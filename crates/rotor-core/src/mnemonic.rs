//! BIP39 mnemonic and BIP32 private-derivation helpers.
//!
//! Sentence/seed handling comes from the `bip39` crate (pure Rust, English
//! wordlist). BIP32 CKDpriv is implemented locally on top of [`crate::scalar`]
//! and [`crate::secp`] with HMAC-SHA512 built from `sha2::Sha512`, so no
//! `bip32`/`k256` dependency is needed.
//!
//! The module is pure: it never reads the OS RNG, the clock, the filesystem or
//! the environment. Entropy is supplied by the caller.

use std::fmt::Write as _;

use bip39::Mnemonic;
use sha2::{Digest, Sha512};

use crate::base58;
use crate::hashes;
use crate::scalar::Scalar;
use crate::secp;

/// Default BIP44 path for the first BTC account key.
pub const DEFAULT_PATH: &str = "m/44'/0'/0'/0/0";

/// Hardened-index flag in a parsed BIP32 path component.
pub const HARDENED: u32 = 0x8000_0000;

/// Largest non-hardened index (`2^31 - 1`).
pub const MAX_INDEX: u32 = HARDENED - 1;

/// Entropy sizes accepted by BIP39 and by `--entropy-bits`.
pub const ENTROPY_BITS: [u32; 5] = [128, 160, 192, 224, 256];

/// HMAC-SHA512 (RFC 2104) over `sha2::Sha512`, 128-byte block size.
pub fn hmac_sha512(key: &[u8], data: &[u8]) -> [u8; 64] {
    const BLOCK: usize = 128;

    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..64].copy_from_slice(&Sha512::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36u8; BLOCK];
    let mut outer_pad = [0x5cu8; BLOCK];
    for ((inner, outer), byte) in inner_pad
        .iter_mut()
        .zip(outer_pad.iter_mut())
        .zip(block.iter())
    {
        *inner ^= byte;
        *outer ^= byte;
    }

    let mut inner = Sha512::new();
    inner.update(inner_pad);
    inner.update(data);
    let inner_digest = inner.finalize();

    let mut outer = Sha512::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    let mut out = [0u8; 64];
    out.copy_from_slice(&outer.finalize());
    out
}

/// A BIP32 extended private key: the private key and its chain code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExtendedKey {
    pub key: Scalar,
    pub chain_code: [u8; 32],
}

fn scalar_from_slice(bytes: &[u8]) -> Result<Scalar, String> {
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "BIP32: expected a 32-byte scalar".to_owned())?;
    Scalar::from_bytes_be(&array)
        .ok_or_else(|| "BIP32: key is not below the curve order".to_owned())
}

/// BIP32 master key: `I = HMAC-SHA512("Bitcoin seed", seed)`.
pub fn master_from_seed(seed: &[u8]) -> Result<ExtendedKey, String> {
    if seed.is_empty() {
        return Err("BIP32: seed must not be empty".to_owned());
    }
    let digest = hmac_sha512(b"Bitcoin seed", seed);
    let key = scalar_from_slice(&digest[..32])?;
    if key.is_zero() {
        return Err("BIP32: master key is zero".to_owned());
    }
    let mut chain_code = [0u8; 32];
    chain_code.copy_from_slice(&digest[32..]);
    Ok(ExtendedKey { key, chain_code })
}

/// BIP32 private child derivation (`CKDpriv`) for normal and hardened indices.
pub fn ckd_priv(parent: &ExtendedKey, index: u32) -> Result<ExtendedKey, String> {
    let mut data = [0u8; 37];
    if index & HARDENED != 0 {
        data[1..33].copy_from_slice(&parent.key.to_bytes_be());
    } else {
        data[..33].copy_from_slice(&secp::compress(&secp::mul_g(&parent.key)));
    }
    data[33..].copy_from_slice(&index.to_be_bytes());

    let digest = hmac_sha512(&parent.chain_code, &data);
    let il = scalar_from_slice(&digest[..32])?;
    if il.is_zero() {
        return Err(format!(
            "BIP32: invalid child at index {index} (IL is zero)"
        ));
    }
    let key = il.add(&parent.key);
    if key.is_zero() {
        return Err(format!(
            "BIP32: invalid child at index {index} (key is zero)"
        ));
    }

    let mut chain_code = [0u8; 32];
    chain_code.copy_from_slice(&digest[32..]);
    Ok(ExtendedKey { key, chain_code })
}

