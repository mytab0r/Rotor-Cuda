//! Private-key derivation report: every address encoding for one key.
//!
//! The output is a UTF-8 JSON document with a fixed set of string fields.
//! All values are hex, base58, decimal, binary or fixed English labels, so
//! the serializer below needs no escaping.

use std::fmt::Write as _;

use blake2::{Blake2b, Digest as _, digest::consts::U32};
use ed25519_dalek::SigningKey;

use crate::point::Affine;
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

/// Build the JSON report for a network: 0 mainnet, 1 Bitcoin testnet.
///
/// Mainnet output is [`report`] plus a leading `network` field, so its
/// addresses and WIFs are unchanged. Testnet output is defined for secp256k1
/// keys only and carries the Bitcoin testnet P2PKH/P2SH-P2WPKH/P2WPKH/P2TR
/// rows with version bytes 0x6f/0xc4 and hrp `tb`, plus the testnet WIF
/// (version 0xef).
pub fn report_network(key: &[u8; 32], curve: u32, network: u32) -> Result<String, String> {
    match network {
        0 => {
            let json = report(key, curve)?;
            let mut out = String::with_capacity(json.len() + 24);
            out.push('{');
            out.push_str("\"network\":\"mainnet\",");
            out.push_str(&json[1..]);
            Ok(out)
        }
        1 => match curve {
            0 => testnet_report(key),
            other => Err(format!(
                "unsupported curve for testnet: {other} (Bitcoin testnet is secp256k1)"
            )),
        },
        other => Err(format!("unsupported network: {other}")),
    }
}

fn testnet_report(key: &[u8; 32]) -> Result<String, String> {
    let scalar = Scalar::from_bytes_be(key)
        .ok_or_else(|| "secp256k1 private key is not below the curve order".to_owned())?;
    if scalar.is_zero() {
        return Err("secp256k1 private key must be in the range 1..n-1".to_owned());
    }

    let point = secp::mul_g(&scalar);
    let compressed = secp::compress(&point);
    let uncompressed = secp::uncompress(&point);
    let hash_compressed = hashes::hash160(&compressed);
    let compressed_hex = hex(&compressed);
    let uncompressed_hex = hex(&uncompressed);
    let hash_compressed_hex = hex(&hash_compressed);
    let x_hex = hex(&point.x.to_bytes_be());
    let y_hex = hex(&point.y.to_bytes_be());

    let (p2pkh_payload, p2pkh_checksum, p2pkh_address) = p2pkh_parts(&hash_compressed, 0x6f);
    let (redeem, script_hash, p2sh_payload, p2sh_checksum, p2sh_address) =
        p2sh_p2wpkh_parts(&hash_compressed, 0xc4);
    let (p2wpkh_address, p2wpkh_checksum) = bech32::encode_segwit("tb", 0, &hash_compressed, false);
    let TaprootParts {
        internal_x_hex,
        tweak_hex,
        output_x: _,
        output_x_hex,
        parity,
        address: p2tr_address,
        checksum: p2tr_checksum,
    } = taproot_parts(&point, "tb")?;

    let addresses = [
        address_object(
            "btc_p2pkh",
            "Bitcoin testnet legacy (compressed)",
            &p2pkh_address,
            &[
                ("pubkey", &compressed_hex),
                ("hash160", &hash_compressed_hex),
                ("payload", &hex(&p2pkh_payload)),
                ("checksum", &hex(&p2pkh_checksum)),
                ("base58", &p2pkh_address),
            ],
        ),
        address_object(
            "btc_p2sh_p2wpkh",
            "Bitcoin testnet P2SH-P2WPKH",
            &p2sh_address,
            &[
                ("redeem", &hex(&redeem)),
                ("script_hash", &hex(&script_hash)),
                ("payload", &hex(&p2sh_payload)),
                ("checksum", &hex(&p2sh_checksum)),
            ],
        ),
        address_object(
            "btc_p2wpkh",
            "Bitcoin testnet native segwit",
            &p2wpkh_address,
            &[
                ("hrp", "tb"),
                ("witness_version", "0"),
                ("program", &hash_compressed_hex),
                ("checksum", &p2wpkh_checksum),
            ],
        ),
        address_object(
            "btc_p2tr",
            "Bitcoin testnet taproot",
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
    ];

    let mut out = String::with_capacity(2048);
    out.push('{');
    push_field(&mut out, "network", "testnet");
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
        &base58::wif_encode_with_version(&scalar, true, 0xef),
    );
    push_field(
        &mut out,
        "wif_uncompressed",
        &base58::wif_encode_with_version(&scalar, false, 0xef),
    );
    push_addresses(&mut out, &addresses);
    Ok(out)
}

