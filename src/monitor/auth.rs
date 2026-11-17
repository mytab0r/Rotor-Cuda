//! Multi-chain wallet login for the address monitor.
//!
//! The message is built from the server challenge and bound to the chain by
//! the stored challenge record. Verification is chain-specific:
//!
//! * EVM: EIP-191 `personal_sign` with k256 recovery.
//! * Solana: ed25519 over the exact UTF-8 message bytes (`verify_strict`).
//! * TRON: `signMessageV2` prehash and k256 recovery.
//!
//! The submitted message must be byte-identical to the stored challenge
//! message, so a message signed for a different domain is rejected.

use tiny_http::Request;

use crate::hashes::keccak256;
use crate::monitor::store::{self, MonitorStore};

/// Challenge lifetime in seconds.
pub const CHALLENGE_TTL_SECS: u64 = 600;

/// Chains that can be used to log in. BTC is watch-only.
pub fn login_chain(chain: &str) -> Result<&'static str, String> {
    match store::canonical_chain(chain)? {
        "evm" => Ok("evm"),
        "solana" => Ok("solana"),
        "tron" => Ok("tron"),
        other => Err(format!(
            "unsupported login chain: {other}; login supports evm, solana and tron"
        )),
    }
}

/// The SIWE message exactly as the user's wallet displays it.
pub fn challenge_message(
    domain: &str,
    origin: &str,
    address: &str,
    nonce: &str,
    issued_at: u64,
    expires_at: u64,
) -> String {
    format!(
        "{domain} wants you to sign in with your Ethereum account:\n\
         {address}\n\n\
         Rotor monitor login\n\n\
         URI: {origin}\n\
         Version: 1\n\
         Chain ID: 1\n\
         Nonce: {nonce}\n\
         Issued At: {}\n\
         Expiration Time: {}",
        iso8601(issued_at),
        iso8601(expires_at)
    )
}

/// Validate and normalize the server-configured SIWE domain.
///
/// The domain is fixed at startup (`--monitor-domain`); it is never taken from
/// the request. SIWE's anti-phishing property depends on that.
pub fn normalize_domain(domain: &str) -> Result<String, String> {
    let domain = domain.trim().to_ascii_lowercase();
    let valid = !domain.is_empty()
        && domain.len() <= 255
        && domain.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']' | b'_')
        });
    if valid {
        Ok(domain)
    } else {
        Err("monitor domain must be a host[:port] without scheme or path".to_string())
    }
}

/// Split the configured domain into `(domain, origin)`.
pub fn domain_and_origin(host: &str) -> (String, String) {
    let domain = if host.starts_with('[') {
        host.find(']')
            .map_or_else(|| host.to_string(), |end| host[..=end].to_string())
    } else {
        host.split(':').next().unwrap_or(host).to_string()
    };
    (domain, format!("http://{host}"))
}

/// The nonce line of a challenge message.
pub fn message_nonce(message: &str) -> Option<&str> {
    message
        .lines()
        .find_map(|line| line.strip_prefix("Nonce: "))
        .map(str::trim)
        .filter(|nonce| !nonce.is_empty())
}

/// EIP-191 hash of `message`.
pub fn personal_sign_hash(message: &str) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut data = Vec::with_capacity(prefix.len() + message.len());
    data.extend_from_slice(prefix.as_bytes());
    data.extend_from_slice(message.as_bytes());
    keccak256(&data)
}

/// Recover the signer address from a 65-byte `r || s || v` signature.
pub fn recover_address(message: &str, signature: &str) -> Result<String, String> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    let bytes = decode_hex(signature)?;
    if bytes.len() != 65 {
        return Err("signature must be 65 bytes (r || s || v)".to_string());
    }
    let signature =
        Signature::from_slice(&bytes[..64]).map_err(|err| format!("invalid signature: {err}"))?;
    let v = bytes[64];
    let recovery = match v {
        0 | 1 => v,
        27 | 28 => v - 27,
        other => return Err(format!("unsupported signature recovery byte: {other}")),
    };
    let recovery_id =
        RecoveryId::from_byte(recovery).ok_or_else(|| "invalid recovery id".to_string())?;
    let prehash = personal_sign_hash(message);
    let verifying_key = VerifyingKey::recover_from_prehash(&prehash, &signature, recovery_id)
        .map_err(|err| format!("cannot recover public key: {err}"))?;
    Ok(address_from_verifying_key(&verifying_key))
}

