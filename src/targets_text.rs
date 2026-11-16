//! Plain-text target lists for the multi-target modes.
//!
//! One target per line: a BTC P2PKH address, an ETH `0x…` address (selected by
//! `Coin`) or a 64-hex xpoint, depending on [`SearchMode`]. Blank lines and
//! `#` comments are skipped, surrounding whitespace and CRLF are tolerated, and
//! a bad line fails with its 1-based line number.

use std::io::BufRead;

use crate::base58;
use crate::cli::{Coin, SearchMode};
use crate::engine::parse_hex_bytes;
use crate::filter::TargetSet;

/// Loads a text target list and builds the same [`TargetSet`] the binary
/// `-i` path uses, so CPU and GPU engines need no changes.
pub fn load<R: BufRead>(reader: R, coin: Coin, mode: SearchMode) -> Result<TargetSet, String> {
    let record_len = match mode {
        SearchMode::Addresses => 20,
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
            SearchMode::Addresses => parse_address(line, coin),
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

/// Decodes one address line into its 20-byte hash160 record.
fn parse_address(text: &str, coin: Coin) -> Result<Vec<u8>, String> {
    match coin {
        Coin::Btc => {
            let payload = base58::decode_check(text)?;
            if payload.len() != 21 || payload[0] != 0x00 {
                return Err(format!(
                    "invalid BTC P2PKH address (expected a 21-byte 0x00 payload): {text}"
                ));
            }
            Ok(payload[1..].to_vec())
        }
        Coin::Eth => {
            let hex = text
                .strip_prefix("0x")
                .or_else(|| text.strip_prefix("0X"))
                .ok_or_else(|| {
                    format!("invalid ETH address (expected 0x + 40 hex chars): {text}")
                })?;
            parse_hex_bytes(hex, 20)
                .ok_or_else(|| format!("invalid ETH address (expected 0x + 40 hex chars): {text}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::load;
    use crate::base58;
    use crate::cli::{Coin, SearchMode};
    use crate::scalar::Scalar;
    use crate::secp::{self, mul_g};

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

        let set = load(Cursor::new(text), Coin::Btc, SearchMode::Addresses)
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

        let err = load(Cursor::new(text), Coin::Btc, SearchMode::Addresses)
            .err()
            .expect("a bad address must fail");

        assert!(err.starts_with("line 3: "), "unexpected error: {err}");
    }

    #[test]
    fn cursor_plays_the_stdin_role() {
        let text = format!("{}\n", btc_address(5));

        let set = load(Cursor::new(text), Coin::Btc, SearchMode::Addresses)
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

        let set = load(Cursor::new(text), Coin::Eth, SearchMode::Addresses)
            .expect("ETH fixture should load");

        assert_eq!(set.len(), 2);
        assert!(set.contains(&one));
        assert!(set.contains(&two));
    }

    #[test]
    fn xpoints_accept_mixed_case_hex() {
        let x = mul_g(&Scalar::from_u64(9)).x.to_bytes_be();
        let text = format!("# xpoints\n\n{}\n", hex_upper(&x));

        let set = load(Cursor::new(text), Coin::Btc, SearchMode::XPoints)
            .expect("xpoint fixture should load");

        assert_eq!(set.len(), 1);
        assert_eq!(set.record_len(), 32);
        assert!(set.contains(&x));
    }

    #[test]
    fn empty_list_is_rejected() {
        let err = load(
            Cursor::new("# only comments\n\n"),
            Coin::Btc,
            SearchMode::Addresses,
        )
        .err()
        .expect("an empty list must fail");
        assert_eq!(err, "target list is empty");
    }
}