/// JSON address report derived from a secp256k1 public key alone.
///
/// The public key may be compressed (02/03) or uncompressed (04); no private
/// key, WIF or decimal form is produced because none can be recovered from a
/// public key.
pub fn pubkey_report(text: &str) -> Result<String, String> {
    let mut was_compressed = true;
    let point = secp::parse_pubkey_hex(text.trim(), &mut was_compressed)?;
    let compressed = secp::compress(&point);
    let uncompressed = secp::uncompress(&point);
    let compressed_hex = hex(&compressed);
    let uncompressed_hex = hex(&uncompressed);
    let hash_compressed = hashes::hash160(&compressed);
    let hash_uncompressed = hashes::hash160(&uncompressed);
    let hash_compressed_hex = hex(&hash_compressed);
    let hash_uncompressed_hex = hex(&hash_uncompressed);
    let x_hex = hex(&point.x.to_bytes_be());
    let y_hex = hex(&point.y.to_bytes_be());

    let (compressed_payload, compressed_checksum, compressed_address) =
        p2pkh_parts(&hash_compressed, 0x00);
    let (uncompressed_payload, uncompressed_checksum, uncompressed_address) =
        p2pkh_parts(&hash_uncompressed, 0x00);
    let (redeem, script_hash, p2sh_payload, p2sh_checksum, p2sh_address) =
        p2sh_p2wpkh_parts(&hash_compressed, 0x05);
    let (p2wpkh_address, p2wpkh_checksum) = bech32::encode_segwit("bc", 0, &hash_compressed, false);
    let taproot = taproot_parts(&point, "bc")?;

    let keccak = hashes::keccak256(&uncompressed[1..]);
    let mut last20 = [0u8; 20];
    last20.copy_from_slice(&keccak[12..]);
    let evm_address = eip55(&last20);
    let mut tron_payload = [0u8; 21];
    tron_payload[0] = 0x41;
    tron_payload[1..].copy_from_slice(&last20);
    let tron_address = base58::encode_check(&tron_payload);

    let addresses = [
        address_object(
            "btc_p2pkh",
            "Bitcoin legacy (compressed)",
            &compressed_address,
            &[
                ("pubkey", &compressed_hex),
                ("hash160", &hash_compressed_hex),
                ("payload", &hex(&compressed_payload)),
                ("checksum", &hex(&compressed_checksum)),
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
                ("payload", &hex(&uncompressed_payload)),
                ("checksum", &hex(&uncompressed_checksum)),
                ("base58", &uncompressed_address),
            ],
        ),
        address_object(
            "btc_p2sh_p2wpkh",
            "Bitcoin P2SH-P2WPKH",
            &p2sh_address,
            &[
                ("redeem", &hex(&redeem)),
                ("script_hash", &hex(&script_hash)),
                ("payload", &hex(&p2sh_payload)),
                ("checksum", &hex(&p2sh_checksum)),
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
            &taproot.address,
            &[
                ("internal_x", &taproot.internal_x_hex),
                ("tweak", &taproot.tweak_hex),
                ("output_x", &taproot.output_x_hex),
                ("parity", taproot.parity),
                ("program", &taproot.output_x_hex),
                ("checksum", &taproot.checksum),
            ],
        ),
        address_object(
            "evm",
            "Ethereum / EVM",
            &evm_address,
            &[("keccak", &hex(&keccak)), ("last20", &hex(&last20))],
        ),
        address_object(
            "tron",
            "TRON",
            &tron_address,
            &[("payload", &hex(&tron_payload))],
        ),
    ];

    let mut out = String::with_capacity(3072);
    out.push('{');
    push_field(&mut out, "curve", "secp256k1");
    push_field(
        &mut out,
        "input_format",
        if was_compressed {
            "compressed"
        } else {
            "uncompressed"
        },
    );
    push_field(&mut out, "pubkey_compressed", &compressed_hex);
    push_field(&mut out, "pubkey_uncompressed", &uncompressed_hex);
    push_field(&mut out, "x", &x_hex);
    push_field(&mut out, "y", &y_hex);
    push_addresses(&mut out, &addresses);
    Ok(out)
}

/// JSON for `P + Q`: the sum of two secp256k1 public keys as a new public key.
pub fn pubkey_add_report(first: &str, second: &str) -> Result<String, String> {
    let mut ignored = true;
    let a = secp::parse_pubkey_hex(first.trim(), &mut ignored)?;
    let b = secp::parse_pubkey_hex(second.trim(), &mut ignored)?;
    let sum = secp::add(&a, &b).ok_or_else(|| {
        "The sum of these public keys is the point at infinity, which has no serialized public key."
            .to_owned()
    })?;

    let mut out = String::with_capacity(512);
    out.push('{');
    push_field(&mut out, "curve", "secp256k1");
    push_field(&mut out, "pubkey_compressed", &hex(&secp::compress(&sum)));
    push_field(
        &mut out,
        "pubkey_uncompressed",
        &hex(&secp::uncompress(&sum)),
    );
    push_field(&mut out, "x", &hex(&sum.x.to_bytes_be()));
    push_field(&mut out, "y", &hex(&sum.y.to_bytes_be()));
    out.pop();
    out.push('}');
    Ok(out)
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
        p2pkh_parts(&hash_compressed, 0x00);
    let (uncompressed_payload, uncompressed_checksum, uncompressed_address) =
        p2pkh_parts(&hash_uncompressed, 0x00);
    let compressed_payload_hex = hex(&compressed_payload);
    let compressed_checksum_hex = hex(&compressed_checksum);
    let uncompressed_payload_hex = hex(&uncompressed_payload);
    let uncompressed_checksum_hex = hex(&uncompressed_checksum);

    // P2SH-P2WPKH: redeem script 0x0014 || hash160(compressed pubkey).
    let (redeem, script_hash, p2sh_payload, p2sh_checksum, p2sh_address) =
        p2sh_p2wpkh_parts(&hash_compressed, 0x05);
    let redeem_hex = hex(&redeem);
    let script_hash_hex = hex(&script_hash);
    let p2sh_payload_hex = hex(&p2sh_payload);
    let p2sh_checksum_hex = hex(&p2sh_checksum);

    // P2WPKH: witness v0 over hash160(compressed pubkey).
    let (p2wpkh_address, p2wpkh_checksum) = bech32::encode_segwit("bc", 0, &hash_compressed, false);

    // Litecoin uses the same encodings with its own version bytes and hrp.
    let (ltc_p2pkh_payload, ltc_p2pkh_checksum, ltc_p2pkh_address) =
        p2pkh_parts(&hash_compressed, 0x30);
    let (ltc_redeem, ltc_script_hash, ltc_p2sh_payload, ltc_p2sh_checksum, ltc_p2sh_address) =
        p2sh_p2wpkh_parts(&hash_compressed, 0x32);
    let (ltc_p2wpkh_address, ltc_p2wpkh_checksum) =
        bech32::encode_segwit("ltc", 0, &hash_compressed, false);

    // Dogecoin legacy shares the P2PKH layout with version byte 0x1e.
    let (doge_payload, doge_checksum, doge_address) = p2pkh_parts(&hash_compressed, 0x1e);

    // Bitcoin Cash legacy is Bitcoin's P2PKH encoding (CashAddr is out of scope).
    let (bch_payload, bch_checksum, bch_address) = p2pkh_parts(&hash_compressed, 0x00);

    // Zcash transparent P2PKH uses the two-byte version 0x1cb8.
    let mut zcash_payload = [0u8; 22];
    zcash_payload[0] = 0x1c;
    zcash_payload[1] = 0xb8;
    zcash_payload[2..].copy_from_slice(&hash_compressed);
    let zcash_digest = hashes::sha256d(&zcash_payload);
    let mut zcash_checksum = [0u8; 4];
    zcash_checksum.copy_from_slice(&zcash_digest[..4]);
    let zcash_address = base58::encode_check(&zcash_payload);

    // XRP classic address: version 0x00, the account id and a four-byte
    // double-SHA256 checksum, encoded with Ripple's own base58 alphabet.
    let mut xrp_payload = [0u8; 21];
    xrp_payload[1..].copy_from_slice(&hash_compressed);
    let xrp_digest = hashes::sha256d(&xrp_payload);
    let mut xrp_checksum = [0u8; 4];
    xrp_checksum.copy_from_slice(&xrp_digest[..4]);
    let mut xrp_data = [0u8; 25];
    xrp_data[..21].copy_from_slice(&xrp_payload);
    xrp_data[21..].copy_from_slice(&xrp_checksum);
    let xrp_address = ripple_base58(&xrp_data);
    let xrp_payload_hex = hex(&xrp_payload);
    let xrp_checksum_hex = hex(&xrp_checksum);

    let ltc_p2pkh_payload_hex = hex(&ltc_p2pkh_payload);
    let ltc_p2pkh_checksum_hex = hex(&ltc_p2pkh_checksum);
    let ltc_redeem_hex = hex(&ltc_redeem);
    let ltc_script_hash_hex = hex(&ltc_script_hash);
    let ltc_p2sh_payload_hex = hex(&ltc_p2sh_payload);
    let ltc_p2sh_checksum_hex = hex(&ltc_p2sh_checksum);
    let doge_payload_hex = hex(&doge_payload);
    let doge_checksum_hex = hex(&doge_checksum);
    let bch_payload_hex = hex(&bch_payload);
    let bch_checksum_hex = hex(&bch_checksum);
    let zcash_payload_hex = hex(&zcash_payload);
    let zcash_checksum_hex = hex(&zcash_checksum);

    // P2TR: BIP341 key path with an empty script tree, over the x-only key.
    // The tweaked output key is chain-independent; Litecoin reuses it with
    // its own human-readable part.
    let TaprootParts {
        internal_x_hex,
        tweak_hex,
        output_x,
        output_x_hex,
        parity,
        address: p2tr_address,
        checksum: p2tr_checksum,
    } = taproot_parts(&point, "bc")?;
    let (ltc_p2tr_address, ltc_p2tr_checksum) = bech32::encode_segwit("ltc", 1, &output_x, true);

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
            "ltc_p2pkh",
            "Litecoin legacy",
            &ltc_p2pkh_address,
            &[
                ("pubkey", &compressed_hex),
                ("hash160", &hash_compressed_hex),
                ("payload", &ltc_p2pkh_payload_hex),
                ("checksum", &ltc_p2pkh_checksum_hex),
                ("base58", &ltc_p2pkh_address),
            ],
        ),
        address_object(
            "ltc_p2sh_p2wpkh",
            "Litecoin P2SH-P2WPKH",
            &ltc_p2sh_address,
            &[
                ("redeem", &ltc_redeem_hex),
                ("script_hash", &ltc_script_hash_hex),
                ("payload", &ltc_p2sh_payload_hex),
                ("checksum", &ltc_p2sh_checksum_hex),
            ],
        ),
        address_object(
            "ltc_p2wpkh",
            "Litecoin native segwit",
            &ltc_p2wpkh_address,
            &[
                ("hrp", "ltc"),
                ("witness_version", "0"),
                ("program", &hash_compressed_hex),
                ("checksum", &ltc_p2wpkh_checksum),
            ],
        ),
        address_object(
            "ltc_p2tr",
            "Litecoin taproot",
            &ltc_p2tr_address,
            &[
                ("internal_x", &internal_x_hex),
                ("tweak", &tweak_hex),
                ("output_x", &output_x_hex),
                ("parity", parity),
                ("program", &output_x_hex),
                ("checksum", &ltc_p2tr_checksum),
            ],
        ),
        address_object(
            "doge_p2pkh",
            "Dogecoin legacy",
            &doge_address,
            &[
                ("pubkey", &compressed_hex),
                ("hash160", &hash_compressed_hex),
                ("payload", &doge_payload_hex),
                ("checksum", &doge_checksum_hex),
                ("base58", &doge_address),
            ],
        ),
        address_object(
            "bch_legacy",
            "Bitcoin Cash legacy (P2PKH)",
            &bch_address,
            &[
                ("pubkey", &compressed_hex),
                ("hash160", &hash_compressed_hex),
                ("payload", &bch_payload_hex),
                ("checksum", &bch_checksum_hex),
                ("base58", &bch_address),
            ],
        ),
        address_object(
            "zcash_p2pkh",
            "Zcash transparent (P2PKH)",
            &zcash_address,
            &[
                ("pubkey", &compressed_hex),
                ("hash160", &hash_compressed_hex),
                ("payload", &zcash_payload_hex),
                ("checksum", &zcash_checksum_hex),
                ("base58", &zcash_address),
            ],
        ),
        address_object(
            "xrp_classic",
            "XRP classic address",
            &xrp_address,
            &[
                ("pubkey", &compressed_hex),
                ("hash160", &hash_compressed_hex),
                ("payload", &xrp_payload_hex),
                ("checksum", &xrp_checksum_hex),
                ("base58", &xrp_address),
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

    // Sui hashes the scheme flag (0x00 = ed25519) plus the public key with
    // BLAKE2b-256 and prefixes the 32-byte digest with 0x.
    let mut sui_input = [0u8; 33];
    sui_input[1..].copy_from_slice(&public);
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(sui_input);
    let digest = hasher.finalize();
    let sui_address = format!("0x{}", hex(&digest));

    // TON wallet v5 (W5): StateInit code is the official wallet_v5 cell and
    // the data cell stores this public key under the default mainnet wallet id.
    let ton = crate::ton::w5_address(&public)?;
    let ton_state_init_hex = hex(&ton.state_init_hash);

    let addresses = [
        address_object(
            "solana",
            "Solana (ed25519)",
            &address,
            &[("pubkey", &public_hex)],
        ),
        address_object(
            "sui",
            "Sui (ed25519)",
            &sui_address,
            &[("pubkey", &public_hex), ("blake2b", &sui_address)],
        ),
        address_object(
            "ton_w5",
            "TON wallet W5",
            &ton.address,
            &[
                ("pubkey", &public_hex),
                ("state_init_hash", &ton_state_init_hex),
                ("address", &ton.address),
            ],
        ),
    ];

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
fn p2pkh_parts(hash: &[u8; 20], version: u8) -> ([u8; 21], [u8; 4], String) {
    let mut payload = [0u8; 21];
    payload[0] = version;
    payload[1..].copy_from_slice(hash);
    let digest = hashes::sha256d(&payload);
    let mut checksum = [0u8; 4];
    checksum.copy_from_slice(&digest[..4]);
    let address = base58::encode_check(&payload);
    (payload, checksum, address)
}

/// P2SH-P2WPKH parts: redeem script, its hash160, the versioned payload, the
/// checksum and the Base58Check address.
fn p2sh_p2wpkh_parts(
    hash: &[u8; 20],
    version: u8,
) -> ([u8; 22], [u8; 20], [u8; 21], [u8; 4], String) {
    let mut redeem = [0u8; 22];
    redeem[1] = 0x14;
    redeem[2..].copy_from_slice(hash);
    let script_hash = hashes::hash160(&redeem);
    let mut payload = [0u8; 21];
    payload[0] = version;
    payload[1..].copy_from_slice(&script_hash);
    let digest = hashes::sha256d(&payload);
    let mut checksum = [0u8; 4];
    checksum.copy_from_slice(&digest[..4]);
    let address = base58::encode_check(&payload);
    (redeem, script_hash, payload, checksum, address)
}

/// BIP341 taproot output for an empty script tree: internal x-only key, tweak,
/// output key, parity and the bech32m address.
struct TaprootParts {
    internal_x_hex: String,
    tweak_hex: String,
    output_x: [u8; 32],
    output_x_hex: String,
    parity: &'static str,
    address: String,
    checksum: String,
}

/// Compute the taproot output key from any point. The internal key is
/// lift_x(x(P)): a point with odd y is negated before the tweak is added.
fn taproot_parts(point: &Affine, hrp: &str) -> Result<TaprootParts, String> {
    let internal_x = point.x.to_bytes_be();
    let tweak = tagged_hash(b"TapTweak", &internal_x);
    let tweak_scalar = reduce_mod_n(&tweak);
    let internal = if point.y.is_odd() {
        point.neg()
    } else {
        *point
    };
    let output = if tweak_scalar.is_zero() {
        internal
    } else {
        let tweak_point = secp::mul(&secp::g(), &tweak_scalar)
            .ok_or_else(|| "taproot tweak is the point at infinity".to_owned())?;
        secp::add(&internal, &tweak_point)
            .ok_or_else(|| "taproot output key is the point at infinity".to_owned())?
    };
    let output_x = output.x.to_bytes_be();
    let (address, checksum) = bech32::encode_segwit(hrp, 1, &output_x, true);
    Ok(TaprootParts {
        internal_x_hex: hex(&internal_x),
        tweak_hex: hex(&tweak),
        output_x,
        output_x_hex: hex(&output_x),
        parity: if output.y.is_odd() { "1" } else { "0" },
        address,
        checksum,
    })
}

/// Ripple's base58 alphabet, used by XRP classic addresses.
const RIPPLE_ALPHABET: &[u8; 58] = b"rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/// Encode bytes in Ripple's base58 alphabet. This is deliberately separate
/// from Bitcoin's alphabet: the same bytes produce a different string.
fn ripple_base58(data: &[u8]) -> String {
    let zeros = data.iter().take_while(|&&byte| byte == 0).count();
    let mut digits: Vec<u8> = Vec::with_capacity(data.len() * 138 / 100 + 1);
    for &byte in &data[zeros..] {
        let mut carry = u32::from(byte);
        for digit in &mut digits {
            let value = (u32::from(*digit) << 8) | carry;
            *digit = (value % 58) as u8;
            carry = value / 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        out.push(char::from(RIPPLE_ALPHABET[0]));
    }
    for &digit in digits.iter().rev() {
        out.push(char::from(RIPPLE_ALPHABET[digit as usize]));
    }
    out
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
pub(crate) fn reduce_mod_n(bytes: &[u8; 32]) -> Scalar {
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

pub(crate) fn hex(bytes: &[u8]) -> String {
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