/// Ethereum address of a recovered verifying key.
fn address_from_verifying_key(key: &k256::ecdsa::VerifyingKey) -> String {
    let point = key.to_encoded_point(false);
    let bytes = point.as_bytes();
    let hash = keccak256(&bytes[1..]);
    let mut address = String::with_capacity(42);
    address.push_str("0x");
    for byte in &hash[12..] {
        address.push_str(&format!("{byte:02x}"));
    }
    address
}

/// TRON `signMessageV2` prehash: `keccak256("\x19TRON Signed Message:\n" ++
/// decimal byte-length ++ message)`.
pub fn tron_message_hash(message: &str) -> [u8; 32] {
    let prefix = format!("\x19TRON Signed Message:\n{}", message.len());
    let mut data = Vec::with_capacity(prefix.len() + message.len());
    data.extend_from_slice(prefix.as_bytes());
    data.extend_from_slice(message.as_bytes());
    keccak256(&data)
}

/// Verify a Solana login: the claimed address is the Base58 ed25519 public
/// key and the 64-byte signature is hex or Base64 over the message bytes.
pub fn verify_solana(message: &str, address: &str, signature: &str) -> Result<String, String> {
    let canonical = store::canonicalize_solana(address)?;
    let public: [u8; 32] = bs58::decode(&canonical)
        .into_vec()
        .map_err(|err| format!("invalid Solana address: {err}"))?
        .try_into()
        .map_err(|_| "Solana address must be 32 bytes".to_string())?;
    let signature = decode_solana_signature(signature)?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&public)
        .map_err(|err| format!("invalid Solana public key: {err}"))?;
    key.verify_strict(
        message.as_bytes(),
        &ed25519_dalek::Signature::from_bytes(&signature),
    )
    .map_err(|err| format!("invalid Solana signature: {err}"))?;
    Ok(canonical)
}

/// Verify a TRON `signMessageV2` signature and derive the signer address.
pub fn verify_tron(message: &str, address: &str, signature: &str) -> Result<String, String> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    let bytes = decode_hex(signature)?;
    if bytes.len() != 65 {
        return Err("signature must be 65 bytes (r || s || v)".to_string());
    }
    let signature =
        Signature::from_slice(&bytes[..64]).map_err(|err| format!("invalid signature: {err}"))?;
    let recovery = match bytes[64] {
        0 | 1 => bytes[64],
        27 | 28 => bytes[64] - 27,
        other => return Err(format!("unsupported signature recovery byte: {other}")),
    };
    let recovery_id =
        RecoveryId::from_byte(recovery).ok_or_else(|| "invalid recovery id".to_string())?;
    let prehash = tron_message_hash(message);
    let verifying_key = VerifyingKey::recover_from_prehash(&prehash, &signature, recovery_id)
        .map_err(|err| format!("cannot recover public key: {err}"))?;
    let point = verifying_key.to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]);
    let mut payload = [0u8; 21];
    payload[0] = 0x41;
    payload[1..].copy_from_slice(&hash[12..]);
    let derived = crate::base58::encode_check(&payload);
    let claimed = store::canonicalize_tron(address)?;
    if derived != claimed {
        return Err("signature does not match the challenge address".to_string());
    }
    Ok(claimed)
}

