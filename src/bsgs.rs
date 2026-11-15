//! CPU baby-step/giant-step solver: recover the scalar `k` with `k*G = target`
//! for `k` in `[k_start, k_end]`.
//!
//! Port of `Rotor-Cuda/bsgs/BsgsCpu.cpp`. The observable behavior mirrors the
//! C++ implementation: the baby table is keyed by the FNV-1a/64 fold of the
//! 32-byte big-endian X coordinate, the manifest binds the exact table content,
//! and every candidate is re-checked against the curve so a fold collision can
//! never yield a wrong key.
//!
//! Deliberate deviations from C++ (documented in the change design):
//! - The span is read in full instead of from its low 64 bits; a span that does
//!   not fit in `u128` is rejected loudly instead of silently searching garbage.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::time::Instant;

use crate::cli::Config;
use crate::point::{Affine, Jacobian, batch_to_affine};
use crate::scalar::Scalar;
use crate::secp;

/// Bump when the baby-table layout or fold changes so a stale checkpoint that
/// names an older version is rejected instead of silently trusted.
pub const BSGS_TABLE_FORMAT_VERSION: u32 = 1;

/// FNV-1a/64 offset basis.
const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
/// FNV-1a/64 prime.
const FNV_PRIME: u64 = 1_099_511_628_211;
/// Batch size for one shared inversion when normalizing points.
const NORMALIZE_BATCH: usize = 1024;

/// Canonical identity of a built baby-step table.
///
/// A saved checkpoint/resume must carry one of these and is rejected on any
/// field mismatch, so a table from different `m`/range/content is never reused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableManifest {
    pub format_version: u32,
    pub curve: String,
    pub baby_size: u64,
    pub range_id: String,
    pub table_checksum: u64,
}

impl Default for TableManifest {
    fn default() -> Self {
        Self {
            format_version: BSGS_TABLE_FORMAT_VERSION,
            curve: "secp256k1".to_string(),
            baby_size: 0,
            range_id: String::new(),
            table_checksum: 0,
        }
    }
}

impl TableManifest {
    /// `true` only when both manifests name the exact same table.
    pub fn compatible(&self, other: &Self) -> bool {
        self.format_version == other.format_version
            && self.curve == other.curve
            && self.baby_size == other.baby_size
            && self.range_id == other.range_id
            && self.table_checksum == other.table_checksum
    }
}

/// Outcome of a [`solve`] call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BsgsResult {
    pub found: bool,
    /// Recovered scalar; [`Scalar::ZERO`] unless `found`.
    pub key: Scalar,
    /// Giant iterations actually performed (`i + 1`, matching the C++ loop).
    pub giant_steps: u64,
    pub baby_size: u64,
    /// Identity of the table this run built.
    pub manifest: TableManifest,
    /// Non-empty when setup or execution could not run.
    pub error: Option<String>,
}

