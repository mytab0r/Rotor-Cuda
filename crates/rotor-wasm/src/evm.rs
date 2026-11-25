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
//!
//! [`unsigned_request`] accepts the same object without `private_key` and
//! returns the reviewed `0x02 || rlp([...access_list])` payload.

use std::fmt::Write as _;

use crate::hashes;
use crate::json::{parse_bytes, parse_u64, parse_u128};
use crate::sign::{self, Signature};

/// The fixed request fields, in the order used by [`Request::parse`].
/// The first eight are the transaction itself; only signing adds a key.
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

/// Number of transaction fields; `private_key` is appended after these.
const TX_FIELDS: usize = 8;

/// A validated type-2 signing request.
struct Request {
    tx: Tx2,
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

/// Parse and serialize the unsigned type-2 transaction:
/// `0x02 || rlp([chain_id, nonce, max_priority_fee, max_fee, gas_limit, to,
/// value, data, access_list])`, without a prefix.
///
/// The request is the same flat JSON object as [`sign_request`] but without
/// `private_key`; a key field is rejected so the caller cannot believe a
/// signature was produced.
pub fn unsigned_request(text: &str) -> Result<Vec<u8>, String> {
    let slots = parse_slots(text, &FIELD_NAMES[..TX_FIELDS])?;
    Ok(parse_tx(&slots)?.unsigned())
}

fn sign_parsed(request: &Request) -> Result<Vec<u8>, String> {
    let hash = request.tx.signing_hash();
    let signature = sign::sign(&hash, &request.private_key)?;
    Ok(request.tx.signed(&signature))
}

/// EIP-191 `personal_sign` hash:
/// `keccak256("\x19Ethereum Signed Message:\n" || decimal byte length || message)`.
pub fn personal_message_hash(message: &[u8]) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut data = Vec::with_capacity(prefix.len() + message.len());
    data.extend_from_slice(prefix.as_bytes());
    data.extend_from_slice(message);
    hashes::keccak256(&data)
}

/// Sign an arbitrary message as EIP-191 `personal_sign` does.
///
/// Returns the 65-byte `r || s || v` signature with `v = 27 + parity`, the
/// convention ethers `signMessage` emits.
pub fn sign_message(key: &[u8; 32], message: &[u8]) -> Result<[u8; 65], String> {
    let hash = personal_message_hash(message);
    let signature = sign::sign(&hash, key)?;
    let mut out = [0u8; 65];
    out[..32].copy_from_slice(&signature.r.to_bytes_be());
    out[32..64].copy_from_slice(&signature.s.to_bytes_be());
    // Only the parity bit is encoded; `x(R) >= n` (+2) is astronomically rare
    // and no personal_sign consumer can express it.
    out[64] = 27 + (signature.recovery & 1);
    Ok(out)
}

impl Request {
    fn parse(text: &str) -> Result<Request, String> {
        let slots = parse_slots(text, &FIELD_NAMES)?;
        let tx = parse_tx(&slots[..TX_FIELDS])?;
        let key_text = slots[TX_FIELDS]
            .ok_or_else(|| format!("missing request field: \"{}\"", FIELD_NAMES[TX_FIELDS]))?;
        let mut key_bytes = parse_bytes(key_text, "private_key")?;
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

/// Match every `name: "value"` pair to its slot, rejecting unknown and
/// duplicate names.
pub(crate) fn parse_slots<'a>(
    text: &'a str,
    names: &[&str],
) -> Result<Vec<Option<&'a str>>, String> {
    let pairs = parse_flat_object(text)?;
    let mut slots = vec![None; names.len()];
    for (key, value) in pairs {
        let index = names
            .iter()
            .position(|name| *name == key)
            .ok_or_else(|| format!("unknown request field: \"{key}\""))?;
        if slots[index].replace(value).is_some() {
            return Err(format!("duplicate request field: \"{key}\""));
        }
    }
    Ok(slots)
}

/// Validate the eight transaction fields and build the unsigned transaction.
fn parse_tx(slots: &[Option<&str>]) -> Result<Tx2, String> {
    let required = |index: usize| {
        slots[index].ok_or_else(|| format!("missing request field: \"{}\"", FIELD_NAMES[index]))
    };

    let chain_id = parse_u64(required(0)?, "chain_id")?;
    let nonce = parse_u64(required(1)?, "nonce")?;
    let max_priority_fee = parse_u128(required(2)?, "max_priority_fee")?;
    let max_fee = parse_u128(required(3)?, "max_fee")?;
    if max_priority_fee > max_fee {
        return Err(
            "max_priority_fee must not exceed max_fee (EIP-1559 priority fee is a tip)".to_owned(),
        );
    }
    let gas_limit = parse_u64(required(4)?, "gas_limit")?;
    if gas_limit == 0 {
        return Err("gas_limit must be greater than zero".to_owned());
    }
    Ok(Tx2 {
        chain_id,
        nonce,
        max_priority_fee,
        max_fee,
        gas_limit,
        to: parse_to(required(5)?)?,
        value: parse_u128(required(6)?, "value")?,
        data: parse_bytes(required(7)?, "data")?,
    })
}