fn decode_solana_signature(text: &str) -> Result<[u8; 64], String> {
    let trimmed = text.trim();
    let hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    let bytes = if hex.len() == 128 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        decode_hex(hex)?
    } else {
        decode_base64(trimmed)?
    };
    bytes
        .try_into()
        .map_err(|_| "Solana signature must be 64 bytes".to_string())
}

/// Standard Base64 decoder (wallets return Base64, not hex).
fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    let mut padding = 0usize;
    for byte in text.bytes() {
        if byte == b'=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            return Err("invalid base64 padding".to_string());
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return Err("invalid base64 character".to_string()),
        } as u32;
        accumulator = ((accumulator << 6) | value) & 0x00ff_ffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    if padding > 2 || bits >= 6 || (accumulator & ((1 << bits) - 1)) != 0 {
        return Err("invalid base64 length".to_string());
    }
    Ok(out)
}

fn verify_identity(
    chain: &str,
    message: &str,
    signature: &str,
    address: &str,
) -> Result<String, String> {
    match chain {
        "evm" => {
            let claimed = store::canonicalize_evm(address)?;
            let recovered = recover_address(message, signature)?;
            if recovered != claimed {
                return Err("signature does not match the challenge address".to_string());
            }
            Ok(recovered)
        }
        "solana" => verify_solana(message, address, signature),
        "tron" => verify_tron(message, address, signature),
        other => Err(format!("unsupported login chain: {other}")),
    }
}

/// Verify the challenge, then consume it. A failed signature or a wrong
/// message must not burn the nonce, so consumption is the last step.
///
/// `session_user` is the account resolved from an optional bearer token; when
/// present the verified identity is attached to that account instead of
/// resolving or creating another one.
pub fn login(
    store: &MonitorStore,
    chain: &str,
    message: &str,
    signature: &str,
    session_user: Option<&str>,
) -> Result<(crate::monitor::store::User, String), String> {
    let chain = login_chain(chain)?;
    let nonce = message_nonce(message).ok_or_else(|| "message has no nonce".to_string())?;
    let challenge = store
        .challenge(nonce)
        .ok_or_else(|| "unknown or already used nonce".to_string())?;
    if challenge.message != message {
        return Err("message does not match the challenge".to_string());
    }
    if challenge.chain != chain {
        return Err("challenge chain does not match the request chain".to_string());
    }
    if crate::coordinator::state::now_secs() > challenge.expires_at {
        return Err("challenge expired".to_string());
    }
    let verified = verify_identity(chain, message, signature, &challenge.address)?;
    // Verification succeeded: the challenge becomes single-use.
    let consumed = store
        .consume_challenge(nonce)?
        .ok_or_else(|| "unknown or already used nonce".to_string())?;
    if consumed.message != message || consumed.chain != chain {
        return Err("message does not match the challenge".to_string());
    }
    let user = match session_user {
        Some(user_id) => match store.find_user_by_identity(chain, &verified) {
            Some(owner) if owner.id != user_id => {
                return Err("address is already linked to another account".to_string());
            }
            _ => store
                .add_identity(user_id, chain, &verified, true)?
                .ok_or_else(|| "unknown session".to_string())?,
        },
        None => match store.find_user_by_identity(chain, &verified) {
            Some(user) => user,
            None => store.upsert_identity(chain, &verified)?,
        },
    };
    let token = store.create_session(&user.id)?;
    Ok((user, token))
}

/// The bearer token presented on a request, if any.
pub fn bearer_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
}

/// Resolve the monitor session token from a request's `Authorization` header.
pub fn session_user(store: &MonitorStore, request: &Request) -> Option<String> {
    let token = bearer_token(request)?;
    store.resolve_session(token)
}

fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    let trimmed = text.trim();
    let hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    if !hex.len().is_multiple_of(2) {
        return Err("hex string has an odd length".to_string());
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    for pair in bytes.as_chunks::<2>().0 {
        let high = hex_digit(pair[0]).ok_or_else(|| "invalid hex digit".to_string())?;
        let low = hex_digit(pair[1]).ok_or_else(|| "invalid hex digit".to_string())?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ` without a date-time dependency.
pub fn iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const KEY: [u8; 32] = [0x11; 32];

    fn signing_key() -> SigningKey {
        SigningKey::from_slice(&KEY).expect("valid key")
    }

    fn address_of(key: &SigningKey) -> String {
        address_from_verifying_key(key.verifying_key())
    }

    fn sign_message(key: &SigningKey, message: &str) -> String {
        let prehash = personal_sign_hash(message);
        let (signature, recovery) = key.sign_prehash_recoverable(&prehash).expect("sign");
        let mut bytes = signature.to_bytes().to_vec();
        bytes.push(recovery.to_byte());
        let mut out = String::with_capacity(2 + bytes.len() * 2);
        out.push_str("0x");
        for byte in bytes {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    fn mutated_signature(signature: &str) -> String {
        let mut chars: Vec<char> = signature.chars().collect();
        // Flip one hex nibble of `r`; the signature can no longer verify.
        chars[10] = if chars[10] == '0' { '1' } else { '0' };
        chars.into_iter().collect()
    }

    struct TempStore {
        path: PathBuf,
        store: MonitorStore,
    }

    impl TempStore {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "rotor-monitor-auth-{}-{nanos}-{tag}.json",
                std::process::id()
            ));
            let store = MonitorStore::open(&path).expect("open store");
            Self { path, store }
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_file(format!("{}.tmp", self.path.display()));
        }
    }

    #[test]
    fn solana_signature_verifies_over_the_exact_message() {
        use ed25519_dalek::Signer;

        let key = ed25519_dalek::SigningKey::from_bytes(&[0x33; 32]);
        let address = bs58::encode(key.verifying_key().to_bytes()).into_string();
        let message = challenge_message(
            "localhost",
            "http://localhost:7887",
            &address,
            "aabbccdd",
            1_700_000_000,
            1_700_000_600,
        );
        let signature = key.sign(message.as_bytes());
        let hex_signature = format!(
            "0x{}",
            signature
                .to_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert_eq!(
            verify_solana(&message, &address, &hex_signature).unwrap(),
            address
        );
        // A different message does not verify against the same signature.
        assert!(verify_solana(&format!("{message} "), &address, &hex_signature).is_err());
        assert!(verify_solana(&message, &address, "deadbeef").is_err());
    }

    #[test]
    fn tron_sign_message_v2_recovers_the_signer() {
        let key = signing_key();
        let point = key.verifying_key().to_encoded_point(false);
        let hash = keccak256(&point.as_bytes()[1..]);
        let mut payload = [0u8; 21];
        payload[0] = 0x41;
        payload[1..].copy_from_slice(&hash[12..]);
        let address = crate::base58::encode_check(&payload);
        let message = challenge_message(
            "localhost",
            "http://localhost:7887",
            &address,
            "aabbccdd",
            1_700_000_000,
            1_700_000_600,
        );
        let (signature, recovery) = key
            .sign_prehash_recoverable(&tron_message_hash(&message))
            .expect("sign");
        let mut bytes = signature.to_bytes().to_vec();
        bytes.push(recovery.to_byte() + 27);
        let hex_signature = format!(
            "0x{}",
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert_eq!(
            verify_tron(&message, &address, &hex_signature).unwrap(),
            address
        );
        assert!(verify_tron(&format!("{message} "), &address, &hex_signature).is_err());
    }

    #[test]
    fn recovery_matches_the_signing_key() {
        let key = signing_key();
        let address = address_of(&key);
        let message = challenge_message(
            "localhost",
            "http://localhost:7887",
            &address,
            "aabbccdd",
            1_700_000_000,
            1_700_000_600,
        );
        let signature = sign_message(&key, &message);
        assert_eq!(recover_address(&message, &signature).unwrap(), address);

        // A different message recovers a different (or no) address.
        let other = message.replace("localhost", "evil.example");
        let recovered = recover_address(&other, &signature);
        assert!(recovered.is_err() || recovered.unwrap() != address);
    }

    #[test]
    fn login_flow_and_nonce_single_use() {
        let temp = TempStore::new("login");
        let key = signing_key();
        let address = address_of(&key);
        let now = crate::coordinator::state::now_secs();
        let nonce = temp.store.new_nonce().expect("nonce");
        let message = challenge_message(
            "127.0.0.1",
            "http://127.0.0.1:7887",
            &address,
            &nonce,
            now,
            now + CHALLENGE_TTL_SECS,
        );
        temp.store
            .put_challenge(&nonce, "evm", &address, &message, now + CHALLENGE_TTL_SECS)
            .expect("store challenge");
        let signature = sign_message(&key, &message);

        let (user, token) = login(&temp.store, "evm", &message, &signature, None).expect("login");
        assert_eq!(user.address, address);
        assert_eq!(
            temp.store.resolve_session(&token).as_deref(),
            Some(user.id.as_str())
        );

        // Replay is rejected because the challenge is gone.
        assert!(login(&temp.store, "evm", &message, &signature, None).is_err());
    }

    #[test]
    fn failed_signature_does_not_burn_the_nonce() {
        let temp = TempStore::new("nonce-burn");
        let key = signing_key();
        let address = address_of(&key);
        let now = crate::coordinator::state::now_secs();
        let nonce = temp.store.new_nonce().expect("nonce");
        let message = challenge_message(
            "127.0.0.1",
            "http://127.0.0.1:7887",
            &address,
            &nonce,
            now,
            now + CHALLENGE_TTL_SECS,
        );
        temp.store
            .put_challenge(&nonce, "evm", &address, &message, now + CHALLENGE_TTL_SECS)
            .expect("store challenge");
        let signature = sign_message(&key, &message);

        // A wrong signature must not consume the challenge.
        let mutated = mutated_signature(&signature);
        assert!(login(&temp.store, "evm", &message, &mutated, None).is_err());
        assert!(login(&temp.store, "evm", &message, &signature, None).is_ok());
    }

    #[test]
    fn wrong_domain_and_mutated_signature_are_rejected() {
        let temp = TempStore::new("wrong-domain");
        let key = signing_key();
        let address = address_of(&key);
        let now = crate::coordinator::state::now_secs();
        let nonce = temp.store.new_nonce().expect("nonce");
        let message = challenge_message(
            "127.0.0.1",
            "http://127.0.0.1:7887",
            &address,
            &nonce,
            now,
            now + CHALLENGE_TTL_SECS,
        );
        temp.store
            .put_challenge(&nonce, "evm", &address, &message, now + CHALLENGE_TTL_SECS)
            .expect("store challenge");
        let signature = sign_message(&key, &message);

        let evil = message.replace("127.0.0.1 wants", "evil.example wants");
        assert!(login(&temp.store, "evm", &evil, &signature, None).is_err());

        let mutated = mutated_signature(&signature);
        assert!(login(&temp.store, "evm", &message, &mutated, None).is_err());
    }

    #[test]
    fn configured_domain_is_normalized() {
        assert_eq!(normalize_domain(" Example.COM ").unwrap(), "example.com");
        assert_eq!(
            normalize_domain("127.0.0.1:7887").unwrap(),
            "127.0.0.1:7887"
        );
        assert!(normalize_domain("https://example.com").is_err());
        assert!(normalize_domain("evil\r\nHost: x").is_err());
        assert!(normalize_domain("").is_err());
        let (domain, origin) = domain_and_origin("example.com:7887");
        assert_eq!(domain, "example.com");
        assert_eq!(origin, "http://example.com:7887");
        let (domain, origin) = domain_and_origin("[::1]:7887");
        assert_eq!(domain, "[::1]");
        assert_eq!(origin, "http://[::1]:7887");
    }

    #[test]
    fn iso8601_is_correct() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
    }
}
