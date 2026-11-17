//! Background address watcher for the address monitor.
//!
//! One thread polls every distinct watched EVM address with a JSON-RPC batch
//! (`eth_getBalance`, `eth_getTransactionCount`) and every distinct watched BTC
//! address through the mempool.space address API. The first observation only
//! sets the baseline; later changes become feed events. The thread is detached
//! and dies with the process.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::monitor::store::{BtcObservation, BtcStats, MonitorStore, Observation};

/// Addresses per JSON-RPC batch (two calls each).
const BATCH_ADDRESSES: usize = 100;
/// Largest JSON-RPC response we are willing to buffer.
const MAX_RPC_BYTES: usize = 1024 * 1024;
/// Largest mempool.space response we are willing to buffer.
const MAX_BTC_BYTES: usize = 1024 * 1024;
/// Minimum gap between repeated warnings for the same BTC address.
const BTC_WARN_INTERVAL: Duration = Duration::from_secs(300);

/// Watcher configuration from `rotor-coord` flags.
#[derive(Debug, Clone)]
pub struct WatcherConfig {
    /// Poll interval in seconds (clamped to at least 10).
    pub interval_secs: u64,
    /// EVM JSON-RPC endpoint.
    pub rpc_url: String,
    /// Bitcoin address API base, e.g. `https://mempool.space`.
    pub btc_api_url: String,
}

/// Start the watcher thread. It never returns; process exit ends it.
pub fn spawn(store: Arc<MonitorStore>, config: WatcherConfig) -> JoinHandle<()> {
    thread::spawn(move || run(&store, &config))
}

fn run(store: &MonitorStore, config: &WatcherConfig) {
    let agent = build_agent();
    let interval = Duration::from_secs(config.interval_secs.max(10));
    let mut btc_warnings: HashMap<String, Instant> = HashMap::new();
    loop {
        if let Err(err) = poll_once(&agent, store, &config.rpc_url) {
            eprintln!("rotor-coord: monitor watcher: {err}");
            store.record_watcher_error(&err);
        }
        poll_btc_once(&agent, store, &config.btc_api_url, &mut btc_warnings);
        thread::sleep(interval);
    }
}

fn build_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .user_agent("rotor-monitor/1.0")
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(15))
        .timeout_write(Duration::from_secs(15));
    // ureq only uses native-tls when the connector is attached explicitly.
    if let Ok(connector) = ureq::native_tls::TlsConnector::new() {
        builder = builder.tls_connector(Arc::new(connector));
    } else {
        eprintln!("rotor-coord: monitor watcher: cannot initialize TLS; https RPC will fail");
    }
    builder.build()
}

fn poll_once(agent: &ureq::Agent, store: &MonitorStore, rpc_url: &str) -> Result<(), String> {
    let addresses = store.evm_watch_addresses();
    if addresses.is_empty() {
        return Ok(());
    }
    for chunk in addresses.chunks(BATCH_ADDRESSES) {
        let observations = poll_chunk(agent, rpc_url, chunk)?;
        if observations.is_empty() {
            continue;
        }
        let events = store
            .apply_evm_observations(&observations)
            .map_err(|err| format!("cannot record observations: {err}"))?;
        if !events.is_empty() {
            // No addresses in the log line: the feed holds the detail.
            eprintln!(
                "rotor-coord: monitor watcher recorded {} event(s)",
                events.len()
            );
        }
    }
    Ok(())
}

