//! Arithmetic in the secp256k1 base field GF(p).
//!
//! p = 2^256 - 2^32 - 977. Elements are canonical little-endian
//! [`u64`; 4] limbs, not Montgomery form.

#![allow(clippy::needless_range_loop)] // fixed-size limb loops read better with indices

use core::cmp::Ordering;
use std::fmt::Write;

/// p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F.
const P: [u64; 4] = [
    0xFFFF_FFFE_FFFF_FC2F,
    0xFFFF_FFFF_FFFF_FFFF,
    0xFFFF_FFFF_FFFF_FFFF,
    0xFFFF_FFFF_FFFF_FFFF,
];

/// 2^256 mod p.
const TWO256_MOD_P: u64 = 0x1_0000_03D1;

/// p - 2, the exponent used for inversion.
const P_MINUS_2: [u64; 4] = [
    0xFFFF_FFFE_FFFF_FC2D,
    0xFFFF_FFFF_FFFF_FFFF,
    0xFFFF_FFFF_FFFF_FFFF,
    0xFFFF_FFFF_FFFF_FFFF,
];

/// (p + 1) / 4, the exponent used for the square root (p = 3 mod 4).
const SQRT_EXP: [u64; 4] = [
    0xFFFF_FFFF_BFFF_FF0C,
    0xFFFF_FFFF_FFFF_FFFF,
    0xFFFF_FFFF_FFFF_FFFF,
    0x3FFF_FFFF_FFFF_FFFF,
];

/// An element of GF(p) in canonical little-endian limbs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fe([u64; 4]);

impl Fe {
    pub const ZERO: Fe = Fe([0, 0, 0, 0]);
    pub const ONE: Fe = Fe([1, 0, 0, 0]);

    /// Wrap raw limbs. Only for trusted compile-time constants.
    pub(crate) const fn from_limbs(limbs: [u64; 4]) -> Fe {
        Fe(limbs)
    }

    pub const fn from_u64(value: u64) -> Fe {
        Fe([value, 0, 0, 0])
    }

    /// Parse at most 64 hexadecimal digits; rejects values greater than or
    /// equal to p.
    pub fn from_hex(text: &str) -> Option<Fe> {
        if text.is_empty() || text.len() > 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mut bytes = [0u8; 32];
        for (index, byte) in text.bytes().rev().enumerate() {
            let nibble = (byte as char).to_digit(16)? as u8;
            bytes[31 - index / 2] |= nibble << (4 * (index % 2));
        }
        Fe::from_bytes_be(&bytes)
    }

    /// Always 64 lowercase hexadecimal digits.
    pub fn to_hex(&self) -> String {
        let mut out = String::with_capacity(64);
        for byte in self.to_bytes_be() {
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    pub fn from_bytes_be(bytes: &[u8; 32]) -> Option<Fe> {
        let mut limbs = [0u64; 4];
        for i in 0..4 {
            let mut limb = 0u64;
            for j in 0..8 {
                limb = (limb << 8) | u64::from(bytes[(3 - i) * 8 + j]);
            }
            limbs[i] = limb;
        }
        if cmp_limbs(&limbs, &P) == Ordering::Less {
            Some(Fe(limbs))
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
    pub fn add(&self, other: &Fe) -> Fe {
        let (sum, carry) = add_limbs(&self.0, &other.0);
        if carry || cmp_limbs(&sum, &P) != Ordering::Less {
            Fe(sub_limbs(&sum, &P).0)
        } else {
            Fe(sum)
        }
    }

    #[inline]
    pub fn sub(&self, other: &Fe) -> Fe {
        let (difference, borrow) = sub_limbs(&self.0, &other.0);
        if borrow {
            Fe(add_limbs(&difference, &P).0)
        } else {
            Fe(difference)
        }
    }

    #[inline]
    pub fn neg(&self) -> Fe {
        if self.is_zero() {
            Fe::ZERO
        } else {
            Fe(sub_limbs(&P, &self.0).0)
        }
    }

    #[inline]
    pub fn double(&self) -> Fe {
        self.add(self)
    }

    #[inline]
    pub fn mul(&self, other: &Fe) -> Fe {
        Fe(reduce(mul_wide(&self.0, &other.0)))
    }

    #[inline]
    pub fn square(&self) -> Fe {
        self.mul(self)
    }

    /// Square-and-multiply from the most significant bit.
    pub fn pow_limbs(&self, exponent: &[u64; 4]) -> Fe {
        let mut result = Fe::ONE;
        for index in (0..256).rev() {
            result = result.square();
            if (exponent[index / 64] >> (index % 64)) & 1 == 1 {
                result = result.mul(self);
            }
        }
        result
    }

    /// Multiplicative inverse via `a^(p-2)`; `None` for zero.
    pub fn invert(&self) -> Option<Fe> {
        if self.is_zero() {
            None
        } else {
            Some(self.pow_limbs(&P_MINUS_2))
        }
    }

    /// Square root via `a^((p+1)/4)`, verified by squaring.
    pub fn sqrt(&self) -> Option<Fe> {
        let root = self.pow_limbs(&SQRT_EXP);
        if root.square() == *self {
            Some(root)
        } else {
            None
        }
    }

    #[inline]
    pub fn is_zero(&self) -> bool {
        self.0 == [0, 0, 0, 0]
    }

    #[inline]
    pub fn is_odd(&self) -> bool {
        self.0[0] & 1 == 1
    }
}

impl Ord for Fe {
    fn cmp(&self, other: &Self) -> Ordering {
        cmp_limbs(&self.0, &other.0)
    }
}

impl PartialOrd for Fe {
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

/// Reduce a 512-bit product modulo p using `2^256 = 0x1000003D1 (mod p)`.
#[inline]
fn reduce(product: [u64; 8]) -> [u64; 4] {
    let mut low = [product[0], product[1], product[2], product[3]];
    let mut high = [product[4], product[5], product[6], product[7]];

    while high != [0, 0, 0, 0] {
        // high * 0x1000003D1 fits in five limbs.
        let mut folded = [0u64; 5];
        let mut carry = 0u128;
        for i in 0..4 {
            let value = u128::from(high[i]) * u128::from(TWO256_MOD_P) + carry;
            folded[i] = value as u64;
            carry = value >> 64;
        }
        folded[4] = carry as u64;

        let mut carry = 0u128;
        for i in 0..4 {
            let value = u128::from(low[i]) + u128::from(folded[i]) + carry;
            low[i] = value as u64;
            carry = value >> 64;
        }
        high = [folded[4] + carry as u64, 0, 0, 0];
    }

    if cmp_limbs(&low, &P) != Ordering::Less {
        low = sub_limbs(&low, &P).0;
    }
    low
}
