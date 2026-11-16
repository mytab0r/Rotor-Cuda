//! Coordinator chunk loop for non-CPU scanners, driven by a stub scanner and
//! an in-process coordinator (no GPU required). A device-gated test checks the
//! GPU entry point's no-device error under `--features gpu`.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rotor::coordinator::chunk_loop::{ChunkScanner, LeaseJob, ScanOutcome, run_leases};
use rotor::coordinator::client::CoordinatorClient;
use rotor::coordinator::spawn;
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
            "rotor_gpu_coord_{tag}_{}_{nanos}.{extension}",
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

fn scalar_hex(value: u64) -> String {
    Scalar::from_u64(value).to_hex()
}

fn xpoint(key: u64) -> String {
    secp::mul_g(&Scalar::from_u64(key)).x.to_hex()
}

fn low_u64(value: &Scalar) -> u64 {
    let bytes = value.to_bytes_be();
    u64::from_be_bytes(bytes[24..32].try_into().expect("eight bytes"))
}

fn lease_job(target: Option<String>, start: u64, end: u64) -> LeaseJob {
    LeaseJob {
        mode: "xpoint".to_owned(),
        coin: "btc".to_owned(),
        target,
        start: scalar_hex(start),
        end: scalar_hex(end),
    }
}

/// Shared log of the leased windows a stub scanner saw.
type WindowLog = Rc<RefCell<Vec<(Scalar, Scalar)>>>;

/// Records the leased windows and optionally reports a found key.
struct StubScanner {
    seen: WindowLog,
    found: Option<Scalar>,
    delay: Duration,
}

impl StubScanner {
    fn new(found: Option<Scalar>, delay: Duration) -> (Self, WindowLog) {
        let seen = Rc::new(RefCell::new(Vec::new()));
        (
            Self {
                seen: Rc::clone(&seen),
                found,
                delay,
            },
            seen,
        )
    }
}

impl ChunkScanner for StubScanner {
    fn scan(&mut self, start: &Scalar, end: &Scalar) -> Result<ScanOutcome, String> {
        self.seen.borrow_mut().push((*start, *end));
        if !self.delay.is_zero() {
            thread::sleep(self.delay);
        }
        let found = self.found.filter(|key| *key >= *start && *key <= *end);
        Ok(ScanOutcome {
            scanned: low_u64(&end.sub(start)).saturating_add(1),
            found,
        })
    }
}

#[test]
fn two_clients_lease_disjoint_chunks() {
    let state = TempPath::new("chunks", "json");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    let target = xpoint(5);
    let job = CoordinatorClient::new(&url, TOKEN, "setup")
        .create_job(json!({
            "mode": "xpoint",
            "target": target,
            "start": scalar_hex(1),
            "end": scalar_hex(4),
            "chunk_width": 1,
            "lease_ttl": 600,
        }))
        .expect("create job");
    assert_eq!(job.chunks_total, 4);

    let request = lease_job(Some(target), 1, 4);
    let mut handles = Vec::new();
    for client_id in ["a", "b"] {
        let url = url.clone();
        let request = request.clone();
        handles.push(thread::spawn(move || {
            let (mut scanner, seen) = StubScanner::new(None, Duration::ZERO);
            let client = CoordinatorClient::new(&url, TOKEN, client_id);
            let (_, found) = run_leases(&client, &request, &mut scanner).expect("run leases");
            assert_eq!(found, None);
            seen.borrow().clone()
        }));
    }

    let mut windows = Vec::new();
    for handle in handles {
        windows.extend(handle.join().expect("join client thread"));
    }
    windows.sort_by_key(|(start, _)| low_u64(start));
    let ranges: Vec<(u64, u64)> = windows
        .iter()
        .map(|(start, end)| (low_u64(start), low_u64(end)))
        .collect();
    assert_eq!(
        ranges,
        vec![(1, 1), (2, 2), (3, 3), (4, 4)],
        "the two clients must scan each chunk exactly once"
    );

    handle.shutdown();
}

