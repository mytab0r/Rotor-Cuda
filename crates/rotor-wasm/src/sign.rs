//! Deterministic secp256k1 ECDSA as specified by RFC 6979.
//!
//! The nonce generator is HMAC-SHA256 (RFC 6979 §3.2) over the 32-byte
//! message hash and the 32-byte private key. Signatures are returned in
//! compact `r || s` form with low-S normalisation, so the recovery id is
//! always 0 or 1 in practice (`x(R) >= n` would add 2, which is
//! cryptographically negligible and is reported honestly when it happens).
//!
//! The curve arithmetic reuses the parent package's `scalar`, `field`,
//! `point` and `secp` modules; only the HMAC layer is new.

use hmac::{Hmac, Mac};
use sha2_010::Sha256;

use crate::derive::reduce_mod_n;
use crate::field::Fe;
use crate::point::Affine;
use crate::scalar::Scalar;
use crate::secp;

type HmacSha256 = Hmac<Sha256>;

/// `n / 2`, the low-S boundary. Any `s` above it is replaced by `n - s`.
fn n_half() -> Scalar {
    Scalar::from_hex("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0")
        .expect("n/2 is below the curve order")
}

/// `n - 2`, the exponent used for the Fermat inversion `a^(n-2) mod n`.
fn n_minus_two() -> Scalar {
    Scalar::from_hex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd036413f")
        .expect("n - 2 is below the curve order")
}

/// A compact signature: `r`, `s` and the parity bit of `R.y`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Signature {
    pub r: Scalar,
    pub s: Scalar,
    /// 0 or 1 (bit 0 of the recovery id); +2 only when `R.x >= n`.
    pub recovery: u8,
}

impl Signature {
    /// `r || s`, 64 bytes, zero-padded big-endian.
    pub fn compact(&self) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&self.r.to_bytes_be());
        out[32..].copy_from_slice(&self.s.to_bytes_be());
        out
    }
}

/// Sign a 32-byte message hash with a 32-byte private key.
///
/// The key must be a scalar in `1..n`; zero and values at or above the curve
/// order are rejected. The returned signature is deterministic and low-S.
pub fn sign(hash: &[u8; 32], key: &[u8; 32]) -> Result<Signature, String> {
    let d = Scalar::from_bytes_be(key)
        .ok_or_else(|| "private key is not below the secp256k1 curve order".to_owned())?;
    if d.is_zero() {
        return Err("private key must be in the range 1..n-1".to_owned());
    }
    sign_scalar(hash, &d)
}

fn sign_scalar(hash: &[u8; 32], d: &Scalar) -> Result<Signature, String> {
    let z = reduce_mod_n(hash);
    let mut nonces = NonceGenerator::new(&d.to_bytes_be(), hash);

    loop {
        let k = nonces.next();
        let point = secp::mul_g(&k);
        let r = reduce_mod_n(&point.x.to_bytes_be());
        if r.is_zero() {
            continue;
        }
        // 2 is included only when x(R) >= n, which is astronomically rare.
        let mut recovery = u8::from(point.y.is_odd())
            | if Scalar::from_bytes_be(&point.x.to_bytes_be()).is_none() {
                2
            } else {
                0
            };

        let s = invert(&k).mul(&z.add(&r.mul(d)));
        if s.is_zero() {
            continue;
        }
        let mut s = s;
        if s > n_half() {
            s = Scalar::ZERO.sub(&s);
            recovery ^= 1;
        }
        return Ok(Signature { r, s, recovery });
    }
}

/// Verify `(r, s)` over `hash` against a public key using plain ECDSA.
pub fn verify(pubkey: &Affine, hash: &[u8; 32], r: &Scalar, s: &Scalar) -> bool {
    if r.is_zero() || s.is_zero() {
        return false;
    }
    let z = reduce_mod_n(hash);
    let w = invert(s);
    let u1 = z.mul(&w);
    let u2 = r.mul(&w);

    let p1 = secp::mul(&secp::g(), &u1);
    let p2 = secp::mul(pubkey, &u2);
    let Some(sum) = combine(&p1, &p2) else {
        return false;
    };
    reduce_mod_n(&sum.x.to_bytes_be()) == *r
}

/// Recover the signer's public key from a signature and its recovery id.
///
/// Recovery ids above 1 (`x(R) >= n`) are rejected; they cannot be produced by
/// [`sign`] in practice and no known chain uses them.
pub fn recover(hash: &[u8; 32], signature: &Signature) -> Result<Affine, String> {
    if signature.r.is_zero() || signature.s.is_zero() {
        return Err("cannot recover from a zero r or s".to_owned());
    }
    if signature.recovery > 1 {
        return Err(format!(
            "unsupported recovery id {} (only 0 and 1 are used)",
            signature.recovery
        ));
    }

    // R = the curve point with x = r and the parity from the recovery id.
    let x = Fe::from_bytes_be(&signature.r.to_bytes_be())
        .ok_or_else(|| "r is not a valid x coordinate".to_owned())?;
    let rhs = x.square().mul(&x).add(&Fe::from_u64(7));
    let mut y = rhs
        .sqrt()
        .ok_or_else(|| "r is not the x coordinate of a curve point".to_owned())?;
    if y.is_odd() != (signature.recovery == 1) {
        y = y.neg();
    }
    let r_point = Affine { x, y };

    // Q = r^-1 (sR - zG).
    let r_inv = invert(&signature.r);
    let z = reduce_mod_n(hash);
    let u1 = Scalar::ZERO.sub(&z).mul(&r_inv);
    let u2 = signature.s.mul(&r_inv);
    let p1 = secp::mul(&secp::g(), &u1);
    let p2 = secp::mul(&r_point, &u2);
    combine(&p1, &p2).ok_or_else(|| "recovered public key is the point at infinity".to_owned())
}

