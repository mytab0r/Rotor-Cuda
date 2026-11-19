//! End-to-end tests for the coordinator HTTP API and its blocking client.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rotor::base58;
use rotor::bsgs::TableManifest;
use rotor::coordinator::client::CoordinatorClient;
use rotor::coordinator::{
    Clients, ServerOptions, spawn, spawn_with_clients, spawn_with_monitor_options,
    spawn_with_options,
};
use rotor::monitor::store::MonitorStore;
use rotor::scalar::Scalar;
use rotor::secp;
use serde_json::json;

const TOKEN: &str = "test-token";

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
            "rotor-coord-api-{}-{nanos}-{tag}.json",
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
) -> (u16, String, String) {
    let mut stream = TcpStream::connect(addr).expect("connect to coordinator");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("read timeout");
    let payload = body.unwrap_or("");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
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
    (status, head.to_string(), rest[4..].to_string())
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn create_job(addr: SocketAddr, body: serde_json::Value) -> String {
    create_job_as(addr, TOKEN, body)
}

fn create_job_as(addr: SocketAddr, token: &str, body: serde_json::Value) -> String {
    let (status, _, response) = raw(
        addr,
        "POST",
        "/api/v1/jobs",
        Some(token),
        Some(&body.to_string()),
    );
    assert_eq!(status, 201, "create job failed: {response}");
    let value: serde_json::Value = serde_json::from_str(&response).expect("job JSON");
    value["id"].as_str().expect("job id").to_string()
}

fn token_hash(token: &str) -> String {
    hex_bytes(&rotor::hashes::sha256(token.as_bytes()))
}

#[test]
fn auth_is_required_for_the_api_but_not_the_dashboard() {
    let temp = TempState::new("auth");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", None, None);
    assert_eq!(status, 401);
    assert!(body.contains("unauthorized"), "body: {body}");

    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some("wrong-token"), None);
    assert_eq!(status, 401);

    let (status, headers, body) = raw(addr, "GET", "/", None, None);
    assert_eq!(status, 200);
    assert!(
        headers.to_ascii_lowercase().contains("text/html"),
        "headers: {headers}"
    );
    assert!(body.contains("Rotor Coordinator"));

    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "client-1");
    assert!(client.jobs().expect("jobs").is_empty());

    let unauthorized = CoordinatorClient::new(&format!("{addr}"), "wrong", "client-1");
    assert_eq!(
        unauthorized.jobs().expect_err("wrong token must fail"),
        "unauthorized"
    );

    handle.shutdown();
}

#[test]
fn two_clients_lease_disjoint_chunks_and_heartbeat() {
    let temp = TempState::new("lease");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;
    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let start = format!("{:064x}", 0x1000);
    let end = format!("{:064x}", 0x10bf);

    let job_id = create_job(
        addr,
        json!({
            "mode": "xpoint",
            "target": target,
            "start": start,
            "end": end,
            "chunk_width": 0x40,
            "lease_ttl": 600,
        }),
    );

    let first = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "alpha");
    let second = CoordinatorClient::new(&format!("{addr}"), TOKEN, "beta");

    let lease_a = first
        .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
        .expect("lease a")
        .expect("first chunk");
    let lease_b = second
        .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
        .expect("lease b")
        .expect("second chunk");
    assert_ne!(lease_a.chunk_index, lease_b.chunk_index);
    assert_ne!(lease_a.start, lease_b.start);

    let third = CoordinatorClient::new(&format!("{addr}"), TOKEN, "gamma");
    let lease_c = third
        .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
        .expect("lease c")
        .expect("third chunk");
    assert!(![lease_a.chunk_index, lease_b.chunk_index].contains(&lease_c.chunk_index));

    let fourth = CoordinatorClient::new(&format!("{addr}"), TOKEN, "delta");
    assert!(
        fourth
            .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
            .expect("lease d")
            .is_none(),
        "all three chunks are leased"
    );

    let expires_at = first
        .heartbeat(
            &job_id,
            lease_a.chunk_index,
            lease_a.lease_id,
            1_024,
            512.0,
            false,
            &[],
        )
        .expect("heartbeat");
    assert!(expires_at >= lease_a.expires_at);

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let status: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(status["clients"].as_array().expect("clients").len(), 3);
    assert_eq!(status["jobs"][0]["chunks_total"], 3);
    assert_eq!(status["jobs"][0]["chunks_leased"], 3);

    handle.shutdown();
}

