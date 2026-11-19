//! RLP encoding and EIP-1559 (type-2) EVM transaction serialization.
//!
//! The request is a flat JSON object whose values are all strings: numbers
//! may be decimal or `0x`-prefixed hexadecimal, byte fields are hexadecimal.
//! Unknown, duplicate or missing fields are rejected so a caller typo cannot
//! silently sign a different transaction than the one reviewed.
//!
//! ```
//! {"chain_id":"11155111","nonce":"0","max_priority_fee":"1000000000",
//!  "max_fee":"2000000000","gas_limit":"21000",
//!  "to":"0x...20-byte...","value":"1000000000000000","data":"0x",
//!  "private_key":"0x...32-byte..."}
//! -->
//! 0x02 || rlp([chain_id, nonce, max_priority_fee, max_fee, gas_limit, to,
//!              value, data, access_list, y_parity, r, s])
//! ```

use std::fmt::Write as _;

use crate::hashes;
use crate::sign::{self, Signature};

/// The fixed request fields, in the order used by [`Request::parse`].
const FIELD_NAMES: [&str; 9] = [
    "chain_id",
    "nonce",
    "max_priority_fee",
    "max_fee",
    "gas_limit",
    "to",
    "value",
    "data",
    "private_key",
];

/// A validated type-2 signing request.
struct Request {
    chain_id: u64,
    nonce: u64,
    max_priority_fee: u128,
    max_fee: u128,
    gas_limit: u64,
    to: Option<[u8; 20]>,
    value: u128,
    data: Vec<u8>,
    private_key: [u8; 32],
}

/// A type-2 transaction without a signature.
pub struct Tx2 {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee: u128,
    pub max_fee: u128,
    pub gas_limit: u64,
    pub to: Option<[u8; 20]>,
    pub value: u128,
    pub data: Vec<u8>,
}

impl Tx2 {
    /// The nine unsigned fields, already RLP-encoded.
    fn fields(&self) -> Vec<Vec<u8>> {
        vec![
            rlp_u128(u128::from(self.chain_id)),
            rlp_u128(u128::from(self.nonce)),
            rlp_u128(self.max_priority_fee),
            rlp_u128(self.max_fee),
            rlp_u128(u128::from(self.gas_limit)),
            rlp_bytes(self.to.as_ref().map(|to| to.as_slice()).unwrap_or(&[])),
            rlp_u128(self.value),
            rlp_bytes(&self.data),
            rlp_list(&[]), // empty access list
        ]
    }

    /// `0x02 || rlp(fields)`; this is what gets hashed before signing.
    pub fn unsigned(&self) -> Vec<u8> {
        let mut out = vec![TYPE_2];
        out.extend_from_slice(&rlp_list(&self.fields()));
        out
    }

    /// EIP-2718 signing hash: keccak256 of the unsigned type-2 payload.
    pub fn signing_hash(&self) -> [u8; 32] {
        hashes::keccak256(&self.unsigned())
    }

    /// `0x02 || rlp(fields || y_parity || r || s)`.
    pub fn signed(&self, signature: &Signature) -> Vec<u8> {
        let mut fields = self.fields();
        fields.push(rlp_u128(u128::from(signature.recovery & 1)));
        fields.push(rlp_bytes(trimmed(&signature.r.to_bytes_be())));
        fields.push(rlp_bytes(trimmed(&signature.s.to_bytes_be())));
        let mut out = vec![TYPE_2];
        out.extend_from_slice(&rlp_list(&fields));
        out
    }
}

/// Type-2 transaction envelope byte (EIP-2718).
const TYPE_2: u8 = 0x02;

/// Parse, sign and serialize a request; the raw signed transaction bytes are
/// returned without a hex prefix.
pub fn sign_request(text: &str) -> Result<Vec<u8>, String> {
    let mut request = Request::parse(text)?;
    let result = sign_parsed(&request);
    sign::wipe(&mut request.private_key);
    result
}

