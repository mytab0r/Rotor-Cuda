//! HTTP handlers for `/api/v1/monitor/*`.
//!
//! Monitor sessions are bearer tokens issued by [`crate::monitor::auth`] and
//! are entirely separate from coordinator client tokens.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use tiny_http::{Method, Request};

use crate::coordinator::{client_ip, query_param, read_body, respond_body_error, respond_json};
use crate::monitor::auth::{self, CHALLENGE_TTL_SECS};
use crate::monitor::store::{MonitorStore, NewWatch, canonicalize_address};

/// Exposure requests allowed per IP per window.
const EXPOSURE_LIMIT: usize = 30;
/// Challenge/login requests allowed per IP per window.
const AUTH_LIMIT: usize = 30;
/// Address adds allowed per account per window.
const ADDRESS_ADD_LIMIT: usize = 20;
/// Sliding-window length for all monitor rate limits.
const RATE_WINDOW: Duration = Duration::from_secs(60);
/// Maximum addresses accepted in one exposure request.
const MAX_EXPOSURE_ADDRESSES: usize = 500;
/// Maximum watch label length.
const MAX_LABEL_CHARS: usize = 64;
/// A plaintext private key would be exactly this many hex digits.
const SECRET_HEX_LEN: usize = 64;
/// WIF strings are 51 or 52 Base58 characters.
const WIF_LENGTHS: [usize; 2] = [51, 52];

static EXPOSURE_LIMITER: LazyLock<IpRateLimiter> =
    LazyLock::new(|| IpRateLimiter::new(EXPOSURE_LIMIT, RATE_WINDOW));
static CHALLENGE_LIMITER: LazyLock<IpRateLimiter> =
    LazyLock::new(|| IpRateLimiter::new(AUTH_LIMIT, RATE_WINDOW));
static LOGIN_LIMITER: LazyLock<IpRateLimiter> =
    LazyLock::new(|| IpRateLimiter::new(AUTH_LIMIT, RATE_WINDOW));
static ADDRESS_LIMITER: LazyLock<IpRateLimiter> =
    LazyLock::new(|| IpRateLimiter::new(ADDRESS_ADD_LIMIT, RATE_WINDOW));

/// Simple per-IP sliding-window counter (in memory; reset on restart).
pub struct IpRateLimiter {
    limit: usize,
    window: Duration,
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl IpRateLimiter {
    pub fn new(limit: usize, window: Duration) -> Self {
        Self {
            limit,
            window,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Count one request from `key`; false when the window is full.
    pub fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut hits = self
            .hits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if hits.len() > 4096 {
            hits.retain(|_, queue| {
                queue
                    .back()
                    .is_some_and(|last| now.duration_since(*last) < self.window)
            });
        }
        let queue = hits.entry(key.to_string()).or_default();
        while queue
            .front()
            .is_some_and(|first| now.duration_since(*first) >= self.window)
        {
            queue.pop_front();
        }
        if queue.len() >= self.limit {
            return false;
        }
        queue.push_back(now);
        true
    }
}

/// Route one monitor request. Always responds.
pub fn handle(
    store: &MonitorStore,
    domain: &str,
    trust_proxy: bool,
    request: Request,
    method: &Method,
    path: &str,
    query: &str,
) {
    match (method, path) {
        (Method::Post, "/api/v1/monitor/challenge") => {
            challenge(store, domain, trust_proxy, request)
        }
        (Method::Post, "/api/v1/monitor/login") => login(store, trust_proxy, request),
        (Method::Post, "/api/v1/monitor/logout") => logout(store, request),
        (Method::Post, "/api/v1/monitor/exposure") => exposure(store, trust_proxy, request),
        (Method::Get, "/api/v1/monitor/me") => me(store, request),
        (Method::Post, "/api/v1/monitor/addresses") => add_addresses(store, request),
        (Method::Patch, "/api/v1/monitor/settings") => settings(store, request),
        (Method::Get, "/api/v1/monitor/feed") => feed(store, request, query),
        (Method::Delete, _) => {
            if let Some(rest) = path.strip_prefix("/api/v1/monitor/addresses/") {
                delete_address(store, request, rest);
            } else {
                respond_json(request, 404, &json!({"error": "not found"}));
            }
        }
        _ => respond_json(request, 404, &json!({"error": "not found"})),
    }
}

fn rate_limited(request: Request) {
    respond_json(request, 429, &json!({"error": "rate limit exceeded"}));
}

#[derive(Deserialize)]
struct ChallengeRequest {
    #[serde(default = "default_chain")]
    chain: String,
    address: String,
}

fn default_chain() -> String {
    "evm".to_string()
}

fn challenge(store: &MonitorStore, domain: &str, trust_proxy: bool, mut request: Request) {
    if !CHALLENGE_LIMITER.allow(&client_ip(&request, trust_proxy)) {
        return rate_limited(request);
    }
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    if looks_like_secret(&body) {
        return reject_secret(request);
    }
    let challenge: ChallengeRequest = match serde_json::from_str(&body) {
        Ok(challenge) => challenge,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({"error": format!("invalid JSON: {err}")}),
            );
        }
    };
    let chain = match auth::login_chain(&challenge.chain) {
        Ok(chain) => chain,
        Err(err) => return respond_json(request, 400, &json!({"error": err})),
    };
    let address = match canonicalize_address(chain, &challenge.address) {
        Ok((_, address)) => address,
        Err(err) => return respond_json(request, 400, &json!({"error": err})),
    };
    let nonce = match store.new_nonce() {
        Ok(nonce) => nonce,
        Err(err) => return respond_json(request, 500, &json!({"error": err})),
    };
    let issued_at = crate::coordinator::state::now_secs();
    let expires_at = issued_at.saturating_add(CHALLENGE_TTL_SECS);
    // The domain is server configuration, never the attacker-controlled Host
    // header: otherwise a phishing site could obtain a signed SIWE message.
    let (sign_domain, origin) = auth::domain_and_origin(domain);
    let message = auth::challenge_message(
        &sign_domain,
        &origin,
        &address,
        &nonce,
        issued_at,
        expires_at,
    );
    if let Err(err) = store.put_challenge(&nonce, chain, &address, &message, expires_at) {
        return respond_json(request, 500, &json!({"error": err}));
    }
    respond_json(
        request,
        200,
        &json!({
            "chain": chain,
            "nonce": nonce,
            "message": message,
            "expires_at": expires_at,
        }),
    );
}

