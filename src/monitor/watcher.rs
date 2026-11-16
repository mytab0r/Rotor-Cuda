//! Background EVM watcher for the address monitor.
//!
//! One thread polls every distinct watched EVM address with a JSON-RPC batch
//! (`eth_getBalance`, `eth_getTransactionCount`). The first observation only
//! sets the baseline; later balance/nonce changes become feed events. The
//! thread is detached and dies with the process.

use std::io::Read;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Value, json};

use crate::monitor::store::{MonitorStore, Observation};

/// Addresses per JSON-RPC batch (two calls each).
const BATCH_ADDRESSES: usize = 100;
/// Largest JSON-RPC response we are willing to buffer.
const MAX_RPC_BYTES: usize = 1024 * 1024;

/// Watcher configuration from `rotor-coord` flags.
#[derive(Debug, Clone)]
pub struct WatcherConfig {
    /// Poll interval in seconds (clamped to at least 10).
    pub interval_secs: u64,
    /// JSON-RPC endpoint.
    pub rpc_url: String,
}

/// Start the watcher thread. It never returns; process exit ends it.
pub fn spawn(store: Arc<MonitorStore>, config: WatcherConfig) -> JoinHandle<()> {
    thread::spawn(move || run(&store, &config))
}

fn run(store: &MonitorStore, config: &WatcherConfig) {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(15))
        .timeout_write(Duration::from_secs(15));
    // ureq only uses native-tls when the connector is attached explicitly.
    if let Ok(connector) = ureq::native_tls::TlsConnector::new() {
        builder = builder.tls_connector(std::sync::Arc::new(connector));
    } else {
        eprintln!("rotor-coord: monitor watcher: cannot initialize TLS; https RPC will fail");
    }
    let agent = builder.build();
    let interval = Duration::from_secs(config.interval_secs.max(10));
    loop {
        match poll_once(&agent, store, &config.rpc_url) {
            Ok(()) => {}
            Err(err) => {
                eprintln!("rotor-coord: monitor watcher: {err}");
                store.record_watcher_error(&err);
            }
        }
        thread::sleep(interval);
    }
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

    #[test]
    fn quantities_are_normalized_and_parsed() {
        assert_eq!(normalize_quantity("0x0000"), "0x0");
        assert_eq!(normalize_quantity("0x00FF"), "0xff");
        assert_eq!(normalize_quantity("0x10"), "0x10");
        assert_eq!(parse_quantity("0x0"), Some(0));
        assert_eq!(parse_quantity("0x1a"), Some(26));
        assert_eq!(parse_quantity("nope"), None);
    }
}
