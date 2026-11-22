//! Operator cabinet session: cookie minting/validation, CSRF and login limits.
//!
//! There is no server-side session registry. The cookie is a signed statement
//! `v1.<exp>.<nonce>.<mac>` where
//!
//! ```text
//! K   = SHA-256("rotor-admin-cookie-v1\0" || admin_token)
//! mac = HMAC-SHA256(K, "v1.<exp>.<nonce>")          (hex)
//! ```
//!
//! Rotating `ROTOR_COORD_TOKEN` changes `K` and invalidates every cookie.
//! The CSRF token is `HMAC-SHA256(K, "csrf.<nonce>")[0..16]` (hex); the browser
//! double-submits it in `X-CSRF-Token`, and logout also compares it to the
//! non-HttpOnly cookie value.
//!
//! Failures are compared in constant time through the shared
//! [`crate::coordinator::constant_time_eq`]. The login limiter lives here so
//! the coordinator owns the only admin attempt counter.

use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::constant_time_eq;

/// Session cookie name.
pub const SESSION_COOKIE: &str = "rotor_admin";
/// CSRF cookie name (readable by `admin.js`, so never a secret by itself).
pub const CSRF_COOKIE: &str = "rotor_admin_csrf";
/// Every admin cookie is scoped to the cabinet, never to the whole site.
pub const COOKIE_PATH: &str = "/cabinet/admin";
/// 12 hours, matching `Max-Age` and the signed `exp` claim.
pub const TTL_SECS: u64 = 12 * 60 * 60;

const VERSION: &str = "v1";
const KEY_CONTEXT: &[u8] = b"rotor-admin-cookie-v1\0";
const NONCE_BYTES: usize = 16;
const CSRF_BYTES: usize = 16;

/// Derived cookie key plus the transport flag for `Secure`.
pub struct AdminAuth {
    key: [u8; 32],
    secure: bool,
}

/// A freshly minted cookie pair.
pub struct Session {
    pub cookie: String,
    pub csrf_token: String,
    pub expires_at: u64,
}

/// The verified part of an incoming cookie.
pub struct ValidSession {
    pub nonce: String,
}

impl AdminAuth {
    /// Derive the key from the coordinator token. `Secure` is dropped only when
    /// the canonical public origin is plain `http://` (local CI harness).
    pub fn new(admin_token: &str, public_url: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(KEY_CONTEXT);
        hasher.update(admin_token.as_bytes());
        let key: [u8; 32] = hasher.finalize().into();
        Self {
            key,
            secure: !public_url.starts_with("http://"),
        }
    }

    /// Mint a session from 16 bytes of OS randomness.
    pub fn mint(&self) -> Result<Session, String> {
        let mut nonce_bytes = [0u8; NONCE_BYTES];
        getrandom::getrandom(&mut nonce_bytes)
            .map_err(|err| format!("cannot read the OS random source: {err}"))?;
        let nonce = hex(&nonce_bytes);
        let expires_at = now_secs().saturating_add(TTL_SECS);
        let payload = format!("{VERSION}.{expires_at}.{nonce}");
        let mac = hex(&hmac_sha256(&self.key, payload.as_bytes()));
        Ok(Session {
            cookie: format!("{payload}.{mac}"),
            csrf_token: self.csrf_for(&nonce),
            expires_at,
        })
    }

    /// Validate `v1.<exp>.<nonce>.<mac>`. A wrong length, nonce alphabet,
    /// expiry or MAC all yield `None`.
    pub fn validate(&self, value: &str) -> Option<ValidSession> {
        let mut parts = value.split('.');
        let version = parts.next()?;
        let exp = parts.next()?;
        let nonce = parts.next()?;
        let mac = parts.next()?;
        if parts.next().is_some() || version != VERSION {
            return None;
        }
        if nonce.len() != NONCE_BYTES * 2 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        if mac.len() != 64 || !mac.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let expires_at = exp.parse::<u64>().ok()?;
        // Reject expired cookies and cookies that outlive the documented TTL
        // (plus a 60 s clock-skew allowance). A valid MAC is not enough: the
        // 12 h lifetime is part of the contract, not just a Set-Cookie hint.
        let now = now_secs();
        if expires_at <= now || expires_at > now.saturating_add(TTL_SECS + 60) {
            return None;
        }
        let payload = format!("{VERSION}.{expires_at}.{nonce}");
        let expected = hmac_sha256(&self.key, payload.as_bytes());
        if !constant_time_eq(&decode_hex(mac)?, &expected) {
            return None;
        }
        Some(ValidSession {
            nonce: nonce.to_string(),
        })
    }

    /// CSRF token bound to a session nonce.
    pub fn csrf_for(&self, nonce: &str) -> String {
        let mac = hmac_sha256(&self.key, format!("csrf.{nonce}").as_bytes());
        hex(&mac[..CSRF_BYTES])
    }

    /// Constant-time CSRF comparison.
    pub fn verify_csrf(&self, nonce: &str, provided: &str) -> bool {
        provided.len() == CSRF_BYTES * 2
            && constant_time_eq(self.csrf_for(nonce).as_bytes(), provided.as_bytes())
    }

