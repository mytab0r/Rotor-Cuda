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
}
