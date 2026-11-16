//! `--benchmark`: measure the selected backend's key rate on a synthetic,
//! guaranteed-miss range so users can compare hardware.
//!
//! The synthetic target is key 1 (or the generator X for `-m xpoint`) while the
//! scanned range starts at `0x100000000`, so a hit is impossible. The search
//! itself is the normal engine/GPU path; only the stop flag is driven by a
//! timer ([`crate::engine::run_for`]).

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::cli::{Coin, Config, Range, SearchMode, U256};
use crate::engine;

/// README key-1 BTC address (compressed).
const BTC_KEY_ONE_ADDRESS: &str = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
/// Key-1 ETH address (keccak160 of the uncompressed generator point).
const ETH_KEY_ONE_ADDRESS: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
/// The generator's X coordinate: key 1 in xpoint mode.
const GENERATOR_X: &str = "79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798";

/// One benchmark result (also the `--benchmark-json` payload).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Measurement {
    pub backend: &'static str,
    pub threads: usize,
    pub seconds: f64,
    pub scanned: u64,
    pub keys_per_second: f64,
}

/// Runs the benchmark duration from `config` and prints human or JSON output.
///
/// Returns the process exit code (0 on success).
pub fn run(config: &Config) -> Result<i32, String> {
    let seconds = if config.benchmark_seconds.is_finite() {
        config.benchmark_seconds.max(0.2)
    } else {
        5.0
    };
    let measurement = measure(config, Duration::from_secs_f64(seconds))?;

    if config.benchmark_json {
        let json = serde_json::to_string(&measurement)
            .map_err(|err| format!("cannot serialize the benchmark result: {err}"))?;
        println!("{json}");
    } else {
        println!("BENCHMARK    : {}", measurement.backend);
        println!("THREADS      : {}", measurement.threads);
        println!("DURATION     : {:.2} s", measurement.seconds);
        println!(
            "SCANNED      : {}",
            engine::format_thousands(measurement.scanned)
        );
        println!("RATE         : {}", rate_text(measurement.keys_per_second));
    }
    Ok(0)
}

/// Measures the configured backend for `duration` on the synthetic miss target.
///
/// Rejects configurations the benchmark cannot measure: multi-target modes,
/// BSGS, coordinator mode, work files, random start and checkpoints.
pub fn measure(config: &Config, duration: Duration) -> Result<Measurement, String> {
    let mode = validate(config)?;
    let synthetic = synthetic_config(config, mode);
    let backend = if config.gpu { "GPU" } else { "CPU" };

    let started = Instant::now();
    let outcome = if config.gpu {
        run_gpu(&synthetic, duration)
    } else {
        engine::run_for(&synthetic, duration)
    };
    let elapsed = started.elapsed();
    // The engine creates the file; never leave it behind.
    let _ = std::fs::remove_file(&synthetic.output_file);

    let outcome = outcome?;
    let seconds = elapsed.as_secs_f64();
    Ok(Measurement {
        backend,
        threads: config.threads.max(1),
        seconds,
        scanned: outcome.scanned,
        keys_per_second: outcome.scanned as f64 / seconds.max(1e-9),
    })
}

/// Returns the single-target mode to benchmark, or a clear error.
fn validate(config: &Config) -> Result<SearchMode, String> {
    let mode = config.mode.unwrap_or(SearchMode::Address);
    match mode {
        SearchMode::Address | SearchMode::XPoint => {}
        SearchMode::Addresses | SearchMode::XPoints => {
            return Err(
                "--benchmark measures a single target; -m addresses/xpoints is not supported"
                    .to_owned(),
            );
        }
        SearchMode::Bsgs => {
            return Err("--benchmark does not support BSGS".to_owned());
        }
    }
    if config.coordinator.is_some() {
        return Err("--benchmark does not support --coordinator".to_owned());
    }
    if config.bsgs_work.is_some() || config.bsgs_work_reset {
        return Err("--benchmark does not support --bsgs-work".to_owned());
    }
    if config.rkey != 0 {
        return Err("--benchmark does not support random start (-r)".to_owned());
    }
    if config.next != 0 {
        return Err("--benchmark does not support checkpoints (-n)".to_owned());
    }
    Ok(mode)
}

/// Clones the user's backend choices but replaces the search inputs with a
/// target that cannot be inside the scanned range.
fn synthetic_config(config: &Config, mode: SearchMode) -> Config {
    let mut synthetic = config.clone();
    synthetic.mode = Some(mode);
    synthetic.operands = vec![benchmark_target(config.coin, mode).to_owned()];
    // Key 1 is far below the start, so the synthetic target never matches.
    synthetic.range = Some(Range {
        start: U256::from_hex("100000000").expect("static benchmark range is valid hex"),
        end: U256::from_hex("1FFFFFFFF").expect("static benchmark range is valid hex"),
    });
    synthetic.display = 0;
    synthetic.output_file = temp_output_path();
    synthetic.input_file = None;
    synthetic.next = 0;
    synthetic.rkey = 0;
    synthetic.coordinator = None;
    synthetic.token = None;
    synthetic.client_id = None;
    synthetic.bsgs_work = None;
    synthetic.bsgs_work_reset = false;
    synthetic.benchmark = false;
    synthetic.benchmark_json = false;
    synthetic
}

fn benchmark_target(coin: Coin, mode: SearchMode) -> &'static str {
    match (coin, mode) {
        (Coin::Eth, _) => ETH_KEY_ONE_ADDRESS,
        (Coin::Btc, SearchMode::XPoint) => GENERATOR_X,
        _ => BTC_KEY_ONE_ADDRESS,
    }
}

fn temp_output_path() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir()
        .join(format!(
            "rotor_benchmark_{}_{nanos}.tmp",
            std::process::id()
        ))
        .to_string_lossy()
        .into_owned()
}

/// Bounds the GPU path with the same stop timer the CPU path uses.
#[cfg(feature = "gpu")]
fn run_gpu(config: &Config, duration: Duration) -> Result<crate::engine::SearchOutcome, String> {
    let timer = std::thread::spawn(move || {
        std::thread::sleep(duration);
        engine::request_stop();
    });
    let outcome = crate::gpu_search::run(config);
    let _ = timer.join();
    outcome
}

#[cfg(not(feature = "gpu"))]
fn run_gpu(_config: &Config, _duration: Duration) -> Result<crate::engine::SearchOutcome, String> {
    Err("GPU support is not compiled into this binary; rebuild with --features gpu.".to_owned())
}

fn rate_text(rate: f64) -> String {
    if rate >= 1e9 {
        format!("{:.2} Gk/s", rate / 1e9)
    } else {
        format!("{:.2} Mk/s", rate / 1e6)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejections_name_the_offending_option() {
        let config = Config {
            mode: Some(SearchMode::Addresses),
            ..Config::default()
        };
        assert!(validate(&config).is_err());
        let config = Config {
            mode: Some(SearchMode::Bsgs),
            ..Config::default()
        };
        assert!(validate(&config).is_err());
        let config = Config {
            coordinator: Some("http://127.0.0.1:1".to_owned()),
            ..Config::default()
        };
        assert!(validate(&config).is_err());
        let config = Config {
            bsgs_work: Some("job.rwork".to_owned()),
            ..Config::default()
        };
        assert!(validate(&config).is_err());
        assert_eq!(
            validate(&Config::default()).expect("default is address mode"),
            SearchMode::Address
        );
    }
}
