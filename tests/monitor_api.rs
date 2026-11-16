//! End-to-end tests for the address monitor API.
//!
//! The first test starts an in-process coordinator with the monitor mounted
//! and drives the whole flow over HTTP. The `#[ignore]` test is the same
//! client against an already-running `rotor-coord` (`MONITOR_LIVE_BASE`,
//! default `http://127.0.0.1:7887`).

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k256::ecdsa::SigningKey;
use rotor::coordinator::{
    Clients, ServerOptions, spawn_with_monitor_options, spawn_with_options_trust_proxy,
};
use rotor::hashes::keccak256;
use rotor::monitor::store::MonitorStore;
use serde_json::{Value, json};

const TOKEN: &str = "test-token";
const BTC_ADDRESS: &str = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

struct TempState {
    path: PathBuf,
}

impl TempState {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "rotor-monitor-api-{}-{nanos}-{tag}.json",
            std::process::id()
        ));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempState {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(format!("{}.tmp", self.path.display()));
    }
}

fn raw(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> (u16, String) {
    raw_extra(addr, &addr.to_string(), method, path, token, body, &[])
}

fn raw_with_host(
    addr: SocketAddr,
    host: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> (u16, String) {
    raw_extra(addr, host, method, path, token, body, &[])
}

fn raw_extra(
    addr: SocketAddr,
    host: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> (u16, String) {
    let mut stream = TcpStream::connect(addr).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("read timeout");
    let payload = body.unwrap_or("");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    for (name, value) in extra_headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if body.is_some() {
        request.push_str("Content-Type: application/json\r\n");
    }
    request.push_str(&format!(
        "Content-Length: {}\r\n\r\n{payload}",
        payload.len()
    ));
    stream.write_all(request.as_bytes()).expect("write request");
    let mut response = Vec::new();
    stream.read_to_end(&mut response).expect("read response");
    let text = String::from_utf8_lossy(&response).into_owned();
    let split = text.find("\r\n\r\n").expect("header terminator");
    let (head, rest) = text.split_at(split);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .expect("status code");
    (status, rest[4..].to_string())
}

fn post(addr: SocketAddr, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
    let (status, text) = raw(addr, "POST", path, token, Some(&body.to_string()));
    let value = serde_json::from_str(&text).unwrap_or(Value::Null);
    (status, value)
}

fn get(addr: SocketAddr, path: &str, token: Option<&str>) -> (u16, Value) {
    let (status, text) = raw(addr, "GET", path, token, None);
    let value = serde_json::from_str(&text).unwrap_or(Value::Null);
    (status, value)
}

fn address_of(key: &SigningKey) -> String {
    let point = key.verifying_key().to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]);
    let mut address = String::from("0x");
    for byte in &hash[12..] {
        address.push_str(&format!("{byte:02x}"));
    }
    address
}

fn personal_sign_hash(message: &str) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut data = prefix.into_bytes();
    data.extend_from_slice(message.as_bytes());
    keccak256(&data)
}

