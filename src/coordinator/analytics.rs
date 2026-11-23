//! Privacy-preserving first-party visit analytics.
//!
//! The collector accepts one beacon per page view and keeps **hourly aggregate
//! buckets only**. It never stores an IP address, a user agent, a cookie, a
//! storage identifier or a full referrer URL. The remote address is used as a
//! transient rate-limit key and is discarded with the request; the user agent
//! is reduced to a coarse device/browser class; the referrer is reduced to its
//! host; the country comes only from Cloudflare's `CF-IPCountry` header.
//!
//! The buckets live in the coordinator state file (`State::record_analytics`),
//! so a restart keeps the current day. [`RETENTION_HOURS`] caps history at one
//! week and the oldest bucket is dropped on every write.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tiny_http::{Method, Request, Response, StatusCode};

use super::state::now_secs;
use super::{App, BodyError, header, header_value, read_body, respond_hidden};

/// Public collector route.
pub const COLLECT_PATH: &str = "/api/v1/analytics/collect";
/// Hourly buckets kept: exactly seven days.
pub const RETENTION_HOURS: u64 = 7 * 24;
/// Largest accepted beacon body. A valid payload is under 300 bytes.
const MAX_BODY_BYTES: usize = 4 * 1024;
/// Longest accepted page path.
const MAX_PATH_LEN: usize = 512;
/// Longest accepted referrer host.
const MAX_REFERRER_LEN: usize = 253;
/// Per-bucket cardinality cap; new keys beyond it are counted as `other`.
const MAX_KEYS_PER_BUCKET: usize = 64;
/// One beacon per second per IP with a 60-view burst. Enough for a shared
/// office/NAT address while still absorbing a trivial flood.
const IP_RATE_PER_SECOND: f64 = 1.0;
const IP_BURST: f64 = 60.0;
/// Drop idle rate-limit entries once the map grows past this size.
const IP_MAP_SOFT_LIMIT: usize = 4096;
const IP_IDLE_SECS: u64 = 600;
/// The only origins allowed to call the collector cross-origin.
pub const ALLOWED_ORIGINS: [&str; 2] =
    ["https://rotor.pxbt.app", "https://rotor-site-b8c.pages.dev"];

// ---------------------------------------------------------------------------
// Stored aggregates
// ---------------------------------------------------------------------------

/// One hourly aggregate bucket. Every field is a counter; no per-visitor row
/// exists and every map is bounded by [`MAX_KEYS_PER_BUCKET`].
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Bucket {
    #[serde(default)]
    pub views: u64,
    #[serde(default)]
    pub routes: BTreeMap<String, u64>,
    #[serde(default)]
    pub countries: BTreeMap<String, u64>,
    #[serde(default)]
    pub devices: BTreeMap<String, u64>,
    #[serde(default)]
    pub browsers: BTreeMap<String, u64>,
    #[serde(default)]
    pub referrers: BTreeMap<String, u64>,
}

/// The persisted analytics document, embedded in the coordinator state file.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AnalyticsData {
    version: u32,
    #[serde(default)]
    buckets: BTreeMap<u64, Bucket>,
}

impl Default for AnalyticsData {
    fn default() -> Self {
        Self {
            version: DATA_VERSION,
            buckets: BTreeMap::new(),
        }
    }
}

const DATA_VERSION: u32 = 1;