#[test]
fn result_requires_a_valid_proof_and_marks_the_job_found() {
    let temp = TempState::new("result");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let key = Scalar::from_u64(42);
    let point = secp::mul_g(&key);
    let address = base58::address_from_hash160(&secp::hash160(&point, true), true);
    let job_id = create_job(
        addr,
        json!({
            "mode": "address",
            "coin": "btc",
            "comp_mode": "compressed",
            "target": address,
            "start": "1",
            "end": "ff",
            "chunk_width": 256,
        }),
    );

    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "finder");
    let lease = client
        .lease(Some(&job_id), None, "address", "btc", "1", "ff")
        .expect("lease")
        .expect("chunk");
    assert_eq!(
        client
            .submit_result(&job_id, lease.lease_id, &Scalar::from_u64(43).to_hex())
            .expect_err("wrong key must fail"),
        "invalid proof"
    );

    client
        .submit_result(&job_id, lease.lease_id, &key.to_hex())
        .expect("valid proof accepted");

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let status: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(status["jobs"][0]["found"], true);
    assert_eq!(status["jobs"][0]["found_key"], key.to_hex());
    assert_eq!(status["results"].as_array().expect("results").len(), 1);
    assert_eq!(status["results"][0]["client_id"], "finder");

    assert!(
        client
            .lease(Some(&job_id), None, "address", "btc", "1", "ff")
            .expect("lease")
            .is_none(),
        "a found job hands out no more chunks"
    );

    handle.shutdown();
}

#[test]
fn bsgs_state_round_trips_and_rejects_a_mismatched_manifest() {
    let temp = TempState::new("bsgs");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let pubkey = hex_bytes(&secp::compress(&secp::mul_g(&Scalar::from_u64(1))));
    let job_id = create_job(
        addr,
        json!({
            "mode": "bsgs",
            "target": pubkey,
            "start": "1",
            "end": "ff",
        }),
    );

    let manifest = TableManifest {
        format_version: 1,
        curve: "secp256k1".to_string(),
        baby_size: 16,
        range_id: "1:ff".to_string(),
        table_checksum: 12_345,
    };

    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "bsgs-1");
    assert_eq!(client.bsgs_get(&job_id).expect("get"), None);
    client
        .bsgs_put(&job_id, &manifest, 7)
        .expect("store checkpoint");
    let stored = client
        .bsgs_get(&job_id)
        .expect("get")
        .expect("stored checkpoint");
    assert_eq!(stored.manifest, manifest);
    assert_eq!(stored.giant_index, 7);

    let mut incompatible = manifest.clone();
    incompatible.table_checksum += 1;
    assert_eq!(
        client
            .bsgs_put(&job_id, &incompatible, 8)
            .expect_err("mismatch must fail"),
        "manifest mismatch"
    );

    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/bsgs/state",
        Some(TOKEN),
        Some(
            &json!({
                "job_id": job_id,
                "manifest": {
                    "format_version": incompatible.format_version,
                    "curve": incompatible.curve,
                    "baby_size": incompatible.baby_size,
                    "range_id": incompatible.range_id,
                    "table_checksum": incompatible.table_checksum,
                },
                "giant_index": 8,
            })
            .to_string(),
        ),
    );
    assert_eq!(status, 409, "body: {body}");
    assert!(body.contains("manifest mismatch"));

    handle.shutdown();
}

#[test]
fn oversized_request_bodies_are_rejected_with_413() {
    let temp = TempState::new("oversized");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    // One byte over the 1 MiB cap; the body is not parsed.
    let body = "x".repeat(1024 * 1024 + 1);
    let (status, _, response) = raw(addr, "POST", "/api/v1/jobs", Some(TOKEN), Some(&body));
    assert_eq!(status, 413, "body: {response}");

    // The server keeps working after a rejected body.
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);

    handle.shutdown();
}

