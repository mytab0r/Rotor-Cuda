//! TRON Nile testnet TRX transfer signing.
//!
//! The request is a flat JSON object whose values are all strings:
//!
//! ```text
//! {"kind":"trx","owner_address":"T...","to_address":"T...",
//!  "amount":"1000000","ref_block_bytes":"12ab",
//!  "ref_block_hash":"0011223344556677","expiration":"1700000060000",
//!  "timestamp":"1700000000000","fee_limit":"0","private_key":"0x...32-byte..."}
//! ```
//!
//! `fee_limit` is optional and defaults to zero. A plain TRX transfer is
//! canonicalized to `fee_limit` 0 (it pays bandwidth, not a contract fee); a
//! TRC-20 request keeps the requested limit. `private_key` is only part of a
//! signing request. The result is a UTF-8 JSON object with `txID`,
//! `raw_data_hex`, `raw_data` and, when signing, `signature` (65 bytes
//! `r || s || v` with `v = 27 + recovery_id`, RFC 6979 deterministic).
//!
//! `kind` selects the contract: `"trx"` encodes a plain `TransferContract`,
//! `"trc20"` encodes a `transfer(address,uint256)` as `TriggerSmartContract`
//! and requires `token_contract_address`. The protobuf layout is
//! hand-written and deterministic: fields are emitted in ascending order, and
//! the `fee_limit` field is always present (even when zero) so the reviewed
//! bytes never depend on an optional-field policy. Unknown, duplicate or
//! missing request fields are rejected, matching the EVM signer's strictness.

use std::fmt::Write as _;

use crate::base58;
use crate::derive::hex;
use crate::evm::parse_slots;
use crate::hashes;
use crate::json;
use crate::sign;

/// Transaction field names in request order. `private_key` is appended after
/// the ten transaction fields and is accepted only when signing.
const FIELD_NAMES: [&str; 11] = [
    "kind",
    "owner_address",
    "to_address",
    "token_contract_address",
    "amount",
    "ref_block_bytes",
    "ref_block_hash",
    "expiration",
    "timestamp",
    "fee_limit",
    "private_key",
];

/// Number of transaction fields; `private_key` follows these.
const TX_FIELDS: usize = 10;

/// `protocol.Transaction.Contract.ContractType.TransferContract`.
const TRANSFER_CONTRACT_TYPE: u64 = 1;

/// The protobuf `Any` type URL of a `TransferContract`.
const TYPE_URL: &str = "type.googleapis.com/protocol.TransferContract";

/// `protocol.Transaction.Contract.ContractType.TriggerSmartContract`.
const TRIGGER_SMART_CONTRACT_TYPE: u64 = 31;

/// The protobuf `Any` type URL of a `TriggerSmartContract`.
const TRC20_TYPE_URL: &str = "type.googleapis.com/protocol.TriggerSmartContract";

/// The first four bytes of `transfer(address,uint256)`, as TRON's ABI coder
/// emits them (the same selector as the EVM encoding).
const TRC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

/// TRON base58check addresses carry the `0x41` (mainnet/testnet shared)
/// prefix; the byte is part of the address payload and the signature hash.
const ADDRESS_PREFIX: u8 = 0x41;

/// A signed or unsigned 64-bit value must stay below this bound: the amount is
/// an `int64` and the timestamps must be exactly representable as JSON numbers
/// in JavaScript.
const MAX_JSON_SAFE: u64 = 1 << 53;

/// `2^63 - 1`, the largest positive `int64` amount.
const MAX_AMOUNT: u64 = i64::MAX as u64;

/// The wallet refuses a `fee_limit` above 100 TRX (100,000,000 sun).
const MAX_FEE_LIMIT: u64 = 100_000_000;

/// The two contract kinds this encoder supports. The kind is explicit in the
/// request so a bare transfer and a token transfer can never be confused.
#[derive(Clone, Copy)]
enum Kind {
    Trx,
    Trc20,
}

/// A validated transfer request.
struct Tx {
    kind: Kind,
    owner_address: [u8; 21],
    to_address: [u8; 21],
    /// Set for a TRC-20 request; all-zero and unused for a plain TRX transfer.
    token_contract_address: [u8; 21],
    amount: u64,
    ref_block_bytes: [u8; 2],
    ref_block_hash: [u8; 8],
    expiration: u64,
    timestamp: u64,
    fee_limit: u64,
}

/// A validated signing request.
struct Request {
    tx: Tx,
    private_key: [u8; 32],
}

/// Parse, sign and serialize a request; the result is the JSON review object.
pub fn sign_request(text: &str) -> Result<String, String> {
    let mut request = Request::parse(text)?;
    let result = sign_parsed(&request);
    sign::wipe(&mut request.private_key);
    result
}

/// Parse and serialize the transfer without signing it.
///
/// The request is the same flat JSON object as [`sign_request`] minus
/// `private_key`; a key field is rejected so the caller cannot believe a
/// signature was produced.
pub fn unsigned_request(text: &str) -> Result<String, String> {
    let slots = parse_slots(text, &FIELD_NAMES[..TX_FIELDS])?;
    let tx = Tx::parse(&slots)?;
    Ok(tx.to_json(None))
}

fn sign_parsed(request: &Request) -> Result<String, String> {
    let raw_data = request.tx.raw_data();
    let tx_id = hashes::sha256(&raw_data);
    let signature = sign::sign(&tx_id, &request.private_key)?;
    let mut signature_hex = hex(&signature.compact());
    let _ = write!(signature_hex, "{:02x}", 27 + signature.recovery);
    Ok(request.tx.to_json(Some(&signature_hex)))
}

impl Request {
    fn parse(text: &str) -> Result<Request, String> {
        let slots = parse_slots(text, &FIELD_NAMES)?;
        let tx = Tx::parse(&slots[..TX_FIELDS])?;
        let key_text = slots[TX_FIELDS]
            .ok_or_else(|| format!("missing request field: \"{}\"", FIELD_NAMES[TX_FIELDS]))?;
        let mut key_bytes = json::parse_bytes(key_text, "private_key")?;
        let private_key: [u8; 32] = match key_bytes.as_slice().try_into() {
            Ok(key) => key,
            Err(_) => {
                let length = key_bytes.len();
                sign::wipe(&mut key_bytes);
                return Err(format!(
                    "private_key must be exactly 32 bytes, got {length}"
                ));
            }
        };
        sign::wipe(&mut key_bytes);

        Ok(Request { tx, private_key })
    }
}