#[derive(Deserialize)]
struct LoginRequest {
    #[serde(default = "default_chain")]
    chain: String,
    message: String,
    signature: String,
}

fn login(store: &MonitorStore, trust_proxy: bool, mut request: Request) {
    if !LOGIN_LIMITER.allow(&client_ip(&request, trust_proxy)) {
        return rate_limited(request);
    }
    // A valid bearer session links the new identity to that account; it
    // never creates a second user.
    let session_user = auth::bearer_token(&request).and_then(|token| store.resolve_session(token));
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    if looks_like_secret(&body) {
        return reject_secret(request);
    }
    let login: LoginRequest = match serde_json::from_str(&body) {
        Ok(login) => login,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({"error": format!("invalid JSON: {err}")}),
            );
        }
    };
    match auth::login(
        store,
        &login.chain,
        &login.message,
        &login.signature,
        session_user.as_deref(),
    ) {
        Ok((user, token)) => respond_json(request, 200, &json!({"token": token, "user": user})),
        Err(err) => respond_json(request, 400, &json!({"error": err})),
    }
}

/// Revoke the presented bearer session.
fn logout(store: &MonitorStore, request: Request) {
    let Some(token) = auth::bearer_token(&request).map(str::to_string) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    match store.delete_session(&token) {
        Ok(true) => respond_json(request, 200, &json!({"ok": true})),
        Ok(false) => respond_json(request, 401, &json!({"error": "unauthorized"})),
        Err(err) => respond_json(request, 500, &json!({"error": err})),
    }
}

fn me(store: &MonitorStore, request: Request) {
    let Some(user_id) = auth::session_user(store, &request) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    match store.me(&user_id) {
        Some(view) => respond_json(request, 200, &view),
        None => respond_json(request, 404, &json!({"error": "not found"})),
    }
}

#[derive(Deserialize)]
struct AddressesRequest {
    addresses: Vec<AddressEntry>,
}

#[derive(Deserialize)]
struct AddressEntry {
    chain: String,
    address: String,
    #[serde(default)]
    label: Option<String>,
}