#[test]
fn client_tokens_are_scoped_to_their_endpoints() {
    let temp = TempState::new("client-auth");
    let admin = "admin-token";
    let alpha = "alpha-secret";
    let clients = Clients::parse(&format!(
        r#"{{"alpha":"{}","beta":"{}"}}"#,
        token_hash(alpha),
        token_hash("beta-secret")
    ))
    .expect("clients map");
    let handle =
        spawn_with_clients("127.0.0.1:0", temp.path(), admin.to_string(), clients).expect("spawn");
    let addr = handle.addr;

    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job_as(
        addr,
        admin,
        json!({
            "mode": "xpoint",
            "target": target,
            "start": "1",
            "end": "8",
            "chunk_width": 8,
            "lease_ttl": 600,
        }),
    );

    // Admin: status and jobs are allowed, leasing is not.
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some(admin), None);
    assert_eq!(status, 200);
    let (status, _, _) = raw(addr, "GET", "/api/v1/jobs", Some(admin), None);
    assert_eq!(status, 200);
    let lease_body = json!({
        "client_id": "alpha",
        "job_id": job_id,
        "mode": "xpoint",
        "coin": "btc",
        "start": "1",
        "end": "8",
    })
    .to_string();
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/lease",
        Some(admin),
        Some(&lease_body),
    );
    assert_eq!(status, 403, "admin must not lease: {body}");

    // Client: lease works even when the body claims another client id.
    let spoofed = json!({
        "client_id": "beta",
        "job_id": job_id,
        "mode": "xpoint",
        "coin": "btc",
        "start": "1",
        "end": "8",
    });
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/lease",
        Some(alpha),
        Some(&spoofed.to_string()),
    );
    assert_eq!(status, 200, "client lease failed: {body}");
    let lease: serde_json::Value = serde_json::from_str(&body).expect("lease JSON");
    let lease_id = lease["lease_id"].as_u64().expect("lease_id");
    let chunk_index = lease["chunk_index"].as_u64().expect("chunk_index");

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(alpha), None);
    assert_eq!(status, 200);
    let value: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(
        value["clients"][0]["client_id"], "alpha",
        "the token owns the identity: {body}"
    );

    // A client cannot create jobs.
    let (status, _, _) = raw(
        addr,
        "POST",
        "/api/v1/jobs",
        Some(alpha),
        Some(
            &json!({
                "mode": "xpoint",
                "target": target,
                "start": "1",
                "end": "8",
            })
            .to_string(),
        ),
    );
    assert_eq!(status, 403);

    // Heartbeat and result use the token identity, not the body id.
    let heartbeat = json!({
        "client_id": "beta",
        "job_id": job_id,
        "chunk_index": chunk_index,
        "lease_id": lease_id,
        "scanned": 1,
        "rate": 1.0,
        "done": false,
    })
    .to_string();
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/heartbeat",
        Some(alpha),
        Some(&heartbeat),
    );
    assert_eq!(status, 200, "client heartbeat failed: {body}");

    let result = json!({
        "client_id": "beta",
        "job_id": job_id,
        "lease_id": lease_id,
        "key": Scalar::from_u64(7).to_hex(),
    })
    .to_string();
    let (status, _, body) = raw(addr, "POST", "/api/v1/result", Some(alpha), Some(&result));
    assert_eq!(status, 200, "client result failed: {body}");

    // Unknown and blank tokens are unauthorized.
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some("unknown"), None);
    assert_eq!(status, 401);
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", None, None);
    assert_eq!(status, 401);
    let (status, _, _) = raw(addr, "POST", "/api/v1/lease", Some(""), Some(&lease_body));
    assert_eq!(status, 401);

    handle.shutdown();
}

#[test]
fn completion_challenge_requires_correct_samples() {
    let temp = TempState::new("challenge-api");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job(
        addr,
        json!({
            "mode": "xpoint",
            "target": target,
            "start": "1",
            "end": "8",
            "chunk_width": 8,
            "lease_ttl": 600,
        }),
    );

    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "challenger");
    let lease = client
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "8")
        .expect("lease")
        .expect("chunk");
    assert_eq!(lease.challenge_offsets.len(), 16);

    let heartbeat = |lease_id: u64, done: bool, samples: serde_json::Value| {
        raw(
            addr,
            "POST",
            "/api/v1/heartbeat",
            Some(TOKEN),
            Some(
                &json!({
                    "client_id": "challenger",
                    "job_id": job_id,
                    "chunk_index": lease.chunk_index,
                    "lease_id": lease_id,
                    "scanned": 1,
                    "rate": 1.0,
                    "done": done,
                    "samples": samples,
                })
                .to_string(),
            ),
        )
    };

    // Missing and wrong samples are 400 and the chunk stays leased.
    let (status, _, body) = heartbeat(lease.lease_id, true, json!([]));
    assert_eq!(status, 400, "missing samples: {body}");
    assert!(body.contains("invalid completion sample"), "body: {body}");
    let wrong = json!(vec![vec![0u8; 32]; 16]);
    let (status, _, body) = heartbeat(lease.lease_id, true, wrong);
    assert_eq!(status, 400, "wrong samples: {body}");

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let value: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(value["jobs"][0]["chunks_done"], 0);
    assert_eq!(value["jobs"][0]["chunks_leased"], 1);

    // A stale nonce is 409.
    let (status, _, body) = heartbeat(lease.lease_id.wrapping_add(1), false, json!([]));
    assert_eq!(status, 409, "stale nonce: {body}");
    assert!(body.contains("lease lost"), "body: {body}");

    // Correct samples complete the chunk exactly once.
    let start = Scalar::from_hex(&lease.start).expect("chunk start");
    let samples = rotor::coordinator::state::challenge_samples(
        "xpoint",
        "btc",
        "compressed",
        &start,
        &lease.challenge_offsets,
    )
    .expect("samples");
    let (status, _, body) = heartbeat(lease.lease_id, true, json!(samples));
    assert_eq!(status, 200, "valid samples: {body}");
    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let value: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(value["jobs"][0]["chunks_done"], 1, "exactly one bit set");

    // Replaying the completed lease reports a lost lease.
    let (status, _, _) = heartbeat(lease.lease_id, true, json!([]));
    assert_eq!(status, 409);

    handle.shutdown();
}