    /// `Set-Cookie` for the HttpOnly session.
    pub fn session_cookie(&self, value: &str) -> String {
        let mut cookie = format!(
            "{SESSION_COOKIE}={value}; HttpOnly; SameSite=Strict; Path={COOKIE_PATH}; Max-Age={TTL_SECS}"
        );
        if self.secure {
            cookie.push_str("; Secure");
        }
        cookie
    }

    /// `Set-Cookie` for the CSRF half of the double submit.
    pub fn csrf_cookie(&self, value: &str) -> String {
        let mut cookie = format!(
            "{CSRF_COOKIE}={value}; SameSite=Strict; Path={COOKIE_PATH}; Max-Age={TTL_SECS}"
        );
        if self.secure {
            cookie.push_str("; Secure");
        }
        cookie
    }

    /// Expire the session cookie.
    pub fn clear_session_cookie(&self) -> String {
        let mut cookie =
            format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path={COOKIE_PATH}; Max-Age=0");
        if self.secure {
            cookie.push_str("; Secure");
        }
        cookie
    }

    /// Expire the CSRF cookie.
    pub fn clear_csrf_cookie(&self) -> String {
        let mut cookie = format!("{CSRF_COOKIE}=; SameSite=Strict; Path={COOKIE_PATH}; Max-Age=0");
        if self.secure {
            cookie.push_str("; Secure");
        }
        cookie
    }
}

/// Read one cookie from a `Cookie:` header (`name=value; name2=value2`).
pub fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|pair| {
        let (candidate, value) = pair.trim().split_once('=')?;
        (candidate == name).then_some(value)
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// HMAC-SHA256 (RFC 2104) over `sha2::Sha256`, 64-byte block size.
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;

    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
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

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(data);
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner);
    outer.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn decode_hex(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (chunk, slot) in text
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .zip(out.iter_mut())
    {
        let high = hex_digit(chunk[0])?;
        let low = hex_digit(chunk[1])?;
        *slot = (high << 4) | low;
    }
    Some(out)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_expiry() {
        let auth = AdminAuth::new("token", "https://example.test");
        let session = auth.mint().expect("mint");
        let valid = auth.validate(&session.cookie).expect("valid");
        assert!(session.cookie.starts_with("v1."));
        assert_eq!(session.csrf_token.len(), CSRF_BYTES * 2);
        assert!(auth.verify_csrf(&valid.nonce, &session.csrf_token));
        assert!(!auth.verify_csrf(&valid.nonce, "0"));
        let exp: u64 = session.cookie.split('.').nth(1).unwrap().parse().unwrap();
        assert_eq!(exp, session.expires_at);
        // A different admin token derives a different key.
        let rotated = AdminAuth::new("other", "https://example.test");
        assert!(rotated.validate(&session.cookie).is_none());
    }

    #[test]
    fn tampered_mac_is_rejected() {
        let auth = AdminAuth::new("token", "https://example.test");
        let session = auth.mint().expect("mint");
        let mut tampered = session.cookie.clone();
        tampered.pop();
        tampered.push(if tampered.ends_with('0') { '1' } else { '0' });
        assert!(auth.validate(&tampered).is_none());
    }

    #[test]
    fn expiry_outside_the_ttl_is_rejected_even_with_a_valid_mac() {
        let auth = AdminAuth::new("token", "https://example.test");
        let mut nonce_bytes = [0u8; NONCE_BYTES];
        getrandom::getrandom(&mut nonce_bytes).expect("OS random");
        let nonce = hex(&nonce_bytes);
        let expires_at = now_secs().saturating_add(TTL_SECS + 120);
        let payload = format!("v1.{expires_at}.{nonce}");
        let mac = hex(&hmac_sha256(&auth.key, payload.as_bytes()));
        let cookie = format!("{payload}.{mac}");
        assert!(
            auth.validate(&cookie).is_none(),
            "a valid MAC must not extend the 12 h lifetime"
        );
    }

    #[test]
    fn secure_flag_follows_public_url() {
        let https = AdminAuth::new("t", "https://example.test");
        assert!(https.session_cookie("v1.1.a.b").contains("; Secure"));
        assert!(https.csrf_cookie("abc").contains("; Secure"));
        let http = AdminAuth::new("t", "http://127.0.0.1:7899");
        assert!(!http.session_cookie("v1.1.a.b").contains("; Secure"));
        assert!(!http.csrf_cookie("abc").contains("; Secure"));
    }

    #[test]
    fn cookie_flags_are_fixed() {
        let auth = AdminAuth::new("t", "https://example.test");
        let session = auth.session_cookie("v1.1.a.b");
        assert!(session.contains("HttpOnly"));
        assert!(session.contains("SameSite=Strict"));
        assert!(session.contains("Path=/cabinet/admin"));
        assert!(session.contains("Max-Age=43200"));
        assert!(session.contains("Secure"));
        let csrf = auth.csrf_cookie("abc");
        assert!(!csrf.contains("HttpOnly"));
        assert!(csrf.contains("Path=/cabinet/admin"));
    }

    #[test]
    fn cookie_header_parsing() {
        let header = "a=1; rotor_admin=v1.2.3.4; rotor_admin_csrf=xy";
        assert_eq!(cookie_value(header, "rotor_admin"), Some("v1.2.3.4"));
        assert_eq!(cookie_value(header, "rotor_admin_csrf"), Some("xy"));
        assert_eq!(cookie_value(header, "missing"), None);
    }
}
