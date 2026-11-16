//! CPU multi-threaded key search for the BTC address/xpoint and ETH address
//! modes, with optional random-start scanning.
//!
//! Ported from the CPU path in `Rotor-Cuda/Rotor.cpp` (range split, batch point
//! generation, hit output and progress line) and the startup banner in
//! `Rotor-Cuda/Main.cpp`.
//!
//! Checkpoints (`Rotor-Cuda_Continue.bat` / `Rotor-Cuda_START.bat`) are
//! written and read through [`crate::checkpoint`]; GPU search belongs to a
//! later milestone.

#![allow(clippy::needless_range_loop)] // fixed-size limb loops read better with indices

use std::cmp::Ordering;
use std::fmt::Write as FmtWrite;
use std::fs::{File, OpenOptions};
use std::io::{self, Write as IoWrite};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Mutex, Once};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::base58;
use crate::checkpoint;
use crate::cli::{self, Coin, CompMode, Config, SearchMode, U256};
use crate::coordinator::client::{CoordinatorClient, JobInfo};
use crate::filter::TargetSet;
use crate::point::{Affine, Jacobian, batch_to_affine};
use crate::scalar::Scalar;
use crate::secp;
use crate::targets_text;

/// Number of keys generated and normalized per batch (`CPU_GRP_SIZE` in C++).
const BATCH_SIZE: usize = 2048;

/// Set by the Ctrl-C handler, checked by every worker before each batch.
static STOP: AtomicBool = AtomicBool::new(false);

/// `ctrlc::set_handler` can only be installed once per process.
static HANDLER: Once = Once::new();

/// Clears the stop flag and installs the Ctrl-C handler (idempotent).
pub(crate) fn prepare_ctrl_c() {
    STOP.store(false, AtomicOrdering::SeqCst);
    HANDLER.call_once(|| {
        // Never fail the run if the handler cannot be installed; Ctrl-C then
        // keeps the platform default instead of breaking the search.
        let _ = ctrlc::set_handler(|| {
            STOP.store(true, AtomicOrdering::SeqCst);
        });
    });
}

/// Sets the stop flag, ending every worker at its next batch boundary.
pub(crate) fn request_stop() {
    STOP.store(true, AtomicOrdering::SeqCst);
}

/// True once Ctrl-C was pressed.
#[cfg_attr(not(feature = "gpu"), allow(dead_code))]
pub(crate) fn stop_requested() -> bool {
    STOP.load(AtomicOrdering::SeqCst)
}

/// Result counters returned by [`run`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchOutcome {
    pub found: u64,
    pub scanned: u64,
}

/// Runs a search over `config.range` (sequential) or over random start keys
/// (when `config.rkey > 0`), keeping checkpoint files in the current directory.
///
/// Returns an explicit error for every configuration this milestone cannot
/// honor (unsupported coin/mode pair, missing/invalid range, bad target).
pub fn run(config: &Config) -> Result<SearchOutcome, String> {
    run_in(config, None)
}

/// Like [`run`], but stops the search after `duration` (used by the benchmark).
///
/// A timer thread is started before [`run`], which clears the stop flag at
/// startup, so the timer must start first. Durations below ~50 ms are not a
/// supported use: the flag could be cleared after the timer already fired.
pub fn run_for(config: &Config, duration: Duration) -> Result<SearchOutcome, String> {
    run_for_timed(config, duration).map(|(outcome, _)| outcome)
}

/// Like [`run_for`], but also returns how long the scan actually ran.
///
/// The duration is captured when [`run`] returns, before the stop timer is
/// joined, so a range that exhausts early reports its true scan time instead
/// of the requested duration.
pub fn run_for_timed(
    config: &Config,
    duration: Duration,
) -> Result<(SearchOutcome, Duration), String> {
    let timer = thread::spawn(move || {
        thread::sleep(duration);
        request_stop();
    });
    let started = Instant::now();
    let outcome = run(config);
    let elapsed = started.elapsed();
    let _ = timer.join();
    outcome.map(|outcome| (outcome, elapsed))
}