#[test]
fn burst_is_rate_limited_with_retry_after() {
    let temp = TempState::new("rate-limit");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let mut limited = None;
    for _ in 0..80 {
        let (status, headers, _) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
        if status == 429 {
            limited = Some(headers);
            break;
        }
        assert_eq!(status, 200, "requests before the burst limit must pass");
    }
    let headers = limited.expect("the burst limit must reject a request");
    assert!(
        headers.to_ascii_lowercase().contains("retry-after: 1"),
        "429 must carry Retry-After: {headers}"
    );

    handle.shutdown();
}

#[test]
fn state_survives_a_coordinator_restart() {
    let temp = TempState::new("restart");
    let target = secp::mul_g(&Scalar::from_u64(11)).x.to_hex();
    let start = format!("{:064x}", 0x2000);
    let end = format!("{:064x}", 0x207f);
    let job_id;
    let first_index;

    {
        let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
        let addr = handle.addr;
        job_id = create_job(
            addr,
            json!({
                "mode": "xpoint",
                "target": target,
                "start": start,
                "end": end,
                "chunk_width": 0x40,
            }),
        );
        let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "alpha");
        let lease = client
            .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
            .expect("lease")
            .expect("first chunk");
        first_index = lease.chunk_index;
        handle.shutdown();
    }

    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("respawn");
    let addr = handle.addr;
    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "beta");

    let jobs = client.jobs().expect("jobs after restart");
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].id, job_id);

    let lease = client
        .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
        .expect("lease after restart")
        .expect("second chunk");
    assert_ne!(
        lease.chunk_index, first_index,
        "the chunk leased before the restart is still reserved"
    );

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let status: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    let clients = status["clients"].as_array().expect("clients");
    assert!(
        clients.iter().any(|client| client["client_id"] == "alpha"),
        "the pre-restart lease survived: {body}"
    );

    handle.shutdown();
}

fn create_client_as(addr: SocketAddr, admin: &str, name: &str) -> (String, String) {
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/clients",
        Some(admin),
        Some(&json!({ "name": name }).to_string()),
    );
    assert_eq!(status, 201, "create client failed: {body}");
    let value: serde_json::Value = serde_json::from_str(&body).expect("client JSON");
    assert_eq!(value["name"], name);
    let id = value["id"].as_str().expect("client id").to_string();
    let token = value["token"].as_str().expect("client token").to_string();
    assert_eq!(token.len(), 64, "token must be 32 bytes of hex");
    (id, token)
}

fn xpoint_job_body(target: &str, start: &str, end: &str) -> serde_json::Value {
    json!({
        "mode": "xpoint",
        "target": target,
        "start": start,
        "end": end,
        "chunk_width": 8,
        "lease_ttl": 600,
    })
}

