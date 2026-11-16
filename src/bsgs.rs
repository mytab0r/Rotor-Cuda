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

use std::cell::Cell;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::bsgs_workfile::{load, save_parts, validate};
use crate::cli::{Config, U256};
use crate::coordinator::client::CoordinatorClient;
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
    /// Absolute giant index + 1 of the last step examined (resumes count from
    /// the start index, not from zero).
    pub giant_steps: u64,
    pub baby_size: u64,
    /// Identity of the table this run built.
    pub manifest: TableManifest,
    /// Non-empty when setup or execution could not run.
    pub error: Option<String>,
}

/// Baby-step table shared by the CPU and GPU giant-step drivers.
///
/// The map and manifest are exposed so a coordinator client can store the
/// table identity and resume the giant walk without rebuilding it.
#[derive(Clone, Debug)]
pub struct BsgsTable {
    /// Inclusive range span (`k_end - k_start`) as a `u128`.
    pub span: u128,
    pub baby_size: u64,
    pub map: HashMap<u64, u32>,
    pub manifest: TableManifest,
    /// FNV-1a/64 folds of `X(j*G)` in table order (`j = 1..=baby_size`), so a
    /// work file can rebuild `map` and re-verify the checksum exactly.
    pub folds: Vec<u64>,
}

/// Build the baby table for `[k_start, k_end]`.
pub fn build_table(k_start: &Scalar, k_end: &Scalar, m: u64) -> Result<BsgsTable, String> {
    let span_scalar = k_end.sub(k_start);
    let span =
        scalar_to_u128(&span_scalar).ok_or_else(|| "range too large for CPU-BSGS".to_string())?;

    // 1. Baby-step count.
    let baby_size = baby_size_for(span, m)?;

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
        range_id: range_id(k_start, k_end),
        table_checksum: table_checksum(&folds),
    };

    Ok(BsgsTable {
        span,
        baby_size,
        map,
        manifest,
        folds,
    })
}

/// Solve `target = k*G` for `k` in `[k_start, k_end]` inclusive.
///
/// `m` is the baby-step count; `0` selects `isqrt(span + 1) + 1`. Deterministic
/// and single-threaded. On failure `found` is `false` and `key` is zero.
pub fn solve(target: &Affine, k_start: &Scalar, k_end: &Scalar, m: u64) -> BsgsResult {
    let table = match build_table(k_start, k_end, m) {
        Ok(table) => table,
        Err(message) => return failure(&message),
    };
    solve_with_table(target, k_start, k_end, &table, 0, &mut |_, _| true)
}