fn sign_parsed(request: &Request) -> Result<Vec<u8>, String> {
    let tx = Tx2 {
        chain_id: request.chain_id,
        nonce: request.nonce,
        max_priority_fee: request.max_priority_fee,
        max_fee: request.max_fee,
        gas_limit: request.gas_limit,
        to: request.to,
        value: request.value,
        data: request.data.clone(),
    };
    let hash = tx.signing_hash();
    let signature = sign::sign(&hash, &request.private_key)?;
    Ok(tx.signed(&signature))
}

impl Request {
    fn parse(text: &str) -> Result<Request, String> {
        let pairs = parse_flat_object(text)?;
        let mut slots: [Option<&str>; FIELD_NAMES.len()] = [None; FIELD_NAMES.len()];
        for (key, value) in pairs {
            let index = FIELD_NAMES
                .iter()
                .position(|name| *name == key)
                .ok_or_else(|| format!("unknown request field: \"{key}\""))?;
            if slots[index].replace(value).is_some() {
                return Err(format!("duplicate request field: \"{key}\""));
            }
        }

        let required = |index: usize| {
            slots[index].ok_or_else(|| format!("missing request field: \"{}\"", FIELD_NAMES[index]))
        };

        let chain_id = parse_u64(required(0)?, "chain_id")?;
        let nonce = parse_u64(required(1)?, "nonce")?;
        let max_priority_fee = parse_u128(required(2)?, "max_priority_fee")?;
        let max_fee = parse_u128(required(3)?, "max_fee")?;
        if max_priority_fee > max_fee {
            return Err(
                "max_priority_fee must not exceed max_fee (EIP-1559 priority fee is a tip)"
                    .to_owned(),
            );
        }
        let gas_limit = parse_u64(required(4)?, "gas_limit")?;
        if gas_limit == 0 {
            return Err("gas_limit must be greater than zero".to_owned());
        }
        let to = parse_to(required(5)?)?;
        let value = parse_u128(required(6)?, "value")?;
        let data = parse_bytes(required(7)?, "data")?;
        let mut key_bytes = parse_bytes(required(8)?, "private_key")?;
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

        Ok(Request {
            chain_id,
            nonce,
            max_priority_fee,
            max_fee,
            gas_limit,
            to,
            value,
            data,
            private_key,
        })
    }
}

/// Parse a flat JSON object whose values are all strings without escapes.
fn parse_flat_object(text: &str) -> Result<Vec<(&str, &str)>, String> {
    let bytes = text.as_bytes();
    let mut at = skip_whitespace(bytes, 0);
    if bytes.get(at) != Some(&b'{') {
        return Err("request is not a JSON object".to_owned());
    }
    at += 1;

    let mut pairs = Vec::with_capacity(FIELD_NAMES.len());
    at = skip_whitespace(bytes, at);
    if bytes.get(at) == Some(&b'}') {
        at += 1;
    } else {
        loop {
            if bytes.get(at) != Some(&b'"') {
                return Err("expected a quoted request field name".to_owned());
            }
            let (key, next) = read_string(text, at)?;
            at = skip_whitespace(bytes, next);
            if bytes.get(at) != Some(&b':') {
                return Err(format!("expected ':' after \"{key}\""));
            }
            at = skip_whitespace(bytes, at + 1);
            if bytes.get(at) != Some(&b'"') {
                return Err(format!("field \"{key}\" must be a quoted string"));
            }
            let (value, next) = read_string(text, at)?;
            pairs.push((key, value));
            at = skip_whitespace(bytes, next);
            match bytes.get(at) {
                Some(b',') => at = skip_whitespace(bytes, at + 1),
                Some(b'}') => {
                    at += 1;
                    break;
                }
                _ => return Err("expected ',' or '}' after a request field".to_owned()),
            }
        }
    }

    if skip_whitespace(bytes, at) != bytes.len() {
        return Err("trailing characters after the JSON object".to_owned());
    }
    Ok(pairs)
}

fn skip_whitespace(bytes: &[u8], mut at: usize) -> usize {
    while matches!(bytes.get(at), Some(b' ' | b'\t' | b'\r' | b'\n')) {
        at += 1;
    }
    at
}

