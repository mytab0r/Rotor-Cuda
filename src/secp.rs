//! secp256k1 curve operations and key/address encoding.

use crate::field::Fe;
use crate::hashes;
use crate::point::{Affine, Jacobian};
use crate::scalar::Scalar;

/// Generator x coordinate.
const GX: [u64; 4] = [
    0x59F2_815B_16F8_1798,
    0x029B_FCDB_2DCE_28D9,
    0x55A0_6295_CE87_0B07,
    0x79BE_667E_F9DC_BBAC,
];

/// Generator y coordinate.
const GY: [u64; 4] = [
    0x9C47_D08F_FB10_D4B8,
    0xFD17_B448_A685_5419,
    0x5DA4_FBFC_0E11_08A8,
    0x483A_DA77_26A3_C465,
];

fn curve_b() -> Fe {
    Fe::from_u64(7)
}

pub fn g() -> Affine {
    Affine {
        x: Fe::from_limbs(GX),
        y: Fe::from_limbs(GY),
    }
}

pub fn is_on_curve(point: &Affine) -> bool {
    point.y.square() == point.x.square().mul(&point.x).add(&curve_b())
}

/// Double-and-add multiplication by G.
///
/// # Panics
///
/// A zero scalar yields the point at infinity, which has no affine
/// representation; pass a nonzero scalar.
pub fn mul_g(k: &Scalar) -> Affine {
    let mut accumulator = Jacobian::infinity();
    let generator = g();
    for index in (0..256).rev() {
        accumulator = accumulator.double();
        if k.bit(index) {
            accumulator = accumulator.add_affine(&generator);
        }
    }
    accumulator
        .to_affine()
        .expect("mul_g: the point at infinity has no affine form")
}

/// Double-and-add multiplication; `None` when the result is infinity.
pub fn mul(point: &Affine, k: &Scalar) -> Option<Affine> {
    let mut accumulator = Jacobian::infinity();
    for index in (0..256).rev() {
        accumulator = accumulator.double();
        if k.bit(index) {
            accumulator = accumulator.add_affine(point);
        }
    }
    accumulator.to_affine()
}

/// Add two affine points; `None` when the result is infinity.
pub fn add(a: &Affine, b: &Affine) -> Option<Affine> {
    Jacobian::from_affine(a).add_affine(b).to_affine()
}

pub fn neg(point: &Affine) -> Affine {
    point.neg()
}

/// Parse a public key as 66 hex chars (02/03) or 130 hex chars (04).
///
/// `want_compressed` is set to reflect the encoding of the parsed key.
pub fn parse_pubkey_hex(text: &str, want_compressed: &mut bool) -> Result<Affine, String> {
    let bytes = decode_hex(text).ok_or_else(|| format!("Invalid public key: {text}"))?;
    let x_slice = bytes
        .get(1..33)
        .ok_or_else(|| format!("Invalid public key length: {} hex chars", text.len()))?;
    let x_bytes: [u8; 32] = x_slice.try_into().expect("slice of 32 bytes");

    match bytes.len() {
        33 => {
            let prefix = bytes[0];
            if prefix != 0x02 && prefix != 0x03 {
                return Err(format!("Invalid public key prefix: {prefix:02x}"));
            }
            let x = Fe::from_bytes_be(&x_bytes)
                .ok_or_else(|| format!("Invalid public key: x >= p in {text}"))?;
            let rhs = x.square().mul(&x).add(&curve_b());
            let mut y = rhs
                .sqrt()
                .ok_or_else(|| format!("Invalid public key: x is not on the curve in {text}"))?;
            if y.is_odd() != (prefix == 0x03) {
                y = y.neg();
            }
            *want_compressed = true;
            Ok(Affine { x, y })
        }
        65 => {
            if bytes[0] != 0x04 {
                return Err(format!("Invalid public key prefix: {:02x}", bytes[0]));
            }
            let y_bytes: [u8; 32] = bytes[33..65].try_into().expect("slice of 32 bytes");
            let x = Fe::from_bytes_be(&x_bytes)
                .ok_or_else(|| format!("Invalid public key: x >= p in {text}"))?;
            let y = Fe::from_bytes_be(&y_bytes)
                .ok_or_else(|| format!("Invalid public key: y >= p in {text}"))?;
            let point = Affine { x, y };
            if !is_on_curve(&point) {
                return Err(format!(
                    "Invalid public key: point is not on the curve in {text}"
                ));
            }
            *want_compressed = false;
            Ok(point)
        }
        length => Err(format!(
            "Invalid public key length: {} hex chars ({length} bytes)",
            text.len()
        )),
    }
}

pub fn compress(point: &Affine) -> [u8; 33] {
    let mut out = [0u8; 33];
    out[0] = if point.y.is_odd() { 0x03 } else { 0x02 };
    out[1..].copy_from_slice(&point.x.to_bytes_be());
    out
}

pub fn uncompress(point: &Affine) -> [u8; 65] {
    let mut out = [0u8; 65];
    out[0] = 0x04;
    out[1..33].copy_from_slice(&point.x.to_bytes_be());
    out[33..].copy_from_slice(&point.y.to_bytes_be());
    out
}

/// RIPEMD-160 of the serialized public key.
pub fn hash160(point: &Affine, compressed: bool) -> [u8; 20] {
    if compressed {
        hashes::hash160(&compress(point))
    } else {
        hashes::hash160(&uncompress(point))
    }
}

/// Ethereum address: the last 20 bytes of keccak256(x || y).
pub fn eth_address(point: &Affine) -> [u8; 20] {
    let mut coordinates = [0u8; 64];
    coordinates[..32].copy_from_slice(&point.x.to_bytes_be());
    coordinates[32..].copy_from_slice(&point.y.to_bytes_be());
    let hash = hashes::keccak256(&coordinates);
    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..]);
    address
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok())
        .collect()
}