/// Solve `target = k*G` for `k` in `[k_start, k_end]` inclusive.
///
/// `m` is the baby-step count; `0` selects `isqrt(span + 1) + 1`. Deterministic
/// and single-threaded. On failure `found` is `false` and `key` is zero.
pub fn solve(target: &Affine, k_start: &Scalar, k_end: &Scalar, m: u64) -> BsgsResult {
    let span_scalar = k_end.sub(k_start);
    let span = match scalar_to_u128(&span_scalar) {
        Some(value) => value,
        None => return failure("range too large for CPU-BSGS"),
    };

    // 1. Baby-step count.
    let mut baby_size = m;
    if baby_size == 0 {
        let root = span.saturating_add(1).isqrt();
        if root >= u128::from(u32::MAX) {
            return failure("baby table would exceed 32-bit indices");
        }
        baby_size = root as u64 + 1;
    }
    if baby_size > u64::from(u32::MAX) {
        return failure("baby table would exceed 32-bit indices");
    }
    let baby_size = baby_size.max(1);

    // 2. Baby table: folds of X(j*G) for j in [1, m], first j wins.
    let generator = secp::g();
    let mut map: HashMap<u64, u32> = HashMap::with_capacity(table_capacity(baby_size));
    let mut folds: Vec<u64> = Vec::with_capacity(table_capacity(baby_size));
    build_baby_table(&generator, baby_size, &mut map, &mut folds);

    // 3. Versioned identity of this table.
    let manifest = TableManifest {
        format_version: BSGS_TABLE_FORMAT_VERSION,
        curve: "secp256k1".to_string(),
        baby_size,
        range_id: format!("{}:{}", hex_trim(k_start), hex_trim(k_end)),
        table_checksum: table_checksum(&folds),
    };

    // 4. Giant walk. Q = target - k_start*G.
    let stride = secp::mul_g(&Scalar::from_u64(baby_size)); // S = m*G
    let neg_stride = stride.neg();
    let start_point = secp::mul(&generator, k_start);
    let q = match start_point {
        Some(point) => Jacobian::from_affine(target).add_affine(&point.neg()),
        None => Jacobian::from_affine(target), // k_start == 0
    };

    let giants = match span
        .checked_div(u128::from(baby_size))
        .and_then(|value| value.checked_add(1))
    {
        Some(value) if value < u128::from(u64::MAX) => value,
        _ => return failure("range too large for CPU-BSGS"),
    };

    let mut result = BsgsResult {
        found: false,
        key: Scalar::ZERO,
        giant_steps: 0,
        baby_size,
        manifest,
        error: None,
    };

    let mut giant_steps = 0u64;
    let mut index: u128 = 0;
    let mut current = q;
    'walk: while index <= giants {
        // Collect a walk chunk so normalization costs one inversion per chunk.
        let mut chunk: Vec<Jacobian> = Vec::with_capacity(NORMALIZE_BATCH);
        let mut indices: Vec<u128> = Vec::with_capacity(NORMALIZE_BATCH);
        while chunk.len() < NORMALIZE_BATCH && index <= giants {
            chunk.push(current);
            indices.push(index);
            current = current.add_affine(&neg_stride); // R -= S
            index += 1;
        }

        for (step, affine) in indices.iter().zip(batch_to_affine(&chunk)) {
            giant_steps = (*step as u64) + 1;
            let giant = step.checked_mul(u128::from(baby_size));
            match affine {
                None => {
                    // Q == i*S -> k' = i*m.
                    if let Some(kp) = giant
                        && kp <= span
                    {
                        let key = add_u128(k_start, kp);
                        if key_matches(&key, target) {
                            result.found = true;
                            result.key = key;
                            break 'walk;
                        }
                    }
                }
                Some(point) => {
                    let fold = fnv1a64(&point.x.to_bytes_be());
                    if let Some(&j) = map.get(&fold) {
                        // R ?= j*G -> k' = i*m + j.
                        if let Some(kp) = giant.and_then(|base| base.checked_add(u128::from(j)))
                            && kp <= span
                        {
                            let key = add_u128(k_start, kp);
                            if key_matches(&key, target) {
                                result.found = true;
                                result.key = key;
                                break 'walk;
                            }
                            // else fold collision, keep walking
                        }
                    }
                }
            }
        }
    }

    result.giant_steps = giant_steps;
    result
}

/// CLI entry point for `-m bsgs`, mirroring `Main.cpp:435-509`.
///
/// Returns the process exit code: `0` found, `1` not found. Setup failures are
/// returned as `Err` so the caller prints `Error: <msg>` and exits non-zero.
pub fn run_cli(config: &Config) -> Result<i32, String> {
    let operand = match config.operands.as_slice() {
        [operand] => operand,
        _ => return Err("BSGS needs exactly one target public key (hex)".to_string()),
    };

    let mut compressed = true;
    let target = secp::parse_pubkey_hex(operand, &mut compressed)?;

    let range = config
        .range
        .ok_or_else(|| "BSGS needs --range START:END".to_string())?;
    let start = Scalar::from_bytes_be(&range.start.0)
        .ok_or_else(|| "--range must be below the curve order".to_string())?;
    let end = Scalar::from_bytes_be(&range.end.0)
        .ok_or_else(|| "--range must be below the curve order".to_string())?;

    println!("\n  Rotor-Cuda v{}", crate::cli::RELEASE);
    println!("  SEARCH MODE  : BSGS (pubkey -> scalar)");
    println!("  BACKEND      : CPU-BSGS");
    println!("  TARGET PUB   : {operand}");
    println!("  RANGE        : {} : {}", hex_trim(&start), hex_trim(&end));

    let started = Instant::now();
    let result = solve(&target, &start, &end, 0);
    println!(
        "  [CPU-BSGS] GIANT STEPS: {}   BABY SIZE: {}   ({:.1}s)",
        result.giant_steps,
        result.baby_size,
        started.elapsed().as_secs_f64()
    );

    if let Some(error) = result.error {
        return Err(error);
    }

    if !result.found {
        println!("\n  Not found in range.\n");
        return Ok(1);
    }

    let key = hex_trim(&result.key);
    println!("\n  =====> KEY FOUND: {key}");

    let output = &config.output_file;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(output)
        .map_err(|err| format!("cannot write {output}: {err}"))?;
    writeln!(file, "{operand} {key}").map_err(|err| format!("cannot write {output}: {err}"))?;
    println!("  (written to {output})\n");

    Ok(0)
}