fn read_string(text: &str, start: usize) -> Result<(&str, usize), String> {
    let bytes = text.as_bytes();
    let mut at = start + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => {
                let value = &text[start + 1..at];
                if !value.is_ascii() {
                    return Err("request strings must be ASCII".to_owned());
                }
                return Ok((value, at + 1));
            }
            b'\\' => {
                return Err("escaped characters are not supported in request strings".to_owned());
            }
            byte if byte < 0x20 => {
                return Err("control characters are not allowed in request strings".to_owned());
            }
            _ => at += 1,
        }
    }
    Err("unterminated string in request".to_owned())
}

fn strip_0x(text: &str) -> Option<&str> {
    text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))
}

fn parse_u128(text: &str, field: &str) -> Result<u128, String> {
    let Some(hex) = strip_0x(text) else {
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!(
                "{field} must be a decimal or 0x-prefixed hexadecimal number"
            ));
        }
        return text
            .parse::<u128>()
            .map_err(|_| format!("{field} does not fit in 128 bits"));
    };
    if hex.is_empty() {
        return Ok(0);
    }
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{field} is not hexadecimal"));
    }
    u128::from_str_radix(hex, 16).map_err(|_| format!("{field} does not fit in 128 bits"))
}

fn parse_u64(text: &str, field: &str) -> Result<u64, String> {
    let value = parse_u128(text, field)?;
    u64::try_from(value).map_err(|_| format!("{field} does not fit in 64 bits"))
}

fn parse_bytes(text: &str, field: &str) -> Result<Vec<u8>, String> {
    let hex = strip_0x(text).unwrap_or(text);
    if !hex.len().is_multiple_of(2) {
        return Err(format!("{field} must have an even number of hex digits"));
    }
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{field} is not hexadecimal"));
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for index in (0..hex.len()).step_by(2) {
        out.push(
            u8::from_str_radix(&hex[index..index + 2], 16)
                .map_err(|_| format!("{field} is not hexadecimal"))?,
        );
    }
    Ok(out)
}

/// `to` is either empty (contract creation) or a 20-byte address.
fn parse_to(text: &str) -> Result<Option<[u8; 20]>, String> {
    let bytes = parse_bytes(text, "to")?;
    match bytes.len() {
        0 => Ok(None),
        20 => {
            let mut address = [0u8; 20];
            address.copy_from_slice(&bytes);
            Ok(Some(address))
        }
        length => Err(format!(
            "to must be empty or a 20-byte address, got {length} bytes"
        )),
    }
}

/// RLP for a byte string.
fn rlp_bytes(data: &[u8]) -> Vec<u8> {
    if data.len() == 1 && data[0] < 0x80 {
        return vec![data[0]];
    }
    let mut out = Vec::with_capacity(data.len() + 9);
    rlp_length(&mut out, data.len(), 0x80, 0xb7);
    out.extend_from_slice(data);
    out
}

/// RLP for a list of already-encoded items.
fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: usize = items.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(payload + 9);
    rlp_length(&mut out, payload, 0xc0, 0xf7);
    for item in items {
        out.extend_from_slice(item);
    }
    out
}

/// RLP for a non-negative integer in minimal big-endian form; zero is empty.
fn rlp_u128(value: u128) -> Vec<u8> {
    rlp_bytes(trimmed(&value.to_be_bytes()))
}

/// The bytes after the last leading zero; all-zero input is empty.
fn trimmed(bytes: &[u8]) -> &[u8] {
    let first = bytes
        .iter()
        .position(|&byte| byte != 0)
        .unwrap_or(bytes.len());
    &bytes[first..]
}

fn rlp_length(out: &mut Vec<u8>, length: usize, short_base: u8, long_base: u8) {
    if length <= 55 {
        out.push(short_base + length as u8);
        return;
    }
    let length_bytes = (length as u128).to_be_bytes();
    let encoded = trimmed(&length_bytes);
    out.push(long_base + encoded.len() as u8);
    out.extend_from_slice(encoded);
}