/// Like [`run`], but reads and writes checkpoints in `checkpoint_dir`
/// (`None` means the current directory).
pub fn run_in(config: &Config, checkpoint_dir: Option<&Path>) -> Result<SearchOutcome, String> {
    let mode = config.mode.ok_or_else(|| {
        "a search mode (-m address|addresses|xpoint|xpoints) is required".to_owned()
    })?;
    let supported = matches!(
        (config.coin, mode),
        (
            Coin::Btc,
            SearchMode::Address | SearchMode::Addresses | SearchMode::XPoint | SearchMode::XPoints
        ) | (Coin::Eth, SearchMode::Address | SearchMode::Addresses)
    );
    if !supported {
        return Err(match config.coin {
            Coin::Eth => "xpoint modes are not supported for ETH".to_owned(),
            Coin::Btc => "unsupported search mode for the CPU engine".to_owned(),
        });
    }
    // `Main.cpp:513-540`: multi-address/xpoint modes take their targets from
    // `-i FILE` only, never from positional operands.
    if matches!(mode, SearchMode::Addresses | SearchMode::XPoints) && !config.operands.is_empty() {
        return Err("Wrong search mode provided for multiple addresses or xpoints".to_owned());
    }
    // `-t 0` means zero CPU workers in the C++ tool; refuse instead of
    // silently using every core.
    if config.threads == 0 {
        return Err("no CPU threads requested".to_owned());
    }

    let random = config.rkey > 0;
    let random_spec = if random {
        Some(RandomSpec::from_config(config)?)
    } else {
        None
    };

    let (start, end) = match config.range {
        Some(range) => {
            let start = Split::from_u256(&range.start);
            let end = Split::from_u256(&range.end);
            if end < start {
                return Err("--range END must be >= START".to_owned());
            }
            if Scalar::from_bytes_be(&range.end.0).is_none() {
                return Err("--range END must be below the secp256k1 curve order n".to_owned());
            }
            (start, end)
        }
        None if random => (Split::from_u256(&U256::ZERO), Split::from_u256(&U256::ZERO)),
        None => return Err("--range START:END is required for search modes".to_owned()),
    };

    let target = build_target(config, mode)?;

    // `Rotor.cpp:213-255`: sequential runs with `-n` resume from the stored
    // per-worker counts and otherwise leave a START.bat behind. A coordinator
    // run keeps its progress on the server, so local checkpoints are off.
    let checkpoint_mode = config.next > 0 && config.rkey == 0 && config.coordinator.is_none();
    let checkpoint_dir = checkpoint_dir.unwrap_or_else(|| Path::new("."));
    let continue_path = checkpoint_dir.join("Rotor-Cuda_Continue.bat");
    let start_path = checkpoint_dir.join("Rotor-Cuda_START.bat");

    let resume = if checkpoint_mode {
        match checkpoint::read_continue(&continue_path).filter(|saved| saved.count > 0) {
            Some(saved) => {
                println!(
                    "  Rotor        : Continuing search from BAT file. Checkpoint created: {}\n",
                    saved.created
                );
                Some(saved)
            }
            None => {
                if let Err(err) = checkpoint::write_start(&start_path, &checkpoint::command_line())
                {
                    eprintln!("  Cannot write Rotor-Cuda_START.bat: {err}");
                }
                None
            }
        }
    } else {
        None
    };

    // `-t 0` was rejected above; keep the divisor non-zero.
    let threads = config.threads.max(1);

    let mut chunks = Vec::new();
    let mut baseline: Vec<u64> = Vec::new();
    let mut chunk_count = 0usize;
    if !random {
        let ranges = split_range(start, end, threads);
        let offsets = resume_offsets(resume.as_ref(), ranges.len());
        chunk_count = ranges.len();
        baseline = offsets.clone();
        for (index, (low, high)) in ranges.into_iter().enumerate() {
            let Some((low, high)) = shift_chunk(low, high, offsets[index], end) else {
                continue;
            };
            let low = low.to_scalar().ok_or_else(|| {
                "--range START must be below the secp256k1 curve order n".to_owned()
            })?;
            let high = high.to_scalar().ok_or_else(|| {
                "--range END must be below the secp256k1 curve order n".to_owned()
            })?;
            chunks.push((index, low, high));
        }
        if resume.is_some() && chunks.is_empty() {
            // Every chunk was fully scanned already.
            return Ok(SearchOutcome {
                found: 0,
                scanned: 0,
            });
        }
    }

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.output_file)
        .map_err(|err| format!("failed to open {} for writing: {err}", config.output_file))?;

    print_banner(config, mode, start, end, "CPU");

    let modes: &[bool] = if config.coin == Coin::Eth {
        // ETH is always uncompressed, whatever the CLI default says.
        &[false]
    } else {
        match config.comp_mode {
            CompMode::Compressed => &[true],
            CompMode::Uncompressed => &[false],
            CompMode::Both => &[true, false],
        }
    };

    let shared = Shared {
        output: Mutex::new(file),
        found: AtomicU64::new(0),
        scanned: AtomicU64::new(0),
        stop_after: target.stop_after(),
        counters: (0..chunk_count).map(|_| AtomicU64::new(0)).collect(),
        error: Mutex::new(None),
        epoch: AtomicU64::new(0),
        rotations: AtomicU64::new(0),
        random_key: Mutex::new("0".to_owned()),
        epoch_len: if random {
            config.rkey.saturating_mul(1_000_000_000)
        } else {
            0
        },
    };
    let done = AtomicBool::new(false);
    let started = Instant::now();
    let total = end.sub(start).add_u64(1);

    prepare_ctrl_c();

    thread::scope(|scope| {
        let mut workers = Vec::with_capacity(chunks.len().max(threads));
        let mut index = 0u64;
        if random {
            for _ in 0..threads {
                let shared = &shared;
                let target = &target;
                let spec = random_spec.as_ref();
                workers.push(scope.spawn(move || {
                    worker(None, index, spec, target, modes, config.coin, shared);
                }));
                index += 1;
            }
        } else {
            for (chunk_index, low, high) in chunks {
                let shared = &shared;
                let target = &target;
                workers.push(scope.spawn(move || {
                    worker(
                        Some((low, high)),
                        chunk_index as u64,
                        None,
                        target,
                        modes,
                        config.coin,
                        shared,
                    );
                }));
            }
        }

        let monitor = if config.display != 0 {
            let shared = &shared;
            let done = &done;
            Some(scope.spawn(move || {
                monitor(shared, started, start, total, threads, done, random, false);
            }))
        } else {
            None
        };

        let checkpoint_thread = if checkpoint_mode {
            let shared = &shared;
            let done = &done;
            let baseline = &baseline;
            let path = continue_path.as_path();
            let interval = Duration::from_secs(config.next as u64 * 55);
            Some(scope.spawn(move || {
                checkpoint_loop(path, interval, baseline, shared, done);
            }))
        } else {
            None
        };

        for handle in workers {
            let _ = handle.join();
        }
        done.store(true, AtomicOrdering::SeqCst);
        if let Some(handle) = monitor {
            let _ = handle.join();
        }
        if let Some(handle) = checkpoint_thread {
            let _ = handle.join();
        }
    });

    if config.display != 0 {
        let _guard = shared.output.lock().expect("output mutex");
        println!();
    }

    if let Some(error) = shared.error.lock().expect("error mutex").take() {
        return Err(error);
    }

    Ok(SearchOutcome {
        found: shared.found.load(AtomicOrdering::SeqCst),
        scanned: shared.scanned.load(AtomicOrdering::SeqCst),
    })
}

/// Default coordinator client id: the machine name plus the process id.
pub(crate) fn default_client_id() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "rotor".to_owned());
    format!("{host}-{}", std::process::id())
}

/// The coordinator job description every worker matches against.
struct CoordinatorContext<'a> {
    client: &'a CoordinatorClient,
    target: &'a Target,
    modes: &'a [bool],
    coin: Coin,
    shared: &'a Shared,
    mode_text: &'a str,
    coin_text: &'a str,
    /// Single-target modes pass the operand so the server can match the job.
    lease_target: Option<&'a str>,
    start_text: &'a str,
    end_text: &'a str,
    range_start: U256,
    range_end: U256,
}

/// Like [`run`], but leases disjoint key chunks from a coordinator instead of
/// splitting the range locally. Progress lives on the server, so checkpoints
/// (`-n`) are not written.
pub fn run_coordinator(config: &Config) -> Result<SearchOutcome, String> {
    let mode = config.mode.ok_or_else(|| {
        "a search mode (-m address|addresses|xpoint|xpoints) is required".to_owned()
    })?;
    let supported = matches!(
        (config.coin, mode),
        (
            Coin::Btc,
            SearchMode::Address | SearchMode::Addresses | SearchMode::XPoint | SearchMode::XPoints
        ) | (Coin::Eth, SearchMode::Address | SearchMode::Addresses)
    );
    if !supported {
        return Err(match config.coin {
            Coin::Eth => "xpoint modes are not supported for ETH".to_owned(),
            Coin::Btc => "unsupported search mode for the CPU engine".to_owned(),
        });
    }
    if matches!(mode, SearchMode::Addresses | SearchMode::XPoints) && !config.operands.is_empty() {
        return Err("Wrong search mode provided for multiple addresses or xpoints".to_owned());
    }
    if config.threads == 0 {
        return Err("no CPU threads requested".to_owned());
    }

    let range = config
        .range
        .ok_or_else(|| "--range START:END is required for search modes".to_owned())?;
    let start = Split::from_u256(&range.start);
    let end = Split::from_u256(&range.end);
    if end < start {
        return Err("--range END must be >= START".to_owned());
    }
    if Scalar::from_bytes_be(&range.end.0).is_none() {
        return Err("--range END must be below the secp256k1 curve order n".to_owned());
    }

    let target = build_target(config, mode)?;

    let url = config
        .coordinator
        .as_deref()
        .ok_or_else(|| "coordinator mode requires --coordinator URL".to_owned())?;
    let token = config
        .token
        .clone()
        .or_else(|| {
            std::env::var("ROTOR_COORD_TOKEN")
                .ok()
                .filter(|t| !t.is_empty())
        })
        .ok_or_else(|| "coordinator mode requires --token or ROTOR_COORD_TOKEN".to_owned())?;
    let client_id = config.client_id.clone().unwrap_or_else(default_client_id);
    let client = CoordinatorClient::new(url, &token, &client_id);

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.output_file)
        .map_err(|err| format!("failed to open {} for writing: {err}", config.output_file))?;

    print_banner(config, mode, start, end, "CPU");

    let modes: &[bool] = if config.coin == Coin::Eth {
        &[false]
    } else {
        match config.comp_mode {
            CompMode::Compressed => &[true],
            CompMode::Uncompressed => &[false],
            CompMode::Both => &[true, false],
        }
    };

    let threads = config.threads.max(1);
    let shared = Shared {
        output: Mutex::new(file),
        found: AtomicU64::new(0),
        scanned: AtomicU64::new(0),
        // Exit only when the job is found/done or Ctrl-C stops us: a re-leased
        // chunk must not trip the local hit counter.
        stop_after: u64::MAX,
        counters: (0..threads).map(|_| AtomicU64::new(0)).collect(),
        error: Mutex::new(None),
        epoch: AtomicU64::new(0),
        rotations: AtomicU64::new(0),
        random_key: Mutex::new("0".to_owned()),
        epoch_len: 0,
    };
    let done = AtomicBool::new(false);
    let started = Instant::now();

    let mode_text = mode_name(mode);
    let coin_text = if config.coin == Coin::Eth {
        "eth"
    } else {
        "btc"
    };
    let lease_target = match mode {
        SearchMode::Address | SearchMode::XPoint => config.operands.first().map(String::as_str),
        _ => None,
    };
    let start_text = start.to_hex();
    let end_text = end.to_hex();
    let context = CoordinatorContext {
        client: &client,
        target: &target,
        modes,
        coin: config.coin,
        shared: &shared,
        mode_text,
        coin_text,
        lease_target,
        start_text: &start_text,
        end_text: &end_text,
        range_start: range.start,
        range_end: range.end,
    };

    prepare_ctrl_c();

    thread::scope(|scope| {
        let mut workers = Vec::with_capacity(threads);
        for index in 0..threads {
            let context = &context;
            workers.push(scope.spawn(move || {
                coordinator_worker(index as u64, context);
            }));
        }

        let monitor = if config.display != 0 {
            let shared = &shared;
            let done = &done;
            Some(scope.spawn(move || {
                monitor(
                    shared,
                    started,
                    Split::from_u64(0),
                    Split::from_u64(0),
                    threads,
                    done,
                    false,
                    true,
                );
            }))
        } else {
            None
        };

        for handle in workers {
            let _ = handle.join();
        }
        done.store(true, AtomicOrdering::SeqCst);
        if let Some(handle) = monitor {
            let _ = handle.join();
        }
    });

    if config.display != 0 {
        let _guard = shared.output.lock().expect("output mutex");
        println!();
    }

    if let Some(error) = shared.error.lock().expect("error mutex").take() {
        return Err(error);
    }

    Ok(SearchOutcome {
        found: shared.found.load(AtomicOrdering::SeqCst),
        scanned: shared.scanned.load(AtomicOrdering::SeqCst),
    })
}