fn add_addresses(store: &MonitorStore, mut request: Request) {
    let Some(user_id) = auth::session_user(store, &request) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    if !ADDRESS_LIMITER.allow(&user_id) {
        return rate_limited(request);
    }
    let Some(user) = store.user(&user_id) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    if looks_like_secret(&body) {
        return reject_secret(request);
    }
    let addresses: AddressesRequest = match serde_json::from_str(&body) {
        Ok(addresses) => addresses,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({"error": format!("invalid JSON: {err}")}),
            );
        }
    };
    let mut watches = Vec::with_capacity(addresses.addresses.len());
    for entry in addresses.addresses {
        let (chain, address) = match canonicalize_address(&entry.chain, &entry.address) {
            Ok(pair) => pair,
            Err(err) => return respond_json(request, 400, &json!({"error": err})),
        };
        // A watch is verified only when its (chain, address) matches one of
        // the account's verified login identities. The primary EVM address is
        // therefore verified by identity, not by string equality here.
        let verified = user.identities.iter().any(|identity| {
            identity.chain == chain && identity.address == address && identity.verified
        });
        let label = entry
            .label
            .map(|label| label.trim().to_string())
            .filter(|label| !label.is_empty())
            .map(|label| label.chars().take(MAX_LABEL_CHARS).collect::<String>());
        watches.push(NewWatch {
            chain,
            address,
            label,
            verified,
        });
    }
    match store.add_watches(&user_id, watches) {
        Ok(watches) => respond_json(request, 200, &json!({"watches": watches})),
        Err(err) if err.contains("address limit") => {
            respond_json(request, 403, &json!({"error": err}))
        }
        Err(err) => respond_json(request, 500, &json!({"error": err})),
    }
}

fn delete_address(store: &MonitorStore, request: Request, rest: &str) {
    let Some(user_id) = auth::session_user(store, &request) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    let Some((chain, address)) = rest.split_once('/') else {
        return respond_json(request, 404, &json!({"error": "not found"}));
    };
    let Ok((chain, address)) = canonicalize_address(chain, address) else {
        return respond_json(request, 404, &json!({"error": "not found"}));
    };
    match store.delete_watch(&user_id, &chain, &address) {
        Ok(true) => respond_json(request, 200, &json!({"ok": true})),
        // Unknown and not-owned watches are indistinguishable.
        Ok(false) | Err(_) => respond_json(request, 404, &json!({"error": "not found"})),
    }
}

#[derive(Deserialize)]
struct SettingsRequest {
    #[serde(default)]
    recovery_opt_in: Option<bool>,
    #[serde(default)]
    alerts_enabled: Option<bool>,
}

fn settings(store: &MonitorStore, mut request: Request) {
    let Some(user_id) = auth::session_user(store, &request) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    if looks_like_secret(&body) {
        return reject_secret(request);
    }
    let settings: SettingsRequest = match serde_json::from_str(&body) {
        Ok(settings) => settings,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({"error": format!("invalid JSON: {err}")}),
            );
        }
    };
    match store.update_settings(&user_id, settings.recovery_opt_in, settings.alerts_enabled) {
        Ok(Some(settings)) => respond_json(request, 200, &json!({"settings": settings})),
        Ok(None) => respond_json(request, 404, &json!({"error": "not found"})),
        Err(err) => respond_json(request, 500, &json!({"error": err})),
    }
}

fn feed(store: &MonitorStore, request: Request, query: &str) {
    let Some(user_id) = auth::session_user(store, &request) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    let since = match query_param(query, "since") {
        Some(value) => match value.parse::<u64>() {
            Ok(value) => Some(value),
            Err(_) => return respond_json(request, 400, &json!({"error": "invalid since"})),
        },
        None => None,
    };
    respond_json(
        request,
        200,
        &json!({"events": store.feed(&user_id, since)}),
    );
}

#[derive(Deserialize)]
struct ExposureRequest {
    addresses: Vec<ExposureEntry>,
}

#[derive(Deserialize)]
struct ExposureEntry {
    chain: String,
    address: String,
}