fn failure(message: &str) -> BsgsResult {
    BsgsResult {
        found: false,
        key: Scalar::ZERO,
        giant_steps: 0,
        baby_size: 0,
        manifest: TableManifest::default(),
        error: Some(message.to_string()),
    }
}

/// Build `x(j*G)` folds for `j` in `[1, m]` in chunks of one inversion each.
fn build_baby_table(generator: &Affine, m: u64, map: &mut HashMap<u64, u32>, folds: &mut Vec<u64>) {
    let mut current = Jacobian::from_affine(generator);
    let mut chunk: Vec<Jacobian> = Vec::with_capacity(NORMALIZE_BATCH);
    let mut first_j: u64 = 1;
    let mut j: u64 = 1;

    loop {
        chunk.push(current);
        if chunk.len() == NORMALIZE_BATCH || j == m {
            for (offset, affine) in batch_to_affine(&chunk).into_iter().enumerate() {
                let point = affine.expect("baby step j*G is finite for 1 <= j <= m");
                let fold = fnv1a64(&point.x.to_bytes_be());
                // First j wins, mirroring `unordered_map::emplace`.
                map.entry(fold).or_insert((first_j + offset as u64) as u32);
                folds.push(fold);
            }
            chunk.clear();
            first_j = j + 1;
        }
        if j == m {
            return;
        }
        current = current.add_affine(generator);
        j += 1;
    }
}

/// FNV-1a/64 over the little-endian bytes of every fold, in table order.
fn table_checksum(folds: &[u64]) -> u64 {
    let mut hash = FNV_OFFSET;
    for fold in folds {
        for byte in fold.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash
}

/// FNV-1a/64, the same fold used for the `X` coordinate bytes.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// `k_start + value` in GF(n); `value` is split into two 64-bit additions.
fn add_u128(base: &Scalar, value: u128) -> Scalar {
    base.add_u64(value as u64).add_u64((value >> 64) as u64)
}

fn key_matches(key: &Scalar, target: &Affine) -> bool {
    // `mul_g` cannot represent infinity; a zero key never matches an affine target.
    !key.is_zero() && secp::mul_g(key) == *target
}

/// Scalar as `u128`, or `None` when any bit at 128 or above is set.
fn scalar_to_u128(value: &Scalar) -> Option<u128> {
    if (128..256).any(|index| value.bit(index)) {
        return None;
    }
    let bytes = value.to_bytes_be();
    let mut low = [0u8; 16];
    low.copy_from_slice(&bytes[16..]);
    Some(u128::from_be_bytes(low))
}

/// Uppercase hex with no leading zeros; zero prints as `"0"`.
fn hex_trim(value: &Scalar) -> String {
    let hex = value.to_hex();
    let trimmed = hex.trim_start_matches('0');
    let trimmed = if trimmed.is_empty() { "0" } else { trimmed };
    trimmed.to_ascii_uppercase()
}

/// Clamp a requested table size to something `usize` can index.
fn table_capacity(m: u64) -> usize {
    usize::try_from(m).unwrap_or(usize::MAX)
}