pub(crate) fn mode_name(mode: SearchMode) -> &'static str {
    match mode {
        SearchMode::Address => "address",
        SearchMode::Addresses => "addresses",
        SearchMode::XPoint => "xpoint",
        SearchMode::XPoints => "xpoints",
        SearchMode::Bsgs => "bsgs",
    }
}

/// One coordinator client: lease a chunk, scan it, heartbeat, re-lease.
fn coordinator_worker(thread_index: u64, context: &CoordinatorContext<'_>) {
    let client = context.client;
    let mut failures = 0u32;

    loop {
        if stop_requested() {
            break;
        }

        let lease = match client.lease(
            None,
            context.lease_target,
            context.mode_text,
            context.coin_text,
            context.start_text,
            context.end_text,
        ) {
            Ok(Some(lease)) => {
                failures = 0;
                lease
            }
            Ok(None) => match client.jobs() {
                Ok(jobs) => match jobs.iter().find(|job| job_matches(job, context)) {
                    Some(job) if job.found || job.done => break,
                    Some(_) => {
                        // The job exists but every chunk is leased or done.
                        thread::sleep(Duration::from_secs(2));
                        continue;
                    }
                    None => {
                        set_error(
                            context.shared,
                            "no matching coordinator job; create it first",
                        );
                        break;
                    }
                },
                Err(err) => {
                    if !record_failure(context.shared, &mut failures, &err) {
                        break;
                    }
                    continue;
                }
            },
            Err(err) => {
                if !record_failure(context.shared, &mut failures, &err) {
                    break;
                }
                continue;
            }
        };

        let (Some(start), Some(end)) =
            (Scalar::from_hex(&lease.start), Scalar::from_hex(&lease.end))
        else {
            set_error(
                context.shared,
                "coordinator lease returned a range outside the curve order",
            );
            break;
        };
        if end < start {
            set_error(context.shared, "coordinator lease returned END below START");
            break;
        }

        let lease_started = Instant::now();
        let last_heartbeat = Mutex::new(Instant::now());
        let aborted = AtomicBool::new(false);
        let accepted = AtomicBool::new(false);

        let on_batch = |scanned: u64| -> bool {
            let mut last = last_heartbeat.lock().expect("heartbeat mutex");
            if last.elapsed() < Duration::from_secs(5) {
                return true;
            }
            let rate = scanned as f64 / lease_started.elapsed().as_secs_f64().max(1e-9);
            match client.heartbeat(&lease.job_id, lease.chunk_index, scanned, rate, false) {
                Ok(_) => {
                    *last = Instant::now();
                    true
                }
                Err(err) => {
                    // The lease is gone (TTL or another client); re-lease.
                    eprintln!("  Coordinator: heartbeat failed ({err}); requesting a new lease");
                    aborted.store(true, AtomicOrdering::SeqCst);
                    false
                }
            }
        };
        let on_hit = |key: &Scalar, _point: &Affine, _compressed: bool| match client
            .submit_result(&lease.job_id, &key.to_hex())
        {
            Ok(()) => accepted.store(true, AtomicOrdering::SeqCst),
            Err(err) => eprintln!("  Coordinator: cannot submit the found key: {err}"),
        };

        let scanned = scan_chunk(
            &start,
            &end,
            thread_index,
            context.target,
            context.modes,
            context.coin,
            context.shared,
            Some(&on_hit),
            Some(&on_batch),
        );

        // An accepted result closes the job and drops its leases server-side, so
        // a done-heartbeat would only report a false "lease lost".
        if !accepted.load(AtomicOrdering::SeqCst)
            && !aborted.load(AtomicOrdering::SeqCst)
            && !stop_requested()
        {
            let rate = scanned as f64 / lease_started.elapsed().as_secs_f64().max(1e-9);
            if let Err(err) =
                client.heartbeat(&lease.job_id, lease.chunk_index, scanned, rate, true)
            {
                eprintln!("  Coordinator: cannot finish the leased chunk: {err}");
            }
        }
        // The accepted result closed the job; leasing again could only fail.
        if accepted.load(AtomicOrdering::SeqCst) {
            break;
        }
    }
}

fn job_matches(job: &JobInfo, context: &CoordinatorContext<'_>) -> bool {
    job.mode == context.mode_text
        && job.coin == context.coin_text
        && U256::from_hex(&job.start).ok() == Some(context.range_start)
        && U256::from_hex(&job.end).ok() == Some(context.range_end)
        && match context.lease_target {
            Some(wanted) => target_matches(
                context.mode_text,
                context.coin_text,
                job.target.as_deref(),
                wanted,
            ),
            None => true,
        }
}

/// Compares a job target with the requested one, canonicalizing hex forms
/// (the server stores X coordinates and ETH addresses as padded lowercase hex).
fn target_matches(mode: &str, coin: &str, stored: Option<&str>, wanted: &str) -> bool {
    let Some(stored) = stored else {
        return false;
    };
    match (mode, coin) {
        ("xpoint", _) | ("address", "eth") => normalize_hex(stored) == normalize_hex(wanted),
        _ => stored.trim() == wanted.trim(),
    }
}

fn normalize_hex(text: &str) -> String {
    let text = text.trim();
    let text = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    let text = text.trim_start_matches('0');
    if text.is_empty() {
        "0".to_owned()
    } else {
        text.to_ascii_lowercase()
    }
}

