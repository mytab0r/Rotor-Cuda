//! Command-line parsing that mirrors `Rotor-Cuda/CmdParse.cpp` and the option
//! handling in `Rotor-Cuda/Main.cpp`.

use std::fmt;

use crate::chain::{self, ChainDescriptor};

pub const RELEASE: &str = "2.0-rotor  mytab0r";
pub const VERSION_LINE: &str = "Rotor-Cuda v2.0-rotor  mytab0r";

/// Usage text copied verbatim from `Main.cpp` lines 41-79.
pub const USAGE: &str = concat!(
    r#"Rotor-Cuda [OPTIONS...] [TARGETS]
Where TARGETS is one address/xpont, or multiple hashes/xpoints file

-h, --help                                   : Display this message
-c, --check                                : Check the working of the codes
-u, --uncomp                            : Search uncompressed points
-b, --both                                   : Search both uncompressed or compressed points
-g, --gpu                                    : Enable GPU calculation
--gpui  GPU ids: 0,1,2,...         : List of GPU(s) to use, default is 0
--gpux gridsize: g0x,g0y,g1x,g1y,...     : Specify GPU(s) kernel gridsize, default is 8*(Device MP count),128
-t, --thread N                            : Specify number of CPU thread, default is number of core
-i, --in FILE                                : Read raw binary target records from FILE: 20-byte address records or 32-byte xpoints. Records carry no chain tag, so --chain decides the chain and one file cannot mix chains
--targets-text FILE                        : Read targets from a text FILE, one per line (- = stdin); needs -m addresses|xpoints. Every address must belong to --chain; a file mixing chains is rejected
-o, --out FILE                            : Write keys to FILE, default: Found.txt
-m, --mode MODE                   : Specify search mode where MODE is
                                                      Address  : for single address
                                                      Addresses: for multiple hashes/addresses
                                                      Xpoint   : for single xpoint
                                                      Xpoints : for multiple xpoints
                                                      BSGS     : recover scalar from a public key in --range (CPU-BSGS; -g selects GPU-BSGS)
--chain SLUG                       : Specify the chain to search (see --list-chains)
                                                      slugs and aliases: bitcoin/btc,
                                                      ethereum/eth, bnb, arbitrum/arb,
                                                      optimism/op, base, polygon/matic,
                                                      avalanche/avax, zksync, solana/sol,
                                                      tron/trx, xrp, litecoin/ltc,
                                                      bitcoin-cash/bch, dogecoin/doge,
                                                      zcash/zec, sui, ton
--list-chains                      : List all 18 chains (slug, family, curve, modes)
--coin BTC/ETH                      : Deprecated alias for --chain bitcoin/ethereum
                                                      (prints a warning)
-l, --list.                                      : List Cuda enabled devices
--range KEYSPACE                  : Specify the range:
                                                      START:END
                                                      START:+COUNT
                                                      START
                                                      :END
                                                      :+COUNT
                                                      Where START, END, COUNT are in hex format
-r, --rkey Rkey                            : Reloads random start Private key every (-r 10 = 10.000.000.000), default is disabled
-c, --check                                 : Check the working of the codes
-n, --next                                    : Range mode GPU save checkpoints every -n ? minutes (1-10000) Default: false
-n, --next                                    : Random mode: What bit range to randomize? -n 1-256 Example -n 252 Default: 252-256 bit
-z, --zet                                       : Random mode: End range for random. Example -n 71 -z 74 (random in puzzles 71,72,73,74 bit) Default: false
-d, --display                               : Disable all informers, compact version for many GPUs. Use -d 0 Default -d 1 (display all)
--coordinator URL                  : Lease disjoint key chunks from a rotor-coord server
--token TOKEN                      : Coordinator API token (or ROTOR_COORD_TOKEN)
--client-id ID                     : Coordinator client id, default is hostname + pid
--bsgs-work FILE                   : CPU-BSGS work file: save the table/position and resume from it
--bsgs-work-reset                  : Overwrite a mismatched or stale --bsgs-work file and start over
--benchmark                        : Measure the backend key rate on a synthetic miss range
--benchmark-seconds N              : Benchmark duration in seconds, default is 5
--benchmark-json                   : Print the benchmark result as one JSON object
--mnemonic PHRASE                  : BIP39 phrase for --mnemonic-derive
--mnemonic-passphrase P            : BIP39 passphrase (default: empty)
--mnemonic-path PATH               : BIP32 path, default m/44'/0'/0'/0/0
--mnemonic-derive                  : Print phrase/seed id/key/pubkey/address
--mnemonic-from-entropy HEX        : Print the BIP39 phrase for raw hex entropy
--mnemonic-audit                   : Audit a bounded entropy counter space
--entropy-bits N                   : Audit entropy size: 128/160/192/224/256
--counter START:END                : Audit counters (decimal or 0x hex; END exclusive)"#,
    " \n",
);

