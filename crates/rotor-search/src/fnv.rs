//! FNV-1a/64, the fold shared by BSGS table identity and the target prefilter.

/// FNV-1a/64 offset basis.
pub const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
/// FNV-1a/64 prime.
pub const FNV_PRIME: u64 = 1_099_511_628_211;

/// FNV-1a/64 over `bytes`, wrapping at 64 bits.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}