fn record_failure(shared: &Shared, failures: &mut u32, err: &str) -> bool {
    *failures += 1;
    if *failures >= 5 {
        set_error(
            shared,
            &format!("coordinator request failed after 5 attempts: {err}"),
        );
        return false;
    }
    thread::sleep(Duration::from_secs(u64::from(*failures)));
    true
}

fn set_error(shared: &Shared, message: &str) {
    let mut slot = shared.error.lock().expect("error mutex");
    if slot.is_none() {
        *slot = Some(message.to_owned());
    }
}

/// Builds the search target for the requested coin/mode pair.
pub(crate) fn build_target(config: &Config, mode: SearchMode) -> Result<Target, String> {
    Ok(match (config.coin, mode) {
        (Coin::Btc, SearchMode::Address) => Target::Hash(parse_btc_address(config)?),
        (Coin::Btc, SearchMode::Addresses) => {
            Target::Hashes(load_target_set(config, 20, "addresses")?)
        }
        (Coin::Btc, SearchMode::XPoint) => Target::X(parse_xpoint(config)?),
        (Coin::Btc, SearchMode::XPoints) => Target::Xs(load_target_set(config, 32, "xpoints")?),
        (Coin::Eth, SearchMode::Address) => Target::Hash(parse_eth_address(config)?),
        (Coin::Eth, SearchMode::Addresses) => {
            Target::Hashes(load_target_set(config, 20, "addresses")?)
        }
        _ => return Err("unsupported search mode for the CPU engine".to_owned()),
    })
}

/// Search target: a single hash160/X, or a loaded `.bin` record set.
pub(crate) enum Target {
    Hash([u8; 20]),
    Hashes(TargetSet),
    X([u8; 32]),
    Xs(TargetSet),
}

impl Target {
    pub(crate) fn matches(&self, needle: &[u8]) -> bool {
        match self {
            Target::Hash(target) => target.as_slice() == needle,
            Target::X(target) => target.as_slice() == needle,
            Target::Hashes(set) | Target::Xs(set) => set.contains(needle),
        }
    }

    pub(crate) fn is_xpoint(&self) -> bool {
        matches!(self, Target::X(_) | Target::Xs(_))
    }

    /// Number of hits that ends the search: one for single targets, the loaded
    /// record count for multi modes (`Rotor.cpp:3266`).
    pub(crate) fn stop_after(&self) -> u64 {
        match self {
            Target::Hash(_) | Target::X(_) => 1,
            Target::Hashes(set) | Target::Xs(set) => set.len() as u64,
        }
    }

    /// Exact target record length in bytes (20 for hash160/ETH, 32 for X).
    #[cfg_attr(not(feature = "gpu"), allow(dead_code))]
    pub(crate) fn record_len(&self) -> usize {
        match self {
            Target::Hash(_) | Target::Hashes(_) => 20,
            Target::X(_) | Target::Xs(_) => 32,
        }
    }

    /// Bloom prefilter for the multi-target modes.
    #[cfg_attr(not(feature = "gpu"), allow(dead_code))]
    pub(crate) fn target_set(&self) -> Option<&TargetSet> {
        match self {
            Target::Hashes(set) | Target::Xs(set) => Some(set),
            _ => None,
        }
    }
}

/// Shared state between workers and the progress monitor.
struct Shared {
    /// Guards the output file and stdout so hit blocks never interleave.
    output: Mutex<File>,
    found: AtomicU64,
    scanned: AtomicU64,
    /// Number of hits that ends the search (`targetCounter` in `Rotor.cpp`).
    stop_after: u64,
    /// Per-worker scan counters, indexed like the chunk list; empty in
    /// random mode.
    counters: Vec<AtomicU64>,
    /// First write error seen by any worker; reported by [`run`].
    error: Mutex<Option<String>>,
    /// Global random-mode epoch already announced by some worker.
    epoch: AtomicU64,
    /// Number of random-start rotations (`rKeyCount` in C++).
    rotations: AtomicU64,
    /// Most recent random start key, shown in the progress line.
    random_key: Mutex<String>,
    /// `rkey * 1_000_000_000`, the scanned-key count per random epoch.
    epoch_len: u64,
}

fn parse_btc_address(config: &Config) -> Result<[u8; 20], String> {
    if config.operands.len() != 1 {
        return Err("address mode requires exactly one address operand".to_owned());
    }
    let address = &config.operands[0];
    let payload = base58::decode_check(address)?;
    if payload.len() != 21 || payload[0] != 0x00 {
        return Err(format!(
            "invalid BTC P2PKH address (expected a 21-byte 0x00 payload): {address}"
        ));
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&payload[1..]);
    Ok(hash)
}

fn parse_eth_address(config: &Config) -> Result<[u8; 20], String> {
    if config.operands.len() != 1 {
        return Err("address mode requires exactly one address operand".to_owned());
    }
    let address = &config.operands[0];
    let hex = address
        .strip_prefix("0x")
        .or_else(|| address.strip_prefix("0X"))
        .ok_or_else(|| format!("invalid ETH address (expected 0x + 40 hex chars): {address}"))?;
    let bytes = parse_hex_bytes(hex, 20)
        .ok_or_else(|| format!("invalid ETH address (expected 0x + 40 hex chars): {address}"))?;
    Ok(bytes.try_into().expect("20 bytes"))
}

fn parse_xpoint(config: &Config) -> Result<[u8; 32], String> {
    if config.operands.len() != 1 {
        return Err("xpoint mode requires exactly one 32-byte X operand".to_owned());
    }
    let xpoint = &config.operands[0];
    let bytes = parse_hex_bytes(xpoint, 32)
        .ok_or_else(|| format!("invalid xpoint (expected 64 hex chars): {xpoint}"))?;
    Ok(bytes.try_into().expect("32 bytes"))
}

/// Decodes exactly `len` bytes worth of hexadecimal digits.
pub(crate) fn parse_hex_bytes(text: &str, len: usize) -> Option<Vec<u8>> {
    if text.len() != len * 2 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("validated hex"))
            .collect(),
    )
}

fn load_target_set(config: &Config, record_len: usize, what: &str) -> Result<TargetSet, String> {
    if let Some(source) = config.targets_text.as_deref() {
        let mode = config
            .mode
            .ok_or_else(|| "--targets-text requires -m addresses or -m xpoints".to_owned())?;
        if source == "-" {
            let stdin = io::stdin();
            return targets_text::load(stdin.lock(), config.coin, mode);
        }
        let file = File::open(source).map_err(|err| format!("failed to read {source}: {err}"))?;
        return targets_text::load(io::BufReader::new(file), config.coin, mode);
    }
    let path = config
        .input_file
        .as_deref()
        .ok_or_else(|| format!("{what} mode requires -i FILE with {record_len}-byte records"))?;
    TargetSet::load(Path::new(path), record_len)
}

/// Random-start parameters derived from `-r`, `-n`, `-z` and `--range`
/// (`Rotor.cpp:636-722`).
#[derive(Debug)]
pub(crate) struct RandomSpec {
    /// Inclusive `[start, end]` range, when it spans more than one key.
    range: Option<(Split, Split)>,
    next: i32,
    zet: i32,
}

