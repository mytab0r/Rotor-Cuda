//! GPU address/xpoint search: Rust host orchestration over the CUDA ABI.
//!
//! Mirrors `Rotor::FindKeyGPU` / `Rotor::Search` (`Rotor-Cuda/Rotor.cpp`):
//! split the range into one chunk per GPU thread, upload mid-chunk starting
//! points, then consume bloom/target candidates batch by batch. Each kernel
//! batch advances every thread by `STEP_SIZE` keys. A candidate is only
//! reported after the exact target lookup and a recomputed public key/address
//! match, so a bloom false positive can never produce a wrong key.
//!
//! `--gpui 0,1,...` runs one engine per listed device, each on its own
//! contiguous slice of `[start, end]`, sharing the stop flag, the found counter
//! and one output sink so blocks never interleave. A single id keeps the
//! original sequential path. `-r` (random) and `-n` (checkpoints) are rejected
//! loudly instead of silently doing something else.
//!
//! With `--coordinator` the same engine leases disjoint chunks from a
//! `rotor-coord` server and scans each lease with [`scan_window`]; the device
//! and its generator table are created once and reused across leases. With
//! several ids, each device runs its own lease loop and client id
//! (`<base>-gpu<index>`), so chunks stay disjoint server-side.

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use crate::cli::{Coin, CompMode, Config, SearchMode, U256};
use crate::coordinator::chunk_loop::{self, ChunkScanner, LeaseJob, ScanOutcome};
use crate::coordinator::client::CoordinatorClient;
use crate::engine::{self, SearchOutcome, Split};
use crate::gpu::{self, AddrEngine};
use crate::gpu_driver::{self, DeviceJob, DeviceOutcome, DeviceRunner, OutputSink};
use crate::gpu_plan::{self, KeyPlan};
use crate::scalar::Scalar;
use crate::secp;

/// `maxFound` from `Main.cpp:250`.
const MAX_FOUND: u32 = 1024 * 64;