/// Sum of two optional points; `None` when both are infinity or they cancel.
fn combine(first: &Option<Affine>, second: &Option<Affine>) -> Option<Affine> {
    match (first, second) {
        (Some(a), Some(b)) => secp::add(a, b),
        (Some(a), None) => Some(*a),
        (None, Some(b)) => Some(*b),
        (None, None) => None,
    }
}

/// `a^(n-2) mod n`, the multiplicative inverse for `a != 0`.
fn invert(a: &Scalar) -> Scalar {
    let exponent = n_minus_two();
    let mut result = Scalar::ONE;
    let mut base = *a;
    for index in 0..256 {
        if exponent.bit(index) {
            result = result.mul(&base);
        }
        base = base.mul(&base);
    }
    result
}

/// RFC 6979 §3.2 HMAC-SHA256 nonce generator.
struct NonceGenerator {
    v: [u8; 32],
    k: [u8; 32],
}

impl NonceGenerator {
    fn new(private_key: &[u8; 32], hash: &[u8; 32]) -> NonceGenerator {
        // RFC 6979 bits2octets: reduce the hash modulo the group order.
        let h1 = reduce_mod_n(hash).to_bytes_be();
        let mut this = NonceGenerator {
            v: [0x01; 32],
            k: [0x00; 32],
        };
        this.k = hmac(&this.k, &[&this.v, &[0x00], private_key, &h1]);
        this.v = hmac(&this.k, &[&this.v]);
        this.k = hmac(&this.k, &[&this.v, &[0x01], private_key, &h1]);
        this.v = hmac(&this.k, &[&this.v]);
        this
    }

    /// Next candidate nonce, retrying per RFC 6979 until it is in `1..n`.
    fn next(&mut self) -> Scalar {
        loop {
            self.v = hmac(&self.k, &[&self.v]);
            if let Some(candidate) = Scalar::from_bytes_be(&self.v)
                && !candidate.is_zero()
            {
                return candidate;
            }
            self.k = hmac(&self.k, &[&self.v, &[0x00]]);
            self.v = hmac(&self.k, &[&self.v]);
        }
    }
}

impl Drop for NonceGenerator {
    fn drop(&mut self) {
        wipe(&mut self.v);
        wipe(&mut self.k);
    }
}

/// Zero a byte buffer without the compiler eliding the writes.
pub(crate) fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        // SAFETY: a volatile write to a valid, uniquely borrowed byte.
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
}

fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any length");
    for part in parts {
        mac.update(part);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_to_bytes(text: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (index, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).unwrap();
        }
        out
    }

    fn sha256_hex(text: &str) -> [u8; 32] {
        crate::hashes::sha256(text.as_bytes())
    }

    /// RFC 6979 A.2.5: key 1, message "Satoshi Nakamoto".
    #[test]
    fn rfc6979_a25_vector() {
        let key = hex_to_bytes("0000000000000000000000000000000000000000000000000000000000000001");
        let hash = sha256_hex("Satoshi Nakamoto");
        let signature = sign(&hash, &key).expect("sign");
        assert_eq!(
            signature.r.to_hex(),
            "934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8"
        );
        assert_eq!(
            signature.s.to_hex(),
            "2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5"
        );
        assert_eq!(signature.recovery & 1, 1);

        let public = secp::mul_g(&Scalar::from_u64(1));
        assert!(verify(&public, &hash, &signature.r, &signature.s));
        let recovered = recover(&hash, &signature).expect("recover");
        assert_eq!(secp::compress(&recovered), secp::compress(&public));
    }

    #[test]
    fn signature_verifies_and_rejects_tampering() {
        let key = hex_to_bytes("0000000000000000000000000000000000000000000000000000000000000001");
        let hash = sha256_hex("cabinet wallet signing");
        let public = secp::mul_g(&Scalar::from_u64(1));
        let signature = sign(&hash, &key).unwrap();
        assert!(verify(&public, &hash, &signature.r, &signature.s));

        let other_hash = sha256_hex("cabinet wallet signing!");
        assert!(!verify(&public, &other_hash, &signature.r, &signature.s));

        let other_public = secp::mul_g(&Scalar::from_u64(2));
        assert!(!verify(&other_public, &hash, &signature.r, &signature.s));
    }

    #[test]
    fn signatures_are_deterministic_and_low_s() {
        let key = hex_to_bytes("4c0b6c2b4f0a5d9e8f1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcd00");
        let hash = sha256_hex("determinism");
        let first = sign(&hash, &key).unwrap();
        let second = sign(&hash, &key).unwrap();
        assert_eq!(first, second);
        assert!(first.s <= n_half());
    }

    #[test]
    fn rejects_invalid_private_keys() {
        let hash = sha256_hex("keys");
        assert!(sign(&hash, &[0u8; 32]).is_err());

        let n = hex_to_bytes("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
        assert!(sign(&hash, &n).is_err());
    }
}
