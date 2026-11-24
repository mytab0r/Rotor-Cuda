//! Desktop BIP39/BIP32 driver and a bounded weak-entropy audit.
//!
//! The pure BIP39/BIP32 helpers live in `rotor-core` and are re-exported here,
//! so `rotor::mnemonic::*` keeps its public paths. This module keeps only the
//! desktop driver: the audit loop, target loading, progress output and the
//! `--mnemonic-*` commands.
//!
//! The audit mode checks a *tiny, user-specified* entropy space only. Each
//! candidate costs a PBKDF2 derivation (milliseconds), so this is not a way to
//! reach the puzzle range; use it only on data you are authorized to audit.

use std::fmt::Write as _;
use std::io::{self, BufReader};
use std::path::Path;
use std::time::{Duration, Instant};

use bip39::Mnemonic;

pub use rotor_core::mnemonic::{
    DEFAULT_PATH, Derived, ENTROPY_BITS, ExtendedKey, HARDENED, MAX_INDEX, ckd_priv, derive,
    derive_counter, derive_path, entropy_for_counter, hmac_sha512, master_from_seed, parse_path,
    phrase_from_entropy,
};
use rotor_core::mnemonic::{derive_master_and_key, seed_id};

use crate::chain;
use crate::cli::{Config, SearchMode};
use crate::filter::TargetSet;
use crate::hashes;
use crate::targets_text;

/// Progress lines are emitted at most this often during an audit.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);

/// Prints the phrase/key/address for `--mnemonic-derive`.
pub fn run_derive(phrase: &str, passphrase: &str, path: &str) -> Result<(), String> {
    let mnemonic = Mnemonic::parse(phrase).map_err(|err| format!("invalid BIP39 phrase: {err}"))?;
    let (master, derived) = derive_master_and_key(&mnemonic, passphrase, path)?;

    println!("  phrase  : {mnemonic}");
    println!("  path    : {path}");
    println!("  seed id : {}", seed_id(&master));
    println!("  key     : {}", derived.key.to_hex());
    println!("  pubkey  : {}", hex_lower(&derived.pubkey));
    println!("  address : {}", derived.address);
    Ok(())
}

/// Prints the BIP39 phrase for `--mnemonic-from-entropy HEX`.
pub fn run_from_entropy(hex: &str) -> Result<(), String> {
    let entropy = crate::engine::parse_hex_bytes(hex, hex.len() / 2)
        .ok_or_else(|| format!("invalid entropy hex: {hex}"))?;
    println!("{}", phrase_from_entropy(&entropy)?);
    Ok(())
}

