//! 256-bit range endpoints and chunk arithmetic.
//!
//! Range arithmetic must not depend on the scalar field: chunk boundaries may
//! equal or approach `2^256`. [`Split`] is little-endian 4x64-bit limbs;
//! [`U256`] is the big-endian byte form used by the CLI and the protocol.

use std::cmp::Ordering;
use std::fmt::Write as _;

use rotor_core::scalar::Scalar;

/// Default chunk width used by the coordinator protocol (`0x10000000`).
pub const DEFAULT_CHUNK_WIDTH: u64 = 0x1000_0000;

/// Big-endian 256-bit integer used for range endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct U256(pub [u8; 32]);

impl U256 {
    pub const ZERO: Self = Self([0; 32]);

    pub const fn from_u64(value: u64) -> Self {
        let mut bytes = [0; 32];
        let source = value.to_be_bytes();
        let mut i = 0;
        while i < 8 {
            bytes[24 + i] = source[i];
            i += 1;
        }
        Self(bytes)
    }

    pub fn from_hex(text: &str) -> Result<Self, String> {
        if text.is_empty() {
            return Err("Invalid hex value: empty".to_string());
        }
        if text.len() > 64 {
            return Err(format!("Invalid hex value: more than 64 digits: {text}"));
        }

        let mut bytes = [0; 32];
        for (index, byte) in text.bytes().rev().enumerate() {
            let nibble = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => {
                    return Err(format!("Invalid hex value: {text}"));
                }
            };
            let slot = 31 - index / 2;
            if index % 2 == 0 {
                bytes[slot] = nibble;
            } else {
                bytes[slot] |= nibble << 4;
            }
        }
        Ok(Self(bytes))
    }

    pub fn wrapping_add(self, rhs: Self) -> Self {
        let mut bytes = [0; 32];
        let mut carry = 0u16;
        for i in (0..32).rev() {
            let sum = u16::from(self.0[i]) + u16::from(rhs.0[i]) + carry;
            bytes[i] = sum as u8;
            carry = sum >> 8;
        }
        Self(bytes)
    }
}

/// Little-endian 4x64-bit limbs of a 256-bit range endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Split([u64; 4]);

// `add` returns an explicit carry and `sub` is wrapping protocol arithmetic;
// neither can be expressed by `std::ops::Add`/`Sub` without changing the API.
#[allow(clippy::should_implement_trait)]
impl Split {
    pub fn from_u256(value: &U256) -> Self {
        let mut limbs = [0u64; 4];
        for (index, limb) in limbs.iter_mut().enumerate() {
            let start = (3 - index) * 8;
            *limb = u64::from_be_bytes(value.0[start..start + 8].try_into().expect("eight bytes"));
        }
        Self(limbs)
    }

    pub fn to_scalar(self) -> Option<Scalar> {
        Scalar::from_bytes_be(&self.to_bytes32())
    }

