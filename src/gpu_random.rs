//! Host-side random-window planning for the GPU address/xpoint search.
//!
//! The GPU kernel scans one contiguous window at a time. Random mode draws a
//! start key with the CPU [`engine::RandomSpec`] rules (uniform in `--range`,
//! or below `2^next` / inside the `-n..-z` bit band), scans upward for a small
//! window, then either advances the window or, once the shared scanned counter
//! crosses another `-r` epoch, draws a fresh start. This module is pure host
//! planning so it is unit-tested without CUDA.

#![cfg_attr(not(feature = "gpu"), allow(dead_code))]

use crate::cli::U256;
use crate::engine::{self, RandomSpec, Split, SplitMix64};
use crate::gpu_plan::STEP_SIZE;
use crate::scalar::Scalar;

/// Smallest window planned per random epoch (~16.7M keys): about a few tens of
/// milliseconds at current GPU rates, so epoch changes are noticed promptly.
pub(crate) const MIN_WINDOW: u64 = 1 << 24;
/// Largest window, so a very wide grid still lets the epoch check run.
pub(crate) const MAX_WINDOW: u64 = 1 << 32;

/// Plans random start keys and the contiguous windows scanned from them.
pub(crate) struct RandomPlanner {
    spec: RandomSpec,
    rng: SplitMix64,
    /// Last global epoch this planner honored.
    epoch: u64,
    /// First key of the current window.
    start: Split,
    /// Keys per window.
    window: u64,
}

impl RandomPlanner {
    /// Draws the first start key and sizes the window for `nb_thread` device
    /// threads (`max(2^24, nb_thread * STEP_SIZE * 8)`, capped at `2^32`).
    pub(crate) fn new(spec: RandomSpec, seed: u64, nb_thread: usize) -> Self {
        let mut rng = SplitMix64::new(seed);
        let start = scalar_split(&engine::random_start_key(&spec, &mut rng));
        let by_threads = nb_thread.max(1) as u64 * u64::from(STEP_SIZE) * 8;
        let window = by_threads.clamp(MIN_WINDOW, MAX_WINDOW);
        Self {
            spec,
            rng,
            epoch: 0,
            start,
            window,
        }
    }

    /// Rotates when the global epoch changed; returns true if a new start was
    /// chosen. `threshold` is `rkey * 1_000_000_000`; zero disables rotation.
    pub(crate) fn maybe_rotate(&mut self, scanned_total: u64, threshold: u64) -> bool {
        if threshold == 0 {
            return false;
        }
        let epoch = scanned_total / threshold;
        if epoch <= self.epoch {
            return false;
        }
        self.epoch = epoch;
        self.start = scalar_split(&engine::random_start_key(&self.spec, &mut self.rng));
        true
    }

    /// Inclusive `[first, last]` key window scanned from the current start.
    pub(crate) fn window(&self) -> (Split, Split) {
        let (last, carry) = self.start.add(Split::from_u64(self.window - 1));
        let last = if carry {
            Split::from_u256(&U256([0xFF; 32]))
        } else {
            last
        };
        (self.start, last)
    }

    /// Continues upward after a full window. A start that left the scalar field
    /// (or wrapped past `2^256`) is replaced by a fresh random draw so the next
    /// plan can never cover keys above the curve order.
    pub(crate) fn advance_window(&mut self) {
        self.start = self.start.add_u64(self.window);
        if self.start.to_scalar().is_none() {
            self.start = scalar_split(&engine::random_start_key(&self.spec, &mut self.rng));
        }
    }

    /// Last epoch this planner honored (for the shared rotation counter).
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    /// First key of the current window.
    pub(crate) fn start(&self) -> Split {
        self.start
    }
}

