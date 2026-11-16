//! Command-line parsing that mirrors `Rotor-Cuda/CmdParse.cpp` and the option
//! handling in `Rotor-Cuda/Main.cpp`.

use std::fmt;

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
-i, --in FILE                                : Read rmd160 hashes or xpoints from FILE, should be in binary format with  .bin
-o, --out FILE                            : Write keys to FILE, default: Found.txt
-m, --mode MODE                   : Specify search mode where MODE is
                                                      Address  : for single address
                                                      Addresses: for multiple hashes/addresses
                                                      Xpoint   : for single xpoint
                                                      Xpoints : for multiple xpoints
                                                      BSGS     : recover scalar from a public key in --range (CPU-BSGS; -g selects GPU-BSGS)
--coin BTC/ETH                      : Specify Coin name to search
                                                      BTC: available mode :-
                                                      ADDRESS, ADDRESSES, XPOINT, XPOINTS
                                                      ETH: available mode :-
                                                      ADDRESS, ADDRESSES
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
--client-id ID                     : Coordinator client id, default is hostname + pid"#,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Coin {
    #[default]
    Btc,
    Eth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Address,
    XPoint,
    Addresses,
    XPoints,
    Bsgs,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub help: bool,
    pub check: bool,
    pub list: bool,
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
    pub output_file: String,
    pub mode: Option<SearchMode>,
    pub coin: Coin,
    pub range: Option<Range>,
    pub rkey: u64,
    pub next: i32,
    pub zet: i32,
    pub display: i32,
    pub coordinator: Option<String>,
    pub token: Option<String>,
    pub client_id: Option<String>,
    pub operands: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            help: false,
            check: false,
            list: false,
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
            output_file: "Found.txt".to_owned(),
            mode: None,
            coin: Coin::Btc,
            range: None,
            rkey: 0,
            next: 0,
            zet: 0,
            display: 1,
            coordinator: None,
            token: None,
            client_id: None,
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
    Out,
    Mode,
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
    ("-o", Opt::Out, true),
    ("--out", Opt::Out, true),
    ("-m", Opt::Mode, true),
    ("--mode", Opt::Mode, true),
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
        Opt::Help | Opt::Check | Opt::List | Opt::Version | Opt::CheckUpdate | Opt::Update
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
            Token::Value(opt, value) => apply_value(&mut config, opt, value)?,
        }
    }

    validate(&mut config)?;
    Ok(config)
}

fn apply_flag(config: &mut Config, opt: Opt) {
    match opt {
        Opt::Help => config.help = true,
        Opt::Check => config.check = true,
        Opt::List => config.list = true,
        Opt::Uncomp => config.comp_mode = CompMode::Uncompressed,
        Opt::Both => config.comp_mode = CompMode::Both,
        Opt::Gpu => config.gpu = true,
        Opt::Version => config.version = true,
        Opt::CheckUpdate => config.check_update = true,
        Opt::Update => config.update = true,
        Opt::GpuIds
        | Opt::GpuGrid
        | Opt::Thread
        | Opt::In
        | Opt::Out
        | Opt::Mode
        | Opt::Coin
        | Opt::Range
        | Opt::Rkey
        | Opt::Next
        | Opt::Zet
        | Opt::Display
        | Opt::Coordinator
        | Opt::Token
        | Opt::ClientId => {
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
        Opt::Out => config.output_file = value,
        Opt::Mode => config.mode = Some(parse_mode(&value)?),
        Opt::Coin => config.coin = parse_coin(&value)?,
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
        Opt::Help
        | Opt::Check
        | Opt::List
        | Opt::Uncomp
        | Opt::Both
        | Opt::Gpu
        | Opt::Version
        | Opt::CheckUpdate
        | Opt::Update => {
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

fn parse_coin(value: &str) -> Result<Coin, CliError> {
    let lowered = value.to_ascii_lowercase();
    match lowered.as_str() {
        "btc" => Ok(Coin::Btc),
        "eth" => Ok(Coin::Eth),
        _ => Err(CliError::new(format!("Invalid coin name: {lowered}"))),
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

fn validate(config: &mut Config) -> Result<(), CliError> {
    if config.coin == Coin::Eth
        && matches!(config.mode, Some(SearchMode::XPoint | SearchMode::XPoints))
    {
        return Err(CliError::new(
            "Wrong search or compress mode provided for ETH coin type",
        ));
    }
    if config.coin == Coin::Eth {
        config.comp_mode = CompMode::Uncompressed;
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
        if config.gpu {
            return Err(CliError::new(
                "GPU mode is not supported with --coordinator",
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
