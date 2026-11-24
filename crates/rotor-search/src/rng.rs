//! SplitMix64 and its clock/worker seed.
//!
//! The desktop CPU and GPU random workers use the same stream; the coordinator
//! uses the same seed for its shuffled chunk order.

use std::time::{SystemTime, UNIX_EPOCH};

/// SplitMix64, seeded from the clock and the worker index (no dependencies).
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Fills 32 bytes from four consecutive outputs, little-endian.
    pub fn fill32(&mut self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.as_chunks_mut::<8>().0 {
            chunk.copy_from_slice(&self.next_u64().to_le_bytes());
        }
        out
    }
}

/// Clock-and-thread-index seed shared by the CPU and GPU random workers.
pub fn thread_seed(thread_index: u64) -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ thread_index.wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

#[cfg(test)]
mod tests {
    use super::SplitMix64;

    #[test]
    fn stream_matches_the_reference_splitmix64_sequence() {
        // Reference values for seed 0 (Steele, Lea & Flood, splitmix64.c).
        let mut rng = SplitMix64::new(0);
        assert_eq!(rng.next_u64(), 0xE220_A839_7B1D_CDAF);
        assert_eq!(rng.next_u64(), 0x6E78_9E6A_A1B9_65F4);
        assert_eq!(rng.next_u64(), 0x06C4_5D18_8009_454F);
    }

    #[test]
    fn fill32_is_four_little_endian_outputs() {
        let mut first = SplitMix64::new(7);
        let mut second = SplitMix64::new(7);
        let bytes = first.fill32();
        for chunk in bytes.as_chunks::<8>().0 {
            assert_eq!(*chunk, second.next_u64().to_le_bytes());
        }
    }
}