fn scalar_split(key: &Scalar) -> Split {
    Split::from_u256(&U256(key.to_bytes_be()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Config, Range};

    fn split(value: u64) -> Split {
        Split::from_u64(value)
    }

    fn range_spec(low: u64, high: u64) -> RandomSpec {
        let config = Config {
            range: Some(Range {
                start: U256::from_u64(low),
                end: U256::from_u64(high),
            }),
            ..Config::default()
        };
        RandomSpec::from_config(&config).expect("range spec")
    }

    fn bit_spec(next: i32, zet: i32) -> RandomSpec {
        let config = Config {
            next,
            zet,
            ..Config::default()
        };
        RandomSpec::from_config(&config).expect("bit spec")
    }

    #[test]
    fn range_mode_starts_inside_the_range_and_rotates_inside_it() {
        let mut planner = RandomPlanner::new(range_spec(0x100, 0x1FF), 0x1234, 1);
        for epoch in 0..64u64 {
            assert!(planner.start() >= split(0x100), "start below --range START");
            assert!(planner.start() <= split(0x1FF), "start above --range END");
            assert!(
                planner.maybe_rotate((epoch + 1) * 1_000, 1_000),
                "a new epoch must rotate"
            );
        }
    }

    #[test]
    fn bit_width_starts_stay_below_the_requested_width() {
        for width in [1i32, 8, 71, 252, 256] {
            let mut planner = RandomPlanner::new(bit_spec(width, 0), 0xBEEF, 1);
            for epoch in 1..=128u64 {
                assert!(
                    planner.start().bit_length() <= width as u32,
                    "start exceeds {width} bits"
                );
                planner.maybe_rotate(epoch * 1_000_000_000, 1_000_000_000);
            }
        }
    }

    #[test]
    fn bit_band_starts_stay_inside_the_band() {
        let mut planner = RandomPlanner::new(bit_spec(71, 74), 0xDEAD_BEEF, 1);
        for epoch in 1..=128u64 {
            let bits = planner.start().bit_length();
            assert!(
                bits <= 74,
                "key has {bits} bits, expected at most the -z width 74"
            );
            planner.maybe_rotate(epoch * 1_000_000_000, 1_000_000_000);
        }
    }

    #[test]
    fn rotation_happens_only_when_the_epoch_changes() {
        let mut planner = RandomPlanner::new(range_spec(1, 0xFFFF), 7, 1);
        assert!(!planner.maybe_rotate(0, 10), "epoch 0 is the initial one");
        assert!(!planner.maybe_rotate(9, 10), "still epoch 0");
        assert!(planner.maybe_rotate(10, 10), "epoch 1 must rotate");
        assert!(!planner.maybe_rotate(19, 10), "still epoch 1");
        assert!(planner.maybe_rotate(20, 10), "epoch 2 must rotate");
        assert!(!planner.maybe_rotate(20, 10), "same epoch must not rotate");
        assert!(!planner.maybe_rotate(u64::MAX, 0), "zero disables rotation");
    }

    #[test]
    fn window_advances_upward_by_its_size() {
        let mut planner = RandomPlanner::new(range_spec(1, 0xFFFF), 11, 1);
        let (start, end) = planner.window();
        let len = end.sub(start).add_u64(1).low_u64();
        assert_eq!(len, MIN_WINDOW, "one thread uses the minimum window");

        planner.advance_window();
        let (next, _) = planner.window();
        assert_eq!(
            next,
            start.add_u64(MIN_WINDOW),
            "advance_window must continue upward"
        );
    }

    #[test]
    fn window_size_scales_with_threads_and_is_capped() {
        let one = RandomPlanner::new(range_spec(1, 0xFFFF), 1, 1);
        let (start, end) = one.window();
        assert_eq!(end.sub(start).add_u64(1).low_u64(), MIN_WINDOW);

        let wide = RandomPlanner::new(range_spec(1, 0xFFFF), 1, 65_536);
        let (start, end) = wide.window();
        assert_eq!(
            end.sub(start).add_u64(1).low_u64(),
            65_536 * u64::from(STEP_SIZE) * 8
        );

        let huge = RandomPlanner::new(range_spec(1, 0xFFFF), 1, 1 << 20);
        let (start, end) = huge.window();
        assert_eq!(end.sub(start).add_u64(1).low_u64(), MAX_WINDOW);
    }
}
