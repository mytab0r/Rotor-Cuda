//! BIP143 P2WPKH signing for Bitcoin testnet transactions.
//!
//! The request is a flat JSON object with one key and N P2WPKH inputs:
//!
//! ```json
//! {"network":"testnet",
//!  "inputs":[{"txid":"...","vout":0,"value":"100000","sequence":"4294967295"}],
//!  "outputs":[{"address":"tb1...","value":"90000"}],
//!  "private_key":"0x...32-byte..."}
//! ```
//!
//! Outputs must be testnet P2WPKH addresses (`tb1q...`). Every input is signed
//! with the same key over the BIP143 witness-v0 sighash with scriptCode
//! `0x1976a914{hash160(pubkey)}88ac`; signatures are RFC6979 deterministic,
//! low-S and DER-encoded. When inputs exceed outputs the difference is the
//! network fee, and the transaction must contain a change output back to the
//! signing key's P2WPKH script so the fee is an explicit part of the reviewed
//! request. Fee and coin selection policy stay in the UI layer: this module
//! signs exactly the inputs and outputs it is given.
//!
//! [`sign_request`] returns the raw signed transaction (segwit serialization,
//! with the marker/flag and witnesses); [`unsigned_request`] returns the
//! pre-signature serialization for the review screen. Both are unprefixed
//! lower-case hex at the ABI.

use std::collections::HashSet;

use crate::bech32;
use crate::hashes;
use crate::json::{self, Value};
use crate::scalar::Scalar;
use crate::secp;
use crate::sign::{self, Signature};

/// The only network accepted in this phase.
const NETWORK_TESTNET: &str = "testnet";
/// SIGHASH_ALL.
const SIGHASH_ALL: u32 = 1;
/// Mainnet/testnet share the transaction format; version 2 and locktime 0 are
/// the wallet's fixed defaults.
const VERSION: u32 = 2;
const LOCKTIME: u32 = 0;
/// Bitcoin dust and the 21M coin cap are not enforced here, but a zero-value
/// output is never valid.
const MAX_MONEY: u64 = 21_000_000 * 100_000_000;

struct TxIn {
    /// Internal (little-endian) txid; the request carries the display order.
    txid: [u8; 32],
    vout: u32,
    sequence: u32,
    /// Value of the spent output, needed by BIP143.
    value: u64,
}

struct TxOut {
    value: u64,
    script: Vec<u8>,
}

struct Tx {
    version: u32,
    locktime: u32,
    inputs: Vec<TxIn>,
    outputs: Vec<TxOut>,
}

impl Tx {
    /// Version, inputs, outputs and locktime without witness data. This is the
    /// transaction the review screen shows; it is also the txid preimage.
    fn serialize_no_witness(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(128);
        out.extend_from_slice(&self.version.to_le_bytes());
        push_varint(&mut out, self.inputs.len() as u64);
        for input in &self.inputs {
            out.extend_from_slice(&input.txid);
            out.extend_from_slice(&input.vout.to_le_bytes());
            push_varint(&mut out, 0); // empty scriptSig
            out.extend_from_slice(&input.sequence.to_le_bytes());
        }
        push_varint(&mut out, self.outputs.len() as u64);
        for output in &self.outputs {
            out.extend_from_slice(&output.value.to_le_bytes());
            push_varint(&mut out, output.script.len() as u64);
            out.extend_from_slice(&output.script);
        }
        out.extend_from_slice(&self.locktime.to_le_bytes());
        out
    }

    /// Segwit serialization: marker 0x00, flag 0x01, then a witness stack per
    /// input after the outputs.
    fn serialize_with_witness(&self, witnesses: &[Vec<Vec<u8>>]) -> Vec<u8> {
        debug_assert_eq!(witnesses.len(), self.inputs.len());
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(&self.version.to_le_bytes());
        out.push(0x00);
        out.push(0x01);
        push_varint(&mut out, self.inputs.len() as u64);
        for input in &self.inputs {
            out.extend_from_slice(&input.txid);
            out.extend_from_slice(&input.vout.to_le_bytes());
            push_varint(&mut out, 0);
            out.extend_from_slice(&input.sequence.to_le_bytes());
        }
        push_varint(&mut out, self.outputs.len() as u64);
        for output in &self.outputs {
            out.extend_from_slice(&output.value.to_le_bytes());
            push_varint(&mut out, output.script.len() as u64);
            out.extend_from_slice(&output.script);
        }
        for stack in witnesses {
            push_varint(&mut out, stack.len() as u64);
            for item in stack {
                push_varint(&mut out, item.len() as u64);
                out.extend_from_slice(item);
            }
        }
        out.extend_from_slice(&self.locktime.to_le_bytes());
        out
    }