#[test]
fn found_key_is_submitted_with_a_valid_proof() {
    let state = TempPath::new("found", "json");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    let target = xpoint(3);
    let job = CoordinatorClient::new(&url, TOKEN, "setup")
        .create_job(json!({
            "mode": "xpoint",
            "target": target,
            "start": scalar_hex(1),
            "end": scalar_hex(4),
            "chunk_width": 2,
            "lease_ttl": 600,
        }))
        .expect("create job");

    let request = lease_job(Some(target), 1, 4);
    let (mut scanner, _) = StubScanner::new(Some(Scalar::from_u64(3)), Duration::ZERO);
    let client = CoordinatorClient::new(&url, TOKEN, "gpu");
    let (scanned, found) = run_leases(&client, &request, &mut scanner).expect("run leases");
    assert_eq!(scanned, 4, "both chunks must be scanned");
    assert_eq!(found, Some(Scalar::from_u64(3)));

    let setup = CoordinatorClient::new(&url, TOKEN, "setup");
    let stored = setup
        .jobs()
        .expect("jobs")
        .into_iter()
        .find(|entry| entry.id == job.id)
        .expect("job");
    assert!(stored.found);
    assert_eq!(
        stored.found_key.as_deref(),
        Some(Scalar::from_u64(3).to_hex().as_str())
    );

    handle.shutdown();
}

#[test]
fn invalid_proof_is_rejected() {
    let state = TempPath::new("invalid", "json");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    // The scanner reports a key inside the range but not matching the target.
    let target = xpoint(7);
    let job = CoordinatorClient::new(&url, TOKEN, "setup")
        .create_job(json!({
            "mode": "xpoint",
            "target": target,
            "start": scalar_hex(1),
            "end": scalar_hex(10),
            "chunk_width": 10,
            "lease_ttl": 600,
        }))
        .expect("create job");

    let request = lease_job(Some(target), 1, 10);
    let (mut scanner, _) = StubScanner::new(Some(Scalar::from_u64(8)), Duration::ZERO);
    let client = CoordinatorClient::new(&url, TOKEN, "gpu");
    let err = run_leases(&client, &request, &mut scanner).expect_err("invalid proof must abort");
    assert!(err.contains("invalid proof"), "unexpected error: {err}");

    let stored = CoordinatorClient::new(&url, TOKEN, "setup")
        .jobs()
        .expect("jobs")
        .into_iter()
        .find(|entry| entry.id == job.id)
        .expect("job");
    assert!(!stored.found);

    handle.shutdown();
}

#[test]
fn exhausted_job_ends_normally() {
    let state = TempPath::new("exhausted", "json");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    let target = xpoint(5);
    let job = CoordinatorClient::new(&url, TOKEN, "setup")
        .create_job(json!({
            "mode": "xpoint",
            "target": target,
            "start": scalar_hex(1),
            "end": scalar_hex(2),
            "chunk_width": 2,
            "lease_ttl": 600,
        }))
        .expect("create job");

    // Complete the only chunk first: the next lease answers 204.
    let setup = CoordinatorClient::new(&url, TOKEN, "setup");
    let lease = setup
        .lease(
            Some(&job.id),
            Some(&target),
            "xpoint",
            "btc",
            &scalar_hex(1),
            &scalar_hex(2),
        )
        .expect("lease")
        .expect("chunk");
    setup
        .heartbeat(&job.id, lease.chunk_index, 2, 1.0, true)
        .expect("finish chunk");

    let request = lease_job(Some(target), 1, 2);
    let (mut scanner, seen) = StubScanner::new(None, Duration::ZERO);
    let client = CoordinatorClient::new(&url, TOKEN, "gpu");
    let outcome = run_leases(&client, &request, &mut scanner).expect("a done job ends the loop");
    assert_eq!(outcome, (0, None));
    assert!(seen.borrow().is_empty(), "no chunk may be scanned");

    handle.shutdown();
}

