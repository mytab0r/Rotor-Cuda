use std::process::Command;

use rotor::cli::{self, Coin, CompMode, Config, Range, SearchMode, U256};

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn parse(values: &[&str]) -> Config {
    cli::parse_from(args(values)).expect("arguments should parse")
}

fn parse_err(values: &[&str]) -> cli::CliError {
    cli::parse_from(args(values)).expect_err("arguments should fail")
}

fn hex(value: &str) -> U256 {
    U256::from_hex(value).expect("valid test hex")
}

fn range(spec: &str) -> Range {
    parse(&["--range", spec])
        .range
        .expect("range should be present")
}

fn compressed_pubkey() -> String {
    format!("02{}", "ab".repeat(32))
}

#[test]
fn range_bare_start() {
    let parsed = range("1");
    assert_eq!(parsed.start, hex("1"));
    assert_eq!(parsed.end, hex("1000000000000"));

    let max = range("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
    assert_eq!(
        max.end,
        hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
            .wrapping_add(hex("FFFFFFFFFFFF"))
    );
}

#[test]
fn range_colon_forms() {
    let explicit = range("aB:cD");
    assert_eq!(explicit.start, hex("ab"));
    assert_eq!(explicit.end, hex("cd"));

    let open_start = range(":10");
    assert_eq!(open_start.start, hex("1"));
    assert_eq!(open_start.end, hex("10"));

    let count = range("1:+F");
    assert_eq!(count.start, hex("1"));
    assert_eq!(count.end, hex("10"));

    let open_count = range(":+F");
    assert_eq!(open_count.start, hex("1"));
    assert_eq!(open_count.end, hex("10"));
}

#[test]
fn range_rejects_invalid_hex() {
    assert!(cli::parse_range("xyz").is_err());
    assert!(cli::parse_range("1:xyz").is_err());
    assert!(cli::parse_range("1:+").is_err());
    assert!(cli::parse_range("").is_err());
    assert!(cli::parse_range(&"f".repeat(65)).is_err());
}

#[test]
fn missing_value_is_an_error() {
    let err = parse_err(&["--range"]);
    assert_eq!(err.message(), "'--range' requires an argument");

    let err = parse_err(&["-t"]);
    assert_eq!(err.message(), "'-t' requires an argument");

    // Tokenisation scans the whole argv, so a missing value after an
    // early-exit flag still fails, exactly like CmdParse::parse.
    let err = parse_err(&["-h", "--range"]);
    assert_eq!(err.message(), "'--range' requires an argument");
}

#[test]
fn option_value_is_consumed_even_if_it_looks_like_an_option() {
    let config = parse(&["-o", "--help"]);
    assert_eq!(config.output_file, "--help");
    assert!(!config.help);
}

#[test]
fn unknown_tokens_become_operands() {
    let config = parse(&["--nope", "-x", "abc"]);
    assert_eq!(config.operands, vec!["--nope", "-x", "abc"]);
    assert!(config.mode.is_none());
}

#[test]
fn defaults_match_cpp() {
    let config = parse_from_empty();
    assert_eq!(config.output_file, "Found.txt");
    assert_eq!(config.gpu_ids, vec![0]);
    assert!(config.grid_size.is_empty());
    assert!(config.threads >= 1);
    assert!(!config.thread_specified);
    assert_eq!(config.comp_mode, CompMode::Compressed);
    assert_eq!(config.coin, Coin::Btc);
    assert!(config.mode.is_none());
    assert!(config.range.is_none());
    assert_eq!(config.display, 1);
    assert_eq!(config.rkey, 0);
    assert_eq!(config.next, 0);
    assert_eq!(config.zet, 0);
    assert!(config.operands.is_empty());
}

fn parse_from_empty() -> Config {
    cli::parse_from(Vec::<String>::new()).expect("empty argv is valid")
}

#[test]
fn mode_and_coin_are_lowercased() {
    let config = parse(&["-m", "XpOiNt"]);
    assert_eq!(config.mode, Some(SearchMode::XPoint));

    let config = parse(&["-m", "AdDrEsSeS", "--coin", "ETH"]);
    assert_eq!(config.mode, Some(SearchMode::Addresses));
    assert_eq!(config.coin, Coin::Eth);
}

#[test]
fn eth_rejects_xpoint_modes() {
    let err = parse_err(&["--coin", "eth", "-m", "xpoint"]);
    assert_eq!(
        err.message(),
        "Wrong search or compress mode provided for ETH coin type"
    );

    let err = parse_err(&["--coin", "eth", "-m", "xpoints"]);
    assert_eq!(
        err.message(),
        "Wrong search or compress mode provided for ETH coin type"
    );

    let config = parse(&["--coin", "eth", "-m", "addresses"]);
    assert_eq!(config.comp_mode, CompMode::Uncompressed);
}

#[test]
fn bsgs_accepts_one_target_and_range() {
    let pubkey = compressed_pubkey();
    let config = parse(&["-m", "BSGS", "--range", "1:10", &pubkey]);
    assert_eq!(config.mode, Some(SearchMode::Bsgs));
    assert_eq!(config.operands, vec![pubkey]);
}

#[test]
fn bsgs_validations() {
    let pubkey = compressed_pubkey();

    let err = parse_err(&["-m", "bsgs", "--range", "1:10"]);
    assert_eq!(
        err.message(),
        "BSGS needs exactly one target public key (hex)"
    );

    let err = parse_err(&["-m", "bsgs", "--range", "1:10", &pubkey, &pubkey]);
    assert_eq!(
        err.message(),
        "BSGS needs exactly one target public key (hex)"
    );

    let err = parse_err(&["-m", "bsgs", &pubkey]);
    assert_eq!(err.message(), "BSGS needs --range START:END");

    let err = parse_err(&["-m", "bsgs", "--range", "0:0", &pubkey]);
    assert_eq!(err.message(), "BSGS needs --range START:END");

    let err = parse_err(&["-m", "bsgs", "--range", "10:1", &pubkey]);
    assert_eq!(err.message(), "BSGS range END must be >= START");

    let short = &pubkey[..65];
    let err = parse_err(&["-m", "bsgs", "--range", "1:10", short]);
    assert_eq!(
        err.message(),
        "target pubkey must be 66 (compressed) or 130 (uncompressed) hex chars, got 65"
    );

    let non_hex = format!("02{}", "zz".repeat(32));
    let err = parse_err(&["-m", "bsgs", "--range", "1:10", &non_hex]);
    assert_eq!(err.message(), "target pubkey must be hexadecimal");

    let err = parse_err(&["-m", "bsgs", "--range", "1:10", "-r", "5", &pubkey]);
    assert!(
        err.message().contains("random BSGS (-r) is non-resumable"),
        "unexpected error: {}",
        err.message()
    );

    // -r 0 is the C++ default and is accepted.
    parse(&["-m", "bsgs", "--range", "1:10", "-r", "0", &pubkey]);
}

#[test]
fn gpux_needs_two_ints_per_gpu_id() {
    let err = parse_err(&["--gpux", "1,2,3"]);
    assert!(err.message().contains("exactly 2 integers per GPU id"));

    let config = parse(&["--gpux", "1,2"]);
    assert_eq!(config.grid_size, vec![1, 2]);

    let config = parse(&["--gpui", "0,1", "--gpux", "1,2,3,4"]);
    assert_eq!(config.gpu_ids, vec![0, 1]);
    assert_eq!(config.grid_size, vec![1, 2, 3, 4]);

    let err = parse_err(&["--gpui", "0,1", "--gpux", "1,2"]);
    assert!(err.message().contains("exactly 2 integers per GPU id"));

    let err = parse_err(&["--gpux", "1,x"]);
    assert_eq!(err.message(), "Invalid --gpux argument, number expected");
}

#[test]
fn gpu_rejects_explicit_positive_thread_count() {
    let err = parse_err(&["-g", "-t", "2"]);
    assert_eq!(
        err.message(),
        "Invalid arguments, CPU and GPU, both can't be used together right now"
    );

    let err = parse_err(&["-t", "2", "-g"]);
    assert_eq!(
        err.message(),
        "Invalid arguments, CPU and GPU, both can't be used together right now"
    );

    let config = parse(&["-g", "-t", "0"]);
    assert!(config.gpu);
    assert_eq!(config.threads, 0);

    let config = parse(&["-g"]);
    assert!(config.gpu);
}

#[test]
fn action_flags_return_before_semantic_validation() {
    let config = parse(&["-m", "bsgs", "-h"]);
    assert!(config.help);

    let config = parse(&["-g", "-l"]);
    assert!(config.list);
    assert!(config.gpu);
}

#[test]
fn bsgs_work_flags_parse() {
    let config = parse(&["--bsgs-work", "job.rwork"]);
    assert_eq!(config.bsgs_work.as_deref(), Some("job.rwork"));
    assert!(!config.bsgs_work_reset);

    let config = parse(&["--bsgs-work", "job.rwork", "--bsgs-work-reset"]);
    assert_eq!(config.bsgs_work.as_deref(), Some("job.rwork"));
    assert!(config.bsgs_work_reset);

    let defaults = parse_from_empty();
    assert!(defaults.bsgs_work.is_none());
    assert!(!defaults.bsgs_work_reset);

    let err = parse_err(&["--bsgs-work"]);
    assert_eq!(err.message(), "'--bsgs-work' requires an argument");
}

#[test]
fn coordinator_flags_parse() {
    let config = parse(&[
        "-m",
        "address",
        "--range",
        "1:2",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        "--client-id",
        "rig-1",
        "14iXhn8bGajVWegZHJ18vJLHhntcpL4dex",
    ]);
    assert_eq!(config.coordinator.as_deref(), Some("http://127.0.0.1:7878"));
    assert_eq!(config.token.as_deref(), Some("secret"));
    assert_eq!(config.client_id.as_deref(), Some("rig-1"));

    let defaults = parse_from_empty();
    assert!(defaults.coordinator.is_none());
    assert!(defaults.token.is_none());
    assert!(defaults.client_id.is_none());
}

#[test]
fn coordinator_validations() {
    let addr = "14iXhn8bGajVWegZHJ18vJLHhntcpL4dex";

    let err = parse_err(&[
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        addr,
    ]);
    assert_eq!(err.message(), "coordinator mode requires -m MODE");

    let err = parse_err(&[
        "-m",
        "address",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        addr,
    ]);
    assert_eq!(err.message(), "coordinator mode requires --range START:END");

    let err = parse_err(&[
        "-m",
        "bsgs",
        "--range",
        "1:10",
        "-g",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        &compressed_pubkey(),
    ]);
    assert_eq!(
        err.message(),
        "CPU coordinator BSGS is the supported path; drop -g"
    );

    let err = parse_err(&[
        "-m",
        "address",
        "--range",
        "1:2",
        "-r",
        "5",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        addr,
    ]);
    assert_eq!(
        err.message(),
        "random start (-r) is not supported with --coordinator"
    );

    let err = parse_err(&[
        "-m",
        "address",
        "--range",
        "1:2",
        "-n",
        "1",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        addr,
    ]);
    assert_eq!(
        err.message(),
        "checkpoints (-n) are not supported with --coordinator"
    );

    let err = parse_err(&["-m", "address", "--range", "1:2", "--token", "secret", addr]);
    assert_eq!(
        err.message(),
        "--token and --client-id require --coordinator"
    );

    // `--client-id` alone is rejected the same way.
    let err = parse_err(&[
        "-m",
        "address",
        "--range",
        "1:2",
        "--client-id",
        "rig-1",
        addr,
    ]);
    assert_eq!(
        err.message(),
        "--token and --client-id require --coordinator"
    );
}

#[test]
fn gpu_coordinator_is_allowed_for_address_and_xpoint_modes() {
    let config = parse(&[
        "-m",
        "address",
        "--range",
        "1:2",
        "-g",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        "14iXhn8bGajVWegZHJ18vJLHhntcpL4dex",
    ]);
    assert!(config.gpu);
    assert_eq!(config.mode, Some(SearchMode::Address));

    let addresses = parse(&[
        "-m",
        "addresses",
        "--range",
        "1:2",
        "-g",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        "-i",
        "targets.bin",
    ]);
    assert_eq!(addresses.mode, Some(SearchMode::Addresses));

    let xpoint = parse(&[
        "-m",
        "xpoint",
        "--range",
        "1:2",
        "-g",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        &"ab".repeat(32),
    ]);
    assert_eq!(xpoint.mode, Some(SearchMode::XPoint));

    let xpoints = parse(&[
        "-m",
        "xpoints",
        "--range",
        "1:2",
        "-g",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        "-i",
        "targets.bin",
    ]);
    assert_eq!(xpoints.mode, Some(SearchMode::XPoints));

    let eth = parse(&[
        "-m",
        "address",
        "--coin",
        "eth",
        "--range",
        "1:2",
        "-g",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        "0xfda5c442e76a95f96c09782f1a15d3b58e32404f",
    ]);
    assert_eq!(eth.coin, Coin::Eth);
    assert!(eth.gpu);
}

#[test]
fn coordinator_without_a_token_fails_in_the_binary() {
    let output = Command::new(env!("CARGO_BIN_EXE_rotor"))
        .args([
            "-m",
            "address",
            "--range",
            "1:2",
            "--coordinator",
            "http://127.0.0.1:1",
            "14iXhn8bGajVWegZHJ18vJLHhntcpL4dex",
        ])
        .env_remove("ROTOR_COORD_TOKEN")
        .output()
        .expect("binary should run");

    assert_eq!(output.status.code(), Some(1), "status: {:?}", output.status);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("requires --token"), "stderr: {stderr}");
}

#[cfg(not(feature = "gpu"))]
#[test]
fn gpu_flag_without_feature_fails_loudly() {
    let pubkey = compressed_pubkey();
    let output = Command::new(env!("CARGO_BIN_EXE_rotor"))
        .args(["-g", "-m", "bsgs", "--range", "1:100", &pubkey])
        .output()
        .expect("binary should run");

    assert_eq!(output.status.code(), Some(2), "status: {:?}", output.status);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("GPU support is not compiled"),
        "stderr: {stderr}"
    );
}

#[test]
fn binary_version_and_help() {
    let version = Command::new(env!("CARGO_BIN_EXE_rotor"))
        .arg("--version")
        .output()
        .expect("binary should run");
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).expect("utf-8 stdout"),
        "Rotor-Cuda v2.0-rotor  mytab0r\n"
    );
    assert!(version.stderr.is_empty());

    let help = Command::new(env!("CARGO_BIN_EXE_rotor"))
        .arg("--help")
        .output()
        .expect("binary should run");
    assert!(help.status.success());
    assert_eq!(
        String::from_utf8(help.stdout).expect("utf-8 stdout"),
        cli::USAGE
    );
    assert!(help.stderr.is_empty());
}