    fn hash_prevouts(&self) -> [u8; 32] {
        let mut data = Vec::with_capacity(self.inputs.len() * 36);
        for input in &self.inputs {
            data.extend_from_slice(&input.txid);
            data.extend_from_slice(&input.vout.to_le_bytes());
        }
        hashes::sha256d(&data)
    }

    fn hash_sequence(&self) -> [u8; 32] {
        let mut data = Vec::with_capacity(self.inputs.len() * 4);
        for input in &self.inputs {
            data.extend_from_slice(&input.sequence.to_le_bytes());
        }
        hashes::sha256d(&data)
    }

    fn hash_outputs(&self) -> [u8; 32] {
        let mut data = Vec::with_capacity(self.outputs.len() * 36);
        for output in &self.outputs {
            data.extend_from_slice(&output.value.to_le_bytes());
            push_varint(&mut data, output.script.len() as u64);
            data.extend_from_slice(&output.script);
        }
        hashes::sha256d(&data)
    }

    /// BIP143 witness-v0 sighash for input `index` (SIGHASH_ALL).
    fn bip143_sighash(&self, index: usize, script_code: &[u8], value: u64) -> [u8; 32] {
        let input = &self.inputs[index];
        let mut preimage = Vec::with_capacity(156 + script_code.len());
        preimage.extend_from_slice(&self.version.to_le_bytes());
        preimage.extend_from_slice(&self.hash_prevouts());
        preimage.extend_from_slice(&self.hash_sequence());
        preimage.extend_from_slice(&input.txid);
        preimage.extend_from_slice(&input.vout.to_le_bytes());
        push_varint(&mut preimage, script_code.len() as u64);
        preimage.extend_from_slice(script_code);
        preimage.extend_from_slice(&value.to_le_bytes());
        preimage.extend_from_slice(&input.sequence.to_le_bytes());
        preimage.extend_from_slice(&self.hash_outputs());
        preimage.extend_from_slice(&self.locktime.to_le_bytes());
        preimage.extend_from_slice(&SIGHASH_ALL.to_le_bytes());
        hashes::sha256d(&preimage)
    }
}

fn push_varint(out: &mut Vec<u8>, value: u64) {
    if value < 0xfd {
        out.push(value as u8);
    } else if value <= 0xffff {
        out.push(0xfd);
        out.extend_from_slice(&(value as u16).to_le_bytes());
    } else if value <= 0xffff_ffff {
        out.push(0xfe);
        out.extend_from_slice(&(value as u32).to_le_bytes());
    } else {
        out.push(0xff);
        out.extend_from_slice(&value.to_le_bytes());
    }
}

/// DER-encode a compact signature. `r` and `s` are minimal big-endian
/// integers; `s` is already low-S from [`sign::sign`]. RFC 6979 fixes `r`, so
/// there is no nonce grinding for a "low-R" policy (which would break
/// determinism and the published vectors).
fn der_encode(signature: &Signature) -> Vec<u8> {
    fn integer(bytes: &[u8]) -> Vec<u8> {
        let first = bytes
            .iter()
            .position(|&byte| byte != 0)
            .unwrap_or(bytes.len());
        let value = &bytes[first..];
        let mut out = Vec::with_capacity(value.len() + 1);
        if value.first().is_none_or(|byte| byte & 0x80 != 0) {
            out.push(0x00);
        }
        out.extend_from_slice(value);
        out
    }

    let r = integer(&signature.r.to_bytes_be());
    let s = integer(&signature.s.to_bytes_be());
    let mut out = Vec::with_capacity(6 + r.len() + s.len());
    out.push(0x30);
    out.push((4 + r.len() + s.len()) as u8);
    out.push(0x02);
    out.push(r.len() as u8);
    out.extend_from_slice(&r);
    out.push(0x02);
    out.push(s.len() as u8);
    out.extend_from_slice(&s);
    out
}