/// Runs the GPU search for the configured address/xpoint mode.
pub fn run(config: &Config) -> Result<SearchOutcome, String> {
    let mode = config
        .mode
        .ok_or_else(|| "a search mode is required".to_owned())?;
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
            Coin::Btc => "unsupported search mode for the GPU engine".to_owned(),
        });
    }
    if matches!(mode, SearchMode::Addresses | SearchMode::XPoints) && !config.operands.is_empty() {
        return Err("Wrong search mode provided for multiple addresses or xpoints".to_owned());
    }
    if config.rkey > 0 {
        return Err(
            "random mode (-r) is not supported with GPU address search; drop -g or -r".to_owned(),
        );
    }
    if config.next > 0 {
        return Err(
            "checkpoint mode (-n) is not supported with GPU address search; drop -g or -n"
                .to_owned(),
        );
    }
    validate_gpu_ids(&config.gpu_ids)?;

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

    let target = Arc::new(engine::build_target(config, mode)?);
    let modes: &[bool] = if config.coin == Coin::Eth {
        &[false]
    } else {
        match config.comp_mode {
            CompMode::Compressed => &[true],
            CompMode::Uncompressed => &[false],
            CompMode::Both => &[true, false],
        }
    };

    if gpu::step_size() != gpu_plan::STEP_SIZE || gpu::group_size() != gpu_plan::GROUP_SIZE {
        return Err(format!(
            "CUDA engine constants disagree with the Rust planner: step {} vs {}, group {} vs {}",
            gpu::step_size(),
            gpu_plan::STEP_SIZE,
            gpu::group_size(),
            gpu_plan::GROUP_SIZE
        ));
    }

    let (gen_x, gen_y, two_gn) = gpu_plan::generator_table();
    let gen_x: Arc<[u64]> = gen_x.into();
    let gen_y: Arc<[u64]> = gen_y.into();

    // Single-GPU runs keep the original path (engine created before the output
    // file is opened, same banner and progress output).
    let single = config.gpu_ids.len() == 1;
    let engine = if single {
        let (thread_groups, threads_per_group) = match config.grid_size.as_slice() {
            [] => (-1, 128),
            [groups, per_group] => (*groups, *per_group),
            _ => {
                return Err("Invalid --gpux argument, must specify exactly 2 integers".to_owned());
            }
        };
        Some(create_engine(
            config.gpu_ids[0],
            (thread_groups, threads_per_group),
            mode,
            config.coin,
            config.comp_mode,
            &target,
            &gen_x,
            &gen_y,
            &two_gn,
        )?)
    } else {
        None
    };

    let sink = Arc::new(OutputSink::open(&config.output_file)?);

    engine::print_banner(config, mode, start, end, "GPU");
    if config.display != 0
        && let Some(engine) = &engine
    {
        println!("  GPU Mode     : {}", engine.name());
        println!();
    }

    engine::prepare_ctrl_c();

    if let Some(mut engine) = engine {
        if config.coordinator.is_some() {
            return run_coordinator(config, mode, start, end, &target, modes, &mut engine, &sink);
        }

        let mut plan = KeyPlan::build(start, end, engine.nb_thread() as usize)?;
        engine.set_keys(&plan.points)?;

        let stop = AtomicBool::new(false);
        let found = AtomicU64::new(0);
        let outcome = scan_window(
            &mut engine,
            &mut plan,
            &sink,
            &target,
            modes,
            config.coin,
            end,
            config.display,
            None,
            target.stop_after(),
            &stop,
            &found,
        )?;

        if config.display != 0 {
            println!();
        }
        return Ok(SearchOutcome {
            found: found.load(Ordering::SeqCst),
            scanned: outcome.scanned,
        });
    }

    let grids = device_grids(config, config.gpu_ids.len())?;
    if config.coordinator.is_some() {
        return run_coordinator_multi(
            config,
            mode,
            start,
            end,
            Arc::clone(&target),
            modes,
            Arc::clone(&sink),
            grids,
            Arc::clone(&gen_x),
            Arc::clone(&gen_y),
            two_gn,
        );
    }
    run_multi(
        config,
        mode,
        start,
        end,
        Arc::clone(&target),
        modes,
        &sink,
        grids,
        Arc::clone(&gen_x),
        Arc::clone(&gen_y),
        two_gn,
    )
}

/// Rejects impossible device lists before any engine is created.
fn validate_gpu_ids(ids: &[i32]) -> Result<(), String> {
    if ids.is_empty() {
        return Err("--gpui requires at least one GPU id".to_owned());
    }
    for (index, id) in ids.iter().enumerate() {
        if *id < 0 {
            return Err(format!(
                "Invalid --gpui argument, GPU ids must be non-negative (got {id})"
            ));
        }
        if ids[..index].contains(id) {
            return Err(format!("Invalid --gpui argument, duplicate GPU id {id}"));
        }
    }
    Ok(())
}

/// Kernel grid per device: `--gpux` holds one pair per id, or `-1,128` when
/// omitted. A lone pair is accepted only for a single device.
fn device_grids(config: &Config, devices: usize) -> Result<Vec<(i32, i32)>, String> {
    match config.grid_size.as_slice() {
        [] => Ok(vec![(-1, 128); devices]),
        [groups, per_group] if devices == 1 => Ok(vec![(*groups, *per_group)]),
        values if values.len() == devices * 2 => Ok(values
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| (pair[0], pair[1]))
            .collect()),
        _ => Err("Invalid --gpux argument, must specify exactly 2 integers per GPU id".to_owned()),
    }
}

/// Creates one address engine. Called on the thread that will launch it:
/// CUDA device selection is per-thread and [`AddrEngine`] is not `Send`.
#[allow(clippy::too_many_arguments)]
fn create_engine(
    device: i32,
    grid: (i32, i32),
    mode: SearchMode,
    coin: Coin,
    comp: CompMode,
    target: &engine::Target,
    gen_x: &[u64],
    gen_y: &[u64],
    two_gn: &[u64; 8],
) -> Result<AddrEngine, String> {
    let bloom = target.target_set().map(|set| {
        (
            set.bloom().bytes(),
            set.bloom().bits(),
            set.bloom().hashes(),
        )
    });
    let single = gpu_plan::single_target_words(target);
    AddrEngine::create(
        device,
        grid.0,
        grid.1,
        MAX_FOUND,
        gpu_plan::gpu_mode(mode),
        gpu_plan::gpu_comp_mode(mode, coin, comp),
        if coin == Coin::Eth {
            gpu_plan::COIN_ETH
        } else {
            gpu_plan::COIN_BTC
        },
        bloom,
        single.as_deref(),
        gen_x,
        gen_y,
        two_gn,
    )
}