#[test]
fn admin_account_endpoints_and_disabled_tokens() {
    let temp = TempState::new("accounts");
    let handle = spawn_with_options(
        "127.0.0.1:0",
        temp.path(),
        TOKEN.to_string(),
        Clients::default(),
        false,
    )
    .expect("spawn");
    let addr = handle.addr;

    // Registration is closed by default.
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/register",
        None,
        Some(&json!({ "name": "Eve" }).to_string()),
    );
    assert_eq!(status, 403, "closed registration: {body}");

    // The admin creates an account and receives the token once.
    let (alpha_id, alpha_token) = create_client_as(addr, TOKEN, "Alpha");

    // The list is admin-only and never leaks the token hash.
    let (status, _, body) = raw(addr, "GET", "/api/v1/clients", Some(TOKEN), None);
    assert_eq!(status, 200);
    let value: serde_json::Value = serde_json::from_str(&body).expect("clients JSON");
    let clients = value["clients"].as_array().expect("clients");
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0]["id"], alpha_id.as_str());
    assert_eq!(clients[0]["name"], "Alpha");
    assert!(clients[0].get("token_hash").is_none(), "hash must not leak");
    assert!(clients[0]["history"].is_array());

    // A client token cannot use admin endpoints.
    let (status, _, _) = raw(addr, "GET", "/api/v1/clients", Some(&alpha_token), None);
    assert_eq!(status, 403);
    let (status, _, _) = raw(
        addr,
        "POST",
        "/api/v1/clients",
        Some(&alpha_token),
        Some(&json!({ "name": "Sneaky" }).to_string()),
    );
    assert_eq!(status, 403);

    // Admin creates the job; the client leases it.
    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job_as(addr, TOKEN, xpoint_job_body(&target, "1", "8"));
    let client = CoordinatorClient::new(&format!("http://{addr}"), &alpha_token, "alpha");
    let lease = client
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "8")
        .expect("lease")
        .expect("chunk");
    assert!(
        client
            .heartbeat(
                &job_id,
                lease.chunk_index,
                lease.lease_id,
                64,
                10.0,
                false,
                &[]
            )
            .is_ok()
    );

    // The cabinet is scoped to the token; the admin has no record.
    let (status, _, body) = raw(addr, "GET", "/api/v1/me", Some(&alpha_token), None);
    assert_eq!(status, 200, "me failed: {body}");
    let me: serde_json::Value = serde_json::from_str(&body).expect("me JSON");
    assert_eq!(me["client"]["id"], alpha_id.as_str());
    assert_eq!(me["rank"], 1);
    assert_eq!(me["lease"]["job_id"], job_id.as_str());
    assert_eq!(me["client"]["scanned_total"], 64);
    let (status, _, _) = raw(addr, "GET", "/api/v1/me", Some(TOKEN), None);
    assert_eq!(status, 403, "the admin has no personal cabinet");

    // Disabling revokes the token and releases its lease.
    let disable_path = format!("/api/v1/clients/{alpha_id}/disable");
    let (status, _, body) = raw(addr, "POST", &disable_path, Some(TOKEN), None);
    assert_eq!(status, 200, "disable failed: {body}");
    let (status, _, _) = raw(addr, "GET", "/api/v1/me", Some(&alpha_token), None);
    assert_eq!(status, 401, "a disabled token must be unauthorized");
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some(&alpha_token), None);
    assert_eq!(status, 401);
    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let status: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert!(
        status["clients"].as_array().expect("clients").is_empty(),
        "the disabled client's lease must be released: {body}"
    );
    let (status, _, _) = raw(
        addr,
        "POST",
        "/api/v1/clients/missing/disable",
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 404);

    handle.shutdown();
}

#[test]
fn registration_is_flag_gated_and_rate_limited() {
    let temp = TempState::new("register");
    let handle = spawn_with_options(
        "127.0.0.1:0",
        temp.path(),
        TOKEN.to_string(),
        Clients::default(),
        true,
    )
    .expect("spawn");
    let addr = handle.addr;

    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/register",
        None,
        Some(&json!({ "name": "Eve" }).to_string()),
    );
    assert_eq!(status, 201, "registration failed: {body}");
    let created: serde_json::Value = serde_json::from_str(&body).expect("register JSON");
    let token = created["token"].as_str().expect("token").to_string();
    assert_eq!(token.len(), 64);

    // A second registration from the same IP inside the window is throttled.
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/register",
        None,
        Some(&json!({ "name": "Mallory" }).to_string()),
    );
    assert_eq!(status, 429, "second registration: {body}");

    // The new token can immediately lease a job created by the admin.
    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job_as(addr, TOKEN, xpoint_job_body(&target, "1", "8"));
    let client = CoordinatorClient::new(&format!("http://{addr}"), &token, "eve");
    let lease = client
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "8")
        .expect("lease")
        .expect("chunk");
    assert!(lease.chunk_index < 8);

    // The public summary reports the flag and counts the account.
    let (status, _, body) = raw(addr, "GET", "/api/v1/summary", None, None);
    assert_eq!(status, 200);
    let summary: serde_json::Value = serde_json::from_str(&body).expect("summary JSON");
    assert_eq!(summary["registration_open"], true);
    assert_eq!(summary["totals"]["jobs"], 1);
    assert_eq!(summary["leaderboard"][0]["name"], "Eve");

    // A bad name is rejected before an account is created.
    let temp2 = TempState::new("register-invalid");
    let handle2 = spawn_with_options(
        "127.0.0.1:0",
        temp2.path(),
        TOKEN.to_string(),
        Clients::default(),
        true,
    )
    .expect("spawn");
    let (status, _, body) = raw(
        handle2.addr,
        "POST",
        "/api/v1/register",
        None,
        Some(&json!({ "name": "<script>" }).to_string()),
    );
    assert_eq!(status, 400, "html name: {body}");
    handle2.shutdown();

    handle.shutdown();
}