/// Strict BIP32 path parser: `m`, `m/0`, `m/0'`, `m/44'/0'/0'/0/0`.
///
/// `'`, `h` and `H` mark a hardened component. Indices are decimal and must be
/// at most `2^31 - 1`; empty components and any other suffixes are rejected.
pub fn parse_path(path: &str) -> Result<Vec<u32>, String> {
    let mut components = path.split('/');
    match components.next() {
        Some("m") => {}
        _ => {
            return Err(format!("invalid BIP32 path '{path}': must start with 'm'"));
        }
    }

    let mut indices = Vec::new();
    for component in components {
        if component.is_empty() {
            return Err(format!("invalid BIP32 path '{path}': empty component"));
        }
        let (digits, hardened) = match component.as_bytes().last() {
            Some(b'\'') | Some(b'h') | Some(b'H') => (&component[..component.len() - 1], true),
            _ => (component, false),
        };
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!(
                "invalid BIP32 path '{path}': '{component}' is not a decimal index"
            ));
        }
        let index = digits.parse::<u64>().map_err(|_| {
            format!("invalid BIP32 path '{path}': '{component}' is not a decimal index")
        })?;
        if index > u64::from(MAX_INDEX) {
            return Err(format!(
                "invalid BIP32 path '{path}': index {index} exceeds the maximum of {MAX_INDEX}"
            ));
        }
        indices.push(index as u32 | if hardened { HARDENED } else { 0 });
    }
    Ok(indices)
}

/// Derives a path from an already-built master key.
pub fn derive_path(master: &ExtendedKey, path: &str) -> Result<ExtendedKey, String> {
    let mut current = *master;
    for index in parse_path(path)? {
        current = ckd_priv(&current, index)?;
    }
    Ok(current)
}

/// A derived key with its BTC P2PKH encoding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Derived {
    pub key: Scalar,
    /// Compressed public key.
    pub pubkey: [u8; 33],
    /// BTC P2PKH address for the compressed key.
    pub address: String,
}

/// Derives the BIP32 master key and the key/address at `path` from `mnemonic`.
pub fn derive_master_and_key(
    mnemonic: &Mnemonic,
    passphrase: &str,
    path: &str,
) -> Result<(ExtendedKey, Derived), String> {
    let seed = mnemonic.to_seed(passphrase);
    let master = master_from_seed(&seed)?;
    let key = derive_path(&master, path)?.key;
    let pubkey = secp::compress(&secp::mul_g(&key));
    let hash = hashes::hash160(&pubkey);
    let address = base58::address_from_hash160(&hash, true);
    Ok((
        master,
        Derived {
            key,
            pubkey,
            address,
        },
    ))
}

fn derive_mnemonic(mnemonic: &Mnemonic, passphrase: &str, path: &str) -> Result<Derived, String> {
    Ok(derive_master_and_key(mnemonic, passphrase, path)?.1)
}

/// Parses a BIP39 phrase and derives `path` (default `m/44'/0'/0'/0/0`).
pub fn derive(phrase: &str, passphrase: &str, path: &str) -> Result<Derived, String> {
    let mnemonic = Mnemonic::parse(phrase).map_err(|err| format!("invalid BIP39 phrase: {err}"))?;
    derive_mnemonic(&mnemonic, passphrase, path)
}

/// Encodes raw entropy (16/20/24/28/32 bytes) as a BIP39 phrase.
pub fn phrase_from_entropy(entropy: &[u8]) -> Result<String, String> {
    let mnemonic =
        Mnemonic::from_entropy(entropy).map_err(|err| format!("invalid BIP39 entropy: {err}"))?;
    Ok(mnemonic.to_string())
}