fn poll_btc_once(
    agent: &ureq::Agent,
    store: &MonitorStore,
    api_url: &str,
    warnings: &mut HashMap<String, Instant>,
) {
    let addresses = store.btc_watch_addresses();
    if addresses.is_empty() {
        return;
    }
    let mut observations = Vec::new();
    for address in addresses {
        match fetch_btc(agent, api_url, &address) {
            Ok((chain, mempool)) => observations.push(BtcObservation {
                address,
                chain,
                mempool,
            }),
            // One bad address must not abort the rest of the poll.
            Err(err) => warn_btc(warnings, &address, &err),
        }
    }
    if observations.is_empty() {
        return;
    }
    match store.apply_btc_observations(&observations) {
        Ok(events) if !events.is_empty() => {
            eprintln!(
                "rotor-coord: monitor watcher recorded {} BTC event(s)",
                events.len()
            );
        }
        Ok(_) => {}
        Err(err) => {
            eprintln!("rotor-coord: monitor watcher: {err}");
            store.record_watcher_error(&err);
        }
    }
}

/// Log at most one warning per address per window. The address itself is not
/// repeated in the log line; the feed carries the activity detail.
fn warn_btc(warnings: &mut HashMap<String, Instant>, address: &str, message: &str) {
    let now = Instant::now();
    if warnings
        .get(address)
        .is_some_and(|last| now.duration_since(*last) < BTC_WARN_INTERVAL)
    {
        return;
    }
    warnings.insert(address.to_string(), now);
    eprintln!("rotor-coord: monitor watcher: BTC poll failed: {message}");
}

fn fetch_btc(
    agent: &ureq::Agent,
    api_url: &str,
    address: &str,
) -> Result<(BtcStats, BtcStats), String> {
    let url = format!("{}/api/address/{address}", api_url.trim_end_matches('/'));
    let response = match agent.get(&url).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!("BTC API returned HTTP {code}"));
        }
        // Deliberately no URL in the message: it contains the watched address.
        Err(_) => return Err("BTC API request failed".to_string()),
    };
    let mut body = Vec::new();
    response
        .into_reader()
        .take(MAX_BTC_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| "cannot read BTC API response".to_string())?;
    if body.len() > MAX_BTC_BYTES {
        return Err("BTC API response exceeds 1 MiB".to_string());
    }
    parse_btc_stats(&body)
}

#[derive(Deserialize)]
struct AddressStatsResponse {
    chain_stats: StatsJson,
    mempool_stats: StatsJson,
}

#[derive(Deserialize)]
struct StatsJson {
    funded_txo_sum: u64,
    spent_txo_sum: u64,
    tx_count: u64,
}

impl StatsJson {
    fn into_stats(self) -> BtcStats {
        BtcStats {
            funded_txo_sum: self.funded_txo_sum,
            spent_txo_sum: self.spent_txo_sum,
            tx_count: self.tx_count,
        }
    }
}

/// Parse the fields the watcher needs from `/api/address/<address>`.
fn parse_btc_stats(body: &[u8]) -> Result<(BtcStats, BtcStats), String> {
    let response: AddressStatsResponse = serde_json::from_slice(body)
        .map_err(|err| format!("cannot parse BTC API response: {err}"))?;
    Ok((
        response.chain_stats.into_stats(),
        response.mempool_stats.into_stats(),
    ))
}

