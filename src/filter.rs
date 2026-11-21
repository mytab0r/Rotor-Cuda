//! Target set storage and prefilter, ported from `Rotor-Cuda/Bloom.cpp`.
//!
//! Large sets (≥ [`FUSE_THRESHOLD`] records) are indexed with a binary fuse8
//! filter keyed by FNV-1a/64 of the record bytes; smaller sets keep the classic
//! libbloom parameters. The exact binary search remains the source of truth.
//!
//! The `.bin` target format is headerless: raw fixed-size records (20 bytes for
//! hash160/ETH addresses, 32 bytes for xpoints). The C++ binary requires the
//! file to be pre-sorted and its binary search loses record 0; this port sorts
//! the records itself and searches them correctly.
//!
//! A 20-byte address record is chain-agnostic: it is the same hash160/keccak
//! account regardless of which chain the CLI selects with `--chain`. The file
//! therefore cannot mix chains, and [`TargetSet::load_for_chain`] rejects a
//! 20-byte interpretation for chains whose target is 32 bytes instead of
//! truncating it.

use std::path::Path;

use xorf::{BinaryFuse8, Filter};

use crate::chain::ChainDescriptor;

/// Record count from which the binary fuse prefilter replaces Bloom.
pub const FUSE_THRESHOLD: usize = 1024;

/// FNV-1a/64, the same fold the C++ `FilterCatalog` uses for fuse keys.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

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

    /// Number of bits in the filter (`BLOOM_BITS` on the CUDA side).
    pub fn bits(&self) -> u64 {
        self.bits
    }

    /// Number of hash probes per element (`BLOOM_HASHES`).
    pub fn hashes(&self) -> u8 {
        self.hashes
    }

    /// Raw bit array uploaded to the device.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Double hashing with wrapping 32-bit arithmetic, as in `Bloom.cpp:256-284`.
    fn bit_index(a: u32, b: u32, i: u32, bits: u64) -> u64 {
        (a.wrapping_add(b.wrapping_mul(i)) as u64) % bits
    }
}

/// The prefilter selected for a target set.
enum Prefilter {
    Bloom(Bloom),
    Fuse(BinaryFuse8),
}

impl Prefilter {
    /// Returns `true` if `needle` may be a member.
    fn may_contain(&self, needle: &[u8]) -> bool {
        match self {
            Prefilter::Bloom(bloom) => bloom.check(needle),
            Prefilter::Fuse(fuse) => fuse.contains(&fnv1a64(needle)),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Prefilter::Bloom(_) => "bloom",
            Prefilter::Fuse(_) => "fuse",
        }
    }
}

/// A loaded target set: sorted raw records plus a membership prefilter.
pub struct TargetSet {
    record_len: usize,
    records: Vec<Vec<u8>>,
    prefilter: Prefilter,
    /// Classic Bloom filter uploaded to the CUDA search kernel.
    #[cfg(feature = "gpu")]
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

    /// Loads a `.bin` file of `record_len`-byte records for `chain`.
    ///
    /// Records carry no chain tag, so the caller's `--chain` decides which
    /// chain the 20-byte hash160/account is compared against. A chain whose
    /// target is 32 bytes must not read a 20-byte file: that would compare
    /// truncated records, so it is rejected before the file is opened.
    pub fn load_for_chain(
        path: &Path,
        chain: &ChainDescriptor,
        record_len: usize,
    ) -> Result<Self, String> {
        if record_len == 20 && chain.target_len() != 20 {
            return Err(format!(
                "chain '{}' compares {}-byte targets, but a 20-byte .bin address file is the \
                 secp-hash160/EVM/TRON form and would be truncated; use a {}-byte record file",
                chain.id,
                chain.target_len(),
                chain.target_len()
            ));
        }
        Self::load(path, record_len)
    }

    /// Builds a target set from in-memory records, sorting a copy.
    pub fn from_records(records: &[Vec<u8>], record_len: usize) -> Self {
        let mut sorted = records.to_vec();
        sorted.sort();
        let prefilter = Self::build_prefilter(&sorted);
        #[cfg(feature = "gpu")]
        let bloom = Self::build_bloom(&sorted);
        Self {
            record_len,
            records: sorted,
            prefilter,
            #[cfg(feature = "gpu")]
            bloom,
        }
    }

    /// The classic libbloom filter (`Rotor.cpp:92` parameters).
    fn build_bloom(records: &[Vec<u8>]) -> Bloom {
        let mut bloom = Bloom::new(records.len() as u64 * 2, 1e-6);
        for record in records {
            bloom.add(record);
        }
        bloom
    }

    /// Binary fuse8 for large sets, Bloom below the threshold or on failure.
    fn build_prefilter(records: &[Vec<u8>]) -> Prefilter {
        if records.len() >= FUSE_THRESHOLD {
            let keys: Vec<u64> = records.iter().map(|record| fnv1a64(record)).collect();
            if let Ok(fuse) = BinaryFuse8::try_from(keys.as_slice()) {
                return Prefilter::Fuse(fuse);
            }
        }
        Prefilter::Bloom(Self::build_bloom(records))
    }

    /// Prefilter only: `true` means the needle may be a member.
    pub fn may_contain(&self, needle: &[u8]) -> bool {
        self.prefilter.may_contain(needle)
    }

    /// Exact membership: prefilter followed by a binary search.
    ///
    /// A needle whose length differs from [`TargetSet::record_len`] is never a
    /// member.
    pub fn contains(&self, needle: &[u8]) -> bool {
        needle.len() == self.record_len
            && self.prefilter.may_contain(needle)
            && self
                .records
                .binary_search_by(|record| record.as_slice().cmp(needle))
                .is_ok()
    }

    /// Which prefilter backs the set: `"fuse"` or `"bloom"`.
    #[doc(hidden)]
    pub fn prefilter_kind(&self) -> &'static str {
        self.prefilter.kind()
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

    /// Bloom prefilter parameters and bits, for the CUDA search kernel.
    #[cfg(feature = "gpu")]
    pub fn bloom(&self) -> &Bloom {
        &self.bloom
    }
}