impl Tx {
    /// Validate the ten transaction fields.
    fn parse(slots: &[Option<&str>]) -> Result<Tx, String> {
        let required = |index: usize| {
            slots[index].ok_or_else(|| format!("missing request field: \"{}\"", FIELD_NAMES[index]))
        };

        let kind = parse_kind(required(0)?)?;

        let amount = parse_u64(required(4)?, "amount")?;
        if amount == 0 {
            return Err("amount must be greater than zero".to_owned());
        }
        if amount > MAX_AMOUNT {
            return Err("amount exceeds the int64 maximum (2^63 - 1 sun)".to_owned());
        }

        let expiration = parse_timestamp(required(7)?, "expiration")?;
        let timestamp = parse_timestamp(required(8)?, "timestamp")?;

        let requested_fee_limit = match slots[9] {
            Some(text) => parse_u64(text, "fee_limit")?,
            None => 0,
        };
        if requested_fee_limit > MAX_FEE_LIMIT {
            return Err("fee_limit exceeds 100 TRX (100000000 sun)".to_owned());
        }
        /* A plain `TransferContract` pays bandwidth, not a smart-contract fee,
         * so its canonical bytes always carry `fee_limit` 0 (the page does the
         * same). The value is still range-checked above; a TRC-20 call keeps
         * the requested limit. */
        let fee_limit = match kind {
            Kind::Trx => 0,
            Kind::Trc20 => requested_fee_limit,
        };

        let token_contract_address = match kind {
            Kind::Trx => {
                if slots[3].is_some_and(|text| !text.is_empty()) {
                    return Err("token_contract_address is set but kind is \"trx\"; \
                         use \"kind\":\"trc20\" for a token transfer"
                        .to_owned());
                }
                [0u8; 21]
            }
            Kind::Trc20 => {
                let text = slots[3].ok_or_else(|| {
                    "missing request field: \"token_contract_address\" for a trc20 request"
                        .to_owned()
                })?;
                if text.is_empty() {
                    return Err(
                        "token_contract_address must not be empty for a trc20 request".to_owned(),
                    );
                }
                parse_address(text, "token_contract_address")?
            }
        };

        Ok(Tx {
            kind,
            owner_address: parse_address(required(1)?, "owner_address")?,
            to_address: parse_address(required(2)?, "to_address")?,
            token_contract_address,
            amount,
            ref_block_bytes: parse_hex_fixed(required(5)?, "ref_block_bytes")?,
            ref_block_hash: parse_hex_fixed(required(6)?, "ref_block_hash")?,
            expiration,
            timestamp,
            fee_limit,
        })
    }

    /// The serialized `Transaction.raw`: fields in ascending order.
    fn raw_data(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(160);
        push_bytes_field(&mut out, 1, &self.ref_block_bytes);
        push_bytes_field(&mut out, 4, &self.ref_block_hash);
        push_varint_field(&mut out, 8, self.expiration);
        push_bytes_field(&mut out, 11, &self.contract());
        push_varint_field(&mut out, 14, self.timestamp);
        push_varint_field(&mut out, 18, self.fee_limit);
        out
    }

    /// `Transaction.Contract` with either a `TransferContract` or a
    /// `TriggerSmartContract` parameter.
    fn contract(&self) -> Vec<u8> {
        match self.kind {
            Kind::Trx => self.trx_contract(),
            Kind::Trc20 => self.trc20_contract(),
        }
    }

    /// `TransferContract`: owner, recipient and the raw amount.
    fn trx_contract(&self) -> Vec<u8> {
        let mut transfer = Vec::with_capacity(48);
        push_bytes_field(&mut transfer, 1, &self.owner_address);
        push_bytes_field(&mut transfer, 2, &self.to_address);
        push_varint_field(&mut transfer, 3, self.amount);

        let mut parameter = Vec::with_capacity(128);
        push_bytes_field(&mut parameter, 1, TYPE_URL.as_bytes());
        push_bytes_field(&mut parameter, 2, &transfer);

        let mut contract = Vec::with_capacity(112);
        push_varint_field(&mut contract, 1, TRANSFER_CONTRACT_TYPE);
        push_bytes_field(&mut contract, 2, &parameter);
        contract
    }

    /// `transfer(address,uint256)` calldata: the selector, the 20-byte
    /// recipient body left-padded to one 32-byte word, then the raw amount as
    /// one 32-byte big-endian word. The amount is never scaled here.
    fn trc20_calldata(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(68);
        data.extend_from_slice(&TRC20_TRANSFER_SELECTOR);
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(&self.to_address[1..]);
        data.extend_from_slice(&[0u8; 24]);
        data.extend_from_slice(&self.amount.to_be_bytes());
        data
    }

    /// `TriggerSmartContract`: owner, the 21-byte contract address and the
    /// transfer calldata (field 4). `call_value` (field 3) stays absent.
    fn trc20_contract(&self) -> Vec<u8> {
        let data = self.trc20_calldata();
        let mut smart = Vec::with_capacity(96);
        push_bytes_field(&mut smart, 1, &self.owner_address);
        push_bytes_field(&mut smart, 2, &self.token_contract_address);
        push_bytes_field(&mut smart, 4, &data);

        let mut parameter = Vec::with_capacity(160);
        push_bytes_field(&mut parameter, 1, TRC20_TYPE_URL.as_bytes());
        push_bytes_field(&mut parameter, 2, &smart);

        let mut contract = Vec::with_capacity(200);
        push_varint_field(&mut contract, 1, TRIGGER_SMART_CONTRACT_TYPE);
        push_bytes_field(&mut contract, 2, &parameter);
        contract
    }

    /// The JSON review object shared by the signing and unsigned requests.
    fn to_json(&self, signature_hex: Option<&str>) -> String {
        let raw_data = self.raw_data();

        let mut out = String::with_capacity(900);
        out.push('{');
        push_string_field(&mut out, "txID", &hex(&hashes::sha256(&raw_data)));
        out.push(',');
        push_string_field(&mut out, "raw_data_hex", &hex(&raw_data));
        out.push_str(",\"raw_data\":{\"contract\":[{");
        match self.kind {
            Kind::Trx => {
                out.push_str("\"type\":\"TransferContract\",\"parameter\":{\"type_url\":\"");
                out.push_str(TYPE_URL);
                out.push_str("\",\"value\":{");
                push_string_field(&mut out, "owner_address", &hex(&self.owner_address));
                out.push(',');
                push_string_field(&mut out, "to_address", &hex(&self.to_address));
                let _ = write!(out, ",\"amount\":{}", self.amount);
                out.push_str("}}");
            }
            Kind::Trc20 => {
                out.push_str("\"type\":\"TriggerSmartContract\",\"parameter\":{\"type_url\":\"");
                out.push_str(TRC20_TYPE_URL);
                out.push_str("\",\"value\":{");
                push_string_field(&mut out, "owner_address", &hex(&self.owner_address));
                out.push(',');
                push_string_field(
                    &mut out,
                    "contract_address",
                    &hex(&self.token_contract_address),
                );
                out.push(',');
                push_string_field(&mut out, "data", &hex(&self.trc20_calldata()));
                out.push_str("}}");
            }
        }
        out.push_str("}]");
        out.push(',');
        push_string_field(&mut out, "ref_block_bytes", &hex(&self.ref_block_bytes));
        out.push(',');
        push_string_field(&mut out, "ref_block_hash", &hex(&self.ref_block_hash));
        let _ = write!(
            out,
            ",\"expiration\":{},\"timestamp\":{},\"fee_limit\":{}",
            self.expiration, self.timestamp, self.fee_limit
        );
        out.push('}');
        if let Some(signature) = signature_hex {
            out.push(',');
            push_string_field(&mut out, "signature", signature);
        }
        out.push('}');
        out
    }
}