    /// Big-endian 32 bytes, used as the ed25519 seed for a range position.
    pub fn to_bytes32(self) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        for (index, limb) in self.0.iter().enumerate() {
            let start = (3 - index) * 8;
            bytes[start..start + 8].copy_from_slice(&limb.to_be_bytes());
        }
        bytes
    }

    pub fn add(self, other: Self) -> (Self, bool) {
        let mut out = [0u64; 4];
        let mut carry = false;
        for index in 0..4 {
            let (partial, first) = self.0[index].overflowing_add(other.0[index]);
            let (sum, second) = partial.overflowing_add(u64::from(carry));
            out[index] = sum;
            carry = first || second;
        }
        (Self(out), carry)
    }

    pub fn from_u64(value: u64) -> Self {
        Self([value, 0, 0, 0])
    }

    pub fn from_u128(value: u128) -> Self {
        Self([value as u64, (value >> 64) as u64, 0, 0])
    }

    pub fn add_u64(self, value: u64) -> Self {
        self.add(Self::from_u64(value)).0
    }

    /// Low 64 bits; only for spans known to fit (GPU batch windows).
    pub fn low_u64(self) -> u64 {
        self.0[0]
    }

    pub fn sub(self, other: Self) -> Self {
        let mut out = [0u64; 4];
        let mut borrow = false;
        for index in 0..4 {
            let (partial, first) = self.0[index].overflowing_sub(other.0[index]);
            let (difference, second) = partial.overflowing_sub(u64::from(borrow));
            out[index] = difference;
            borrow = first || second;
        }
        Self(out)
    }

    pub fn sub_u64(self, value: u64) -> Self {
        self.sub(Self([value, 0, 0, 0]))
    }

    /// Low 256 bits of the product; exact for every value the split produces.
    fn mul_u64(self, value: u64) -> Self {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for index in 0..4 {
            let product = u128::from(self.0[index]) * u128::from(value) + carry;
            out[index] = product as u64;
            carry = product >> 64;
        }
        Self(out)
    }

    pub fn div_u64(self, value: u64) -> (Self, u64) {
        debug_assert!(value != 0);
        let divisor = u128::from(value);
        let mut quotient = [0u64; 4];
        let mut remainder = 0u128;
        for index in (0..4).rev() {
            let current = (remainder << 64) | u128::from(self.0[index]);
            quotient[index] = (current / divisor) as u64;
            remainder = current % divisor;
        }
        (Self(quotient), remainder as u64)
    }

    pub fn bit_length(self) -> u32 {
        for index in (0..4).rev() {
            if self.0[index] != 0 {
                return index as u32 * 64 + (64 - self.0[index].leading_zeros());
            }
        }
        0
    }

    /// Uppercase hexadecimal without leading zeros (`Int::GetBase16`).
    pub fn to_hex(self) -> String {
        match self.0.iter().rposition(|&limb| limb != 0) {
            None => "0".to_owned(),
            Some(top) => {
                let mut out = String::with_capacity(64);
                let _ = write!(out, "{:X}", self.0[top]);
                for limb in self.0[..top].iter().rev() {
                    let _ = write!(out, "{limb:016X}");
                }
                out
            }
        }
    }

    pub fn to_f64(self) -> f64 {
        let mut value = 0.0;
        for limb in self.0.iter().rev() {
            value = value * 18_446_744_073_709_551_616.0 + *limb as f64;
        }
        value
    }
}

impl Ord for Split {
    fn cmp(&self, other: &Self) -> Ordering {
        for index in (0..4).rev() {
            if self.0[index] != other.0[index] {
                return self.0[index].cmp(&other.0[index]);
            }
        }
        Ordering::Equal
    }
}

impl PartialOrd for Split {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Splits the inclusive `[start, end]` range into at most `threads`
/// contiguous, non-overlapping chunks of `ceil(total / threads)` keys.
pub fn split_range(start: Split, end: Split, threads: usize) -> Vec<(Split, Split)> {
    let total = end.sub(start).add_u64(1);
    let divisor = threads.max(1) as u64;
    let (quotient, remainder) = total.div_u64(divisor);
    let chunk = quotient.add_u64(u64::from(remainder != 0));

    let mut chunks = Vec::new();
    let mut current = start;
    for index in 1..=divisor {
        if current > end {
            break;
        }
        let (next_start, carry) = start.add(chunk.mul_u64(index));
        let chunk_end = if carry || next_start > end {
            end
        } else {
            next_start.sub_u64(1)
        };
        chunks.push((current, chunk_end));
        if carry {
            break;
        }
        current = next_start;
    }
    chunks
}

/// Partitions the inclusive `[start, end]` range into one contiguous chunk per
/// device (`ceil(total / devices)` keys each, the last clipped at `end`; fewer
/// chunks when the range is shorter than the device count).
///
/// `devices == 1` returns the whole range unchanged. The chunks cover every key
/// exactly once and in ascending order.
pub fn split_ranges(start: Split, end: Split, devices: usize) -> Vec<(Split, Split)> {
    split_range(start, end, devices)
}

/// Shifts an inclusive device window by `offset` keys, clipping its high end at
/// `end`. `None` means the whole window was scanned already.
///
/// Shared with the GPU checkpoint path.
pub fn shift_chunk(low: Split, high: Split, offset: u64, end: Split) -> Option<(Split, Split)> {
    let (low, low_carry) = low.add(Split::from_u64(offset));
    let (high, high_carry) = high.add(Split::from_u64(offset));
    let high = if high_carry || high > end { end } else { high };
    if low_carry || low > high {
        return None;
    }
    Some((low, high))
}

#[cfg(test)]
mod split_ranges_tests {
    use super::*;

