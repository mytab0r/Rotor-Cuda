//! Pure planning helpers for the GPU address/xpoint search.
//!
//! Kept separate from the FFI wrapper so the chunk layout, starting points and
//! hit filtering can be tested on machines without CUDA.
#![cfg_attr(not(feature = "gpu"), allow(dead_code))]

use crate::cli::{Coin, CompMode, SearchMode};
use crate::engine::{Split, split_range};
use crate::point::Affine;
use crate::scalar::Scalar;
use crate::secp;

// C ids from `GPU/GPUEngine.h`. Kept here so the planner is testable without
// linking the CUDA ABI.
pub const SEARCH_MODE_MA: i32 = 1;
pub const SEARCH_MODE_SA: i32 = 2;
pub const SEARCH_MODE_MX: i32 = 3;
pub const SEARCH_MODE_SX: i32 = 4;
pub const COMPRESSED: i32 = 0;
pub const UNCOMPRESSED: i32 = 1;
pub const BOTH: i32 = 2;
pub const COIN_BTC: i32 = 1;
pub const COIN_ETH: i32 = 2;

/// Keys per thread group (`GRP_SIZE` in `GPU/GPUMath.h`).
pub const GROUP_SIZE: u32 = 1024 * 2;

/// Keys advanced per kernel batch (`STEP_SIZE` in `GPU/GPUEngine.h`).
pub const STEP_SIZE: u32 = 1024 * 2;

/// One thread's fixed chunk plus the sliding start of the current batch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    chunk_high: Split,
    batch_low: Split,
}

impl Window {
    /// The private key a hit at `incr` corresponds to, or `None` when the hit
    /// falls outside this batch's slice of the thread's chunk (the kernel's
    /// group can overrun a short chunk, and the last group may run past the
    /// requested range).
    pub fn key(&self, incr: u32, end: Split, step: u64) -> Option<Split> {
        if self.exhausted(end) {
            return None;
        }
        let key = self.batch_low.add_u64(u64::from(incr));
        let last = self.batch_low.add_u64(step - 1);
        let high = last.min(self.chunk_high).min(end);
        (key <= high).then_some(key)
    }

    /// Number of keys this batch can report (the clipped slice length).
    pub fn current_len(&self, end: Split, step: u64) -> u64 {
        if self.exhausted(end) {
            return 0;
        }
        let last = self.batch_low.add_u64(step - 1);
        let high = last.min(self.chunk_high).min(end);
        high.sub(self.batch_low).low_u64() + 1
    }

    pub fn advance(&mut self, step: u64) {
        self.batch_low = self.batch_low.add_u64(step);
    }

    pub fn exhausted(&self, end: Split) -> bool {
        self.batch_low > self.chunk_high || self.batch_low > end
    }
}

/// Per-thread starting points and key windows.
pub struct KeyPlan {
    pub points: Vec<u64>,
    pub windows: Vec<Window>,
}

impl KeyPlan {
    /// Splits `[start, end]` into at most `nb_thread` chunks, starting each
    /// thread at `chunk_start + GRP_SIZE/2` as `Rotor::getGPUStartingKeys`
    /// does. Threads past the range get a valid point and an empty window so
    /// their hits can never be reported.
    pub fn build(start: Split, end: Split, nb_thread: usize) -> Result<Self, String> {
        if nb_thread == 0 {
            return Err("GPU engine reported zero threads".to_owned());
        }
        let half = Split::from_u64(u64::from(GROUP_SIZE / 2));
        let mut points = Vec::with_capacity(nb_thread * 8);
        let mut windows = Vec::with_capacity(nb_thread);

        for (low, high) in split_range(start, end, nb_thread) {
            let center = low.add(half).0.to_scalar().ok_or_else(|| {
                "range start is too close to the curve order for GPU search".to_owned()
            })?;
            push_point(&mut points, &secp::mul_g(&center));
            windows.push(Window {
                chunk_high: high,
                batch_low: low,
            });
        }

        let dummy = secp::g();
        while windows.len() < nb_thread {
            push_point(&mut points, &dummy);
            windows.push(Window {
                chunk_high: Split::from_u64(0),
                batch_low: Split::from_u64(1),
            });
        }
        Ok(Self { points, windows })
    }

    pub fn len(&self) -> usize {
        self.windows.len()
    }

    /// Keys inside the range covered by the current batch (progress counter).
    pub fn batch_len(&self, end: Split, step: u64) -> u64 {
        self.windows
            .iter()
            .map(|window| window.current_len(end, step))
            .sum()
    }