/// Builds N-bit big-endian entropy with `counter` in its low bits.
pub fn entropy_for_counter(counter: u64, entropy_bits: u32) -> Result<Vec<u8>, String> {
    if !ENTROPY_BITS.contains(&entropy_bits) {
        return Err(format!(
            "--entropy-bits must be one of 128, 160, 192, 224, 256 (got {entropy_bits})"
        ));
    }
    let mut entropy = vec![0u8; (entropy_bits / 8) as usize];
    let offset = entropy.len() - std::mem::size_of::<u64>();
    entropy[offset..].copy_from_slice(&counter.to_be_bytes());
    Ok(entropy)
}

/// Phrase and derived key for one audit counter.
pub fn derive_counter(
    counter: u64,
    entropy_bits: u32,
    passphrase: &str,
    path: &str,
) -> Result<(String, Derived), String> {
    let entropy = entropy_for_counter(counter, entropy_bits)?;
    let mnemonic =
        Mnemonic::from_entropy(&entropy).map_err(|err| format!("invalid BIP39 entropy: {err}"))?;
    let derived = derive_mnemonic(&mnemonic, passphrase, path)?;
    Ok((mnemonic.to_string(), derived))
}

/// BIP32 master fingerprint: the first four bytes of the master key's hash160.
pub fn seed_id(master: &ExtendedKey) -> String {
    let pubkey = secp::compress(&secp::mul_g(&master.key));
    hex_lower(&hashes::hash160(&pubkey)[..4])
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon \
                           abandon abandon abandon abandon abandon about";
    const ZOO: &str = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo \
                       zoo zoo zoo zoo zoo zoo zoo vote";

    fn hex(text: &str) -> Vec<u8> {
        assert!(text.len().is_multiple_of(2), "odd hex length: {text}");
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex byte"))
            .collect()
    }

    fn assert_key(master: &ExtendedKey, path: &str, key: &str, chain_code: &str) {
        let derived = derive_path(master, path).expect("path must derive");
        assert_eq!(derived.key.to_hex(), key, "key at {path}");
        assert_eq!(
            hex_lower(&derived.chain_code),
            chain_code,
            "chain code at {path}"
        );
    }

    #[test]
    fn hmac_sha512_rfc4231_case_1() {
        let digest = hmac_sha512(&[0x0b; 20], b"Hi There");
        assert_eq!(
            hex_lower(&digest),
            "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde\
             daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854"
        );
    }

    #[test]
    fn bip39_zero_entropy_phrase() {
        assert_eq!(
            phrase_from_entropy(&[0u8; 16]).expect("zero entropy is valid"),
            ABANDON
        );
    }

    #[test]
    fn bip39_max_entropy_phrase() {
        // The canonical "zoo ... vote" vector is 256 bits of 0xff.
        assert_eq!(
            phrase_from_entropy(&[0xffu8; 32]).expect("0xff entropy is valid"),
            ZOO
        );
        // 128 bits of 0xff is a different vector: "zoo ... wrong".
        assert_eq!(
            phrase_from_entropy(&[0xffu8; 16]).expect("0xff entropy is valid"),
            "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"
        );
    }

    #[test]
    fn bip39_seed_vectors() {
        let zero = Mnemonic::parse(ABANDON).expect("valid phrase");
        assert_eq!(
            hex_lower(&zero.to_seed("")),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1\
             9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );
        assert_eq!(
            hex_lower(&zero.to_seed("TREZOR")),
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553\
             1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
        );

        let max = Mnemonic::parse(ZOO).expect("valid phrase");
        assert_eq!(
            hex_lower(&max.to_seed("TREZOR")),
            "dd48c104698c30cfe2b6142103248622fb7bb0ff692eebb00089b32d22484e16\
             13912f0a5b694407be899ffd31ed3992c456cdf60f5d4564b8ba3f05a69890ad"
        );
    }

    #[test]
    fn bip32_test_vector_1() {
        let master =
            master_from_seed(&hex("000102030405060708090a0b0c0d0e0f")).expect("valid seed");
        assert_key(
            &master,
            "m",
            "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35",
            "873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508",
        );
        assert_key(
            &master,
            "m/0'",
            "edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea",
            "47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141",
        );
        assert_key(
            &master,
            "m/0'/1",
            "3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368",
            "2a7857631386ba23dacac34180dd1983734e444fdbf774041578e9b6adb37c19",
        );
        // Not in the published vector; pinned from an independent implementation.
        assert_key(
            &master,
            "m/0'/0",
            "47a62230342a7cd15e02c3e8cc9386befe55ac129893e457166d46f37442c606",
            "fcf758fccd01524fc311f15b3097fb8eea3c8bcc23289fb674d5f080de1a8b93",
        );
    }

    #[test]
    fn bip32_test_vector_2() {
        let master = master_from_seed(&hex(
            "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a2\
             9f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542",
        ))
        .expect("valid seed");
        assert_key(
            &master,
            "m",
            "4b03d6fc340455b363f51020ad3ecca4f0850280cf436c70c727923f6db46c3e",
            "60499f801b896d83179a4374aeb7822aaeaceaa0db1f85ee3e904c4defbd9689",
        );
        assert_key(
            &master,
            "m/0",
            "abe74a98f6c7eabee0428f53798f0ab8aa1bd37873999041703c742f15ac7e1e",
            "f0909affaa7ee7abe5dd4e100598d4dc53cd709d5a5c2cac40e7412f232f7c9c",
        );
        assert_key(
            &master,
            "m/0/2147483647'",
            "877c779ad9687164e9c2f4f0f4ff0340814392330693ce95a58fe18fd52e6e93",
            "be17a268474a6bb9c61e1d720cf6215e2a88c5406c4aee7b38547f585c9a37d9",
        );
    }

    #[test]
    fn address_fixture_for_abandon_phrase() {
        let derived = derive(ABANDON, "", DEFAULT_PATH).expect("derives");
        assert_eq!(
            derived.key.to_hex(),
            "e284129cc0922579a535bbf4d1a3b25773090d28c909bc0fed73b5e0222cc372"
        );
        assert_eq!(
            hex_lower(&derived.pubkey),
            "03aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e"
        );
        assert_eq!(derived.address, "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA");
    }

    #[test]
    fn path_parser_is_strict() {
        assert_eq!(parse_path("m").expect("master"), Vec::<u32>::new());
        assert_eq!(parse_path("m/0").expect("normal"), vec![0]);
        assert_eq!(parse_path("m/0'").expect("hardened"), vec![HARDENED]);
        assert_eq!(
            parse_path("m/44'/0'/0'/0/0").expect("BIP44"),
            vec![44 | HARDENED, HARDENED, HARDENED, 0, 0]
        );
        assert_eq!(
            parse_path("m/0h/1H").expect("h/H suffixes"),
            vec![HARDENED, 1 | HARDENED]
        );

        for bad in [
            "",
            "M",
            "0",
            "m/",
            "m//0",
            "m/ 0",
            "m/-1",
            "m/'",
            "m/0x10",
            "m/2147483648",
            "m/4294967296",
        ] {
            assert!(parse_path(bad).is_err(), "path should be rejected: {bad:?}");
        }
    }

    #[test]
    fn counter_entropy_is_big_endian_and_low() {
        let entropy = entropy_for_counter(0x0102, 128).expect("valid bits");
        assert_eq!(entropy.len(), 16);
        assert_eq!(hex_lower(&entropy), "00000000000000000000000000000102");
        assert!(entropy_for_counter(0, 129).is_err());
    }

    #[test]
    fn counter_entropy_lengths_follow_bits() {
        for (bits, len) in [(128, 16), (160, 20), (192, 24), (224, 28), (256, 32)] {
            let entropy = entropy_for_counter(1, bits).expect("valid bits");
            assert_eq!(entropy.len(), len, "{bits} bits");
            assert_eq!(entropy[len - 1], 1);
            assert!(entropy[..len - 1].iter().all(|byte| *byte == 0));
        }
    }

    #[test]
    fn counter_fixture_matches_independent_address() {
        let (phrase, derived) = derive_counter(3, 128, "", DEFAULT_PATH).expect("counter derives");
        assert_eq!(
            phrase,
            "abandon abandon abandon abandon abandon abandon \
                            abandon abandon abandon abandon abandon alpha"
        );
        assert_eq!(
            derived.key.to_hex(),
            "886793a2c73391f1527355898213ceae72f3a7cff29619219badfaf80ecc0785"
        );
        assert_eq!(derived.address, "1EfCaguhRK1DzLmvMF5nqSuAVLhv8hPxq8");
    }
}
