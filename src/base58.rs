//! Base58Check and WIF encoding.

use crate::hashes::sha256d;
use crate::scalar::Scalar;

const WIF_VERSION: u8 = 0x80;
const P2PKH_VERSION: u8 = 0x00;
const WIF_COMPRESSED_FLAG: u8 = 0x01;

/// Decode a Base58Check string and verify its four-byte double-SHA256
/// checksum.
pub fn decode_check(text: &str) -> Result<Vec<u8>, String> {
    let raw = bs58::decode(text)
        .into_vec()
        .map_err(|err| format!("Invalid Base58 string: {err}"))?;
    if raw.len() < 4 {
        return Err("Invalid Base58Check string: too short".to_owned());
    }
    let (payload, checksum) = raw.split_at(raw.len() - 4);
    let calculated = sha256d(payload);
    if calculated[..4] != *checksum {
        return Err("Invalid Base58Check checksum".to_owned());
    }
    Ok(payload.to_vec())
}

/// Append a four-byte double-SHA256 checksum and encode as Base58.
pub fn encode_check(payload: &[u8]) -> String {
    let checksum = sha256d(payload);
    let mut data = Vec::with_capacity(payload.len() + 4);
    data.extend_from_slice(payload);
    data.extend_from_slice(&checksum[..4]);
    bs58::encode(data).into_string()
}

/// Decode a WIF private key, returning the scalar and whether the key is
/// compressed.
pub fn decode_wif(text: &str) -> Result<(Scalar, bool), String> {
    let data = decode_check(text)?;
    match data.first() {
        Some(&WIF_VERSION) => {}
        Some(&version) => {
            return Err(format!("Invalid WIF version: 0x{version:02x}"));
        }
        None => return Err("Invalid WIF: empty payload".to_owned()),
    }

    let key_bytes: [u8; 32] = data
        .get(1..33)
        .ok_or_else(|| "Invalid WIF: payload shorter than the private key".to_owned())?
        .try_into()
        .expect("slice of 32 bytes");
    let scalar = Scalar::from_bytes_be(&key_bytes)
        .ok_or_else(|| "Invalid WIF: private key is not below the curve order".to_owned())?;

    let compressed = match data.len() {
        33 => false,
        34 if data[33] == WIF_COMPRESSED_FLAG => true,
        34 => return Err("Invalid WIF: bad compression flag".to_owned()),
        length => return Err(format!("Invalid WIF payload length: {length}")),
    };

    Ok((scalar, compressed))
}

/// P2PKH address for a hash160; `compressed` is part of the signature for
/// parity with the C++ code but does not affect the address itself.
pub fn address_from_hash160(hash: &[u8; 20], _compressed: bool) -> String {
    let mut payload = [0u8; 21];
    payload[0] = P2PKH_VERSION;
    payload[1..].copy_from_slice(hash);
    encode_check(&payload)
}

pub fn wif_encode(key: &Scalar, compressed: bool) -> String {
    let mut payload = [0u8; 34];
    payload[0] = WIF_VERSION;
    payload[1..33].copy_from_slice(&key.to_bytes_be());
    let length = if compressed {
        payload[33] = WIF_COMPRESSED_FLAG;
        34
    } else {
        33
    };
    encode_check(&payload[..length])
}