impl AnalyticsData {
    /// Reject a foreign format instead of guessing.
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version == DATA_VERSION {
            Ok(())
        } else {
            Err(format!(
                "unsupported analytics state version {}; this build expects {DATA_VERSION}",
                self.version
            ))
        }
    }

    /// Increment one hourly bucket. `now` is Unix seconds.
    pub(crate) fn record(&mut self, now: u64, visit: &Visit) {
        let bucket = self.buckets.entry(hour_start(now)).or_default();
        bucket.views = bucket.views.saturating_add(1);
        bump(&mut bucket.routes, visit.family);
        bump(&mut bucket.countries, &visit.country);
        bump(&mut bucket.devices, visit.device);
        bump(&mut bucket.browsers, visit.browser);
        bump(&mut bucket.referrers, &visit.referrer);
    }

    /// Keep only the last [`RETENTION_HOURS`] hourly slots.
    pub(crate) fn prune(&mut self, now: u64) {
        let current = hour_start(now);
        let oldest = current.saturating_sub((RETENTION_HOURS - 1) * 3600);
        self.buckets
            .retain(|hour, _| *hour >= oldest && *hour <= current);
    }

    /// Admin projection: today, the calendar week, hourly/daily slots and the
    /// top families. Counts only; there is nothing identifying to expose.
    pub(crate) fn snapshot(&self, now: u64) -> Value {
        let current_hour = hour_start(now);
        let today = day_start(now);
        let week = today.saturating_sub(6 * 86_400);

        let mut today_views = 0u64;
        let mut week_views = 0u64;
        let mut week_bucket = Bucket::default();
        for (hour, bucket) in &self.buckets {
            if *hour < week || *hour > current_hour {
                continue;
            }
            week_views = week_views.saturating_add(bucket.views);
            merge_into(&mut week_bucket, bucket);
            if *hour >= today {
                today_views = today_views.saturating_add(bucket.views);
            }
        }

        let mut hourly = Vec::with_capacity(24);
        let mut last_24h = 0u64;
        for offset in (0..24u64).rev() {
            let hour = current_hour.saturating_sub(offset * 3600);
            let views = self.buckets.get(&hour).map_or(0, |bucket| bucket.views);
            last_24h = last_24h.saturating_add(views);
            hourly.push(json!({ "hour": hour, "views": views }));
        }

        let mut daily = Vec::with_capacity(7);
        for offset in (0..7u64).rev() {
            let day = today.saturating_sub(offset * 86_400);
            let mut views = 0u64;
            for (hour, bucket) in &self.buckets {
                if *hour >= day && *hour < day + 86_400 {
                    views = views.saturating_add(bucket.views);
                }
            }
            daily.push(json!({ "day": day, "views": views }));
        }

        let hour_views = self
            .buckets
            .get(&current_hour)
            .map_or(0, |bucket| bucket.views);
        // The current hour is partial: divide by the minutes that have passed
        // instead of pretending the bucket is a full hour.
        let minutes_into_hour = ((now % 3600) / 60).max(1);
        let minutes_last_24h = 24 * 60;

        json!({
            "generated_at": now,
            "retention_hours": RETENTION_HOURS,
            "timezone": "UTC",
            "today": { "start": today, "views": today_views },
            "week": { "start": week, "views": week_views },
            "hourly": hourly,
            "daily": daily,
            "routes": named(&week_bucket.routes, 12),
            "countries": named(&week_bucket.countries, 12),
            "devices": named(&week_bucket.devices, 6),
            "browsers": named(&week_bucket.browsers, 6),
            "referrers": named(&week_bucket.referrers, 10),
            "load": {
                "views_this_hour": hour_views,
                "views_last_24h": last_24h,
                "views_per_minute_current_hour": per_minute(hour_views, minutes_into_hour),
                "views_per_minute_last_24h": per_minute(last_24h, minutes_last_24h),
            },
        })
    }

    #[cfg(test)]
    fn bucket_count(&self) -> usize {
        self.buckets.len()
    }
}

fn bump(map: &mut BTreeMap<String, u64>, key: &str) {
    if let Some(value) = map.get_mut(key) {
        *value += 1;
        return;
    }
    // Reserve one slot for the `other` sentinel so the map never exceeds the
    // cap even when the sentinel itself has to be inserted.
    if map.len() >= MAX_KEYS_PER_BUCKET - 1 {
        *map.entry("other".to_string()).or_insert(0) += 1;
    } else {
        map.insert(key.to_string(), 1);
    }
}