/// Production device runner: owns its range and creates the engine when the
/// driver thread starts. Hits are published to the shared counter while the
/// slice is scanned, so reaching `stop_after` stops the other devices at their
/// next batch; the returned `found` is therefore zero.
struct EngineRunner {
    job: DeviceJob,
    grid: (i32, i32),
    mode: SearchMode,
    coin: Coin,
    comp: CompMode,
    target: Arc<engine::Target>,
    modes: Vec<bool>,
    display: i32,
    stop_after: u64,
    sink: Arc<OutputSink>,
    found: Arc<AtomicU64>,
    gen_x: Arc<[u64]>,
    gen_y: Arc<[u64]>,
    two_gn: [u64; 8],
}

impl DeviceRunner for EngineRunner {
    fn run(&mut self, stop: &AtomicBool) -> Result<DeviceOutcome, String> {
        if stop.load(Ordering::SeqCst) {
            return Ok(DeviceOutcome::default());
        }

        let mut engine = create_engine(
            self.job.device_id,
            self.grid,
            self.mode,
            self.coin,
            self.comp,
            &self.target,
            &self.gen_x,
            &self.gen_y,
            &self.two_gn,
        )?;
        if self.display != 0 {
            let name = engine.name().to_owned();
            self.sink.progress(|| {
                println!("  {name}");
                let _ = io::stdout().flush();
            })?;
        }

        let mut plan = KeyPlan::build(self.job.start, self.job.end, engine.nb_thread() as usize)?;
        engine.set_keys(&plan.points)?;

        let outcome = scan_window(
            &mut engine,
            &mut plan,
            &self.sink,
            &self.target,
            &self.modes,
            self.coin,
            self.job.end,
            self.display,
            Some(self.job.device_id),
            self.stop_after,
            stop,
            &self.found,
        )?;
        Ok(DeviceOutcome {
            scanned: outcome.scanned,
            found: 0,
        })
    }
}

/// Splits `[start, end]` across the listed devices and drives them in parallel.
#[allow(clippy::too_many_arguments)]
fn run_multi(
    config: &Config,
    mode: SearchMode,
    start: Split,
    end: Split,
    target: Arc<engine::Target>,
    modes: &[bool],
    sink: &Arc<OutputSink>,
    grids: Vec<(i32, i32)>,
    gen_x: Arc<[u64]>,
    gen_y: Arc<[u64]>,
    two_gn: [u64; 8],
) -> Result<SearchOutcome, String> {
    let chunks = engine::split_ranges(start, end, config.gpu_ids.len());
    let found = Arc::new(AtomicU64::new(0));
    let mut runners: Vec<Box<dyn DeviceRunner>> = Vec::with_capacity(chunks.len());
    for (index, (chunk_start, chunk_end)) in chunks.into_iter().enumerate() {
        runners.push(Box::new(EngineRunner {
            job: DeviceJob {
                device_id: config.gpu_ids[index],
                start: chunk_start,
                end: chunk_end,
            },
            grid: grids[index],
            mode,
            coin: config.coin,
            comp: config.comp_mode,
            target: Arc::clone(&target),
            modes: modes.to_vec(),
            display: config.display,
            stop_after: target.stop_after(),
            sink: Arc::clone(sink),
            found: Arc::clone(&found),
            gen_x: Arc::clone(&gen_x),
            gen_y: Arc::clone(&gen_y),
            two_gn,
        }));
    }

    // The runners publish hits into `found` while scanning (so the first hit
    // stops the others promptly); their `DeviceOutcome.found` is therefore 0
    // and the driver only sums scanned keys.
    let stop = AtomicBool::new(false);
    let scanned = gpu_driver::drive(runners, &stop, &found, target.stop_after())?;

    if config.display != 0 {
        println!();
    }
    Ok(SearchOutcome {
        found: found.load(Ordering::SeqCst),
        scanned,
    })
}

