//! Plain-text target lists for the multi-target modes.
//!
//! One target per line: a chain address or a 64-hex xpoint, depending on
//! [`SearchMode`]. The address is decoded with the encoding the selected
//! [`ChainDescriptor`] declares, so a line is accepted only for `--chain`:
//! an address that belongs to another supported chain is an error naming both
//! chains, never a fallback. Blank lines and `#` comments are skipped,
//! surrounding whitespace and CRLF are tolerated, and a bad line fails with its
//! 1-based line number.

use std::io::BufRead;

use crate::base58;
use crate::chain::{self, AddressEncoding, ChainDescriptor};
use crate::cli::SearchMode;
use crate::engine::parse_hex_bytes;
use crate::filter::TargetSet;

/// Loads a text target list and builds the same [`TargetSet`] the binary
/// `-i` path uses, so CPU and GPU engines need no changes.
pub fn load<R: BufRead>(
    reader: R,
    chain: &ChainDescriptor,
    mode: SearchMode,
) -> Result<TargetSet, String> {
    let record_len = match mode {
        SearchMode::Addresses => chain.target_len(),
        SearchMode::XPoints => 32,
        _ => return Err("--targets-text requires -m addresses or -m xpoints".to_owned()),
    };

    let mut records = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        let number = index + 1;
        let line = line.map_err(|err| format!("line {number}: {err}"))?;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let record = match mode {
            SearchMode::Addresses => parse_address(line, chain),
            SearchMode::XPoints => parse_hex_bytes(line, 32)
                .ok_or_else(|| format!("invalid xpoint (expected 64 hex chars): {line}")),
            _ => unreachable!("mode was checked above"),
        }
        .map_err(|reason| format!("line {number}: {reason}"))?;
        records.push(record);
    }

    if records.is_empty() {
        return Err("target list is empty".to_owned());
    }
    Ok(TargetSet::from_records(&records, record_len))
}

/// Decodes one address line into the chain's raw target bytes.
///
/// Shared with the single-`-m address` path in [`crate::engine`] so both
/// accept exactly the encodings the selected descriptor declares.
pub(crate) fn parse_address(text: &str, chain: &ChainDescriptor) -> Result<Vec<u8>, String> {
    decode_for_chain(text, chain).map_err(|reason| describe_mismatch(text, chain, reason))
}

/// Decodes `text` with exactly the encoding `chain` declares.
///
/// Every length/version check names the chain and both lengths, so a caller
/// can report a precise error instead of "invalid address".
fn decode_for_chain(text: &str, chain: &ChainDescriptor) -> Result<Vec<u8>, String> {
    match chain.encoding {
        AddressEncoding::Base58Check(version) => {
            let payload = base58::decode_check(text)
                .map_err(|err| format!("invalid {} address: {err}: {text}", chain.name))?;
            let expected = version.len() + 20;
            if payload.len() != expected {
                return Err(format!(
                    "invalid {} address: decoded a {}-byte payload, expected {expected} bytes \
                     ({} version + 20 hash160): {text}",
                    chain.name,
                    payload.len(),
                    version.len()
                ));
            }
            if !payload.starts_with(version) {
                return Err(format!(
                    "invalid {} address: decoded version {}, expected {}: {text}",
                    chain.name,
                    hex_prefix(&payload[..version.len()]),
                    hex_prefix(version)
                ));
            }
            Ok(payload[version.len()..].to_vec())
        }
        AddressEncoding::RippleBase58 => {
            let payload = base58::decode_ripple(text)
                .map_err(|err| format!("invalid {} address: {err}: {text}", chain.name))?;
            if payload.len() != 21 {
                return Err(format!(
                    "invalid {} address: decoded a {}-byte payload, expected 21 bytes \
                     (1 version + 20 hash160): {text}",
                    chain.name,
                    payload.len()
                ));
            }
            if payload[0] != 0x00 {
                return Err(format!(
                    "invalid {} address: decoded version 0x{:02x}, expected 0x00: {text}",
                    chain.name, payload[0]
                ));
            }
            Ok(payload[1..].to_vec())
        }
        AddressEncoding::EvmHex => {
            let hex = text
                .strip_prefix("0x")
                .or_else(|| text.strip_prefix("0X"))
                .ok_or_else(|| {
                    format!(
                        "invalid {} address: expected 0x + 40 hex chars: {text}",
                        chain.name
                    )
                })?;
            if hex.len() != 40 {
                return Err(format!(
                    "invalid {} address: decoded a {}-hex-char payload, expected 40 hex chars \
                     (20 bytes): {text}",
                    chain.name,
                    hex.len()
                ));
            }
            parse_hex_bytes(hex, 20).ok_or_else(|| {
                format!(
                    "invalid {} address: payload is not hexadecimal: {text}",
                    chain.name
                )
            })
        }
        AddressEncoding::TronBase58 => {
            let payload = base58::decode_check(text)
                .map_err(|err| format!("invalid {} address: {err}: {text}", chain.name))?;
            if payload.len() != 21 {
                return Err(format!(
                    "invalid {} address: decoded a {}-byte payload, expected 21 bytes \
                     (1 version + 20 account): {text}",
                    chain.name,
                    payload.len()
                ));
            }
            if payload[0] != 0x41 {
                return Err(format!(
                    "invalid {} address: decoded version 0x{:02x}, expected 0x41: {text}",
                    chain.name, payload[0]
                ));
            }
            Ok(payload[1..].to_vec())
        }
        AddressEncoding::SolanaBase58
        | AddressEncoding::SuiHex
        | AddressEncoding::TonUserFriendly(_) => Err(format!(
            "chain '{}' compares {}-byte targets; text address targets for the {} family \
             are not implemented yet",
            chain.id,
            chain.target_len(),
            chain.family.label()
        )),
    }
}