#[test]
fn lost_lease_aborts() {
    let state = TempPath::new("lost", "json");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    let target = xpoint(5);
    CoordinatorClient::new(&url, TOKEN, "setup")
        .create_job(json!({
            "mode": "xpoint",
            "target": target,
            "start": scalar_hex(1),
            "end": scalar_hex(2),
            "chunk_width": 2,
            // The scan outlives this lease; the closing heartbeat must fail.
            "lease_ttl": 1,
        }))
        .expect("create job");

    let request = lease_job(Some(target), 1, 2);
    let (mut scanner, _) = StubScanner::new(None, Duration::from_millis(1_500));
    let client = CoordinatorClient::new(&url, TOKEN, "gpu");
    let err = run_leases(&client, &request, &mut scanner).expect_err("a lost lease must abort");
    assert!(err.contains("lease lost"), "unexpected error: {err}");

    handle.shutdown();
}

#[test]
fn lost_lease_after_the_job_was_found_stops_normally() {
    let state = TempPath::new("found_during_scan", "json");
    let handle = spawn("127.0.0.1:0", state.path(), TOKEN.to_string()).expect("spawn");
    let url = format!("http://{}", handle.addr);

    let key = Scalar::from_u64(1);
    let target = xpoint(1);
    let job = CoordinatorClient::new(&url, TOKEN, "setup")
        .create_job(json!({
            "mode": "xpoint",
            "target": target,
            "start": scalar_hex(1),
            "end": scalar_hex(1),
            "chunk_width": 1,
            "lease_ttl": 600,
        }))
        .expect("create job");

    // The scan submits the key itself, so the closing heartbeat sees the job
    // found and a lease that no longer exists.
    struct SubmitDuringScan {
        client: CoordinatorClient,
        job_id: String,
        key: Scalar,
    }

    impl ChunkScanner for SubmitDuringScan {
        fn scan(&mut self, _start: &Scalar, _end: &Scalar) -> Result<ScanOutcome, String> {
            self.client
                .submit_result(&self.job_id, &self.key.to_hex())
                .map_err(|err| format!("submit during scan: {err}"))?;
            Ok(ScanOutcome {
                scanned: 1,
                found: None,
            })
        }
    }

    let request = lease_job(Some(target), 1, 1);
    let client = CoordinatorClient::new(&url, TOKEN, "gpu");
    let mut scanner = SubmitDuringScan {
        client: client.clone(),
        job_id: job.id.clone(),
        key,
    };
    let (scanned, found) =
        run_leases(&client, &request, &mut scanner).expect("a found job is a normal stop");
    assert_eq!((scanned, found), (1, None));

    let stored = CoordinatorClient::new(&url, TOKEN, "setup")
        .jobs()
        .expect("jobs")
        .into_iter()
        .find(|entry| entry.id == job.id)
        .expect("job");
    assert!(
        stored.found,
        "the key submitted during the scan was accepted"
    );

    handle.shutdown();
}

#[cfg(feature = "gpu")]
mod device {
    use super::*;
    use rotor::cli::{Coin, CompMode, Config, Range, SearchMode, U256};

    #[test]
    fn gpu_coordinator_without_a_device_fails_loudly() {
        if rotor::gpu::device_count().unwrap_or(0) > 0 {
            eprintln!("skipping: a CUDA device is present");
            return;
        }
        let output = TempPath::new("gpu_no_device", "txt");
        let config = Config {
            gpu: true,
            mode: Some(SearchMode::Address),
            coin: Coin::Btc,
            comp_mode: CompMode::Compressed,
            range: Some(Range {
                start: U256::from_u64(1),
                end: U256::from_u64(2),
            }),
            operands: vec!["14iXhn8bGajVWegZHJ18vJLHhntcpL4dex".to_owned()],
            output_file: output.path().display().to_string(),
            gpu_ids: vec![0],
            display: 0,
            coordinator: Some("http://127.0.0.1:1".to_owned()),
            token: Some("secret".to_owned()),
            ..Config::default()
        };

        let err = rotor::gpu_search::run(&config).expect_err("no device must fail");
        assert!(
            err.to_lowercase().contains("device"),
            "unexpected error: {err}"
        );
    }
}