/// Walk the giant steps of an already built table, starting at `start_index`.
///
/// `start_index` is the first giant index still to process; values above the
/// last index are clamped. After every normalization chunk `progress` receives
/// the table manifest and the next unprocessed index; returning `false` stops
/// the walk (used to honor a lost coordinator lease). Ctrl-C also stops after
/// one final `progress` call. `giant_steps` reports the absolute index + 1.
pub fn solve_with_table(
    target: &Affine,
    k_start: &Scalar,
    _k_end: &Scalar,
    table: &BsgsTable,
    start_index: u128,
    progress: &mut dyn FnMut(&TableManifest, u128) -> bool,
) -> BsgsResult {
    let span = table.span;
    let baby_size = table.baby_size;
    let manifest = table.manifest.clone();

    let giants = match span
        .checked_div(u128::from(baby_size))
        .and_then(|value| value.checked_add(1))
    {
        Some(value) if value < u128::from(u64::MAX) => value,
        _ => return failure_with_manifest("range too large for CPU-BSGS", manifest),
    };
    let mut index = start_index.min(giants);

    // Giant walk. Q = target - (k_start + start_index*baby_size)*G.
    let generator = secp::g();
    let stride = secp::mul_g(&Scalar::from_u64(baby_size)); // S = m*G
    let neg_stride = stride.neg();
    let offset = match index.checked_mul(u128::from(baby_size)) {
        Some(value) => add_u128(k_start, value),
        None => return failure_with_manifest("range too large for CPU-BSGS", manifest),
    };
    let q = if offset.is_zero() {
        Jacobian::from_affine(target)
    } else {
        let start_point = secp::mul(&generator, &offset).expect("non-zero offset is finite");
        Jacobian::from_affine(target).add_affine(&start_point.neg())
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
                    if let Some(&j) = table.map.get(&fold) {
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

        // Report the next unprocessed index; false (lease lost) or Ctrl-C
        // stops the walk. The final call doubles as the STOP checkpoint.
        let keep_going = progress(&table.manifest, index);
        if !keep_going || crate::engine::stop_requested() {
            break;
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
    let BsgsTable {
        span,
        baby_size,
        map,
        manifest,
        folds: _,
    } = match build_table(k_start, k_end, m) {
        Ok(table) => table,
        Err(message) => return failure(&message),
    };

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
        let Some(&j) = map.get(&fnv1a64(&x_bytes)) else {
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

    let work_path = config.bsgs_work.as_deref().map(Path::new);
    if work_path.is_none() && config.bsgs_work_reset {
        return Err("--bsgs-work-reset requires --bsgs-work FILE".to_string());
    }
    if work_path.is_some() && config.gpu {
        return Err(
            "BSGS work files are not supported with GPU-BSGS; drop -g to resume a CPU-BSGS work file"
                .to_string(),
        );
    }

    let backend = if config.coordinator.is_some() {
        "COORD-BSGS"
    } else if config.gpu {
        "GPU-BSGS"
    } else {
        "CPU-BSGS"
    };
    println!("\n  Rotor-Cuda v{}", crate::cli::RELEASE);
    println!("  SEARCH MODE  : BSGS (pubkey -> scalar)");
    println!("  BACKEND      : {backend}");
    println!("  TARGET PUB   : {operand}");
    println!("  RANGE        : {} : {}", hex_trim(&start), hex_trim(&end));

    let started = Instant::now();
    let (result, remote, save_error) = if config.coordinator.is_some() {
        let (result, job_id, client, work_error) =
            run_coordinator_search(config, &target, &start, &end, work_path)?;
        (result, Some((client, job_id)), work_error)
    } else {
        #[cfg(feature = "gpu")]
        {
            if config.gpu {
                (
                    solve_gpu(
                        &target,
                        &start,
                        &end,
                        0,
                        config.gpu_ids.first().copied().unwrap_or(0),
                    ),
                    None,
                    None,
                )
            } else {
                let (result, work_error) =
                    run_cpu_search(&target, &start, &end, work_path, config.bsgs_work_reset)?;
                (result, None, work_error)
            }
        }
        #[cfg(not(feature = "gpu"))]
        {
            if config.gpu {
                return Err(
                    "GPU support is not compiled into this binary; rebuild with --features gpu"
                        .to_string(),
                );
            }
            let (result, work_error) =
                run_cpu_search(&target, &start, &end, work_path, config.bsgs_work_reset)?;
            (result, None, work_error)
        }
    };
    println!(
        "  [{backend}] GIANT STEPS: {}   BABY SIZE: {}   ({:.1}s)",
        result.giant_steps,
        result.baby_size,
        started.elapsed().as_secs_f64()
    );

    // A failed work-file save must never look like a successful run.
    if let Some(err) = save_error {
        return Err(err);
    }

    if let Some(error) = result.error {
        return Err(error);
    }

    if !result.found {
        println!("\n  Not found in range.\n");
        return Ok(1);
    }

    let key = hex_trim(&result.key);
    if let Some((client, job_id)) = &remote
        && let Err(err) = client.submit_result(job_id, &result.key.to_hex())
    {
        eprintln!("  Coordinator: cannot submit the found key: {err}");
    }
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

/// CPU giant walk with optional work-file load/save.
///
/// On a matching work file the stored table is reused and the walk starts at
/// its `giant_index`; otherwise the table is built and (when a path is given)
/// written from index 0. Returns the result plus any save error, which the
/// caller turns into a non-zero exit.
fn run_cpu_search(
    target: &Affine,
    start: &Scalar,
    end: &Scalar,
    work_path: Option<&Path>,
    reset: bool,
) -> Result<(BsgsResult, Option<String>), String> {
    let (table, start_index, resumed) = match work_path {
        Some(path) if !reset && path.exists() => {
            let work = load(path).map_err(|err| {
                format!(
                    "cannot resume from BSGS work file '{}': {err}; pass --bsgs-work-reset to overwrite it or choose another --bsgs-work path",
                    path.display()
                )
            })?;
            validate(&work, start, end, target, 0).map_err(|err| {
                format!(
                    "BSGS work file '{}' does not match this run: {err}; pass --bsgs-work-reset to overwrite it or choose another --bsgs-work path",
                    path.display()
                )
            })?;
            (work.table, u128::from(work.giant_index), true)
        }
        _ => (build_table(start, end, 0)?, 0, false),
    };

    let mut saver =
        work_path.map(|path| WorkSaver::new(path, &table, start, end, target, start_index));
    if let Some(saver) = &mut saver
        && !resumed
    {
        // Fresh run or explicit reset: replace any stale file immediately.
        saver.save_now(start_index)?;
    }

    let mut progress = |_manifest: &TableManifest, index: u128| -> bool {
        if let Some(saver) = saver.as_mut() {
            saver.note(index);
        }
        true
    };
    let result = solve_with_table(target, start, end, &table, start_index, &mut progress);

    // On a hit the progress callback never ran for the found chunk; re-save the
    // found giant index so a restarted run re-checks it instead of skipping it.
    let final_index = if result.found {
        u128::from(result.giant_steps.saturating_sub(1))
    } else {
        saver.as_ref().map_or(0, WorkSaver::pending_index)
    };
    let mut save_error = None;
    if let Some(saver) = &mut saver {
        saver.finish(final_index);
        save_error = saver.take_error();
    }

    Ok((result, save_error))
}

/// How often an advancing giant walk rewrites the work file.
const WORKFILE_SAVE_INTERVAL: Duration = Duration::from_secs(30);

/// Throttled work-file writer shared by the CPU and coordinator paths.
///
/// The table is borrowed, so a save never clones the fold/map state.
struct WorkSaver<'a> {
    path: &'a Path,
    table: &'a BsgsTable,
    k_start: Scalar,
    k_end: Scalar,
    target: Affine,
    last_saved_at: Instant,
    last_saved_index: u128,
    pending: u128,
    error: Option<String>,
}

impl<'a> WorkSaver<'a> {
    fn new(
        path: &'a Path,
        table: &'a BsgsTable,
        k_start: &Scalar,
        k_end: &Scalar,
        target: &Affine,
        index: u128,
    ) -> Self {
        Self {
            path,
            table,
            k_start: *k_start,
            k_end: *k_end,
            target: *target,
            last_saved_at: Instant::now(),
            last_saved_index: index,
            pending: index,
            error: None,
        }
    }

    fn pending_index(&self) -> u128 {
        self.pending
    }

    /// Progress hook: rewrite at most once per 30 s, only when the giant index
    /// advanced. Save failures are recorded and reported by the caller.
    fn note(&mut self, index: u128) {
        self.pending = index;
        if index > self.last_saved_index && self.last_saved_at.elapsed() >= WORKFILE_SAVE_INTERVAL {
            self.try_save();
        }
    }

    /// Immediate write; errors propagate so a fresh/reset run fails loudly.
    fn save_now(&mut self, index: u128) -> Result<(), String> {
        self.pending = index;
        self.write(index)
    }

    /// Write once when the walk stops (found, exhausted or interrupted).
    fn finish(&mut self, index: u128) {
        if index > self.pending {
            self.pending = index;
        }
        self.try_save();
    }

    fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }

    fn try_save(&mut self) {
        if self.error.is_some() {
            return;
        }
        if let Err(err) = self.write(self.pending) {
            self.error = Some(err);
        }
    }

    fn write(&mut self, index: u128) -> Result<(), String> {
        let giant_index = u64::try_from(index).unwrap_or(u64::MAX);
        save_parts(
            self.path,
            self.table,
            &self.k_start,
            &self.k_end,
            &self.target,
            giant_index,
        )
        .map_err(|err| {
            format!(
                "cannot save BSGS work file '{}': {err}",
                self.path.display()
            )
        })?;
        self.last_saved_at = Instant::now();
        self.last_saved_index = index;
        Ok(())
    }
}

/// Coordinator-backed BSGS: find the matching job, build the table once,
/// resume from the server's giant index when the manifest is compatible, and
/// post the resume point every few seconds.
fn run_coordinator_search(
    config: &Config,
    target: &Affine,
    start: &Scalar,
    end: &Scalar,
    work_path: Option<&Path>,
) -> Result<(BsgsResult, String, CoordinatorClient, Option<String>), String> {
    let url = config
        .coordinator
        .as_deref()
        .ok_or_else(|| "coordinator mode requires --coordinator URL".to_string())?;
    let token = config
        .token
        .clone()
        .or_else(|| {
            std::env::var("ROTOR_COORD_TOKEN")
                .ok()
                .filter(|t| !t.is_empty())
        })
        .ok_or_else(|| "coordinator mode requires --token or ROTOR_COORD_TOKEN".to_string())?;
    let client_id = config
        .client_id
        .clone()
        .unwrap_or_else(crate::engine::default_client_id);
    let client = CoordinatorClient::new(url, &token, &client_id);

    let range = config
        .range
        .ok_or_else(|| "BSGS needs --range START:END".to_string())?;
    let jobs = client.jobs()?;
    let job = jobs
        .iter()
        .find(|job| {
            job.mode == "bsgs"
                && U256::from_hex(&job.start).ok() == Some(range.start)
                && U256::from_hex(&job.end).ok() == Some(range.end)
                && job.target.as_deref().is_some_and(|text| {
                    let mut compressed = true;
                    secp::parse_pubkey_hex(text, &mut compressed)
                        .is_ok_and(|point| point == *target)
                })
        })
        .ok_or_else(|| {
            "no matching coordinator job for this target/range; create it via the API or dashboard"
                .to_string()
        })?;

    let table = build_table(start, end, 0)?;
    let giants = table
        .span
        .checked_div(u128::from(table.baby_size))
        .and_then(|value| value.checked_add(1))
        .unwrap_or(u128::MAX);

    let start_index = match client.bsgs_get(&job.id) {
        Ok(Some(remote)) if remote.manifest.compatible(&table.manifest) => {
            u128::from(remote.giant_index).min(giants)
        }
        Ok(_) => 0,
        Err(err) => {
            eprintln!("  Coordinator: cannot read BSGS state: {err}");
            0
        }
    };

    crate::engine::prepare_ctrl_c();

    // The remote state decides the resume index; the local work file (when
    // requested) is refreshed from that same position.
    let mut saver =
        work_path.map(|path| WorkSaver::new(path, &table, start, end, target, start_index));
    if let Some(saver) = &mut saver {
        saver.save_now(start_index)?;
    }

    let mut last_put = Instant::now();
    let last_index = Cell::new(start_index);
    let mut progress = |manifest: &TableManifest, index: u128| -> bool {
        last_index.set(index);
        if let Some(saver) = saver.as_mut() {
            saver.note(index);
        }
        if last_put.elapsed() >= Duration::from_secs(5) {
            last_put = Instant::now();
            if let Err(err) = client.bsgs_put(&job.id, manifest, index as u64) {
                eprintln!("  Coordinator: cannot save BSGS state: {err}");
            }
        }
        !crate::engine::stop_requested()
    };

    let result = solve_with_table(target, start, end, &table, start_index, &mut progress);

    // Always leave the latest resume point on the server, even for a short run.
    if let Err(err) = client.bsgs_put(&job.id, &table.manifest, last_index.get() as u64) {
        eprintln!("  Coordinator: cannot save BSGS state: {err}");
    }

    let mut save_error = None;
    if let Some(saver) = &mut saver {
        saver.finish(last_index.get());
        save_error = saver.take_error();
    }

    Ok((result, job.id.clone(), client, save_error))
}

fn failure(message: &str) -> BsgsResult {
    failure_with_manifest(message, TableManifest::default())
}

fn failure_with_manifest(message: &str, manifest: TableManifest) -> BsgsResult {
    BsgsResult {
        found: false,
        key: Scalar::ZERO,
        giant_steps: 0,
        baby_size: manifest.baby_size,
        manifest,
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

/// Rebuild the baby map from an ordered fold list with the same first-j-wins
/// rule as `build_baby_table`, without any baby-step EC work.
pub(crate) fn map_from_folds(folds: &[u64]) -> HashMap<u64, u32> {
    let mut map = HashMap::with_capacity(folds.len());
    for (offset, fold) in folds.iter().enumerate() {
        map.entry(*fold).or_insert((offset as u64 + 1) as u32);
    }
    map
}

/// FNV-1a/64 over the little-endian bytes of every fold, in table order.
pub(crate) fn table_checksum(folds: &[u64]) -> u64 {
    let mut hash = FNV_OFFSET;
    for fold in folds {
        for byte in fold.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash
}

/// Baby-step count for a span: explicit `m` or the `isqrt(span + 1) + 1`
/// default, clamped and validated exactly like `build_table`.
pub(crate) fn baby_size_for(span: u128, m: u64) -> Result<u64, String> {
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
    Ok(baby_size.max(1))
}

/// Canonical manifest range identity, e.g. `"3E8:13E7"`.
pub(crate) fn range_id(k_start: &Scalar, k_end: &Scalar) -> String {
    format!("{}:{}", hex_trim(k_start), hex_trim(k_end))
}

/// The scalar span `k_end - k_start` as `u128`, or `None` when it does not fit.
pub(crate) fn span_u128(k_start: &Scalar, k_end: &Scalar) -> Option<u128> {
    scalar_to_u128(&k_end.sub(k_start))
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