    fn split(value: u64) -> Split {
        Split::from_u256(&U256::from_u64(value))
    }

    /// Asserts exact-once, ascending, contiguous coverage of `[start, end]`.
    fn assert_exact_once(start: Split, end: Split, devices: usize) {
        let chunks = split_ranges(start, end, devices);
        assert!(!chunks.is_empty(), "a non-empty range must yield a chunk");
        assert_eq!(chunks[0].0, start, "first chunk must start at START");
        assert_eq!(
            chunks.last().expect("chunks").1,
            end,
            "last chunk must end at END"
        );
        assert!(chunks.len() <= devices.max(1));

        let mut covered = Split::from_u64(0);
        for (index, (low, high)) in chunks.iter().enumerate() {
            assert!(low <= high, "chunk {index} is inverted");
            covered = covered.add(high.sub(*low).add_u64(1)).0;
            if let Some((next_low, _)) = chunks.get(index + 1) {
                assert_eq!(high.add_u64(1), *next_low, "chunks must be adjacent");
            }
        }
        assert_eq!(covered, end.sub(start).add_u64(1), "every key exactly once");
    }

    #[test]
    fn one_device_returns_the_whole_range() {
        assert_eq!(
            split_ranges(split(10), split(20), 1),
            vec![(split(10), split(20))]
        );
    }

    #[test]
    fn several_spans_and_device_counts_cover_exactly_once() {
        for (low, high, devices) in [
            (0u64, 0u64, 1usize),
            (0, 0, 4),
            (1, 10, 3),
            (5, 6, 2),
            (7, 7, 8),
            (0, 1023, 4),
            (0x1000, 0x11FF, 4),
            (100, 1099, 7),
            (0x1F2E_3D4C_5A00, 0x1F2E_3D4C_5A00 + 0x800, 3),
        ] {
            assert_exact_once(split(low), split(high), devices);
        }
    }

    #[test]
    fn last_chunk_is_clipped() {
        // 4 keys over 3 devices -> ceil(4/3) = 2: [10,11], [12,13].
        assert_eq!(
            split_ranges(split(10), split(13), 3),
            vec![(split(10), split(11)), (split(12), split(13))]
        );
        // The range is shorter than the device count: only real keys remain.
        assert_eq!(
            split_ranges(split(7), split(7), 8),
            vec![(split(7), split(7))]
        );
    }

    #[test]
    fn golden_chunk_bounds_match_the_coordinator_protocol() {
        // Coordinator `DEFAULT_CHUNK_WIDTH` is 0x1000_0000. For a job that
        // starts at 0x1000_0000, chunk 3 covers
        // [start + 3 * width, start + 4 * width - 1].
        let start = Split::from_u256(&U256::from_hex("10000000").expect("valid hex"));
        let width = u128::from(DEFAULT_CHUNK_WIDTH);

        let (chunk_start, carry) = start.add(Split::from_u128(3 * width));
        assert!(!carry);
        assert_eq!(chunk_start.to_hex(), "40000000");

        let (candidate, carry) = start.add(Split::from_u128(4 * width));
        assert!(!carry);
        assert_eq!(candidate.sub_u64(1).to_hex(), "4FFFFFFF");

        // A short job clips the candidate at END instead of the chunk width.
        let end = Split::from_u256(&U256::from_hex("41000000").expect("valid hex"));
        assert!(candidate > end);
    }

    #[test]
    fn u256_and_split_round_trip_the_high_boundary() {
        let bytes = [0xFF; 32];
        let split = Split::from_u256(&U256(bytes));
        assert_eq!(split.to_bytes32(), bytes);
        assert_eq!(split.to_hex(), "F".repeat(64));
        assert_eq!(split.bit_length(), 256);

        let (wrapped, carry) = split.add(Split::from_u64(1));
        assert!(carry);
        assert_eq!(wrapped, Split::from_u64(0));
    }
}
