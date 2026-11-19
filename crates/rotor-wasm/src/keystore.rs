//! Local Ethereum V3 (UTC/JSON) keystore decryption.
//!
//! Supported: `scrypt` and `pbkdf2` (HMAC-SHA256) KDFs with a 32-byte derived
//! key and AES-128-CTR ciphertext, which is what the format standardised. The
//! password is supplied as bytes by the caller and never leaves the module;
//! the result is the 32-byte private key, or an error that explains the first
//! failed check.
//!
//! MAC: `keccak256(derived_key[16..32] || ciphertext)[..16]` (constant-time
//! comparison). Wrong password and wrong MAC are the same error on purpose.

use aes::cipher::{KeyIvInit, StreamCipher};
use sha2_010::Sha256;

use crate::hashes;

type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;

/// Upper bound on the scrypt working set, in bytes. A 256 MiB set covers the
/// common `n=262144, r=8` keystores while keeping a hostile file from asking
/// the browser to allocate gigabytes.
const MAX_SCRYPT_BYTES: u64 = 512 * 1024 * 1024;

/// The fields read from a V3 keystore plus the password.
pub struct Request<'a> {
    /// 0 = scrypt, 1 = PBKDF2-HMAC-SHA256.
    pub kdf: u32,
    /// scrypt CPU/memory cost (must be a power of two).
    pub n: u32,
    /// scrypt block size.
    pub r: u32,
    /// scrypt parallelisation.
    pub p: u32,
    /// PBKDF2 iteration count.
    pub c: u32,
    /// Derived-key length; only 32 is accepted.
    pub dklen: u32,
    pub salt: &'a [u8],
    pub iv: &'a [u8],
    pub ciphertext: &'a [u8],
    pub mac: &'a [u8],
    pub password: &'a [u8],
}

/// Decrypt a V3 keystore and return its 32-byte private key.
pub fn decrypt(request: &Request<'_>) -> Result<[u8; 32], String> {
    if request.dklen != 32 {
        return Err(format!(
            "Unsupported keystore: dklen is {}, only 32 is supported.",
            request.dklen
        ));
    }
    if request.salt.is_empty() {
        return Err("Invalid keystore: the KDF salt is empty.".to_owned());
    }
    if request.iv.len() != 16 {
        return Err(format!(
            "Invalid keystore: AES-128-CTR needs a 16-byte IV, got {}.",
            request.iv.len()
        ));
    }
    if request.ciphertext.len() != 32 {
        return Err(format!(
            "Unsupported keystore: ciphertext is {} bytes, a private key is 32.",
            request.ciphertext.len()
        ));
    }
    if request.mac.len() != 16 {
        return Err(format!(
            "Invalid keystore: the MAC is {} bytes, expected 16.",
            request.mac.len()
        ));
    }

    let mut derived = [0u8; 32];
    match request.kdf {
        0 => derive_scrypt(request, &mut derived)?,
        1 => derive_pbkdf2(request, &mut derived)?,
        other => return Err(format!("Unsupported keystore KDF id: {other}")),
    }

    let mut mac_input = Vec::with_capacity(48);
    mac_input.extend_from_slice(&derived[16..]);
    mac_input.extend_from_slice(request.ciphertext);
    let expected = hashes::keccak256(&mac_input);
    if !constant_time_eq(&expected[..16], request.mac) {
        return Err("Wrong password, or the keystore is corrupt: the MAC check failed.".to_owned());
    }

    let mut key = [0u8; 32];
    key.copy_from_slice(request.ciphertext);
    let mut cipher = Aes128Ctr::new(derived[..16].into(), request.iv.into());
    cipher.apply_keystream(&mut key);
    derived.fill(0);
    Ok(key)
}

fn derive_scrypt(request: &Request<'_>, out: &mut [u8; 32]) -> Result<(), String> {
    if request.n < 2 || !request.n.is_power_of_two() {
        return Err(format!(
            "Invalid keystore: scrypt n must be a power of two >= 2, got {}.",
            request.n
        ));
    }
    if request.r == 0 || request.p == 0 {
        return Err("Invalid keystore: scrypt r and p must be >= 1.".to_owned());
    }
    let log_n = request.n.trailing_zeros();
    if log_n >= 32 {
        return Err("Invalid keystore: scrypt n is too large.".to_owned());
    }
    let working_set = 128u64 * u64::from(request.n) * u64::from(request.r);
    if working_set > MAX_SCRYPT_BYTES {
        return Err(format!(
            "This keystore asks for {working_set} bytes of scrypt memory; the page limit is {MAX_SCRYPT_BYTES}."
        ));
    }
    let params = scrypt::Params::new(log_n as u8, request.r, request.p, out.len())
        .map_err(|err| format!("Invalid scrypt parameters: {err}"))?;
    scrypt::scrypt(request.password, request.salt, &params, out)
        .map_err(|err| format!("scrypt failed: {err}"))
}