fn poll_chunk(
    agent: &ureq::Agent,
    rpc_url: &str,
    chunk: &[String],
) -> Result<Vec<Observation>, String> {
    let mut batch = Vec::with_capacity(chunk.len() * 2);
    for (index, address) in chunk.iter().enumerate() {
        let balance_id = (index * 2 + 1) as u64;
        let nonce_id = (index * 2 + 2) as u64;
        batch.push(json!({
            "jsonrpc": "2.0",
            "id": balance_id,
            "method": "eth_getBalance",
            "params": [address, "latest"],
        }));
        batch.push(json!({
            "jsonrpc": "2.0",
            "id": nonce_id,
            "method": "eth_getTransactionCount",
            "params": [address, "latest"],
        }));
    }
    let payload = serde_json::to_string(&batch)
        .map_err(|err| format!("cannot serialize JSON-RPC batch: {err}"))?;
    let response = agent
        .post(rpc_url)
        .set("Content-Type", "application/json")
        .send_string(&payload)
        .map_err(|err| format!("JSON-RPC request failed: {err}"))?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(MAX_RPC_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|err| format!("cannot read JSON-RPC response: {err}"))?;
    if body.len() > MAX_RPC_BYTES {
        return Err("JSON-RPC response exceeds 1 MiB".to_string());
    }
    let values: Vec<Value> = serde_json::from_slice(&body)
        .map_err(|err| format!("cannot parse JSON-RPC response: {err}"))?;
    let mut balances: Vec<Option<String>> = vec![None; chunk.len()];
    let mut nonces: Vec<Option<u64>> = vec![None; chunk.len()];
    for value in values {
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(result) = value.get("result").and_then(Value::as_str) else {
            continue;
        };
        let zero_based = id.saturating_sub(1) as usize;
        let index = zero_based / 2;
        if index >= chunk.len() {
            continue;
        }
        if zero_based.is_multiple_of(2) {
            balances[index] = Some(normalize_quantity(result));
        } else if let Some(nonce) = parse_quantity(result) {
            nonces[index] = Some(nonce);
        }
    }
    let mut observations = Vec::new();
    for (index, address) in chunk.iter().enumerate() {
        if let (Some(balance), Some(nonce)) = (&balances[index], nonces[index]) {
            observations.push(Observation {
                address: address.clone(),
                balance: balance.clone(),
                nonce,
            });
        }
    }
    Ok(observations)
}

/// Normalize a JSON-RPC hex quantity (`0x00ff` -> `0xff`).
fn normalize_quantity(value: &str) -> String {
    let digits = value.strip_prefix("0x").unwrap_or(value);
    let trimmed = digits.trim_start_matches('0');
    let trimmed = if trimmed.is_empty() { "0" } else { trimmed };
    format!("0x{}", trimmed.to_ascii_lowercase())
}

