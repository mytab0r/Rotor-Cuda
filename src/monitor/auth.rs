//! SIWE-style wallet login for the address monitor.
//!
//! The message is built from the server challenge and verified with EIP-191
//! `personal_sign` semantics: `keccak256("\x19Ethereum Signed Message:\n" ++
//! len ++ message)`, then ECDSA public-key recovery with k256. The submitted
//! message must be byte-identical to the stored challenge message, so a
//! message signed for a different domain is rejected.

use tiny_http::Request;

use crate::hashes::keccak256;
use crate::monitor::store::MonitorStore;

/// Challenge lifetime in seconds.
pub const CHALLENGE_TTL_SECS: u64 = 600;

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

/// Verify the challenge, then consume it. A failed signature or a wrong
/// message must not burn the nonce, so consumption is the last step.
pub fn login(
    store: &MonitorStore,
    message: &str,
    signature: &str,
) -> Result<(crate::monitor::store::User, String), String> {
    let nonce = message_nonce(message).ok_or_else(|| "message has no nonce".to_string())?;
    let challenge = store
        .challenge(nonce)
        .ok_or_else(|| "unknown or already used nonce".to_string())?;
    if challenge.message != message {
        return Err("message does not match the challenge".to_string());
    }
    if crate::coordinator::state::now_secs() > challenge.expires_at {
        return Err("challenge expired".to_string());
    }
    let recovered = recover_address(message, signature)?;
    if recovered != challenge.address {
        return Err("signature does not match the challenge address".to_string());
    }
    let consumed = store
        .consume_challenge(nonce)?
        .ok_or_else(|| "unknown or already used nonce".to_string())?;
    if consumed.message != message {
        return Err("message does not match the challenge".to_string());
    }
    let user = store.upsert_user(&recovered)?;
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
            .put_challenge(&nonce, &address, &message, now + CHALLENGE_TTL_SECS)
            .expect("store challenge");
        let signature = sign_message(&key, &message);

        let (user, token) = login(&temp.store, &message, &signature).expect("login");
        assert_eq!(user.address, address);
        assert_eq!(
            temp.store.resolve_session(&token).as_deref(),
            Some(user.id.as_str())
        );

        // Replay is rejected because the challenge is gone.
        assert!(login(&temp.store, &message, &signature).is_err());
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
            .put_challenge(&nonce, &address, &message, now + CHALLENGE_TTL_SECS)
            .expect("store challenge");
        let signature = sign_message(&key, &message);

        // A wrong signature must not consume the challenge.
        let mutated = mutated_signature(&signature);
        assert!(login(&temp.store, &message, &mutated).is_err());
        assert!(login(&temp.store, &message, &signature).is_ok());
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
            .put_challenge(&nonce, &address, &message, now + CHALLENGE_TTL_SECS)
            .expect("store challenge");
        let signature = sign_message(&key, &message);

        let evil = message.replace("127.0.0.1 wants", "evil.example wants");
        assert!(login(&temp.store, &evil, &signature).is_err());

        let mutated = mutated_signature(&signature);
        assert!(login(&temp.store, &message, &mutated).is_err());
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
