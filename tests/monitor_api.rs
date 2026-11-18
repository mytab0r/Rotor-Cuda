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

use ed25519_dalek::{Signer as _, SigningKey as Ed25519SigningKey};
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

fn tron_address(key: &SigningKey) -> String {
    let point = key.verifying_key().to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]);
    let mut payload = [0u8; 21];
    payload[0] = 0x41;
    payload[1..].copy_from_slice(&hash[12..]);
    rotor::base58::encode_check(&payload)
}

/// TRON `signMessageV2`: prefix, decimal byte length, then the message bytes.
fn sign_tron(key: &SigningKey, message: &str) -> String {
    let prefix = format!("\x19TRON Signed Message:\n{}", message.len());
    let mut data = prefix.into_bytes();
    data.extend_from_slice(message.as_bytes());
    let (signature, recovery) = key
        .sign_prehash_recoverable(&keccak256(&data))
        .expect("sign tron message");
    let mut bytes = signature.to_bytes().to_vec();
    bytes.push(recovery.to_byte() + 27);
    let mut out = String::from("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn solana_key(seed: u8) -> Ed25519SigningKey {
    Ed25519SigningKey::from_bytes(&[seed; 32])
}

fn solana_address(key: &Ed25519SigningKey) -> String {
    bs58::encode(key.verifying_key().to_bytes()).into_string()
}

fn sign_solana(key: &Ed25519SigningKey, message: &str) -> String {
    let signature = key.sign(message.as_bytes());
    let mut out = String::from("0x");
    for byte in signature.to_bytes() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn challenge_for(addr: SocketAddr, chain: &str, address: &str) -> Value {
    let (status, value) = post(
        addr,
        "/api/v1/monitor/challenge",
        None,
        json!({"chain": chain, "address": address}),
    );
    assert_eq!(status, 200, "challenge failed: {value}");
    value
}

fn challenge(addr: SocketAddr, address: &str) -> Value {
    challenge_for(addr, "evm", address)
}

fn login_sig(
    addr: SocketAddr,
    chain: &str,
    message: &str,
    signature: &str,
    token: Option<&str>,
) -> (u16, Value) {
    post(
        addr,
        "/api/v1/monitor/login",
        token,
        json!({"chain": chain, "message": message, "signature": signature}),
    )
}

fn login(addr: SocketAddr, key: &SigningKey, message: &str) -> (u16, Value) {
    login_sig(addr, "evm", message, &sign_message(key, message), None)
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
    let identities = body["user"]["identities"]
        .as_array()
        .expect("login identities");
    assert_eq!(identities.len(), 1);
    assert_eq!(identities[0]["chain"], "evm");
    assert_eq!(identities[0]["address"], address);
    assert_eq!(identities[0]["verified"], true);

    // The same nonce is single-use.
    let (status, _) = login(addr, key, message);
    assert_eq!(status, 400, "replayed login must fail");

    let foreign_sol = solana_address(&solana_key(0x55));
    let foreign_tron = tron_address(&SigningKey::from_slice(&[0x66; 32]).expect("tron key"));
    let (status, body) = post(
        addr,
        "/api/v1/monitor/addresses",
        Some(&token),
        json!({"addresses": [
            {"chain": "evm", "address": address, "label": "main"},
            {"chain": "evm", "address": "0x4444444444444444444444444444444444444444"},
            {"chain": "btc", "address": BTC_ADDRESS},
            {"chain": "solana", "address": foreign_sol},
            {"chain": "tron", "address": foreign_tron}
        ]}),
    );
    assert_eq!(status, 200, "add addresses failed: {body}");
    let watches = body["watches"].as_array().expect("watches");
    assert_eq!(watches.len(), 5);
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
    let sol_watch = watches
        .iter()
        .find(|watch| watch["chain"] == "solana")
        .expect("solana watch");
    let tron_watch = watches
        .iter()
        .find(|watch| watch["chain"] == "tron")
        .expect("tron watch");
    // Only the account's verified identities are verified.
    assert_eq!(evm["verified"], true);
    assert_eq!(foreign_evm["verified"], false);
    assert_eq!(btc["verified"], false);
    assert_eq!(sol_watch["verified"], false);
    assert_eq!(tron_watch["verified"], false);

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

    // --- Solana login: hex signature, then Base64 on a fresh challenge. ---
    let sol_key = solana_key(0x33);
    let sol_addr = solana_address(&sol_key);
    let sol_challenge = challenge_for(addr, "solana", &sol_addr);
    assert_eq!(sol_challenge["chain"], "solana");
    let sol_message = sol_challenge["message"].as_str().expect("sol message");
    assert!(sol_message.contains(&sol_addr));
    let (status, body) = login_sig(
        addr,
        "solana",
        sol_message,
        &sign_solana(&sol_key, sol_message),
        None,
    );
    assert_eq!(status, 200, "solana login failed: {body}");
    let sol_token = body["token"].as_str().expect("sol token").to_string();
    let sol_user_id = body["user"]["id"]
        .as_str()
        .expect("sol user id")
        .to_string();
    assert_eq!(body["user"]["address"], sol_addr);
    let identities = body["user"]["identities"]
        .as_array()
        .expect("sol identities");
    assert_eq!(identities.len(), 1);
    assert_eq!(identities[0]["chain"], "solana");
    assert_eq!(identities[0]["address"], sol_addr);
    assert_eq!(identities[0]["verified"], true);

    let sol_challenge = challenge_for(addr, "solana", &sol_addr);
    let sol_message = sol_challenge["message"].as_str().expect("sol message");
    let sol_base64 = base64_encode(&sol_key.sign(sol_message.as_bytes()).to_bytes());
    let (status, body) = login_sig(addr, "solana", sol_message, &sol_base64, None);
    assert_eq!(status, 200, "base64 solana login failed: {body}");
    assert_eq!(body["user"]["id"], sol_user_id);

    let (status, body) = post(
        addr,
        "/api/v1/monitor/addresses",
        Some(&sol_token),
        json!({"addresses": [{"chain": "solana", "address": sol_addr}]}),
    );
    assert_eq!(status, 200, "solana watch failed: {body}");
    assert_eq!(body["watches"][0]["verified"], true);

    // --- TRON signMessageV2 login. ---
    let tron_key = SigningKey::from_slice(&[0x22; 32]).expect("tron key");
    let tron_addr = tron_address(&tron_key);
    let tron_challenge = challenge_for(addr, "tron", &tron_addr);
    assert_eq!(tron_challenge["chain"], "tron");
    let tron_message = tron_challenge["message"].as_str().expect("tron message");
    let (status, body) = login_sig(
        addr,
        "tron",
        tron_message,
        &sign_tron(&tron_key, tron_message),
        None,
    );
    assert_eq!(status, 200, "tron login failed: {body}");
    assert_eq!(body["user"]["address"], tron_addr);
    let identities = body["user"]["identities"]
        .as_array()
        .expect("tron identities");
    assert_eq!(identities.len(), 1);
    assert_eq!(identities[0]["chain"], "tron");
    assert_eq!(identities[0]["verified"], true);

    // --- Linking: a Bearer EVM session absorbs the Solana identity. ---
    let link_key = solana_key(0x44);
    let link_addr = solana_address(&link_key);
    let link_challenge = challenge_for(addr, "solana", &link_addr);
    let link_message = link_challenge["message"].as_str().expect("link message");
    let (status, body) = login_sig(
        addr,
        "solana",
        link_message,
        &sign_solana(&link_key, link_message),
        Some(&token),
    );
    assert_eq!(status, 200, "linking login failed: {body}");
    assert_eq!(body["user"]["id"], user_id, "linking must reuse the user");
    let identities = body["user"]["identities"]
        .as_array()
        .expect("linked identities");
    assert_eq!(identities.len(), 2);
    assert!(
        identities
            .iter()
            .any(|identity| identity["chain"] == "solana"
                && identity["address"] == link_addr
                && identity["verified"] == true)
    );
    let (status, me) = get(addr, "/api/v1/monitor/me", Some(&token));
    assert_eq!(status, 200);
    assert_eq!(
        me["user"]["identities"].as_array().expect("me ids").len(),
        2
    );
    let (status, body) = post(
        addr,
        "/api/v1/monitor/addresses",
        Some(&token),
        json!({"addresses": [{"chain": "solana", "address": link_addr}]}),
    );
    assert_eq!(status, 200, "linked watch failed: {body}");
    assert!(
        body["watches"]
            .as_array()
            .expect("linked watches")
            .iter()
            .any(|watch| watch["chain"] == "solana"
                && watch["address"] == link_addr
                && watch["verified"] == true)
    );

    // --- Rejections: unknown chain, wrong chain, wrong signer. ---
    let (status, _) = post(
        addr,
        "/api/v1/monitor/challenge",
        None,
        json!({"chain": "doge", "address": address}),
    );
    assert_eq!(status, 400, "unknown chain challenge must fail");

    let mismatch = challenge_for(addr, "evm", &address);
    let mismatch_message = mismatch["message"].as_str().expect("mismatch message");
    let (status, _) = login_sig(
        addr,
        "solana",
        mismatch_message,
        &sign_message(key, mismatch_message),
        None,
    );
    assert_eq!(status, 400, "challenge/login chain mismatch must fail");

    let bad = challenge_for(addr, "solana", &sol_addr);
    let bad_message = bad["message"].as_str().expect("bad message");
    let (status, _) = login_sig(
        addr,
        "solana",
        bad_message,
        &sign_solana(&solana_key(0x45), bad_message),
        None,
    );
    assert_eq!(status, 400, "wrong solana signer must fail");
    // A failed verification must not burn the challenge.
    let (status, body) = login_sig(
        addr,
        "solana",
        bad_message,
        &sign_solana(&sol_key, bad_message),
        None,
    );
    assert_eq!(
        status, 200,
        "challenge must survive a bad signature: {body}"
    );
    // And it is single-use once verified.
    let (status, _) = login_sig(
        addr,
        "solana",
        bad_message,
        &sign_solana(&sol_key, bad_message),
        None,
    );
    assert_eq!(status, 400, "verified challenge must be single-use");

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
            wallets_upstream: None,
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
