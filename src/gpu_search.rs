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

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::time::Instant;

use crate::cli::{Coin, CompMode, Config, SearchMode};
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

    let mut plan = KeyPlan::build(start, end, engine.nb_thread() as usize)?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.output_file)
        .map_err(|err| format!("failed to open {} for writing: {err}", config.output_file))?;

    engine::print_banner(config, mode, start, end, "GPU");
    println!("  GPU Mode     : {}", engine.name());
    println!();

    engine::prepare_ctrl_c();
    engine.set_keys(&plan.points)?;

    let step = u64::from(gpu_plan::STEP_SIZE);
    let mut scanned = 0u64;
    let mut found = 0u64;
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
                    emit(&mut file, &scalar, &point, compressed, config.coin)?;
                    found += 1;
                }
            } else {
                // The kernel sets bit 15 for the compressed hash
                // (`GPUCompute.h`: CHECK_POINT_SEARCH_MODE_MA(..., true)).
                let compressed = config.coin != Coin::Eth && hits.mode[index] != 0;
                let needle = if config.coin == Coin::Eth {
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
                emit(&mut file, &scalar, &point, compressed, config.coin)?;
                found += 1;
            }
        }

        plan.advance(step);
        scanned = scanned.saturating_add(batch_covered);

        if found >= target.stop_after() || plan.exhausted(end) {
            break;
        }

        if config.display != 0 && last_report.elapsed().as_secs_f64() >= 1.0 {
            last_report = Instant::now();
            let elapsed = started.elapsed().as_secs_f64();
            let rate = scanned as f64 / elapsed.max(1e-9);
            print!(
                "\r  [{}] [F: {}] [GPU: {}] [T: {}]  ",
                engine::to_time_str(elapsed),
                found,
                rate_text(rate),
                engine::format_thousands(scanned)
            );
            let _ = io::stdout().flush();
        }
    }

    if config.display != 0 {
        println!();
    }
    Ok(SearchOutcome { found, scanned })
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