/// Runs the bounded `--mnemonic-audit` sweep.
pub fn run_audit(config: &Config) -> Result<(), String> {
    let bits = config
        .entropy_bits
        .ok_or_else(|| "--mnemonic-audit requires --entropy-bits N".to_owned())?;
    let range = config
        .counter
        .ok_or_else(|| "--mnemonic-audit requires --counter START:END".to_owned())?;
    if !ENTROPY_BITS.contains(&bits) {
        return Err(format!(
            "--entropy-bits must be one of 128, 160, 192, 224, 256 (got {bits})"
        ));
    }
    if range.end <= range.start {
        return Err("--counter END must be greater than START".to_owned());
    }
    if range.count() > crate::cli::MAX_AUDIT_CANDIDATES {
        return Err(format!(
            "--counter range is {} entries, at most {} are allowed",
            range.count(),
            crate::cli::MAX_AUDIT_CANDIDATES
        ));
    }
    let path = config.mnemonic_path.as_deref().unwrap_or(DEFAULT_PATH);
    let x_targets = config.mode == Some(SearchMode::XPoints);
    let targets = audit_targets(config, x_targets)?;
    let total = range.count();

    eprintln!("  WARNING: --mnemonic-audit checks only a tiny, user-specified entropy space.");
    eprintln!("  Each candidate costs a PBKDF2 derivation (milliseconds). This cannot reach");
    eprintln!("  the puzzle range and must be used only on data you are authorized to audit.");
    eprintln!();

    println!("  targets    : {} hash160 record(s)", targets.len());
    println!("  entropy    : {bits} bits");
    println!("  path       : {path}");
    println!(
        "  passphrase : {}",
        if config.mnemonic_passphrase.is_empty() {
            "(empty)"
        } else {
            "(set)"
        }
    );
    println!(
        "  counters   : {}..{} ({total} candidates, END exclusive)",
        range.start, range.end
    );
    println!();

    let started = Instant::now();
    let mut last_report = started;
    let mut processed = 0u64;
    let mut matches = 0u64;

    for counter in range.start..range.end {
        let (phrase, derived) = derive_counter(counter, bits, &config.mnemonic_passphrase, path)?;
        let hash = hashes::hash160(&derived.pubkey);
        let record: &[u8] = if x_targets {
            &derived.pubkey[1..]
        } else {
            &hash
        };
        processed += 1;

        if targets.contains(record) {
            matches += 1;
            println!("  MATCH");
            println!("    counter : {counter}");
            println!("    phrase  : {phrase}");
            println!("    path    : {path}");
            println!("    key     : {}", derived.key.to_hex());
            println!("    address : {}", derived.address);
            if x_targets {
                println!("    xpoint  : {}", hex_lower(&derived.pubkey[1..]));
            } else {
                println!("    hash160 : {}", hex_lower(&hash));
            }
            println!();
        }

        if processed == total || last_report.elapsed() >= PROGRESS_INTERVAL {
            print_progress(processed, total, started.elapsed(), matches);
            last_report = Instant::now();
        }
    }

    let elapsed = started.elapsed();
    let rate = processed as f64 / elapsed.as_secs_f64().max(1e-9);
    println!(
        "  audit finished: {processed} candidate(s) in {:.2?}, {rate:.1} keys/s, {matches} match(es)",
        elapsed
    );
    Ok(())
}

/// Mnemonic targets are always Bitcoin P2PKH, as validated by the CLI.
fn bitcoin() -> &'static chain::ChainDescriptor {
    chain::by_id("bitcoin").expect("bitcoin descriptor")
}

fn audit_targets(config: &Config, x_targets: bool) -> Result<TargetSet, String> {
    let mode = if x_targets {
        SearchMode::XPoints
    } else {
        SearchMode::Addresses
    };
    let record_len = if x_targets { 32 } else { 20 };
    if let Some(source) = config.targets_text.as_deref() {
        if source == "-" {
            let stdin = io::stdin();
            return targets_text::load(stdin.lock(), bitcoin(), mode);
        }
        let file =
            std::fs::File::open(source).map_err(|err| format!("failed to read {source}: {err}"))?;
        return targets_text::load(BufReader::new(file), bitcoin(), mode);
    }
    let path = config.input_file.as_deref().ok_or_else(|| {
        "--mnemonic-audit requires a target list (--targets-text FILE or -i FILE)".to_owned()
    })?;
    TargetSet::load(Path::new(path), record_len)
}

fn print_progress(processed: u64, total: u64, elapsed: Duration, matches: u64) {
    let rate = processed as f64 / elapsed.as_secs_f64().max(1e-9);
    let remaining = total.saturating_sub(processed) as f64;
    let eta = if rate > 0.0 {
        remaining / rate
    } else {
        f64::INFINITY
    };
    println!(
        "  progress: {processed}/{total} ({:.3}%)  {rate:.1} keys/s  ETA {}  matches {matches}",
        processed as f64 * 100.0 / total as f64,
        format_duration(eta)
    );
}

fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() {
        return "unknown".to_owned();
    }
    if seconds < 10.0 {
        return format!("{seconds:.1}s");
    }
    let rounded = seconds.round() as u64;
    let hours = rounded / 3600;
    let minutes = rounded % 3600 / 60;
    let secs = rounded % 60;
    if hours > 0 {
        format!("{hours}h {minutes:02}m {secs:02}s")
    } else {
        format!("{minutes}m {secs:02}s")
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}