/// Parse the explicit contract kind.
fn parse_kind(text: &str) -> Result<Kind, String> {
    match text {
        "trx" => Ok(Kind::Trx),
        "trc20" => Ok(Kind::Trc20),
        _ => Err(format!("kind must be \"trx\" or \"trc20\", got \"{text}\"")),
    }
}

/// Parse a decimal or `0x`-prefixed `u64`, as the other signing requests do.
fn parse_u64(text: &str, field: &str) -> Result<u64, String> {
    json::parse_u64(text, field)
}

/// Milliseconds since the Unix epoch: nonzero and exactly representable in a
/// JavaScript number.
fn parse_timestamp(text: &str, field: &str) -> Result<u64, String> {
    let value = parse_u64(text, field)?;
    if value == 0 {
        return Err(format!("{field} must be greater than zero"));
    }
    if value > MAX_JSON_SAFE {
        return Err(format!(
            "{field} exceeds 2^53 milliseconds and is not JSON-safe"
        ));
    }
    Ok(value)
}

/// Decode a base58check TRON address: 21 bytes with the `0x41` prefix.
fn parse_address(text: &str, field: &str) -> Result<[u8; 21], String> {
    if text.len() >= 2 && (text.starts_with("0x") || text.starts_with("0X")) {
        return Err(format!(
            "{field} must be a TRON base58 address (T...), not a hex address"
        ));
    }
    let payload =
        base58::decode_check(text).map_err(|error| format!("invalid {field}: {error}"))?;
    if payload.len() != 21 || payload[0] != ADDRESS_PREFIX {
        return Err(format!(
            "{field} is not a TRON address (base58check payload must be 21 bytes with the 0x41 prefix)"
        ));
    }
    let mut address = [0u8; 21];
    address.copy_from_slice(&payload);
    Ok(address)
}

/// Parse exactly `N` bytes of bare hexadecimal text.
fn parse_hex_fixed<const N: usize>(text: &str, field: &str) -> Result<[u8; N], String> {
    if text.len() != N * 2 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "{field} must be exactly {} hexadecimal characters",
            N * 2
        ));
    }
    let mut out = [0u8; N];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .map_err(|_| format!("{field} is not hexadecimal"))?;
    }
    Ok(out)
}

/// Protobuf varint.
fn push_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn push_tag(out: &mut Vec<u8>, field: u64, wire: u64) {
    push_varint(out, (field << 3) | wire);
}

/// Length-delimited field (wire type 2).
fn push_bytes_field(out: &mut Vec<u8>, field: u64, data: &[u8]) {
    push_tag(out, field, 2);
    push_varint(out, data.len() as u64);
    out.extend_from_slice(data);
}

/// Varint field (wire type 0).
fn push_varint_field(out: &mut Vec<u8>, field: u64, value: u64) {
    push_tag(out, field, 0);
    push_varint(out, value);
}

