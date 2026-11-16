//! Private-key derivation report: every address encoding for one key.
//!
//! The output is a UTF-8 JSON document with a fixed set of string fields.
//! All values are hex, base58, decimal, binary or fixed English labels, so
//! the serializer below needs no escaping.

use std::fmt::Write as _;

use ed25519_dalek::SigningKey;

use crate::scalar::Scalar;
use crate::{base58, bech32, hashes, secp};

/// secp256k1 curve order n, big-endian.
const N_BYTES: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// Build the JSON report for `curve`: 0 secp256k1, 1 ed25519.
pub fn report(key: &[u8; 32], curve: u32) -> Result<String, String> {
    match curve {
        0 => secp_report(key),
        1 => ed25519_report(key),
        other => Err(format!("unsupported curve: {other}")),
    }
}

fn secp_report(key: &[u8; 32]) -> Result<String, String> {
    let scalar = Scalar::from_bytes_be(key)
        .ok_or_else(|| "secp256k1 private key is not below the curve order".to_owned())?;
    if scalar.is_zero() {
        return Err("secp256k1 private key must be in the range 1..n-1".to_owned());
    }

    let point = secp::mul_g(&scalar);
    let compressed = secp::compress(&point);
    let uncompressed = secp::uncompress(&point);
    let hash_compressed = hashes::hash160(&compressed);
    let hash_uncompressed = hashes::hash160(&uncompressed);

    let compressed_hex = hex(&compressed);
    let uncompressed_hex = hex(&uncompressed);
    let hash_compressed_hex = hex(&hash_compressed);
    let hash_uncompressed_hex = hex(&hash_uncompressed);
    let x_hex = hex(&point.x.to_bytes_be());
    let y_hex = hex(&point.y.to_bytes_be());

    let (compressed_payload, compressed_checksum, compressed_address) =
        p2pkh_parts(&hash_compressed);
    let (uncompressed_payload, uncompressed_checksum, uncompressed_address) =
        p2pkh_parts(&hash_uncompressed);
    let compressed_payload_hex = hex(&compressed_payload);
    let compressed_checksum_hex = hex(&compressed_checksum);
    let uncompressed_payload_hex = hex(&uncompressed_payload);
    let uncompressed_checksum_hex = hex(&uncompressed_checksum);

    // P2SH-P2WPKH: redeem script 0x0014 || hash160(compressed pubkey).
    let mut redeem = [0u8; 22];
    redeem[1] = 0x14;
    redeem[2..].copy_from_slice(&hash_compressed);
    let redeem_hex = hex(&redeem);
    let script_hash = hashes::hash160(&redeem);
    let script_hash_hex = hex(&script_hash);
    let mut p2sh_payload = [0u8; 21];
    p2sh_payload[0] = 0x05;
    p2sh_payload[1..].copy_from_slice(&script_hash);
    let p2sh_payload_hex = hex(&p2sh_payload);
    let p2sh_digest = hashes::sha256d(&p2sh_payload);
    let p2sh_checksum_hex = hex(&p2sh_digest[..4]);
    let p2sh_address = base58::encode_check(&p2sh_payload);

    // P2WPKH: witness v0 over hash160(compressed pubkey).
    let (p2wpkh_address, p2wpkh_checksum) = bech32::encode_segwit("bc", 0, &hash_compressed, false);

    // P2TR: BIP341 key path with an empty script tree. The internal key is the
    // x-only key, so it is lift_x(x(P)): a point with odd y is negated before
    // the tweak is added.
    let internal_x = point.x.to_bytes_be();
    let internal_x_hex = hex(&internal_x);
    let tweak = tagged_hash(b"TapTweak", &internal_x);
    let tweak_hex = hex(&tweak);
    let tweak_scalar = reduce_mod_n(&tweak);
    let internal = if point.y.is_odd() { point.neg() } else { point };
    let output = if tweak_scalar.is_zero() {
        internal
    } else {
        let tweak_point = secp::mul(&secp::g(), &tweak_scalar)
            .ok_or_else(|| "taproot tweak is the point at infinity".to_owned())?;
        secp::add(&internal, &tweak_point)
            .ok_or_else(|| "taproot output key is the point at infinity".to_owned())?
    };
    let output_x = output.x.to_bytes_be();
    let output_x_hex = hex(&output_x);
    let parity = if output.y.is_odd() { "1" } else { "0" };
    let (p2tr_address, p2tr_checksum) = bech32::encode_segwit("bc", 1, &output_x, true);

    // EVM: last 20 bytes of keccak256(x || y), EIP-55 displayed. TRON reuses
    // the same twenty bytes behind the 0x41 version byte.
    let keccak = hashes::keccak256(&uncompressed[1..]);
    let keccak_hex = hex(&keccak);
    let mut last20 = [0u8; 20];
    last20.copy_from_slice(&keccak[12..]);
    let last20_hex = hex(&last20);
    let evm_address = eip55(&last20);

    let mut tron_payload = [0u8; 21];
    tron_payload[0] = 0x41;
    tron_payload[1..].copy_from_slice(&last20);
    let tron_payload_hex = hex(&tron_payload);
    let tron_digest = hashes::sha256d(&tron_payload);
    let tron_checksum_hex = hex(&tron_digest[..4]);
    let tron_address = base58::encode_check(&tron_payload);

    let addresses = [
        address_object(
            "btc_p2pkh",
            "Bitcoin legacy (compressed)",
            &compressed_address,
            &[
                ("pubkey", &compressed_hex),
                ("hash160", &hash_compressed_hex),
                ("payload", &compressed_payload_hex),
                ("checksum", &compressed_checksum_hex),
                ("base58", &compressed_address),
            ],
        ),
        address_object(
            "btc_p2pkh_uncompressed",
            "Bitcoin legacy (uncompressed)",
            &uncompressed_address,
            &[
                ("pubkey", &uncompressed_hex),
                ("hash160", &hash_uncompressed_hex),
                ("payload", &uncompressed_payload_hex),
                ("checksum", &uncompressed_checksum_hex),
                ("base58", &uncompressed_address),
            ],
        ),
        address_object(
            "btc_p2sh_p2wpkh",
            "Bitcoin P2SH-P2WPKH",
            &p2sh_address,
            &[
                ("redeem", &redeem_hex),
                ("script_hash", &script_hash_hex),
                ("payload", &p2sh_payload_hex),
                ("checksum", &p2sh_checksum_hex),
            ],
        ),
        address_object(
            "btc_p2wpkh",
            "Bitcoin native segwit",
            &p2wpkh_address,
            &[
                ("hrp", "bc"),
                ("witness_version", "0"),
                ("program", &hash_compressed_hex),
                ("checksum", &p2wpkh_checksum),
            ],
        ),
        address_object(
            "btc_p2tr",
            "Bitcoin taproot",
            &p2tr_address,
            &[
                ("internal_x", &internal_x_hex),
                ("tweak", &tweak_hex),
                ("output_x", &output_x_hex),
                ("parity", parity),
                ("program", &output_x_hex),
                ("checksum", &p2tr_checksum),
            ],
        ),
        address_object(
            "evm",
            "Ethereum / EVM",
            &evm_address,
            &[("keccak", &keccak_hex), ("last20", &last20_hex)],
        ),
        address_object(
            "tron",
            "TRON",
            &tron_address,
            &[
                ("payload", &tron_payload_hex),
                ("checksum", &tron_checksum_hex),
                ("base58", &tron_address),
            ],
        ),
        address_object("solana", "Solana (ed25519)", "", &[("pubkey", "")]),
    ];

    let mut out = String::with_capacity(4096);
    out.push('{');
    push_field(&mut out, "curve", "secp256k1");
    push_field(&mut out, "priv_hex", &hex(key));
    push_field(&mut out, "priv_dec", &decimal(key));
    push_field(&mut out, "priv_bin", &binary(key));
    push_field(&mut out, "pubkey_compressed", &compressed_hex);
    push_field(&mut out, "pubkey_uncompressed", &uncompressed_hex);
    push_field(&mut out, "x", &x_hex);
    push_field(&mut out, "y", &y_hex);
    push_field(&mut out, "ed_pubkey", "");
    push_field(
        &mut out,
        "wif_compressed",
        &base58::wif_encode(&scalar, true),
    );
    push_field(
        &mut out,
        "wif_uncompressed",
        &base58::wif_encode(&scalar, false),
    );
    push_addresses(&mut out, &addresses);
    Ok(out)
}