    pub fn advance(&mut self, step: u64) {
        for window in &mut self.windows {
            window.advance(step);
        }
    }

    pub fn exhausted(&self, end: Split) -> bool {
        self.windows.iter().all(|window| window.exhausted(end))
    }
}

fn push_point(points: &mut Vec<u64>, point: &Affine) {
    points.extend_from_slice(&point.x.to_limbs());
    points.extend_from_slice(&point.y.to_limbs());
}

/// `G..1024G` and `2048G` in the layout `InitGenratorTable` uploads.
pub fn generator_table() -> (Vec<u64>, Vec<u64>, [u64; 8]) {
    let generator = secp::g();
    let mut xs = Vec::with_capacity(1024 * 4);
    let mut ys = Vec::with_capacity(1024 * 4);
    let mut point = generator;
    for _ in 0..1024 {
        xs.extend_from_slice(&point.x.to_limbs());
        ys.extend_from_slice(&point.y.to_limbs());
        point = secp::add(&point, &generator).expect("a multiple of G is never infinity");
    }
    let two_gn_point = secp::mul_g(&Scalar::from_u64(u64::from(GROUP_SIZE)));
    let mut two_gn = [0u64; 8];
    two_gn[..4].copy_from_slice(&two_gn_point.x.to_limbs());
    two_gn[4..].copy_from_slice(&two_gn_point.y.to_limbs());
    (xs, ys, two_gn)
}

/// C search mode id (`GPU/GPUEngine.h`).
pub fn gpu_mode(mode: SearchMode) -> i32 {
    match mode {
        SearchMode::Address => SEARCH_MODE_SA,
        SearchMode::Addresses => SEARCH_MODE_MA,
        SearchMode::XPoint => SEARCH_MODE_SX,
        SearchMode::XPoints => SEARCH_MODE_MX,
        SearchMode::Bsgs => unreachable!("BSGS uses its own backend"),
    }
}

/// Compression mode handed to the kernel. Xpoint search compares X, which is
/// mode independent, so it always runs the compressed check; the host emits
/// one block per selected mode (matching the CPU engine).
pub fn gpu_comp_mode(mode: SearchMode, coin: Coin, comp: CompMode) -> i32 {
    if coin == Coin::Eth || matches!(mode, SearchMode::XPoint | SearchMode::XPoints) {
        return COMPRESSED;
    }
    match comp {
        CompMode::Compressed => COMPRESSED,
        CompMode::Uncompressed => UNCOMPRESSED,
        CompMode::Both => BOTH,
    }
}