fn derive_pbkdf2(request: &Request<'_>, out: &mut [u8; 32]) -> Result<(), String> {
    if request.c == 0 {
        return Err("Invalid keystore: pbkdf2 iteration count must be >= 1.".to_owned());
    }
    pbkdf2::pbkdf2_hmac::<Sha256>(request.password, request.salt, request.c, out);
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (&a, &b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect()
    }

    const PRIVATE_KEY: &str = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

    #[test]
    fn scrypt_fixture_decrypts() {
        let salt = bytes("dc4503dd74699a901de4d508c404856188e305edba9c4883eb076ff63d052e5f");
        let iv = bytes("298f88b92ccc0d3a00d9c9740083aaf3");
        let ciphertext = bytes("d0529445d0ea0ac164cd2e33b8f2fbb290d512a525124035cacf7de3e10b709e");
        let mac = bytes("3a5cc2cde46413afd05a8cc3b2bb836c");
        let key = decrypt(&Request {
            kdf: 0,
            n: 1024,
            r: 8,
            p: 1,
            c: 0,
            dklen: 32,
            salt: &salt,
            iv: &iv,
            ciphertext: &ciphertext,
            mac: &mac,
            password: b"testpassword",
        })
        .expect("scrypt fixture decrypts");
        assert_eq!(crate::derive::hex(&key), PRIVATE_KEY);
    }

    #[test]
    fn pbkdf2_fixture_decrypts() {
        let salt = bytes("f8bb8267db01439b94e5cb7f32b9c745adb219c65531c0e59e9a5d326ca423f8");
        let iv = bytes("aa1a4975ed2552d141c2b0efb697227e");
        let ciphertext = bytes("f4cff4877250f18f9f538d9c466e49dbc0eab4a46f86fc10075296e60ffa4f5f");
        let mac = bytes("e52c429438f1fcfe33d429825550bd69");
        let key = decrypt(&Request {
            kdf: 1,
            n: 0,
            r: 0,
            p: 0,
            c: 1024,
            dklen: 32,
            salt: &salt,
            iv: &iv,
            ciphertext: &ciphertext,
            mac: &mac,
            password: b"testpassword",
        })
        .expect("pbkdf2 fixture decrypts");
        assert_eq!(crate::derive::hex(&key), PRIVATE_KEY);
    }

    #[test]
    fn wrong_password_fails_the_mac() {
        let salt = bytes("f8bb8267db01439b94e5cb7f32b9c745adb219c65531c0e59e9a5d326ca423f8");
        let iv = bytes("aa1a4975ed2552d141c2b0efb697227e");
        let ciphertext = bytes("f4cff4877250f18f9f538d9c466e49dbc0eab4a46f86fc10075296e60ffa4f5f");
        let mac = bytes("e52c429438f1fcfe33d429825550bd69");
        let error = decrypt(&Request {
            kdf: 1,
            n: 0,
            r: 0,
            p: 0,
            c: 1024,
            dklen: 32,
            salt: &salt,
            iv: &iv,
            ciphertext: &ciphertext,
            mac: &mac,
            password: b"not-the-password",
        })
        .expect_err("wrong password is rejected");
        assert!(error.contains("MAC"));
    }

    #[test]
    fn rejects_bad_parameters() {
        let empty = Request {
            kdf: 0,
            n: 1024,
            r: 8,
            p: 1,
            c: 0,
            dklen: 32,
            salt: &[],
            // Dummy bytes for the invalid-parameter path; this request never
            // reaches the cipher, so the value is not used as an IV.
            // codeql[rust/hard-coded-cryptographic-value]
            iv: &[0u8; 16],
            ciphertext: &[0u8; 32],
            mac: &[0u8; 16],
            password: b"x",
        };
        assert!(decrypt(&empty).unwrap_err().contains("salt"));

        let bad_n = Request {
            salt: b"s",
            n: 1000,
            ..empty
        };
        assert!(decrypt(&bad_n).unwrap_err().contains("power of two"));

        let huge = Request {
            salt: b"s",
            n: 1 << 20,
            r: 8,
            ..empty
        };
        assert!(decrypt(&huge).unwrap_err().contains("limit"));

        let bad_kdf = Request {
            salt: b"s",
            n: 1024,
            kdf: 7,
            ..empty
        };
        assert!(decrypt(&bad_kdf).unwrap_err().contains("KDF"));
    }
}