/// Parse a JSON-RPC hex quantity into `u64`.
fn parse_quantity(value: &str) -> Option<u64> {
    let digits = value.strip_prefix("0x").unwrap_or(value);
    let digits = if digits.is_empty() { "0" } else { digits };
    u64::from_str_radix(digits, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::monitor::store::NewWatch;

    #[test]
    fn quantities_are_normalized_and_parsed() {
        assert_eq!(normalize_quantity("0x0000"), "0x0");
        assert_eq!(normalize_quantity("0x00FF"), "0xff");
        assert_eq!(normalize_quantity("0x10"), "0x10");
        assert_eq!(parse_quantity("0x0"), Some(0));
        assert_eq!(parse_quantity("0x1a"), Some(26));
        assert_eq!(parse_quantity("nope"), None);
    }

    #[test]
    fn btc_stats_are_parsed_strictly() {
        let body = br#"{
            "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
            "chain_stats": {"funded_txo_sum": 1000, "spent_txo_sum": 250, "tx_count": 3},
            "mempool_stats": {"funded_txo_sum": 40, "spent_txo_sum": 0, "tx_count": 1}
        }"#;
        let (chain, mempool) = parse_btc_stats(body).expect("parse");
        assert_eq!(
            chain,
            BtcStats {
                funded_txo_sum: 1000,
                spent_txo_sum: 250,
                tx_count: 3,
            }
        );
        assert_eq!(
            mempool,
            BtcStats {
                funded_txo_sum: 40,
                spent_txo_sum: 0,
                tx_count: 1,
            }
        );

        assert!(parse_btc_stats(b"{}").is_err());
        assert!(parse_btc_stats(br#"{"chain_stats":{}}"#).is_err());
        assert!(parse_btc_stats(b"not json").is_err());
    }

    struct TempStore {
        path: PathBuf,
        store: MonitorStore,
    }

    impl TempStore {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "rotor-monitor-watcher-{}-{nanos}-{tag}.json",
                std::process::id()
            ));
            let store = MonitorStore::open(&path).expect("open store");
            Self { path, store }
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_file(format!("{}.tmp", self.path.display()));
        }
    }

    const BTC_ADDRESS: &str = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

    fn btc_user(store: &MonitorStore) -> String {
        let user = store.upsert_identity("btc", BTC_ADDRESS).expect("btc user");
        store
            .add_watches(
                &user.id,
                vec![NewWatch {
                    chain: "btc".to_string(),
                    address: BTC_ADDRESS.to_string(),
                    label: None,
                    verified: false,
                }],
            )
            .expect("add btc watch");
        user.id
    }

    fn stats_body(chain: (u64, u64, u64), mempool: (u64, u64, u64)) -> String {
        format!(
            r#"{{"chain_stats":{{"funded_txo_sum":{},"spent_txo_sum":{},"tx_count":{}}},"mempool_stats":{{"funded_txo_sum":{},"spent_txo_sum":{},"tx_count":{}}}}}"#,
            chain.0, chain.1, chain.2, mempool.0, mempool.1, mempool.2
        )
    }

    /// Minimal one-shot HTTP server: returns the queued bodies in order.
    fn mock_server(responses: Vec<String>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let base = format!("http://{}", listener.local_addr().expect("mock addr"));
        let handle = thread::spawn(move || {
            for body in responses {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write mock response");
            }
        });
        (base, handle)
    }

    #[test]
    fn btc_watcher_baselines_classifies_and_deduplicates() {
        let temp = TempStore::new("btc-flow");
        let user_id = btc_user(&temp.store);
        let (base, server) = mock_server(vec![
            stats_body((0, 0, 0), (0, 0, 0)),
            stats_body((1_000, 0, 1), (0, 0, 0)),
            // Identical repeat: no second event.
            stats_body((1_000, 0, 1), (0, 0, 0)),
            stats_body((1_000, 0, 1), (500, 0, 1)),
        ]);
        let agent = build_agent();
        let mut warnings = HashMap::new();

        poll_btc_once(&agent, &temp.store, &base, &mut warnings);
        assert!(temp.store.feed(&user_id, None).is_empty());
        assert_eq!(
            temp.store.me(&user_id).expect("me").watches[0]
                .last_balance
                .as_deref(),
            Some("0")
        );

        poll_btc_once(&agent, &temp.store, &base, &mut warnings);
        poll_btc_once(&agent, &temp.store, &base, &mut warnings);
        poll_btc_once(&agent, &temp.store, &base, &mut warnings);

        let events = temp.store.feed(&user_id, None);
        let kinds: Vec<&str> = events.iter().map(|event| event.kind.as_str()).collect();
        assert_eq!(kinds, vec!["incoming", "mempool"], "events: {events:?}");
        assert_eq!(events[0].severity, "info");
        assert_eq!(events[1].severity, "info");
        assert_eq!(
            temp.store.me(&user_id).expect("me").watches[0]
                .last_balance
                .as_deref(),
            Some("1500")
        );

        server.join().expect("mock server");
    }

    #[test]
    fn btc_watcher_does_not_replay_after_restart() {
        let temp = TempStore::new("btc-restart");
        let user_id = btc_user(&temp.store);
        let (base, server) = mock_server(vec![
            stats_body((100, 0, 1), (0, 0, 0)),
            stats_body((1_000, 0, 2), (0, 0, 0)),
            stats_body((1_000, 0, 2), (0, 0, 0)),
        ]);
        let agent = build_agent();
        let mut warnings = HashMap::new();

        poll_btc_once(&agent, &temp.store, &base, &mut warnings);
        poll_btc_once(&agent, &temp.store, &base, &mut warnings);
        assert_eq!(temp.store.feed(&user_id, None).len(), 1);

        let reopened = MonitorStore::open(&temp.path).expect("reopen");
        poll_btc_once(&agent, &reopened, &base, &mut warnings);
        assert_eq!(
            reopened.feed(&user_id, None).len(),
            1,
            "restart replayed a known change"
        );

        server.join().expect("mock server");
    }
}