fn sign_message(key: &SigningKey, message: &str) -> String {
    let (signature, recovery) = key
        .sign_prehash_recoverable(&personal_sign_hash(message))
        .expect("sign");
    let mut bytes = signature.to_bytes().to_vec();
    bytes.push(recovery.to_byte());
    let mut out = String::from("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn challenge(addr: SocketAddr, address: &str) -> Value {
    let (status, value) = post(
        addr,
        "/api/v1/monitor/challenge",
        None,
        json!({"address": address}),
    );
    assert_eq!(status, 200, "challenge failed: {value}");
    value
}

fn login(addr: SocketAddr, key: &SigningKey, message: &str) -> (u16, Value) {
    post(
        addr,
        "/api/v1/monitor/login",
        None,
        json!({"message": message, "signature": sign_message(key, message)}),
    )
}

fn monitor_flow(addr: SocketAddr, key: &SigningKey) {
    let address = address_of(key);
    let challenge = challenge(addr, &address);
    let message = challenge["message"].as_str().expect("message");
    assert!(message.contains("Chain ID: 1"));
    assert!(message.contains("Rotor monitor login"));
    assert!(message.starts_with("127.0.0.1 wants"));

    // The fixed server domain wins over an attacker-controlled Host header.
    let (status, text) = raw_with_host(
        addr,
        "evil.example",
        "POST",
        "/api/v1/monitor/challenge",
        None,
        Some(&json!({"address": address}).to_string()),
    );
    assert_eq!(status, 200);
    let spoofed: Value = serde_json::from_str(&text).expect("spoofed challenge JSON");
    let spoofed_message = spoofed["message"].as_str().expect("spoofed message");
    assert!(
        spoofed_message.starts_with("127.0.0.1 wants"),
        "Host header leaked into SIWE domain: {spoofed_message}"
    );
    assert!(!spoofed_message.contains("evil.example"));

    let (status, body) = login(addr, key, message);
    assert_eq!(status, 200, "login failed: {body}");
    let token = body["token"].as_str().expect("token").to_string();
    let user_id = body["user"]["id"].as_str().expect("user id").to_string();
    assert_eq!(body["user"]["address"], address);

    // The same nonce is single-use.
    let (status, _) = login(addr, key, message);
    assert_eq!(status, 400, "replayed login must fail");

    let (status, body) = post(
        addr,
        "/api/v1/monitor/addresses",
        Some(&token),
        json!({"addresses": [
            {"chain": "evm", "address": address, "label": "main"},
            {"chain": "evm", "address": "0x4444444444444444444444444444444444444444"},
            {"chain": "btc", "address": BTC_ADDRESS}
        ]}),
    );
    assert_eq!(status, 200, "add addresses failed: {body}");
    let watches = body["watches"].as_array().expect("watches");
    assert_eq!(watches.len(), 3);
    let evm = watches
        .iter()
        .find(|watch| watch["chain"] == "evm" && watch["address"] == address)
        .expect("evm watch");
    let foreign_evm = watches
        .iter()
        .find(|watch| watch["address"] == "0x4444444444444444444444444444444444444444")
        .expect("foreign evm watch");
    let btc = watches
        .iter()
        .find(|watch| watch["chain"] == "btc")
        .expect("btc watch");
    // Only the SIWE signer is verified; other addresses are not.
    assert_eq!(evm["verified"], true);
    assert_eq!(foreign_evm["verified"], false);
    assert_eq!(btc["verified"], false);

    // Public exposure lookup: count only, one lookup event for the owner.
    // `/key` also submits TRON/Solana rows; unsupported chains are skipped.
    let (status, body) = post(
        addr,
        "/api/v1/monitor/exposure",
        None,
        json!({"addresses": [
            {"chain": "evm", "address": address},
            {"chain": "tron", "address": "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE"},
            {"chain": "solana", "address": "11111111111111111111111111111111"}
        ]}),
    );
    assert_eq!(status, 200, "exposure failed: {body}");
    assert_eq!(body["matched"], 1);
    assert!(body.get("addresses").is_none(), "response leaks matches");

    let (status, body) = get(addr, "/api/v1/monitor/me", Some(&token));
    assert_eq!(status, 200, "me failed: {body}");
    assert_eq!(body["user"]["id"], user_id);
    let events = body["events"].as_array().expect("events");
    assert!(
        events.iter().any(|event| event["kind"] == "lookup"
            && event["severity"] == "high"
            && event["address"] == address),
        "lookup event missing: {body}"
    );

    // Unmatched exposure stays at zero and records nothing.
    let (status, body) = post(
        addr,
        "/api/v1/monitor/exposure",
        None,
        json!({"addresses": [{"chain": "evm", "address": "0x2222222222222222222222222222222222222222"}]}),
    );
    assert_eq!(status, 200);
    assert_eq!(body["matched"], 0);

    // Settings round-trip.
    let (status, body) = raw(
        addr,
        "PATCH",
        "/api/v1/monitor/settings",
        Some(&token),
        Some(&json!({"recovery_opt_in": true}).to_string()),
    );
    assert_eq!(status, 200, "settings failed: {body}");
    let body: Value = serde_json::from_str(&body).expect("settings JSON");
    assert_eq!(body["settings"]["recovery_opt_in"], true);
    assert_eq!(body["settings"]["alerts_enabled"], true);

    // Feed is newest-first by id and supports since.
    let (status, body) = get(addr, "/api/v1/monitor/feed", Some(&token));
    assert_eq!(status, 200);
    assert_eq!(body["events"].as_array().expect("feed").len(), 1);

    // Uniform 404 for an unknown/not-owned watch.
    let (status, _) = raw(
        addr,
        "DELETE",
        "/api/v1/monitor/addresses/evm/0x3333333333333333333333333333333333333333",
        Some(&token),
        None,
    );
    assert_eq!(status, 404);

    // Deleting the owned watch works.
    let (status, _) = raw(
        addr,
        "DELETE",
        &format!("/api/v1/monitor/addresses/evm/{address}"),
        Some(&token),
        None,
    );
    assert_eq!(status, 200);

    // Missing/foreign bearer is rejected.
    let (status, _) = get(addr, "/api/v1/monitor/me", None);
    assert_eq!(status, 401);

    // Logout revokes the session and it stops working.
    let (status, body) = post(addr, "/api/v1/monitor/logout", Some(&token), json!({}));
    assert_eq!(status, 200, "logout failed: {body}");
    let (status, _) = get(addr, "/api/v1/monitor/me", Some(&token));
    assert_eq!(status, 401, "session must be revoked by logout");
}

#[test]
fn monitor_api_end_to_end() {
    let coordinator_state = TempState::new("coord");
    let monitor_state = TempState::new("monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            open_registration: false,
            trust_proxy: false,
            monitor_domain: "127.0.0.1".to_string(),
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;
    let key = SigningKey::from_slice(&[0x11; 32]).expect("key");
    monitor_flow(addr, &key);

    // Custody guard: private-key-shaped input is rejected before parsing.
    let secret = "ab".repeat(32);
    let (status, body) = post(
        addr,
        "/api/v1/monitor/exposure",
        None,
        json!({"addresses": [], "key": secret}),
    );
    assert_eq!(status, 422, "custody guard failed: {body}");

    // A wrong-domain message cannot use a fresh challenge.
    let address = address_of(&key);
    let challenge = challenge(addr, &address);
    let message = challenge["message"]
        .as_str()
        .expect("message")
        .replace("127.0.0.1 wants", "evil.example wants");
    let (status, _) = login(addr, &key, &message);
    assert_eq!(status, 400, "wrong-domain login must fail");
}

#[test]
#[ignore = "needs a running rotor-coord (MONITOR_LIVE_BASE)"]
fn live_client_against_running_binary() {
    let base =
        std::env::var("MONITOR_LIVE_BASE").unwrap_or_else(|_| "http://127.0.0.1:7887".to_string());
    let addr: SocketAddr = base
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .parse()
        .expect("MONITOR_LIVE_BASE must be host:port");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let seed = rotor::hashes::sha256(&nanos.to_le_bytes());
    let key = SigningKey::from_slice(&seed).expect("key");
    let address = address_of(&key);
    println!("live client address: {address}");

    let challenge = challenge(addr, &address);
    let message = challenge["message"].as_str().expect("message");
    println!("challenge message:\n{message}");
    let (status, body) = login(addr, &key, message);
    assert_eq!(status, 200, "login failed: {body}");
    let token = body["token"].as_str().expect("token").to_string();
    println!("login user: {}", body["user"]);

    let (status, body) = post(
        addr,
        "/api/v1/monitor/addresses",
        Some(&token),
        json!({"addresses": [{"chain": "evm", "address": address}]}),
    );
    assert_eq!(status, 200, "add failed: {body}");
    println!("addresses: {body}");

    let (status, body) = post(
        addr,
        "/api/v1/monitor/exposure",
        None,
        json!({"addresses": [{"chain": "evm", "address": address}]}),
    );
    assert_eq!(status, 200, "exposure failed: {body}");
    println!("exposure: {body}");

    let (status, body) = get(addr, "/api/v1/monitor/me", Some(&token));
    assert_eq!(status, 200, "me failed: {body}");
    let events = body["events"].as_array().expect("events");
    assert!(events.iter().any(|event| event["kind"] == "lookup"));
    println!("me: {body}");
}

#[test]
fn registration_rate_limit_respects_trust_proxy_flag() {
    for trust in [false, true] {
        let temp = TempState::new(if trust {
            "register-trust"
        } else {
            "register-socket"
        });
        let handle = spawn_with_options_trust_proxy(
            "127.0.0.1:0",
            temp.path(),
            TOKEN.to_string(),
            Clients::default(),
            true,
            trust,
        )
        .expect("spawn coordinator");
        let addr = handle.addr;
        let register = |headers: &[(&str, &str)], name: &str| {
            let body = json!({"name": name}).to_string();
            raw_extra(
                addr,
                &addr.to_string(),
                "POST",
                "/api/v1/register",
                None,
                Some(&body),
                headers,
            )
            .0
        };
        let first = register(&[("CF-Connecting-IP", "1.1.1.1")], "alpha");
        let second = register(&[("CF-Connecting-IP", "2.2.2.2")], "beta");
        let third = register(&[("X-Forwarded-For", "3.3.3.3, 10.0.0.1")], "gamma");
        if trust {
            assert_eq!(first, 201, "trusted, first registration");
            assert_eq!(second, 201, "trusted, distinct CF IP");
            assert_eq!(third, 201, "trusted, first XFF hop");
            assert_eq!(
                register(&[("CF-Connecting-IP", "1.1.1.1")], "delta"),
                429,
                "trusted, same CF IP must share one bucket"
            );
        } else {
            assert_eq!(first, 201, "untrusted, first registration");
            assert_eq!(second, 429, "untrusted ignores CF-Connecting-IP");
            assert_eq!(third, 429, "untrusted ignores X-Forwarded-For");
        }
        handle.shutdown();
    }
}