impl RandomSpec {
    pub(crate) fn from_config(config: &Config) -> Result<Self, String> {
        if config.next < 0 || config.next > 256 {
            return Err(format!(
                "ROTOR Random: -n must be between 0 and 256, got {}",
                config.next
            ));
        }
        if config.zet < 0 || config.zet > 256 {
            return Err(format!(
                "ROTOR Random: -z must be between 0 and 256, got {}",
                config.zet
            ));
        }

        let range = match config.range {
            Some(range) => {
                let start = Split::from_u256(&range.start);
                let end = Split::from_u256(&range.end);
                if end < start {
                    return Err("--range END must be >= START".to_owned());
                }
                if Scalar::from_bytes_be(&range.end.0).is_none() {
                    return Err("--range END must be below the secp256k1 curve order n".to_owned());
                }
                if end > start {
                    Some((start, end))
                } else {
                    None
                }
            }
            None => None,
        };

        // `Rotor.cpp:694-699`: the -z end must be above the -n start. Only the
        // bit-range branch is validated; an explicit range takes precedence.
        if range.is_none() && config.next > 0 && config.zet > 1 && config.zet <= config.next {
            return Err("ROTOR Random: -n start must be less than -z end".to_owned());
        }

        Ok(Self {
            range,
            next: config.next,
            zet: config.zet,
        })
    }
}

/// Picks a random start key according to the C++ random branches.
pub(crate) fn random_start_key(spec: &RandomSpec, rng: &mut SplitMix64) -> Scalar {
    if let Some((start, end)) = spec.range {
        // Uniform in [start, end]: mask the draw to the span's bit length and
        // reject values above the span (no modulo bias).
        let span = end.sub(start).add_u64(1);
        let bits = span.bit_length();
        loop {
            let mut bytes = rng.fill32();
            mask_bits(&mut bytes, bits);
            let candidate = Split::from_u256(&U256(bytes));
            if candidate < span {
                return start
                    .add(candidate)
                    .0
                    .to_scalar()
                    .expect("random range endpoints are below the curve order");
            }
        }
    }

    if spec.next > 0 {
        let width = if spec.zet > 1 {
            let band = (spec.zet - spec.next).max(1) as u64;
            spec.next as u64 + rng.next_u64() % band + rng.next_u64() % 2
        } else {
            spec.next as u64
        };
        loop {
            let mut bytes = rng.fill32();
            mask_bits(&mut bytes, width as u32);
            // `width` can be 256, where the draw may exceed the curve order.
            if let Some(key) = Scalar::from_bytes_be(&bytes) {
                return key;
            }
        }
    }

    loop {
        if let Some(key) = Scalar::from_bytes_be(&rng.fill32()) {
            return key;
        }
    }
}

/// Keeps only the low `width` bits of a big-endian 256-bit value.
fn mask_bits(bytes: &mut [u8; 32], width: u32) {
    if width >= 256 {
        return;
    }
    let full_bytes = (width / 8) as usize;
    let partial_bits = width % 8;
    let zero_len = 32 - full_bytes - usize::from(partial_bits > 0);
    bytes[..zero_len].fill(0);
    if partial_bits > 0 {
        bytes[zero_len] &= (1u8 << partial_bits) - 1;
    }
}

/// SplitMix64, seeded from the clock and the worker index (no dependencies).
pub(crate) struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub(crate) fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn fill32(&mut self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.as_chunks_mut::<8>().0 {
            chunk.copy_from_slice(&self.next_u64().to_le_bytes());
        }
        out
    }
}