/// Leases chunks from `config.coordinator` and scans them on the already
/// created GPU engine, mirroring [`crate::engine::run_coordinator`].
#[allow(clippy::too_many_arguments)]
fn run_coordinator(
    config: &Config,
    mode: SearchMode,
    start: Split,
    end: Split,
    target: &engine::Target,
    modes: &[bool],
    engine: &mut AddrEngine,
    sink: &OutputSink,
) -> Result<SearchOutcome, String> {
    let client_id = config
        .client_id
        .clone()
        .unwrap_or_else(engine::default_client_id);
    let outcome = run_coordinator_device(
        config, mode, start, end, target, modes, engine, sink, &client_id, None,
    )?;

    if config.display != 0 {
        println!();
    }
    Ok(outcome)
}

/// One device's independent lease loop. With several ids each device gets its
/// own engine and client id (`<base>-gpu<index>`), so the server keeps chunks
/// disjoint. A found key ends that device's loop; the server's job state makes
/// the other loops stop with 204.
#[allow(clippy::too_many_arguments)]
fn run_coordinator_multi(
    config: &Config,
    mode: SearchMode,
    start: Split,
    end: Split,
    target: Arc<engine::Target>,
    modes: &[bool],
    sink: Arc<OutputSink>,
    grids: Vec<(i32, i32)>,
    gen_x: Arc<[u64]>,
    gen_y: Arc<[u64]>,
    two_gn: [u64; 8],
) -> Result<SearchOutcome, String> {
    let base = config
        .client_id
        .clone()
        .unwrap_or_else(engine::default_client_id);
    let ids: Vec<i32> = config.gpu_ids.clone();
    let modes = modes.to_vec();
    let mut scanned = 0u64;
    let mut found = 0u64;
    let mut first_error: Option<String> = None;

    thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel::<Result<SearchOutcome, String>>();
        let mut handles = Vec::with_capacity(ids.len());
        for (index, device_id) in ids.iter().copied().enumerate() {
            let client_id = format!("{base}-gpu{index}");
            let grid = grids[index];
            let target = Arc::clone(&target);
            let sink = Arc::clone(&sink);
            let gen_x = Arc::clone(&gen_x);
            let gen_y = Arc::clone(&gen_y);
            let modes = modes.clone();
            let sender = sender.clone();
            handles.push(scope.spawn(move || {
                let result = (|| -> Result<SearchOutcome, String> {
                    let mut engine = create_engine(
                        device_id,
                        grid,
                        mode,
                        config.coin,
                        config.comp_mode,
                        &target,
                        &gen_x,
                        &gen_y,
                        &two_gn,
                    )?;
                    if config.display != 0 {
                        let name = engine.name().to_owned();
                        sink.progress(|| {
                            println!("  {name}");
                            let _ = io::stdout().flush();
                        })?;
                    }
                    run_coordinator_device(
                        config,
                        mode,
                        start,
                        end,
                        &target,
                        &modes,
                        &mut engine,
                        &sink,
                        &client_id,
                        Some(device_id),
                    )
                })();
                let _ = sender.send(result);
            }));
        }
        drop(sender);

        for result in receiver {
            match result {
                Ok(outcome) => {
                    scanned = scanned.saturating_add(outcome.scanned);
                    found = found.saturating_add(outcome.found);
                }
                Err(err) => {
                    engine::request_stop();
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                }
            }
        }

        for handle in handles {
            if handle.join().is_err() {
                engine::request_stop();
                if first_error.is_none() {
                    first_error = Some("GPU coordinator worker thread panicked".to_owned());
                }
            }
        }
    });

    if let Some(err) = first_error {
        return Err(err);
    }
    if config.display != 0 {
        println!();
    }
    Ok(SearchOutcome { found, scanned })
}

