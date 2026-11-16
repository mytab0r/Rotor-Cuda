//! Client-side coordinator integration: the engine leases chunks, BSGS resumes
//! from a stored giant index, and two clients never receive the same chunk.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rotor::bsgs::{build_table, solve_with_table};
use rotor::cli::{Coin, Config, Range, SearchMode, U256};
use rotor::coordinator::client::CoordinatorClient;
use rotor::coordinator::spawn;
use rotor::engine;
use rotor::scalar::Scalar;
use rotor::secp;
use serde_json::json;

const TOKEN: &str = "test-token";

/// Temporary file removed on drop (plus the coordinator's `.tmp` sibling).
struct TempPath(PathBuf);

impl TempPath {
    fn new(tag: &str, extension: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        Self(std::env::temp_dir().join(format!(
            "rotor_coord_client_{tag}_{}_{nanos}.{extension}",
            std::process::id()
        )))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_file(format!("{}.tmp", self.0.display()));
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex(value: &str) -> U256 {
    U256::from_hex(value).expect("valid test hex")
}

#[test]
fn engine_leases_chunks_and_reports_the_found_key() {
    let state = TempPath::new("engine_state", "json");
    let output = TempPath::new("engine_output", "txt");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    let setup = CoordinatorClient::new(&url, TOKEN, "setup");
    let job = setup
        .create_job(json!({
            "mode": "address",
            "coin": "btc",
            "comp_mode": "compressed",
            "target": "14iXhn8bGajVWegZHJ18vJLHhntcpL4dex",
            "start": "1757756A90",
            "end": "1757756A95",
            // The key is in the second of two chunks; both chunks are leased
            // before the hit can end the job, so the scan count is exact.
            "chunk_width": 3,
            "lease_ttl": 600,
        }))
        .expect("create job");
    assert_eq!(job.chunks_total, 2);

    let config = Config {
        mode: Some(SearchMode::Address),
        coin: Coin::Btc,
        range: Some(Range {
            start: hex("1757756A90"),
            end: hex("1757756A95"),
        }),
        operands: vec!["14iXhn8bGajVWegZHJ18vJLHhntcpL4dex".to_owned()],
        threads: 2,
        display: 0,
        coordinator: Some(url),
        token: Some(TOKEN.to_owned()),
        client_id: Some("engine-client".to_owned()),
        output_file: output.path().to_string_lossy().into_owned(),
        ..Config::default()
    };

    let outcome = engine::run_coordinator(&config).expect("coordinator run");
    assert_eq!(outcome.found, 1);
    assert_eq!(outcome.scanned, 6);

    let text = fs::read_to_string(output.path()).expect("output file");
    assert!(
        text.contains("Priv (HEX): 1757756A93"),
        "missing key block:\n{text}"
    );

    let jobs = setup.jobs().expect("jobs");
    let stored = jobs.iter().find(|entry| entry.id == job.id).expect("job");
    assert!(stored.found);
    let expected = Scalar::from_u64(0x1757756A93).to_hex();
    assert_eq!(stored.found_key.as_deref(), Some(expected.as_str()));

    handle.shutdown();
}

#[test]
fn two_clients_lease_different_chunks() {
    let state = TempPath::new("lease_state", "json");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    let target = secp::mul_g(&Scalar::from_u64(5)).x.to_hex();
    let setup = CoordinatorClient::new(&url, TOKEN, "setup");
    let job = setup
        .create_job(json!({
            "mode": "xpoint",
            "target": target,
            "start": "1",
            "end": "4",
            "chunk_width": 1,
            "lease_ttl": 600,
        }))
        .expect("create job");
    assert_eq!(job.chunks_total, 4);

    let first = CoordinatorClient::new(&url, TOKEN, "a");
    let second = CoordinatorClient::new(&url, TOKEN, "b");
    let lease_a = first
        .lease(Some(&job.id), Some(&target), "xpoint", "btc", "1", "4")
        .expect("lease a")
        .expect("chunk a");
    let lease_b = second
        .lease(Some(&job.id), Some(&target), "xpoint", "btc", "1", "4")
        .expect("lease b")
        .expect("chunk b");

    assert_ne!(
        lease_a.chunk_index, lease_b.chunk_index,
        "two clients must receive disjoint chunks"
    );
    assert_ne!(
        (lease_a.start, lease_a.end),
        (lease_b.start, lease_b.end),
        "chunk ranges must not overlap"
    );

    handle.shutdown();
}

#[test]
fn bsgs_resumes_from_the_coordinator_state() {
    let state = TempPath::new("bsgs_state", "json");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    let start = Scalar::from_u64(0x40_0000);
    let end = Scalar::from_u64(0x80_0000);
    // Placed past the first 1024-giant chunk so the first pass only stores the
    // resume point and the second pass resumes and recovers it.
    let key = Scalar::from_u64(0x70_0000);
    let target = secp::mul_g(&key);

    let setup = CoordinatorClient::new(&url, TOKEN, "setup");
    let job = setup
        .create_job(json!({
            "mode": "bsgs",
            "target": hex_bytes(&secp::compress(&target)),
            "start": start.to_hex(),
            "end": end.to_hex(),
        }))
        .expect("create job");

    let table = build_table(&start, &end, 0).expect("build table");

    // One client stores the resume point, a second one restores it.
    let writer = CoordinatorClient::new(&url, TOKEN, "bsgs-1");
    let mut calls = 0;
    let first = solve_with_table(&target, &start, &end, &table, 0, &mut |manifest, index| {
        calls += 1;
        writer
            .bsgs_put(&job.id, manifest, index as u64)
            .expect("store resume point");
        false
    });
    assert!(!first.found);
    assert_eq!(calls, 1, "the callback stops after the first chunk");

    let resumer = CoordinatorClient::new(&url, TOKEN, "bsgs-2");
    let remote = resumer
        .bsgs_get(&job.id)
        .expect("get state")
        .expect("stored state");
    assert!(remote.manifest.compatible(&table.manifest));
    let start_index = u128::from(remote.giant_index);
    assert_eq!(start_index, 1024);

    let second = solve_with_table(&target, &start, &end, &table, start_index, &mut |_, _| true);
    assert!(second.error.is_none(), "{:?}", second.error);
    assert!(second.found);
    assert_eq!(second.key, key);
    assert!(
        u128::from(second.giant_steps) > start_index,
        "resume must report absolute giant steps: {}",
        second.giant_steps
    );

    let different = build_table(&start, &end, 1024).expect("different table");
    assert!(!different.manifest.compatible(&table.manifest));

    handle.shutdown();
}