/// Turns a decode failure into the most specific error available.
///
/// When the line is a valid address of another supported 20-byte chain, the
/// message names both chains and says mixed target files are rejected. The
/// loader never falls back to the other encoding.
fn describe_mismatch(text: &str, chain: &ChainDescriptor, reason: String) -> String {
    match identify_chain(text) {
        Some(other) => format!(
            "{text}: address is on chain '{}', but --chain is '{}'; \
             mixed chains in one target file are not supported",
            other.id, chain.id
        ),
        None => reason,
    }
}

/// The first supported 20-byte chain whose encoding accepts `text`.
///
/// Used only to explain a failure (never to accept a target). Descriptors that
/// share an encoding are interchangeable by construction: BTC/BCH share the
/// 0x00 Base58Check form and every EVM chain shares the `0x` account form.
fn identify_chain(text: &str) -> Option<&'static ChainDescriptor> {
    chain::all()
        .iter()
        .filter(|candidate| candidate.target_len() == 20)
        .find(|candidate| decode_for_chain(text, candidate).is_ok())
}

fn hex_prefix(bytes: &[u8]) -> String {
    let mut out = String::from("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::load;
    use crate::base58;
    use crate::chain;
    use crate::cli::SearchMode;
    use crate::scalar::Scalar;
    use crate::secp::{self, mul_g};

    fn bitcoin() -> &'static chain::ChainDescriptor {
        chain::by_id("bitcoin").expect("bitcoin descriptor")
    }

    fn ethereum() -> &'static chain::ChainDescriptor {
        chain::by_id("ethereum").expect("ethereum descriptor")
    }

    fn btc_hash160(key: u64) -> [u8; 20] {
        secp::hash160(&mul_g(&Scalar::from_u64(key)), true)
    }

    fn btc_address(key: u64) -> String {
        base58::address_from_hash160(&btc_hash160(key), true)
    }

    fn hex_upper(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02X}")).collect()
    }

    #[test]
    fn mixed_btc_fixture_skips_comments_blanks_and_crlf() {
        let (five, seven) = (btc_address(5), btc_address(7));
        let text =
            format!("# leading comment\r\n\r\n   {five}   \r\n# between entries\r\n{seven}\r\n");

        let set = load(Cursor::new(text), bitcoin(), SearchMode::Addresses)
            .expect("mixed fixture should load");

        assert_eq!(set.len(), 2);
        assert_eq!(set.record_len(), 20);
        assert!(set.contains(&btc_hash160(5)));
        assert!(set.contains(&btc_hash160(7)));
    }

    #[test]
    fn malformed_line_reports_its_number() {
        let text = format!(
            "# comment counts\r\n\r\nnot-an-address\r\n{}\r\n",
            btc_address(5)
        );

        let err = load(Cursor::new(text), bitcoin(), SearchMode::Addresses)
            .err()
            .expect("a bad address must fail");

        assert!(err.starts_with("line 3: "), "unexpected error: {err}");
    }

    #[test]
    fn cursor_plays_the_stdin_role() {
        let text = format!("{}\n", btc_address(5));

        let set = load(Cursor::new(text), bitcoin(), SearchMode::Addresses)
            .expect("stdin-style reader should load");

        assert_eq!(set.len(), 1);
        assert!(set.contains(&btc_hash160(5)));
    }

    #[test]
    fn eth_addresses_accept_upper_and_lower_0x_prefix() {
        let one = secp::eth_address(&mul_g(&Scalar::from_u64(1)));
        let two = secp::eth_address(&mul_g(&Scalar::from_u64(2)));
        let text = format!(
            "0x{}\n  0X{}  \n",
            hex_upper(&one).to_ascii_lowercase(),
            hex_upper(&two)
        );

        let set = load(Cursor::new(text), ethereum(), SearchMode::Addresses)
            .expect("ETH fixture should load");

        assert_eq!(set.len(), 2);
        assert!(set.contains(&one));
        assert!(set.contains(&two));
    }

    #[test]
    fn xpoints_accept_mixed_case_hex() {
        let x = mul_g(&Scalar::from_u64(9)).x.to_bytes_be();
        let text = format!("# xpoints\n\n{}\n", hex_upper(&x));

        let set = load(Cursor::new(text), bitcoin(), SearchMode::XPoints)
            .expect("xpoint fixture should load");

        assert_eq!(set.len(), 1);
        assert_eq!(set.record_len(), 32);
        assert!(set.contains(&x));
    }

    #[test]
    fn empty_list_is_rejected() {
        let err = load(
            Cursor::new("# only comments\n\n"),
            bitcoin(),
            SearchMode::Addresses,
        )
        .err()
        .expect("an empty list must fail");
        assert_eq!(err, "target list is empty");
    }
}