/// Shared single-device coordinator loop body (also used by the multi-device
/// threads, which create their engine on the owning thread).
#[allow(clippy::too_many_arguments)]
fn run_coordinator_device(
    config: &Config,
    mode: SearchMode,
    start: Split,
    end: Split,
    target: &engine::Target,
    modes: &[bool],
    engine: &mut AddrEngine,
    sink: &OutputSink,
    client_id: &str,
    device: Option<i32>,
) -> Result<SearchOutcome, String> {
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
                .filter(|token| !token.is_empty())
        })
        .ok_or_else(|| "coordinator mode requires --token or ROTOR_COORD_TOKEN".to_owned())?;
    let client = CoordinatorClient::new(url, &token, client_id);
    let job = lease_job(config, mode, start, end);

    let mut scanner = GpuScanner {
        engine,
        sink,
        target,
        modes,
        coin: config.coin,
        display: config.display,
        device,
    };
    let (scanned, found) = chunk_loop::run_leases(&client, &job, &mut scanner)?;
    Ok(SearchOutcome {
        found: u64::from(found.is_some()),
        scanned,
    })
}

/// The job fields `POST /api/v1/lease` matches on.
fn lease_job(config: &Config, mode: SearchMode, start: Split, end: Split) -> LeaseJob {
    LeaseJob {
        mode: engine::mode_name(mode).to_owned(),
        coin: if config.coin == Coin::Eth {
            "eth".to_owned()
        } else {
            "btc".to_owned()
        },
        target: match mode {
            SearchMode::Address | SearchMode::XPoint => config.operands.first().cloned(),
            _ => None,
        },
        start: start.to_hex(),
        end: end.to_hex(),
    }
}

/// Adapts one reusable [`AddrEngine`] to the generic coordinator chunk loop.
struct GpuScanner<'a> {
    engine: &'a mut AddrEngine,
    sink: &'a OutputSink,
    target: &'a engine::Target,
    modes: &'a [bool],
    coin: Coin,
    display: i32,
    /// `Some(id)` in multi-GPU mode adds the device to the progress line.
    device: Option<i32>,
}

impl ChunkScanner for GpuScanner<'_> {
    fn scan(&mut self, start: &Scalar, end: &Scalar) -> Result<ScanOutcome, String> {
        // A lease only rebuilds the key plan and uploads new starting points;
        // the device and its generator table were created once in `run`.
        let start = Split::from_u256(&U256(start.to_bytes_be()));
        let end = Split::from_u256(&U256(end.to_bytes_be()));
        let mut plan = KeyPlan::build(start, end, self.engine.nb_thread() as usize)?;
        self.engine.set_keys(&plan.points)?;

        // The coordinator submits one key and the server closes the job, so the
        // window stops at the first hit instead of hunting every target.
        let stop = AtomicBool::new(false);
        let found = AtomicU64::new(0);
        scan_window(
            self.engine,
            &mut plan,
            self.sink,
            self.target,
            self.modes,
            self.coin,
            end,
            self.display,
            self.device,
            1,
            &stop,
            &found,
        )
    }
}