fn merge_into(target: &mut Bucket, source: &Bucket) {
    target.views = target.views.saturating_add(source.views);
    for (key, value) in &source.routes {
        *target.routes.entry(key.clone()).or_insert(0) += value;
    }
    for (key, value) in &source.countries {
        *target.countries.entry(key.clone()).or_insert(0) += value;
    }
    for (key, value) in &source.devices {
        *target.devices.entry(key.clone()).or_insert(0) += value;
    }
    for (key, value) in &source.browsers {
        *target.browsers.entry(key.clone()).or_insert(0) += value;
    }
    for (key, value) in &source.referrers {
        *target.referrers.entry(key.clone()).or_insert(0) += value;
    }
}

/// Sorted `[{<field>: key, views: n}]`, highest first, then alphabetical.
fn named(map: &BTreeMap<String, u64>, limit: usize) -> Value {
    let mut rows: Vec<(&String, u64)> = map.iter().map(|(key, value)| (key, *value)).collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    rows.truncate(limit);
    Value::Array(
        rows.into_iter()
            .map(|(key, views)| json!({ "name": key, "views": views }))
            .collect(),
    )
}

fn per_minute(count: u64, minutes: u64) -> f64 {
    if minutes == 0 {
        return 0.0;
    }
    ((count as f64 / minutes as f64) * 10_000.0).round() / 10_000.0
}

fn hour_start(now: u64) -> u64 {
    now / 3600 * 3600
}

fn day_start(now: u64) -> u64 {
    now / 86_400 * 86_400
}

// ---------------------------------------------------------------------------
// Request interpretation
// ---------------------------------------------------------------------------

/// One accepted beacon after server-side derivation. There is deliberately no
/// field for an IP address or a raw user agent.
#[derive(Clone, Debug)]
pub struct Visit {
    pub family: &'static str,
    pub referrer: String,
    pub country: String,
    pub device: &'static str,
    pub browser: &'static str,
}

#[derive(Deserialize)]
struct CollectRequest {
    event: String,
    path: String,
    #[serde(default)]
    referrer_host: Option<String>,
}

struct ParsedVisit {
    family: &'static str,
    referrer: String,
}

/// Validate a beacon body and reduce the path to a known family.
fn parse_collect(body: &str) -> Result<ParsedVisit, &'static str> {
    let request: CollectRequest = serde_json::from_str(body).map_err(|_| "invalid JSON body")?;
    if request.event != "view" {
        return Err("event must be \"view\"");
    }
    let path = request.path.as_str();
    if path.is_empty()
        || path.len() > MAX_PATH_LEN
        || !path.starts_with('/')
        || path
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b' ')
    {
        return Err("invalid path");
    }
    // Query strings and fragments are never stored or inspected.
    let path = path.split(['?', '#']).next().unwrap_or(path);
    Ok(ParsedVisit {
        family: normalize_path(path),
        referrer: validate_referrer(request.referrer_host.as_deref())?,
    })
}

/// Map a path to a fixed route family. Unknown paths share one `other` bucket
/// so request input cannot grow the key space.
pub(crate) fn normalize_path(path: &str) -> &'static str {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let path = path.trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };

    // Prefix families: a dynamic segment is folded into the hub.
    for (prefix, family) in [
        ("/cabinet/admin", "/cabinet/admin"),
        ("/cabinet/wallet", "/cabinet/wallet"),
        ("/private-keys", "/private-keys"),
        ("/bitcoin-puzzle", "/bitcoin-puzzle"),
        ("/mnemonic-seeds", "/mnemonic-seeds"),
        ("/brainwallet", "/brainwallet"),
        ("/keystore-parser", "/keystore-parser"),
        ("/public-key", "/public-key"),
        ("/pubkey-add", "/pubkey-add"),
        ("/reconstruction", "/reconstruction"),
        ("/hex-dec-bin", "/hex-dec-bin"),
        ("/mnemonic-converter", "/mnemonic-converter"),
        ("/key", "/key"),
        ("/send", "/send"),
        ("/keys", "/keys"),
        ("/tx", "/tx"),
    ] {
        if path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        {
            return family;
        }
    }

    match path {
        "/" => "/",
        "/app" => "/app",
        "/run" => "/run",
        "/me" => "/me",
        "/docs" => "/docs",
        "/faq" => "/faq",
        "/disclaimer" => "/disclaimer",
        "/donate" => "/donate",
        "/tools" => "/tools",
        "/vanity" | "/vanity-generator" => "/vanity",
        "/seed" => "/seed",
        "/milk-sad" => "/milk-sad",
        "/security" => "/security",
        "/wallets" => "/wallets",
        "/downloads" => "/downloads",
        "/cabinet" => "/cabinet",
        "/monitor" => "/monitor",
        _ => "other",
    }
}