/// Parse error raised by [`parse_from`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError {
    message: String,
}

impl CliError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CompMode {
    #[default]
    Compressed,
    Uncompressed,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Address,
    XPoint,
    Addresses,
    XPoints,
    Bsgs,
}

impl SearchMode {
    /// Lowercase name used by the coordinator protocol, `--list-chains` and
    /// error messages.
    pub const fn name(self) -> &'static str {
        match self {
            SearchMode::Address => "address",
            SearchMode::Addresses => "addresses",
            SearchMode::XPoint => "xpoint",
            SearchMode::XPoints => "xpoints",
            SearchMode::Bsgs => "bsgs",
        }
    }
}

/// Search modes the desktop engine implements for a chain today.
///
/// Every other chain has a descriptor (so `--list-chains` and address
/// derivation work) but no search path yet; selecting one must fail loudly.
pub fn supported_modes(chain: &ChainDescriptor) -> &'static [SearchMode] {
    const BITCOIN: &[SearchMode] = &[
        SearchMode::Address,
        SearchMode::Addresses,
        SearchMode::XPoint,
        SearchMode::XPoints,
        SearchMode::Bsgs,
    ];
    const ETHEREUM: &[SearchMode] = &[SearchMode::Address, SearchMode::Addresses, SearchMode::Bsgs];
    match chain.id {
        "bitcoin" => BITCOIN,
        "ethereum" => ETHEREUM,
        _ => &[],
    }
}

/// True when the chain has at least one implemented search mode.
fn chain_is_implemented(chain: &ChainDescriptor) -> bool {
    !supported_modes(chain).is_empty()
}