/// Lowercase `0x`-prefixed hex.
pub fn hex_prefixed(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scalar::Scalar;

    #[test]
    fn rlp_reference_vectors() {
        assert_eq!(rlp_bytes(b""), vec![0x80]);
        assert_eq!(rlp_bytes(b"dog"), vec![0x83, b'd', b'o', b'g']);
        assert_eq!(rlp_bytes(&[0x00]), vec![0x00]);
        assert_eq!(rlp_bytes(&[0x7f]), vec![0x7f]);
        assert_eq!(rlp_bytes(&[0x80]), vec![0x81, 0x80]);
        assert_eq!(
            rlp_bytes(&[b'a'; 56])[..2],
            [0xb8, 56],
            "long string header"
        );
        // ["cat", "dog"]
        assert_eq!(
            rlp_list(&[rlp_bytes(b"cat"), rlp_bytes(b"dog")]),
            vec![0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
    }

    #[test]
    fn rlp_integers_are_minimal() {
        assert_eq!(rlp_u128(0), vec![0x80]);
        assert_eq!(rlp_u128(1), vec![0x01]);
        assert_eq!(rlp_u128(0x80), vec![0x81, 0x80]);
        assert_eq!(rlp_u128(1000), vec![0x82, 0x03, 0xe8]);
    }

    #[test]
    fn parses_numbers_and_bytes() {
        assert_eq!(parse_u64("21000", "x").unwrap(), 21000);
        assert_eq!(parse_u64("0x5208", "x").unwrap(), 21000);
        assert_eq!(parse_u128("0x", "x").unwrap(), 0);
        assert_eq!(parse_u128("0x0", "x").unwrap(), 0);
        assert!(parse_u64("0x10000000000000000", "x").is_err());
        assert!(parse_u64("-1", "x").is_err());
        assert!(parse_u64("1_000", "x").is_err());
        assert_eq!(parse_bytes("0x1234", "x").unwrap(), vec![0x12, 0x34]);
        assert!(parse_bytes("0x1", "x").is_err());
        assert!(parse_bytes("zz", "x").is_err());
        assert_eq!(parse_to("").unwrap(), None);
        assert_eq!(parse_to("0x").unwrap(), None);
        let address = "0x3535353535353535353535353535353535353535";
        assert_eq!(parse_to(address).unwrap(), Some([0x35; 20]));
        assert!(parse_to("0x1234").is_err());
    }

    #[test]
    fn rejects_malformed_requests() {
        let valid = r#"{
            "chain_id":"11155111","nonce":"0","max_priority_fee":"1",
            "max_fee":"2","gas_limit":"21000",
            "to":"0x3535353535353535353535353535353535353535","value":"0",
            "data":"","private_key":"0x0000000000000000000000000000000000000000000000000000000000000001"
        }"#;
        assert!(Request::parse(valid).is_ok());

        // Missing field.
        let missing = valid.replace(r#""nonce":"0","#, "");
        assert!(Request::parse(&missing).is_err());
        // Unknown field.
        let unknown = valid.replace(r#""nonce":"0","#, r#""nonce":"0","nonce2":"0","#);
        assert!(Request::parse(&unknown).is_err());
        // Duplicate field.
        let duplicate = valid.replace(r#""nonce":"0","#, r#""nonce":"0","nonce":"1","#);
        assert!(Request::parse(&duplicate).is_err());
        // Unquoted value and trailing garbage.
        assert!(Request::parse(&valid.replace(r#""value":"0""#, r#""value":0"#)).is_err());
        assert!(Request::parse(&format!("{valid}x")).is_err());
        assert!(Request::parse(&valid.replace(r#""nonce":"0","#, r#""nonce":"0",,"#)).is_err());
        assert!(
            Request::parse(&format!("{{{},}}", &valid[1..valid.len() - 1])).is_err(),
            "trailing comma"
        );
        // Invalid ranges.
        assert!(
            Request::parse(&valid.replace(r#""gas_limit":"21000""#, r#""gas_limit":"0""#)).is_err()
        );
        assert!(
            Request::parse(
                &valid.replace(r#""max_priority_fee":"1""#, r#""max_priority_fee":"3""#)
            )
            .is_err(),
            "priority fee above max fee"
        );
        assert!(
            Request::parse(&valid.replace(r#""nonce":"0""#, r#""nonce":"18446744073709551616""#))
                .is_err()
        );
        assert!(
            Request::parse(&valid.replace(
                r#""chain_id":"11155111""#,
                r#""chain_id":"0x10000000000000000""#
            ))
            .is_err()
        );
        // Wrong key length.
        assert!(
            Request::parse(&valid.replace(
                "0000000000000000000000000000000000000000000000000000000000000001",
                "00000000000000000000000000000000000000000000000000000000000001"
            ))
            .is_err()
        );
        // Empty data is accepted and encodes as 0x80 inside the payload.
        let request = Request::parse(valid).unwrap();
        assert!(request.data.is_empty());
    }

    /// Raw signed transactions reproduced independently with ethers 6.17.0
    /// (`new Wallet(key).signTransaction(tx)`, `type: 2`) under Node 24 on
    /// 2026-11-19. Pin both the raw bytes and the signer address so a change
    /// in RLP, signing or recovery is caught.
    #[test]
    fn eip1559_vectors_match_ethers() {
        let key1 = "0x0000000000000000000000000000000000000000000000000000000000000001";
        let key2 = "0x4c0b6c2b4f0a5d9e8f1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcd00";

        let cases: [(&str, &str, &str); 3] = [
            (
                "sepolia-transfer",
                &format!(
                    r#"{{"chain_id":"11155111","nonce":"0","max_priority_fee":"1000000000",
                    "max_fee":"2000000000","gas_limit":"21000",
                    "to":"0x3535353535353535353535353535353535353535","value":"1000000000000000",
                    "data":"0x","private_key":"{key1}"}}"#
                ),
                "0x02f87483aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c080a0d02b933531d628f5d2251fbf58903a4d720f9bd6c7c51f7578f7cf301f761263a012a7d571860bb8d7e71bcb6c63d265bc6fc57b250b9381cbc18c1543c282b147",
            ),
            (
                "mainnet-erc20",
                &format!(
                    r#"{{"chain_id":"1","nonce":"7","max_priority_fee":"1500000000",
                    "max_fee":"30000000000","gas_limit":"60000",
                    "to":"0xdAC17F958D2ee523a2206206994597C13D831ec7","value":"0",
                    "data":"0xa9059cbb0000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf00000000000000000000000000000000000000000000000000000000000f4240",
                    "private_key":"{key2}"}}"#
                ),
                "0x02f8b001078459682f008506fc23ac0082ea6094dac17f958d2ee523a2206206994597c13d831ec780b844a9059cbb0000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf00000000000000000000000000000000000000000000000000000000000f4240c080a0e5044cdcba895d088cdd57793550a15ca68f0a2472881287c1f24417a6295b75a07a7e5f9087fae4a848be5b2736b6c14ddb6976b798db83fe78c1a95973d68ba7",
            ),
            (
                "contract-creation with leading-zero r",
                &format!(
                    r#"{{"chain_id":"31337","nonce":"3","max_priority_fee":"0",
                    "max_fee":"1000000000","gas_limit":"100000","to":"","value":"0",
                    "data":"600160005260206000f3","private_key":"{key1}"}}"#
                ),
                "0x02f85f827a690380843b9aca00830186a080808a600160005260206000f3c001a00e6f0062e21a326d11170fcffdc9ec1e1cf27c5562687a1a23657c27f364dcc5a0756eca5f06fc7526fd8530fc749c089985c017e745329b20284ab5df0a663f56",
            ),
        ];

        for (name, request, expected) in cases {
            let raw = sign_request(request).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(hex_prefixed(&raw), expected, "{name}");
        }

        // The vectors' signer addresses, derived from the same keys.
        let key1 = Scalar::from_u64(1);
        assert_eq!(
            crate::derive::hex(&crate::secp::eth_address(&crate::secp::mul_g(&key1))),
            "7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
        let key2_bytes = parse_bytes(key2, "key").unwrap();
        let key2 = Scalar::from_bytes_be(&key2_bytes.try_into().unwrap()).unwrap();
        assert_eq!(
            crate::derive::hex(&crate::secp::eth_address(&crate::secp::mul_g(&key2))),
            "acc50517bd89088ebf93a9baacc72aa639aa6952"
        );
    }
}