/// The 22-byte P2WPKH scriptPubKey `0x00 0x14 || hash160(pubkey)`.
fn p2wpkh_script(hash: &[u8; 20]) -> Vec<u8> {
    let mut script = Vec::with_capacity(22);
    script.push(0x00);
    script.push(0x14);
    script.extend_from_slice(hash);
    script
}

/// The 25-byte BIP143 scriptCode `0x76a914 || hash160(pubkey) || 0x88ac`.
fn p2wpkh_script_code(hash: &[u8; 20]) -> Vec<u8> {
    let mut script = Vec::with_capacity(25);
    script.extend_from_slice(&[0x76, 0xa9, 0x14]);
    script.extend_from_slice(hash);
    script.extend_from_slice(&[0x88, 0xac]);
    script
}

pub fn sign_request(text: &str) -> Result<Vec<u8>, String> {
    let (tx, key) = parse_request(text, true)?;
    let mut key = key.expect("a signing request always carries a private key");
    let result = sign_parsed(&tx, &key);
    sign::wipe(&mut key);
    result
}

pub fn unsigned_request(text: &str) -> Result<Vec<u8>, String> {
    Ok(parse_request(text, false)?.0.serialize_no_witness())
}

fn sign_parsed(tx: &Tx, private_key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let scalar = Scalar::from_bytes_be(private_key)
        .ok_or_else(|| "private key is not below the secp256k1 curve order".to_owned())?;
    if scalar.is_zero() {
        return Err("private key must be in the range 1..n-1".to_owned());
    }
    let point = secp::mul_g(&scalar);
    let pubkey = secp::compress(&point);
    let hash = hashes::hash160(&pubkey);
    let script_code = p2wpkh_script_code(&hash);
    let self_script = p2wpkh_script(&hash);

    let input_total = tx
        .inputs
        .iter()
        .try_fold(0u64, |sum, input| sum.checked_add(input.value))
        .ok_or_else(|| "input values overflow 64 bits".to_owned())?;
    let output_total = tx
        .outputs
        .iter()
        .try_fold(0u64, |sum, output| sum.checked_add(output.value))
        .ok_or_else(|| "output values overflow 64 bits".to_owned())?;
    if output_total > input_total {
        return Err("output value exceeds input value".to_owned());
    }
    if output_total < input_total && !tx.outputs.iter().any(|out| out.script == self_script) {
        return Err(
            "missing change output to the signing key's address (inputs exceed outputs)".to_owned(),
        );
    }

    let mut witnesses = Vec::with_capacity(tx.inputs.len());
    for index in 0..tx.inputs.len() {
        let sighash = tx.bip143_sighash(index, &script_code, tx.inputs[index].value);
        let signature = sign::sign(&sighash, private_key)?;
        let mut item = der_encode(&signature);
        item.push(SIGHASH_ALL as u8);
        witnesses.push(vec![item, pubkey.to_vec()]);
    }
    Ok(tx.serialize_with_witness(&witnesses))
}