/// Lowercase DNS host, or `direct` when absent/blank. Anything that is not a
/// host (slashes, port, credentials, spaces) is rejected.
fn validate_referrer(value: Option<&str>) -> Result<String, &'static str> {
    let Some(raw) = value else {
        return Ok("direct".to_string());
    };
    let host = raw.trim().to_ascii_lowercase();
    if host.is_empty() {
        return Ok("direct".to_string());
    }
    if host.len() > MAX_REFERRER_LEN
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        || host.starts_with('.')
        || host.ends_with('.')
        || host.starts_with('-')
        || host.ends_with('-')
        || host.contains("..")
    {
        return Err("invalid referrer host");
    }
    Ok(host)
}

/// Only a two-letter uppercase country code from `CF-IPCountry` is accepted.
pub(crate) fn country_from_header(value: Option<&str>) -> String {
    match value.map(str::trim) {
        Some(code) if code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_uppercase()) => {
            code.to_string()
        }
        _ => "unknown".to_string(),
    }
}

/// Coarse device class from the user agent. A missing UA is treated as a bot:
/// real browsers always send one.
pub(crate) fn classify_device(user_agent: Option<&str>) -> &'static str {
    let Some(user_agent) = user_agent else {
        return "bot";
    };
    let ua = user_agent.to_ascii_lowercase();
    const BOTS: [&str; 18] = [
        "bot",
        "crawler",
        "spider",
        "slurp",
        "headless",
        "lighthouse",
        "curl/",
        "wget",
        "python-requests",
        "go-http-client",
        "okhttp",
        "java/",
        "axios/",
        "node-fetch",
        "undici",
        "httpclient",
        "facebookexternalhit",
        "preview",
    ];
    if BOTS.iter().any(|needle| ua.contains(needle)) {
        return "bot";
    }
    if ua.contains("ipad")
        || ua.contains("tablet")
        || ua.contains("playbook")
        || ua.contains("silk/")
        || (ua.contains("android") && !ua.contains("mobile"))
    {
        return "tablet";
    }
    if ua.contains("mobile")
        || ua.contains("mobi")
        || ua.contains("iphone")
        || ua.contains("ipod")
        || ua.contains("android")
        || ua.contains("windows phone")
        || ua.contains("opera mini")
        || ua.contains("iemobile")
    {
        return "mobile";
    }
    "desktop"
}

/// Coarse browser family. Edge and Chrome are tested before Safari because
/// their user agents embed the Chrome/Safari tokens.
pub(crate) fn classify_browser(user_agent: Option<&str>) -> &'static str {
    let Some(user_agent) = user_agent else {
        return "other";
    };
    let ua = user_agent.to_ascii_lowercase();
    if ua.contains("edg/") || ua.contains("edga/") || ua.contains("edgios/") || ua.contains("edge/")
    {
        "edge"
    } else if ua.contains("firefox/") || ua.contains("fxios/") {
        "firefox"
    } else if ua.contains("chrome/") || ua.contains("crios/") || ua.contains("chromium/") {
        "chrome"
    } else if ua.contains("safari/") {
        "safari"
    } else {
        "other"
    }
}

// ---------------------------------------------------------------------------
// Per-IP rate limiting (memory only)
// ---------------------------------------------------------------------------

struct IpBucket {
    tokens: f64,
    last: Instant,
    seen: Instant,
}

