//! GPU address/xpoint search: Rust host orchestration over the CUDA ABI.
//!
//! Mirrors `Rotor::FindKeyGPU` / `Rotor::Search` (`Rotor-Cuda/Rotor.cpp`):
//! split the range into one chunk per GPU thread, upload mid-chunk starting
//! points, then consume bloom/target candidates batch by batch. Each kernel
//! batch advances every thread by `STEP_SIZE` keys. A candidate is only
//! reported after the exact target lookup and a recomputed public key/address
//! match, so a bloom false positive can never produce a wrong key.
//!
//! Device execution is single-GPU and sequential: `-r` (random) and `-n`
//! (checkpoints) are rejected loudly instead of silently doing something else.
//!
//! With `--coordinator` the same engine leases disjoint chunks from a
//! `rotor-coord` server and scans each lease with [`scan_window`]; the device
//! and its generator table are created once and reused across leases.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::time::Instant;

use crate::cli::{Coin, CompMode, Config, SearchMode, U256};
use crate::coordinator::chunk_loop::{self, ChunkScanner, LeaseJob, ScanOutcome};
use crate::coordinator::client::CoordinatorClient;
use crate::engine::{self, SearchOutcome, Split};
use crate::gpu::{self, AddrEngine};
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
    if config.gpu_ids.len() != 1 {
        return Err("GPU address search supports one GPU; multi-GPU is deferred".to_owned());
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

    let target = engine::build_target(config, mode)?;
    let modes: &[bool] = if config.coin == Coin::Eth {
        &[false]
    } else {
        match config.comp_mode {
            CompMode::Compressed => &[true],
            CompMode::Uncompressed => &[false],
            CompMode::Both => &[true, false],
        }
    };

    let (thread_groups, threads_per_group) = match config.grid_size.as_slice() {
        [] => (-1, 128),
        [groups, per_group] => (*groups, *per_group),
        _ => return Err("Invalid --gpux argument, must specify exactly 2 integers".to_owned()),
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
    let bloom = target.target_set().map(|set| {
        (
            set.bloom().bytes(),
            set.bloom().bits(),
            set.bloom().hashes(),
        )
    });
    let single = gpu_plan::single_target_words(&target);

    let mut engine = AddrEngine::create(
        config.gpu_ids[0],
        thread_groups,
        threads_per_group,
        MAX_FOUND,
        gpu_plan::gpu_mode(mode),
        gpu_plan::gpu_comp_mode(mode, config.coin, config.comp_mode),
        if config.coin == Coin::Eth {
            gpu_plan::COIN_ETH
        } else {
            gpu_plan::COIN_BTC
        },
        bloom,
        single.as_deref(),
        &gen_x,
        &gen_y,
        &two_gn,
    )?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.output_file)
        .map_err(|err| format!("failed to open {} for writing: {err}", config.output_file))?;

    engine::print_banner(config, mode, start, end, "GPU");
    if config.display != 0 {
        println!("  GPU Mode     : {}", engine.name());
        println!();
    }

    engine::prepare_ctrl_c();

    if config.coordinator.is_some() {
        return run_coordinator(
            config,
            mode,
            start,
            end,
            &target,
            modes,
            &mut engine,
            &mut file,
        );
    }

    let mut plan = KeyPlan::build(start, end, engine.nb_thread() as usize)?;
    engine.set_keys(&plan.points)?;

    let mut found = 0u64;
    let outcome = scan_window(
        &mut engine,
        &mut plan,
        &mut file,
        &target,
        modes,
        config.coin,
        end,
        config.display,
        target.stop_after(),
        &mut found,
    )?;

    if config.display != 0 {
        println!();
    }
    Ok(SearchOutcome {
        found,
        scanned: outcome.scanned,
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
    file: &mut File,
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
    let client_id = config
        .client_id
        .clone()
        .unwrap_or_else(engine::default_client_id);
    let client = CoordinatorClient::new(url, &token, &client_id);

    let job = LeaseJob {
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
    };

    let mut scanner = GpuScanner {
        engine,
        file,
        target,
        modes,
        coin: config.coin,
        display: config.display,
    };
    let (scanned, found) = chunk_loop::run_leases(&client, &job, &mut scanner)?;

    if config.display != 0 {
        println!();
    }
    Ok(SearchOutcome {
        found: u64::from(found.is_some()),
        scanned,
    })
}

/// Adapts one reusable [`AddrEngine`] to the generic coordinator chunk loop.
struct GpuScanner<'a> {
    engine: &'a mut AddrEngine,
    file: &'a mut File,
    target: &'a engine::Target,
    modes: &'a [bool],
    coin: Coin,
    display: i32,
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
        let mut found = 0u64;
        scan_window(
            self.engine,
            &mut plan,
            self.file,
            self.target,
            self.modes,
            self.coin,
            end,
            self.display,
            1,
            &mut found,
        )
    }
}

/// Scans the inclusive `[start, end]` window one kernel batch at a time.
///
/// `end` is the window end (`plan` already holds the window's chunk layout);
/// `found` is the total number of hit blocks emitted so far, extended by this
/// window and used for the `stop_after` check. Hits are verified, written to
/// `Found.txt` and printed exactly as in the sequential path; the first found
/// key is returned for the coordinator.
#[allow(clippy::too_many_arguments)]
fn scan_window(
    engine: &mut AddrEngine,
    plan: &mut KeyPlan,
    file: &mut File,
    target: &engine::Target,
    modes: &[bool],
    coin: Coin,
    end: Split,
    display: i32,
    stop_after: u64,
    found: &mut u64,
) -> Result<ScanOutcome, String> {
    let step = u64::from(gpu_plan::STEP_SIZE);
    let mut scanned = 0u64;
    let mut found_key = None;
    let started = Instant::now();
    let mut last_report = Instant::now();

    loop {
        if engine::stop_requested() {
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
                    emit(file, &scalar, &point, compressed, coin)?;
                    *found += 1;
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
                emit(file, &scalar, &point, compressed, coin)?;
                *found += 1;
            }

            if found_key.is_none() {
                found_key = Some(scalar);
            }
        }

        plan.advance(step);
        scanned = scanned.saturating_add(batch_covered);

        if *found >= stop_after || plan.exhausted(end) {
            break;
        }

        if display != 0 && last_report.elapsed().as_secs_f64() >= 1.0 {
            last_report = Instant::now();
            let elapsed = started.elapsed().as_secs_f64();
            let rate = scanned as f64 / elapsed.max(1e-9);
            print!(
                "\r  [{}] [F: {}] [GPU: {}] [T: {}]  ",
                engine::to_time_str(elapsed),
                *found,
                rate_text(rate),
                engine::format_thousands(scanned)
            );
            let _ = io::stdout().flush();
        }
    }

    Ok(ScanOutcome {
        scanned,
        found: found_key,
    })
}

fn emit(
    file: &mut std::fs::File,
    key: &Scalar,
    point: &crate::point::Affine,
    compressed: bool,
    coin: Coin,
) -> Result<(), String> {
    engine::emit_hit(file, key, point, compressed, coin)
        .map_err(|err| format!("failed to write the output file: {err}"))
}

fn rate_text(rate: f64) -> String {
    if rate >= 1e9 {
        format!("{:.2} Gk/s", rate / 1e9)
    } else {
        format!("{:.2} Mk/s", rate / 1e6)
    }
}
