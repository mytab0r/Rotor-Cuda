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
use crate::monitor::notify::TelegramConfig;
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

    /// Seconds until `key` may try again, or `None` while it is under the
    /// limit. Read-only: unlike [`Self::allow`], this records nothing.
    pub fn retry_after(&self, key: &str) -> Option<u64> {
        let now = Instant::now();
        let mut hits = self
            .hits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let queue = hits.get_mut(key)?;
        while queue
            .front()
            .is_some_and(|first| now.duration_since(*first) >= self.window)
        {
            queue.pop_front();
        }
        if queue.len() < self.limit {
            return None;
        }
        let oldest = *queue.front()?;
        let remaining = self.window.saturating_sub(now.duration_since(oldest));
        Some(remaining.as_secs().max(1))
    }
}

/// Shared request context for the monitor routes.
pub struct Context<'a> {
    pub store: &'a MonitorStore,
    pub telegram: &'a TelegramConfig,
    pub domain: &'a str,
    pub trust_proxy: bool,
}

/// Route one monitor request. Always responds.
pub fn handle(context: Context<'_>, request: Request, method: &Method, path: &str, query: &str) {
    let Context {
        store,
        telegram,
        domain,
        trust_proxy,
    } = context;
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
        (Method::Post, "/api/v1/monitor/telegram/link") => telegram_link(store, telegram, request),
        (Method::Get, "/api/v1/monitor/telegram/status") => telegram_status(store, request),
        (Method::Delete, "/api/v1/monitor/telegram/link") => telegram_unlink(store, request),
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

/// Create a single-use Telegram linking code and its deep link.
fn telegram_link(store: &MonitorStore, telegram: &TelegramConfig, request: Request) {
    let Some(user_id) = auth::session_user(store, &request) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    if !telegram.is_enabled() {
        return respond_json(
            request,
            503,
            &json!({"error": "Telegram alerts are not configured on this server"}),
        );
    }
    let Some(user) = store.user(&user_id) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    if user.telegram_chat_id.is_some() {
        return respond_json(
            request,
            409,
            &json!({"error": "Telegram is already linked; unlink it first"}),
        );
    }
    match store.create_link_code(&user_id) {
        Ok(link) => respond_json(
            request,
            200,
            &json!({
                "code": link.code,
                "deep_link": telegram.deep_link(&link.code),
                "expires_at": link.expires_at,
            }),
        ),
        Err(err) => respond_json(request, 500, &json!({"error": err})),
    }
}

fn telegram_status(store: &MonitorStore, request: Request) {
    let Some(user_id) = auth::session_user(store, &request) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    match store.telegram_status(&user_id) {
        Some(linked) => respond_json(request, 200, &json!({"linked": linked})),
        None => respond_json(request, 401, &json!({"error": "unauthorized"})),
    }
}

fn telegram_unlink(store: &MonitorStore, request: Request) {
    let Some(user_id) = auth::session_user(store, &request) else {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    };
    match store.unlink_telegram(&user_id) {
        Ok(_) => respond_json(request, 200, &json!({"linked": false})),
        Err(err) => respond_json(request, 500, &json!({"error": err})),
    }
}

#[derive(Deserialize)]
struct TelegramUpdate {
    #[serde(default)]
    message: Option<TelegramMessage>,
}

#[derive(Deserialize)]
struct TelegramMessage {
    chat: TelegramChat,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct TelegramChat {
    id: i64,
}

/// Public Telegram webhook. Verifies the secret header, binds a chat to the
/// account that owns a `/start <code>` payload and confirms over the Bot API.
///
/// The response is sent before the confirmation call so Telegram sees a quick
/// 200. Unknown or malformed updates are acknowledged and ignored.
pub fn handle_webhook(store: &MonitorStore, telegram: &TelegramConfig, mut request: Request) {
    if !telegram.is_enabled() {
        return respond_json(
            request,
            503,
            &json!({"error": "Telegram alerts are not configured on this server"}),
        );
    }
    let Some(secret) = store.webhook_secret() else {
        return respond_json(
            request,
            503,
            &json!({"error": "Telegram webhook is not initialized"}),
        );
    };
    let presented = header_value(&request, "X-Telegram-Bot-Api-Secret-Token")
        .unwrap_or_default()
        .to_string();
    if !constant_time_eq(presented.as_bytes(), secret.as_bytes()) {
        return respond_json(request, 401, &json!({"error": "unauthorized"}));
    }
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let update: TelegramUpdate = match serde_json::from_str(&body) {
        Ok(update) => update,
        // Malformed updates are ignored; Telegram must not keep retrying.
        Err(_) => return respond_json(request, 200, &json!({"ok": true})),
    };
    let Some(message) = update.message else {
        return respond_json(request, 200, &json!({"ok": true}));
    };
    let Some(code) = message.text.as_deref().and_then(start_code) else {
        return respond_json(request, 200, &json!({"ok": true}));
    };
    let link = match store.consume_link_code(code) {
        Ok(link) => link,
        Err(err) => {
            eprintln!("rotor-coord: telegram webhook: {err}");
            return respond_json(request, 200, &json!({"ok": true}));
        }
    };
    if let Some(link) = link {
        let _ = store.link_telegram(&link.user_id, message.chat.id);
        respond_json(request, 200, &json!({"ok": true}));
        let _ = telegram.sender().send_message(
            message.chat.id,
            "Rotor monitor: Telegram alerts linked. You will receive notifications for your watched addresses. Send no keys here.",
        );
    } else {
        respond_json(request, 200, &json!({"ok": true}));
    }
}

/// Extract `<code>` from `/start <code>` (also `/start@bot <code>`).
fn start_code(text: &str) -> Option<&str> {
    let mut parts = text.split_whitespace();
    let command = parts.next()?;
    if command != "/start" && !command.starts_with("/start@") {
        return None;
    }
    let code = parts.next()?;
    (code.len() <= 64
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    .then_some(code)
}

fn header_value<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

/// Constant-time byte comparison for the webhook secret.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
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

    struct WebhookHarness {
        path: std::path::PathBuf,
        store: std::sync::Arc<MonitorStore>,
        config: TelegramConfig,
        addr: std::net::SocketAddr,
        server: std::sync::Arc<tiny_http::Server>,
        join: Option<std::thread::JoinHandle<()>>,
        mock: TelegramMock,
    }

    impl WebhookHarness {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "rotor-monitor-telegram-{}-{nanos}-{tag}.json",
                std::process::id()
            ));
            let store = std::sync::Arc::new(MonitorStore::open(&path).expect("open store"));
            store.ensure_webhook_secret().expect("secret");
            let mock = TelegramMock::start();
            let config = TelegramConfig {
                bot_token: "test-token".to_string(),
                bot_username: "test_bot".to_string(),
                api_base: mock.base.clone(),
            };
            let server =
                std::sync::Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("http server"));
            let addr = server.server_addr().to_ip().expect("addr");
            let handler_store = std::sync::Arc::clone(&store);
            let handler_config = config.clone();
            let handler_server = std::sync::Arc::clone(&server);
            let join = std::thread::spawn(move || {
                for request in handler_server.incoming_requests() {
                    handle_webhook(&handler_store, &handler_config, request);
                }
            });
            Self {
                path,
                store,
                config,
                addr,
                server,
                join: Some(join),
                mock,
            }
        }

        fn post(&self, secret: Option<&str>, body: &str) -> u16 {
            let url = format!("http://{}/api/v1/telegram/webhook", self.addr);
            let mut request = ureq::post(&url).set("Content-Type", "application/json");
            if let Some(secret) = secret {
                request = request.set("X-Telegram-Bot-Api-Secret-Token", secret);
            }
            match request.send_string(body) {
                Ok(response) => response.status(),
                Err(ureq::Error::Status(code, _)) => code,
                Err(_) => 0,
            }
        }
    }

    impl Drop for WebhookHarness {
        fn drop(&mut self) {
            self.server.unblock();
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(format!("{}.tmp", self.path.display()));
        }
    }

    /// Bot API mock recording message bodies.
    struct TelegramMock {
        base: String,
        bodies: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        join: Option<std::thread::JoinHandle<()>>,
    }

    impl TelegramMock {
        fn start() -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock");
            listener.set_nonblocking(true).expect("nonblocking");
            let base = format!("http://{}", listener.local_addr().expect("addr"));
            let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let recorded = std::sync::Arc::clone(&bodies);
            let stopping = std::sync::Arc::clone(&stop);
            let join = std::thread::spawn(move || {
                while !stopping.load(std::sync::atomic::Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            crate::monitor::mock_http::prepare(&mut stream);
                            if let Some(body) =
                                crate::monitor::mock_http::read_http_body(&mut stream)
                            {
                                recorded.lock().expect("bodies").push(body);
                            }
                            crate::monitor::mock_http::respond_ok(&mut stream);
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                base,
                bodies,
                stop,
                join: Some(join),
            }
        }

        fn count(&self) -> usize {
            self.bodies.lock().expect("bodies").len()
        }

        fn wait_for(&self, expected: usize) {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while std::time::Instant::now() < deadline && self.count() < expected {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for TelegramMock {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    #[test]
    fn webhook_rejects_a_wrong_or_missing_secret() {
        let harness = WebhookHarness::new("secret");
        let user = harness
            .store
            .upsert_user("0x1111111111111111111111111111111111111111");
        let user = user.expect("user");
        let link = harness.store.create_link_code(&user.id).expect("code");
        let body = format!(
            r#"{{"update_id":1,"message":{{"message_id":1,"chat":{{"id":777,"type":"private"}},"text":"/start {}"}}}}"#,
            link.code
        );

        assert_eq!(harness.post(None, &body), 401);
        assert_eq!(harness.post(Some("wrong-secret"), &body), 401);
        assert_eq!(harness.store.telegram_status(&user.id), Some(false));
        // The rejected call did not consume the code.
        assert!(
            harness
                .store
                .consume_link_code(&link.code)
                .expect("peek")
                .is_some()
        );
        assert_eq!(harness.mock.count(), 0);
        let _ = &harness.config;
    }

    #[test]
    fn webhook_binds_the_chat_and_confirms_once() {
        let harness = WebhookHarness::new("bind");
        let user = harness
            .store
            .upsert_user("0x1111111111111111111111111111111111111111")
            .expect("user");
        let link = harness.store.create_link_code(&user.id).expect("code");
        let secret = harness.store.webhook_secret().expect("secret");
        let body = format!(
            r#"{{"update_id":1,"message":{{"message_id":1,"chat":{{"id":777,"type":"private"}},"text":"/start {}"}}}}"#,
            link.code
        );

        assert_eq!(harness.post(Some(&secret), &body), 200);
        assert_eq!(harness.store.telegram_status(&user.id), Some(true));
        let bound = harness.store.user(&user.id).expect("user");
        assert_eq!(bound.telegram_chat_id, Some(777));
        harness.mock.wait_for(1);
        assert_eq!(harness.mock.count(), 1);
        let bodies = harness.mock.bodies.lock().expect("bodies");
        assert!(bodies[0].contains("\"chat_id\":777"));
        drop(bodies);

        // Single-use: replaying the update sends no second confirmation.
        assert_eq!(harness.post(Some(&secret), &body), 200);
        harness.mock.wait_for(1);
        assert_eq!(harness.mock.count(), 1);
    }
}