fn ed25519_report(key: &[u8; 32]) -> Result<String, String> {
    let public = SigningKey::from_bytes(key).verifying_key().to_bytes();
    let public_hex = hex(&public);
    let address = bs58::encode(public).into_string();

    let addresses = [address_object(
        "solana",
        "Solana (ed25519)",
        &address,
        &[("pubkey", &public_hex)],
    )];

    let mut out = String::with_capacity(1024);
    out.push('{');
    push_field(&mut out, "curve", "ed25519");
    push_field(&mut out, "priv_hex", &hex(key));
    push_field(&mut out, "priv_dec", &decimal(key));
    push_field(&mut out, "priv_bin", &binary(key));
    push_field(&mut out, "pubkey_compressed", "");
    push_field(&mut out, "pubkey_uncompressed", "");
    push_field(&mut out, "x", "");
    push_field(&mut out, "y", "");
    push_field(&mut out, "ed_pubkey", &public_hex);
    push_field(&mut out, "wif_compressed", "");
    push_field(&mut out, "wif_uncompressed", "");
    push_addresses(&mut out, &addresses);
    Ok(out)
}

/// Base58Check parts of a P2PKH address: payload, checksum, full address.
fn p2pkh_parts(hash: &[u8; 20]) -> ([u8; 21], [u8; 4], String) {
    let mut payload = [0u8; 21];
    payload[1..].copy_from_slice(hash);
    let digest = hashes::sha256d(&payload);
    let mut checksum = [0u8; 4];
    checksum.copy_from_slice(&digest[..4]);
    let address = base58::encode_check(&payload);
    (payload, checksum, address)
}