/// Append `"key":"value"`; every value here is constrained ASCII (hex, a
/// base58 address or the fixed type URL), so no JSON escaping is needed.
fn push_string_field(out: &mut String, key: &str, value: &str) {
    let _ = write!(out, "\"{key}\":\"{value}\"");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scalar::Scalar;
    use crate::secp;

    const KEY1: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const OWNER: &str = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";
    const TO: &str = "TDvSsdrNM5eeXNL3czpa6AxLDHZA9nwe9K";

    /// Independent Python reference (`hashlib` + a hand-written protobuf
    /// encoder) for this exact request on 2026-11-20.
    const RAW_DATA_HEX: &str = "0a0212ab2208001122334455667740e0a499ffbc315a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a15417e5f4552091a69125d5dfcb7b8c2659029395bdf1215412b5ad5c4795c026514f8317c7a215e218dccd6cf18c0843d7080d095ffbc31900100";
    const TX_ID: &str = "ceff5238d3200e6ea4a23f8de6608e61aa6bb757a505e93f4fed422631a32c4e";
    /// RFC 6979 deterministic signature for the vector above (`v = 28`); the
    /// recovery test below proves it belongs to the owner address.
    const SIGNATURE: &str = "d990cf8db49841329b06d1c2c50e43d9481a7f762df4f603d321b8578454c0e62fe71d4d72db7bc8f95ac9d60cf5da983ba64ea13d6325e36fc99d9e46bb8a631c";

    fn body() -> String {
        format!(
            r#""kind":"trx","owner_address":"{OWNER}","to_address":"{TO}","amount":"1000000",
               "ref_block_bytes":"12ab","ref_block_hash":"0011223344556677",
               "expiration":"1700000060000","timestamp":"1700000000000""#
        )
    }

    fn unsigned() -> String {
        format!("{{{}}}", body())
    }

    fn signed() -> String {
        format!("{{{},\"private_key\":\"0x{KEY1}\"}}", body())
    }

    fn key_bytes() -> [u8; 32] {
        let mut key = [0u8; 32];
        key[31] = 1;
        key
    }

    /// Derive the TRON address from a private key, so the pinned vector is
    /// self-consistent with the signer that must recover it.
    fn address_for_key(key: &[u8; 32]) -> String {
        let scalar = Scalar::from_bytes_be(key).expect("valid scalar");
        let last20 = secp::eth_address(&secp::mul_g(&scalar));
        let mut payload = [0u8; 21];
        payload[0] = ADDRESS_PREFIX;
        payload[1..].copy_from_slice(&last20);
        base58::encode_check(&payload)
    }

    #[test]
    fn owner_address_is_derived_from_the_test_key() {
        assert_eq!(address_for_key(&key_bytes()), OWNER);
        // Key 2's TRON address is the pinned destination.
        let mut key = [0u8; 32];
        key[31] = 2;
        assert_eq!(address_for_key(&key), TO);
    }

    #[test]
    fn unsigned_vector_matches_the_independent_encoding() {
        let result = unsigned_request(&unsigned()).expect("unsigned request");
        assert!(result.starts_with(r#"{"txID":"ceff5238"#));

        let value: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["txID"], TX_ID);
        assert_eq!(value["raw_data_hex"], RAW_DATA_HEX);
        assert!(value.get("signature").is_none());

        let raw = &value["raw_data"];
        assert_eq!(raw["ref_block_bytes"], "12ab");
        assert_eq!(raw["ref_block_hash"], "0011223344556677");
        assert_eq!(raw["expiration"], 1_700_000_060_000u64);
        assert_eq!(raw["timestamp"], 1_700_000_000_000u64);
        assert_eq!(raw["fee_limit"], 0);
        let contract = &raw["contract"][0];
        assert_eq!(contract["type"], "TransferContract");
        assert_eq!(
            contract["parameter"]["type_url"],
            "type.googleapis.com/protocol.TransferContract"
        );
        assert_eq!(
            contract["parameter"]["value"]["owner_address"],
            format!("41{}", "7e5f4552091a69125d5dfcb7b8c2659029395bdf")
        );
        assert_eq!(contract["parameter"]["value"]["amount"], 1_000_000u64);
    }

    #[test]
    fn signature_is_deterministic_and_recovers_the_owner() {
        let first = sign_request(&signed()).expect("sign");
        let second = sign_request(&signed()).expect("sign again");
        assert_eq!(first, second);

        let value: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(value["txID"], TX_ID);
        assert_eq!(value["raw_data_hex"], RAW_DATA_HEX);
        let signature_hex = value["signature"].as_str().unwrap();
        assert_eq!(signature_hex, SIGNATURE);
        assert_eq!(signature_hex.len(), 130, "65 bytes r||s||v");

        let bytes: Vec<u8> = (0..signature_hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&signature_hex[index..index + 2], 16).unwrap())
            .collect();
        assert!(matches!(bytes[64], 27 | 28), "v = 27 + recovery_id");

        let mut r = [0u8; 32];
        r.copy_from_slice(&bytes[..32]);
        let mut s = [0u8; 32];
        s.copy_from_slice(&bytes[32..64]);
        let signature = sign::Signature {
            r: Scalar::from_bytes_be(&r).unwrap(),
            s: Scalar::from_bytes_be(&s).unwrap(),
            recovery: bytes[64] - 27,
        };

        let mut tx_id = [0u8; 32];
        tx_id.copy_from_slice(&json::parse_bytes(TX_ID, "txID").unwrap());
        assert!(sign::verify(
            &secp::mul_g(&Scalar::from_u64(1)),
            &tx_id,
            &signature.r,
            &signature.s
        ));

        let recovered = sign::recover(&tx_id, &signature).expect("recover");
        let mut payload = [0u8; 21];
        payload[0] = ADDRESS_PREFIX;
        payload[1..].copy_from_slice(&secp::eth_address(&recovered));
        assert_eq!(base58::encode_check(&payload), OWNER);
    }

    #[test]
    fn unsigned_request_rejects_a_key_and_unknown_fields() {
        assert!(unsigned_request(&signed()).is_err());
        let unknown = format!("{{\"extra\":\"x\",{}}}", body());
        assert!(unsigned_request(&unknown).is_err());
        let duplicate = format!("{{{},\"amount\":\"1\"}}", body());
        assert!(unsigned_request(&duplicate).is_err());
        let missing = unsigned().replace(r#""amount":"1000000","#, "");
        assert!(unsigned_request(&missing).is_err());
        assert!(unsigned_request("{}").is_err());
        assert!(unsigned_request(&format!("{}x", unsigned())).is_err());
    }

    #[test]
    fn rejects_wrong_address_networks_and_checksums() {
        let valid = unsigned();

        // Bitcoin mainnet P2PKH: valid base58check, but a 0x00 payload prefix.
        assert!(
            unsigned_request(&valid.replace(TO, "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH")).is_err()
        );
        // EVM hex address.
        assert!(
            unsigned_request(&valid.replace(TO, "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"))
                .is_err()
        );
        // A one-character checksum change.
        let mut flipped = TO.to_owned();
        flipped.pop();
        flipped.push(if TO.ends_with('K') { 'L' } else { 'K' });
        assert!(unsigned_request(&valid.replace(TO, &flipped)).is_err());
        // Correct prefix but the wrong payload length.
        let short = base58::encode_check(&[ADDRESS_PREFIX; 20]);
        assert!(unsigned_request(&valid.replace(TO, &short)).is_err());
        // Not base58 at all.
        assert!(unsigned_request(&valid.replace(TO, "not-an-address")).is_err());
    }

    #[test]
    fn rejects_out_of_range_amounts_and_fee_limits() {
        let valid = unsigned();
        for amount in ["0", "-1", "9223372036854775808", "1.5", "1e6", "hi"] {
            assert!(
                unsigned_request(
                    &valid.replace(r#""amount":"1000000""#, &format!(r#""amount":"{amount}""#))
                )
                .is_err(),
                "amount {amount}"
            );
        }
        assert!(
            unsigned_request(
                &valid.replace(r#""amount":"1000000""#, r#""amount":"9223372036854775807""#)
            )
            .is_ok()
        );

        for fee in ["100000001", "-1", "x"] {
            let request = format!(
                "{{{},\"fee_limit\":\"{fee}\"}}",
                body().trim_end_matches(',')
            );
            assert!(unsigned_request(&request).is_err(), "fee_limit {fee}");
        }
        let accepted = format!(
            "{{{},\"fee_limit\":\"100000000\"}}",
            body().trim_end_matches(',')
        );
        assert!(unsigned_request(&accepted).is_ok());
    }

    #[test]
    fn rejects_bad_reference_blocks_and_timestamps() {
        let valid = unsigned();
        for (from, to) in [
            (r#""ref_block_bytes":"12ab""#, r#""ref_block_bytes":"12""#),
            (
                r#""ref_block_bytes":"12ab""#,
                r#""ref_block_bytes":"12abc""#,
            ),
            (r#""ref_block_bytes":"12ab""#, r#""ref_block_bytes":"12zz""#),
            (
                r#""ref_block_hash":"0011223344556677""#,
                r#""ref_block_hash":"00112233445566""#,
            ),
            (
                r#""ref_block_hash":"0011223344556677""#,
                r#""ref_block_hash":"001122334455667788""#,
            ),
        ] {
            assert!(unsigned_request(&valid.replace(from, to)).is_err(), "{to}");
        }

        for (field, original) in [
            ("expiration", r#""expiration":"1700000060000""#),
            ("timestamp", r#""timestamp":"1700000000000""#),
        ] {
            for value in ["0", "9007199254740993"] {
                let replaced = valid.replace(original, &format!(r#""{field}":"{value}""#));
                assert!(unsigned_request(&replaced).is_err(), "{field} {value}");
            }
        }
        // The boundary itself is accepted.
        let boundary = valid.replace(
            r#""expiration":"1700000060000""#,
            r#""expiration":"9007199254740992""#,
        );
        assert!(unsigned_request(&boundary).is_ok());
    }

    #[test]
    fn rejects_invalid_private_keys() {
        let valid = signed();
        assert!(sign_request(&valid.replace(KEY1, &KEY1[2..])).is_err());
        assert!(sign_request(&valid.replace(KEY1, "not-hex")).is_err());
        let zero = "0".repeat(64);
        assert!(sign_request(&valid.replace(KEY1, &zero)).is_err());
        let order = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
        assert!(sign_request(&valid.replace(KEY1, order)).is_err());
    }

    #[test]
    fn protobuf_helpers_match_reference_bytes() {
        assert_eq!(push_varint_bytes(0), vec![0x00]);
        assert_eq!(push_varint_bytes(127), vec![0x7f]);
        assert_eq!(push_varint_bytes(128), vec![0x80, 0x01]);
        assert_eq!(push_varint_bytes(300), vec![0xac, 0x02]);

        let mut out = Vec::new();
        push_bytes_field(&mut out, 1, &[0x12, 0xab]);
        assert_eq!(out, vec![0x0a, 0x02, 0x12, 0xab]);

        let mut out = Vec::new();
        push_varint_field(&mut out, 18, 0);
        assert_eq!(out, vec![0x90, 0x01, 0x00]);
    }

    fn push_varint_bytes(value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        push_varint(&mut out, value);
        out
    }
    /// TRC-20 (`TriggerSmartContract`) coverage for the ROT-511 slice.
    ///
    /// Oracle: tronweb 6.5.2 run offline on 2026-11-24 outside the repository
    /// (`txJsonToPb` / `txPbToRawDataHex` / `txPbToTxID` for the raw bytes and
    /// the id, `utils.abi.encodeParams` for the calldata and
    /// `utils.crypto.signTransaction` for the RFC 6979 signature). The ABI
    /// coder takes the 20-byte recipient body without the `0x41` prefix.
    /// Cross-check: the same tronweb signer reproduces the pinned TRX
    /// `SIGNATURE` above byte for byte.
    mod trc20_tests {
        use super::*;
        use crate::scalar::Scalar;
        use crate::secp;

        /// TRON mainnet USDT (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`).
        const CONTRACT: &str = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
        const CONTRACT_HEX: &str = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
        const DATA: &str = "a9059cbb0000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf00000000000000000000000000000000000000000000000000000000000f4240";
        const TRC20_RAW_DATA_HEX: &str = "0a0212ab2208001122334455667740e0a499ffbc315aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15417e5f4552091a69125d5dfcb7b8c2659029395bdf121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb0000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf00000000000000000000000000000000000000000000000000000000000f42407080d095ffbc31900180c2d72f";
        const TRC20_TX_ID: &str =
            "e2e775bf45d59c75626a7b1c3a87bf32eada7b0870c2c617408fe87e609800b6";
        const TRC20_SIGNATURE: &str = "bb8652874740c0860c7735e92bba6405253b578e5966b3e5015adb66952a06a0130522d939703fbbb831800c7c51986061bf16a212724950efeee28869f7de191c";

        /// One request body; `contract` is `None` (field absent) or
        /// `Some("")` (explicitly empty) or a token contract address.
        fn body(kind: &str, contract: Option<&str>) -> String {
            let token = match contract {
                Some(value) => format!(r#","token_contract_address":"{value}""#),
                None => String::new(),
            };
            format!(
                r#""kind":"{kind}","owner_address":"{OWNER}","to_address":"{TO}"{token},"amount":"1000000","ref_block_bytes":"12ab","ref_block_hash":"0011223344556677","expiration":"1700000060000","timestamp":"1700000000000","fee_limit":"100000000""#
            )
        }

        fn unsigned(kind: &str, contract: Option<&str>) -> String {
            format!("{{{}}}", body(kind, contract))
        }

        fn signed(kind: &str, contract: Option<&str>) -> String {
            format!(r#"{{{},"private_key":"0x{KEY1}"}}"#, body(kind, contract))
        }

        #[test]
        fn trc20_unsigned_vector_matches_the_independent_encoding() {
            let result =
                unsigned_request(&unsigned("trc20", Some(CONTRACT))).expect("unsigned trc20");
            let value: serde_json::Value = serde_json::from_str(&result).unwrap();

            assert_eq!(value["txID"], TRC20_TX_ID);
            assert_eq!(value["raw_data_hex"], TRC20_RAW_DATA_HEX);
            assert!(value.get("signature").is_none());

            let raw = &value["raw_data"];
            assert_eq!(raw["ref_block_bytes"], "12ab");
            assert_eq!(raw["ref_block_hash"], "0011223344556677");
            assert_eq!(raw["expiration"], 1_700_000_060_000u64);
            assert_eq!(raw["timestamp"], 1_700_000_000_000u64);
            assert_eq!(raw["fee_limit"], 100_000_000u64);

            let contract = &raw["contract"][0];
            assert_eq!(contract["type"], "TriggerSmartContract");
            assert_eq!(
                contract["parameter"]["type_url"],
                "type.googleapis.com/protocol.TriggerSmartContract"
            );
            let payload = &contract["parameter"]["value"];
            assert_eq!(
                payload["owner_address"],
                "417e5f4552091a69125d5dfcb7b8c2659029395bdf"
            );
            assert_eq!(payload["contract_address"], CONTRACT_HEX);
            assert_eq!(payload["data"], DATA);
        }

        #[test]
        fn trc20_signature_verifies_and_matches_the_independent_signer() {
            let first = sign_request(&signed("trc20", Some(CONTRACT))).expect("sign trc20");
            let second = sign_request(&signed("trc20", Some(CONTRACT))).expect("sign again");
            assert_eq!(first, second, "RFC 6979 is deterministic");

            let value: serde_json::Value = serde_json::from_str(&first).unwrap();
            assert_eq!(value["txID"], TRC20_TX_ID);
            assert_eq!(value["raw_data_hex"], TRC20_RAW_DATA_HEX);

            let signature_hex = value["signature"].as_str().expect("signature");
            assert_eq!(signature_hex, TRC20_SIGNATURE);
            assert_eq!(signature_hex.len(), 130, "65 bytes r||s||v");

            let bytes: Vec<u8> = (0..signature_hex.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&signature_hex[index..index + 2], 16).unwrap())
                .collect();
            assert!(matches!(bytes[64], 27 | 28), "v = 27 + recovery_id");

            let mut r = [0u8; 32];
            r.copy_from_slice(&bytes[..32]);
            let mut s = [0u8; 32];
            s.copy_from_slice(&bytes[32..64]);
            let signature = sign::Signature {
                r: Scalar::from_bytes_be(&r).unwrap(),
                s: Scalar::from_bytes_be(&s).unwrap(),
                recovery: bytes[64] - 27,
            };

            let mut tx_id = [0u8; 32];
            tx_id.copy_from_slice(&json::parse_bytes(TRC20_TX_ID, "txID").unwrap());
            assert!(
                sign::verify(
                    &secp::mul_g(&Scalar::from_u64(1)),
                    &tx_id,
                    &signature.r,
                    &signature.s
                ),
                "the signature must verify against the public key of key 1"
            );

            let recovered = sign::recover(&tx_id, &signature).expect("recover");
            let mut payload = [0u8; 21];
            payload[0] = ADDRESS_PREFIX;
            payload[1..].copy_from_slice(&secp::eth_address(&recovered));
            assert_eq!(base58::encode_check(&payload), OWNER);

            // An unsigned request never carries a signature.
            let unsigned_result = unsigned_request(&unsigned("trc20", Some(CONTRACT))).unwrap();
            let unsigned_value: serde_json::Value = serde_json::from_str(&unsigned_result).unwrap();
            assert!(unsigned_value.get("signature").is_none());
        }

        #[test]
        fn the_kind_is_required_and_strict() {
            assert!(unsigned_request(&unsigned("trc20", Some(CONTRACT))).is_ok());
            assert!(unsigned_request(&unsigned("trx", None)).is_ok());
            // An explicitly empty token contract on a TRX request carries none.
            assert!(unsigned_request(&unsigned("trx", Some(""))).is_ok());
            // A TRX request with a kind field still encodes the pinned TRX bytes.
            let trx: serde_json::Value =
                serde_json::from_str(&unsigned_request(&unsigned("trx", None)).unwrap()).unwrap();
            assert_eq!(trx["raw_data_hex"], RAW_DATA_HEX);
            assert_eq!(trx["txID"], TX_ID);

            let err = unsigned_request(&unsigned("trc21", Some(CONTRACT))).unwrap_err();
            assert!(
                err.contains("kind"),
                "unknown kind must name the field: {err}"
            );

            let missing = unsigned("trc20", Some(CONTRACT)).replace(r#""kind":"trc20","#, "");
            let err = unsigned_request(&missing).unwrap_err();
            assert!(
                err.contains("kind"),
                "a missing kind must name the field: {err}"
            );

            let duplicate_kind = format!("{{{},\"kind\":\"trx\"}}", body("trc20", Some(CONTRACT)));
            assert!(unsigned_request(&duplicate_kind).is_err());

            let duplicate_token = format!(
                "{{{},\"token_contract_address\":\"{CONTRACT}\"}}",
                body("trc20", Some(CONTRACT))
            );
            assert!(unsigned_request(&duplicate_token).is_err());

            let unknown = format!("{{{},\"extra\":\"x\"}}", body("trc20", Some(CONTRACT)));
            assert!(unsigned_request(&unknown).is_err());

            assert!(unsigned_request("{}").is_err());
        }

        #[test]
        fn kind_and_token_contract_must_agree() {
            let mismatch = unsigned("trx", Some(CONTRACT));
            let err = unsigned_request(&mismatch).unwrap_err();
            assert!(
                err.contains("token_contract_address"),
                "a TRX request with a token contract must name the field: {err}"
            );

            let missing = unsigned("trc20", None);
            let err = unsigned_request(&missing).unwrap_err();
            assert!(
                err.contains("token_contract_address"),
                "a TRC-20 request without a token contract must name the field: {err}"
            );
        }

        #[test]
        fn trc20_refuses_invalid_token_contracts() {
            let request = |contract: &str| unsigned("trc20", Some(contract));

            for contract in [
                "not-an-address",
                // Bitcoin P2PKH: valid base58check, but a 0x00 payload prefix.
                "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
                // EVM hex address.
                "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
            ] {
                let err = unsigned_request(&request(contract)).unwrap_err();
                assert!(err.contains("token_contract_address"), "{contract}: {err}");
            }

            // A one-character checksum change.
            let mut flipped = CONTRACT[..CONTRACT.len() - 1].to_owned();
            flipped.push('u');
            assert!(unsigned_request(&request(&flipped)).is_err());

            // Correct prefix but the wrong payload length.
            let short = base58::encode_check(&[ADDRESS_PREFIX; 20]);
            assert!(unsigned_request(&request(&short)).is_err());
        }

        #[test]
        fn trc20_refuses_a_zero_amount() {
            let request = unsigned("trc20", Some(CONTRACT))
                .replace(r#""amount":"1000000""#, r#""amount":"0""#);
            let err = unsigned_request(&request).unwrap_err();
            assert!(err.contains("amount"), "{err}");
        }
    }
}

/// SunSwap V2 swap and TRC-20 approve coverage for the ROT-520 slice.
///
/// Oracle: tronweb 6.5.2 installed outside the repository (temp directory,
/// 2026-11-25) and run offline against the host Node runtime. The transaction
/// bytes come from `utils.transaction.txJsonToPb` / `txPbToRawDataHex` /
/// `txPbToTxID`; the calldata from `utils.abi.encodeParams` and the signature
/// from `utils.crypto.signTransaction`. The path array is passed to the coder
/// as 20-byte address bodies (no `0x41` prefix), which is exactly the ABI
/// encoding this module pins. The same signer reproduces the TRX and TRC-20
/// vectors already pinned above, so the oracle is cross-checked against an
/// independent slice.
#[cfg(test)]
mod swap_tests {
    use super::*;
    use crate::scalar::Scalar;
    use crate::secp;

    const KEY1: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const OWNER: &str = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";
    const TO: &str = "TDvSsdrNM5eeXNL3czpa6AxLDHZA9nwe9K";
    /// SunSwap V2 router on TRON mainnet.
    const ROUTER: &str = "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax";
    const WTRX: &str = "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR";
    const USDT: &str = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const USDC: &str = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";

    const OWNER_HEX: &str = "417e5f4552091a69125d5dfcb7b8c2659029395bdf";
    const ROUTER_HEX: &str = "416e0617948fe030a7e4970f8389d4ad295f249b7e";
    const USDT_HEX: &str = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

    // Address bodies as the ABI coder sees them (no 0x41 prefix).
    const TO_BODY: &str = "2b5ad5c4795c026514f8317c7a215e218dccd6cf";
    const WTRX_BODY: &str = "891cdb91d149f23b1a45d9c5ca78a88d0cb44c18";
    const USDT_BODY: &str = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";
    const USDC_BODY: &str = "3487b63d30b5b2c87fb7ffa8bcfade38eaac1abe";

    // ---- Pinned tronweb output, 2026-11-25 ----

    /// TRX in: `swapExactETHForTokens(uint256,address[],address,uint256)`,
    /// `call_value` 1,000,000 sun, two-address path WTRX -> USDT.
    const SWAP_TRX_DATA: &str = "7ff36ab500000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000000800000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf0000000000000000000000000000000000000000000000000000018bcfe9fbe00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000891cdb91d149f23b1a45d9c5ca78a88d0cb44c18000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c";
    const SWAP_TRX_TX_ID: &str = "e45d986fe4947d2098a0a114b5a935b9af6f26495cedb579b2080a34b47705f1";
    const SWAP_TRX_SIGNATURE: &str = "1162fbfb4aba8ec720e520892bbf0848b28c704fdc1751be24329b14565cc3b37cd17fe7367cf8c98ec47d8031dcc62d8f0e67b510823a63efa3bc8f757035da1b";
    const SWAP_TRX_RAW_DATA_HEX: &str = "0a0212ab2208001122334455667740e0a499ffbc315ad402081f12cf020a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e74726163741299020a15417e5f4552091a69125d5dfcb7b8c2659029395bdf1215416e0617948fe030a7e4970f8389d4ad295f249b7e18c0843d22e4017ff36ab500000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000000800000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf0000000000000000000000000000000000000000000000000000018bcfe9fbe00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000891cdb91d149f23b1a45d9c5ca78a88d0cb44c18000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c7080d095ffbc31900180c2d72f";

    /// TRC-20 in: `swapExactTokensForTokens(uint256,uint256,address[],address,uint256)`,
    /// no `call_value`, three-address path USDT -> WTRX -> USDC.
    const SWAP_TOKEN_DATA: &str = "38ed173900000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000138800000000000000000000000000000000000000000000000000000000000000a00000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf0000000000000000000000000000000000000000000000000000018bcfe9fbe00000000000000000000000000000000000000000000000000000000000000003000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c000000000000000000000000891cdb91d149f23b1a45d9c5ca78a88d0cb44c180000000000000000000000003487b63d30b5b2c87fb7ffa8bcfade38eaac1abe";
    const SWAP_TOKEN_TX_ID: &str =
        "37f9a13f12723bbb7584a12034e7b5148b6a6cfc4cc2c758a1717b2eebc44880";
    const SWAP_TOKEN_SIGNATURE: &str = "d6ec62be29bf746a08b27eb08114b7c361639ea46a21ac2a0e926a342969f7147952e28194cf8025bb3d88c469aebfe639262c86db508773e0f35747506f24911b";
    const SWAP_TOKEN_RAW_DATA_HEX: &str = "0a0212ab2208001122334455667740e0a499ffbc315a9003081f128b030a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412d5020a15417e5f4552091a69125d5dfcb7b8c2659029395bdf1215416e0617948fe030a7e4970f8389d4ad295f249b7e22a40238ed173900000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000138800000000000000000000000000000000000000000000000000000000000000a00000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf0000000000000000000000000000000000000000000000000000018bcfe9fbe00000000000000000000000000000000000000000000000000000000000000003000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c000000000000000000000000891cdb91d149f23b1a45d9c5ca78a88d0cb44c180000000000000000000000003487b63d30b5b2c87fb7ffa8bcfade38eaac1abe7080d095ffbc31900180c2d72f";

    /// `approve(address,uint256)` on USDT with the router as spender.
    const APPROVE_DATA: &str = "095ea7b30000000000000000000000006e0617948fe030a7e4970f8389d4ad295f249b7e00000000000000000000000000000000000000000000000000000000000f4240";
    const APPROVE_TX_ID: &str = "f11c9463b458c4a54169496feca0bc9dccb326262b0874c64f02158c81cf548b";
    const APPROVE_SIGNATURE: &str = "7f48bec592b5acc292246d77a87581bb058f8af0ad77aa7b0eb3055a8d8e5d056c441554a7428df77bf7891285a4d7be16f43ec88b31455e87b478f3f4f148141b";
    const APPROVE_RAW_DATA_HEX: &str = "0a0212ab2208001122334455667740e0a499ffbc315aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15417e5f4552091a69125d5dfcb7b8c2659029395bdf121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244095ea7b30000000000000000000000006e0617948fe030a7e4970f8389d4ad295f249b7e00000000000000000000000000000000000000000000000000000000000f42407080d095ffbc31900180c2d72f";

    fn swap_body() -> String {
        format!(
            r#""kind":"swap","owner_address":"{OWNER}","to_address":"{TO}","token_contract_address":"","router_address":"{ROUTER}","path":"{WTRX},{USDT}","amount_in":"1000000","amount_out_min":"1000","deadline":"1700000300000","ref_block_bytes":"12ab","ref_block_hash":"0011223344556677","expiration":"1700000060000","timestamp":"1700000000000","fee_limit":"100000000""#
        )
    }

    fn token_swap_body() -> String {
        format!(
            r#""kind":"swap","owner_address":"{OWNER}","to_address":"{TO}","token_contract_address":"{USDT}","router_address":"{ROUTER}","path":"{USDT},{WTRX},{USDC}","amount_in":"1000000","amount_out_min":"5000","deadline":"1700000300000","ref_block_bytes":"12ab","ref_block_hash":"0011223344556677","expiration":"1700000060000","timestamp":"1700000000000","fee_limit":"100000000""#
        )
    }

    fn approve_body() -> String {
        format!(
            r#""kind":"approve","owner_address":"{OWNER}","token_contract_address":"{USDT}","spender_address":"{ROUTER}","amount":"1000000","ref_block_bytes":"12ab","ref_block_hash":"0011223344556677","expiration":"1700000060000","timestamp":"1700000000000","fee_limit":"100000000""#
        )
    }

    fn unsigned(body: &str) -> String {
        format!("{{{body}}}")
    }

    fn signed(body: &str) -> String {
        format!(r#"{{{},"private_key":"0x{KEY1}"}}"#, body)
    }

    /// A right-aligned 32-byte ABI word, as lowercase hex.
    fn word(value: &str) -> String {
        format!("{value:0>64}")
    }

    /// A 32-byte ABI word holding an address body (no `0x41` prefix).
    fn address_word(body: &str) -> String {
        word(body)
    }

    #[test]
    fn trx_in_swap_matches_the_independent_encoding() {
        let result = unsigned_request(&unsigned(&swap_body())).expect("unsigned swap");
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(value["txID"], SWAP_TRX_TX_ID);
        assert_eq!(value["raw_data_hex"], SWAP_TRX_RAW_DATA_HEX);
        assert!(value.get("signature").is_none());

        let raw = &value["raw_data"];
        assert_eq!(raw["fee_limit"], 100_000_000u64);
        let contract = &raw["contract"][0];
        assert_eq!(contract["type"], "TriggerSmartContract");
        assert_eq!(
            contract["parameter"]["type_url"],
            "type.googleapis.com/protocol.TriggerSmartContract"
        );
        let payload = &contract["parameter"]["value"];
        assert_eq!(payload["owner_address"], OWNER_HEX);
        // The call target is the router, not `path[0]`.
        assert_eq!(payload["contract_address"], ROUTER_HEX);
        assert_eq!(payload["data"], SWAP_TRX_DATA);

        // Selector and ABI layout: 4 static words, then the dynamic path.
        assert_eq!(&SWAP_TRX_DATA[..8], "7ff36ab5");
        assert_eq!(SWAP_TRX_DATA.len(), 8 + 4 * 64 + (1 + 2) * 64);
        assert_eq!(&SWAP_TRX_DATA[8..8 + 64], word("3e8"), "amountOutMin");
        assert_eq!(
            &SWAP_TRX_DATA[8 + 64..8 + 2 * 64],
            word("80"),
            "path offset"
        );
        assert_eq!(
            &SWAP_TRX_DATA[8 + 2 * 64..8 + 3 * 64],
            address_word(TO_BODY),
            "recipient"
        );
        assert_eq!(
            &SWAP_TRX_DATA[8 + 3 * 64..8 + 4 * 64],
            word("18bcfe9fbe0"),
            "deadline"
        );
        assert_eq!(
            &SWAP_TRX_DATA[8 + 4 * 64..8 + 5 * 64],
            word("2"),
            "path length"
        );
        assert_eq!(
            &SWAP_TRX_DATA[8 + 5 * 64..8 + 6 * 64],
            address_word(WTRX_BODY),
            "path[0]"
        );
        assert_eq!(
            &SWAP_TRX_DATA[8 + 6 * 64..8 + 7 * 64],
            address_word(USDT_BODY),
            "path[1]"
        );
    }

    #[test]
    fn trc20_in_swap_pins_the_three_address_path_encoding() {
        let result = unsigned_request(&unsigned(&token_swap_body())).expect("unsigned token swap");
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(value["txID"], SWAP_TOKEN_TX_ID);
        assert_eq!(value["raw_data_hex"], SWAP_TOKEN_RAW_DATA_HEX);
        assert!(value.get("signature").is_none());

        let payload = &value["raw_data"]["contract"][0]["parameter"]["value"];
        assert_eq!(payload["owner_address"], OWNER_HEX);
        assert_eq!(payload["contract_address"], ROUTER_HEX);
        assert_eq!(payload["data"], SWAP_TOKEN_DATA);
        // No `call_value` for a token-in swap (field 3 is absent from the raw
        // bytes, which the pinned hex above already proves).
        assert!(payload.get("call_value").is_none());

        assert_eq!(&SWAP_TOKEN_DATA[..8], "38ed1739");
        assert_eq!(SWAP_TOKEN_DATA.len(), 8 + 5 * 64 + (1 + 3) * 64);
        assert_eq!(&SWAP_TOKEN_DATA[8..8 + 64], word("f4240"), "amountIn");
        assert_eq!(
            &SWAP_TOKEN_DATA[8 + 64..8 + 2 * 64],
            word("1388"),
            "amountOutMin"
        );
        assert_eq!(
            &SWAP_TOKEN_DATA[8 + 2 * 64..8 + 3 * 64],
            word("a0"),
            "path offset: five head words"
        );
        assert_eq!(
            &SWAP_TOKEN_DATA[8 + 3 * 64..8 + 4 * 64],
            address_word(TO_BODY),
            "recipient"
        );
        assert_eq!(
            &SWAP_TOKEN_DATA[8 + 4 * 64..8 + 5 * 64],
            word("18bcfe9fbe0"),
            "deadline"
        );
        assert_eq!(
            &SWAP_TOKEN_DATA[8 + 5 * 64..8 + 6 * 64],
            word("3"),
            "path length"
        );
        for (index, body) in [USDT_BODY, WTRX_BODY, USDC_BODY].iter().enumerate() {
            let start = 8 + (6 + index) * 64;
            let element = &SWAP_TOKEN_DATA[start..start + 64];
            assert_eq!(element, address_word(body), "path[{index}]");
            assert!(
                element.starts_with("000000000000000000000000"),
                "an ABI address is 12 zero bytes + the 20-byte body"
            );
            assert!(
                !element.contains("41"),
                "the 0x41 prefix must not appear inside an ABI address word"
            );
        }
    }

    #[test]
    fn approve_matches_the_independent_encoding() {
        let result = unsigned_request(&unsigned(&approve_body())).expect("unsigned approve");
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(value["txID"], APPROVE_TX_ID);
        assert_eq!(value["raw_data_hex"], APPROVE_RAW_DATA_HEX);
        assert!(value.get("signature").is_none());

        let payload = &value["raw_data"]["contract"][0]["parameter"]["value"];
        assert_eq!(payload["owner_address"], OWNER_HEX);
        assert_eq!(payload["contract_address"], USDT_HEX);
        assert_eq!(payload["data"], APPROVE_DATA);
        assert_eq!(&APPROVE_DATA[..8], "095ea7b3");
        assert_eq!(APPROVE_DATA.len(), 8 + 2 * 64);
        assert_eq!(
            &APPROVE_DATA[8..8 + 64],
            address_word("6e0617948fe030a7e4970f8389d4ad295f249b7e"),
            "spender"
        );
        assert_eq!(&APPROVE_DATA[8 + 64..], word("f4240"), "amount");
    }

    #[test]
    fn swap_refuses_invalid_routes_and_amounts() {
        let valid = unsigned(&swap_body());

        // A path with a single address cannot route.
        let single = valid.replace(
            &format!(r#""path":"{WTRX},{USDT}""#),
            &format!(r#""path":"{WTRX}""#),
        );
        let err = unsigned_request(&single).unwrap_err();
        assert!(err.contains("path"), "single-element path: {err}");

        // The router is the call target; without it the request has no target.
        let no_router = valid.replace(&format!(r#","router_address":"{ROUTER}""#), "");
        let err = unsigned_request(&no_router).unwrap_err();
        assert!(err.contains("router_address"), "missing router: {err}");

        // A zero input amount is not a swap.
        let zero_in = valid.replace(r#""amount_in":"1000000""#, r#""amount_in":"0""#);
        let err = unsigned_request(&zero_in).unwrap_err();
        assert!(err.contains("amount_in"), "zero amount_in: {err}");

        // A path member must be a valid TRON base58 address.
        let bad_path = valid.replace(
            &format!(r#""path":"{WTRX},{USDT}""#),
            &format!(r#""path":"not-an-address,{USDT}""#),
        );
        let err = unsigned_request(&bad_path).unwrap_err();
        assert!(err.contains("path"), "invalid path element: {err}");

        // The deadline is milliseconds and must be in the future of timestamp.
        let stale = valid.replace(
            r#""deadline":"1700000300000""#,
            r#""deadline":"1699999999999""#,
        );
        let err = unsigned_request(&stale).unwrap_err();
        assert!(err.contains("deadline"), "stale deadline: {err}");

        // For a token-in swap the minimum output above the input is nonsense.
        let token = unsigned(&token_swap_body()).replace(
            r#""amount_out_min":"5000""#,
            r#""amount_out_min":"1000001""#,
        );
        let err = unsigned_request(&token).unwrap_err();
        assert!(err.contains("amount_out_min"), "min above amount_in: {err}");
    }

    #[test]
    fn approve_refuses_a_zero_spender() {
        let mut payload = [0u8; 21];
        payload[0] = ADDRESS_PREFIX;
        let zero = base58::encode_check(&payload);

        let request = unsigned(&approve_body()).replace(ROUTER, &zero);
        let err = unsigned_request(&request).unwrap_err();
        assert!(
            err.contains("spender_address") && !err.contains("unknown request field"),
            "zero spender: {err}"
        );
    }

    #[test]
    fn signed_swap_verifies_and_never_contains_the_key() {
        // An unsigned request must reject a key field outright.
        assert!(unsigned_request(&signed(&swap_body())).is_err());

        let unsigned_result = unsigned_request(&unsigned(&swap_body())).expect("unsigned swap");
        assert!(
            !unsigned_result.contains(KEY1),
            "no key in the unsigned result"
        );
        assert!(!unsigned_result.contains("private_key"));

        let first = sign_request(&signed(&swap_body())).expect("sign swap");
        let second = sign_request(&signed(&swap_body())).expect("sign again");
        assert_eq!(first, second, "RFC 6979 is deterministic");
        assert!(!first.contains(KEY1), "no key in the signed result");
        assert!(!first.contains("private_key"));

        let value: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(value["txID"], SWAP_TRX_TX_ID);
        assert_eq!(value["raw_data_hex"], SWAP_TRX_RAW_DATA_HEX);
        let signature_hex = value["signature"].as_str().expect("signature");
        assert_eq!(signature_hex, SWAP_TRX_SIGNATURE);
        assert_eq!(signature_hex.len(), 130, "65 bytes r||s||v");

        let bytes: Vec<u8> = (0..signature_hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&signature_hex[index..index + 2], 16).unwrap())
            .collect();
        assert!(matches!(bytes[64], 27 | 28), "v = 27 + recovery_id");

        let mut r = [0u8; 32];
        r.copy_from_slice(&bytes[..32]);
        let mut s = [0u8; 32];
        s.copy_from_slice(&bytes[32..64]);
        let signature = sign::Signature {
            r: Scalar::from_bytes_be(&r).unwrap(),
            s: Scalar::from_bytes_be(&s).unwrap(),
            recovery: bytes[64] - 27,
        };

        let mut tx_id = [0u8; 32];
        tx_id.copy_from_slice(&json::parse_bytes(SWAP_TRX_TX_ID, "txID").unwrap());
        assert!(
            sign::verify(
                &secp::mul_g(&Scalar::from_u64(1)),
                &tx_id,
                &signature.r,
                &signature.s
            ),
            "the signature must verify against the public key of key 1"
        );

        let recovered = sign::recover(&tx_id, &signature).expect("recover");
        let mut recovered_payload = [0u8; 21];
        recovered_payload[0] = ADDRESS_PREFIX;
        recovered_payload[1..].copy_from_slice(&secp::eth_address(&recovered));
        assert_eq!(base58::encode_check(&recovered_payload), OWNER);
    }
}