#[test]
fn cabinet_is_scoped_and_the_leaderboard_is_ordered() {
    let temp = TempState::new("cabinet");
    let handle = spawn_with_options(
        "127.0.0.1:0",
        temp.path(),
        TOKEN.to_string(),
        Clients::default(),
        false,
    )
    .expect("spawn");
    let addr = handle.addr;

    let (alpha_id, alpha_token) = create_client_as(addr, TOKEN, "Alpha");
    let (beta_id, beta_token) = create_client_as(addr, TOKEN, "Beta");
    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job_as(addr, TOKEN, xpoint_job_body(&target, "1", "10"));

    let alpha = CoordinatorClient::new(&format!("http://{addr}"), &alpha_token, "alpha");
    let beta = CoordinatorClient::new(&format!("http://{addr}"), &beta_token, "beta");
    let alpha_lease = alpha
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "10")
        .expect("lease")
        .expect("chunk");
    let beta_lease = beta
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "10")
        .expect("lease")
        .expect("chunk");
    assert_ne!(alpha_lease.chunk_index, beta_lease.chunk_index);
    alpha
        .heartbeat(
            &job_id,
            alpha_lease.chunk_index,
            alpha_lease.lease_id,
            100,
            10.0,
            false,
            &[],
        )
        .expect("alpha heartbeat");
    beta.heartbeat(
        &job_id,
        beta_lease.chunk_index,
        beta_lease.lease_id,
        50,
        5.0,
        false,
        &[],
    )
    .expect("beta heartbeat");

    // A heartbeat cannot borrow another client's lease.
    beta.heartbeat(
        &job_id,
        alpha_lease.chunk_index,
        alpha_lease.lease_id,
        100,
        1.0,
        false,
        &[],
    )
    .expect_err("a foreign lease nonce is rejected");

    let (status, _, body) = raw(addr, "GET", "/api/v1/summary", None, None);
    assert_eq!(status, 200);
    let summary: serde_json::Value = serde_json::from_str(&body).expect("summary JSON");
    assert_eq!(summary["totals"]["scanned"], 150);
    assert_eq!(summary["totals"]["clients_active"], 2);
    assert_eq!(summary["totals"]["jobs"], 1);
    assert_eq!(summary["leaderboard"][0]["id"], alpha_id.as_str());
    assert_eq!(summary["leaderboard"][1]["id"], beta_id.as_str());

    let (status, _, body) = raw(addr, "GET", "/api/v1/me", Some(&alpha_token), None);
    assert_eq!(status, 200);
    let me: serde_json::Value = serde_json::from_str(&body).expect("me JSON");
    assert_eq!(me["client"]["id"], alpha_id.as_str());
    assert_eq!(me["rank"], 1);
    assert_eq!(me["lease"]["job_id"], job_id.as_str());
    assert_eq!(me["job"]["id"], job_id.as_str());

    // An accepted result is credited only to the submitting client.
    alpha
        .submit_result(&job_id, alpha_lease.lease_id, &Scalar::from_u64(7).to_hex())
        .expect("valid proof");
    let (status, _, body) = raw(addr, "GET", "/api/v1/me", Some(&alpha_token), None);
    assert_eq!(status, 200);
    let me: serde_json::Value = serde_json::from_str(&body).expect("me JSON");
    assert_eq!(me["client"]["found"], 1);
    assert_eq!(me["results"].as_array().expect("results").len(), 1);
    assert!(me["lease"].is_null(), "the found job drops its leases");
    let (status, _, body) = raw(addr, "GET", "/api/v1/me", Some(&beta_token), None);
    assert_eq!(status, 200);
    let me: serde_json::Value = serde_json::from_str(&body).expect("me JSON");
    assert_eq!(me["client"]["found"], 0);
    assert!(me["results"].as_array().expect("results").is_empty());

    let (status, _, body) = raw(addr, "GET", "/api/v1/summary", None, None);
    assert_eq!(status, 200);
    let summary: serde_json::Value = serde_json::from_str(&body).expect("summary JSON");
    assert_eq!(summary["totals"]["results"], 1);
    assert_eq!(summary["leaderboard"][0]["found"], 1);

    handle.shutdown();
}