/// BIP340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || message).
fn tagged_hash(tag: &[u8], message: &[u8]) -> [u8; 32] {
    let tag_hash = hashes::sha256(tag);
    let mut data = Vec::with_capacity(64 + message.len());
    data.extend_from_slice(&tag_hash);
    data.extend_from_slice(&tag_hash);
    data.extend_from_slice(message);
    hashes::sha256(&data)
}

/// Reduce a 256-bit big-endian hash modulo the secp256k1 order.
fn reduce_mod_n(bytes: &[u8; 32]) -> Scalar {
    let mut value = *bytes;
    while Scalar::from_bytes_be(&value).is_none() {
        let mut borrow = 0i16;
        for index in (0..32).rev() {
            let difference = i16::from(value[index]) - i16::from(N_BYTES[index]) - borrow;
            if difference < 0 {
                value[index] = (difference + 256) as u8;
                borrow = 1;
            } else {
                value[index] = difference as u8;
                borrow = 0;
            }
        }
    }
    Scalar::from_bytes_be(&value).expect("value is below the curve order after reduction")
}

/// EIP-55 mixed-case checksum form of a 20-byte address.
fn eip55(address: &[u8; 20]) -> String {
    let lower = hex(address);
    let digest = hashes::keccak256(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (index, character) in lower.bytes().enumerate() {
        let nibble = if index % 2 == 0 {
            digest[index / 2] >> 4
        } else {
            digest[index / 2] & 0x0f
        };
        if character.is_ascii_alphabetic() && nibble >= 8 {
            out.push(char::from(character.to_ascii_uppercase()));
        } else {
            out.push(char::from(character));
        }
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Big-endian 256-bit value as a decimal string.
fn decimal(bytes: &[u8; 32]) -> String {
    let mut value = *bytes;
    let mut digits = Vec::new();
    loop {
        let mut remainder = 0u32;
        let mut all_zero = true;
        for byte in &mut value {
            let accumulator = (remainder << 8) | u32::from(*byte);
            *byte = (accumulator / 10) as u8;
            remainder = accumulator % 10;
            if *byte != 0 {
                all_zero = false;
            }
        }
        digits.push(b'0' + remainder as u8);
        if all_zero {
            break;
        }
    }
    digits
        .iter()
        .rev()
        .map(|&digit| char::from(digit))
        .collect()
}

/// The 32 bytes as 256 '0'/'1' characters, most significant bit first.
fn binary(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(256);
    for byte in bytes {
        for shift in (0..8).rev() {
            out.push(if (byte >> shift) & 1 == 1 { '1' } else { '0' });
        }
    }
    out
}

fn push_field(out: &mut String, key: &str, value: &str) {
    out.push('"');
    out.push_str(key);
    out.push_str("\":\"");
    out.push_str(value);
    out.push_str("\",");
}

fn push_addresses(out: &mut String, addresses: &[String]) {
    out.push_str("\"addresses\":[");
    for (index, address) in addresses.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(address);
    }
    out.push_str("]}");
}

fn address_object(id: &str, label: &str, address: &str, steps: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(512);
    out.push_str("{\"id\":\"");
    out.push_str(id);
    out.push_str("\",\"label\":\"");
    out.push_str(label);
    out.push_str("\",\"address\":\"");
    out.push_str(address);
    out.push_str("\",\"steps\":{");
    for (index, (key, value)) in steps.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(key);
        out.push_str("\":\"");
        out.push_str(value);
        out.push('"');
    }
    out.push_str("}}");
    out
}
