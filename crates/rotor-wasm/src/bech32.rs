//! Minimal BIP173 (bech32) and BIP350 (bech32m) segwit encoder.
//!
//! Only encoding is needed: witness programs are hashes and x-only public
//! keys produced locally, so there is no decoder and no dependency.

/// Character set shared by bech32 and bech32m.
const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// BIP173 checksum constant.
const BECH32_CONST: u32 = 1;
/// BIP350 checksum constant.
const BECH32M_CONST: u32 = 0x2bc8_30a3;

fn polymod(values: &[u8]) -> u32 {
    const GENERATOR: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let mut checksum = 1u32;
    for &value in values {
        let top = checksum >> 25;
        checksum = ((checksum & 0x01ff_ffff) << 5) ^ u32::from(value);
        for (index, generator) in GENERATOR.iter().enumerate() {
            if (top >> index) & 1 == 1 {
                checksum ^= generator;
            }
        }
    }
    checksum
}

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let bytes = hrp.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 2 + 1);
    out.extend(bytes.iter().map(|byte| byte >> 5));
    out.push(0);
    out.extend(bytes.iter().map(|byte| byte & 0x1f));
    out
}

/// Regroup bytes into five-bit values, padding the final group with zeroes.
fn to_five_bit(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 8 / 5 + 1);
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for &byte in data {
        accumulator = (accumulator << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(((accumulator >> bits) & 0x1f) as u8);
        }
        // Keep only the unconsumed low bits so the shift cannot overflow.
        accumulator &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(((accumulator << (5 - bits)) & 0x1f) as u8);
    }
    out
}

fn checksum(hrp: &str, data: &[u8], bech32m: bool) -> [u8; 6] {
    let mut values = hrp_expand(hrp);
    values.extend_from_slice(data);
    values.extend_from_slice(&[0u8; 6]);
    let constant = if bech32m { BECH32M_CONST } else { BECH32_CONST };
    let polymod = polymod(&values) ^ constant;
    let mut out = [0u8; 6];
    for (index, value) in out.iter_mut().enumerate() {
        *value = ((polymod >> (5 * (5 - index))) & 0x1f) as u8;
    }
    out
}

/// Encode a segwit address (`hrp1` + witness version + program + checksum).
///
/// Returns the address and its six checksum characters.
pub fn encode_segwit(hrp: &str, version: u8, program: &[u8], bech32m: bool) -> (String, String) {
    let mut data = Vec::with_capacity(program.len() * 8 / 5 + 2);
    data.push(version);
    data.extend(to_five_bit(program));

    let check = checksum(hrp, &data, bech32m);
    let mut address = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    address.push_str(hrp);
    address.push('1');
    for &value in data.iter().chain(check.iter()) {
        address.push(char::from(CHARSET[value as usize]));
    }

    let checksum_text: String = check
        .iter()
        .map(|&value| char::from(CHARSET[value as usize]))
        .collect();
    (address, checksum_text)
}

/// Decode a segwit address into its lower-case human-readable part, witness
/// version and witness program.
///
/// The checksum, mixed-case rule, padding and program length are validated.
pub fn decode_segwit(text: &str) -> Result<(String, u8, Vec<u8>), String> {
    if text.len() < 8 || text.len() > 90 {
        return Err("invalid segwit address length".to_owned());
    }
    let has_lower = text.bytes().any(|byte| byte.is_ascii_lowercase());
    let has_upper = text.bytes().any(|byte| byte.is_ascii_uppercase());
    if has_lower && has_upper {
        return Err("mixed-case segwit address".to_owned());
    }
    let lower = text.to_ascii_lowercase();
    let separator = lower
        .rfind('1')
        .ok_or_else(|| "segwit address has no separator".to_owned())?;
    if separator == 0 || lower.len() < separator + 8 {
        return Err("segwit address is too short".to_owned());
    }
    let hrp = &lower[..separator];
    if !hrp.bytes().all(|byte| (33..=126).contains(&byte)) {
        return Err("invalid segwit human-readable part".to_owned());
    }
    let data: Vec<u8> = lower[separator + 1..]
        .bytes()
        .map(|byte| {
            CHARSET
                .iter()
                .position(|&candidate| candidate == byte)
                .map(|index| index as u8)
                .ok_or_else(|| "invalid segwit character".to_owned())
        })
        .collect::<Result<_, _>>()?;

    let mut values = hrp_expand(hrp);
    values.extend_from_slice(&data);
    let polymod = polymod(&values);
    let is_bech32 = polymod == BECH32_CONST;
    let is_bech32m = polymod == BECH32M_CONST;
    if !is_bech32 && !is_bech32m {
        return Err("invalid segwit checksum".to_owned());
    }

    let payload = &data[..data.len() - 6];
    let version = *payload
        .first()
        .ok_or_else(|| "segwit address has no witness version".to_owned())?;
    if version > 16 {
        return Err(format!("invalid witness version {version}"));
    }
    if version == 0 && !is_bech32 {
        return Err("witness v0 must use a bech32 checksum".to_owned());
    }
    if version != 0 && !is_bech32m {
        return Err("witness v1+ must use a bech32m checksum".to_owned());
    }
    let program = from_five_bit(&payload[1..])?;
    if program.len() < 2 || program.len() > 40 {
        return Err("invalid witness program length".to_owned());
    }
    if version == 0 && program.len() != 20 && program.len() != 32 {
        return Err("witness v0 program must be 20 or 32 bytes".to_owned());
    }
    Ok((hrp.to_owned(), version, program))
}