#[test]
fn public_pages_and_assets_are_served() {
    let temp = TempState::new("pages");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let checks: [(&str, &[&str]); 8] = [
        (
            "/",
            &[
                "Rotor Coordinator",
                "id=\"totals-scanned\"",
                "id=\"join-form\"",
                "href=\"/private-keys\"",
                "href=\"/bitcoin-puzzle\"",
                "href=\"/brainwallet\"",
                "href=\"/cabinet\"",
                "href=\"/docs\"",
            ],
        ),
        (
            "/app",
            &[
                "id=\"jobs\"",
                "id=\"leaderboard-body\"",
                "/api/v1/status",
                "id=\"global-scanned\"",
            ],
        ),
        (
            "/me",
            &["id=\"sparkline\"", "/api/v1/me", "id=\"me-token\""],
        ),
        (
            "/docs",
            &["--coordinator", "--token", "-m addresses", "--client-id"],
        ),
        (
            "/cabinet/wallet",
            &[
                "id=\"wallet-panel\"",
                "id=\"wallet-unlock-form\"",
                "/wallet-vault.js?v=20261122b",
                "/theme.js?v=20261122b",
            ],
        ),
        (
            "/key",
            &[
                "class=\"address-type-panel key-address-panel\"",
                "class=\"address-type-card\"",
                "data-row=\"btc_p2pkh\"",
                "id=\"btc-panel\"",
            ],
        ),
        ("/site.css", &[":root", "--bg", "@media"]),
        ("/site.js", &["window.Rotor", "sparkline", "TOKEN_KEY"]),
    ];
    for (path, needles) in checks {
        let (status, headers, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        if path.ends_with(".css") {
            assert!(
                headers.to_ascii_lowercase().contains("text/css"),
                "{path}: {headers}"
            );
        }
        for needle in needles {
            assert!(body.contains(needle), "{path} misses {needle}");
        }
    }

    // The wallet vault codec and page script are served as JavaScript.
    for (path, needle) in [
        ("/wallet.js", "rotor-wallet"),
        ("/wallet-vault.js", "PBKDF2-SHA256"),
        ("/wallet-btc.js", "RotorBtcSend"),
    ] {
        let (status, headers, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("application/javascript"),
            "{path}: {headers}"
        );
        assert!(body.contains(needle), "{path} misses {needle}");
    }

    // Unknown non-API paths are a real 404, not a landing-page fallback.
    let (status, _, _) = raw(addr, "GET", "/anything", None, None);
    assert_eq!(status, 404);

    // The parity map is internal docs now; its old public route is gone.
    for path in [
        "/site-map",
        "/site-map.css",
        "/site-map.js",
        "/site-map-data.js",
    ] {
        let (status, _, _) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 404, "{path} must not be served");
    }
    let (status, _, sitemap) = raw(addr, "GET", "/sitemap.xml", None, None);
    assert_eq!(status, 200);
    assert!(
        !sitemap.contains("/site-map"),
        "sitemap.xml must not list the internal parity map"
    );

    // The authenticated API is still protected.
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", None, None);
    assert_eq!(status, 401);

    handle.shutdown();
}

/// Minimal HTTP upstream used to prove the wallet download route streams
/// through the coordinator and maps upstream failures to clean statuses.
struct MockUpstream {
    base: String,
    hits: Arc<AtomicUsize>,
    mode: Arc<AtomicUsize>,
    paths: Arc<Mutex<Vec<String>>>,
}

impl MockUpstream {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock upstream");
        let addr = listener.local_addr().expect("mock address");
        let hits = Arc::new(AtomicUsize::new(0));
        let mode = Arc::new(AtomicUsize::new(0));
        let paths = Arc::new(Mutex::new(Vec::new()));
        let hits_thread = Arc::clone(&hits);
        let mode_thread = Arc::clone(&mode);
        let paths_thread = Arc::clone(&paths);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                paths_thread.lock().unwrap().push(path);
                hits_thread.fetch_add(1, Ordering::SeqCst);
                let body = b"mock-wallet-dataset";
                let head = match mode_thread.load(Ordering::SeqCst) {
                    1 => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                    2 => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                    _ => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    ),
                };
                let _ = stream.write_all(head.as_bytes());
                if mode_thread.load(Ordering::SeqCst) == 0 {
                    let _ = stream.write_all(body);
                }
            }
        });
        Self {
            base: format!("http://{addr}"),
            hits,
            mode,
            paths,
        }
    }

    fn set_mode(&self, mode: usize) {
        self.mode.store(mode, Ordering::SeqCst);
    }
}