/// Parse and validate the request. `with_key` selects the signing schema; the
/// review request must not carry a key.
fn parse_request(text: &str, with_key: bool) -> Result<(Tx, Option<[u8; 32]>), String> {
    let names: &[&str] = if with_key {
        &["network", "inputs", "outputs", "private_key"]
    } else {
        &["network", "inputs", "outputs"]
    };
    let slots = take_object(json::parse(text)?, "request", names)?;
    let required = |index: usize| {
        slots[index]
            .as_ref()
            .ok_or_else(|| format!("missing request field: \"{}\"", names[index]))
    };

    let network = text_value(required(0)?, "network")?;
    if network != NETWORK_TESTNET {
        return Err(format!(
            "unsupported network: \"{network}\"; only \"testnet\" is supported in this phase"
        ));
    }

    let mut inputs = Vec::new();
    let input_values = array_value(required(1)?, "inputs")?;
    if input_values.is_empty() {
        return Err("inputs must not be empty".to_owned());
    }
    let mut seen = HashSet::with_capacity(input_values.len());
    for (index, value) in input_values.iter().enumerate() {
        let fields = take_object_ref(value, &format!("input {index}"), INPUT_FIELDS)?;
        let txid_text = text_value(input_field(&fields, 0, index)?, "txid")?;
        let txid = parse_txid(txid_text, index)?;
        let vout = u32_value(
            input_field(&fields, 1, index)?,
            &format!("input {index} vout"),
        )?;
        let value_sats = amount(
            input_field(&fields, 2, index)?,
            &format!("input {index} value"),
        )?;
        let sequence = u32_value(
            input_field(&fields, 3, index)?,
            &format!("input {index} sequence"),
        )?;
        if !seen.insert((txid, vout)) {
            return Err(format!(
                "duplicate input: txid {} vout {vout}",
                display_txid(&txid)
            ));
        }
        inputs.push(TxIn {
            txid,
            vout,
            sequence,
            value: value_sats,
        });
    }

    let mut outputs = Vec::new();
    let output_values = array_value(required(2)?, "outputs")?;
    if output_values.is_empty() {
        return Err("outputs must not be empty".to_owned());
    }
    for (index, value) in output_values.iter().enumerate() {
        let fields = take_object_ref(value, &format!("output {index}"), OUTPUT_FIELDS)?;
        let address = text_value(output_field(&fields, 0, index)?, "address")?;
        let program = parse_p2wpkh_testnet(address)?;
        let value_sats = amount(
            output_field(&fields, 1, index)?,
            &format!("output {index} value"),
        )?;
        outputs.push(TxOut {
            value: value_sats,
            script: p2wpkh_script(&program),
        });
    }

    let private_key = if with_key {
        let key_text = text_value(required(3)?, "private_key")?;
        let mut bytes = json::parse_bytes(key_text, "private_key")?;
        let key = match bytes.as_slice().try_into() {
            Ok(key) => key,
            Err(_) => {
                let length = bytes.len();
                sign::wipe(&mut bytes);
                return Err(format!(
                    "private_key must be exactly 32 bytes, got {length}"
                ));
            }
        };
        sign::wipe(&mut bytes);
        Some(key)
    } else {
        None
    };

    Ok((
        Tx {
            version: VERSION,
            locktime: LOCKTIME,
            inputs,
            outputs,
        },
        private_key,
    ))
}

const INPUT_FIELDS: &[&str] = &["txid", "vout", "value", "sequence"];
const OUTPUT_FIELDS: &[&str] = &["address", "value"];

/// Match every key to its slot, rejecting unknown and duplicate names.
fn take_object<'a>(
    value: Value<'a>,
    context: &str,
    names: &[&str],
) -> Result<Vec<Option<Value<'a>>>, String> {
    let Value::Object(pairs) = value else {
        return Err(format!("{context} must be a JSON object"));
    };
    let mut slots: Vec<Option<Value<'a>>> = (0..names.len()).map(|_| None).collect();
    for (key, value) in pairs {
        let index = names
            .iter()
            .position(|name| *name == key)
            .ok_or_else(|| format!("unknown {context} field: \"{key}\""))?;
        if slots[index].replace(value).is_some() {
            return Err(format!("duplicate {context} field: \"{key}\""));
        }
    }
    Ok(slots)
}

fn take_object_ref<'a>(
    value: &'a Value<'a>,
    context: &str,
    names: &[&str],
) -> Result<Vec<Option<&'a Value<'a>>>, String> {
    let Value::Object(pairs) = value else {
        return Err(format!("{context} must be a JSON object"));
    };
    let mut slots: Vec<Option<&'a Value<'a>>> = (0..names.len()).map(|_| None).collect();
    for (key, value) in pairs {
        let index = names
            .iter()
            .position(|name| *name == *key)
            .ok_or_else(|| format!("unknown {context} field: \"{key}\""))?;
        if slots[index].replace(value).is_some() {
            return Err(format!("duplicate {context} field: \"{key}\""));
        }
    }
    Ok(slots)
}

fn input_field<'a>(
    fields: &'a [Option<&'a Value<'a>>],
    index: usize,
    position: usize,
) -> Result<&'a Value<'a>, String> {
    fields[index].ok_or_else(|| {
        format!(
            "missing input {position} field: \"{}\"",
            INPUT_FIELDS[index]
        )
    })
}

fn output_field<'a>(
    fields: &'a [Option<&'a Value<'a>>],
    index: usize,
    position: usize,
) -> Result<&'a Value<'a>, String> {
    fields[index].ok_or_else(|| {
        format!(
            "missing output {position} field: \"{}\"",
            OUTPUT_FIELDS[index]
        )
    })
}

fn text_value<'a>(value: &'a Value<'a>, field: &str) -> Result<&'a str, String> {
    match value {
        Value::Str(text) => Ok(text),
        _ => Err(format!("{field} must be a quoted string")),
    }
}

