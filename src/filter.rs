//! Target set storage and Bloom filter, ported from `Rotor-Cuda/Bloom.cpp`.
//!
//! The `.bin` target format is headerless: raw fixed-size records (20 bytes for
//! hash160/ETH addresses, 32 bytes for xpoints). The C++ binary requires the
//! file to be pre-sorted and its binary search loses record 0; this port sorts
//! the records itself and searches them correctly.

use std::path::Path;

/// MurmurHash2 (32-bit), by Austin Appleby.
///
/// Ported verbatim from `Bloom.cpp:298-345`, including its non-standard tail
/// handling (the 3-/2-/1-byte cases do not fall through, so `h *= m` only
/// happens for a single trailing byte).
pub fn murmurhash2(data: &[u8], seed: u32) -> u32 {
    const M: u32 = 0x5bd1_e995;
    const R: u32 = 24;

    let mut h = seed ^ data.len() as u32;
    let (chunks, tail) = data.as_chunks::<4>();
    for chunk in chunks {
        let mut k = u32::from_le_bytes(*chunk);
        k = k.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
    }

    match tail.len() {
        3 => h ^= (tail[2] as u32) << 16,
        2 => h ^= (tail[1] as u32) << 8,
        1 => {
            h ^= tail[0] as u32;
            h = h.wrapping_mul(M);
        }
        _ => {}
    }

    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;
    h
}

/// Bloom filter with libbloom-compatible parameters (`Bloom.cpp:13-50`).
pub struct Bloom {
    bits: u64,
    hashes: u8,
    bytes: Vec<u8>,
}

impl Bloom {
    /// Builds a filter sized for `entries` elements with the given error rate.
    pub fn new(entries: u64, error: f64) -> Self {
        let bpe = -error.ln() / 0.480453013918201; // ln(2)^2
        let bits = (entries as f64 * bpe) as u64;
        let hashes = (std::f64::consts::LN_2 * bpe).ceil() as u8;
        let bytes = vec![0u8; bits.div_ceil(8) as usize];
        Self {
            bits,
            hashes,
            bytes,
        }
    }

    /// Records `data` in the filter.
    pub fn add(&mut self, data: &[u8]) {
        if self.bits == 0 {
            return;
        }
        let (a, b) = Self::hashes_for(data);
        for i in 0..u32::from(self.hashes) {
            let bit = Self::bit_index(a, b, i, self.bits);
            self.bytes[(bit / 8) as usize] |= 1u8 << (bit % 8);
        }
    }

    /// Returns `true` if `data` may have been added (false positives possible,
    /// false negatives are not).
    pub fn check(&self, data: &[u8]) -> bool {
        if self.bits == 0 {
            return false;
        }
        let (a, b) = Self::hashes_for(data);
        for i in 0..u32::from(self.hashes) {
            let bit = Self::bit_index(a, b, i, self.bits);
            if self.bytes[(bit / 8) as usize] & (1u8 << (bit % 8)) == 0 {
                return false;
            }
        }
        true
    }

    fn hashes_for(data: &[u8]) -> (u32, u32) {
        let a = murmurhash2(data, 0x9747b28c);
        let b = murmurhash2(data, a);
        (a, b)
    }

    /// Double hashing with wrapping 32-bit arithmetic, as in `Bloom.cpp:256-284`.
    fn bit_index(a: u32, b: u32, i: u32, bits: u64) -> u64 {
        (a.wrapping_add(b.wrapping_mul(i)) as u64) % bits
    }
}

/// A loaded target set: sorted raw records plus a Bloom prefilter.
pub struct TargetSet {
    record_len: usize,
    records: Vec<Vec<u8>>,
    bloom: Bloom,
}

impl TargetSet {
    /// Loads a headerless `.bin` file of fixed-size `record_len` records.
    ///
    /// Records are sorted internally, so unsorted input files are safe.
    pub fn load(path: &Path, record_len: usize) -> Result<Self, String> {
        if record_len == 0 {
            return Err("record length must be positive".to_string());
        }
        let data =
            std::fs::read(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
        if data.is_empty() {
            return Err(format!("target file {} is empty", path.display()));
        }
        if !data.len().is_multiple_of(record_len) {
            return Err(format!(
                "target file {} has {} bytes, which is not a multiple of the {}-byte record length",
                path.display(),
                data.len(),
                record_len
            ));
        }
        let records: Vec<Vec<u8>> = data.chunks_exact(record_len).map(|c| c.to_vec()).collect();
        Ok(Self::from_records(&records, record_len))
    }

    /// Builds a target set from in-memory records, sorting a copy.
    pub fn from_records(records: &[Vec<u8>], record_len: usize) -> Self {
        let mut sorted = records.to_vec();
        sorted.sort();
        let mut bloom = Bloom::new(sorted.len() as u64 * 2, 1e-6); // `Rotor.cpp:92`
        for record in &sorted {
            bloom.add(record);
        }
        Self {
            record_len,
            records: sorted,
            bloom,
        }
    }

    /// Bloom prefilter only: `true` means the needle may be a member.
    pub fn may_contain(&self, needle: &[u8]) -> bool {
        self.bloom.check(needle)
    }

    /// Exact membership: Bloom prefilter followed by a binary search.
    ///
    /// A needle whose length differs from [`TargetSet::record_len`] is never a
    /// member.
    pub fn contains(&self, needle: &[u8]) -> bool {
        needle.len() == self.record_len
            && self.bloom.check(needle)
            && self
                .records
                .binary_search_by(|record| record.as_slice().cmp(needle))
                .is_ok()
    }

    /// Number of records in the set.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Returns `true` if the set holds no records.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Size of each raw record in bytes (20 or 32).
    pub fn record_len(&self) -> usize {
        self.record_len
    }

    /// The sorted records.
    pub fn records(&self) -> &[Vec<u8>] {
        &self.records
    }
}