#[test]
fn wallet_catalog_is_public_and_downloads_stream_through_our_origin() {
    let coordinator_state = TempState::new("wallets");
    let monitor_state = TempState::new("wallets-monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let upstream = MockUpstream::start();
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            open_registration: false,
            trust_proxy: false,
            monitor_domain: "127.0.0.1".to_string(),
            wallets_upstream: Some(upstream.base.clone()),
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;

    // Catalogue: public, six chains, license notice, no upstream host.
    let (status, headers, body) = raw(addr, "GET", "/api/v1/wallets", None, None);
    assert_eq!(status, 200, "catalogue: {body}");
    assert!(headers.to_ascii_lowercase().contains("application/json"));
    assert!(!body.contains("github.com"), "upstream host leaked: {body}");
    assert!(body.contains("Copyright (c) 2022 MMDRZA"), "{body}");
    let catalog: serde_json::Value = serde_json::from_str(&body).expect("catalogue JSON");
    assert_eq!(catalog["datasets"].as_array().unwrap().len(), 6);
    assert_eq!(catalog["license"]["name"], "MIT");
    assert_eq!(
        catalog["datasets"][0]["download"],
        "/api/v1/wallets/bitcoin/download"
    );

    // Single-chain lookup and the strict allowlist.
    let (status, _, body) = raw(addr, "GET", "/api/v1/wallets/dash", None, None);
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"chain\":\"dash\""));
    assert!(!body.contains("github.com"));
    let (status, _, _) = raw(addr, "GET", "/api/v1/wallets/bitcoincash", None, None);
    assert_eq!(status, 404, "only the slug allowlist may resolve");
    let (status, _, _) = raw(addr, "GET", "/api/v1/wallets/../secret", None, None);
    assert_eq!(status, 404);

    // Storefront page and machine-readable license file.
    let (status, _, page) = raw(addr, "GET", "/wallets", None, None);
    assert_eq!(status, 200);
    assert!(page.contains("Rich-address wallet databases"), "{page}");
    assert!(
        page.contains("/api/v1/wallets/bitcoin/download"),
        "download must stay on our origin"
    );
    assert!(page.contains("/wallets/LICENSE.txt"));
    assert!(page.contains("Request access"));
    assert!(page.contains("Copyright (c) 2022 MMDRZA"));
    assert!(!page.contains("github.com"), "page links upstream: {page}");
    let (status, headers, license) = raw(addr, "GET", "/wallets/LICENSE.txt", None, None);
    assert_eq!(status, 200);
    assert!(headers.to_ascii_lowercase().contains("text/plain"));
    assert!(license.contains("MIT License"));
    assert!(license.contains("Copyright (c) 2022 MMDRZA"));

    // The landing page links to /wallets only, never to the upstream host.
    let (status, _, landing) = raw(addr, "GET", "/", None, None);
    assert_eq!(status, 200);
    assert!(landing.contains("href=\"/wallets\""));
    assert!(
        !landing.contains("github.com"),
        "landing leaks upstream: {landing}"
    );

    // Successful proxied download.
    let (status, headers, body) = raw(addr, "GET", "/api/v1/wallets/bitcoin/download", None, None);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body, "mock-wallet-dataset");
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("content-disposition: attachment")
    );
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("content-type: application/gzip")
    );
    assert!(
        headers.to_ascii_lowercase().contains("rel=\"license\""),
        "MIT notice must travel with the data: {headers}"
    );
    let requested = upstream.paths.lock().unwrap().clone();
    assert_eq!(requested.len(), 1);
    assert_eq!(requested[0], "/Bitcoin/Latest_Rich_Bitcoin_Address.txt.gz");

    // Upstream failure is a clean 502, not a leaked error page.
    upstream.set_mode(1);
    let (status, _, body) = raw(addr, "GET", "/api/v1/wallets/ethereum/download", None, None);
    assert_eq!(status, 502, "{body}");
    assert!(body.contains("upstream download failed"));
    assert!(!body.contains("github.com"));

    // The download bucket allows a burst of two, then answers 429 without
    // calling upstream again.
    let hits_before = upstream.hits.load(Ordering::SeqCst);
    let (status, _, _) = raw(addr, "GET", "/api/v1/wallets/dogecoin/download", None, None);
    assert_eq!(status, 429);
    assert_eq!(upstream.hits.load(Ordering::SeqCst), hits_before);

    handle.shutdown();
}
