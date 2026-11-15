//! Arithmetic in GF(n), the scalar field of secp256k1.
//!
//! n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141.
//! Not performance critical; multiplication uses a 512-bit product followed by
//! a simple bitwise reduction.

#![allow(clippy::needless_range_loop)] // fixed-size limb loops read better with indices

use core::cmp::Ordering;
use std::fmt::Write;

/// The curve order n.
const N: [u64; 4] = [
    0xBFD2_5E8C_D036_4141,
    0xBAAE_DCE6_AF48_A03B,
    0xFFFF_FFFF_FFFF_FFFE,
    0xFFFF_FFFF_FFFF_FFFF,
];

/// n sign-extended to five limbs, for the reduction loop.
const N_EXT: [u64; 5] = [N[0], N[1], N[2], N[3], 0];

/// An element of GF(n) in canonical little-endian limbs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scalar([u64; 4]);

impl Scalar {
    pub const ZERO: Scalar = Scalar([0, 0, 0, 0]);
    pub const ONE: Scalar = Scalar([1, 0, 0, 0]);

    pub const fn from_u64(value: u64) -> Scalar {
        Scalar([value, 0, 0, 0])
    }

    /// Parse at most 64 hexadecimal digits; rejects values greater than or
    /// equal to n.
    pub fn from_hex(text: &str) -> Option<Scalar> {
        if text.is_empty() || text.len() > 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mut bytes = [0u8; 32];
        for (index, byte) in text.bytes().rev().enumerate() {
            let nibble = (byte as char).to_digit(16)? as u8;
            bytes[31 - index / 2] |= nibble << (4 * (index % 2));
        }
        Scalar::from_bytes_be(&bytes)
    }

    /// Always 64 lowercase hexadecimal digits.
    pub fn to_hex(&self) -> String {
        let mut out = String::with_capacity(64);
        for byte in self.to_bytes_be() {
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    pub fn from_bytes_be(bytes: &[u8; 32]) -> Option<Scalar> {
        let mut limbs = [0u64; 4];
        for i in 0..4 {
            let mut limb = 0u64;
            for j in 0..8 {
                limb = (limb << 8) | u64::from(bytes[(3 - i) * 8 + j]);
            }
            limbs[i] = limb;
        }
        if cmp_limbs(&limbs, &N) == Ordering::Less {
            Some(Scalar(limbs))
        } else {
            None
        }
    }

    pub fn to_bytes_be(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..4 {
            out[i * 8..i * 8 + 8].copy_from_slice(&self.0[3 - i].to_be_bytes());
        }
        out
    }

    #[inline]
    pub fn add(&self, other: &Scalar) -> Scalar {
        let (sum, carry) = add_limbs(&self.0, &other.0);
        if carry || cmp_limbs(&sum, &N) != Ordering::Less {
            Scalar(sub_limbs(&sum, &N).0)
        } else {
            Scalar(sum)
        }
    }

    #[inline]
    pub fn sub(&self, other: &Scalar) -> Scalar {
        let (difference, borrow) = sub_limbs(&self.0, &other.0);
        if borrow {
            Scalar(add_limbs(&difference, &N).0)
        } else {
            Scalar(difference)
        }
    }

    #[inline]
    pub fn add_u64(&self, value: u64) -> Scalar {
        let mut limbs = self.0;
        let mut carry = u128::from(value);
        for limb in limbs.iter_mut() {
            let sum = u128::from(*limb) + carry;
            *limb = sum as u64;
            carry = sum >> 64;
        }
        if cmp_limbs(&limbs, &N) != Ordering::Less {
            limbs = sub_limbs(&limbs, &N).0;
        }
        Scalar(limbs)
    }

    pub fn mul(&self, other: &Scalar) -> Scalar {
        let product = mul_wide(&self.0, &other.0);
        // Long division by n, one bit at a time; the accumulator stays below n
        // so it never needs more than 257 bits.
        let mut accumulator = [0u64; 5];
        for index in (0..512).rev() {
            let mut carry = (product[index / 64] >> (index % 64)) & 1;
            for limb in accumulator.iter_mut() {
                let next = *limb >> 63;
                *limb = (*limb << 1) | carry;
                carry = next;
            }
            if cmp_limbs5(&accumulator, &N_EXT) != Ordering::Less {
                sub_limbs5(&mut accumulator, &N_EXT);
            }
        }
        Scalar([
            accumulator[0],
            accumulator[1],
            accumulator[2],
            accumulator[3],
        ])
    }

    #[inline]
    pub fn is_zero(&self) -> bool {
        self.0 == [0, 0, 0, 0]
    }

    /// `index` 0 is the least significant bit; out-of-range indices are zero.
    #[inline]
    pub fn bit(&self, index: usize) -> bool {
        index < 256 && (self.0[index / 64] >> (index % 64)) & 1 == 1
    }
}

impl Ord for Scalar {
    fn cmp(&self, other: &Self) -> Ordering {
        cmp_limbs(&self.0, &other.0)
    }
}

impl PartialOrd for Scalar {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[inline]
fn cmp_limbs(a: &[u64; 4], b: &[u64; 4]) -> Ordering {
    for i in (0..4).rev() {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    Ordering::Equal
}

#[inline]
fn cmp_limbs5(a: &[u64; 5], b: &[u64; 5]) -> Ordering {
    for i in (0..5).rev() {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    Ordering::Equal
}

#[inline]
fn add_limbs(a: &[u64; 4], b: &[u64; 4]) -> ([u64; 4], bool) {
    let mut out = [0u64; 4];
    let mut carry = false;
    for i in 0..4 {
        let (partial, first) = a[i].overflowing_add(b[i]);
        let (sum, second) = partial.overflowing_add(u64::from(carry));
        out[i] = sum;
        carry = first || second;
    }
    (out, carry)
}

#[inline]
fn sub_limbs(a: &[u64; 4], b: &[u64; 4]) -> ([u64; 4], bool) {
    let mut out = [0u64; 4];
    let mut borrow = false;
    for i in 0..4 {
        let (partial, first) = a[i].overflowing_sub(b[i]);
        let (difference, second) = partial.overflowing_sub(u64::from(borrow));
        out[i] = difference;
        borrow = first || second;
    }
    (out, borrow)
}

#[inline]
fn sub_limbs5(a: &mut [u64; 5], b: &[u64; 5]) {
    let mut borrow = false;
    for i in 0..5 {
        let (partial, first) = a[i].overflowing_sub(b[i]);
        let (difference, second) = partial.overflowing_sub(u64::from(borrow));
        a[i] = difference;
        borrow = first || second;
    }
}

/// 4x4 schoolbook multiplication into eight limbs.
#[inline]
fn mul_wide(a: &[u64; 4], b: &[u64; 4]) -> [u64; 8] {
    let mut out = [0u64; 8];
    for i in 0..4 {
        let mut carry = 0u128;
        for j in 0..4 {
            let value = u128::from(a[i]) * u128::from(b[j]) + u128::from(out[i + j]) + carry;
            out[i + j] = value as u64;
            carry = value >> 64;
        }
        out[i + 4] = carry as u64;
    }
    out
}