/// Regroup five-bit values into bytes, rejecting non-zero or long padding.
fn from_five_bit(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(data.len() * 5 / 8);
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for &value in data {
        if value > 31 {
            return Err("invalid five-bit group".to_owned());
        }
        accumulator = (accumulator << 5) | u32::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    if bits >= 5 || accumulator != 0 {
        return Err("invalid segwit padding".to_owned());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_hex(text: &str) -> Vec<u8> {
        text.as_bytes()
            .chunks(2)
            .map(|chunk| u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap())
            .collect()
    }

    const H160: &str = "751e76e8199196d454941c45d1b3a323f1433bd6";

    #[test]
    fn bech32_witness_v0_matches_bip173() {
        let (address, checksum) = encode_segwit("bc", 0, &decode_hex(H160), false);
        assert_eq!(address, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
        assert_eq!(checksum, "v8f3t4");
    }

    #[test]
    fn bech32_witness_v0_ltc_hrp() {
        // Same program as the BIP173 vector with Litecoin's hrp; the published
        // Litecoin address for this program is ltc1qw508...gmn4n9.
        let (address, checksum) = encode_segwit("ltc", 0, &decode_hex(H160), false);
        assert_eq!(address, "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9");
        assert_eq!(checksum, "gmn4n9");
    }

    #[test]
    fn bech32m_witness_v1_matches_bip350() {
        // Published BIP350 vector: v1, 40-byte program, bech32m checksum.
        let program = decode_hex(&format!("{H160}{H160}"));
        let (address, checksum) = encode_segwit("bc", 1, &program, true);
        assert_eq!(
            address,
            "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y"
        );
        assert_eq!(checksum, "t5nd6y");

        // Published BIP350 vector: v1, the generator x coordinate as program.
        let generator_x =
            decode_hex("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
        let (address, checksum) = encode_segwit("bc", 1, &generator_x, true);
        assert_eq!(
            address,
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
        );
        assert_eq!(checksum, "zk5jj0");
    }

    #[test]
    fn decodes_testnet_p2wpkh_and_taproot_addresses() {
        // bitcoinjs-lib 6 testnet payments for compressed key 1.
        let (hrp, version, program) =
            decode_segwit("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx").unwrap();
        assert_eq!(hrp, "tb");
        assert_eq!(version, 0);
        assert_eq!(program, decode_hex(H160));

        let (hrp, version, program) =
            decode_segwit("tb1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5ssk79hv2")
                .unwrap();
        assert_eq!(hrp, "tb");
        assert_eq!(version, 1);
        assert_eq!(program.len(), 32);
    }

    #[test]
    fn decode_round_trips_and_enforces_bip173_rules() {
        let (address, _) = encode_segwit("tb", 0, &decode_hex(H160), false);
        assert_eq!(decode_segwit(&address).unwrap().0, "tb");

        // Upper case is the same address; mixed case is invalid.
        assert!(decode_segwit(&address.to_ascii_uppercase()).is_ok());
        let mixed = format!("{}{}", &address[..3], address[3..].to_ascii_uppercase());
        assert!(decode_segwit(&mixed).is_err());

        // A changed checksum character invalidates the address.
        let mut broken = address.clone();
        let last = broken.pop().unwrap();
        broken.push(if last == 'q' { 'p' } else { 'q' });
        assert!(decode_segwit(&broken).is_err());

        assert!(decode_segwit("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5").is_err());
        assert!(decode_segwit("tb1").is_err());
        assert!(decode_segwit("1qqqqqqqqqqqqqqqq").is_err());
    }
}