/// Token bucket keyed by the request's remote address. The map lives only in
/// process memory and the IP is never written to the state file.
#[derive(Default)]
pub struct IpLimiter {
    buckets: Mutex<HashMap<String, IpBucket>>,
}

impl IpLimiter {
    pub fn allow(&self, ip: &str) -> bool {
        let now = Instant::now();
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if buckets.len() >= IP_MAP_SOFT_LIMIT {
            buckets.retain(|_, bucket| now.duration_since(bucket.seen).as_secs() < IP_IDLE_SECS);
        }
        let bucket = buckets.entry(ip.to_string()).or_insert_with(|| IpBucket {
            tokens: IP_BURST,
            last: now,
            seen: now,
        });
        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * IP_RATE_PER_SECOND).min(IP_BURST);
        bucket.last = now;
        bucket.seen = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    fn cleanup(&self) {
        self.buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// The CORS decision for one request.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CorsOrigin {
    /// No `Origin` header: same-origin navigation, curl and tests.
    Absent,
    Allowed(&'static str),
    Foreign,
}

pub(crate) fn cors_origin(origin: Option<&str>) -> CorsOrigin {
    match origin {
        None => CorsOrigin::Absent,
        Some(value) => ALLOWED_ORIGINS
            .iter()
            .copied()
            .find(|allowed| *allowed == value)
            .map_or(CorsOrigin::Foreign, CorsOrigin::Allowed),
    }
}

/// Handle `POST`/`OPTIONS /api/v1/analytics/collect`.
pub(super) fn handle(app: &App, mut request: Request, method: &Method, ip: &str) {
    let cors = cors_origin(header_value(&request, "Origin"));
    if method == &Method::Options {
        return match cors {
            CorsOrigin::Allowed(origin) => respond_preflight(request, origin),
            CorsOrigin::Absent | CorsOrigin::Foreign => {
                respond_error(request, 403, None, "origin not allowed")
            }
        };
    }

    let allowed_origin = match cors {
        CorsOrigin::Allowed(origin) => Some(origin),
        CorsOrigin::Foreign => {
            return respond_error(request, 403, None, "origin not allowed");
        }
        CorsOrigin::Absent => None,
    };

    if !app.analytics_limiter.allow(ip) {
        return respond_limited(request, allowed_origin);
    }

    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(BodyError::TooLarge) => {
            return respond_error(request, 413, allowed_origin, "request body too large");
        }
        Err(BodyError::Io(message)) => {
            return respond_error(request, 400, allowed_origin, &message);
        }
    };
    if body.len() > MAX_BODY_BYTES {
        return respond_error(request, 413, allowed_origin, "request body too large");
    }
    let parsed = match parse_collect(&body) {
        Ok(parsed) => parsed,
        Err(message) => return respond_error(request, 400, allowed_origin, message),
    };

    let visit = Visit {
        family: parsed.family,
        referrer: parsed.referrer,
        country: country_from_header(header_value(&request, "CF-IPCountry")),
        device: classify_device(header_value(&request, "User-Agent")),
        browser: classify_browser(header_value(&request, "User-Agent")),
    };
    let saved = {
        let mut state = app.lock();
        state.record_analytics(now_secs(), &visit)
    };
    match saved {
        Ok(()) => respond_empty(request, 204, allowed_origin),
        Err(_) => respond_error(request, 500, allowed_origin, "analytics persistence failed"),
    }
}

fn apply_cors<R: std::io::Read>(
    mut response: Response<R>,
    origin: Option<&'static str>,
) -> Response<R> {
    response = response
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("Vary", "Origin"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    if let Some(origin) = origin {
        response = response
            .with_header(header("Access-Control-Allow-Origin", origin))
            .with_header(header("Access-Control-Allow-Methods", "POST, OPTIONS"))
            .with_header(header("Access-Control-Allow-Headers", "content-type"))
            .with_header(header("Access-Control-Max-Age", "86400"));
    }
    response
}

fn respond_empty(request: Request, status: u16, origin: Option<&'static str>) {
    let response = Response::empty(StatusCode(status));
    respond_hidden(request, apply_cors(response, origin));
}

fn respond_error(request: Request, status: u16, origin: Option<&'static str>, message: &str) {
    let response = Response::from_string(json!({ "error": message }).to_string())
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "application/json"));
    respond_hidden(request, apply_cors(response, origin));
}