fn exposure(store: &MonitorStore, trust_proxy: bool, mut request: Request) {
    if !EXPOSURE_LIMITER.allow(&client_ip(&request, trust_proxy)) {
        return rate_limited(request);
    }
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    if looks_like_secret(&body) {
        return reject_secret(request);
    }
    let exposure: ExposureRequest = match serde_json::from_str(&body) {
        Ok(exposure) => exposure,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({"error": format!("invalid JSON: {err}")}),
            );
        }
    };
    if exposure.addresses.len() > MAX_EXPOSURE_ADDRESSES {
        return respond_json(
            request,
            400,
            &json!({"error": format!("at most {MAX_EXPOSURE_ADDRESSES} addresses per request")}),
        );
    }
    let mut pairs = Vec::with_capacity(exposure.addresses.len());
    for entry in exposure.addresses {
        // Unknown chains (TRON/Solana on `/key`) and malformed addresses are
        // skipped rather than failing the whole batch; the response stays
        // uniform and never echoes the submitted value.
        if let Ok(pair) = canonicalize_address(&entry.chain, &entry.address) {
            pairs.push(pair);
        }
    }
    match store.record_exposure(&pairs) {
        Ok(matched) => respond_json(request, 200, &json!({"matched": matched})),
        Err(err) => respond_json(request, 500, &json!({"error": err})),
    }
}

fn reject_secret(request: Request) {
    respond_json(
        request,
        422,
        &json!({"error": "private keys, WIF and seed phrases are never accepted"}),
    );
}

/// True when the body contains a plaintext private key (exactly 64 hex
/// digits) or a WIF-shaped Base58 string. The body is never logged.
pub fn looks_like_secret(body: &str) -> bool {
    looks_like_hex_key(body) || looks_like_wif(body)
}

fn looks_like_hex_key(body: &str) -> bool {
    let mut run = 0usize;
    for byte in body.bytes() {
        if byte.is_ascii_hexdigit() {
            run += 1;
        } else {
            if run == SECRET_HEX_LEN {
                return true;
            }
            run = 0;
        }
    }
    run == SECRET_HEX_LEN
}

fn looks_like_wif(body: &str) -> bool {
    body.split(|character: char| !character.is_ascii_alphanumeric())
        .any(|token| {
            WIF_LENGTHS.contains(&token.len())
                && matches!(token.as_bytes().first(), Some(b'5' | b'K' | b'L'))
                && token.bytes().all(is_base58_character)
        })
}

fn is_base58_character(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() && !matches!(byte, b'0' | b'O' | b'I' | b'l')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custody_guard_recognizes_key_material() {
        assert!(looks_like_secret(&format!(
            r#"{{"key":"{}"}}"#,
            "ab".repeat(32)
        )));
        assert!(looks_like_secret(&format!(
            r#"{{"key":"0x{}"}}"#,
            "AB".repeat(32)
        )));
        // A 65-byte signature is 130 hex digits: not a 64-digit key.
        assert!(!looks_like_secret(&format!(
            r#"{{"signature":"0x{}"}}"#,
            "ab".repeat(65)
        )));
        // WIF-shaped Base58 (length 52, leading K).
        let wif = format!("K{}", "a".repeat(51));
        assert!(looks_like_secret(&format!(r#"{{"wif":"{wif}"}}"#)));
        // Ordinary EVM addresses and SIWE text are fine.
        assert!(!looks_like_secret(
            r#"{"addresses":[{"chain":"evm","address":"0x1111111111111111111111111111111111111111"}]}"#
        ));
        assert!(!looks_like_secret(
            "localhost wants you to sign in with your Ethereum account:\n\
             0x1111111111111111111111111111111111111111\n\nRotor monitor login\n\n\
             URI: http://localhost\nVersion: 1\nChain ID: 1\nNonce: 0123456789abcdef0123456789abcdef\n\
             Issued At: 2026-01-01T00:00:00Z\nExpiration Time: 2026-01-01T00:10:00Z"
        ));
    }

    #[test]
    fn ip_rate_limiter_enforces_the_window() {
        let limiter = IpRateLimiter::new(3, Duration::from_secs(60));
        assert!(limiter.allow("127.0.0.1"));
        assert!(limiter.allow("127.0.0.1"));
        assert!(limiter.allow("127.0.0.1"));
        assert!(!limiter.allow("127.0.0.1"));
        assert!(limiter.allow("127.0.0.2"));
    }

    #[test]
    fn ip_rate_limiter_expires_old_hits() {
        let limiter = IpRateLimiter::new(1, Duration::from_millis(1));
        assert!(limiter.allow("127.0.0.1"));
        std::thread::sleep(Duration::from_millis(5));
        assert!(limiter.allow("127.0.0.1"));
    }
}
