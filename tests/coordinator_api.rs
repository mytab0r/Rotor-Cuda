//! End-to-end tests for the coordinator HTTP API and its blocking client.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rotor::base58;
use rotor::bsgs::TableManifest;
use rotor::coordinator::client::CoordinatorClient;
use rotor::coordinator::spawn;
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
    let (status, _, response) = raw(
        addr,
        "POST",
        "/api/v1/jobs",
        Some(TOKEN),
        Some(&body.to_string()),
    );
    assert_eq!(status, 201, "create job failed: {response}");
    let value: serde_json::Value = serde_json::from_str(&response).expect("job JSON");
    value["id"].as_str().expect("job id").to_string()
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
        .heartbeat(&job_id, lease_a.chunk_index, 1_024, 512.0, false)
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
    assert_eq!(
        client
            .submit_result(&job_id, &Scalar::from_u64(43).to_hex())
            .expect_err("wrong key must fail"),
        "invalid proof"
    );

    client
        .submit_result(&job_id, &key.to_hex())
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
fn state_survives_a_coordinator_restart() {
    let temp = TempState::new("restart");
    let target = secp::mul_g(&Scalar::from_u64(11)).x.to_hex();
    let start = format!("{:064x}", 0x2000);
    let end = format!("{:064x}", 0x207f);
    let job_id;

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
        assert_eq!(lease.chunk_index, 0);
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
    assert_eq!(
        lease.chunk_index, 1,
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