/// Modes as a comma-separated list, or `none` for an unimplemented chain.
pub fn modes_text(modes: &[SearchMode]) -> String {
    if modes.is_empty() {
        "none".to_owned()
    } else {
        modes
            .iter()
            .map(|mode| mode.name())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Error for a mode the selected chain does not implement yet.
pub fn unsupported_mode_message(chain: &ChainDescriptor, mode: SearchMode) -> String {
    format!(
        "chain '{}' is not implemented for mode '{}' yet; supported modes: {}",
        chain.id,
        mode.name(),
        modes_text(supported_modes(chain))
    )
}

/// Human-readable `--list-chains` table: slug, family, curve and modes.
pub fn list_chains_text() -> String {
    let mut out = String::from(
        "  CHAIN ID        NAME             FAMILY        CURVE      ALIASES        MODES\n",
    );
    for descriptor in chain::all() {
        let modes = supported_modes(descriptor);
        let modes = if modes.is_empty() {
            "not implemented yet".to_owned()
        } else {
            modes_text(modes)
        };
        let aliases = chain::aliases_for(descriptor.id);
        let aliases = if aliases.is_empty() {
            "-".to_owned()
        } else {
            aliases.join(",")
        };
        out.push_str(&format!(
            "  {:<15} {:<16} {:<13} {:<10} {:<14} {modes}\n",
            descriptor.id,
            descriptor.name,
            descriptor.family.label(),
            descriptor.curve.label(),
            aliases,
        ));
    }
    out
}

/// Big-endian 256-bit integer used for range endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct U256(pub [u8; 32]);

impl U256 {
    pub const ZERO: Self = Self([0; 32]);

    pub const fn from_u64(value: u64) -> Self {
        let mut bytes = [0; 32];
        let source = value.to_be_bytes();
        let mut i = 0;
        while i < 8 {
            bytes[24 + i] = source[i];
            i += 1;
        }
        Self(bytes)
    }

    pub fn from_hex(text: &str) -> Result<Self, CliError> {
        if text.is_empty() {
            return Err(CliError::new("Invalid hex value: empty"));
        }
        if text.len() > 64 {
            return Err(CliError::new(format!(
                "Invalid hex value: more than 64 digits: {text}"
            )));
        }

        let mut bytes = [0; 32];
        for (index, byte) in text.bytes().rev().enumerate() {
            let nibble = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => {
                    return Err(CliError::new(format!("Invalid hex value: {text}")));
                }
            };
            let slot = 31 - index / 2;
            if index % 2 == 0 {
                bytes[slot] = nibble;
            } else {
                bytes[slot] |= nibble << 4;
            }
        }
        Ok(Self(bytes))
    }

    pub fn wrapping_add(self, rhs: Self) -> Self {
        let mut bytes = [0; 32];
        let mut carry = 0u16;
        for i in (0..32).rev() {
            let sum = u16::from(self.0[i]) + u16::from(rhs.0[i]) + carry;
            bytes[i] = sum as u8;
            carry = sum >> 8;
        }
        Self(bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub start: U256,
    pub end: U256,
}

/// Inclusive start / exclusive end counter range for `--mnemonic-audit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CounterRange {
    pub start: u64,
    pub end: u64,
}

impl CounterRange {
    /// Number of counters in the range.
    pub fn count(self) -> u64 {
        self.end - self.start
    }
}

/// Largest audit range accepted in one run (`2^32` candidates).
pub const MAX_AUDIT_CANDIDATES: u64 = 1 << 32;

/// Parses `--counter START:END` (decimal or `0x` hex, END exclusive).
pub fn parse_counter_range(spec: &str) -> Result<CounterRange, CliError> {
    let Some((start_text, end_text)) = spec.split_once(':') else {
        return Err(CliError::new(format!(
            "Invalid --counter value '{spec}', expected START:END"
        )));
    };
    let start = parse_counter(start_text, spec)?;
    let end = parse_counter(end_text, spec)?;
    if end <= start {
        return Err(CliError::new(format!(
            "Invalid --counter value '{spec}': END must be greater than START"
        )));
    }
    if end - start > MAX_AUDIT_CANDIDATES {
        return Err(CliError::new(format!(
            "Invalid --counter value '{spec}': range is {} entries, at most {MAX_AUDIT_CANDIDATES} are allowed",
            end - start
        )));
    }
    Ok(CounterRange { start, end })
}

fn parse_counter(text: &str, spec: &str) -> Result<u64, CliError> {
    let parsed = if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        if hex.is_empty() {
            return Err(CliError::new(format!(
                "Invalid --counter value '{spec}': empty hexadecimal number"
            )));
        }
        u64::from_str_radix(hex, 16)
    } else {
        text.parse::<u64>()
    };
    parsed.map_err(|_| {
        CliError::new(format!(
            "Invalid --counter value '{spec}': '{text}' is not a decimal or 0x-hex number"
        ))
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub help: bool,
    pub check: bool,
    pub list: bool,
    pub list_chains: bool,
    pub version: bool,
    pub check_update: bool,
    pub update: bool,
    pub gpu: bool,
    pub comp_mode: CompMode,
    pub gpu_ids: Vec<i32>,
    pub grid_size: Vec<i32>,
    pub threads: usize,
    pub thread_specified: bool,
    pub input_file: Option<String>,
    pub targets_text: Option<String>,
    pub output_file: String,
    pub mode: Option<SearchMode>,
    /// Selected chain descriptor; defaults to Bitcoin.
    pub chain: &'static ChainDescriptor,
    /// True when the deprecated `--coin` alias was used.
    pub coin_deprecated: bool,
    pub range: Option<Range>,
    pub rkey: u64,
    pub next: i32,
    pub zet: i32,
    pub display: i32,
    pub coordinator: Option<String>,
    pub token: Option<String>,
    pub client_id: Option<String>,
    pub bsgs_work: Option<String>,
    pub bsgs_work_reset: bool,
    pub benchmark: bool,
    pub benchmark_seconds: f64,
    pub benchmark_json: bool,
    pub mnemonic: Option<String>,
    pub mnemonic_passphrase: String,
    pub mnemonic_path: Option<String>,
    pub mnemonic_derive: bool,
    pub mnemonic_from_entropy: Option<String>,
    pub mnemonic_audit: bool,
    pub entropy_bits: Option<u32>,
    pub counter: Option<CounterRange>,
    pub operands: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            help: false,
            check: false,
            list: false,
            list_chains: false,
            version: false,
            check_update: false,
            update: false,
            gpu: false,
            comp_mode: CompMode::Compressed,
            gpu_ids: vec![0],
            grid_size: Vec::new(),
            threads: std::thread::available_parallelism()
                .map(|count| count.get())
                .unwrap_or(1),
            thread_specified: false,
            input_file: None,
            targets_text: None,
            output_file: "Found.txt".to_owned(),
            mode: None,
            chain: chain::by_id("bitcoin").expect("bitcoin descriptor is part of CHAINS"),
            coin_deprecated: false,
            range: None,
            rkey: 0,
            next: 0,
            zet: 0,
            display: 1,
            coordinator: None,
            token: None,
            client_id: None,
            bsgs_work: None,
            bsgs_work_reset: false,
            benchmark: false,
            benchmark_seconds: 5.0,
            benchmark_json: false,
            mnemonic: None,
            mnemonic_passphrase: String::new(),
            mnemonic_path: None,
            mnemonic_derive: false,
            mnemonic_from_entropy: None,
            mnemonic_audit: false,
            entropy_bits: None,
            counter: None,
            operands: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opt {
    Help,
    Check,
    List,
    Uncomp,
    Both,
    Gpu,
    GpuIds,
    GpuGrid,
    Thread,
    In,
    TargetsText,
    Out,
    Mode,
    Chain,
    ListChains,
    Coin,
    Range,
    Rkey,
    Version,
    CheckUpdate,
    Update,
    Next,
    Zet,
    Display,
    Coordinator,
    Token,
    ClientId,
    BsgsWork,
    BsgsWorkReset,
    Benchmark,
    BenchmarkSeconds,
    BenchmarkJson,
    Mnemonic,
    MnemonicPassphrase,
    MnemonicPath,
    MnemonicDerive,
    MnemonicFromEntropy,
    MnemonicAudit,
    EntropyBits,
    Counter,
}

/// Exact-token option table: `(token, option, takes_argument)`.
const OPTIONS: &[(&str, Opt, bool)] = &[
    ("-h", Opt::Help, false),
    ("--help", Opt::Help, false),
    ("-c", Opt::Check, false),
    ("--check", Opt::Check, false),
    ("-l", Opt::List, false),
    ("--list", Opt::List, false),
    ("-u", Opt::Uncomp, false),
    ("--uncomp", Opt::Uncomp, false),
    ("-b", Opt::Both, false),
    ("--both", Opt::Both, false),
    ("-g", Opt::Gpu, false),
    ("--gpu", Opt::Gpu, false),
    ("--gpui", Opt::GpuIds, true),
    ("--gpux", Opt::GpuGrid, true),
    ("-t", Opt::Thread, true),
    ("--thread", Opt::Thread, true),
    ("-i", Opt::In, true),
    ("--in", Opt::In, true),
    ("--targets-text", Opt::TargetsText, true),
    ("-o", Opt::Out, true),
    ("--out", Opt::Out, true),
    ("-m", Opt::Mode, true),
    ("--mode", Opt::Mode, true),
    ("--chain", Opt::Chain, true),
    ("--list-chains", Opt::ListChains, false),
    ("--coin", Opt::Coin, true),
    ("--range", Opt::Range, true),
    ("-r", Opt::Rkey, true),
    ("--rkey", Opt::Rkey, true),
    ("-v", Opt::Version, false),
    ("--version", Opt::Version, false),
    ("--check-update", Opt::CheckUpdate, false),
    ("--update", Opt::Update, false),
    ("-n", Opt::Next, true),
    ("--next", Opt::Next, true),
    ("-z", Opt::Zet, true),
    ("--zet", Opt::Zet, true),
    ("-d", Opt::Display, true),
    ("--display", Opt::Display, true),
    ("--coordinator", Opt::Coordinator, true),
    ("--token", Opt::Token, true),
    ("--client-id", Opt::ClientId, true),
    ("--bsgs-work", Opt::BsgsWork, true),
    ("--bsgs-work-reset", Opt::BsgsWorkReset, false),
    ("--benchmark", Opt::Benchmark, false),
    ("--benchmark-seconds", Opt::BenchmarkSeconds, true),
    ("--benchmark-json", Opt::BenchmarkJson, false),
    ("--mnemonic", Opt::Mnemonic, true),
    ("--mnemonic-passphrase", Opt::MnemonicPassphrase, true),
    ("--mnemonic-path", Opt::MnemonicPath, true),
    ("--mnemonic-derive", Opt::MnemonicDerive, false),
    ("--mnemonic-from-entropy", Opt::MnemonicFromEntropy, true),
    ("--mnemonic-audit", Opt::MnemonicAudit, false),
    ("--entropy-bits", Opt::EntropyBits, true),
    ("--counter", Opt::Counter, true),
];

fn lookup(token: &str) -> Option<(Opt, bool)> {
    OPTIONS
        .iter()
        .find(|(name, _, _)| *name == token)
        .map(|(_, opt, has_arg)| (*opt, *has_arg))
}

fn is_action(opt: Opt) -> bool {
    matches!(
        opt,
        Opt::Help
            | Opt::Check
            | Opt::List
            | Opt::ListChains
            | Opt::Version
            | Opt::CheckUpdate
            | Opt::Update
    )
}

enum Token {
    Flag(Opt),
    Value(Opt, String),
    Operand(String),
}

/// Parse the arguments *after* the program name.
pub fn parse_from<I: IntoIterator<Item = String>>(args: I) -> Result<Config, CliError> {
    let mut tokens = Vec::new();
    let mut iter = args.into_iter();

    while let Some(arg) = iter.next() {
        match lookup(&arg) {
            Some((opt, false)) => tokens.push(Token::Flag(opt)),
            Some((opt, true)) => match iter.next() {
                Some(value) => tokens.push(Token::Value(opt, value)),
                None => {
                    return Err(CliError::new(format!("'{arg}' requires an argument")));
                }
            },
            None => tokens.push(Token::Operand(arg)),
        }
    }

    let mut config = Config::default();
    let mut benchmark_seconds_given = false;
    let mut chain_seen: Option<&'static ChainDescriptor> = None;
    let mut coin_seen: Option<&'static ChainDescriptor> = None;
    for token in tokens {
        match token {
            Token::Operand(value) => config.operands.push(value),
            Token::Flag(opt) => {
                apply_flag(&mut config, opt);
                // Match Main.cpp: these flags print and return immediately,
                // before any later option or semantic validation is reached.
                if is_action(opt) {
                    return Ok(config);
                }
            }
            Token::Value(opt, value) => {
                if opt == Opt::BenchmarkSeconds {
                    benchmark_seconds_given = true;
                }
                match opt {
                    Opt::Chain => {
                        let selected = parse_chain(&value)?;
                        if let Some(coin) = coin_seen
                            && coin.id != selected.id
                        {
                            return Err(CliError::new(
                                "--chain and the deprecated --coin select different chains; use --chain only",
                            ));
                        }
                        config.chain = selected;
                        chain_seen = Some(selected);
                    }
                    Opt::Coin => {
                        let selected = parse_coin(&value)?;
                        if let Some(chain) = chain_seen
                            && chain.id != selected.id
                        {
                            return Err(CliError::new(
                                "--chain and the deprecated --coin select different chains; use --chain only",
                            ));
                        }
                        config.chain = selected;
                        config.coin_deprecated = true;
                        coin_seen = Some(selected);
                    }
                    _ => apply_value(&mut config, opt, value)?,
                }
            }
        }
    }

    // `--benchmark-seconds`/`--benchmark-json` only make sense with the flag.
    if !config.benchmark && (benchmark_seconds_given || config.benchmark_json) {
        return Err(CliError::new(
            "--benchmark-seconds and --benchmark-json require --benchmark",
        ));
    }

    validate(&mut config)?;
    Ok(config)
}

fn apply_flag(config: &mut Config, opt: Opt) {
    match opt {
        Opt::Help => config.help = true,
        Opt::Check => config.check = true,
        Opt::List => config.list = true,
        Opt::ListChains => config.list_chains = true,
        Opt::Uncomp => config.comp_mode = CompMode::Uncompressed,
        Opt::Both => config.comp_mode = CompMode::Both,
        Opt::Gpu => config.gpu = true,
        Opt::Version => config.version = true,
        Opt::CheckUpdate => config.check_update = true,
        Opt::Update => config.update = true,
        Opt::BsgsWorkReset => config.bsgs_work_reset = true,
        Opt::Benchmark => config.benchmark = true,
        Opt::BenchmarkJson => config.benchmark_json = true,
        Opt::MnemonicDerive => config.mnemonic_derive = true,
        Opt::MnemonicAudit => config.mnemonic_audit = true,
        Opt::GpuIds
        | Opt::GpuGrid
        | Opt::Thread
        | Opt::In
        | Opt::TargetsText
        | Opt::Out
        | Opt::Mode
        | Opt::Chain
        | Opt::Coin
        | Opt::Range
        | Opt::Rkey
        | Opt::Next
        | Opt::Zet
        | Opt::Display
        | Opt::Coordinator
        | Opt::Token
        | Opt::ClientId
        | Opt::BsgsWork
        | Opt::BenchmarkSeconds
        | Opt::Mnemonic
        | Opt::MnemonicPassphrase
        | Opt::MnemonicPath
        | Opt::MnemonicFromEntropy
        | Opt::EntropyBits
        | Opt::Counter => {
            // These options always arrive as Token::Value.
        }
    }
}

fn apply_value(config: &mut Config, opt: Opt, value: String) -> Result<(), CliError> {
    match opt {
        Opt::GpuIds => config.gpu_ids = parse_int_list("--gpui", &value)?,
        Opt::GpuGrid => config.grid_size = parse_int_list("--gpux", &value)?,
        Opt::Thread => {
            config.threads = value
                .parse::<usize>()
                .map_err(|_| CliError::new("Invalid --thread argument, number expected"))?;
            config.thread_specified = true;
        }
        Opt::In => config.input_file = Some(value),
        Opt::TargetsText => config.targets_text = Some(value),
        Opt::Out => config.output_file = value,
        Opt::Mode => config.mode = Some(parse_mode(&value)?),
        Opt::Range => config.range = Some(parse_range(&value)?),
        Opt::Rkey => {
            config.rkey = value
                .parse::<u64>()
                .map_err(|_| CliError::new("Invalid --rkey argument, number expected"))?;
        }
        Opt::Next => config.next = parse_i32("--next", &value)?,
        Opt::Zet => config.zet = parse_i32("--zet", &value)?,
        Opt::Display => config.display = parse_i32("--display", &value)?,
        Opt::Coordinator => config.coordinator = Some(value),
        Opt::Token => config.token = Some(value),
        Opt::ClientId => config.client_id = Some(value),
        Opt::BsgsWork => config.bsgs_work = Some(value),
        Opt::BenchmarkSeconds => {
            config.benchmark_seconds = value.parse::<f64>().map_err(|_| {
                CliError::new("Invalid --benchmark-seconds argument, number expected")
            })?;
        }
        Opt::Mnemonic => config.mnemonic = Some(value),
        Opt::MnemonicPassphrase => config.mnemonic_passphrase = value,
        Opt::MnemonicPath => config.mnemonic_path = Some(value),
        Opt::MnemonicFromEntropy => config.mnemonic_from_entropy = Some(value),
        Opt::EntropyBits => config.entropy_bits = Some(parse_entropy_bits(&value)?),
        Opt::Counter => config.counter = Some(parse_counter_range(&value)?),
        Opt::Help
        | Opt::Check
        | Opt::List
        | Opt::ListChains
        | Opt::Chain
        | Opt::Coin
        | Opt::Uncomp
        | Opt::Both
        | Opt::Gpu
        | Opt::Version
        | Opt::CheckUpdate
        | Opt::Update
        | Opt::BsgsWorkReset
        | Opt::Benchmark
        | Opt::BenchmarkJson
        | Opt::MnemonicDerive
        | Opt::MnemonicAudit => {
            // These options never take a value.
        }
    }
    Ok(())
}

fn parse_int_list(name: &str, text: &str) -> Result<Vec<i32>, CliError> {
    let mut values = Vec::new();
    for item in text.split(',') {
        let value = item
            .parse::<i32>()
            .map_err(|_| CliError::new(format!("Invalid {name} argument, number expected")))?;
        values.push(value);
    }
    Ok(values)
}

fn parse_i32(name: &str, text: &str) -> Result<i32, CliError> {
    text.parse::<i32>()
        .map_err(|_| CliError::new(format!("Invalid {name} argument, number expected")))
}

fn parse_entropy_bits(value: &str) -> Result<u32, CliError> {
    let bits = value
        .parse::<u32>()
        .map_err(|_| CliError::new("Invalid --entropy-bits argument, number expected"))?;
    if !matches!(bits, 128 | 160 | 192 | 224 | 256) {
        return Err(CliError::new(
            "Invalid --entropy-bits argument, must be one of 128, 160, 192, 224, 256",
        ));
    }
    Ok(bits)
}

fn parse_mode(value: &str) -> Result<SearchMode, CliError> {
    let lowered = value.to_ascii_lowercase();
    match lowered.as_str() {
        "address" => Ok(SearchMode::Address),
        "xpoint" => Ok(SearchMode::XPoint),
        "addresses" => Ok(SearchMode::Addresses),
        "xpoints" => Ok(SearchMode::XPoints),
        "bsgs" => Ok(SearchMode::Bsgs),
        _ => Err(CliError::new(format!(
            "Invalid search mode format: {lowered}"
        ))),
    }
}

/// Resolve `--chain` from a site slug or ticker alias.
fn parse_chain(value: &str) -> Result<&'static ChainDescriptor, CliError> {
    chain::by_alias(value).ok_or_else(|| {
        CliError::new(format!(
            "Invalid chain name: {value} (expected a site slug or alias; run --list-chains)"
        ))
    })
}

/// Deprecated `--coin BTC|ETH` alias for `--chain bitcoin|ethereum`.
fn parse_coin(value: &str) -> Result<&'static ChainDescriptor, CliError> {
    match value.to_ascii_lowercase().as_str() {
        "btc" => Ok(chain::by_id("bitcoin").expect("bitcoin descriptor")),
        "eth" => Ok(chain::by_id("ethereum").expect("ethereum descriptor")),
        _ => Err(CliError::new(format!(
            "Invalid coin name: {value} (--coin is deprecated; use --chain <slug>)"
        ))),
    }
}

pub fn parse_range(spec: &str) -> Result<Range, CliError> {
    let Some((left, right)) = spec.split_once(':') else {
        let start = hex_part(spec, spec)?;
        return Ok(Range {
            start,
            end: start.wrapping_add(U256::from_u64(0xFFFF_FFFF_FFFF)),
        });
    };

    let start = if left.is_empty() {
        U256::from_u64(1)
    } else {
        hex_part(left, spec)?
    };

    let end = if let Some(count) = right.strip_prefix('+') {
        start.wrapping_add(hex_part(count, spec)?)
    } else {
        hex_part(right, spec)?
    };

    Ok(Range { start, end })
}

fn hex_part(value: &str, spec: &str) -> Result<U256, CliError> {
    U256::from_hex(value)
        .map_err(|err| CliError::new(format!("Invalid --range value '{spec}': {}", err.message())))
}

fn validate_mnemonic(config: &Config) -> Result<(), CliError> {
    let mnemonic_requested = config.mnemonic_derive
        || config.mnemonic.is_some()
        || config.mnemonic_from_entropy.is_some()
        || config.mnemonic_audit
        || config.mnemonic_path.is_some()
        || !config.mnemonic_passphrase.is_empty();

    if mnemonic_requested {
        if config.gpu {
            return Err(CliError::new(
                "mnemonic flags are not supported with -g/--gpu",
            ));
        }
        if config.mode == Some(SearchMode::Bsgs) {
            return Err(CliError::new(
                "mnemonic flags are not supported with -m bsgs",
            ));
        }
        if config.coordinator.is_some() {
            return Err(CliError::new(
                "mnemonic flags are not supported with --coordinator",
            ));
        }
        if config.benchmark {
            return Err(CliError::new(
                "mnemonic flags are not supported with --benchmark",
            ));
        }
        if config.chain.id != "bitcoin" {
            return Err(CliError::new(
                "mnemonic tools support BTC P2PKH addresses only; use --chain bitcoin",
            ));
        }
        if config.comp_mode != CompMode::Compressed {
            return Err(CliError::new(
                "mnemonic tools derive compressed P2PKH addresses only; drop -u/-b",
            ));
        }
    }

    if config.mnemonic_audit {
        if config.mnemonic_derive
            || config.mnemonic_from_entropy.is_some()
            || config.mnemonic.is_some()
        {
            return Err(CliError::new(
                "--mnemonic-audit cannot be combined with --mnemonic-derive, --mnemonic-from-entropy or --mnemonic",
            ));
        }
        if config.entropy_bits.is_none() {
            return Err(CliError::new("--mnemonic-audit requires --entropy-bits N"));
        }
        if config.counter.is_none() {
            return Err(CliError::new(
                "--mnemonic-audit requires --counter START:END",
            ));
        }
        if config.targets_text.is_none() && config.input_file.is_none() {
            return Err(CliError::new(
                "--mnemonic-audit requires a target list (--targets-text FILE or -i FILE)",
            ));
        }
        if !matches!(
            config.mode,
            None | Some(SearchMode::Addresses | SearchMode::XPoints)
        ) {
            return Err(CliError::new(
                "--mnemonic-audit targets are BTC P2PKH hash160 (-m addresses) or x-only pubkeys (-m xpoints)",
            ));
        }
    } else {
        if config.entropy_bits.is_some() {
            return Err(CliError::new("--entropy-bits requires --mnemonic-audit"));
        }
        if config.counter.is_some() {
            return Err(CliError::new("--counter requires --mnemonic-audit"));
        }
    }

    if config.mnemonic_derive && config.mnemonic_from_entropy.is_some() {
        return Err(CliError::new(
            "--mnemonic-derive cannot be combined with --mnemonic-from-entropy",
        ));
    }
    if config.mnemonic_from_entropy.is_some() && config.mnemonic.is_some() {
        return Err(CliError::new(
            "--mnemonic-from-entropy cannot be combined with --mnemonic",
        ));
    }
    if config.mnemonic_derive && config.mnemonic.is_none() {
        return Err(CliError::new(
            "--mnemonic-derive requires --mnemonic PHRASE",
        ));
    }
    if config.mnemonic.is_some() && !config.mnemonic_derive {
        return Err(CliError::new("--mnemonic requires --mnemonic-derive"));
    }
    if (config.mnemonic_path.is_some() || !config.mnemonic_passphrase.is_empty())
        && !(config.mnemonic_derive || config.mnemonic_audit)
    {
        return Err(CliError::new(
            "--mnemonic-passphrase and --mnemonic-path require --mnemonic-derive or --mnemonic-audit",
        ));
    }

    Ok(())
}

fn validate(config: &mut Config) -> Result<(), CliError> {
    validate_mnemonic(config)?;

    // The descriptor table knows every site network, but only the chains in
    // `supported_modes` have a desktop search path today. Reject any other
    // pair instead of silently searching the wrong primitive.
    if let Some(mode) = config.mode {
        if !supported_modes(config.chain).contains(&mode) {
            return Err(CliError::new(unsupported_mode_message(config.chain, mode)));
        }
    } else if !config.operands.is_empty()
        && !config.benchmark
        && !chain_is_implemented(config.chain)
    {
        return Err(CliError::new(unsupported_mode_message(
            config.chain,
            SearchMode::Address,
        )));
    }

    if config.benchmark && !chain_is_implemented(config.chain) {
        return Err(CliError::new(format!(
            "chain '{}' is not implemented for --benchmark yet; supported chains: bitcoin, ethereum",
            config.chain.id
        )));
    }

    // Keccak chains compare an account, not a compressed/uncompressed hash.
    if config.chain.uses_keccak() {
        config.comp_mode = CompMode::Uncompressed;
    }

    if config.targets_text.is_some() {
        if config.input_file.is_some() {
            return Err(CliError::new(
                "--targets-text and -i are mutually exclusive",
            ));
        }
        if !config.mnemonic_audit
            && !matches!(
                config.mode,
                Some(SearchMode::Addresses | SearchMode::XPoints)
            )
        {
            return Err(CliError::new(
                "--targets-text requires -m addresses or -m xpoints",
            ));
        }
    }

    if config.mode == Some(SearchMode::Bsgs) {
        if config.operands.len() != 1 {
            return Err(CliError::new(
                "BSGS needs exactly one target public key (hex)",
            ));
        }

        let Some(range) = config.range else {
            return Err(CliError::new("BSGS needs --range START:END"));
        };
        if range.start == U256::ZERO && range.end == U256::ZERO {
            return Err(CliError::new("BSGS needs --range START:END"));
        }
        if range.end < range.start {
            return Err(CliError::new("BSGS range END must be >= START"));
        }

        let target = &config.operands[0];
        let length = target.len();
        if length != 66 && length != 130 {
            return Err(CliError::new(format!(
                "target pubkey must be 66 (compressed) or 130 (uncompressed) hex chars, got {length}"
            )));
        }
        if !target.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CliError::new("target pubkey must be hexadecimal"));
        }

        if config.rkey != 0 {
            return Err(CliError::new(
                "random BSGS (-r) is non-resumable and unsupported; run sequential BSGS instead",
            ));
        }
    }

    if config.coordinator.is_some() {
        if config.mode.is_none() {
            return Err(CliError::new("coordinator mode requires -m MODE"));
        }
        if config.range.is_none() {
            return Err(CliError::new("coordinator mode requires --range START:END"));
        }
        // GPU address/xpoint/ETH clients lease chunks like the CPU path; GPU
        // BSGS is not wired to the coordinator protocol's giant-walk state.
        if config.gpu && config.mode == Some(SearchMode::Bsgs) {
            return Err(CliError::new(
                "CPU coordinator BSGS is the supported path; drop -g",
            ));
        }
        if config.rkey != 0 {
            return Err(CliError::new(
                "random start (-r) is not supported with --coordinator",
            ));
        }
        if config.next > 0 {
            return Err(CliError::new(
                "checkpoints (-n) are not supported with --coordinator",
            ));
        }
        let has_token = config
            .token
            .as_deref()
            .is_some_and(|token| !token.trim().is_empty());
        if !has_token {
            match std::env::var("ROTOR_COORD_TOKEN") {
                Ok(token) if !token.trim().is_empty() => config.token = Some(token),
                _ => {
                    return Err(CliError::new(
                        "coordinator mode requires --token or ROTOR_COORD_TOKEN",
                    ));
                }
            }
        }
    } else if config.token.is_some() || config.client_id.is_some() {
        return Err(CliError::new(
            "--token and --client-id require --coordinator",
        ));
    }

    for (index, id) in config.gpu_ids.iter().enumerate() {
        if *id < 0 {
            return Err(CliError::new(format!(
                "Invalid --gpui argument, GPU ids must be non-negative (got {id})"
            )));
        }
        if config.gpu_ids[..index].contains(id) {
            return Err(CliError::new(format!(
                "Invalid --gpui argument, duplicate GPU id {id}"
            )));
        }
    }

    if !config.grid_size.is_empty() && config.grid_size.len() != config.gpu_ids.len() * 2 {
        return Err(CliError::new(
            "Invalid --gpux argument, must specify exactly 2 integers per GPU id",
        ));
    }

    if config.gpu && config.thread_specified && config.threads > 0 {
        return Err(CliError::new(
            "Invalid arguments, CPU and GPU, both can't be used together right now",
        ));
    }

    Ok(())
}
