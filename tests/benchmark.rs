use std::sync::Mutex;
use std::time::{Duration, Instant};

use rotor::benchmark::{self, Measurement};
use rotor::cli::{self, Coin, Config, Range, SearchMode, U256};
use rotor::engine;

/// The stop flag is process-wide, so engine-touching tests must not overlap.
static ENGINE: Mutex<()> = Mutex::new(());

fn bench_config() -> Config {
    Config {
        threads: 1,
        display: 0,
        coin: Coin::Btc,
        mode: Some(SearchMode::Address),
        ..Config::default()
    }
}

fn temp_path(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after the epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "rotor_benchmark_test_{tag}_{}_{nanos}.tmp",
        std::process::id()
    ))
}

fn hex(value: &str) -> U256 {
    U256::from_hex(value).expect("valid test hex")
}

/// Both engine-touching checks live in one test: the stop flag is process-wide,
/// so two concurrent timed runs could cut each other short.
#[test]
fn run_for_stops_near_the_duration_and_measure_reports_a_rate() {
    let _guard = ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let output = temp_path("run_for");
    let mut run_config = bench_config();
    run_config.operands = vec!["1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH".to_owned()];
    run_config.range = Some(Range {
        start: hex("100000000"),
        end: hex("1FFFFFFFF"),
    });
    run_config.output_file = output.to_string_lossy().into_owned();

    let started = Instant::now();
    let outcome =
        engine::run_for(&run_config, Duration::from_millis(200)).expect("timed run should finish");
    let elapsed = started.elapsed();
    let _ = std::fs::remove_file(&output);

    assert!(outcome.scanned > 0, "the timed run scanned nothing");
    assert_eq!(outcome.found, 0, "the synthetic target must never match");
    assert!(
        elapsed >= Duration::from_millis(200),
        "run_for returned before its timer: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "run_for overshot its timer: {elapsed:?}"
    );

    let measurement =
        benchmark::measure(&bench_config(), Duration::from_millis(300)).expect("benchmark runs");
    assert_eq!(measurement.backend, "CPU");
    assert_eq!(measurement.threads, 1);
    assert!(measurement.scanned > 0, "benchmark scanned nothing");
    assert!(
        measurement.keys_per_second > 0.0,
        "benchmark rate must be positive"
    );
    assert!(measurement.seconds > 0.0);
}

#[test]
fn measure_seconds_reflect_the_wall_clock() {
    let _guard = ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let duration = Duration::from_millis(200);
    let measurement = benchmark::measure(&bench_config(), duration).expect("benchmark runs");

    assert!(measurement.scanned > 0, "benchmark scanned nothing");
    assert!(measurement.seconds > 0.0, "seconds must be positive");
    // A truthful wall-clock measurement is far below this bound; a duration
    // taken from the timer (or inflated by joining it after an early return)
    // would not be.
    assert!(
        measurement.seconds < duration.as_secs_f64() * 10.0,
        "seconds {} is not a plausible scan time for {duration:?}",
        measurement.seconds
    );
    let rate = measurement.scanned as f64 / measurement.seconds;
    assert!(
        (rate - measurement.keys_per_second).abs() / rate.max(1.0) < 0.01,
        "keys_per_second {} must match scanned/seconds {rate}",
        measurement.keys_per_second
    );
}

#[test]
fn measurement_json_round_trips() {
    let fixture = Measurement {
        backend: "CPU",
        threads: 4,
        seconds: 2.5,
        scanned: 1_000_000,
        keys_per_second: 400_000.0,
    };
    let json = serde_json::to_string(&fixture).expect("measurement should serialize");
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");

    assert_eq!(value["backend"], "CPU");
    assert_eq!(value["threads"], 4);
    assert_eq!(value["seconds"].as_f64(), Some(2.5));
    assert_eq!(value["scanned"], 1_000_000);
    assert_eq!(value["keys_per_second"].as_f64(), Some(400_000.0));

    let rate =
        value["scanned"].as_f64().expect("scanned") / value["seconds"].as_f64().expect("seconds");
    assert!(
        (rate - value["keys_per_second"].as_f64().expect("rate")).abs() < 1e-6,
        "scanned / seconds must match keys_per_second"
    );
}

fn measure_error(config: &Config) -> String {
    benchmark::measure(config, Duration::from_millis(200))
        .expect_err("benchmark must reject this configuration")
}

#[test]
fn multi_target_modes_are_rejected() {
    for mode in [SearchMode::Addresses, SearchMode::XPoints] {
        let config = Config {
            mode: Some(mode),
            ..bench_config()
        };
        let err = measure_error(&config);
        assert!(
            err.contains("single target"),
            "unexpected error for {mode:?}: {err}"
        );
    }
}

#[test]
fn bsgs_is_rejected() {
    let config = Config {
        mode: Some(SearchMode::Bsgs),
        ..bench_config()
    };
    let err = measure_error(&config);
    assert!(err.contains("BSGS"), "unexpected error: {err}");
}

#[test]
fn coordinator_and_work_file_are_rejected() {
    let mut config = bench_config();
    config.coordinator = Some("http://127.0.0.1:7878".to_owned());
    let err = measure_error(&config);
    assert!(err.contains("--coordinator"), "unexpected error: {err}");

    let mut config = bench_config();
    config.bsgs_work = Some("job.rwork".to_owned());
    let err = measure_error(&config);
    assert!(err.contains("--bsgs-work"), "unexpected error: {err}");

    let mut config = bench_config();
    config.bsgs_work_reset = true;
    let err = measure_error(&config);
    assert!(err.contains("--bsgs-work"), "unexpected error: {err}");
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn cli_parses_benchmark_flags_and_defaults() {
    let defaults = cli::parse_from(Vec::<String>::new()).expect("empty argv is valid");
    assert!(!defaults.benchmark);
    assert_eq!(defaults.benchmark_seconds, 5.0);
    assert!(!defaults.benchmark_json);

    let config = cli::parse_from(args(&["--benchmark"])).expect("flag parses");
    assert!(config.benchmark);
    assert_eq!(config.benchmark_seconds, 5.0);
    assert!(!config.benchmark_json);

    let config = cli::parse_from(args(&[
        "--benchmark",
        "--benchmark-seconds",
        "1.5",
        "--benchmark-json",
    ]))
    .expect("all benchmark flags parse");
    assert!(config.benchmark);
    assert_eq!(config.benchmark_seconds, 1.5);
    assert!(config.benchmark_json);

    let err = cli::parse_from(args(&["--benchmark-seconds", "1"])).expect_err("needs the flag");
    assert!(err.message().contains("--benchmark"), "unexpected: {err}");

    let err = cli::parse_from(args(&["--benchmark-json"])).expect_err("needs the flag");
    assert!(err.message().contains("--benchmark"), "unexpected: {err}");
}
