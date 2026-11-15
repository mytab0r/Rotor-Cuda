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
#[cfg(feature = "gpu")]
use crate::field::Fe;
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

/// Baby-step table shared by the CPU and GPU giant-step drivers.
struct BabyTable {
    baby_size: u64,
    map: HashMap<u64, u32>,
    manifest: TableManifest,
}

/// Build the baby table for `[k_start, k_end]` and return the range span.
fn build_baby(k_start: &Scalar, k_end: &Scalar, m: u64) -> Result<(u128, BabyTable), String> {
    let span_scalar = k_end.sub(k_start);
    let span =
        scalar_to_u128(&span_scalar).ok_or_else(|| "range too large for CPU-BSGS".to_string())?;

    // 1. Baby-step count.
    let mut baby_size = m;
    if baby_size == 0 {
        let root = span.saturating_add(1).isqrt();
        if root >= u128::from(u32::MAX) {
            return Err("baby table would exceed 32-bit indices".to_string());
        }
        baby_size = root as u64 + 1;
    }
    if baby_size > u64::from(u32::MAX) {
        return Err("baby table would exceed 32-bit indices".to_string());
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

    Ok((
        span,
        BabyTable {
            baby_size,
            map,
            manifest,
        },
    ))
}

/// Solve `target = k*G` for `k` in `[k_start, k_end]` inclusive.
///
/// `m` is the baby-step count; `0` selects `isqrt(span + 1) + 1`. Deterministic
/// and single-threaded. On failure `found` is `false` and `key` is zero.
pub fn solve(target: &Affine, k_start: &Scalar, k_end: &Scalar, m: u64) -> BsgsResult {
    // 1-3. Span, baby table, and its versioned identity.
    let (span, baby) = match build_baby(k_start, k_end, m) {
        Ok(value) => value,
        Err(message) => return failure(&message),
    };
    let baby_size = baby.baby_size;
    let manifest = baby.manifest;
    let map = baby.map;

    // 4. Giant walk. Q = target - k_start*G.
    let generator = secp::g();
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

/// GPU giant-step walk batch size (mirrors `BsgsCpu.cpp::solve_gpu`).
#[cfg(feature = "gpu")]
const GPU_N_STEPS: u32 = 1024;

/// Solve `target = k*G` for `k` in `[k_start, k_end]` using the CUDA backend.
///
/// Mirrors `BsgsCpu.cpp::solve_gpu`: the baby table is shared with the CPU
/// solver, the giant walks are planned on the host, and every hit is re-checked
/// against the curve. Any launcher error is reported through `BsgsResult::error`;
/// there is no CPU fallback.
#[cfg(feature = "gpu")]
pub fn solve_gpu(
    target: &Affine,
    k_start: &Scalar,
    k_end: &Scalar,
    m: u64,
    device: i32,
) -> BsgsResult {
    let (span, baby) = match build_baby(k_start, k_end, m) {
        Ok(value) => value,
        Err(message) => return failure(&message),
    };
    let baby_size = baby.baby_size;
    let manifest = baby.manifest;

    // Q = target - k_start*G, exactly as in `solve`.
    let s = secp::mul_g(&Scalar::from_u64(baby_size)); // S = m*G
    let start_point = secp::mul(&secp::g(), k_start);
    let q = match start_point {
        Some(point) => Jacobian::from_affine(target).add_affine(&point.neg()),
        None => Jacobian::from_affine(target),
    };

    // CPU solve visits indices 0..span/m+1; the final extra index cannot
    // produce an in-range kp, so the GPU emits exactly [0, span/m].
    let giant_points = match span
        .checked_div(u128::from(baby_size))
        .and_then(|value| value.checked_add(1))
    {
        Some(value) => value,
        None => return failure("range too large for GPU-BSGS"),
    };
    if giant_points > u128::from(u32::MAX) {
        return failure("range too large for GPU-BSGS");
    }
    let n_walks = giant_points.div_ceil(u128::from(GPU_N_STEPS));
    let emitted = n_walks * u128::from(GPU_N_STEPS);
    if n_walks == 0 || emitted > u128::from(u32::MAX) {
        return failure("range too large for GPU-BSGS");
    }
    let n_walks = n_walks as u32;
    let emitted = emitted as u32;

    let mut result = BsgsResult {
        found: false,
        key: Scalar::ZERO,
        giant_steps: 0,
        baby_size,
        manifest,
        error: None,
    };

    // A walk start at infinity has no canonical X; resolve it on the host.
    let starts = match plan_walks(&q, baby_size, n_walks, span) {
        Ok(starts) => starts,
        Err((_walk, kp)) => {
            let key = add_u128(k_start, u128::from(kp));
            if !key_matches(&key, target) {
                return failure("GPU-BSGS internal: boundary point failed verification");
            }
            result.found = true;
            result.key = key;
            return result;
        }
    };

    let stride = limbs8(&s);
    let hits = match crate::gpu::launch_giant_dp(
        &starts,
        &stride,
        n_walks,
        GPU_N_STEPS,
        8,
        0,
        emitted,
        device,
    ) {
        Ok(hits) => hits,
        Err(message) => {
            result.error = Some(message);
            return result;
        }
    };
    if hits.total > u64::from(emitted) {
        result.error = Some("GPU-BSGS output truncated; reduce range or use CPU-BSGS".to_string());
        return result;
    }
    result.giant_steps = hits.total;

    for index in 0..hits.walk.len() {
        let i = u64::from(hits.walk[index]) * u64::from(GPU_N_STEPS) + u64::from(hits.step[index]);
        if u128::from(i) >= giant_points {
            continue;
        }

        // GPU limbs are canonical little-endian; rebuild the 32 big-endian
        // bytes the CPU fold expects.
        let x_bytes = x_bytes_from_limbs(&hits.x[index * 4..index * 4 + 4]);
        let Some(&j) = baby.map.get(&fnv1a64(&x_bytes)) else {
            continue;
        };

        let kp = u128::from(i) * u128::from(baby_size) + u128::from(j);
        if kp > span {
            continue;
        }
        let key = add_u128(k_start, kp);
        if key_matches(&key, target) {
            result.found = true;
            result.key = key;
            return result;
        }
    }

    result
}

/// Plan the GPU giant walks: eight limbs (x then y) per walk start.
///
/// Walk `w` starts at `Q - w*1024*m*G`. A start at infinity is returned as
/// `Err((walk, kp))` when its `kp = walk*1024*m` is still in range, so the
/// caller can resolve the exact giant-boundary hit on the host.
#[cfg(feature = "gpu")]
pub fn plan_walks(
    q: &Jacobian,
    baby_size: u64,
    n_walks: u32,
    span: u128,
) -> Result<Vec<u64>, (u32, u64)> {
    let mut starts = Vec::with_capacity(n_walks as usize * 8);
    let chunk = secp::mul_g(&Scalar::from_u64(baby_size.saturating_mul(1024))).neg();
    let mut start = *q;

    for walk in 0..n_walks {
        if start.is_infinity() {
            let kp = u128::from(walk) * 1024 * u128::from(baby_size);
            if kp <= span {
                return Err((walk, kp as u64));
            }
            // Out of range: every index in this walk is rejected by the kp
            // bound anyway; the cleared point mirrors the C++ encoding.
            starts.extend_from_slice(&[0u64; 8]);
        } else {
            let point = start
                .to_affine()
                .expect("non-infinity walk start has an affine form");
            starts.extend_from_slice(&limbs(&point.x));
            starts.extend_from_slice(&limbs(&point.y));
        }
        start = start.add_affine(&chunk);
    }

    Ok(starts)
}

/// A field element as four little-endian limbs (limb 0 is least significant).
#[cfg(feature = "gpu")]
fn limbs(value: &Fe) -> [u64; 4] {
    let be = value.to_bytes_be();
    let mut out = [0u64; 4];
    for (index, limb) in out.iter_mut().enumerate() {
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&be[32 - 8 * (index + 1)..32 - 8 * index]);
        *limb = u64::from_be_bytes(bytes);
    }
    out
}

/// An affine point as eight limbs (x then y), the ABI's start/stride layout.
#[cfg(feature = "gpu")]
fn limbs8(point: &Affine) -> [u64; 8] {
    let mut out = [0u64; 8];
    out[..4].copy_from_slice(&limbs(&point.x));
    out[4..].copy_from_slice(&limbs(&point.y));
    out
}

/// The inverse of [`limbs`]: four little-endian limbs back to 32 big-endian
/// bytes, the encoding the CPU fold hashes.
#[cfg(feature = "gpu")]
fn x_bytes_from_limbs(limbs: &[u64]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (index, limb) in limbs.iter().take(4).enumerate() {
        out[32 - 8 * (index + 1)..32 - 8 * index].copy_from_slice(&limb.to_be_bytes());
    }
    out
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

    let backend = if config.gpu { "GPU-BSGS" } else { "CPU-BSGS" };
    println!("\n  Rotor-Cuda v{}", crate::cli::RELEASE);
    println!("  SEARCH MODE  : BSGS (pubkey -> scalar)");
    println!("  BACKEND      : {backend}");
    println!("  TARGET PUB   : {operand}");
    println!("  RANGE        : {} : {}", hex_trim(&start), hex_trim(&end));

    let started = Instant::now();
    #[cfg(feature = "gpu")]
    let result = if config.gpu {
        solve_gpu(
            &target,
            &start,
            &end,
            0,
            config.gpu_ids.first().copied().unwrap_or(0),
        )
    } else {
        solve(&target, &start, &end, 0)
    };
    #[cfg(not(feature = "gpu"))]
    let result = if config.gpu {
        return Err(
            "GPU support is not compiled into this binary; rebuild with --features gpu".to_string(),
        );
    } else {
        solve(&target, &start, &end, 0)
    };
    println!(
        "  [{backend}] GIANT STEPS: {}   BABY SIZE: {}   ({:.1}s)",
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

#[cfg(all(test, feature = "gpu"))]
mod tests {
    use super::*;

    #[test]
    fn plan_walks_encodes_starts_and_resolves_boundary_on_host() {
        // Q = 2048*G and m = 2, so one chunk is 1024*m = 2048 points.
        let baby_size = 2;
        let q = Jacobian::from_affine(&secp::mul_g(&Scalar::from_u64(2048)));
        let expected_point = secp::mul_g(&Scalar::from_u64(2048));

        let starts = plan_walks(&q, baby_size, 1, 10_000).expect("finite first start");
        assert_eq!(starts.len(), 8);
        assert_eq!(&starts[..4], &limbs(&expected_point.x));
        assert_eq!(&starts[4..], &limbs(&expected_point.y));

        // The second walk starts at infinity with kp = 1024*2 = 2048 <= span.
        assert_eq!(plan_walks(&q, baby_size, 2, 10_000), Err((1, 2048)));

        // Out of range: the boundary hit is rejected and the walk is emitted.
        let out_of_range = plan_walks(&q, baby_size, 2, 2047).expect("boundary out of range");
        assert_eq!(out_of_range.len(), 16);
    }

    #[test]
    fn gpu_limb_encoding_round_trips_to_the_cpu_fold() {
        // The GPU emits X as little-endian limbs; the fold must hash exactly the
        // same 32 big-endian bytes the CPU baby table hashed.
        for j in 1..=8u64 {
            let point = secp::mul_g(&Scalar::from_u64(j));
            let encoded = limbs(&point.x);
            assert_eq!(x_bytes_from_limbs(&encoded), point.x.to_bytes_be());
            assert_eq!(
                fnv1a64(&x_bytes_from_limbs(&encoded)),
                fnv1a64(&point.x.to_bytes_be())
            );
        }
    }
}