/// Parse a flat JSON object whose values are all strings without escapes.
pub(crate) fn parse_flat_object(text: &str) -> Result<Vec<(&str, &str)>, String> {
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
        assert!(request.tx.data.is_empty());
    }

    /// The unsigned payload of the first pinned vector, i.e. the signed
    /// transaction with the trailing `y_parity`, `r` and `s` list items
    /// removed. ethers 6.17.0 reports the same bytes as
    /// `Transaction.unsignedSerialized` for these fields.
    #[test]
    fn unsigned_type2_vector_matches_ethers() {
        let request = r#"{"chain_id":"11155111","nonce":"0",
            "max_priority_fee":"1000000000","max_fee":"2000000000",
            "gas_limit":"21000",
            "to":"0x3535353535353535353535353535353535353535",
            "value":"1000000000000000","data":"0x"}"#;
        let raw = unsigned_request(request).expect("unsigned transaction");
        assert_eq!(
            hex_prefixed(&raw),
            "0x02f183aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c0"
        );

        // The unsigned request is exactly the signing request without a key:
        // a key or any unknown field is a typo, not something to ignore.
        let with_key = request.replace(
            r#""data":"0x""#,
            r#""data":"0x","private_key":"0x0000000000000000000000000000000000000000000000000000000000000001""#,
        );
        assert!(unsigned_request(&with_key).is_err());
        assert!(unsigned_request("{}").is_err());
        assert!(unsigned_request(&format!("{request}x")).is_err());
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

    /// EIP-191 `personal_sign` vectors reproduced independently with ethers
    /// 6.13.4 (`new Wallet(key).signMessage(message)`) under Node 24 on
    /// 2026-11-22. The trailing byte is the ethers `v` (27/28).
    #[test]
    fn personal_sign_vectors_match_ethers() {
        let key1 = parse_bytes(
            "0x0000000000000000000000000000000000000000000000000000000000000001",
            "key",
        )
        .unwrap()
        .try_into()
        .unwrap();
        let key2 = parse_bytes(
            "0x4c0b6c2b4f0a5d9e8f1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcd00",
            "key",
        )
        .unwrap()
        .try_into()
        .unwrap();

        let siwe = "rotor.test wants you to sign in with your Ethereum account:\n\
                    0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf\n\n\
                    Rotor monitor login\n\n\
                    URI: http://rotor.test";
        let cases: [(&[u8; 32], &str, &str); 4] = [
            (
                &key1,
                "Hello World",
                "0x9020b81ff870c0fcdd0c0b1945770f2358c51ec57a0f4e6d9d82ce50d4988f483b767a68a5f051a9d6c25daf303583ea6e3e03875f735a9e2900d6e4099a03cb1b",
            ),
            (
                &key1,
                "",
                "0x0ac02a3eb3039b7a3ebb6a35f1e0dd31a4ed51781205a2c193354752a25edad50593868baf38c519b78bdc61a23c3f55e058c29f8b83d79ae48cc47d931afaed1b",
            ),
            (
                &key1,
                siwe,
                "0xd9c8dd3a9febe925b1130cc398c1e2abf8b91eff485c03e5b6401a97dbc98788337f1b82f282ef3bf61b8625c4085dbd9c7cf4a5b35e4a4b1299f3f80b838f331c",
            ),
            (
                &key2,
                "Hello World",
                "0xf55347a46ef6bfdb2b278ac01c22eecc4ff115f52a823528d6c5f57757280bba221a66587c58fbec270762d9821d2c55b8eb21f92e2978e24acdea1098dcf8f61b",
            ),
        ];
        for (key, message, expected) in cases {
            let signature = sign_message(key, message.as_bytes()).unwrap();
            assert_eq!(hex_prefixed(&signature), expected, "{message:?}");
        }
    }

    /// A different key must not recover to the same address, and the empty
    /// message is signed as the EIP-191 preimage of zero bytes (not skipped).
    #[test]
    fn personal_sign_rejects_wrong_keys() {
        let key1 = Scalar::from_u64(1);
        let key1_bytes = key1.to_bytes_be();
        let key2 = Scalar::from_u64(2);
        let key2_bytes = key2.to_bytes_be();

        let signed = sign_message(&key1_bytes, b"Hello World").unwrap();
        assert_ne!(
            hex_prefixed(&signed),
            hex_prefixed(&sign_message(&key2_bytes, b"Hello World").unwrap())
        );

        let hash = personal_message_hash(b"Hello World");
        let r = Scalar::from_bytes_be(&signed[..32].try_into().unwrap()).unwrap();
        let s = Scalar::from_bytes_be(&signed[32..64].try_into().unwrap()).unwrap();
        let recovered = sign::recover(
            &hash,
            &Signature {
                r,
                s,
                recovery: signed[64] - 27,
            },
        )
        .expect("recover");
        assert_eq!(
            crate::derive::hex(&crate::secp::eth_address(&recovered)),
            crate::derive::hex(&crate::secp::eth_address(&crate::secp::mul_g(&key1)))
        );
        assert_ne!(
            crate::derive::hex(&crate::secp::eth_address(&recovered)),
            crate::derive::hex(&crate::secp::eth_address(&crate::secp::mul_g(&key2)))
        );

        assert!(sign_message(&[0u8; 32], b"Hello World").is_err());
        assert!(
            sign_message(
                &parse_bytes(
                    "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
                    "key"
                )
                .unwrap()
                .try_into()
                .unwrap(),
                b"Hello World"
            )
            .is_err()
        );
    }
}