fn respond_limited(request: Request, origin: Option<&'static str>) {
    let response = Response::from_string(json!({ "error": "rate limit exceeded" }).to_string())
        .with_status_code(StatusCode(429))
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Retry-After", "60"));
    respond_hidden(request, apply_cors(response, origin));
}

fn respond_preflight(request: Request, origin: &'static str) {
    let response = Response::empty(StatusCode(204))
        .with_header(header("Access-Control-Allow-Origin", origin))
        .with_header(header("Access-Control-Allow-Methods", "POST, OPTIONS"))
        .with_header(header("Access-Control-Allow-Headers", "content-type"))
        .with_header(header("Access-Control-Max-Age", "86400"));
    respond_hidden(request, apply_cors(response, Some(origin)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visit(family: &'static str, country: &str) -> Visit {
        Visit {
            family,
            referrer: "search.example".to_string(),
            country: country.to_string(),
            device: "desktop",
            browser: "firefox",
        }
    }

    #[test]
    fn route_constant_matches_the_dispatched_literal() {
        // `data/routes.json` is validated against literals in `handle`, so the
        // dispatcher spells the path out and this test keeps both in sync.
        assert_eq!(COLLECT_PATH, "/api/v1/analytics/collect");
    }

    #[test]
    fn normalizes_dynamic_paths_into_families_and_unknowns_into_other() {
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path(""), "/");
        assert_eq!(normalize_path("/private-keys/ethereum"), "/private-keys");
        assert_eq!(normalize_path("/private-keys/ethereum/3/"), "/private-keys");
        assert_eq!(normalize_path("/bitcoin-puzzle/66"), "/bitcoin-puzzle");
        assert_eq!(
            normalize_path("/bitcoin-puzzle/66?ref=x"),
            "/bitcoin-puzzle"
        );
        assert_eq!(normalize_path("/mnemonic-seeds/bitcoin"), "/mnemonic-seeds");
        assert_eq!(normalize_path("/key/00ff"), "/key");
        assert_eq!(normalize_path("/keys/bitcoin/1-2"), "/keys");
        assert_eq!(normalize_path("/send/bnb"), "/send");
        assert_eq!(normalize_path("/tx/bitcoin"), "/tx");
        assert_eq!(normalize_path("/docs"), "/docs");
        assert_eq!(normalize_path("/cabinet/admin/analytics"), "/cabinet/admin");
        assert_eq!(normalize_path("/something-new"), "other");
        assert_eq!(normalize_path("/PRIVATE-KEYS"), "other");
        // The key space cannot grow with request input.
        assert_eq!(normalize_path(&format!("/x/{}", "a".repeat(300))), "other");
    }

    #[test]
    fn classifies_coarse_devices_and_browsers() {
        let chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
        assert_eq!(classify_device(Some(chrome)), "desktop");
        assert_eq!(classify_browser(Some(chrome)), "chrome");

        let edge = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0";
        assert_eq!(classify_browser(Some(edge)), "edge");

        let safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
        assert_eq!(classify_browser(Some(safari)), "safari");

        let firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
        assert_eq!(classify_browser(Some(firefox)), "firefox");
        assert_eq!(classify_device(Some(firefox)), "desktop");

        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
        assert_eq!(classify_device(Some(iphone)), "mobile");
        assert_eq!(classify_browser(Some(iphone)), "safari");

        let ipad = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
        assert_eq!(classify_device(Some(ipad)), "tablet");

        let android_tablet = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
        assert_eq!(classify_device(Some(android_tablet)), "tablet");

        assert_eq!(
            classify_device(Some("Googlebot/2.1 (+http://www.google.com/bot.html)")),
            "bot"
        );
        assert_eq!(classify_browser(Some("curl/8.0")), "other");
        assert_eq!(classify_device(None), "bot");
        assert_eq!(classify_browser(None), "other");
    }

    #[test]
    fn country_accepts_only_a_two_letter_code() {
        assert_eq!(country_from_header(Some("DE")), "DE");
        assert_eq!(country_from_header(Some(" DE ")), "DE");
        assert_eq!(country_from_header(Some("de")), "unknown");
        assert_eq!(country_from_header(Some("DEU")), "unknown");
        assert_eq!(country_from_header(Some("D1")), "unknown");
        assert_eq!(country_from_header(Some("")), "unknown");
        assert_eq!(country_from_header(None), "unknown");
    }

    #[test]
    fn rejects_malformed_beacons() {
        assert!(parse_collect("").is_err());
        assert!(parse_collect("{}").is_err());
        assert!(parse_collect("{\"event\":\"view\"}").is_err());
        assert!(parse_collect("{\"event\":\"click\",\"path\":\"/\"}").is_err());
        assert!(parse_collect("{\"event\":\"view\",\"path\":\"\"}").is_err());
        assert!(parse_collect("{\"event\":\"view\",\"path\":\"docs\"}").is_err());
        assert!(parse_collect("{\"event\":\"view\",\"path\":\"/a b\"}").is_err());
        assert!(
            parse_collect(&format!(
                "{{\"event\":\"view\",\"path\":\"/{}\"}}",
                "a".repeat(MAX_PATH_LEN)
            ))
            .is_err()
        );
        for bad in [
            "https://example.com/a",
            "example.com/path",
            "example.com:443",
            "bad host",
            "-bad.example",
            ".bad.example",
            "bad..example",
        ] {
            let body = json!({"event":"view","path":"/","referrer_host":bad}).to_string();
            assert!(parse_collect(&body).is_err(), "{bad}");
        }

        let ok = parse_collect("{\"event\":\"view\",\"path\":\"/private-keys/ethereum?x=1\"}")
            .expect("valid beacon");
        assert_eq!(ok.family, "/private-keys");
        assert_eq!(ok.referrer, "direct");
        let ok = parse_collect(
            "{\"event\":\"view\",\"path\":\"/\",\"referrer_host\":\"Search.Example\"}",
        )
        .expect("valid referrer");
        assert_eq!(ok.referrer, "search.example");
    }

    #[test]
    fn retains_exactly_seven_days_of_hourly_buckets() {
        let now = 1_700_000_000;
        let mut data = AnalyticsData::default();
        for index in 0..RETENTION_HOURS + 50 {
            data.record(now - index * 3600, &visit("/", "US"));
        }
        data.prune(now);
        assert_eq!(data.bucket_count() as u64, RETENTION_HOURS);
        assert!(data.buckets.contains_key(&hour_start(now)));
        assert!(
            !data
                .buckets
                .contains_key(&(hour_start(now) - RETENTION_HOURS * 3600))
        );
    }

    #[test]
    fn aggregates_today_week_and_top_dimensions() {
        // 2023-11-14 12:00:00 UTC.
        let now = 1_700_000_000;
        let today = day_start(now);
        let mut data = AnalyticsData::default();
        data.record(today + 3600, &visit("/private-keys", "US"));
        data.record(today + 7200, &visit("/private-keys", "DE"));
        data.record(today - 3600, &visit("/bitcoin-puzzle", "US")); // yesterday
        data.record(today - 2 * 86_400, &visit("/docs", "US"));
        // Older than the retention window: must not appear anywhere.
        data.record(today - 9 * 86_400, &visit("/", "FR"));
        data.prune(now);

        let snapshot = data.snapshot(now);
        assert_eq!(snapshot["today"]["views"], 2);
        assert_eq!(snapshot["week"]["views"], 4);
        assert_eq!(snapshot["retention_hours"], RETENTION_HOURS);
        assert_eq!(snapshot["timezone"], "UTC");
        let routes = snapshot["routes"].as_array().expect("routes");
        assert_eq!(routes[0]["name"], "/private-keys");
        assert_eq!(routes[0]["views"], 2);
        let countries = snapshot["countries"].as_array().expect("countries");
        assert_eq!(countries[0]["name"], "US");
        assert_eq!(countries[0]["views"], 3);
        assert!(snapshot["hourly"].as_array().expect("hourly").len() == 24);
        assert!(snapshot["daily"].as_array().expect("daily").len() == 7);
        assert!(
            snapshot["load"]["views_per_minute_last_24h"]
                .as_f64()
                .expect("rate")
                > 0.0
        );
    }

    #[test]
    fn cardinality_is_capped_per_bucket() {
        let now = 1_700_000_000;
        let mut data = AnalyticsData::default();
        for index in 0..MAX_KEYS_PER_BUCKET + 10 {
            let host = format!("host{index}.example");
            let mut entry = visit("/", "US");
            entry.referrer = host;
            data.record(now, &entry);
        }
        let bucket = data.buckets.get(&hour_start(now)).expect("bucket");
        assert_eq!(bucket.views, (MAX_KEYS_PER_BUCKET + 10) as u64);
        assert_eq!(bucket.referrers.len(), MAX_KEYS_PER_BUCKET);
        // 63 real hosts keep their own key; the sentinel takes the last slot.
        assert_eq!(bucket.referrers.get("other"), Some(&11));
    }

    #[test]
    fn stored_document_never_contains_an_ip_or_user_agent() {
        let now = 1_700_000_000;
        let mut data = AnalyticsData::default();
        let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
        let ip = "203.0.113.77";
        // The record API has no parameter for either value; derive the visit
        // exactly like the handler does and prove the serialized bytes carry
        // neither.
        let entry = Visit {
            family: normalize_path("/docs"),
            referrer: validate_referrer(Some("search.example")).expect("host"),
            country: country_from_header(Some("US")),
            device: classify_device(Some(user_agent)),
            browser: classify_browser(Some(user_agent)),
        };
        data.record(now, &entry);
        let serialized = serde_json::to_string(&data).expect("serialize");
        assert!(!serialized.contains(ip), "{serialized}");
        assert!(!serialized.contains("Mozilla"), "{serialized}");
        assert!(!serialized.contains("Windows NT"), "{serialized}");
        assert!(
            serialized.contains("\"devices\":{\"desktop\":1}"),
            "{serialized}"
        );
        assert!(
            serialized.contains("\"browsers\":{\"chrome\":1}"),
            "{serialized}"
        );
        assert!(
            serialized.contains("\"countries\":{\"US\":1}"),
            "{serialized}"
        );
    }

    #[test]
    fn cors_allows_exactly_the_two_site_origins() {
        assert_eq!(cors_origin(None), CorsOrigin::Absent);
        assert_eq!(
            cors_origin(Some("https://rotor.pxbt.app")),
            CorsOrigin::Allowed("https://rotor.pxbt.app")
        );
        assert_eq!(
            cors_origin(Some("https://rotor-site-b8c.pages.dev")),
            CorsOrigin::Allowed("https://rotor-site-b8c.pages.dev")
        );
        for foreign in [
            "https://evil.example",
            "http://rotor.pxbt.app",
            "https://rotor.pxbt.app.evil.example",
            "https://rotor.pxbt.app/",
            "null",
        ] {
            assert_eq!(cors_origin(Some(foreign)), CorsOrigin::Foreign, "{foreign}");
        }
    }

    #[test]
    fn ip_limiter_bursts_then_throttles_without_storing_anything() {
        let limiter = IpLimiter::default();
        for _ in 0..IP_BURST as usize {
            assert!(limiter.allow("198.51.100.9"));
        }
        assert!(!limiter.allow("198.51.100.9"));
        assert!(limiter.allow("198.51.100.10"));
        limiter.cleanup();
        assert!(limiter.allow("198.51.100.9"));
    }
}