fn thread_rng(thread_index: u64) -> SplitMix64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    SplitMix64::new(nanos ^ thread_index.wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

/// Scans one inclusive chunk (sequential mode) or an endless random walk
/// (random mode), one batch of [`BATCH_SIZE`] keys at a time. Successive points
/// are chained with `add_affine(G)` and normalized by a single batch inversion,
/// as in the C++ CPU group loop.
fn worker(
    chunk: Option<(Scalar, Scalar)>,
    thread_index: u64,
    random_spec: Option<&RandomSpec>,
    target: &Target,
    modes: &[bool],
    coin: Coin,
    shared: &Shared,
) {
    let batch_scalar = Scalar::from_u64(BATCH_SIZE as u64);

    let mut rng = thread_rng(thread_index);
    let mut epoch = 0u64;
    let mut key = match random_spec {
        Some(spec) => random_start_key(spec, &mut rng),
        None => chunk.expect("sequential workers always have a chunk").0,
    };
    let mut point = starting_point(&key);
    if random_spec.is_some() {
        record_random_key(shared, &key);
    }

    loop {
        if STOP.load(AtomicOrdering::SeqCst) {
            break;
        }

        if let Some(spec) = random_spec {
            // A new global epoch asks every worker for a fresh random start.
            let current = shared.scanned.load(AtomicOrdering::SeqCst) / shared.epoch_len;
            if current > epoch {
                epoch = current;
                note_rotation(shared, current);
                key = random_start_key(spec, &mut rng);
                point = starting_point(&key);
                record_random_key(shared, &key);
            }
        }

        let remaining = match chunk {
            Some((_, chunk_end)) => {
                let difference = chunk_end.sub(&key);
                if difference < batch_scalar {
                    Some(scalar_low_u64(&difference) + 1)
                } else {
                    None
                }
            }
            None => None,
        };
        let count = remaining.unwrap_or(BATCH_SIZE as u64) as usize;

        let next_point = scan_batch(&key, &point, count, target, modes, coin, shared, None);

        shared
            .scanned
            .fetch_add(count as u64, AtomicOrdering::SeqCst);
        if let Some(counter) = shared.counters.get(thread_index as usize) {
            counter.fetch_add(count as u64, AtomicOrdering::SeqCst);
        }

        // `Rotor.cpp:3266`: stop every worker once enough targets were found.
        if shared.found.load(AtomicOrdering::SeqCst) >= shared.stop_after {
            break;
        }

        if remaining.is_some() {
            break;
        }
        key = key.add_u64(count as u64);
        point = next_point;
    }
}

/// Called for every emitted hit: key, point and compression mode.
type HitCallback<'a> = &'a (dyn Fn(&Scalar, &Affine, bool) + Sync);
/// Called after every batch with the keys scanned so far; `false` abandons the
/// chunk (used when a coordinator lease is lost).
type BatchCallback<'a> = &'a (dyn Fn(u64) -> bool + Sync);

/// Scans one batch of `count` successive keys starting at `key`/`point`.
///
/// Generates the points, normalizes them with one batch inversion, checks every
/// configured target mode, appends hits to the output file and calls `on_hit`
/// for each emitted hit (used by the coordinator to POST results). Returns the
/// point that follows the last scanned key so callers can chain batches.
#[allow(clippy::too_many_arguments)]
fn scan_batch(
    key: &Scalar,
    point: &Jacobian,
    count: usize,
    target: &Target,
    modes: &[bool],
    coin: Coin,
    shared: &Shared,
    on_hit: Option<HitCallback<'_>>,
) -> Jacobian {
    let generator = secp::g();
    let mut points = Vec::with_capacity(count);
    let mut next_point = *point;
    for _ in 0..count {
        points.push(next_point);
        next_point = next_point.add_affine(&generator);
    }

    for (offset, maybe_point) in batch_to_affine(&points).iter().enumerate() {
        let Some(affine) = maybe_point else {
            // Key 0 has no affine form; the C++ search never yields it.
            continue;
        };
        let point_key = key.add_u64(offset as u64);

        if target.is_xpoint() {
            // `GetXBytes` compares the 32-byte big-endian X for both
            // compression modes; emit one block per configured mode.
            let x = affine.x.to_bytes_be();
            if !target.matches(&x) {
                continue;
            }
            for &compressed in modes {
                shared.found.fetch_add(1, AtomicOrdering::SeqCst);
                emit(shared, &point_key, affine, compressed, coin);
                if let Some(on_hit) = on_hit {
                    on_hit(&point_key, affine, compressed);
                }
            }
            continue;
        }

        for &compressed in modes {
            let needle = if coin == Coin::Eth {
                secp::eth_address(affine)
            } else {
                secp::hash160(affine, compressed)
            };
            if !target.matches(&needle) {
                continue;
            }
            shared.found.fetch_add(1, AtomicOrdering::SeqCst);
            emit(shared, &point_key, affine, compressed, coin);
            if let Some(on_hit) = on_hit {
                on_hit(&point_key, affine, compressed);
            }
        }
    }

    next_point
}

/// Scans the inclusive `[start, end]` chunk in batches, sharing the hit output
/// with the other workers. `on_batch` runs after every batch (with the number
/// of keys scanned so far in this chunk) and may return `false` to abandon the
/// chunk, e.g. when the coordinator lease is lost.
///
/// Returns the number of keys actually scanned here.
#[allow(clippy::too_many_arguments)]
fn scan_chunk(
    start: &Scalar,
    end: &Scalar,
    thread_index: u64,
    target: &Target,
    modes: &[bool],
    coin: Coin,
    shared: &Shared,
    on_hit: Option<HitCallback<'_>>,
    on_batch: Option<BatchCallback<'_>>,
) -> u64 {
    let batch_scalar = Scalar::from_u64(BATCH_SIZE as u64);
    let mut key = *start;
    let mut point = starting_point(&key);
    let mut scanned = 0u64;

    loop {
        if STOP.load(AtomicOrdering::SeqCst) {
            break;
        }

        let difference = end.sub(&key);
        let remaining = if difference < batch_scalar {
            Some(scalar_low_u64(&difference) + 1)
        } else {
            None
        };
        let count = remaining.unwrap_or(BATCH_SIZE as u64) as usize;

        let next_point = scan_batch(&key, &point, count, target, modes, coin, shared, on_hit);

        shared
            .scanned
            .fetch_add(count as u64, AtomicOrdering::SeqCst);
        if let Some(counter) = shared.counters.get(thread_index as usize) {
            counter.fetch_add(count as u64, AtomicOrdering::SeqCst);
        }
        scanned += count as u64;

        if let Some(on_batch) = on_batch
            && !on_batch(scanned)
        {
            break;
        }

        // `Rotor.cpp:3266`: stop every worker once enough targets were found.
        if shared.found.load(AtomicOrdering::SeqCst) >= shared.stop_after {
            break;
        }

        if remaining.is_some() {
            break;
        }
        key = key.add_u64(count as u64);
        point = next_point;
    }

    scanned
}

fn starting_point(key: &Scalar) -> Jacobian {
    if key.is_zero() {
        Jacobian::infinity()
    } else {
        Jacobian::from_affine(&secp::mul_g(key))
    }
}

/// Announces a new random epoch once, no matter how many workers observe it.
fn note_rotation(shared: &Shared, epoch: u64) {
    let mut current = shared.epoch.load(AtomicOrdering::SeqCst);
    while epoch > current {
        match shared.epoch.compare_exchange(
            current,
            epoch,
            AtomicOrdering::SeqCst,
            AtomicOrdering::SeqCst,
        ) {
            Ok(_) => {
                shared.rotations.fetch_add(1, AtomicOrdering::SeqCst);
                return;
            }
            Err(actual) => current = actual,
        }
    }
}

fn record_random_key(shared: &Shared, key: &Scalar) {
    *shared.random_key.lock().expect("random key mutex") = scalar_hex_trimmed(key);
}

/// Appends the C++ hit block to `config.output_file` and duplicates it on
/// stdout with a two-space indent (`Rotor.cpp:344-369`).
fn emit(shared: &Shared, key: &Scalar, point: &Affine, compressed: bool, coin: Coin) {
    let mut file = shared.output.lock().expect("output mutex");
    if let Err(err) = emit_hit(&mut file, key, point, compressed, coin) {
        let mut slot = shared.error.lock().expect("error mutex");
        if slot.is_none() {
            *slot = Some(format!("failed to write the output file: {err}"));
        }
    }
}

/// Writes one hit block to `file` and prints it. Shared by the CPU and GPU
/// search paths so both produce identical Found.txt contents.
pub(crate) fn emit_hit(
    file: &mut File,
    key: &Scalar,
    point: &Affine,
    compressed: bool,
    coin: Coin,
) -> io::Result<()> {
    let private_hex = scalar_hex_trimmed(key);
    let (address, wif, public_hex) = match coin {
        Coin::Btc => (
            base58::address_from_hash160(&secp::hash160(point, compressed), compressed),
            Some(base58::wif_encode(key, compressed)),
            if compressed {
                hex_upper(&secp::compress(point))
            } else {
                hex_upper(&secp::uncompress(point))
            },
        ),
        Coin::Eth => {
            let public = secp::uncompress(point);
            (
                format!("0x{}", hex_lower(&secp::eth_address(point))),
                None,
                hex_upper(&public[1..]),
            )
        }
    };

    write_block(file, &address, wif.as_deref(), &private_hex, &public_hex)?;

    print!("\n  {}\n", "=".repeat(96));
    println!("  PubAddress: {address}");
    if let Some(wif) = &wif {
        println!("  Priv (WIF): {wif}");
    }
    println!("  Priv (HEX): {private_hex}");
    println!("  PubK (HEX): {public_hex}");
    println!();
    let _ = io::stdout().flush();
    Ok(())
}

fn write_block(
    file: &mut File,
    address: &str,
    wif: Option<&str>,
    private_hex: &str,
    public_hex: &str,
) -> io::Result<()> {
    writeln!(file, "PubAddress: {address}")?;
    if let Some(wif) = wif {
        writeln!(file, "Priv (WIF): {wif}")?;
    }
    writeln!(file, "Priv (HEX): {private_hex}")?;
    writeln!(file, "PubK (HEX): {public_hex}")?;
    writeln!(file, "{}", "=".repeat(86))?;
    file.flush()
}

/// Prints the progress line once per second while workers are alive.
#[allow(clippy::too_many_arguments)]
fn monitor(
    shared: &Shared,
    started: Instant,
    start_key: Split,
    total: Split,
    threads: usize,
    done: &AtomicBool,
    random: bool,
    coordinator: bool,
) {
    let total = total.to_f64();
    let mut last = Instant::now();
    loop {
        if done.load(AtomicOrdering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
        if done.load(AtomicOrdering::SeqCst) {
            break;
        }
        if last.elapsed() < Duration::from_secs(1) {
            continue;
        }
        last = Instant::now();

        let scanned = shared.scanned.load(AtomicOrdering::SeqCst);
        let found = shared.found.load(AtomicOrdering::SeqCst);
        let elapsed = started.elapsed().as_secs_f64();
        let rate = scanned as f64 / elapsed.max(1e-9);
        let rate_text = if rate >= 1e9 {
            format!("{:.2} Gk/s", rate / 1e9)
        } else {
            format!("{:.2} Mk/s", rate / 1e6)
        };

        if random {
            // `Rotor.cpp:1814-1839`: the C: percentage field is replaced by the
            // rotation count and the current random start key.
            let rotations = shared.rotations.load(AtomicOrdering::SeqCst);
            let key = shared.random_key.lock().expect("random key mutex").clone();
            let _guard = shared.output.lock().expect("output mutex");
            print!(
                "\r  [{}] [R: {}] [{}] [F: {}] [CPU {}: {}] [T: {}]  ",
                to_time_str(elapsed),
                rotations,
                key,
                found,
                threads,
                rate_text,
                format_thousands(scanned),
            );
        } else if coordinator {
            // Leased chunks are not contiguous from the local start, so there
            // is no meaningful percentage or key to show.
            let _guard = shared.output.lock().expect("output mutex");
            print!(
                "\r  [{}] [F: {}] [CPU {}: {}] [T: {}]  ",
                to_time_str(elapsed),
                found,
                threads,
                rate_text,
                format_thousands(scanned),
            );
        } else {
            let percent = if total > 0.0 {
                scanned as f64 / total * 100.0
            } else {
                0.0
            };
            let key = start_key.add_u64(scanned).to_hex();
            let _guard = shared.output.lock().expect("output mutex");
            print!(
                "\r  [{}] [{}] [F: {}] [C: {:.6} %] [CPU {}: {}] [T: {}]  ",
                to_time_str(elapsed),
                key,
                found,
                percent,
                threads,
                rate_text,
                format_thousands(scanned),
            );
        }
        let _ = io::stdout().flush();
    }
}

/// Writes `Rotor-Cuda_Continue.bat` every `interval` while the search runs.
///
/// The checkpoint thread only reads the scan counter and never takes the
/// output mutex. The first write error is reported; later ones are dropped so
/// a full disk does not flood stderr.
fn checkpoint_loop(
    path: &Path,
    interval: Duration,
    baseline: &[u64],
    shared: &Shared,
    done: &AtomicBool,
) {
    let mut last_write = Instant::now();
    let mut reported_error = false;
    while !done.load(AtomicOrdering::SeqCst) {
        thread::sleep(Duration::from_millis(100));
        if done.load(AtomicOrdering::SeqCst) {
            break;
        }
        if last_write.elapsed() < interval {
            continue;
        }
        last_write = Instant::now();
        let chunks: Vec<u64> = baseline
            .iter()
            .zip(&shared.counters)
            .map(|(saved, counter)| saved.saturating_add(counter.load(AtomicOrdering::SeqCst)))
            .collect();
        let count = chunks.iter().copied().fold(0u64, u64::saturating_add);
        if let Err(err) = checkpoint::write_continue_with_chunks(
            path,
            &checkpoint::command_line(),
            count,
            &chunks,
        ) && !reported_error
        {
            eprintln!("  Cannot write checkpoint: {err}");
            reported_error = true;
        }
    }
}

/// Per-worker resume offsets: the exact `chunks:` extension when it matches the
/// current chunk layout, otherwise the C++ fallback `count / threads`.
fn resume_offsets(resume: Option<&checkpoint::Checkpoint>, chunk_count: usize) -> Vec<u64> {
    let Some(saved) = resume else {
        return vec![0; chunk_count];
    };
    match saved.chunks.as_ref() {
        Some(values) if saved.threads == Some(chunk_count) && values.len() == chunk_count => {
            values.clone()
        }
        _ => vec![saved.count / chunk_count.max(1) as u64; chunk_count],
    }
}

/// Slides one chunk window forward by `offset` and clips it at the range end;
/// `None` means the whole window was scanned already.
fn shift_chunk(low: Split, high: Split, offset: u64, end: Split) -> Option<(Split, Split)> {
    let (low, low_carry) = low.add(Split::from_u64(offset));
    let (high, high_carry) = high.add(Split::from_u64(offset));
    let high = if high_carry || high > end { end } else { high };
    if low_carry || low > high {
        return None;
    }
    Some((low, high))
}

/// Startup banner: field names and layout from `Main.cpp:638-705` and the
/// `Global start/end/range` block from `Rotor.cpp:280-282`.
pub(crate) fn print_banner(
    config: &Config,
    mode: SearchMode,
    start: Split,
    end: Split,
    device: &str,
) {
    // `-d 0` disables all informers; the benchmark relies on this to keep
    // stdout clean for `--benchmark-json`.
    if config.display == 0 {
        return;
    }
    let comp = match config.comp_mode {
        CompMode::Compressed => "COMPRESSED",
        CompMode::Uncompressed => "UNCOMPRESSED",
        CompMode::Both => "COMPRESSED & UNCOMPRESSED",
    };
    let search = match mode {
        SearchMode::Address => "Single Address",
        SearchMode::Addresses => "Multi Address",
        SearchMode::XPoint => "Single X Point",
        SearchMode::XPoints => "Multi X Points",
        SearchMode::Bsgs => "BSGS",
    };
    let range = end.sub(start);

    println!();
    println!("  {}", cli::VERSION_LINE);
    println!();
    if config.coin == Coin::Btc {
        println!("  COMP MODE    : {comp}");
    }
    println!(
        "  COIN TYPE    : {}",
        if config.coin == Coin::Btc {
            "BITCOIN"
        } else {
            "ETHEREUM"
        }
    );
    println!("  SEARCH MODE  : {search}");
    println!("  DEVICE       : {device}");
    let target_source = config
        .targets_text
        .as_deref()
        .or(config.input_file.as_deref())
        .unwrap_or("");
    match (config.coin, mode) {
        (Coin::Btc, SearchMode::Address) => {
            println!("  BTC ADDRESS  : {}", config.operands[0]);
        }
        (Coin::Btc, SearchMode::Addresses) => println!("  BTC HASH160s : {target_source}"),
        (Coin::Btc, SearchMode::XPoint) => {
            println!("  BTC XPOINT   : {}", config.operands[0]);
        }
        (Coin::Btc, SearchMode::XPoints) => println!("  BTC XPOINTS  : {target_source}"),
        (Coin::Eth, SearchMode::Address) => {
            println!("  ETH ADDRESS  : {}", config.operands[0]);
        }
        (Coin::Eth, SearchMode::Addresses) => println!("  ETH ADDRESS  : {target_source}"),
        _ => {}
    }
    println!("  OUTPUT FILE  : {}", config.output_file);
    println!("  Start Time   : {}", start_time_string());
    println!(
        "  Global start : {} ({} bit)",
        start.to_hex(),
        start.bit_length()
    );
    println!(
        "  Global end   : {} ({} bit)",
        end.to_hex(),
        end.bit_length()
    );
    println!(
        "  Global range : {} ({} bit)",
        range.to_hex(),
        range.bit_length()
    );
    println!();
}

/// Little-endian 4x64-bit limbs of a 256-bit range endpoint.
///
/// Kept private to the engine: range arithmetic for the split must not depend
/// on the scalar field (chunk boundaries may equal or approach `2^256`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Split([u64; 4]);

impl Split {
    pub(crate) fn from_u256(value: &U256) -> Self {
        let mut limbs = [0u64; 4];
        for (index, limb) in limbs.iter_mut().enumerate() {
            let start = (3 - index) * 8;
            *limb = u64::from_be_bytes(value.0[start..start + 8].try_into().expect("eight bytes"));
        }
        Self(limbs)
    }

    pub(crate) fn to_scalar(self) -> Option<Scalar> {
        let mut bytes = [0u8; 32];
        for (index, limb) in self.0.iter().enumerate() {
            let start = (3 - index) * 8;
            bytes[start..start + 8].copy_from_slice(&limb.to_be_bytes());
        }
        Scalar::from_bytes_be(&bytes)
    }

    pub(crate) fn add(self, other: Self) -> (Self, bool) {
        let mut out = [0u64; 4];
        let mut carry = false;
        for index in 0..4 {
            let (partial, first) = self.0[index].overflowing_add(other.0[index]);
            let (sum, second) = partial.overflowing_add(u64::from(carry));
            out[index] = sum;
            carry = first || second;
        }
        (Self(out), carry)
    }

    pub(crate) fn from_u64(value: u64) -> Self {
        Self([value, 0, 0, 0])
    }

    pub(crate) fn add_u64(self, value: u64) -> Self {
        self.add(Self::from_u64(value)).0
    }

    /// Low 64 bits; only for spans known to fit (GPU batch windows).
    #[cfg_attr(not(feature = "gpu"), allow(dead_code))]
    pub(crate) fn low_u64(self) -> u64 {
        self.0[0]
    }

    pub(crate) fn sub(self, other: Self) -> Self {
        let mut out = [0u64; 4];
        let mut borrow = false;
        for index in 0..4 {
            let (partial, first) = self.0[index].overflowing_sub(other.0[index]);
            let (difference, second) = partial.overflowing_sub(u64::from(borrow));
            out[index] = difference;
            borrow = first || second;
        }
        Self(out)
    }

    pub(crate) fn sub_u64(self, value: u64) -> Self {
        self.sub(Self([value, 0, 0, 0]))
    }

    /// Low 256 bits of the product; exact for every value the split produces.
    fn mul_u64(self, value: u64) -> Self {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for index in 0..4 {
            let product = u128::from(self.0[index]) * u128::from(value) + carry;
            out[index] = product as u64;
            carry = product >> 64;
        }
        Self(out)
    }

    fn div_u64(self, value: u64) -> (Self, u64) {
        debug_assert!(value != 0);
        let divisor = u128::from(value);
        let mut quotient = [0u64; 4];
        let mut remainder = 0u128;
        for index in (0..4).rev() {
            let current = (remainder << 64) | u128::from(self.0[index]);
            quotient[index] = (current / divisor) as u64;
            remainder = current % divisor;
        }
        (Self(quotient), remainder as u64)
    }

    pub(crate) fn bit_length(self) -> u32 {
        for index in (0..4).rev() {
            if self.0[index] != 0 {
                return index as u32 * 64 + (64 - self.0[index].leading_zeros());
            }
        }
        0
    }

    /// Uppercase hexadecimal without leading zeros (`Int::GetBase16`).
    pub(crate) fn to_hex(self) -> String {
        match self.0.iter().rposition(|&limb| limb != 0) {
            None => "0".to_owned(),
            Some(top) => {
                let mut out = String::with_capacity(64);
                let _ = write!(out, "{:X}", self.0[top]);
                for limb in self.0[..top].iter().rev() {
                    let _ = write!(out, "{limb:016X}");
                }
                out
            }
        }
    }

    fn to_f64(self) -> f64 {
        let mut value = 0.0;
        for limb in self.0.iter().rev() {
            value = value * 18_446_744_073_709_551_616.0 + *limb as f64;
        }
        value
    }
}

impl Ord for Split {
    fn cmp(&self, other: &Self) -> Ordering {
        for index in (0..4).rev() {
            if self.0[index] != other.0[index] {
                return self.0[index].cmp(&other.0[index]);
            }
        }
        Ordering::Equal
    }
}

impl PartialOrd for Split {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Splits the inclusive `[start, end]` range into at most `threads`
/// contiguous, non-overlapping chunks of `ceil(total / threads)` keys.
pub(crate) fn split_range(start: Split, end: Split, threads: usize) -> Vec<(Split, Split)> {
    let total = end.sub(start).add_u64(1);
    let divisor = threads.max(1) as u64;
    let (quotient, remainder) = total.div_u64(divisor);
    let chunk = quotient.add_u64(u64::from(remainder != 0));

    let mut chunks = Vec::new();
    let mut current = start;
    for index in 1..=divisor {
        if current > end {
            break;
        }
        let (next_start, carry) = start.add(chunk.mul_u64(index));
        let chunk_end = if carry || next_start > end {
            end
        } else {
            next_start.sub_u64(1)
        };
        chunks.push((current, chunk_end));
        if carry {
            break;
        }
        current = next_start;
    }
    chunks
}

fn scalar_low_u64(value: &Scalar) -> u64 {
    let bytes = value.to_bytes_be();
    u64::from_be_bytes(bytes[24..32].try_into().expect("eight bytes"))
}

/// Uppercase hexadecimal without leading zeros (`Int::GetBase16`).
fn scalar_hex_trimmed(key: &Scalar) -> String {
    let bytes = key.to_bytes_be();
    match bytes.iter().position(|&byte| byte != 0) {
        None => "0".to_owned(),
        Some(first) => {
            let mut out = String::with_capacity(64);
            let _ = write!(out, "{:X}", bytes[first]);
            for byte in &bytes[first + 1..] {
                let _ = write!(out, "{byte:02X}");
            }
            out
        }
    }
}

fn hex_upper(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02X}");
    }
    out
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `HH:MM:SS` elapsed time, as `toTimeStr` in the C++ code.
pub(crate) fn to_time_str(seconds: f64) -> String {
    let total = seconds as u64;
    format!(
        "{:02}:{:02}:{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

/// Comma thousands separators, as `formatThousands` in the C++ code.
pub(crate) fn format_thousands(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// UTC start time in the `ctime` layout used by `Rotor.cpp:211`.
fn start_time_string() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let days = (seconds / 86_400) as i64;
    let rem = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let weekdays = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} {} {:02} {:02}:{:02}:{:02} {}",
        weekdays[days.rem_euclid(7) as usize],
        months[(month - 1) as usize],
        day,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        year
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod random_start_tests {
    use super::*;

    fn key_bit_length(key: &Scalar) -> u32 {
        let bytes = key.to_bytes_be();
        match bytes.iter().position(|&byte| byte != 0) {
            None => 0,
            Some(first) => (32 - first) as u32 * 8 - bytes[first].leading_zeros(),
        }
    }

    #[test]
    fn range_start_keys_stay_inside_the_range() {
        let low = 0x100u64;
        let high = 0x1FFu64;
        let spec = RandomSpec {
            range: Some((
                Split::from_u256(&U256::from_u64(low)),
                Split::from_u256(&U256::from_u64(high)),
            )),
            next: 0,
            zet: 0,
        };
        let mut rng = SplitMix64::new(0x1234_5678_9ABC_DEF0);
        let low = Scalar::from_u64(low);
        let high = Scalar::from_u64(high);
        for _ in 0..256 {
            let key = random_start_key(&spec, &mut rng);
            assert!(key >= low, "key {key:?} is below the range start");
            assert!(key <= high, "key {key:?} is above the range end");
        }
    }

    #[test]
    fn bit_range_start_keys_respect_the_width() {
        let spec = RandomSpec {
            range: None,
            next: 71,
            zet: 74,
        };
        let mut rng = SplitMix64::new(0x0BAD_F00D_DEAD_BEEF);
        for _ in 0..256 {
            let key = random_start_key(&spec, &mut rng);
            assert!(
                key_bit_length(&key) <= 74,
                "key {key:?} exceeds the 74-bit ceiling"
            );
        }
    }

    #[test]
    fn full_width_start_keys_stay_below_the_curve_order() {
        let spec = RandomSpec {
            range: None,
            next: 0,
            zet: 0,
        };
        let mut rng = SplitMix64::new(0xFEED_FACE_CAFE_BEEF);
        for _ in 0..64 {
            let key = random_start_key(&spec, &mut rng);
            assert!(
                Scalar::from_bytes_be(&key.to_bytes_be()).is_some(),
                "helper produced a non-canonical scalar"
            );
        }
    }

    #[test]
    fn random_spec_rejects_bad_bit_bounds() {
        let config = Config {
            next: 300,
            ..Config::default()
        };
        let err = RandomSpec::from_config(&config).expect_err("next above 256 must fail");
        assert!(err.contains("256"), "unexpected error: {err}");

        let config = Config {
            next: 71,
            zet: 71,
            ..Config::default()
        };
        let err = RandomSpec::from_config(&config).expect_err("zet <= next must fail");
        assert_eq!(err, "ROTOR Random: -n start must be less than -z end");
    }
}