/// Scans the inclusive `[start, end]` window one kernel batch at a time.
///
/// `end` is the window end (`plan` already holds the window's chunk layout);
/// `found` is the shared number of hit blocks emitted so far and `stop` the
/// shared abort flag. Hits are verified, written under the [`OutputSink`] lock
/// and printed exactly as in the sequential path; the first found key is
/// returned for the coordinator.
#[allow(clippy::too_many_arguments)]
fn scan_window(
    engine: &mut AddrEngine,
    plan: &mut KeyPlan,
    sink: &OutputSink,
    target: &engine::Target,
    modes: &[bool],
    coin: Coin,
    end: Split,
    display: i32,
    device: Option<i32>,
    stop_after: u64,
    stop: &AtomicBool,
    found: &AtomicU64,
) -> Result<ScanOutcome, String> {
    let step = u64::from(gpu_plan::STEP_SIZE);
    let mut scanned = 0u64;
    let mut found_key = None;
    let started = Instant::now();
    let mut last_report = Instant::now();

    loop {
        if engine::stop_requested() || stop.load(Ordering::SeqCst) {
            break;
        }

        let batch_covered = plan.batch_len(end, step);
        let hits = engine.launch()?;
        if hits.total > hits.tid.len() as u64 {
            return Err(format!(
                "GPU hit buffer overflowed: {} hits, capacity {}",
                hits.total,
                hits.tid.len()
            ));
        }
        let record_len = target.record_len();
        for index in 0..hits.tid.len() {
            let tid = hits.tid[index] as usize;
            if tid >= plan.len() {
                return Err(format!("GPU reported an unknown thread id {tid}"));
            }
            // The kernel groups can overrun a short chunk; never report a key
            // outside this thread's slice of the requested range.
            let Some(key) = plan.windows[tid].key(hits.incr[index], end, step) else {
                continue;
            };
            let hash = &hits.hash[index * 32..index * 32 + record_len];
            if !target.matches(hash) {
                continue;
            }

            let scalar = key
                .to_scalar()
                .ok_or_else(|| "GPU reported a key above the curve order".to_owned())?;
            let point = secp::mul_g(&scalar);

            if target.is_xpoint() {
                if point.x.to_bytes_be().as_slice() != hash {
                    return Err(format!(
                        "GPU xpoint hit failed verification at key {}",
                        key.to_hex()
                    ));
                }
                for &compressed in modes {
                    sink.write_block(&scalar, &point, compressed, coin)?;
                    publish_hit(found, stop, stop_after);
                }
            } else {
                // The kernel sets bit 15 for the compressed hash
                // (`GPUCompute.h`: CHECK_POINT_SEARCH_MODE_MA(..., true)).
                let compressed = coin != Coin::Eth && hits.mode[index] != 0;
                let needle = if coin == Coin::Eth {
                    secp::eth_address(&point)
                } else {
                    secp::hash160(&point, compressed)
                };
                if needle.as_slice() != hash {
                    return Err(format!(
                        "GPU address hit failed verification at key {}",
                        key.to_hex()
                    ));
                }
                sink.write_block(&scalar, &point, compressed, coin)?;
                publish_hit(found, stop, stop_after);
            }

            if found_key.is_none() {
                found_key = Some(scalar);
            }
        }

        plan.advance(step);
        scanned = scanned.saturating_add(batch_covered);

        if found.load(Ordering::SeqCst) >= stop_after || plan.exhausted(end) {
            break;
        }

        if display != 0 && last_report.elapsed().as_secs_f64() >= 1.0 {
            last_report = Instant::now();
            let elapsed = started.elapsed().as_secs_f64();
            let rate = scanned as f64 / elapsed.max(1e-9);
            let found = found.load(Ordering::SeqCst);
            sink.progress(|| {
                match device {
                    Some(device) => print!(
                        "\r  [{}] [F: {}] [GPU #{}: {}] [T: {}]  ",
                        engine::to_time_str(elapsed),
                        found,
                        device,
                        rate_text(rate),
                        engine::format_thousands(scanned)
                    ),
                    None => print!(
                        "\r  [{}] [F: {}] [GPU: {}] [T: {}]  ",
                        engine::to_time_str(elapsed),
                        found,
                        rate_text(rate),
                        engine::format_thousands(scanned)
                    ),
                }
                let _ = io::stdout().flush();
            })?;
        }
    }

    Ok(ScanOutcome {
        scanned,
        found: found_key,
    })
}

/// Counts one hit block and stops every device once `stop_after` is reached.
fn publish_hit(found: &AtomicU64, stop: &AtomicBool, stop_after: u64) {
    let total = found.fetch_add(1, Ordering::SeqCst) + 1;
    if total >= stop_after {
        stop.store(true, Ordering::SeqCst);
    }
}

fn rate_text(rate: f64) -> String {
    if rate >= 1e9 {
        format!("{:.2} Gk/s", rate / 1e9)
    } else {
        format!("{:.2} Mk/s", rate / 1e6)
    }
}