fn number_value<'a>(value: &'a Value<'a>, field: &str) -> Result<&'a str, String> {
    match value {
        Value::Str(text) | Value::Num(text) => Ok(text),
        _ => Err(format!(
            "{field} must be a decimal or 0x-prefixed hexadecimal number"
        )),
    }
}

fn array_value<'a>(value: &'a Value<'a>, field: &str) -> Result<&'a [Value<'a>], String> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(format!("{field} must be a JSON array")),
    }
}

fn u32_value(value: &Value<'_>, field: &str) -> Result<u32, String> {
    let text = number_value(value, field)?;
    let parsed = json::parse_u64(text, field)?;
    u32::try_from(parsed).map_err(|_| format!("{field} does not fit in 32 bits"))
}

fn amount(value: &Value<'_>, field: &str) -> Result<u64, String> {
    let text = number_value(value, field)?;
    let parsed = json::parse_u64(text, field)?;
    if parsed == 0 {
        return Err(format!("{field} must be greater than zero"));
    }
    if parsed > MAX_MONEY {
        return Err(format!("{field} exceeds the 21 million BTC supply"));
    }
    Ok(parsed)
}

fn parse_txid(text: &str, position: usize) -> Result<[u8; 32], String> {
    let hex = json::strip_0x(text).unwrap_or(text);
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "input {position} txid must be 64 hexadecimal characters"
        ));
    }
    let mut internal = [0u8; 32];
    for (index, byte) in internal.iter_mut().enumerate() {
        let at = (31 - index) * 2;
        *byte = u8::from_str_radix(&hex[at..at + 2], 16)
            .map_err(|_| format!("input {position} txid is not hexadecimal"))?;
    }
    Ok(internal)
}

