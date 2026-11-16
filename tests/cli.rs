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
fn gpu_ids_accept_multiple_and_reject_duplicates_or_negatives() {
    let config = parse(&["--gpui", "0,1"]);
    assert_eq!(config.gpu_ids, vec![0, 1]);

    let config = parse(&["--gpui", "0,1", "--gpux", "1,2,3,4"]);
    assert_eq!(config.gpu_ids, vec![0, 1]);

    let err = parse_err(&["--gpui", "0,0"]);
    assert!(
        err.message().contains("duplicate GPU id 0"),
        "unexpected error: {}",
        err.message()
    );

    let err = parse_err(&["--gpui", "0,-1"]);
    assert!(
        err.message().contains("non-negative"),
        "unexpected error: {}",
        err.message()
    );
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
fn targets_text_flag_parses() {
    let config = parse(&["-m", "addresses", "--targets-text", "targets.txt"]);
    assert_eq!(config.targets_text.as_deref(), Some("targets.txt"));
    assert!(config.input_file.is_none());

    let config = parse(&["-m", "xpoints", "--targets-text", "-"]);
    assert_eq!(config.targets_text.as_deref(), Some("-"));

    let defaults = parse_from_empty();
    assert!(defaults.targets_text.is_none());

    let err = parse_err(&["--targets-text"]);
    assert_eq!(err.message(), "'--targets-text' requires an argument");
}

#[test]
fn targets_text_validations() {
    let err = parse_err(&["-m", "addresses", "--targets-text", "t.txt", "-i", "t.bin"]);
    assert_eq!(
        err.message(),
        "--targets-text and -i are mutually exclusive"
    );

    let err = parse_err(&["--targets-text", "t.txt"]);
    assert_eq!(
        err.message(),
        "--targets-text requires -m addresses or -m xpoints"
    );

    let err = parse_err(&["-m", "address", "--targets-text", "t.txt"]);
    assert_eq!(
        err.message(),
        "--targets-text requires -m addresses or -m xpoints"
    );

    let err = parse_err(&[
        "-m",
        "bsgs",
        "--range",
        "1:10",
        "--targets-text",
        "t.txt",
        &compressed_pubkey(),
    ]);
    assert_eq!(
        err.message(),
        "--targets-text requires -m addresses or -m xpoints"
    );
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
fn gpu_random_and_checkpoint_flags_parse() {
    let addr = "14iXhn8bGajVWegZHJ18vJLHhntcpL4dex";

    // `-r > 0`: `-n` is the random bit width, not a checkpoint period.
    let config = parse(&[
        "-g", "-m", "address", "--range", "1:2", "-r", "5", "-n", "71", addr,
    ]);
    assert!(config.gpu);
    assert_eq!(config.rkey, 5);
    assert_eq!(config.next, 71);

    // `-r == 0`: `-n` is the checkpoint period in minutes.
    let config = parse(&["-g", "-m", "address", "--range", "1:2", "-n", "1", addr]);
    assert!(config.gpu);
    assert_eq!(config.rkey, 0);
    assert_eq!(config.next, 1);

    // Coordinator mode keeps rejecting the random start for a GPU client.
    let err = parse_err(&[
        "-g",
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

fn run_rotor(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_rotor"))
        .args(args)
        .output()
        .expect("binary should run")
}

#[test]
fn counter_range_parses_decimal_and_hex() {
    let range = cli::parse_counter_range("0:8").expect("decimal range");
    assert_eq!(range.start, 0);
    assert_eq!(range.end, 8);
    assert_eq!(range.count(), 8);

    let range = cli::parse_counter_range("0x10:0X20").expect("hex range");
    assert_eq!((range.start, range.end), (16, 32));

    // Exactly 2^32 entries is allowed; END is exclusive.
    let range = cli::parse_counter_range("0:4294967296").expect("max range");
    assert_eq!(range.count(), 1 << 32);
}

#[test]
fn counter_range_rejects_bad_forms() {
    for bad in [
        "",
        "0",
        "0:",
        ":8",
        "8:0",
        "0:0",
        "0:4294967297",
        "0x:8",
        "x:8",
        "0:0xzz",
    ] {
        assert!(
            cli::parse_counter_range(bad).is_err(),
            "range should be rejected: {bad:?}"
        );
    }
}

#[test]
fn mnemonic_audit_validations() {
    let err = parse_err(&[
        "--mnemonic-audit",
        "--counter",
        "0:8",
        "--targets-text",
        "t.txt",
    ]);
    assert_eq!(err.message(), "--mnemonic-audit requires --entropy-bits N");

    let err = parse_err(&[
        "--mnemonic-audit",
        "--entropy-bits",
        "128",
        "--targets-text",
        "t.txt",
    ]);
    assert_eq!(
        err.message(),
        "--mnemonic-audit requires --counter START:END"
    );

    let err = parse_err(&[
        "--mnemonic-audit",
        "--entropy-bits",
        "128",
        "--counter",
        "0:8",
    ]);
    assert_eq!(
        err.message(),
        "--mnemonic-audit requires a target list (--targets-text FILE or -i FILE)"
    );

    let err = parse_err(&[
        "--mnemonic-audit",
        "--entropy-bits",
        "129",
        "--counter",
        "0:8",
        "--targets-text",
        "t.txt",
    ]);
    assert!(err.message().contains("128, 160, 192, 224, 256"));

    let config = parse(&[
        "--mnemonic-audit",
        "--entropy-bits",
        "160",
        "--counter",
        "0x10:0x20",
        "-i",
        "t.bin",
    ]);
    assert_eq!(config.entropy_bits, Some(160));
    assert_eq!(
        config.counter,
        Some(cli::CounterRange { start: 16, end: 32 })
    );

    let err = parse_err(&[
        "--mnemonic-audit",
        "--entropy-bits",
        "128",
        "--counter",
        "0:8",
        "-m",
        "address",
        "-i",
        "t.bin",
    ]);
    assert!(err.message().contains("BTC P2PKH hash160"));

    for flag in ["-u", "-b"] {
        let err = parse_err(&[
            "--mnemonic-audit",
            "--entropy-bits",
            "128",
            "--counter",
            "0:8",
            "--targets-text",
            "t.txt",
            flag,
        ]);
        assert_eq!(
            err.message(),
            "mnemonic tools derive compressed P2PKH addresses only; drop -u/-b"
        );
    }
}

#[test]
fn mnemonic_flags_conflict_with_search_backends() {
    let err = parse_err(&["--mnemonic-derive", "--mnemonic", "abandon", "-g"]);
    assert_eq!(
        err.message(),
        "mnemonic flags are not supported with -g/--gpu"
    );

    let err = parse_err(&[
        "--mnemonic-from-entropy",
        "00",
        "-m",
        "bsgs",
        "--range",
        "1:10",
        &compressed_pubkey(),
    ]);
    assert_eq!(
        err.message(),
        "mnemonic flags are not supported with -m bsgs"
    );

    let err = parse_err(&[
        "--mnemonic-audit",
        "--coordinator",
        "http://127.0.0.1:7878",
        "--token",
        "secret",
        "-m",
        "address",
        "--range",
        "1:2",
        "14iXhn8bGajVWegZHJ18vJLHhntcpL4dex",
    ]);
    assert_eq!(
        err.message(),
        "mnemonic flags are not supported with --coordinator"
    );

    let err = parse_err(&["--mnemonic-from-entropy", "00", "-g"]);
    assert_eq!(
        err.message(),
        "mnemonic flags are not supported with -g/--gpu"
    );
}

#[test]
fn mnemonic_derive_validations() {
    let err = parse_err(&["--mnemonic-derive"]);
    assert_eq!(
        err.message(),
        "--mnemonic-derive requires --mnemonic PHRASE"
    );

    let err = parse_err(&["--mnemonic", "abandon"]);
    assert_eq!(err.message(), "--mnemonic requires --mnemonic-derive");

    let err = parse_err(&["--mnemonic-from-entropy", "00", "--mnemonic", "x"]);
    assert!(err.message().contains("cannot be combined"));

    let err = parse_err(&[
        "--mnemonic-derive",
        "--mnemonic",
        "x",
        "--mnemonic-from-entropy",
        "00",
    ]);
    assert!(err.message().contains("cannot be combined"));

    let err = parse_err(&["--mnemonic-passphrase", "x"]);
    assert!(
        err.message()
            .contains("require --mnemonic-derive or --mnemonic-audit")
    );

    let err = parse_err(&["--mnemonic-path", "m/0"]);
    assert!(
        err.message()
            .contains("require --mnemonic-derive or --mnemonic-audit")
    );

    let err = parse_err(&[
        "--mnemonic-derive",
        "--mnemonic",
        "abandon",
        "--coin",
        "eth",
    ]);
    assert_eq!(
        err.message(),
        "mnemonic tools support BTC P2PKH addresses only"
    );
}

#[test]
fn mnemonic_from_entropy_binary() {
    let output = run_rotor(&[
        "--mnemonic-from-entropy",
        "00000000000000000000000000000000",
    ]);
    assert!(output.status.success(), "status: {:?}", output.status);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    );
}

#[test]
fn mnemonic_derive_binary() {
    let output = run_rotor(&[
        "--mnemonic-derive",
        "--mnemonic",
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    ]);
    assert!(output.status.success(), "status: {:?}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    for expected in [
        "m/44'/0'/0'/0/0",
        "73c5da0a",
        "e284129cc0922579a535bbf4d1a3b25773090d28c909bc0fed73b5e0222cc372",
        "03aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e",
        "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",
    ] {
        assert!(
            stdout.contains(expected),
            "missing {expected:?} in: {stdout}"
        );
    }
}

#[test]
fn mnemonic_audit_finds_a_known_counter() {
    let target =
        std::env::temp_dir().join(format!("rotor-mnemonic-targets-{}.txt", std::process::id()));
    std::fs::write(&target, "1EfCaguhRK1DzLmvMF5nqSuAVLhv8hPxq8\n")
        .expect("target file should be written");

    let output = run_rotor(&[
        "--mnemonic-audit",
        "--entropy-bits",
        "128",
        "--counter",
        "2:5",
        "--targets-text",
        target.to_str().expect("utf-8 temp path"),
    ]);
    let _ = std::fs::remove_file(&target);

    assert!(output.status.success(), "status: {:?}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("MATCH"), "stdout: {stdout}");
    assert!(stdout.contains("counter : 3"), "stdout: {stdout}");
    assert!(
        stdout.contains(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon alpha"
        ),
        "stdout: {stdout}"
    );
    assert!(
        stdout.contains("1EfCaguhRK1DzLmvMF5nqSuAVLhv8hPxq8"),
        "stdout: {stdout}"
    );

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("WARNING"), "stderr: {stderr}");
    assert!(stderr.contains("authorized"), "stderr: {stderr}");
}

#[test]
fn mnemonic_audit_matches_xpoint_targets() {
    let target =
        std::env::temp_dir().join(format!("rotor-mnemonic-xpoints-{}.txt", std::process::id()));
    std::fs::write(
        &target,
        "f0b68ab805f64b8106e4ea56ec984662dff70e4d11ba0ef51019c300b648b078\n",
    )
    .expect("target file should be written");

    let output = run_rotor(&[
        "--mnemonic-audit",
        "--entropy-bits",
        "128",
        "--counter",
        "2:5",
        "-m",
        "xpoints",
        "--targets-text",
        target.to_str().expect("utf-8 temp path"),
    ]);
    let _ = std::fs::remove_file(&target);

    assert!(output.status.success(), "status: {:?}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("MATCH"), "stdout: {stdout}");
    assert!(stdout.contains("counter : 3"), "stdout: {stdout}");
    assert!(
        stdout
            .contains("xpoint  : f0b68ab805f64b8106e4ea56ec984662dff70e4d11ba0ef51019c300b648b078"),
        "stdout: {stdout}"
    );
}