/// Single-target bytes as the little-endian u32 words the kernel compares.
pub fn single_target_words(target: &crate::engine::Target) -> Option<Vec<u32>> {
    use crate::engine::Target;
    fn words(bytes: &[u8]) -> Vec<u32> {
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| u32::from_le_bytes(*chunk))
            .collect()
    }
    match target {
        Target::Hash(hash) => Some(words(hash)),
        Target::X(x) => Some(words(x)),
        Target::Hashes(_) | Target::Xs(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::U256;
    use crate::engine::split_range;

    fn split(value: u64) -> Split {
        Split::from_u256(&U256::from_u64(value))
    }

    #[test]
    fn chunk_starts_are_midpoints_of_split_chunks() {
        let start = split(0x1000);
        let end = split(0x11FF); // 512 keys, 4 threads -> 128 each
        let plan = KeyPlan::build(start, end, 4).expect("plan");
        assert_eq!(plan.windows.len(), 4);
        assert_eq!(plan.points.len(), 4 * 8);

        let chunks = split_range(start, end, 4);
        for (index, (low, _)) in chunks.iter().enumerate() {
            let center = low.add_u64(u64::from(GROUP_SIZE / 2));
            let point = secp::mul_g(&center.to_scalar().expect("canonical"));
            assert_eq!(&plan.points[index * 8..index * 8 + 4], &point.x.to_limbs());
            assert_eq!(
                &plan.points[index * 8 + 4..index * 8 + 8],
                &point.y.to_limbs()
            );
        }
    }

    #[test]
    fn short_ranges_pad_idle_threads_with_empty_windows() {
        let plan = KeyPlan::build(split(10), split(12), 8).expect("plan");
        assert_eq!(plan.windows.len(), 8);
        assert_eq!(plan.points.len(), 8 * 8);
        let end = split(12);
        assert!(plan.windows[0].key(0, end, 2048).is_some());
        // Threads past the 3-key range never report keys.
        for window in &plan.windows[3..] {
            assert!(window.exhausted(end));
            assert_eq!(window.key(0, end, 2048), None);
        }
    }

    #[test]
    fn windows_accept_only_the_current_batch_slice() {
        let start = split(0x1000);
        let end = split(0x1FFF); // one 4096-key chunk
        let plan = KeyPlan::build(start, end, 1).expect("plan");
        let mut window = plan.windows[0];
        let step = u64::from(STEP_SIZE);

        assert_eq!(window.key(0, end, step), Some(split(0x1000)));
        assert_eq!(window.key(2047, end, step), Some(split(0x17FF)));
        assert_eq!(window.key(2048, end, step), None);

        window.advance(step);
        assert_eq!(window.key(0, end, step), Some(split(0x1800)));
        assert_eq!(window.key(2047, end, step), Some(split(0x1FFF)));
        assert_eq!(window.key(2048, end, step), None);

        window.advance(step);
        assert!(window.exhausted(end));
        assert_eq!(window.key(0, end, step), None);
    }

    #[test]
    fn batch_length_counts_only_keys_inside_the_range() {
        let start = split(0x1000);
        let end = split(0x17FF); // 2048 keys over 4 threads
        let mut plan = KeyPlan::build(start, end, 4).expect("plan");
        assert_eq!(plan.batch_len(end, 2048), 2048);
        plan.advance(2048);
        assert_eq!(plan.batch_len(end, 2048), 0);

        let short = KeyPlan::build(split(10), split(12), 8).expect("plan");
        assert_eq!(short.batch_len(split(12), 2048), 3);
    }

    #[test]
    fn short_chunks_reject_group_overrun() {
        let start = split(100);
        let end = split(227); // 128-key chunk
        let plan = KeyPlan::build(start, end, 1).expect("plan");
        let window = plan.windows[0];
        assert!(window.key(0, end, 2048).is_some());
        assert!(window.key(127, end, 2048).is_some());
        assert_eq!(window.key(128, end, 2048), None, "past the chunk end");
        assert_eq!(window.key(1024, end, 2048), None, "past the range end");
    }

    #[test]
    fn generator_table_matches_scalar_multiplication() {
        let (xs, ys, two_gn) = generator_table();
        assert_eq!(xs.len(), 4096);
        assert_eq!(ys.len(), 4096);
        for k in [1u64, 2, 3, 1024] {
            let point = secp::mul_g(&Scalar::from_u64(k));
            let offset = (k as usize - 1) * 4;
            assert_eq!(&xs[offset..offset + 4], &point.x.to_limbs(), "G*{k} x");
            assert_eq!(&ys[offset..offset + 4], &point.y.to_limbs(), "G*{k} y");
        }
        let two_gn_point = secp::mul_g(&Scalar::from_u64(u64::from(GROUP_SIZE)));
        assert_eq!(&two_gn[..4], &two_gn_point.x.to_limbs());
        assert_eq!(&two_gn[4..], &two_gn_point.y.to_limbs());
    }

    #[test]
    fn single_targets_become_little_endian_words() {
        use crate::engine::Target;
        let mut hash = [0u8; 20];
        for (index, byte) in hash.iter_mut().enumerate() {
            *byte = index as u8;
        }
        let words = single_target_words(&Target::Hash(hash)).expect("single target");
        assert_eq!(words.len(), 5);
        assert_eq!(words[0], u32::from_le_bytes([0, 1, 2, 3]));

        let xwords = single_target_words(&Target::X([0xFF; 32])).expect("xpoint");
        assert_eq!(xwords, vec![u32::MAX; 8]);
    }

    #[test]
    fn mode_and_compression_mapping_matches_the_c_headers() {
        assert_eq!(gpu_mode(SearchMode::Address), 2);
        assert_eq!(gpu_mode(SearchMode::Addresses), 1);
        assert_eq!(gpu_mode(SearchMode::XPoint), 4);
        assert_eq!(gpu_mode(SearchMode::XPoints), 3);

        assert_eq!(
            gpu_comp_mode(SearchMode::Address, Coin::Btc, CompMode::Both),
            2
        );
        assert_eq!(
            gpu_comp_mode(SearchMode::Address, Coin::Btc, CompMode::Uncompressed),
            1
        );
        assert_eq!(
            gpu_comp_mode(SearchMode::XPoint, Coin::Btc, CompMode::Uncompressed),
            0
        );
        assert_eq!(
            gpu_comp_mode(SearchMode::Address, Coin::Eth, CompMode::Both),
            0
        );
    }
}