fn display_txid(txid: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for byte in txid.iter().rev() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Decode a testnet P2WPKH address into its 20-byte witness program.
fn parse_p2wpkh_testnet(address: &str) -> Result<[u8; 20], String> {
    let (hrp, version, program) = bech32::decode_segwit(address)
        .map_err(|error| format!("invalid output address: {error}"))?;
    if hrp != "tb" {
        return Err(format!(
            "output address {address} is not a Bitcoin testnet address (expected hrp \"tb\")"
        ));
    }
    if version != 0 || program.len() != 20 {
        return Err(format!(
            "output address {address} is not P2WPKH (only witness v0 with a 20-byte program is supported)"
        ));
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&program);
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::hex;

    const KEY1: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const CHANGE: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const OTHER: &str = "tb1qq6hag67dl53wl99vzg42z8eyzfz2xlkvvlryfj";

    fn bytes(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
            .collect()
    }

    fn fixed32(text: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes(text));
        out
    }

    fn valid_request() -> String {
        format!(
            r#"{{"network":"testnet","inputs":[{{"txid":"{0}","vout":0,"value":"100000","sequence":"4294967295"}}],"outputs":[{{"address":"{CHANGE}","value":"100000"}}],"private_key":"0x{KEY1}"}}"#,
            "11".repeat(32)
        )
    }

    /// The unsigned transaction of BIP143 "Example 1: Native P2WPKH". Its
    /// second input is the P2WPKH one with the published sighash.
    fn bip143_example_tx() -> Tx {
        let mut txid0 = [0u8; 32];
        txid0.copy_from_slice(&bytes(
            "fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f",
        ));
        let mut txid1 = [0u8; 32];
        txid1.copy_from_slice(&bytes(
            "ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a",
        ));
        Tx {
            version: 1,
            locktime: 17,
            inputs: vec![
                TxIn {
                    txid: txid0,
                    vout: 0,
                    sequence: 0xffff_ffee,
                    value: 625_000_000,
                },
                TxIn {
                    txid: txid1,
                    vout: 1,
                    sequence: 0xffff_ffff,
                    value: 600_000_000,
                },
            ],
            outputs: vec![
                TxOut {
                    value: 112_340_000,
                    script: bytes("76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac"),
                },
                TxOut {
                    value: 223_450_000,
                    script: bytes("76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac"),
                },
            ],
        }
    }

    /// Published BIP143 example: the P2WPKH input (index 1) sighash must match
    /// the specification, and the unsigned serialization must be identical to
    /// the BIP's transaction hex. The value was also reproduced with
    /// bitcoinjs-lib 6 (`Transaction.hashForWitnessV0`).
    #[test]
    fn bip143_published_sighash_vector() {
        let tx = bip143_example_tx();
        assert_eq!(
            hex(&tx.serialize_no_witness()),
            "0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000"
        );
        let sighash = tx.bip143_sighash(
            1,
            &bytes("76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac"),
            600_000_000,
        );
        assert_eq!(
            hex(&sighash),
            "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670"
        );
    }

    /// A two-input, two-output testnet transaction reproduced with
    /// bitcoinjs-lib 6 (Psbt, P2WPKH inputs, key 1) on 2026-11-19. The same
    /// library produced DETERMINISTIC signatures, so the raw bytes are pinned.
    #[test]
    fn signs_testnet_p2wpkh_like_bitcoinjs() {
        let body = format!(
            r#""network":"testnet","inputs":[
                {{"txid":"{0}","vout":0,"value":"100000","sequence":"4294967295"}},
                {{"txid":"{1}","vout":1,"value":"50000","sequence":"4294967293"}}],
                "outputs":[
                {{"address":"{CHANGE}","value":"140000"}},
                {{"address":"{OTHER}","value":"9000"}}]"#,
            "11".repeat(32),
            "22".repeat(32),
        );
        let unsigned = format!("{{{body}}}");
        let request = format!("{{{body},\"private_key\":\"0x{KEY1}\"}}");
        assert_eq!(
            hex(&unsigned_request(&unsigned).unwrap()),
            "020000000211111111111111111111111111111111111111111111111111111111111111110000000000ffffffff22222222222222222222222222222222222222222222222222222222222222220100000000fdffffff02e022020000000000160014751e76e8199196d454941c45d1b3a323f1433bd6282300000000000016001406afd46bcdfd22ef94ac122aa11f241244a37ecc00000000"
        );
        let signed = sign_request(&request).unwrap();
        assert_eq!(
            hex(&signed),
            "0200000000010211111111111111111111111111111111111111111111111111111111111111110000000000ffffffff22222222222222222222222222222222222222222222222222222222222222220100000000fdffffff02e022020000000000160014751e76e8199196d454941c45d1b3a323f1433bd6282300000000000016001406afd46bcdfd22ef94ac122aa11f241244a37ecc0247304402207f52cb2eb984d81ec7c337dc79e13e21f55acecdef40dc45d7a6601f8920757802203eb5617258cdaf7244124aff7b22576d878d708dd356d49abbe981c4795899e901210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179802483045022100c88a9d58318733dadca553032a01bb0fc71fafc94e71d572b436e1b8dab24ddf02206df5e9be3f42a6ad89d28a9bdba8e1cf6327bac058e4bc31ac9a375ec7091fc401210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179800000000"
        );

        // Every input's signature verifies with the existing ECDSA verify and
        // is low-S (the DER integer never has its top bit set after the sign).
        let key = Scalar::from_u64(1);
        let public = secp::mul_g(&key);
        let hash = hashes::hash160(&secp::compress(&public));
        let script_code = p2wpkh_script_code(&hash);
        let values = [100_000u64, 50_000u64];
        for (index, value) in values.iter().enumerate() {
            let tx = Tx {
                version: VERSION,
                locktime: LOCKTIME,
                inputs: vec![
                    TxIn {
                        txid: fixed32(&"11".repeat(32)),
                        vout: 0,
                        sequence: 0xffff_ffff,
                        value: values[0],
                    },
                    TxIn {
                        txid: fixed32(&"22".repeat(32)),
                        vout: 1,
                        sequence: 0xffff_fffd,
                        value: values[1],
                    },
                ],
                outputs: vec![
                    TxOut {
                        value: 140_000,
                        script: p2wpkh_script(&hashes::hash160(&secp::compress(&secp::mul_g(
                            &Scalar::from_u64(1),
                        )))),
                    },
                    TxOut {
                        value: 9_000,
                        script: p2wpkh_script(&hashes::hash160(&secp::compress(&secp::mul_g(
                            &Scalar::from_u64(2),
                        )))),
                    },
                ],
            };
            let sighash = tx.bip143_sighash(index, &script_code, *value);
            let signature = sign::sign(&sighash, &fixed32(KEY1)).unwrap();
            assert!(sign::verify(&public, &sighash, &signature.r, &signature.s));
            assert_eq!(signature.s.to_bytes_be()[0] & 0x80, 0, "low-S");
        }
    }

    #[test]
    fn accepts_numeric_json_fields_and_change() {
        // vout/value/sequence as JSON numbers, with a fee and change.
        let body = format!(
            r#""network":"testnet","inputs":[{{"txid":"{0}","vout":0,"value":100000,"sequence":4294967295}}],"outputs":[{{"address":"{CHANGE}","value":99000}},{{"address":"{OTHER}","value":500}}]"#,
            "11".repeat(32)
        );
        let unsigned = format!("{{{body}}}");
        let request = format!("{{{body},\"private_key\":\"0x{KEY1}\"}}");
        assert_eq!(
            hex(&unsigned_request(&unsigned).unwrap()),
            "020000000111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff02b882010000000000160014751e76e8199196d454941c45d1b3a323f1433bd6f40100000000000016001406afd46bcdfd22ef94ac122aa11f241244a37ecc00000000"
        );
        assert!(sign_request(&request).is_ok());
    }

    #[test]
    fn rejects_malformed_requests() {
        let valid = valid_request();
        let bad = |request: String| assert!(sign_request(&request).is_err(), "{request}");

        bad(valid.replace("\"network\":\"testnet\"", "\"network\":\"mainnet\""));
        bad(valid.replace("\"network\":\"testnet\",", ""));
        bad(valid.replace("\"network\":\"testnet\"", "\"network\":1"));
        bad(valid.replace("\"vout\":0", "\"vout\":4294967296"));
        bad(valid.replace("\"vout\":0", "\"vout\":-1"));
        bad(valid.replace("\"vout\":0", "\"vout\":1.5"));
        bad(valid.replace("\"value\":\"100000\"", "\"value\":\"0\""));
        bad(valid.replace("\"value\":\"100000\"", "\"value\":\"-5\""));
        bad(valid.replace("\"value\":\"100000\"", "\"value\":\"2100000000000001\""));
        bad(valid.replace("\"sequence\":\"4294967295\"", "\"sequence\":\"4294967296\""));
        bad(valid.replace(&"11".repeat(32), &"11".repeat(31)));
        bad(valid.replace(&"11".repeat(32), &format!("{}zz", "11".repeat(31))));
        bad(valid.replace(",\"private_key\"", ",\"extra\":\"x\",\"private_key\""));
        bad(valid.replace(
            "\"private_key\":\"0x",
            "\"private_key\":\"0x\",\"private_key\":\"0x",
        ));
        bad(valid.replace(KEY1, &KEY1[2..]));
        bad(valid.replace(KEY1, "not-hex"));
        bad(valid.replace(
            r#""inputs":[{"txid":"1111111111111111111111111111111111111111111111111111111111111111","vout":0,"value":"100000","sequence":"4294967295"}]"#,
            r#""inputs":[{"txid":"1111111111111111111111111111111111111111111111111111111111111111","vout":0,"value":"100000","sequence":"4294967295"},{"txid":"1111111111111111111111111111111111111111111111111111111111111111","vout":0,"value":"100000","sequence":"4294967295"}]"#,
        ));
        bad(valid.replace(CHANGE, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"));
        bad(valid.replace(CHANGE, "mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r"));
        bad(valid.replace(
            CHANGE,
            "tb1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5ssk79hv2",
        ));
        bad(valid.replace(CHANGE, "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"));
        bad(valid.replace(CHANGE, "not-an-address"));
        bad(valid.replace("\"inputs\":[", "\"inputs\":[],\"ignored\":["));
        bad(valid.replace(
            r#""outputs":[{"address":"tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx","value":"100000"}]"#,
            r#""outputs":[]"#,
        ));
        // Outputs exceed inputs.
        bad(valid.replace("\"value\":\"100000\"}]", "\"value\":\"100001\"}]"));
        // Inputs exceed outputs with no change output to the key.
        bad(valid.replace(CHANGE, OTHER).replace(
            r#""value":"100000"}],"private_key""#,
            r#""value":"99999"}],"private_key""#,
        ));
        // The review request must not carry a key.
        assert!(unsigned_request(&valid).is_err());

        // Empty and non-object requests.
        assert!(sign_request("{}").is_err());
        assert!(sign_request("[]").is_err());
        assert!(sign_request("not json").is_err());
        assert!(sign_request(&format!("{valid}x")).is_err());
    }
}
