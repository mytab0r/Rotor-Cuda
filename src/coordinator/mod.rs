//! Distributed coordinator: a token-protected HTTP/JSON API plus a static
//! dashboard.
//!
//! One thread accepts requests and one thread per request does the work; state
//! lives behind a single mutex. No async runtime, no TLS (terminate it in a
//! reverse proxy).

pub mod chunk_loop;
pub mod client;
pub mod puzzles;
pub mod state;
pub mod wallets;

use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Instant;

use serde::Deserialize;
use serde_json::json;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use num_bigint::BigUint;
use num_traits::ToPrimitive;
use state::{
    ERR_CLIENT_NOT_FOUND, ERR_INVALID_SAMPLE, ERR_JOB_NOT_FOUND, ERR_LEASE_LOST,
    ERR_MANIFEST_MISMATCH,
};

/// The public site is embedded so the binary stays a single file.
const LANDING: &str = include_str!("../../apps/site/landing.html");
const APP_PAGE: &str = include_str!("../../apps/site/app.html");
const ME_PAGE: &str = include_str!("../../apps/site/me.html");
const DOCS_PAGE: &str = include_str!("../../apps/site/docs.html");
const SITE_CSS: &str = include_str!("../../apps/site/site.css");
const SITE_JS: &str = include_str!("../../apps/site/site.js");
const RUN_PAGE: &str = include_str!("../../apps/site/run.html");
const KEY_PAGE: &str = include_str!("../../apps/site/key.html");
const KEY_JS: &str = include_str!("../../apps/site/key.js");
const RANGE_PAGE: &str = include_str!("../../apps/site/range.html");
const RANGE_JS: &str = include_str!("../../apps/site/range.js");
const PUZZLE_JS: &str = include_str!("../../apps/site/puzzle.js");
const PUZZLE_BROWSER_JS: &str = include_str!("../../apps/site/puzzle-browser.js");
const PUZZLE_WORKER_JS: &str = include_str!("../../apps/site/puzzle-worker.js");
const MONITOR_PAGE: &str = include_str!("../../apps/site/monitor.html");
const MONITOR_JS: &str = include_str!("../../apps/site/monitor.js");
const ROTOR_WORKER: &str = include_str!("../../apps/site/rotor-worker.js");
const ROTOR_WASM: &[u8] = include_bytes!("../../apps/site/rotor_wasm.wasm");
const WALLETCONNECT_JS: &[u8] = include_bytes!("../../apps/site/walletconnect.js");
const BRAINWALLET_JS: &str = include_str!("../../apps/site/brainwallet.js");
const BRAINWALLET_ENGINE_JS: &str = include_str!("../../apps/site/brainwallet-engine.js");
const BROWSE_JS: &str = include_str!("../../apps/site/browse.js");
const VANITY_PAGE: &str = include_str!("../../apps/site/vanity.html");
const VANITY_JS: &str = include_str!("../../apps/site/vanity.js");
const SEED_PAGE: &str = include_str!("../../apps/site/seed.html");
const SEED_BUNDLE: &str = include_str!("../../apps/site/seed.js");
const SEED_PAGE_JS: &str = include_str!("../../apps/site/seed-page.js");
const SEED_CRYPTO_JS: &str = include_str!("../../apps/site/seed-crypto.js");
const SEED_STUDIO_CSS: &str = include_str!("../../apps/site/seed-studio.css");
const MNEMONIC_CONVERTER_PAGE: &str = include_str!("../../apps/site/mnemonic-converter.html");
const MNEMONIC_SEEDS_PAGE: &str = include_str!("../../apps/site/mnemonic-seeds.html");
const MNEMONIC_SEEDS_JS: &str = include_str!("../../apps/site/mnemonic-seeds.js");
const MILK_PAGE: &str = include_str!("../../apps/site/milk-sad.html");
const MILK_JS: &str = include_str!("../../apps/site/milk-sad.js");
const TOOLS_PAGE: &str = include_str!("../../apps/site/tools.html");
const KEY_TOOLS_JS: &str = include_str!("../../apps/site/key-tools.js");
const HEX_DEC_BIN_PAGE: &str = include_str!("../../apps/site/hex-dec-bin.html");
const HEX_DEC_BIN_JS: &str = include_str!("../../apps/site/hex-dec-bin.js");
const PUBLIC_KEY_PAGE: &str = include_str!("../../apps/site/public-key.html");
const PUBLIC_KEY_JS: &str = include_str!("../../apps/site/public-key.js");
const PUBKEY_ADD_PAGE: &str = include_str!("../../apps/site/pubkey-add.html");
const PUBKEY_ADD_JS: &str = include_str!("../../apps/site/pubkey-add.js");
const KEYSTORE_PARSER_PAGE: &str = include_str!("../../apps/site/keystore-parser.html");
const KEYSTORE_PARSER_JS: &str = include_str!("../../apps/site/keystore-parser.js");
const RECONSTRUCTION_PAGE: &str = include_str!("../../apps/site/reconstruction.html");
const RECONSTRUCTION_JS: &str = include_str!("../../apps/site/reconstruction.js");
const CABINET_WALLET_PAGE: &str = include_str!("../../apps/site/wallet.html");
const WALLET_JS: &str = include_str!("../../apps/site/wallet.js");
const WALLET_VAULT_JS: &str = include_str!("../../apps/site/wallet-vault.js");
const WALLET_EVM_JS: &str = include_str!("../../apps/site/wallet-evm.js");
const WALLET_BTC_JS: &str = include_str!("../../apps/site/wallet-btc.js");
const SEARCH_JS: &str = include_str!("../../apps/site/search.js");
const THEME_JS: &str = include_str!("../../apps/site/theme.js");
const ICONS_SVG: &[u8] = include_bytes!("../../apps/site/icons.svg");
const MANROPE_WOFF2: &[u8] = include_bytes!("../../apps/site/fonts/manrope-latin.woff2");
const FAVICON_ICO: &[u8] = include_bytes!("../../apps/site/favicon.ico");
const FAVICON_PNG: &[u8] = include_bytes!("../../apps/site/favicon.png");
/// Canonical public origin for absolute URLs in the SEO surface. It is never
/// derived from the request `Host` header; override with `ROTOR_PUBLIC_URL`
/// (the CLI flag lives outside this module's route contract).
const DEFAULT_PUBLIC_URL: &str = "https://rotor.pxbt.app";
/// Largest request body the coordinator buffers (JSON commands are tiny).
const MAX_BODY_BYTES: usize = 1024 * 1024;
/// Requests handled concurrently; the rest are rejected with 503.
const MAX_CONCURRENT_REQUESTS: usize = 32;
/// Per-token rate limit: requests per second and the bucket depth.
const RATE_PER_SECOND: f64 = 20.0;
const RATE_BURST: f64 = 40.0;
/// Minimum seconds between two self-service registrations from one remote IP.
const REGISTER_WINDOW_SECS: u64 = 60;
/// Number of request handlers currently running.
static ACTIVE_REQUESTS: AtomicUsize = AtomicUsize::new(0);

/// The `--clients` map: client id -> SHA-256 of its bearer token.
#[derive(Clone, Debug, Default)]
pub struct Clients {
    tokens: HashMap<String, [u8; 32]>,
}

impl Clients {
    /// Parse the JSON `{ "client-id": "<sha256 hex>", ... }` form.
    pub fn parse(text: &str) -> Result<Self, String> {
        let raw: HashMap<String, String> = serde_json::from_str(text)
            .map_err(|err| format!("cannot parse clients JSON: {err}"))?;
        let mut tokens = HashMap::with_capacity(raw.len());
        for (id, hash) in raw {
            let id = id.trim().to_string();
            if id.is_empty() {
                return Err("clients file contains a blank client id".to_string());
            }
            if tokens.contains_key(&id) {
                return Err(format!("clients file contains duplicate client id {id}"));
            }
            let digest = decode_hash(hash.trim())?;
            if tokens.values().any(|existing| existing == &digest) {
                return Err(format!(
                    "clients file gives client {id} a duplicate token hash"
                ));
            }
            tokens.insert(id, digest);
        }
        Ok(Self { tokens })
    }

    /// Read and parse a clients file.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path)
            .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
        Self::parse(&text)
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    /// Import entries as `(client id, SHA-256 of its token)` pairs.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &[u8; 32])> {
        self.tokens.iter().map(|(id, hash)| (id.as_str(), hash))
    }
}

/// Accepted identity for one request.
#[derive(Clone)]
enum Identity {
    /// The admin token (`--token`/`ROTOR_COORD_TOKEN`).
    Admin,
    /// A registered client (state account or an imported `--clients` entry).
    Client(String),
}

impl Identity {
    fn rate_key(&self) -> String {
        match self {
            Identity::Admin => "admin".to_string(),
            Identity::Client(id) => id.clone(),
        }
    }
}

/// Per-token token bucket. In memory only; reset on restart.
#[derive(Default)]
struct RateLimiter {
    buckets: Mutex<HashMap<String, Bucket>>,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    fn allow(&self, key: &str) -> bool {
        self.allow_with(key, RATE_PER_SECOND, RATE_BURST)
    }

    /// Token bucket with an explicit refill rate and burst depth. Heavy routes
    /// (streamed dataset downloads) use a much smaller bucket than the API.
    fn allow_with(&self, key: &str, rate_per_second: f64, burst: f64) -> bool {
        let now = Instant::now();
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let bucket = buckets.entry(key.to_string()).or_insert_with(|| Bucket {
            tokens: burst,
            last: now,
        });
        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate_per_second).min(burst);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Self-service registration throttled to one request per IP per window.
/// In memory only; reset on restart.
#[derive(Default)]
struct RegisterLimiter {
    last: Mutex<HashMap<String, u64>>,
}

impl RegisterLimiter {
    fn allow(&self, ip: &str, now: u64) -> bool {
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        last.retain(|_, at| now.saturating_sub(*at) < REGISTER_WINDOW_SECS);
        if last
            .get(ip)
            .is_some_and(|at| now.saturating_sub(*at) < REGISTER_WINDOW_SECS)
        {
            return false;
        }
        last.insert(ip.to_string(), now);
        true
    }
}

struct App {
    state: Mutex<state::State>,
    admin_token: String,
    rate: RateLimiter,
    register: RegisterLimiter,
    open_registration: bool,
    /// Address monitor, when `rotor-coord` started it. `None` keeps ordinary
    /// coordinator-only servers (tests, embedders) from serving monitor routes.
    monitor: Option<Arc<crate::monitor::store::MonitorStore>>,
    /// Server-configured SIWE domain, never taken from the request.
    monitor_domain: String,
    /// Trust reverse-proxy client-IP headers for rate limiting.
    trust_proxy: bool,
    /// Canonical public origin (no trailing slash) for canonical links, the
    /// sitemap and JSON-LD. Fixed at startup, never taken from the request.
    public_url: String,
    /// Optional Reown/WalletConnect project id, exposed to the cabinet config.
    walletconnect_project_id: String,
    /// Base URL of the Rich-Address-Wallet release mirror used by
    /// [`wallets`]. Fixed at startup (options or `ROTOR_WALLETS_UPSTREAM`);
    /// request input can only pick a chain from the allowlist, never a host.
    wallets_upstream: Option<String>,
    /// Telegram Bot API configuration for monitor alert linking/delivery.
    telegram: Arc<crate::monitor::notify::TelegramConfig>,
}

impl App {
    fn lock(&self) -> MutexGuard<'_, state::State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// True while the state holds no accounts: the single admin token is
    /// accepted for every endpoint (legacy mode). Creating or importing the
    /// first client switches the coordinator to the per-client matrix.
    fn legacy(&self) -> bool {
        !self.lock().has_clients()
    }

    fn identity(&self, request: &Request) -> Option<Identity> {
        let presented = bearer(request)?;
        if constant_time_eq(presented.as_bytes(), self.admin_token.as_bytes()) {
            return Some(Identity::Admin);
        }
        self.lock().identify_client(presented).map(Identity::Client)
    }

    /// Endpoint permission for an authenticated identity. Unknown paths pass
    /// through so the dispatcher can answer 404.
    fn allowed(&self, role: &Identity, method: &Method, path: &str) -> bool {
        if self.legacy() {
            return true;
        }
        if method == &Method::Get && (path == "/api/v1/status" || path == "/api/v1/jobs") {
            return true;
        }
        if method == &Method::Get && path == "/api/v1/me" {
            return matches!(role, Identity::Client(_));
        }
        if method == &Method::Post && path == "/api/v1/jobs" {
            return matches!(role, Identity::Admin);
        }
        if (method == &Method::Get || method == &Method::Post) && path == "/api/v1/clients" {
            return matches!(role, Identity::Admin);
        }
        if method == &Method::Post
            && path
                .strip_prefix("/api/v1/clients/")
                .is_some_and(|rest| rest.ends_with("/disable"))
        {
            return matches!(role, Identity::Admin);
        }
        if method == &Method::Post
            && matches!(
                path,
                "/api/v1/lease" | "/api/v1/heartbeat" | "/api/v1/result"
            )
        {
            return matches!(role, Identity::Client(_));
        }
        if path == "/api/v1/bsgs/state" && (method == &Method::Get || method == &Method::Post) {
            return matches!(role, Identity::Client(_));
        }
        true
    }
}

/// A running coordinator. Drop or [`ServerHandle::shutdown`] stops it.
pub struct ServerHandle {
    pub addr: SocketAddr,
    server: Arc<Server>,
    join: Option<thread::JoinHandle<()>>,
}

impl ServerHandle {
    /// Stop accepting requests and wait for the accept loop to finish.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.server.unblock();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Bind and serve in legacy single-token mode.
///
/// `bind` may use port `0`; the real address is in [`ServerHandle::addr`].
pub fn spawn(bind: &str, state_path: &Path, token: String) -> Result<ServerHandle, String> {
    spawn_with_options(bind, state_path, token, Clients::default(), false)
}

/// Bind and serve with the given per-client token map.
///
/// An empty map keeps the legacy single-token behavior (the admin token works
/// on every endpoint). With a map, lease/heartbeat/result require a client
/// token and job creation requires the admin token. The map is imported into
/// the state on the first start; afterwards the state is authoritative.
pub fn spawn_with_clients(
    bind: &str,
    state_path: &Path,
    token: String,
    clients: Clients,
) -> Result<ServerHandle, String> {
    spawn_with_options(bind, state_path, token, clients, false)
}

/// Runtime options shared by the coordinator and the monitor.
#[derive(Clone, Debug)]
pub struct ServerOptions {
    /// Enable public `POST /api/v1/register`.
    pub open_registration: bool,
    /// Trust `CF-Connecting-IP` / the first `X-Forwarded-For` hop for rate
    /// limits. Only enable this when a reverse proxy sets those headers.
    pub trust_proxy: bool,
    /// Fixed SIWE domain shown in monitor challenges (never the Host header).
    pub monitor_domain: String,
    /// Optional override for the Rich-Address-Wallet release mirror base URL.
    /// `None` reads `ROTOR_WALLETS_UPSTREAM` and then falls back to the
    /// project's public release host (a server-side constant, never a request
    /// parameter).
    pub wallets_upstream: Option<String>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            open_registration: false,
            trust_proxy: false,
            monitor_domain: "localhost".to_string(),
            wallets_upstream: None,
        }
    }
}

/// Bind and serve with accounts, tokens and optional open registration.
///
/// `open_registration` enables `POST /api/v1/register`. The `clients` map is
/// imported into the state only when the state has no accounts yet.
pub fn spawn_with_options(
    bind: &str,
    state_path: &Path,
    token: String,
    clients: Clients,
    open_registration: bool,
) -> Result<ServerHandle, String> {
    spawn_inner(
        bind,
        state_path,
        token,
        clients,
        ServerOptions {
            open_registration,
            ..ServerOptions::default()
        },
        None,
    )
}

/// Coordinator-only variant that also controls reverse-proxy trust.
pub fn spawn_with_options_trust_proxy(
    bind: &str,
    state_path: &Path,
    token: String,
    clients: Clients,
    open_registration: bool,
    trust_proxy: bool,
) -> Result<ServerHandle, String> {
    spawn_inner(
        bind,
        state_path,
        token,
        clients,
        ServerOptions {
            open_registration,
            trust_proxy,
            ..ServerOptions::default()
        },
        None,
    )
}

/// Bind and serve with the address monitor mounted under
/// `/api/v1/monitor/*`. The monitor store is independent of coordinator state.
pub fn spawn_with_monitor_options(
    bind: &str,
    state_path: &Path,
    token: String,
    clients: Clients,
    options: ServerOptions,
    monitor: Arc<crate::monitor::store::MonitorStore>,
) -> Result<ServerHandle, String> {
    spawn_inner(bind, state_path, token, clients, options, Some(monitor))
}

fn spawn_inner(
    bind: &str,
    state_path: &Path,
    token: String,
    clients: Clients,
    options: ServerOptions,
    monitor: Option<Arc<crate::monitor::store::MonitorStore>>,
) -> Result<ServerHandle, String> {
    if token.is_empty() {
        return Err("the coordinator token must not be empty".to_string());
    }
    let monitor_domain = crate::monitor::auth::normalize_domain(&options.monitor_domain)?;
    let wallets_upstream = options
        .wallets_upstream
        .clone()
        .or_else(|| std::env::var("ROTOR_WALLETS_UPSTREAM").ok())
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty());
    let mut state = state::State::open(state_path)?;
    if !clients.is_empty() {
        let entries = clients
            .entries()
            .map(|(id, hash)| (id.to_string(), *hash))
            .collect();
        state.import_clients(entries)?;
    }
    let server = Server::http(bind).map_err(|err| format!("cannot bind {bind}: {err}"))?;
    let addr = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| format!("cannot resolve the bound address of {bind}"))?;
    let server = Arc::new(server);
    let app = Arc::new(App {
        state: Mutex::new(state),
        admin_token: token,
        rate: RateLimiter::default(),
        register: RegisterLimiter::default(),
        open_registration: options.open_registration,
        monitor,
        monitor_domain,
        trust_proxy: options.trust_proxy,
        public_url: public_url_from_env(),
        walletconnect_project_id: std::env::var("ROTOR_WALLETCONNECT_PROJECT_ID")
            .unwrap_or_default(),
        wallets_upstream,
        telegram: Arc::new(crate::monitor::notify::TelegramConfig::from_env()),
    });
    let listener = Arc::clone(&server);
    let join = thread::spawn(move || {
        for request in listener.incoming_requests() {
            if ACTIVE_REQUESTS.fetch_add(1, Ordering::SeqCst) >= MAX_CONCURRENT_REQUESTS {
                ACTIVE_REQUESTS.fetch_sub(1, Ordering::SeqCst);
                reject_over_capacity(&app, request);
                continue;
            }
            let app = Arc::clone(&app);
            thread::spawn(move || {
                let _slot = ActiveSlot;
                handle(app, request);
            });
        }
    });
    Ok(ServerHandle {
        addr,
        server,
        join: Some(join),
    })
}

/// Releases the concurrency slot when a request handler finishes.
struct ActiveSlot;

impl Drop for ActiveSlot {
    fn drop(&mut self) {
        ACTIVE_REQUESTS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Rejects a request that arrived while the handler cap was reached.
///
/// An API request with a missing or wrong token still gets 401, so the auth
/// check wins over the capacity limit where it can be decided cheaply.
fn reject_over_capacity(app: &App, request: Request) {
    let url = request.url().to_string();
    let path = url.split_once('?').map_or(url.as_str(), |(path, _)| path);
    let status = capacity_rejection_status(path, app.identity(&request).is_some());
    let error = if status == 401 {
        "unauthorized"
    } else {
        "server busy"
    };
    respond_json(request, status, &json!({ "error": error }));
}

fn capacity_rejection_status(path: &str, authorized: bool) -> u16 {
    // Public endpoints never answer 401; capacity is the only failure.
    if path == "/api/v1/summary"
        || path == "/api/v1/jobs/public"
        || path == "/api/v1/workers/public"
        || path == "/api/v1/register"
        || path == "/api/v1/monitor/config"
        || path == "/api/v1/telegram/webhook"
        || path.starts_with("/api/v1/wallets")
    {
        return 503;
    }
    if path.starts_with("/api/v1/") && !authorized {
        401
    } else {
        503
    }
}

fn handle(app: Arc<App>, request: Request) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));

    if method == Method::Get {
        if let Some(location) = redirect_target(path) {
            respond_redirect(request, &location);
            return;
        }
        // Dynamic SEO surface: key pages, chain hubs, robots and sitemap.
        if let Some((body, content_type, status)) = seo_asset(&app.public_url, path, query) {
            let response = Response::from_string(body)
                .with_status_code(StatusCode(status))
                .with_header(header("Content-Type", content_type))
                .with_header(header("Cache-Control", "no-cache"));
            let _ = request.respond(response);
            return;
        }
        if let Some((body, content_type)) = static_asset(path) {
            let response = Response::from_data(body)
                .with_header(header("Content-Type", content_type))
                .with_header(header("Cache-Control", "no-cache"));
            let _ = request.respond(response);
            return;
        }
        if !path.starts_with("/api/v1/") {
            // Unknown non-API paths are a real 404, never a soft landing page.
            let (body, content_type, status) = unknown_html_page();
            let response = Response::from_string(body)
                .with_status_code(StatusCode(status))
                .with_header(header("Content-Type", content_type));
            let _ = request.respond(response);
            return;
        }
    }

    if !path.starts_with("/api/v1/") {
        respond_json(request, 404, &json!({"error": "not found"}));
        return;
    }

    if method == Method::Get && path == "/api/v1/monitor/config" {
        return respond_json(
            request,
            200,
            &json!({ "walletconnect_project_id": app.walletconnect_project_id }),
        );
    }

    // Telegram webhook is public: Telegram calls it with its own secret header.
    if method == Method::Post && path == "/api/v1/telegram/webhook" {
        match app.monitor.as_ref() {
            Some(store) => crate::monitor::api::handle_webhook(store, &app.telegram, request),
            None => respond_json(request, 404, &json!({"error": "not found"})),
        }
        return;
    }

    // The address monitor has its own store, sessions and rate limits; its
    // routes never enter the coordinator token matrix below.
    if path.starts_with("/api/v1/monitor/") {
        match app.monitor.as_ref() {
            Some(store) => crate::monitor::api::handle(
                crate::monitor::api::Context {
                    store,
                    telegram: &app.telegram,
                    domain: &app.monitor_domain,
                    trust_proxy: app.trust_proxy,
                },
                request,
                &method,
                path,
                query,
            ),
            None => respond_json(request, 404, &json!({"error": "not found"})),
        }
        return;
    }

    // Public wallet-database catalogue and streamed dataset downloads. Hit
    // before the token matrix: the landing storefront must work without an
    // account, and the handler rate-limits per client IP itself.
    if method == Method::Get && path.starts_with("/api/v1/wallets") {
        wallets::handle(&app, request, path);
        return;
    }

    if method == Method::Get && path == "/api/v1/summary" {
        let response = app.lock().summary(state::now_secs());
        return respond_json(
            request,
            200,
            &json!({
                "totals": response.totals,
                "leaderboard": response.leaderboard,
                "registration_open": app.open_registration,
            }),
        );
    }

    // Public job snapshot: no token, lightly rate-limited per IP.
    if method == Method::Get && path == "/api/v1/jobs/public" {
        return public_jobs(&app, request);
    }

    // Public worker snapshot: same open, rate-limited policy.
    if method == Method::Get && path == "/api/v1/workers/public" {
        return public_workers(&app, request);
    }

    // Self-service registration is public; the flag decides 403 vs 201.
    if method == Method::Post && path == "/api/v1/register" {
        return register(&app, request);
    }

    let Some(role) = app.identity(&request) else {
        respond_json(request, 401, &json!({"error": "unauthorized"}));
        return;
    };

    if !app.rate.allow(&role.rate_key()) {
        respond_rate_limited(request);
        return;
    }

    if !app.allowed(&role, &method, path) {
        respond_json(request, 403, &json!({"error": "forbidden"}));
        return;
    }

    match (method, path) {
        (Method::Get, "/api/v1/jobs") => {
            let jobs = app.lock().list_jobs();
            respond_json(request, 200, &json!({ "jobs": jobs }));
        }
        (Method::Post, "/api/v1/jobs") => create_job(&app, request),
        (Method::Post, "/api/v1/lease") => lease(&app, request, &role),
        (Method::Post, "/api/v1/heartbeat") => heartbeat(&app, request, &role),
        (Method::Post, "/api/v1/result") => submit_result(&app, request, &role),
        (Method::Get, "/api/v1/status") => {
            let now = state::now_secs();
            let status = app.lock().status(now);
            respond_json(request, 200, &status);
        }
        (Method::Get, "/api/v1/me") => me(&app, request, &role),
        (Method::Get, "/api/v1/clients") => {
            let clients = app.lock().list_clients();
            respond_json(request, 200, &json!({ "clients": clients }));
        }
        (Method::Post, "/api/v1/clients") => create_client(&app, request),
        (Method::Post, _) if path.starts_with("/api/v1/clients/") => {
            disable_client(&app, request, path)
        }
        (Method::Get, "/api/v1/bsgs/state") => bsgs_get(&app, request, query),
        (Method::Post, "/api/v1/bsgs/state") => bsgs_put(&app, request),
        _ => respond_json(request, 404, &json!({"error": "not found"})),
    }
}

/// Static assets served before the API auth check.
fn static_asset(path: &str) -> Option<(&'static [u8], &'static str)> {
    match path {
        "/" => Some((LANDING.as_bytes(), "text/html; charset=utf-8")),
        "/app" => Some((APP_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/run" => Some((RUN_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/me" => Some((ME_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/docs" => Some((DOCS_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/key" => Some((KEY_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/key.js" => Some((KEY_JS.as_bytes(), "application/javascript; charset=utf-8")),
        "/range.js" => Some((RANGE_JS.as_bytes(), "application/javascript; charset=utf-8")),
        "/puzzle.js" => Some((
            PUZZLE_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/puzzle-browser.js" => Some((
            PUZZLE_BROWSER_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/puzzle-worker.js" => Some((
            PUZZLE_WORKER_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/walletconnect.js" => Some((WALLETCONNECT_JS, "application/javascript; charset=utf-8")),
        "/brainwallet.js" => Some((
            BRAINWALLET_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/brainwallet-engine.js" => Some((
            BRAINWALLET_ENGINE_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/browse.js" => Some((
            BROWSE_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/vanity" => Some((VANITY_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/vanity.js" => Some((
            VANITY_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/seed" => Some((SEED_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/seed.js" => Some((
            SEED_BUNDLE.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/seed-page.js" => Some((
            SEED_PAGE_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/seed-crypto.js" => Some((
            SEED_CRYPTO_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/seed-studio.css" => Some((SEED_STUDIO_CSS.as_bytes(), "text/css; charset=utf-8")),
        "/mnemonic-converter" => Some((
            MNEMONIC_CONVERTER_PAGE.as_bytes(),
            "text/html; charset=utf-8",
        )),
        "/mnemonic-seeds" => Some((MNEMONIC_SEEDS_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/mnemonic-seeds.js" => Some((
            MNEMONIC_SEEDS_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/ton.js" => Some((
            include_str!("../../apps/site/ton.js").as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/milk-sad" => Some((MILK_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/milk-sad.js" => Some((MILK_JS.as_bytes(), "application/javascript; charset=utf-8")),
        "/tools" => Some((TOOLS_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/key-tools.js" => Some((
            KEY_TOOLS_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/hex-dec-bin" => Some((HEX_DEC_BIN_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/hex-dec-bin.js" => Some((
            HEX_DEC_BIN_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/public-key" => Some((PUBLIC_KEY_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/public-key.js" => Some((
            PUBLIC_KEY_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/pubkey-add" => Some((PUBKEY_ADD_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/pubkey-add.js" => Some((
            PUBKEY_ADD_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/keystore-parser" => Some((KEYSTORE_PARSER_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/keystore-parser.js" => Some((
            KEYSTORE_PARSER_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/reconstruction" => Some((RECONSTRUCTION_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/reconstruction.js" => Some((
            RECONSTRUCTION_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/search.js" => Some((
            SEARCH_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/theme.js" => Some((THEME_JS.as_bytes(), "application/javascript; charset=utf-8")),
        "/icons.svg" => Some((ICONS_SVG, "image/svg+xml")),
        "/wallets/LICENSE.txt" => Some((
            wallets::LICENSE_TEXT.as_bytes(),
            "text/plain; charset=utf-8",
        )),
        "/fonts/manrope-latin.woff2" => Some((MANROPE_WOFF2, "font/woff2")),
        "/favicon.ico" => Some((FAVICON_ICO, "image/x-icon")),
        "/favicon.png" => Some((FAVICON_PNG, "image/png")),
        "/cabinet" => Some((MONITOR_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/cabinet/wallet" => Some((CABINET_WALLET_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/wallet.js" => Some((
            WALLET_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/wallet-vault.js" => Some((
            WALLET_VAULT_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/wallet-evm.js" => Some((
            WALLET_EVM_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/wallet-btc.js" => Some((
            WALLET_BTC_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/cabinet.js" | "/monitor.js" => Some((
            MONITOR_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/site.css" => Some((SITE_CSS.as_bytes(), "text/css; charset=utf-8")),
        "/site.js" => Some((SITE_JS.as_bytes(), "application/javascript; charset=utf-8")),
        "/rotor-worker.js" => Some((
            ROTOR_WORKER.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/rotor_wasm.wasm" => Some((ROTOR_WASM, "application/wasm")),
        _ => None,
    }
}

/// Permanent redirects to the canonical naming: `/monitor` -> `/cabinet`
/// and the old `/keys` hubs -> `/private-keys`. Key-range pages keep their
/// `/keys/<chain>/<start>-<end>` URLs and are not redirected.
fn redirect_target(path: &str) -> Option<String> {
    if path == "/monitor" {
        return Some("/cabinet".to_string());
    }
    if path == "/keys" {
        return Some("/private-keys".to_string());
    }
    if path == "/mnemonic-seeds/" {
        return Some("/mnemonic-seeds".to_string());
    }
    if let Some(slug) = path.strip_prefix("/keys/")
        && !slug.contains('/')
        && chain_by_slug(slug).is_some()
    {
        return Some(format!("/private-keys/{slug}"));
    }
    None
}

fn respond_redirect(request: Request, location: &str) {
    let response = Response::empty(StatusCode(301)).with_header(header("Location", location));
    let _ = request.respond(response);
}

/// Canonical origin for absolute SEO URLs. A trailing slash is trimmed so the
/// generated links never contain `//`.
fn public_url_from_env() -> String {
    let raw = std::env::var("ROTOR_PUBLIC_URL").unwrap_or_else(|_| DEFAULT_PUBLIC_URL.to_string());
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        DEFAULT_PUBLIC_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Canonical public origin from `ROTOR_PUBLIC_URL` (used for webhook
/// registration and absolute links).
pub fn public_url() -> String {
    public_url_from_env()
}

/// One server-rendered chain hub under `/keys/<slug>`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AddressKind {
    Bitcoin,
    Evm,
    Tron,
    Solana,
    Litecoin,
    Dogecoin,
    BitcoinCash,
    Xrp,
    Zcash,
    Sui,
    Ton,
}

struct AddressType {
    value: &'static str,
    label: &'static str,
    desc: &'static str,
    field: &'static str,
}

const BTC_TYPES: &[AddressType] = &[
    AddressType {
        value: "legacy",
        label: "Legacy",
        desc: "P2PKH · 1…",
        field: "btc_p2pkh",
    },
    AddressType {
        value: "segwit",
        label: "SegWit",
        desc: "P2WPKH · bc1q…",
        field: "btc_p2wpkh",
    },
    AddressType {
        value: "script",
        label: "Nested SegWit",
        desc: "P2SH · 3…",
        field: "btc_p2sh_p2wpkh",
    },
    AddressType {
        value: "taproot",
        label: "Taproot",
        desc: "P2TR · bc1p…",
        field: "btc_p2tr",
    },
];
const LTC_TYPES: &[AddressType] = &[
    AddressType {
        value: "legacy",
        label: "Legacy",
        desc: "P2PKH · L…",
        field: "ltc_p2pkh",
    },
    AddressType {
        value: "segwit",
        label: "SegWit",
        desc: "P2WPKH · ltc1q…",
        field: "ltc_p2wpkh",
    },
    AddressType {
        value: "script",
        label: "Nested SegWit",
        desc: "P2SH · M…",
        field: "ltc_p2sh_p2wpkh",
    },
];
const EVM_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Address",
    desc: "0x…",
    field: "evm",
}];
const TRON_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Address",
    desc: "T…",
    field: "tron",
}];
const SOL_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Address",
    desc: "base58",
    field: "solana",
}];
const DOGE_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Legacy",
    desc: "P2PKH · D…",
    field: "doge_p2pkh",
}];
const BCH_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Legacy",
    desc: "P2PKH · 1…",
    field: "bch_legacy",
}];
const XRP_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Classic",
    desc: "r…",
    field: "xrp_classic",
}];
const ZCASH_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Transparent",
    desc: "t1…",
    field: "zcash_p2pkh",
}];
const SUI_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Address",
    desc: "0x…",
    field: "sui",
}];
const TON_TYPES: &[AddressType] = &[AddressType {
    value: "legacy",
    label: "Wallet v4R2",
    desc: "EQ…",
    field: "ton",
}];

impl AddressKind {
    fn curve(self) -> u32 {
        match self {
            Self::Solana | Self::Sui | Self::Ton => 1,
            _ => 0,
        }
    }

    fn types(self) -> &'static [AddressType] {
        match self {
            Self::Bitcoin => BTC_TYPES,
            Self::Litecoin => LTC_TYPES,
            Self::Evm => EVM_TYPES,
            Self::Tron => TRON_TYPES,
            Self::Solana => SOL_TYPES,
            Self::Dogecoin => DOGE_TYPES,
            Self::BitcoinCash => BCH_TYPES,
            Self::Xrp => XRP_TYPES,
            Self::Zcash => ZCASH_TYPES,
            Self::Sui => SUI_TYPES,
            Self::Ton => TON_TYPES,
        }
    }

    fn type_by_value(self, value: &str) -> Option<&'static AddressType> {
        self.types().iter().find(|kind| kind.value == value)
    }
}

struct ChainHub {
    slug: &'static str,
    name: &'static str,
    symbol: &'static str,
    description: &'static str,
    intro: &'static str,
    /// Solana key pages derive on ed25519; the others default to secp256k1.
    curve_suffix: &'static str,
    kind: AddressKind,
    color: &'static str,
    icon: &'static str,
    explorer: &'static str,
}

const CHAINS: [ChainHub; 18] = [
    ChainHub {
        slug: "bitcoin",
        name: "Bitcoin",
        symbol: "BTC",
        description: "Legacy P2PKH, SegWit, Nested SegWit and Taproot addresses derived from one key.",
        intro: "Every private key maps to several Bitcoin addresses. Pick an address type, then open any key to derive it locally in your browser.",
        curve_suffix: "",
        kind: AddressKind::Bitcoin,
        color: "#f7931a",
        icon: "chain-bitcoin",
        explorer: "https://mempool.space/address/",
    },
    ChainHub {
        slug: "ethereum",
        name: "Ethereum",
        symbol: "ETH",
        description: "EIP-55 checksummed Ethereum addresses on the secp256k1 curve.",
        intro: "Ethereum addresses are the last 20 bytes of keccak256 of the public key. Every key page derives the checksummed address locally.",
        curve_suffix: "",
        kind: AddressKind::Evm,
        color: "#8a9cf5",
        icon: "chain-ethereum",
        explorer: "https://etherscan.io/address/",
    },
    ChainHub {
        slug: "bnb",
        name: "BNB Chain",
        symbol: "BNB",
        description: "BNB Smart Chain addresses shared with every EVM network.",
        intro: "BNB Chain uses the same secp256k1 key and EVM address encoding as Ethereum. Switch the network in your wallet; the address stays the same.",
        curve_suffix: "",
        kind: AddressKind::Evm,
        color: "#f3ba2f",
        icon: "chain-bnb",
        explorer: "https://bscscan.com/address/",
    },
    ChainHub {
        slug: "arbitrum",
        name: "Arbitrum",
        symbol: "ETH",
        description: "Arbitrum One addresses derived on secp256k1.",
        intro: "Arbitrum One is an EVM rollup: the private key derives the same 0x address as Ethereum, with fees paid on Arbitrum.",
        curve_suffix: "",
        kind: AddressKind::Evm,
        color: "#28a0f0",
        icon: "chain-arbitrum",
        explorer: "https://arbiscan.io/address/",
    },
    ChainHub {
        slug: "optimism",
        name: "Optimism",
        symbol: "ETH",
        description: "OP Mainnet addresses derived on secp256k1.",
        intro: "OP Mainnet is an EVM rollup. The key derives the same 0x address as Ethereum, and the address is controlled on the OP network.",
        curve_suffix: "",
        kind: AddressKind::Evm,
        color: "#ff0420",
        icon: "chain-optimism",
        explorer: "https://optimistic.etherscan.io/address/",
    },
    ChainHub {
        slug: "base",
        name: "Base",
        symbol: "ETH",
        description: "Base addresses derived on secp256k1.",
        intro: "Base is an EVM rollup by Coinbase. The same key gives the same 0x address as Ethereum; only the network changes.",
        curve_suffix: "",
        kind: AddressKind::Evm,
        color: "#0052ff",
        icon: "chain-base",
        explorer: "https://basescan.org/address/",
    },
    ChainHub {
        slug: "polygon",
        name: "Polygon",
        symbol: "POL",
        description: "Polygon PoS addresses derived on secp256k1.",
        intro: "Polygon PoS is EVM-compatible. One key derives the 0x address shown across Ethereum, Polygon and other EVM chains.",
        curve_suffix: "",
        kind: AddressKind::Evm,
        color: "#a06ee8",
        icon: "chain-polygon",
        explorer: "https://polygonscan.com/address/",
    },
    ChainHub {
        slug: "avalanche",
        name: "Avalanche",
        symbol: "AVAX",
        description: "Avalanche C-Chain addresses on secp256k1.",
        intro: "The Avalanche C-Chain is EVM-compatible. The key derives a 0x address; the X-Chain uses a different encoding and is out of scope.",
        curve_suffix: "",
        kind: AddressKind::Evm,
        color: "#e84142",
        icon: "chain-avalanche",
        explorer: "https://snowtrace.io/address/",
    },
    ChainHub {
        slug: "zksync",
        name: "zkSync Era",
        symbol: "ETH",
        description: "zkSync Era addresses derived on secp256k1.",
        intro: "zkSync Era is an EVM rollup. The same key controls the same 0x address, with zkSync-specific account abstraction available on top.",
        curve_suffix: "",
        kind: AddressKind::Evm,
        color: "#8c8dfc",
        icon: "chain-zksync",
        explorer: "https://explorer.zksync.io/address/",
    },
    ChainHub {
        slug: "solana",
        name: "Solana",
        symbol: "SOL",
        description: "ed25519 accounts encoded as base58 public keys.",
        intro: "Solana accounts use ed25519. Every key page on this hub switches the derivation to ed25519 and runs locally in your browser.",
        curve_suffix: "?curve=ed25519",
        kind: AddressKind::Solana,
        color: "#14f195",
        icon: "chain-solana",
        explorer: "https://solscan.io/account/",
    },
    ChainHub {
        slug: "tron",
        name: "TRON",
        symbol: "TRX",
        description: "Base58Check TRON addresses with the 0x41 version byte.",
        intro: "TRON addresses use secp256k1 and the same keccak hash as EVM, then a 0x41 prefix and Base58Check. Derivation runs in your browser.",
        curve_suffix: "",
        kind: AddressKind::Tron,
        color: "#ff4d4d",
        icon: "chain-tron",
        explorer: "https://tronscan.org/#/address/",
    },
    ChainHub {
        slug: "xrp",
        name: "XRP",
        symbol: "XRP",
        description: "Classic r-addresses with the Ripple Base58 alphabet.",
        intro: "XRP classic addresses use secp256k1, hash160 and the Ripple Base58 alphabet. Open any key to derive its r-address locally.",
        curve_suffix: "",
        kind: AddressKind::Xrp,
        color: "#7fa8d9",
        icon: "chain-xrp",
        explorer: "https://xrpscan.com/account/",
    },
    ChainHub {
        slug: "litecoin",
        name: "Litecoin",
        symbol: "LTC",
        description: "Legacy, Nested SegWit and native SegWit Litecoin addresses.",
        intro: "Litecoin uses secp256k1 with its own version bytes. Switch the address type to derive legacy, P2SH-SegWit and ltc1 SegWit forms.",
        curve_suffix: "",
        kind: AddressKind::Litecoin,
        color: "#b8c2d6",
        icon: "chain-litecoin",
        explorer: "https://blockchair.com/litecoin/address/",
    },
    ChainHub {
        slug: "bitcoin-cash",
        name: "Bitcoin Cash",
        symbol: "BCH",
        description: "Legacy P2PKH addresses and the BCH derivation path.",
        intro: "Bitcoin Cash shares the secp256k1 key format with Bitcoin. The legacy P2PKH address is derived locally in your browser.",
        curve_suffix: "",
        kind: AddressKind::BitcoinCash,
        color: "#8dc351",
        icon: "chain-bitcoin-cash",
        explorer: "https://blockchair.com/bitcoin-cash/address/",
    },
    ChainHub {
        slug: "dogecoin",
        name: "Dogecoin",
        symbol: "DOGE",
        description: "Legacy Dogecoin addresses with the 0x1e version byte.",
        intro: "Dogecoin uses secp256k1 and the 0x1e version byte. Open any key to see its Dogecoin address derived locally in your browser.",
        curve_suffix: "",
        kind: AddressKind::Dogecoin,
        color: "#c2a633",
        icon: "chain-dogecoin",
        explorer: "https://blockchair.com/dogecoin/address/",
    },
    ChainHub {
        slug: "zcash",
        name: "Zcash",
        symbol: "ZEC",
        description: "Transparent Zcash t-addresses with the two-byte 0x1cb8 prefix.",
        intro: "Zcash transparent addresses use secp256k1 and a two-byte version prefix. Shielded addresses are a separate protocol and are not derived here.",
        curve_suffix: "",
        kind: AddressKind::Zcash,
        color: "#ecb244",
        icon: "chain-zcash",
        explorer: "https://blockchair.com/zcash/address/",
    },
    ChainHub {
        slug: "sui",
        name: "Sui",
        symbol: "SUI",
        description: "Sui ed25519 accounts hashed with BLAKE2b-256.",
        intro: "Sui derives an account address as BLAKE2b-256 of the ed25519 scheme flag plus the public key. Open any key to derive the 0x address locally.",
        curve_suffix: "?curve=ed25519",
        kind: AddressKind::Sui,
        color: "#6fbcf0",
        icon: "chain-sui",
        explorer: "https://suiscan.xyz/mainnet/account/",
    },
    ChainHub {
        slug: "ton",
        name: "TON",
        symbol: "TON",
        description: "TON Wallet v4R2 addresses derived from the ed25519 public key.",
        intro: "A TON wallet address is the hash of the wallet contract StateInit. Rotor builds the standard v4R2 wallet locally from the ed25519 key; the contract is not deployed until it receives funds.",
        curve_suffix: "?curve=ed25519",
        kind: AddressKind::Ton,
        color: "#0098ea",
        icon: "chain-ton",
        explorer: "https://tonviewer.com/",
    },
];

fn chain_by_slug(slug: &str) -> Option<&'static ChainHub> {
    CHAINS.iter().find(|chain| chain.slug == slug)
}

/// Resolve a dynamic SEO route. `None` means the path is not part of this
/// surface; a returned 404 keeps lookup misses from falling back to the
/// landing page (which would soft-404 for crawlers).
fn seo_asset(base: &str, path: &str, query: &str) -> Option<(String, &'static str, u16)> {
    const HTML: &str = "text/html; charset=utf-8";
    if path == "/robots.txt" {
        return Some((render_robots(base), "text/plain; charset=utf-8", 200));
    }
    if path == "/sitemap.xml" {
        return Some((render_sitemap(base), "application/xml; charset=utf-8", 200));
    }
    if path == "/faq" {
        return Some((render_faq(base), HTML, 200));
    }
    if path == "/disclaimer" {
        return Some((render_disclaimer(base), HTML, 200));
    }
    if path == "/donate" {
        return Some((render_donate(base), HTML, 200));
    }
    if path == "/brainwallet" || path == "/brainwallet/" {
        return Some((render_brainwallet(base, BrainwalletFocus::All), HTML, 200));
    }
    if path == "/brainwallet/bitcoin" || path == "/brainwallet/bitcoin/" {
        return Some((
            render_brainwallet(base, BrainwalletFocus::Bitcoin),
            HTML,
            200,
        ));
    }
    if path == "/brainwallet/ethereum" || path == "/brainwallet/ethereum/" {
        return Some((
            render_brainwallet(base, BrainwalletFocus::Ethereum),
            HTML,
            200,
        ));
    }
    if path == "/brainwallet-generator" || path == "/brainwallet-generator/" {
        // Donor alias for the same calculator; canonical stays on /brainwallet.
        return Some((render_brainwallet(base, BrainwalletFocus::All), HTML, 200));
    }
    if path == "/keys" || path == "/private-keys" {
        return Some((render_keys_hub(base), HTML, 200));
    }
    if let Some(rest) = path.strip_prefix("/private-keys/") {
        let rest = rest.trim_end_matches('/');
        if rest.is_empty() {
            return Some((render_keys_hub(base), HTML, 200));
        }
        let mut parts = rest.split('/');
        let Some(slug) = parts.next() else {
            return Some((render_seo_not_found(), HTML, 404));
        };
        let page = parts.next();
        if parts.next().is_some() {
            return Some((render_seo_not_found(), HTML, 404));
        }
        let Some(chain) = chain_by_slug(slug) else {
            return Some((render_seo_not_found(), HTML, 404));
        };
        let address_type = query_param(query, "type").unwrap_or("legacy");
        return Some(match page {
            Some(raw) if parse_page_number(raw).is_some() => (
                render_browse_page(base, chain, raw, address_type),
                HTML,
                200,
            ),
            Some(_) => (render_seo_not_found(), HTML, 404),
            None => (
                render_browse_page(base, chain, "1", address_type),
                HTML,
                200,
            ),
        });
    }
    if path == "/bitcoin-puzzle" {
        return Some((render_puzzle_home(base), HTML, 200));
    }
    if let Some(rest) = path.strip_prefix("/bitcoin-puzzle/") {
        let rest = rest.trim_end_matches('/');
        if rest.is_empty() {
            return Some((render_puzzle_home(base), HTML, 200));
        }
        if rest == "unsolved" {
            return Some((render_puzzle_unsolved(base), HTML, 200));
        }
        let mut parts = rest.split('/');
        let Some(number) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
            return Some((render_seo_not_found(), HTML, 404));
        };
        let view = parts.next();
        if parts.next().is_some() || puzzles::puzzle(number).is_none() {
            return Some((render_seo_not_found(), HTML, 404));
        }
        return Some(match view {
            None | Some("detail") => (render_puzzle_page(base, number, false), HTML, 200),
            Some("random") => (render_puzzle_page(base, number, true), HTML, 200),
            Some(_) => (render_seo_not_found(), HTML, 404),
        });
    }
    if let Some(rest) = path.strip_prefix("/mnemonic-seeds/") {
        let rest = rest.trim_end_matches('/');
        if rest.is_empty() {
            return Some((MNEMONIC_SEEDS_PAGE.to_string(), HTML, 200));
        }
        let mut parts = rest.split('/');
        let Some(slug) = parts.next() else {
            return Some((render_seo_not_found(), HTML, 404));
        };
        let page = parts.next();
        if parts.next().is_some() {
            return Some((render_seo_not_found(), HTML, 404));
        }
        let Some(chain) = chain_by_slug(slug) else {
            return Some((render_seo_not_found(), HTML, 404));
        };
        return Some(match page {
            Some(raw) if parse_page_number(raw).is_some() => {
                (render_mnemonic_seeds_page(base, chain, raw), HTML, 200)
            }
            Some(_) => (render_seo_not_found(), HTML, 404),
            None => (render_mnemonic_seeds_page(base, chain, "1"), HTML, 200),
        });
    }
    if path == "/wallets" {
        return Some((wallets::render_page(base), HTML, 200));
    }
    if let Some(rest) = path.strip_prefix("/keys/") {
        let Some((slug, range_text)) = rest.split_once('/') else {
            // Bare `/keys/<chain>` is redirected to `/private-keys/<chain>`
            // before this point; keep direct lookups a hard 404.
            return Some((render_seo_not_found(), HTML, 404));
        };
        let Some(chain) = chain_by_slug(slug) else {
            return Some((render_seo_not_found(), HTML, 404));
        };
        return Some(match parse_key_range(range_text) {
            Some(range) => (render_range_page(base, chain, &range), HTML, 200),
            None => (render_seo_not_found(), HTML, 404),
        });
    }
    if let Some(entity) = path.strip_prefix("/key/")
        && let Some(page) = render_key_entity(base, entity)
    {
        return Some((page, HTML, 200));
    }
    if let Some(hex) = path.strip_prefix("/key/") {
        let curve = if query.split('&').any(|pair| pair == "curve=ed25519") {
            "ed25519"
        } else {
            "secp256k1"
        };
        return Some(match normalized_key_hex(hex, curve) {
            Some(key) => (render_key_page(base, &key, curve), HTML, 200),
            None => (render_seo_not_found(), HTML, 404),
        });
    }
    None
}

/// Exactly 64 hex digits, non-zero; secp256k1 keys must also be below the
/// curve order (the existing scalar parser enforces that). Returns lowercase.
fn normalized_key_hex(hex: &str, curve: &str) -> Option<String> {
    // A Bitcoin WIF is accepted in the /key/<value> path as well, matching the
    // donor-style key links. It is decoded to the 32-byte secp256k1 key here.
    if curve != "ed25519"
        && (51..=52).contains(&hex.len())
        && matches!(hex.as_bytes().first(), Some(b'5' | b'K' | b'L'))
    {
        let decoded = bs58::decode(hex).with_check(None).into_vec().ok()?;
        let key = match decoded.as_slice() {
            [0x80, rest @ ..] if rest.len() == 32 => rest.to_vec(),
            [0x80, rest @ .., 0x01] if rest.len() == 32 => rest.to_vec(),
            _ => return None,
        };
        let lower = key
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        return crate::scalar::Scalar::from_hex(&lower)
            .filter(|value| !value.is_zero())
            .map(|_| lower);
    }
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let lower = hex.to_ascii_lowercase();
    if curve == "ed25519" {
        if lower.bytes().all(|byte| byte == b'0') {
            return None;
        }
    } else if !crate::scalar::Scalar::from_hex(&lower).is_some_and(|value| !value.is_zero()) {
        return None;
    }
    Some(lower)
}

/// A parsed `/keys/<chain>/<start>-<end>` range: lowercase hex endpoints, an
/// inclusive key count (1..=64) and whether it is one of the curated 1..=64
/// ranges that hub pages link to (indexable).
struct KeyRange {
    start: String,
    end: String,
    start_bytes: [u8; 32],
    count: u32,
    curated: bool,
}

/// Exactly 64 hex digits as 32 big-endian bytes.
fn hex_to_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (slot, chunk) in out.iter_mut().zip(hex.as_bytes().as_chunks::<2>().0) {
        *slot = (hex_digit(chunk[0])? << 4) | hex_digit(chunk[1])?;
    }
    Some(out)
}

fn hex_from_32(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// True when the 256-bit value is at most 64 (it fits in the last byte).
fn value_at_most_64(bytes: &[u8; 32]) -> bool {
    bytes[..31].iter().all(|&byte| byte == 0) && bytes[31] <= 64
}

/// `end - start` as a 256-bit big-endian subtraction; returns `None` when
/// `end < start`.
fn sub_32(end: &[u8; 32], start: &[u8; 32]) -> Option<[u8; 32]> {
    if end < start {
        return None;
    }
    let mut out = [0u8; 32];
    let mut borrow = 0u16;
    for index in (0..32).rev() {
        let difference = end[index] as u16 + 256 - start[index] as u16 - borrow;
        out[index] = (difference & 0xff) as u8;
        borrow = if difference < 256 { 1 } else { 0 };
    }
    Some(out)
}

fn increment_32(bytes: &mut [u8; 32]) {
    for slot in bytes.iter_mut().rev() {
        let (next, carry) = slot.overflowing_add(1);
        *slot = next;
        if !carry {
            break;
        }
    }
}

/// Parse the `<start>-<end>` part of a key-range route. Case-insensitive hex,
/// inclusive range, `start <= end`, at most 64 keys; anything else is `None`.
fn parse_key_range(text: &str) -> Option<KeyRange> {
    let (start_hex, end_hex) = text.split_once('-')?;
    let start_bytes = hex_to_32(start_hex)?;
    let end_bytes = hex_to_32(end_hex)?;
    let span = sub_32(&end_bytes, &start_bytes)?;
    if span[..24].iter().any(|&byte| byte != 0) {
        return None;
    }
    let low = u64::from_be_bytes(span[24..32].try_into().ok()?);
    if low >= 64 {
        return None;
    }
    let curated = start_bytes.iter().any(|&byte| byte != 0) && value_at_most_64(&end_bytes);
    Some(KeyRange {
        start: start_hex.to_ascii_lowercase(),
        end: end_hex.to_ascii_lowercase(),
        start_bytes,
        count: (low + 1) as u32,
        curated,
    })
}

fn escape_attr(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn breadcrumb_nav(items: &[(&str, Option<&str>)]) -> String {
    let mut out = String::from("<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\">");
    for (index, (label, href)) in items.iter().enumerate() {
        if index > 0 {
            out.push_str(" / ");
        }
        match href {
            Some(href) => out.push_str(&format!(
                "<a href=\"{}\">{}</a>",
                escape_attr(href),
                escape_attr(label)
            )),
            None => out.push_str(&format!(
                "<span aria-current=\"page\">{}</span>",
                escape_attr(label)
            )),
        }
    }
    out.push_str("</nav>");
    out
}

fn site_header() -> String {
    format!(
        "<header class=\"site-nav\">\
         <a class=\"brand\" href=\"/\"><span class=\"brand-mark\">{key}</span><span class=\"brand-name\">Rotor<span>.</span></span></a>\
         <nav aria-label=\"Main\">\
         <a href=\"/\" data-nav=\"home\">{grid}<span>Home</span></a>\
         <a href=\"/private-keys\" data-nav=\"directory\">{key2}<span>Directory</span></a>\
         <a href=\"/seed\" data-nav=\"seeds\">{seed}<span>Seeds</span></a>\
         <a href=\"/bitcoin-puzzle\" data-nav=\"puzzle\">{puzzle}<span>Puzzle</span></a>\
         <a href=\"/vanity\" data-nav=\"vanity\">{vanity}<span>Vanity</span></a>\
         <a href=\"/tools\" data-nav=\"tools\">{tools}<span>Tools</span></a>\
         <a href=\"/docs\" data-nav=\"docs\">{book}<span>Docs</span></a>\
         </nav>\
         <div class=\"nav-tools\">\
         <a class=\"nav-pill nav-icon-pill\" href=\"/key\" data-nav=\"search\" aria-label=\"Search wallet\">{search}</a>\
         <a class=\"nav-pill nav-cabinet\" href=\"/cabinet\" data-nav=\"cabinet\">{wallet}<span>Cabinet</span></a>\
         </div></header>",
        key = ui_icon("ui-rotor", "icon"),
        grid = ui_icon("ui-grid", "icon"),
        key2 = ui_icon("ui-key", "icon"),
        seed = ui_icon("ui-key", "icon"),
        puzzle = ui_icon("ui-puzzle", "icon"),
        vanity = ui_icon("ui-tools", "icon"),
        tools = ui_icon("ui-tools", "icon"),
        book = ui_icon("ui-book", "icon"),
        search = ui_icon("ui-search", "icon"),
        wallet = ui_icon("ui-wallet", "icon"),
    )
}

/// Swap the template header (built before the IA change) for [`site_header`]
/// without touching the static site files.
fn replace_site_nav(html: String) -> String {
    const OPEN: &str = "<header class=\"site-nav\">";
    const CLOSE: &str = "</header>";
    let Some(start) = html.find(OPEN) else {
        return html;
    };
    let Some(close_rel) = html[start..].find(CLOSE) else {
        return html;
    };
    let end = start + close_rel + CLOSE.len();
    let mut out = String::with_capacity(html.len());
    out.push_str(&html[..start]);
    out.push_str(&site_header());
    out.push_str(&html[end..]);
    out
}

fn html_document(title: &str, head_extra: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n\
         <link rel=\"stylesheet\" href=\"/site.css?v=20261121e\">\n\
         <script src=\"/theme.js?v=20261121e\"></script>\n\
         {head_extra}</head>\n<body>\n{body}\n<script src=\"/search.js?v=20261121e\"></script>\n<script src=\"/site.js?v=20261121e\"></script>\n</body>\n</html>\n",
        escape_attr(title)
    )
}

fn json_ld(value: &serde_json::Value) -> String {
    format!("<script type=\"application/ld+json\">{value}</script>\n")
}

fn render_key_entity(base: &str, entity: &str) -> Option<String> {
    let (slug, title, heading, tagline, label, placeholder, help) = match entity {
        "hex" => (
            "hex",
            "Hex private key calculator",
            "Hex private key calculator",
            "Paste 64 hexadecimal characters and see the WIF, decimal value, public key and every derived address.",
            "Private key (hex)",
            "64 hex characters, optional 0x",
            "Accepts 64 hex characters with an optional 0x prefix. The key stays in memory only.",
        ),
        "wif" => (
            "wif",
            "WIF calculator — Wallet Import Format to hex and addresses",
            "WIF calculator",
            "Decode a Bitcoin Wallet Import Format key (5…, K… or L…) into hex, decimal, public key and addresses.",
            "WIF (Wallet Import Format)",
            "5…, K… or L… WIF",
            "Accepts a mainnet Bitcoin WIF. The compressed flag is preserved; the key never leaves this page.",
        ),
        "decimal" => (
            "decimal",
            "Decimal private key calculator",
            "Decimal private key calculator",
            "Paste a decimal integer below the secp256k1 order and see its hex, WIF, public key and addresses.",
            "Private key (decimal)",
            "decimal integer",
            "Accepts a decimal integer in 1..n-1. The key stays in memory only.",
        ),
        _ => return None,
    };
    let canonical = format!("{base}/key/{slug}");
    let mut page = KEY_PAGE.to_string();
    page = page.replace(
        "<title>Rotor Coordinator - private key explorer</title>",
        &format!("<title>{title} | Rotor</title>"),
    );
    page = page.replace(
        "<h1>Private-key explorer</h1>",
        &format!("<h1>{heading}</h1>"),
    );
    page = page.replace(
        "Every private key is a number. See what yours opens — all derivation happens in this browser.",
        tagline,
    );
    page = page.replace("64 hex, decimal, or BTC WIF", placeholder);
    page = page.replace(
        "<label class=\"key-input-label\">Private key",
        &format!("<label class=\"key-input-label\">{label}"),
    );
    page = page.replace(
        "Accepts 64 hex characters with an optional 0x prefix, a decimal integer, or a Bitcoin WIF. The key stays in memory only and is cleared when you leave the page.",
        help,
    );
    page = page.replace(
        "</head>",
        &format!(
            "<meta name=\"description\" content=\"{}\">\n\
             <link rel=\"canonical\" href=\"{}\">\n\
             </head>",
            escape_attr(tagline),
            escape_attr(&canonical)
        ),
    );
    page = page.replace("<body>", &format!("<body data-entity=\"{slug}\">"));
    Some(page)
}

fn render_key_page(base: &str, key: &str, curve: &str) -> String {
    let first = &key[..8];
    let last = &key[key.len() - 4..];
    let short = format!("{first}…{last}");
    let canonical = format!("{base}/key/{key}");
    let title = format!("Private key {short} — Bitcoin, EVM, Solana and TRON addresses | Rotor");
    let description = format!(
        "Derive Bitcoin, EVM and TRON addresses from private key {short} in your browser. Rotor shows public addresses only; the key is never sent to a server."
    );
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": title,
        "url": canonical,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires JavaScript and WebAssembly",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "description": description,
    });
    let ld_crumbs = json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": format!("{base}/") },
            { "@type": "ListItem", "position": 2, "name": "Chains", "item": format!("{base}/private-keys") },
            { "@type": "ListItem", "position": 3, "name": format!("Key {short}"), "item": canonical },
        ],
    });
    // Only the curated example keys 1..=64 are indexable; any other key page is
    // user-supplied and stays out of the index.
    let curated = hex_to_32(key).is_some_and(|bytes| {
        bytes[..31].iter().all(|&byte| byte == 0) && (1..=64).contains(&bytes[31])
    });
    let robots = if curated {
        "index,follow"
    } else {
        "noindex,follow"
    };
    let head = format!(
        "<meta name=\"description\" content=\"{}\">\n\
         <link rel=\"canonical\" href=\"{}\">\n\
         <meta name=\"robots\" content=\"{}\">\n\
         <meta property=\"og:type\" content=\"website\">\n\
         <meta property=\"og:title\" content=\"{}\">\n\
         <meta property=\"og:description\" content=\"{}\">\n\
         <meta property=\"og:url\" content=\"{}\">\n\
         {}{}",
        escape_attr(&description),
        escape_attr(&canonical),
        robots,
        escape_attr(&title),
        escape_attr(&description),
        escape_attr(&canonical),
        json_ld(&ld_app),
        json_ld(&ld_crumbs),
    );

    let crumb_label = format!("Key {short}");
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Chains", Some("/private-keys")),
        (&crumb_label, None),
    ]);
    let payload = format!(
        "<script>window.__ROTOR_KEY__=\"{key}\";window.__ROTOR_CURVE__=\"{curve}\";</script>\n"
    );

    let mut html = KEY_PAGE.replacen(
        "<title>Rotor Coordinator - private key explorer</title>",
        &format!("<title>{}</title>", escape_attr(&title)),
        1,
    );
    html = html.replacen("</head>", &format!("{head}</head>"), 1);
    html = html.replacen(
        "<main class=\"key-page\">",
        &format!("<main class=\"key-page\">{crumbs}"),
        1,
    );
    replace_site_nav(html.replacen(
        "<script src=\"/key.js",
        &format!("{payload}<script src=\"/key.js"),
        1,
    ))
}

fn render_range_page(base: &str, chain: &ChainHub, range: &KeyRange) -> String {
    let start_short = &range.start[..8];
    let end_short = &range.end[56..];
    let label = format!("0x{start_short}…–0x{end_short}…");
    let canonical = format!("{base}/keys/{}/{}-{}", chain.slug, range.start, range.end);
    let title = format!("{} keys {label} — {} keys | Rotor", chain.name, range.count);
    let description = format!(
        "{} private keys from 0x{start_short}… to 0x{end_short}… (inclusive), derived locally in your browser. Rotor shows public addresses only; the keys are never sent to a server.",
        chain.name
    );
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": title,
        "url": canonical,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires JavaScript and WebAssembly",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "description": description,
    });
    let ld_crumbs = json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": format!("{base}/") },
            { "@type": "ListItem", "position": 2, "name": "Chains", "item": format!("{base}/private-keys") },
            { "@type": "ListItem", "position": 3, "name": chain.name, "item": format!("{base}/private-keys/{}", chain.slug) },
            { "@type": "ListItem", "position": 4, "name": label, "item": canonical },
        ],
    });
    let mut entries = Vec::with_capacity(range.count as usize);
    let mut current = range.start_bytes;
    for position in 1..=range.count {
        entries.push(json!({
            "@type": "ListItem",
            "position": position,
            "url": format!("{base}/key/{}{}", hex_from_32(&current), chain.curve_suffix),
        }));
        increment_32(&mut current);
    }
    let ld_items = json!({
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": format!("{} keys in range {label}", chain.name),
        "numberOfItems": range.count,
        "itemListElement": entries,
    });
    // Curated ranges (1..=64) are linked from hubs and stay indexable; any other
    // range is user-supplied and only follows links.
    let robots = if range.curated {
        "index,follow"
    } else {
        "noindex,follow"
    };
    let head = format!(
        "<meta name=\"description\" content=\"{}\">\n\
         <link rel=\"canonical\" href=\"{}\">\n\
         <meta name=\"robots\" content=\"{}\">\n\
         <meta property=\"og:type\" content=\"website\">\n\
         <meta property=\"og:title\" content=\"{}\">\n\
         <meta property=\"og:description\" content=\"{}\">\n\
         <meta property=\"og:url\" content=\"{}\">\n\
         {}{}{}",
        escape_attr(&description),
        escape_attr(&canonical),
        robots,
        escape_attr(&title),
        escape_attr(&description),
        escape_attr(&canonical),
        json_ld(&ld_app),
        json_ld(&ld_crumbs),
        json_ld(&ld_items),
    );

    let chain_href = format!("/private-keys/{}", chain.slug);
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Chains", Some("/private-keys")),
        (chain.name, Some(&chain_href)),
        (&label, None),
    ]);
    let payload = format!(
        "<script>window.__ROTOR_RANGE__={{chain:\"{}\",start:\"{}\",end:\"{}\"}};</script>\n",
        chain.slug, range.start, range.end
    );

    let mut html = RANGE_PAGE.replacen(
        "<title>Rotor Coordinator - key range</title>",
        &format!("<title>{}</title>", escape_attr(&title)),
        1,
    );
    html = html.replacen("</head>", &format!("{head}</head>"), 1);
    html = html.replacen(
        "<nav class=\"breadcrumbs\" id=\"range-breadcrumbs\" aria-label=\"Breadcrumbs\"></nav>",
        &crumbs,
        1,
    );
    replace_site_nav(html.replacen(
        "<script src=\"/range.js",
        &format!("{payload}<script src=\"/range.js"),
        1,
    ))
}

fn render_keys_hub(base: &str) -> String {
    let canonical = format!("{base}/private-keys");
    let title = "Private keys directory — browse keys on 18 chains | Rotor";
    let description = "Browse private key pages for Bitcoin, Ethereum, BNB Chain, Arbitrum, Optimism, Base, Polygon, Avalanche, zkSync, Solana, TRON, XRP, Litecoin, Bitcoin Cash, Dogecoin, Zcash, Sui and TON. Addresses are derived locally in your browser.";
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": title,
        "url": canonical,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "description": description,
    });
    let ld_crumbs = json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": format!("{base}/") },
            { "@type": "ListItem", "position": 2, "name": "Chains", "item": canonical },
        ],
    });
    let entries: Vec<_> = CHAINS
        .iter()
        .enumerate()
        .map(|(index, chain)| {
            json!({
                "@type": "ListItem",
                "position": index + 1,
                "name": format!("{} private keys", chain.name),
                "url": format!("{base}/private-keys/{}", chain.slug),
            })
        })
        .collect();
    let ld_items = json!({
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": "Private key hubs",
        "numberOfItems": CHAINS.len(),
        "itemListElement": entries,
    });
    let head = hub_head(
        &canonical,
        title,
        description,
        &[ld_app, ld_crumbs, ld_items],
    );

    let mut cards = String::new();
    for chain in &CHAINS {
        let type_count = chain.kind.types().len();
        cards.push_str(&format!(
            "<a class=\"chain-card directory-card\" href=\"/private-keys/{}\" style=\"--chain:{}\" title=\"{}\">\
             <span class=\"chain-icon-wrap\">{}</span>\
             <span class=\"chain-name\">{}</span>\
             <span class=\"chain-meta\">{} · {} address {}</span>\
             </a>",
            chain.slug,
            chain.color,
            escape_attr(chain.description),
            chain_icon(chain, "chain-card-icon"),
            chain.name,
            chain.symbol,
            type_count,
            if type_count == 1 { "type" } else { "types" },
        ));
    }
    let body = format!(
        "{}{}<main class=\"directory-page\">\
         <section class=\"directory-hero\">\
           <h1>Private Keys Directory</h1>\
           <p>Select a blockchain to browse every possible private key, 60 at a time. Addresses are derived in your browser and checked against public chain data.</p>\
           <form class=\"directory-search\" data-key-search>\
             <span class=\"search-leading\">{search_icon}</span>\
             <input id=\"directory-search-input\" type=\"text\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"HEX, WIF or brainwallet\" aria-label=\"Search a private key, WIF or brainwallet\">\
             <button type=\"submit\" class=\"primary\">Search</button>\
           </form>\
           <p class=\"directory-hint\">HEX, WIF, byte arrays and brainwallet text are decoded in your browser. Nothing is uploaded.</p>\
         </section>\
         <div class=\"chain-grid directory-grid\">{cards}</div>\
         <aside class=\"edu-note\"><strong>Educational purpose.</strong> The probability of finding a used key at random is about 1 in 2<sup>160</sup>. These pages are a derivation reference, not a wallet and not a recovery service.</aside>\
         <section class=\"directory-links\">\
           <a href=\"/bitcoin-puzzle\">Bitcoin puzzle</a>\
           <a href=\"/brainwallet\">Brainwallet</a>\
           <a href=\"/key\">Key calculator</a>\
           <a href=\"/faq\">FAQ</a>\
           <a href=\"/disclaimer\">Disclaimer</a>\
           <a href=\"/donate\">Donate</a>\
         </section>\
         </main>",
        site_header(),
        "",
        search_icon = ui_icon("ui-search", "icon"),
    );
    html_document(title, &head, &body)
}

/// Absolute `BreadcrumbList` JSON-LD matching a visible trail. A `None` href
/// is a non-link intermediate crumb (for example "Tools") and omits `item`.
fn breadcrumb_ld(base: &str, items: &[(&str, Option<&str>)]) -> serde_json::Value {
    let entries: Vec<_> = items
        .iter()
        .enumerate()
        .map(|(index, (name, href))| {
            let mut entry = json!({
                "@type": "ListItem",
                "position": index + 1,
                "name": *name,
            });
            if let Some(href) = href {
                entry["item"] = json!(format!("{base}{href}"));
            }
            entry
        })
        .collect();
    json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": entries,
    })
}

const FAQ_TITLE: &str = "FAQ — how Rotor key tools and alerts work | Rotor";
const FAQ_DESCRIPTION: &str = "Answers about Rotor's browser key derivation, the /keys hubs, noindex pages, the address watchlist and Telegram alerts, and what the tools cannot do.";

/// Honest Q&A used both for the visible FAQ and its `FAQPage` JSON-LD.
const FAQ_QA: [(&str, &str); 9] = [
    (
        "What does this site do?",
        "Rotor explains how private keys map to public addresses on Bitcoin, Ethereum, TRON, Solana, Litecoin, Dogecoin, Bitcoin Cash and XRP. It derives addresses from a key you control in your browser and runs an authorized puzzle search engine and an address watchlist. It does not hold, sign for or move funds.",
    ),
    (
        "Is my key sent to a server?",
        "No. Derivation runs locally with WebAssembly in your browser. The page does not receive, log or transmit the key, and the site never asks for a seed phrase.",
    ),
    (
        "Do you ask for seed phrases?",
        "No. The web tools accept single private keys only, for educational use. There is no custody: Rotor cannot hold funds, sign transactions or sweep balances.",
    ),
    (
        "What do /keys and /key/<hex> show?",
        "The key hubs list 64 deterministic example keys (1 to 64). Each key page derives public addresses for the selected chain and curve. These pages show derivation, not balances, holdings or ownership; the server never places a key you enter into the page URL.",
    ),
    (
        "Why are some pages noindex?",
        "A key page or key range that contains user-supplied material is marked noindex so it is not published in search results. Only the curated example keys, hubs and informational pages are indexable.",
    ),
    (
        "How do alerts and the watchlist work?",
        "You add a public address you control to the cabinet. The coordinator polls public chain data providers for changes and can deliver Telegram alerts. Alerts are best-effort: provider delays, reorgs and outages mean a late or missed notification is possible.",
    ),
    (
        "What is impossible here?",
        "Deriving an address from a key does not prove that the address is observable, funded, used or known to anyone else. You cannot derive a private key from an address, and Rotor cannot know whether a key was used somewhere else.",
    ),
    (
        "Can I use this to find or recover someone else's keys?",
        "No. Use Rotor only for keys and addresses you own or are explicitly authorized to test, such as public puzzles and research. Deriving a key does not give lawful access to funds.",
    ),
    (
        "Is the brainwallet checker safe?",
        "No brainwallet is safe for real funds. The checker is educational: it shows why passphrase-derived keys are easy to guess. Use only test passphrases, never a phrase that protects funds.",
    ),
];

fn render_faq(base: &str) -> String {
    let canonical = format!("{base}/faq");
    let ld_faq = json!({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": FAQ_QA
            .iter()
            .map(|(question, answer)| json!({
                "@type": "Question",
                "name": *question,
                "acceptedAnswer": { "@type": "Answer", "text": *answer },
            }))
            .collect::<Vec<_>>(),
    });
    let ld_crumbs = breadcrumb_ld(base, &[("Home", Some("/")), ("FAQ", Some("/faq"))]);
    let head = hub_head(&canonical, FAQ_TITLE, FAQ_DESCRIPTION, &[ld_faq, ld_crumbs]);

    let mut qa = String::new();
    for (question, answer) in FAQ_QA {
        qa.push_str(&format!(
            "<div class=\"faq-item\"><h3>{}</h3><p>{}</p></div>",
            escape_attr(question),
            escape_attr(answer)
        ));
    }
    let mut hub_links = String::from("<li><a href=\"/keys\">All key hubs</a></li>");
    for chain in &CHAINS {
        hub_links.push_str(&format!(
            "<li><a href=\"/keys/{}\">{} private keys</a></li>",
            chain.slug, chain.name
        ));
    }
    let body = format!(
        "{}{}<main class=\"key-page\">{}<section class=\"hero\">\
         <h1>Frequently asked questions</h1>\
         <p>How Rotor derives addresses, what the key pages show, and what the tools cannot do.</p></section>\
         <section class=\"card\"><h2>Questions</h2>{qa}</section>\
         <section class=\"card\"><h2>Explore the key hubs</h2><ul>{hub_links}</ul></section>\
         <section class=\"card\"><h2>Site information</h2><ul>\
         <li><a href=\"/disclaimer\">Disclaimer and authorized use</a></li>\
         <li><a href=\"/brainwallet\">Brainwallet checker (educational)</a></li>\
         <li><a href=\"/docs\">Documentation</a></li>\
         <li><a href=\"/donate\">Donate</a></li></ul></section>\
         </main>",
        site_header(),
        "",
        breadcrumb_nav(&[("Home", Some("/")), ("FAQ", None)]),
    );
    html_document(FAQ_TITLE, &head, &body)
}

const DISCLAIMER_TITLE: &str = "Disclaimer — educational and authorized use | Rotor";
const DISCLAIMER_DESCRIPTION: &str = "Rotor is provided for education, research and authorized testing only. It is not a wallet, holds no funds, signs nothing, and cannot sweep balances.";

fn render_disclaimer(base: &str) -> String {
    let canonical = format!("{base}/disclaimer");
    let ld_crumbs = breadcrumb_ld(
        base,
        &[("Home", Some("/")), ("Disclaimer", Some("/disclaimer"))],
    );
    let head = hub_head(
        &canonical,
        DISCLAIMER_TITLE,
        DISCLAIMER_DESCRIPTION,
        &[ld_crumbs],
    );
    let body = format!(
        "{}{}<main class=\"key-page\">{}<section class=\"hero\">\
         <h1>Disclaimer</h1>\
         <p>Rotor is an educational and research tool. Read this page before using any key or address feature.</p></section>\
         <section class=\"card\"><h2>Educational and authorized use only</h2>\
         <p>The site explains how keys map to addresses and lets you test that mapping. Use it only with keys and addresses you own or are explicitly authorized to test, such as public puzzles and security research. Do not use it to access funds you do not control.</p></section>\
         <section class=\"card\"><h2>No custody, signing or sweeping</h2>\
         <p>Rotor is not a wallet. It does not hold funds, sign transactions, broadcast transfers or sweep balances, and it never asks for a seed phrase. Any signing or transaction feature is separate and gated; nothing on these pages moves value.</p></section>\
         <section class=\"card\"><h2>Key handling warning</h2>\
         <p>Treat any private key typed into a networked browser as potentially exposed. Use published test vectors or throwaway keys for learning, and keep keys that protect real funds offline or air-gapped. A passphrase-derived brainwallet is not safe for real funds.</p></section>\
         <section class=\"card\"><h2>Data providers and API caveats</h2>\
         <p>Balance and watchlist checks send public addresses to configured chain data providers. Those services can be delayed, incomplete or unavailable, and alerts are best-effort rather than a guarantee. Derived addresses alone do not prove ownership, funding or observability.</p></section>\
         <section class=\"card\"><h2>More information</h2><ul>\
         <li><a href=\"/faq\">Frequently asked questions</a></li>\
         <li><a href=\"/docs\">Documentation</a></li>\
         <li><a href=\"/keys\">Key hubs</a></li></ul></section>\
         </main>",
        site_header(),
        "",
        breadcrumb_nav(&[("Home", Some("/")), ("Disclaimer", None)]),
    );
    html_document(DISCLAIMER_TITLE, &head, &body)
}

const DONATE_TITLE: &str = "Donate — support Rotor development | Rotor";
const DONATE_DESCRIPTION: &str = "Maintainer donation addresses for Rotor: Bitcoin, USDT-TRC20 and EVM, plus a hosted payment link. Select an address and copy it in your browser.";

fn render_donate(base: &str) -> String {
    let canonical = format!("{base}/donate");
    let ld_crumbs = breadcrumb_ld(base, &[("Home", Some("/")), ("Donate", Some("/donate"))]);
    let head = hub_head(&canonical, DONATE_TITLE, DONATE_DESCRIPTION, &[ld_crumbs]);
    let body = format!(
        "{}{}<main class=\"key-page\">{}<section class=\"hero\">\
         <h1>Donate</h1>\
         <p>Support maintenance of Rotor. These are the maintainer's own addresses; select an address to copy it with your browser.</p></section>\
         <section class=\"card\"><h2>Addresses</h2><ul class=\"donate-addresses\">\
         <li><strong>Bitcoin (BTC)</strong><br><code class=\"mono\">bc1qgkqw02q70d0j00gylp3l5p8tyjd0c4lftrdsz8</code></li>\
         <li><strong>USDT (TRC-20)</strong><br><code class=\"mono\">TC2d5VsjAY6eAVLrbwhEJtqtHTzbaf926f</code></li>\
         <li><strong>EVM (Ethereum and compatible chains)</strong><br><code class=\"mono\">0xd451c8720545118a7e6566c54eb1bbbbc0f6a58a</code></li>\
         </ul></section>\
         <section class=\"card\"><h2>Payment link</h2>\
         <p><a href=\"https://pay.pxbt.app/u/0xd451c8720545118a7e6566c54eb1bbbbc0f6a58a\" rel=\"noopener noreferrer\">pay.pxbt.app payment page</a></p></section>\
         </main>",
        site_header(),
        "",
        breadcrumb_nav(&[("Home", Some("/")), ("Donate", None)]),
    );
    html_document(DONATE_TITLE, &head, &body)
}

const BRAINWALLET_TITLE: &str = "Brainwallet checker — SHA-256 passphrase to addresses | Rotor";
const BRAINWALLET_DESCRIPTION: &str = "Educational SHA-256 brainwallet checker: derive public addresses from a passphrase in your browser. Brainwallets are unsafe for real funds; test only with throwaway passphrases.";
const BRAINWALLET_BITCOIN_TITLE: &str =
    "Bitcoin brainwallet calculator — passphrase to BTC addresses | Rotor";
const BRAINWALLET_BITCOIN_DESCRIPTION: &str = "Turn a passphrase into its SHA-256 private key and Bitcoin legacy, SegWit and Taproot addresses in your browser. Brainwallets are unsafe for real funds; test only throwaway phrases.";
const BRAINWALLET_ETHEREUM_TITLE: &str =
    "Ethereum brainwallet calculator — passphrase to ETH address | Rotor";
const BRAINWALLET_ETHEREUM_DESCRIPTION: &str = "Turn a passphrase into its SHA-256 private key and Ethereum address in your browser. Brainwallets are unsafe for real funds; test only throwaway phrases.";

#[derive(Clone, Copy)]
enum BrainwalletFocus {
    All,
    Bitcoin,
    Ethereum,
}

impl BrainwalletFocus {
    fn path(self) -> &'static str {
        match self {
            Self::All => "/brainwallet",
            Self::Bitcoin => "/brainwallet/bitcoin",
            Self::Ethereum => "/brainwallet/ethereum",
        }
    }

    fn focus_key(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Bitcoin => "bitcoin",
            Self::Ethereum => "ethereum",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::All => BRAINWALLET_TITLE,
            Self::Bitcoin => BRAINWALLET_BITCOIN_TITLE,
            Self::Ethereum => BRAINWALLET_ETHEREUM_TITLE,
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::All => BRAINWALLET_DESCRIPTION,
            Self::Bitcoin => BRAINWALLET_BITCOIN_DESCRIPTION,
            Self::Ethereum => BRAINWALLET_ETHEREUM_DESCRIPTION,
        }
    }

    fn heading(self) -> &'static str {
        match self {
            Self::All => "Brainwallet checker",
            Self::Bitcoin => "Bitcoin brainwallet calculator",
            Self::Ethereum => "Ethereum brainwallet calculator",
        }
    }

    fn tagline(self) -> &'static str {
        match self {
            Self::All => {
                "A passphrase becomes a private key through one SHA-256 hash, and that key becomes a Bitcoin and Ethereum address. Everything below is derived in this browser."
            }
            Self::Bitcoin => {
                "A passphrase becomes a private key through one SHA-256 hash, and that key becomes a Bitcoin legacy, SegWit and Taproot address. Everything below is derived in this browser."
            }
            Self::Ethereum => {
                "A passphrase becomes a private key through one SHA-256 hash, and that key becomes an Ethereum address. Everything below is derived in this browser."
            }
        }
    }

    fn crumb(self) -> &'static str {
        match self {
            Self::All => "Brainwallet",
            Self::Bitcoin => "Bitcoin brainwallet",
            Self::Ethereum => "Ethereum brainwallet",
        }
    }
}

fn render_brainwallet(base: &str, focus: BrainwalletFocus) -> String {
    let canonical = format!("{base}{}", focus.path());
    let mut ld_entries = vec![
        ("Home", Some("/")),
        ("Tools", None),
        ("Brainwallet", Some("/brainwallet")),
    ];
    if !matches!(focus, BrainwalletFocus::All) {
        ld_entries.push((focus.crumb(), Some(focus.path())));
    }
    let ld_crumbs = breadcrumb_ld(base, &ld_entries);
    let head = hub_head(&canonical, focus.title(), focus.description(), &[ld_crumbs]);
    let crumbs = if matches!(focus, BrainwalletFocus::All) {
        "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\">\
         <a href=\"/\">Home</a> / <a href=\"/tools\">Tools</a> / \
         <span aria-current=\"page\">Brainwallet</span></nav>"
            .to_string()
    } else {
        format!(
            "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\">\
             <a href=\"/\">Home</a> / <a href=\"/tools\">Tools</a> / \
             <a href=\"/brainwallet\">Brainwallet</a> / \
             <span aria-current=\"page\">{}</span></nav>",
            focus.crumb()
        )
    };
    let body = format!(
        "{}{}<main class=\"key-page\">{crumbs}<section class=\"hero\">\
         <h1>{heading}</h1>\
         <p>{tagline}</p>\
         <p class=\"notice brainwallet-warning\" role=\"note\">Brainwallets are unsafe for real funds. \
         A phrase people can remember is guessable and such keys are swept quickly. Use only \
         throwaway phrases you are authorized to test; never a phrase that protects funds.</p></section>\
         <nav class=\"entity-links\" aria-label=\"Brainwallet pages\">\
         <span>Brainwallet pages</span>\
         <a href=\"/brainwallet\">All chains</a>\
         <a href=\"/brainwallet/bitcoin\">Bitcoin</a>\
         <a href=\"/brainwallet/ethereum\">Ethereum</a>\
         <a href=\"/key\">Key explorer</a>\
         <a href=\"/seed\">Seed phrase</a></nav>\
         <section class=\"card\"><h2>Passphrase</h2>\
         <form id=\"brainwallet-form\" class=\"key-form\" autocomplete=\"off\" data-brain-chain=\"{focus_key}\">\
         <label>Passphrase\
         <input id=\"brainwallet-input\" type=\"password\" class=\"mono\" autocomplete=\"new-password\" spellcheck=\"false\" autocapitalize=\"off\" data-lpignore=\"true\" data-1p-ignore=\"true\" aria-describedby=\"brainwallet-help\">\
         </label>\
         <div class=\"key-buttons\">\
         <button type=\"submit\" class=\"primary\" id=\"brainwallet-derive\">Derive</button>\
         <button type=\"button\" id=\"brainwallet-generate\" title=\"Fill a random test phrase; nothing is derived until you press Derive\">Generate random phrase</button>\
         <button type=\"button\" id=\"brainwallet-clear\" title=\"Clear the phrase and results\">Clear</button>\
         </div>\
         </form>\
         <p id=\"brainwallet-help\" class=\"muted key-help\">The key is SHA-256 of the UTF-8 phrase, exactly like the key search brainwallet path. The phrase stays in this browser, is never stored and is never put in the URL; results are cleared when you leave the page.</p>\
         <p id=\"brainwallet-status\" class=\"muted key-help\" role=\"status\" hidden></p>\
         <p id=\"brainwallet-error\" class=\"error brainwallet-error\" role=\"alert\" hidden></p></section>\
         <section class=\"card\"><h2>Results</h2>\
         <div id=\"brainwallet-results\" class=\"mono\" data-brain-chain=\"{focus_key}\">Enter a throwaway passphrase and press Derive.</div></section>\
         </main>\
         <script src=\"/brainwallet-engine.js?v=20261121e\" defer></script>\
         <script src=\"/brainwallet.js?v=20261121e\" defer></script>",
        site_header(),
        "",
        heading = focus.heading(),
        tagline = focus.tagline(),
        focus_key = focus.focus_key(),
    );
    html_document(focus.title(), &head, &body)
}

fn chain_icon(chain: &ChainHub, class: &str) -> String {
    format!(
        "<svg class=\"{class}\" aria-hidden=\"true\"><use href=\"/icons.svg#{}\"/></svg>",
        chain.icon
    )
}

fn ui_icon(name: &str, class: &str) -> String {
    format!("<svg class=\"{class}\" aria-hidden=\"true\"><use href=\"/icons.svg#{name}\"/></svg>")
}

/// secp256k1 group order as a decimal string.
const SECP_ORDER_DEC: &str =
    "115792089237316195423570985008687907852837564279074904382605163141518161494337";
/// 2^256 - 1: the ed25519 key page space (every 32-byte seed is valid).
const ED25519_SPACE_DEC: &str =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";

fn chain_key_space(chain: &ChainHub) -> BigUint {
    let decimal = if chain.kind.curve() == 1 {
        ED25519_SPACE_DEC
    } else {
        SECP_ORDER_DEC
    };
    BigUint::parse_bytes(decimal.as_bytes(), 10).expect("curve order constant")
}

fn chain_total_pages(chain: &ChainHub) -> BigUint {
    let last_key = chain_key_space(chain) - BigUint::from(1u8);
    (last_key + BigUint::from(59u32)) / BigUint::from(60u32)
}

fn parse_page_number(raw: &str) -> Option<BigUint> {
    let text = raw.trim();
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let digits = text.trim_start_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    if digits.len() > 80 {
        return None;
    }
    BigUint::parse_bytes(digits.as_bytes(), 10)
}

fn format_page_count(value: &BigUint) -> String {
    let text = value.to_string();
    if text.len() <= 6 {
        return text;
    }
    match value.to_f64() {
        Some(number) => format!("{number:.2E}").replace('E', "E+"),
        None => text,
    }
}

fn page_percent(page: &BigUint, total: &BigUint) -> String {
    let percent = match (page.to_f64(), total.to_f64()) {
        (Some(page), Some(total)) if total > 0.0 => (page / total * 100.0).clamp(0.0, 100.0),
        _ => 0.0,
    };
    format!("{percent:.4}%")
}

fn browse_page_href(chain: &ChainHub, page: &BigUint, address_type: &str) -> String {
    let base = if page <= &BigUint::from(1u8) {
        format!("/private-keys/{}", chain.slug)
    } else {
        format!("/private-keys/{}/{}", chain.slug, page)
    };
    if address_type == "legacy" {
        base
    } else {
        format!("{base}?type={address_type}")
    }
}

fn random_page(chain: &ChainHub) -> BigUint {
    let total = chain_total_pages(chain);
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        return BigUint::from(1u8);
    }
    BigUint::from_bytes_be(&bytes) % total + BigUint::from(1u8)
}

fn render_browse_page(base: &str, chain: &ChainHub, requested: &str, address_type: &str) -> String {
    let total = chain_total_pages(chain);
    let mut page = parse_page_number(requested).unwrap_or_else(|| BigUint::from(1u8));
    if page < BigUint::from(1u8) {
        page = BigUint::from(1u8);
    }
    if page > total {
        page = total.clone();
    }
    let active_type = chain
        .kind
        .type_by_value(address_type)
        .unwrap_or(&chain.kind.types()[0]);
    let canonical = format!("{base}/private-keys/{}", chain.slug);
    let self_url = format!("{base}{}", browse_page_href(chain, &page, "legacy"));
    let page_text = page.to_string();
    let total_text = format_page_count(&total);
    let percent = page_percent(&page, &total);
    let title = if page == BigUint::from(1u8) {
        format!(
            "{} private keys — browse addresses and balances | Rotor",
            chain.name
        )
    } else {
        format!(
            "{} private keys — page {} of {} | Rotor",
            chain.name,
            format_page_count(&page),
            total_text
        )
    };
    let description = format!(
        "Browse {} private keys 60 at a time, derive {} addresses locally in your browser and check their on-chain balances. Page {} of {}.",
        chain.name,
        chain.name,
        format_page_count(&page),
        total_text
    );
    let robots = if page == BigUint::from(1u8) {
        "index,follow"
    } else {
        "noindex,follow"
    };
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": format!("{} private keys", chain.name),
        "url": self_url,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "description": description,
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    });
    let ld_crumbs = json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": format!("{base}/") },
            { "@type": "ListItem", "position": 2, "name": "Private Keys", "item": format!("{base}/private-keys") },
            { "@type": "ListItem", "position": 3, "name": chain.name, "item": canonical },
        ],
    });
    let curated_start = format!("{:064x}", 1u8);
    let curated_end = format!("{:064x}", 64u8);
    let curated_url = format!("{base}/keys/{}/{curated_start}-{curated_end}", chain.slug);
    let ld_range = json!({
        "@context": "https://schema.org",
        "@type": "WebPage",
        "relatedLink": curated_url,
    });
    let head = format!(
        "<meta name=\"description\" content=\"{}\">\n\
         <link rel=\"canonical\" href=\"{}\">\n\
         <meta name=\"robots\" content=\"{robots}\">\n\
         <meta property=\"og:type\" content=\"website\">\n\
         <meta property=\"og:title\" content=\"{}\">\n\
         <meta property=\"og:description\" content=\"{}\">\n\
         <meta property=\"og:url\" content=\"{}\">\n\
         {}{}{}",
        escape_attr(&description),
        escape_attr(&self_url),
        escape_attr(&title),
        escape_attr(&description),
        escape_attr(&self_url),
        json_ld(&ld_app),
        json_ld(&ld_crumbs),
        json_ld(&ld_range),
    );

    let mut tabs = String::new();
    for other in &CHAINS {
        let active = if other.slug == chain.slug {
            " active"
        } else {
            ""
        };
        tabs.push_str(&format!(
            "<a class=\"chain-tab{active}\" href=\"/private-keys/{}\" style=\"--chain:{}\">{}<span>{}</span></a>",
            other.slug,
            other.color,
            chain_icon(other, "chain-tab-icon"),
            other.name,
        ));
    }

    let start = (&page - BigUint::from(1u8)) * BigUint::from(60u32) + BigUint::from(1u8);
    let max_key = chain_key_space(chain) - BigUint::from(1u8);
    let mut rows = String::new();
    for offset in 0u32..60u32 {
        let value = &start + BigUint::from(offset);
        if value > max_key {
            break;
        }
        let hex = format!("{value:064x}");
        let curve_suffix = chain.curve_suffix;
        rows.push_str(&format!(
            "<div class=\"key-row\" data-key=\"{hex}\">\
             <div class=\"col-key\">\
             <a class=\"private-key mono\" href=\"/key/{hex}{curve_suffix}\" title=\"{hex}\">{hex}</a>\
             <button type=\"button\" class=\"icon-btn copy-btn\" data-copy=\"{hex}\" aria-label=\"Copy private key\">{copy}</button>\
             <button type=\"button\" class=\"icon-btn details-btn\" aria-expanded=\"false\" aria-label=\"Show key details\">{chevron}</button>\
             </div>\
             <div class=\"col-address\"><span class=\"cell-skeleton\">Calculating…</span></div>\
             <div class=\"col-balance\"><span class=\"cell-skeleton\">—</span></div>\
             <div class=\"key-details\" hidden></div>\
             </div>",
            copy = ui_icon("ui-copy", "icon"),
            chevron = ui_icon("ui-chevron", "icon"),
        ));
    }

    let mut type_cards = String::new();
    if chain.kind.types().len() > 1 {
        for kind in chain.kind.types() {
            let active = if kind.value == active_type.value {
                " active"
            } else {
                ""
            };
            type_cards.push_str(&format!(
                "<button type=\"button\" class=\"address-type-card{active}\" data-type=\"{}\">\
                 <span class=\"type-name\">{}</span><span class=\"type-desc\">{}</span></button>",
                kind.value, kind.label, kind.desc
            ));
        }
    }
    let type_selector = if type_cards.is_empty() {
        String::new()
    } else {
        format!(
            "<section class=\"address-type-panel\" aria-label=\"Address type\">\
             <div class=\"panel-label\">{} Address type</div>\
             <div class=\"address-type-cards\">{type_cards}</div></section>",
            ui_icon("ui-wallet", "icon")
        )
    };

    let mut search_options = String::new();
    for kind in chain.kind.types() {
        search_options.push_str(&format!(
            "<option value=\"{}\"{}>{}</option>",
            kind.value,
            if kind.value == active_type.value {
                " selected"
            } else {
                ""
            },
            kind.label
        ));
    }
    let search_select = if chain.kind.types().len() > 1 {
        format!(
            "<select id=\"browse-search-type\" aria-label=\"Address type\">{search_options}</select>"
        )
    } else {
        String::new()
    };

    let page_one = BigUint::from(1u8);
    let prev = if page > page_one {
        &page - BigUint::from(1u8)
    } else {
        page_one.clone()
    };
    let next = if page < total {
        &page + BigUint::from(1u8)
    } else {
        page.clone()
    };
    let first_disabled = if page == page_one { " disabled" } else { "" };
    let prev_disabled = first_disabled;
    let next_disabled = if page >= total { " disabled" } else { "" };
    let last_disabled = next_disabled;
    let random = random_page(chain);
    let curve_data = chain.kind.curve();

    let body = format!(
        "{}{}<main class=\"browse-page\" style=\"--chain:{}\" data-chain=\"{}\" data-symbol=\"{}\" data-explorer=\"{}\" data-type=\"{}\" data-field=\"{}\" data-curve=\"{}\" data-pages=\"{}\" data-page=\"{}\">\
         <nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\"><a href=\"/\">Home</a> <span>/</span> <a href=\"/private-keys\">Private Keys</a> <span>/</span> <span aria-current=\"page\">{}</span></nav>\
         <section class=\"browse-hero\">\
           <div class=\"browse-hero-title\">{}<h1>{} private keys</h1></div>\
           <p>{}</p>\
         </section>\
         <div class=\"chain-tabs\" role=\"navigation\" aria-label=\"Chains\">{tabs}</div>\
         <section class=\"page-info\">\
           <div class=\"page-info-text\">{}<span>{} keys page <strong>#{}</strong> out of <strong>#{}</strong></span><span class=\"page-percent\">{}</span></div>\
           <div class=\"progress-track\" role=\"progressbar\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"{}\"><span style=\"width:{}\"></span></div>\
         </section>\
         <section class=\"browse-controls\">\
           <div class=\"pager\">\
             <a class=\"pager-btn{first_disabled}\" href=\"{}\" aria-disabled=\"{}\">{} First</a>\
             <a class=\"pager-btn{prev_disabled}\" href=\"{}\" aria-disabled=\"{}\">{} Previous</a>\
             <a class=\"pager-btn random\" href=\"{}\">{} Random</a>\
             <a class=\"pager-btn{next_disabled}\" href=\"{}\" aria-disabled=\"{}\">Next {}</a>\
             <a class=\"pager-btn{last_disabled}\" href=\"{}\" aria-disabled=\"{}\">Last {}</a>\
           </div>\
           <form class=\"page-jump\" id=\"browse-jump\">\
             <label for=\"browse-page-input\">Page</label>\
             <input id=\"browse-page-input\" inputmode=\"numeric\" autocomplete=\"off\" value=\"{}\">\
             <button type=\"submit\" class=\"primary\">Jump {}</button>\
           </form>\
         </section>\
         <section class=\"search-panel\">\
           <form id=\"browse-search\" class=\"browse-search\">\
             <div class=\"search-leading\">{}</div>\
             <input id=\"browse-search-input\" type=\"text\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"HEX, WIF (5/K/L), or brainwallet\" aria-label=\"Search a private key, WIF or brainwallet\">\
             {search_select}\
             <button type=\"submit\" class=\"primary\">{} Search</button>\
           </form>\
           <p class=\"search-hint\">Supports 64-char HEX, a Bitcoin WIF, a 32/64-number byte array, or any text as a brainwallet. Derivation runs in your browser.</p>\
         </section>\
         <section class=\"balance-summary\" aria-label=\"Balance summary\">\
           <div class=\"stat-card\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\" id=\"total-balance\">—</span></div>\
           <div class=\"stat-card\"><span class=\"stat-label\">Received</span><span class=\"stat-value\" id=\"total-received\">—</span></div>\
           <div class=\"stat-card\"><span class=\"stat-label\">Transactions</span><span class=\"stat-value\" id=\"total-tx\">—</span></div>\
           <p class=\"balance-note\" id=\"balance-note\">Balances are checked in your browser for the addresses on this page.</p>\
         </section>\
         {type_selector}\
         <section class=\"keys-panel\">\
           <div class=\"keys-header\"><div class=\"col-key\">{} Private key</div><div class=\"col-address\">{} Address</div><div class=\"col-balance\">{} Balance</div></div>\
           <div id=\"keys-container\">{rows}</div>\
         </section>\
         <p class=\"browse-range-link\"><a href=\"/keys/{}/{curated_start}-{curated_end}\">Open the curated 1–64 key range</a></p>\n         <p class=\"browse-footnote\">These are deterministic example keys, not a wallet. Nothing is signed or swept. Balance checks send the derived public addresses to a public chain data provider; the private key never leaves this page. Only search keys and funds you are authorized to use.</p>\
         </main>\n         <script src=\"/browse.js?v=20261121e\"></script>",
        site_header(),
        "",
        chain.color,
        chain.slug,
        chain.symbol,
        chain.explorer,
        active_type.value,
        active_type.field,
        curve_data,
        total,
        page_text,
        chain.name,
        chain_icon(chain, "browse-hero-icon"),
        chain.name,
        escape_attr(chain.intro),
        chain_icon(chain, "page-info-icon"),
        chain.name,
        page_text,
        total_text,
        percent,
        percent,
        percent,
        browse_page_href(chain, &page_one, active_type.value),
        if first_disabled.is_empty() {
            "false"
        } else {
            "true"
        },
        ui_icon("ui-first", "icon"),
        browse_page_href(chain, &prev, active_type.value),
        if prev_disabled.is_empty() {
            "false"
        } else {
            "true"
        },
        ui_icon("ui-prev", "icon"),
        if active_type.value == "legacy" {
            format!("/private-keys/{}/{}", chain.slug, random)
        } else {
            format!(
                "/private-keys/{}/{}?type={}",
                chain.slug, random, active_type.value
            )
        },
        ui_icon("ui-random", "icon"),
        browse_page_href(chain, &next, active_type.value),
        if next_disabled.is_empty() {
            "false"
        } else {
            "true"
        },
        ui_icon("ui-next", "icon"),
        browse_page_href(chain, &total, active_type.value),
        if last_disabled.is_empty() {
            "false"
        } else {
            "true"
        },
        ui_icon("ui-last", "icon"),
        page_text,
        ui_icon("ui-arrow-right", "icon"),
        chain_icon(chain, "search-chain-icon"),
        ui_icon("ui-search", "icon"),
        ui_icon("ui-key", "icon"),
        ui_icon("ui-wallet", "icon"),
        chain_icon(chain, "keys-header-icon"),
        chain.slug,
    );
    html_document(&title, &head, &body)
}

fn puzzle_badge(solved: bool) -> String {
    if solved {
        "<span class=\"puzzle-badge solved\">Solved</span>".to_string()
    } else {
        "<span class=\"puzzle-badge\">Unsolved</span>".to_string()
    }
}

fn puzzle_picker(number: u32, tab: &str) -> String {
    let mut options = String::new();
    for item in puzzles::all() {
        let selected = if item.number == number {
            " selected"
        } else {
            ""
        };
        options.push_str(&format!(
            "<option value=\"{}\"{}>#{}</option>",
            item.number, selected, item.number
        ));
    }
    let prev = if number > 1 {
        format!(
            "<a class=\"puzzle-step\" rel=\"prev\" href=\"/bitcoin-puzzle/{}/{}\">&larr; #{}</a>",
            number - 1,
            escape_attr(tab),
            number - 1
        )
    } else {
        "<span class=\"puzzle-step disabled\">&larr; Prev</span>".to_string()
    };
    let next = if number < puzzles::PUZZLE_COUNT {
        format!(
            "<a class=\"puzzle-step\" rel=\"next\" href=\"/bitcoin-puzzle/{}/{}\">#{} &rarr;</a>",
            number + 1,
            escape_attr(tab),
            number + 1
        )
    } else {
        "<span class=\"puzzle-step disabled\">Next &rarr;</span>".to_string()
    };
    format!(
        "<div class=\"puzzle-picker\">\
         <label class=\"puzzle-picker-label\" for=\"puzzle-select\">Puzzle</label>\
         <select id=\"puzzle-select\" data-puzzle-picker data-puzzle-tab=\"{}\">{}</select>\
         {}<span class=\"puzzle-step-current\">#{}</span>{}\
         </div>",
        escape_attr(tab),
        options,
        prev,
        number,
        next
    )
}

fn puzzle_tabs(number: u32, active: &str) -> String {
    let entries = [
        (
            "detail",
            "Detail",
            format!("/bitcoin-puzzle/{number}/detail"),
        ),
        (
            "random",
            "Random Keys",
            format!("/bitcoin-puzzle/{number}/random"),
        ),
        (
            "unsolved",
            "Unsolved",
            "/bitcoin-puzzle/unsolved".to_string(),
        ),
        ("team", "Team", "/bitcoin-puzzle#team".to_string()),
    ];
    let mut out = String::from("<nav class=\"puzzle-tabs\" aria-label=\"Puzzle views\">");
    for (key, label, href) in entries {
        let class = if key == active {
            "puzzle-tab active"
        } else {
            "puzzle-tab"
        };
        let current = if key == active {
            " aria-current=\"page\""
        } else {
            ""
        };
        out.push_str(&format!(
            "<a class=\"{}\" href=\"{}\"{}>{}</a>",
            class,
            escape_attr(&href),
            current,
            label
        ));
    }
    out.push_str("</nav>");
    out
}

fn puzzle_unsolved_grid() -> String {
    let mut out = String::from("<div class=\"puzzle-grid\">");
    for item in puzzles::all().filter(|item| !item.solved) {
        out.push_str(&format!(
            "<a class=\"puzzle-chip\" href=\"/bitcoin-puzzle/{0}/random\">\
             <span class=\"puzzle-chip-number\">#{0}</span>\
             <code class=\"puzzle-chip-target\">{1}</code>\
             <span class=\"puzzle-chip-meta\">{0}-bit range · unsolved</span></a>",
            item.number,
            escape_attr(item.target)
        ));
    }
    out.push_str("</div>");
    out
}

/// Default `<title>` in the embedded mnemonic seed shell. Chain pages swap it
/// for a chain-specific title; the directory keeps it.
const MNEMONIC_SEEDS_DEFAULT_TITLE: &str =
    "Mnemonic seeds directory — browse BIP39 phrases by chain | Rotor";
const MNEMONIC_SEEDS_DEFAULT_DESCRIPTION: &str = "Browse deterministic BIP39 mnemonic seeds chain by chain: 60 phrases per page, 12/18/24 words, BIP32 paths, Bitcoin address types and balance checks. Everything is derived in your browser.";
const MNEMONIC_SEEDS_DEFAULT_CANONICAL: &str = "https://rotor.pxbt.app/mnemonic-seeds";
const MNEMONIC_SEEDS_DEFAULT_MAIN: &str = "<main class=\"browse-page mnemonic-seeds-page\" data-chain=\"\" data-symbol=\"\" data-explorer=\"\" data-curve=\"0\" data-page=\"1\" style=\"--chain:#f7931a\">";
const MNEMONIC_SEEDS_DEFAULT_INTRO: &str = "<span data-chain-intro>Browse deterministic English BIP39 phrases across the entropy space, 60 seeds per page, and derive the matching addresses locally.</span>";

/// One `/mnemonic-seeds/<chain>[/<page>]` page. The shell is static; the
/// chain, page and SEO head are filled in here.
fn render_mnemonic_seeds_page(base: &str, chain: &ChainHub, requested: &str) -> String {
    let mut page = parse_page_number(requested).unwrap_or_else(|| BigUint::from(1u8));
    if page < BigUint::from(1u8) {
        page = BigUint::from(1u8);
    }
    let page_text = page.to_string();
    let self_url = if page == BigUint::from(1u8) {
        format!("{base}/mnemonic-seeds/{}", chain.slug)
    } else {
        format!("{base}/mnemonic-seeds/{}/{}", chain.slug, page_text)
    };
    let title = if page == BigUint::from(1u8) {
        format!(
            "{} mnemonic seeds — 60 BIP39 phrases per page | Rotor",
            chain.name
        )
    } else {
        format!("{} mnemonic seeds — page {} | Rotor", chain.name, page_text)
    };
    let description = format!(
        "Browse deterministic {} mnemonic seeds, 60 per page. Choose 12, 18 or 24 words, a BIP32 path and an address type, then derive addresses and balances in your browser. Page {}.",
        chain.name, page_text
    );
    let intro = format!(
        "Enumerate deterministic {} mnemonic seeds from the entropy space, 60 per page, and derive the matching addresses locally. Choose the word count, BIP32 path and address type; balance checks are optional.",
        chain.name
    );
    let robots = if page == BigUint::from(1u8) {
        "index,follow"
    } else {
        "noindex,follow"
    };
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": format!("{} mnemonic seeds", chain.name),
        "url": self_url,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires JavaScript and WebAssembly",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "description": description,
    });
    let chain_path = format!("/mnemonic-seeds/{}", chain.slug);
    let chain_name = chain.name;
    let ld_crumbs = breadcrumb_ld(
        base,
        &[
            ("Home", Some("/")),
            ("Mnemonic seeds", Some("/mnemonic-seeds")),
            (chain_name, Some(chain_path.as_str())),
        ],
    );
    let head = format!(
        "<meta name=\"robots\" content=\"{robots}\">\n\
         <meta property=\"og:type\" content=\"website\">\n\
         <meta property=\"og:title\" content=\"{}\">\n\
         <meta property=\"og:description\" content=\"{}\">\n\
         <meta property=\"og:url\" content=\"{}\">\n\
         {}{}",
        escape_attr(&title),
        escape_attr(&description),
        escape_attr(&self_url),
        json_ld(&ld_app),
        json_ld(&ld_crumbs),
    );

    let mut html = MNEMONIC_SEEDS_PAGE.to_string();
    html = html.replacen(
        &format!("<title>{MNEMONIC_SEEDS_DEFAULT_TITLE}</title>"),
        &format!("<title>{}</title>", escape_attr(&title)),
        1,
    );
    html = html.replacen(
        &format!("<meta name=\"description\" content=\"{MNEMONIC_SEEDS_DEFAULT_DESCRIPTION}\">"),
        &format!(
            "<meta name=\"description\" content=\"{}\">",
            escape_attr(&description)
        ),
        1,
    );
    html = html.replacen(
        &format!("<link rel=\"canonical\" href=\"{MNEMONIC_SEEDS_DEFAULT_CANONICAL}\">"),
        &format!(
            "<link rel=\"canonical\" href=\"{}\">",
            escape_attr(&self_url)
        ),
        1,
    );
    html = html.replacen("</head>", &format!("{head}</head>"), 1);
    html = html.replacen(
        "<body class=\"mnemonic-directory-mode\">",
        "<body class=\"mnemonic-chain-mode\">",
        1,
    );
    html = html.replacen(
        MNEMONIC_SEEDS_DEFAULT_MAIN,
        &format!(
            "<main class=\"browse-page mnemonic-seeds-page\" data-chain=\"{}\" data-symbol=\"{}\" data-explorer=\"{}\" data-curve=\"{}\" data-page=\"{}\" style=\"--chain:{}\">",
            escape_attr(chain.slug),
            escape_attr(chain.symbol),
            escape_attr(chain.explorer),
            chain.kind.curve(),
            page_text,
            escape_attr(chain.color),
        ),
        1,
    );
    html = html.replace(
        "<span data-chain-name>Directory</span>",
        &format!("<span data-chain-name>{}</span>", escape_attr(chain.name)),
    );
    html = html.replace(
        "<span data-chain-name>Chain</span>",
        &format!("<span data-chain-name>{}</span>", escape_attr(chain.name)),
    );
    html = html.replace(
        "<span data-chain-title>Mnemonic seeds</span>",
        &format!(
            "<span data-chain-title>{} mnemonic seeds</span>",
            escape_attr(chain.name)
        ),
    );
    html = html.replace(
        MNEMONIC_SEEDS_DEFAULT_INTRO,
        &format!("<span data-chain-intro>{}</span>", escape_attr(&intro)),
    );
    html
}

fn render_puzzle_home(base: &str) -> String {
    let canonical = format!("{base}/bitcoin-puzzle");
    let title = "Bitcoin puzzle browser — client-side key search | Rotor";
    let description = "Browse all 160 public Bitcoin puzzles with target address, key range, balance and split presets. Scan a puzzle range locally in your browser with WebAssembly; the pooled team mode stays separate.";
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": title,
        "url": canonical,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires JavaScript and WebAssembly",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "description": description,
    });
    let ld_crumbs = json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": format!("{base}/") },
            { "@type": "ListItem", "position": 2, "name": "Bitcoin Puzzle", "item": canonical },
        ],
    });
    let head = hub_head(&canonical, title, description, &[ld_app, ld_crumbs]);
    let crumbs = breadcrumb_nav(&[("Home", Some("/")), ("Bitcoin Puzzle", None)]);
    let solved = puzzles::all().filter(|item| item.solved).count();
    let unsolved = puzzles::PUZZLE_COUNT as usize - solved;
    let body = format!(
        "{}{crumbs}<main class=\"key-page\">\
         <section class=\"hero\"><h1>Bitcoin Puzzle</h1>\
         <p>Pick any public puzzle from #1 to #160 and scan its key range in your browser. Random and sequential modes run locally with WebAssembly; no private key or scan result leaves the page.</p>\
         <div class=\"actions\"><a class=\"button primary\" href=\"/bitcoin-puzzle/71/random\">Random Keys · Puzzle #71</a><a class=\"button\" href=\"#team\">Pooled team mode</a></div></section>\
         <section class=\"card\"><h2>Puzzle selector</h2>{picker}\
         <p class=\"puzzle-note\">Puzzle n covers the inclusive range 2^(n-1) to 2^n-1. The embedded target list contains {known} solved and {unsolved} unsolved puzzles, sourced from the public puzzle dataset (privatekeyfinder.io, crawled 2026-11-19).</p>\
         {tabs}</section>\
         <section class=\"card\" id=\"unsolved\"><h2>Unsolved puzzles</h2>\
         <p class=\"puzzle-note\">Every puzzle below is still unsolved according to the public dataset. Open one to inspect its range or start a local random scan.</p>{grid}</section>\
         <section class=\"card\" id=\"team\"><h2>Team mode — pooled chunk leasing</h2>\
         <p>Team mode is Rotor's coordinator pool: a job is split into fixed-size chunks, each contributor leases one chunk and scans it on their own hardware. A worker receives only its slice of the range, and an expired lease returns the chunk to the pool. This is separate from the local puzzle browser above; the two never mix in one run.</p>\
         <h3>Live public jobs</h3>\
         <div data-puzzle-summary></div>\
         <div data-puzzle-jobs></div>\
         <noscript><p>Enable JavaScript to load live job statistics, or read the JSON at <a href=\"/api/v1/jobs/public\">/api/v1/jobs/public</a>.</p></noscript>\
         <p class=\"puzzle-actions\"><a class=\"button\" href=\"/run\">Run a worker</a> <a class=\"button\" href=\"/cabinet\">Open the cabinet</a> <a class=\"button\" href=\"/docs\">Read the docs</a></p></section>\
         </main>\
         <script src=\"/puzzle-browser.js\" defer></script>\
         <script src=\"/puzzle.js\" defer></script>",
        site_header(),
        picker = puzzle_picker(71, "random"),
        known = solved,
        unsolved = unsolved,
        tabs = puzzle_tabs(71, "home"),
        grid = puzzle_unsolved_grid()
    );
    html_document(title, &head, &body)
}

fn render_puzzle_unsolved(base: &str) -> String {
    let canonical = format!("{base}/bitcoin-puzzle/unsolved");
    let title = "Unsolved Bitcoin puzzles — local browser scan | Rotor";
    let description = "The unsolved subset of the 160 public Bitcoin puzzles, with target addresses and key ranges. Open any puzzle to scan its range locally in the browser.";
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": title,
        "url": canonical,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires JavaScript and WebAssembly",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "description": description,
    });
    let ld_crumbs = json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": format!("{base}/") },
            { "@type": "ListItem", "position": 2, "name": "Bitcoin Puzzle", "item": format!("{base}/bitcoin-puzzle") },
            { "@type": "ListItem", "position": 3, "name": "Unsolved" },
        ],
    });
    let head = hub_head(&canonical, title, description, &[ld_app, ld_crumbs]);
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Bitcoin Puzzle", Some("/bitcoin-puzzle")),
        ("Unsolved", None),
    ]);
    let unsolved = puzzles::all().filter(|item| !item.solved).count();
    let body = format!(
        "{}{crumbs}<main class=\"key-page\">\
         <section class=\"hero\"><h1>Unsolved Bitcoin puzzles</h1>\
         <p>There are {unsolved} unsolved puzzles in the public #1–#160 set. Each card links to a local browser scan for that puzzle's key range.</p></section>\
         <section class=\"card\">{picker}{tabs}\
         <p class=\"puzzle-note\">Ranges follow 2^(n-1) to 2^n-1. A puzzle leaves this list when its target address is spent; the embedded status comes from the public dataset (privatekeyfinder.io, crawled 2026-11-19).</p>{grid}</section>\
         </main>\
         <script src=\"/puzzle-browser.js\" defer></script>",
        site_header(),
        picker = puzzle_picker(71, "random"),
        tabs = puzzle_tabs(71, "unsolved"),
        grid = puzzle_unsolved_grid()
    );
    html_document(title, &head, &body)
}

fn render_puzzle_page(base: &str, number: u32, random: bool) -> String {
    let item = puzzles::puzzle(number).expect("route validated the puzzle number");
    let (start_hex, end_hex) =
        puzzles::range_hex(number).expect("route validated the puzzle number");
    let view = if random { "random" } else { "detail" };
    let view_label = if random { "Random Keys" } else { "Detail" };
    let canonical = format!("{base}/bitcoin-puzzle/{number}/{view}");
    let title = if random {
        format!("Bitcoin Puzzle #{number} — Random Keys | Rotor")
    } else {
        format!("Bitcoin Puzzle #{number} — Detail | Rotor")
    };
    let description = if random {
        format!(
            "Scan the key range of public Bitcoin puzzle #{number} locally in your browser. Target {}, random or sequential WASM workers, no key upload.",
            item.target
        )
    } else {
        format!(
            "Puzzle #{number} detail: target {}, inclusive key range, balance and explorer links. The search runs locally in the browser.",
            item.target
        )
    };
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": title,
        "url": canonical,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires JavaScript and WebAssembly",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "description": description,
    });
    let ld_crumbs = json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": format!("{base}/") },
            { "@type": "ListItem", "position": 2, "name": "Bitcoin Puzzle", "item": format!("{base}/bitcoin-puzzle") },
            { "@type": "ListItem", "position": 3, "name": format!("Puzzle #{number}"), "item": format!("{base}/bitcoin-puzzle/{number}/detail") },
            { "@type": "ListItem", "position": 4, "name": view_label },
        ],
    });
    let head = hub_head(&canonical, &title, &description, &[ld_app, ld_crumbs]);

    let puzzle_label = format!("Puzzle #{number}");
    let detail_href = format!("/bitcoin-puzzle/{number}/detail");
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Bitcoin Puzzle", Some("/bitcoin-puzzle")),
        (puzzle_label.as_str(), Some(detail_href.as_str())),
        (view_label, None),
    ]);

    let status = puzzle_badge(item.solved);
    let status_sentence = if item.solved {
        format!(
            "The public dataset lists puzzle #{number} as solved. The target address has been spent."
        )
    } else {
        format!(
            "Puzzle #{number} is unsolved. The target below is the only match; everything else in the range is noise."
        )
    };
    let solved_pct = if item.solved { 100 } else { 0 };
    let status_progress = if item.solved {
        "Solved: the target address is spent. Global search progress is not published, so this bar shows the solved / unsolved status only."
    } else {
        "Unsolved: the target address still holds the prize. Global search progress is not published; Random Keys shows the progress of your own local run."
    };

    let detail = format!(
        "<section class=\"card\" data-puzzle-target=\"{target}\"><h2>Puzzle detail</h2>\
         <div class=\"puzzle-facts\">\
         <div class=\"puzzle-fact\"><span class=\"puzzle-fact-label\">Target address</span><code class=\"puzzle-fact-value\">{target}</code></div>\
         <div class=\"puzzle-fact\"><span class=\"puzzle-fact-label\">Balance</span><strong class=\"puzzle-fact-value\" data-puzzle-balance>—</strong><span class=\"puzzle-fact-note\" data-puzzle-balance-state>loading via mempool.space</span></div>\
         <div class=\"puzzle-fact\"><span class=\"puzzle-fact-label\">Range start</span><code class=\"puzzle-fact-value mono\">{start_hex}</code></div>\
         <div class=\"puzzle-fact\"><span class=\"puzzle-fact-label\">Range end</span><code class=\"puzzle-fact-value mono\">{end_hex}</code></div>\
         <div class=\"puzzle-fact\"><span class=\"puzzle-fact-label\">Range size</span><strong class=\"puzzle-fact-value\">2^{bits} keys</strong></div>\
         <div class=\"puzzle-fact\"><span class=\"puzzle-fact-label\">Status</span><span class=\"puzzle-fact-value\">{status}</span></div>\
         </div>\
         <div class=\"puzzle-progress\"><div class=\"progress\" role=\"img\" aria-label=\"Puzzle solved status\"><span class=\"bar\" style=\"width:{solved_pct}%\"></span></div>\
         <p class=\"puzzle-progress-text\">{status_progress}</p></div>\
         <p class=\"puzzle-actions\"><a class=\"button primary\" href=\"/bitcoin-puzzle/{number}/random\">Open Random Keys</a>\
         <a class=\"button\" href=\"https://www.blockchain.com/btc/address/{target}\" target=\"_blank\" rel=\"noopener noreferrer\">Blockchain</a>\
         <a class=\"button\" href=\"https://mempool.space/address/{target}\" target=\"_blank\" rel=\"noopener noreferrer\">Mempool</a>\
         <button type=\"button\" data-puzzle-check>Check</button></p>\
         <p class=\"puzzle-note\">The balance line is read from mempool.space for this public puzzle address. The page never sends a private key or scan result.</p></section>\
         <section class=\"card\"><h2>How this range works</h2>\
         <p class=\"puzzle-note\">Puzzle n spans every private key from 2^(n-1) to 2^n-1, so puzzle #{number} covers {bits} bits. A valid match is the single key whose public key hashes to the target address; every other key in the range is discarded.</p>\
         <p class=\"puzzle-note\">Splits only narrow the search window. They do not change the target, the range formula, or the difficulty per tested key.</p></section>",
        target = escape_attr(item.target),
        start_hex = start_hex,
        end_hex = end_hex,
        bits = number - 1,
        status = status,
        solved_pct = solved_pct,
        status_progress = status_progress,
        number = number
    );

    let presets = "<div class=\"puzzle-presets\" role=\"group\" aria-label=\"Range presets\">\
         <button type=\"button\" class=\"active\" data-range-preset=\"full\">Full</button>\
         <button type=\"button\" data-range-preset=\"first\">1st Half</button>\
         <button type=\"button\" data-range-preset=\"second\">2nd Half</button>\
         <button type=\"button\" data-range-preset=\"q1\">Q1</button>\
         <button type=\"button\" data-range-preset=\"q2\">Q2</button>\
         <button type=\"button\" data-range-preset=\"q3\">Q3</button>\
         <button type=\"button\" data-range-preset=\"q4\">Q4</button>\
         </div>";
    let worker = format!(
        "<section class=\"card puzzle-app\" data-puzzle-app data-puzzle-number=\"{number}\" data-puzzle-target=\"{target}\" data-puzzle-start=\"{start_hex}\" data-puzzle-end=\"{end_hex}\" data-puzzle-solved=\"{solved}\">\
         <h2>Random keys — browser scan</h2>\
         <p class=\"puzzle-balance-line\">Target balance <strong data-puzzle-balance>—</strong> <span class=\"puzzle-fact-note\" data-puzzle-balance-state>loading via mempool.space</span></p>\
         <p class=\"puzzle-note\">The scan uses the Rotor WebAssembly core in local Web Workers. Keys are generated, tested and discarded inside this tab; the optional balance check only reads this public target address.</p>\
         <div class=\"puzzle-controls\">\
         <label>Mode <select data-puzzle-mode><option value=\"random\" selected>Solo Random</option><option value=\"seq\">Solo Seq</option><option value=\"team\">Team</option></select></label>\
         <label>Workers <input type=\"number\" min=\"1\" max=\"8\" step=\"1\" value=\"1\" inputmode=\"numeric\" data-puzzle-workers></label>\
         </div>\
         {presets}\
         <div class=\"puzzle-range\">\
         <label>Range start <input class=\"mono\" data-puzzle-start-input value=\"{start_hex}\" spellcheck=\"false\" autocomplete=\"off\" aria-label=\"Range start in hex\"></label>\
         <label>Range end <input class=\"mono\" data-puzzle-end-input value=\"{end_hex}\" spellcheck=\"false\" autocomplete=\"off\" aria-label=\"Range end in hex\"></label>\
         </div>\
         <div class=\"puzzle-actions\">\
         <button type=\"button\" class=\"primary\" data-puzzle-start-btn>Start</button>\
         <button type=\"button\" data-puzzle-stop-btn disabled>Stop</button>\
         <button type=\"button\" data-puzzle-reset-btn>Reset</button>\
         <button type=\"button\" data-puzzle-check>Check</button>\
         </div>\
         <p class=\"puzzle-state\" data-puzzle-state role=\"status\" aria-live=\"polite\">Ready. Press Start or Space.</p>\
         <div class=\"puzzle-team-note\" data-puzzle-team-note hidden>Team mode is the coordinator pool, not this local scan. <a href=\"/bitcoin-puzzle#team\">Open the pooled job board</a> or <a href=\"/run\">run a lease worker</a>. Local and leased work never mix.</div>\
         <div class=\"stat-grid puzzle-counters\">\
         <div class=\"stat\"><span class=\"stat-label\">Generated</span><span class=\"stat-value small\" data-puzzle-generated>0</span></div>\
         <div class=\"stat\"><span class=\"stat-label\">Speed /s</span><span class=\"stat-value small\" data-puzzle-speed>0</span></div>\
         <div class=\"stat\"><span class=\"stat-label\">Workers</span><span class=\"stat-value small\" data-puzzle-worker-count>0</span></div>\
         <div class=\"stat\"><span class=\"stat-label\">WASM</span><span class=\"stat-value small\" data-puzzle-wasm>loading</span></div>\
         <div class=\"stat\"><span class=\"stat-label\">Match</span><span class=\"stat-value small\" data-puzzle-match-count>0</span></div>\
         <div class=\"stat\"><span class=\"stat-label\">ETA</span><span class=\"stat-value small\" data-puzzle-eta>—</span></div>\
         <div class=\"stat\"><span class=\"stat-label\">Network /s</span><span class=\"stat-value small\" data-puzzle-network title=\"Local-only scan; nothing is uploaded.\">0 · local</span></div>\
         </div>\
         <div class=\"puzzle-progress\"><div class=\"progress\" role=\"progressbar\" aria-label=\"Local scan progress\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"0\" data-puzzle-progress-bar><span class=\"bar\" data-puzzle-progress style=\"width:0%\"></span></div>\
         <p class=\"puzzle-progress-text\" data-puzzle-progress-text>No keys scanned yet.</p></div>\
         <div class=\"puzzle-match\" data-puzzle-match hidden>\
         <h3>MATCH FOUND</h3>\
         <p class=\"puzzle-match-target\">Target <code>{target}</code></p>\
         <div class=\"puzzle-match-key\"><span>Private key</span><code data-puzzle-match-key></code><button type=\"button\" data-puzzle-copy>Copy</button></div>\
         <p class=\"puzzle-note\">The key stayed in this browser. Verify it against the target before using it anywhere.</p>\
         </div></section>",
        number = number,
        target = escape_attr(item.target),
        start_hex = start_hex,
        end_hex = end_hex,
        solved = item.solved,
        presets = presets
    );

    let content = if random { worker } else { detail };
    let body = format!(
        "{}{crumbs}<main class=\"key-page\">\
         <section class=\"card puzzle-head\">\
         <div class=\"puzzle-head-row\"><div><h1>Bitcoin Puzzle #{number}</h1>\
         <p class=\"puzzle-note\">{status_sentence}</p></div>{status}</div>\
         {picker}{tabs}</section>\
         {content}\
         </main>\
         <script src=\"/puzzle-browser.js\" defer></script>",
        site_header(),
        number = number,
        status_sentence = status_sentence,
        status = status,
        picker = puzzle_picker(number, view),
        tabs = puzzle_tabs(number, view),
        content = content
    );
    html_document(&title, &head, &body)
}

fn hub_head(
    canonical: &str,
    title: &str,
    description: &str,
    scripts: &[serde_json::Value],
) -> String {
    let mut head = format!(
        "<meta name=\"description\" content=\"{}\">\n\
         <link rel=\"canonical\" href=\"{}\">\n\
         <meta name=\"robots\" content=\"index,follow\">\n\
         <meta property=\"og:type\" content=\"website\">\n\
         <meta property=\"og:title\" content=\"{}\">\n\
         <meta property=\"og:description\" content=\"{}\">\n\
         <meta property=\"og:url\" content=\"{}\">\n",
        escape_attr(description),
        escape_attr(canonical),
        escape_attr(title),
        escape_attr(description),
        escape_attr(canonical),
    );
    for script in scripts {
        head.push_str(&json_ld(script));
    }
    head
}

fn render_robots(base: &str) -> String {
    format!(
        "User-agent: *\n\
         Disallow: /api/\n\
         Disallow: /cabinet\n\
         Allow: /cabinet/wallet\n\
         Disallow: /monitor\n\
         Disallow: /dashboard\n\
         \n\
         Sitemap: {base}/sitemap.xml\n"
    )
}

fn render_sitemap(base: &str) -> String {
    let mut urls = String::from("  <url><loc>");
    urls.push_str(&escape_attr(base));
    urls.push_str("/</loc></url>\n");
    urls.push_str(&format!(
        "  <url><loc>{}/private-keys</loc></url>\n",
        escape_attr(base)
    ));
    for chain in &CHAINS {
        urls.push_str(&format!(
            "  <url><loc>{}/private-keys/{}</loc></url>\n",
            escape_attr(base),
            chain.slug
        ));
    }
    urls.push_str(&format!(
        "  <url><loc>{}/mnemonic-seeds</loc></url>\n",
        escape_attr(base)
    ));
    for chain in &CHAINS {
        urls.push_str(&format!(
            "  <url><loc>{}/mnemonic-seeds/{}</loc></url>\n",
            escape_attr(base),
            chain.slug
        ));
    }
    urls.push_str(&format!(
        "  <url><loc>{}/bitcoin-puzzle</loc></url>
",
        escape_attr(base)
    ));
    for puzzle_path in [
        "/bitcoin-puzzle/unsolved",
        "/bitcoin-puzzle/71/detail",
        "/bitcoin-puzzle/71/random",
    ] {
        urls.push_str(&format!(
            "  <url><loc>{}{puzzle_path}</loc></url>
",
            escape_attr(base)
        ));
    }
    for page in [
        "/faq",
        "/disclaimer",
        "/donate",
        "/brainwallet",
        "/brainwallet/bitcoin",
        "/brainwallet/ethereum",
        "/seed",
        "/mnemonic-converter",
        "/vanity",
        "/milk-sad",
        "/tools",
        "/hex-dec-bin",
        "/public-key",
        "/pubkey-add",
        "/reconstruction",
        "/keystore-parser",
        "/wallets",
        "/cabinet/wallet",
        "/key/wif",
        "/key/hex",
        "/key/decimal",
    ] {
        urls.push_str(&format!(
            "  <url><loc>{}{page}</loc></url>
",
            escape_attr(base)
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n\
         {urls}</urlset>\n"
    )
}

fn render_seo_not_found() -> String {
    html_document(
        "Not found | Rotor",
        "<meta name=\"robots\" content=\"noindex,nofollow\">\n",
        "<header class=\"site-nav\"><a class=\"brand\" href=\"/\">Rotor <span>Coordinator</span></a></header>\
         <main class=\"key-page\"><section class=\"hero\"><h1>Page not found</h1>\
         <p>This key or chain hub does not exist.</p>\
         <p><a href=\"/keys\">Browse the key hubs</a> or go back to the <a href=\"/\">landing page</a>.</p>\
         </section></main>",
    )
}

/// Body and status for an unknown non-API GET. A soft landing fallback would
/// answer 200 and look like an endless site to crawlers.
fn unknown_html_page() -> (String, &'static str, u16) {
    (render_seo_not_found(), "text/html; charset=utf-8", 404)
}

/// Public projection of one job. Deliberately explicit: no client ids, no
/// leases, no found key, and targets only for single-address jobs (those are
/// public puzzle targets). Multi-target jobs expose only the target count.
fn public_job_json(job: &state::JobView) -> serde_json::Value {
    let single_target = job.targets.is_empty();
    let target_count = if single_target {
        usize::from(job.target.is_some())
    } else {
        job.targets.len()
    };
    json!({
        "id": job.id.clone(),
        "mode": job.mode.clone(),
        "coin": job.coin.clone(),
        "comp_mode": job.comp_mode.clone(),
        "target": if single_target { job.target.clone() } else { None },
        "target_count": target_count,
        "start": job.start.clone(),
        "end": job.end.clone(),
        "chunks_total": job.chunks_total,
        "chunks_done": job.chunks_done,
        "chunks_leased": job.chunks_leased,
        "scanned": job.scanned,
        "done": job.done,
        "found": job.found,
    })
}

/// `GET /api/v1/jobs/public`: open and finished jobs without authentication.
/// Rate-limited per client IP with the existing token bucket.
fn public_jobs(app: &App, request: Request) {
    let ip = client_ip(&request, app.trust_proxy);
    if !app.rate.allow(&format!("public-jobs:{ip}")) {
        return respond_rate_limited(request);
    }
    let jobs = app.lock().list_jobs();
    let public: Vec<_> = jobs.iter().map(public_job_json).collect();
    respond_json(request, 200, &json!({ "jobs": public }));
}

/// `GET /api/v1/workers/public`: worker stats and live leases without
/// authentication. Rate-limited per client IP with the existing token bucket.
fn public_workers(app: &App, request: Request) {
    let ip = client_ip(&request, app.trust_proxy);
    if !app.rate.allow(&format!("public-workers:{ip}")) {
        return respond_rate_limited(request);
    }
    let workers = app.lock().public_workers(state::now_secs());
    respond_json(request, 200, &json!({ "workers": workers }));
}

fn create_job(app: &App, mut request: Request) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let new_job: state::NewJob = match serde_json::from_str(&body) {
        Ok(new_job) => new_job,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
    let result = app.lock().create_job(new_job);
    match result {
        Ok(view) => respond_json(request, 201, &view),
        Err(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

#[derive(Deserialize)]
struct NameRequest {
    #[serde(default)]
    name: String,
}

/// Admin: create a client account and return its token once.
fn create_client(app: &App, mut request: Request) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let name: NameRequest = match serde_json::from_str(&body) {
        Ok(name) => name,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
    let now = state::now_secs();
    match app.lock().create_client(&name.name, now) {
        Ok(client) => respond_json(
            request,
            201,
            &json!({ "id": client.id, "name": client.name, "token": client.token }),
        ),
        Err(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

/// Public self-service registration when `--open-registration` is set.
fn register(app: &App, mut request: Request) {
    if !app.open_registration {
        return respond_json(request, 403, &json!({ "error": "registration is closed" }));
    }
    let ip = client_ip(&request, app.trust_proxy);
    let now = state::now_secs();
    if !app.register.allow(&ip, now) {
        return respond_json(request, 429, &json!({ "error": "rate limit exceeded" }));
    }
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let name: NameRequest = match serde_json::from_str(&body) {
        Ok(name) => name,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
    match app.lock().create_client(&name.name, now) {
        Ok(client) => respond_json(
            request,
            201,
            &json!({ "id": client.id, "token": client.token }),
        ),
        Err(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

/// Admin: disable a client (its token stops working, leases are released).
fn disable_client(app: &App, request: Request, path: &str) {
    let Some(id) = path
        .strip_prefix("/api/v1/clients/")
        .and_then(|rest| rest.strip_suffix("/disable"))
    else {
        return respond_json(request, 404, &json!({ "error": "not found" }));
    };
    if id.is_empty() || id.contains('/') {
        return respond_json(request, 404, &json!({ "error": "not found" }));
    }
    match app.lock().disable_client(id) {
        Ok(()) => respond_json(request, 200, &json!({ "ok": true })),
        Err(message) if message == ERR_CLIENT_NOT_FOUND => {
            respond_json(request, 404, &json!({ "error": message }))
        }
        Err(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

/// Cabinet snapshot for the authenticated client token.
fn me(app: &App, request: Request, role: &Identity) {
    let Identity::Client(id) = role else {
        return respond_json(
            request,
            400,
            &json!({ "error": "a client token is required" }),
        );
    };
    let view = app.lock().me(id, state::now_secs());
    match view {
        Some(view) => respond_json(request, 200, &view),
        None => respond_json(request, 404, &json!({ "error": ERR_CLIENT_NOT_FOUND })),
    }
}

fn lease(app: &App, mut request: Request, role: &Identity) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let mut lease_request: state::LeaseRequest = match serde_json::from_str(&body) {
        Ok(lease_request) => lease_request,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
    // With client tokens the server owns the identity: a body `client_id` is
    // ignored (it can only claim the token's own id).
    if let Identity::Client(id) = role {
        lease_request.client_id = id.clone();
    }
    let now = state::now_secs();
    let result = app.lock().lease(lease_request, now);
    match result {
        Ok(Some(view)) => respond_json(request, 200, &view),
        Ok(None) => respond_empty(request, 204),
        Err(message) if message == ERR_JOB_NOT_FOUND => {
            respond_json(request, 404, &json!({ "error": message }))
        }
        Err(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

#[derive(Deserialize)]
struct HeartbeatRequest {
    #[serde(default)]
    client_id: Option<String>,
    job_id: String,
    chunk_index: u64,
    lease_id: u64,
    #[serde(default)]
    scanned: u64,
    #[serde(default)]
    rate: f64,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    samples: Vec<Vec<u8>>,
}

fn heartbeat(app: &App, mut request: Request, role: &Identity) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let heartbeat: HeartbeatRequest = match serde_json::from_str(&body) {
        Ok(heartbeat) => heartbeat,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
    let client_id = effective_client_id(role, heartbeat.client_id.as_deref());
    let now = state::now_secs();
    let result = app.lock().heartbeat(
        client_id,
        &heartbeat.job_id,
        heartbeat.chunk_index,
        heartbeat.lease_id,
        heartbeat.scanned,
        heartbeat.rate,
        heartbeat.done,
        &heartbeat.samples,
        now,
    );
    match result {
        Ok(expires_at) => respond_json(request, 200, &json!({ "expires_at": expires_at })),
        Err(message) if message == ERR_INVALID_SAMPLE => {
            respond_json(request, 400, &json!({ "error": message }))
        }
        Err(message) => respond_json(request, 409, &json!({ "error": message })),
    }
}

#[derive(Deserialize)]
struct ResultRequest {
    #[serde(default)]
    client_id: Option<String>,
    job_id: String,
    lease_id: u64,
    key: String,
}

fn submit_result(app: &App, mut request: Request, role: &Identity) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let result_request: ResultRequest = match serde_json::from_str(&body) {
        Ok(result_request) => result_request,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
    let client_id = effective_client_id(role, result_request.client_id.as_deref());
    let result = app.lock().submit_result(
        client_id,
        &result_request.job_id,
        result_request.lease_id,
        &result_request.key,
    );
    match result {
        Ok(()) => respond_json(request, 200, &json!({ "accepted": true })),
        Err(message) if message == ERR_JOB_NOT_FOUND => {
            respond_json(request, 404, &json!({ "error": message }))
        }
        Err(message) if message == ERR_LEASE_LOST => {
            respond_json(request, 409, &json!({ "error": message }))
        }
        Err(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

/// Client identity from the token; the legacy admin token falls back to the
/// body (the body is authoritative only in single-token mode).
fn effective_client_id<'a>(role: &'a Identity, body: Option<&'a str>) -> &'a str {
    match role {
        Identity::Client(id) => id,
        Identity::Admin => body.unwrap_or(""),
    }
}

fn bsgs_get(app: &App, request: Request, query: &str) {
    let Some(job_id) = query_param(query, "job_id") else {
        return respond_json(request, 400, &json!({"error": "job_id is required"}));
    };
    let stored = app.lock().bsgs_get(job_id);
    match stored {
        Some(entry) => respond_json(
            request,
            200,
            &json!({
                "job_id": job_id,
                "manifest": state::ManifestJson::from(&entry.manifest),
                "giant_index": entry.giant_index,
            }),
        ),
        None => respond_json(request, 404, &json!({"error": "not found"})),
    }
}

#[derive(Deserialize)]
struct BsgsPutRequest {
    job_id: String,
    manifest: state::ManifestJson,
    giant_index: u64,
}

fn bsgs_put(app: &App, mut request: Request) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let put: BsgsPutRequest = match serde_json::from_str(&body) {
        Ok(put) => put,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
    let result = app
        .lock()
        .bsgs_put(&put.job_id, put.manifest.to_manifest(), put.giant_index);
    match result {
        Ok(()) => respond_json(request, 200, &json!({ "ok": true })),
        Err(message) if message == ERR_JOB_NOT_FOUND => {
            respond_json(request, 404, &json!({ "error": message }))
        }
        Err(message) if message == ERR_MANIFEST_MISMATCH => {
            respond_json(request, 409, &json!({ "error": message }))
        }
        Err(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

/// Why a request body could not be read.
pub(crate) enum BodyError {
    TooLarge,
    Io(String),
}

pub(crate) fn read_body(request: &mut Request) -> Result<String, BodyError> {
    if request
        .body_length()
        .is_some_and(|length| length > MAX_BODY_BYTES)
    {
        return Err(BodyError::TooLarge);
    }
    let mut body = String::new();
    request
        .as_reader()
        .take(MAX_BODY_BYTES as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|err| BodyError::Io(format!("cannot read request body: {err}")))?;
    if body.len() > MAX_BODY_BYTES {
        return Err(BodyError::TooLarge);
    }
    Ok(body)
}

pub(crate) fn respond_body_error(request: Request, error: BodyError) {
    match error {
        BodyError::TooLarge => respond_json(
            request,
            413,
            &json!({ "error": "request body exceeds 1 MiB" }),
        ),
        BodyError::Io(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

pub(crate) fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

fn bearer(request: &Request) -> Option<&str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
}

/// Client IP used as a rate-limit key.
///
/// `trust_proxy` is opt-in: without it the socket peer is authoritative even
/// when proxy headers are present. With it, `CF-Connecting-IP` wins, then the
/// first hop of `X-Forwarded-For`, then the socket address.
pub(crate) fn client_ip(request: &Request, trust_proxy: bool) -> String {
    client_ip_from(
        header_value(request, "CF-Connecting-IP"),
        header_value(request, "X-Forwarded-For"),
        request.remote_addr().map(|addr| addr.ip().to_string()),
        trust_proxy,
    )
}

fn header_value<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

fn client_ip_from(
    cloudflare: Option<&str>,
    forwarded_for: Option<&str>,
    socket: Option<String>,
    trust_proxy: bool,
) -> String {
    if trust_proxy {
        if let Some(ip) = cloudflare.and_then(parse_forwarded_ip) {
            return ip;
        }
        if let Some(ip) = forwarded_for
            .and_then(|value| value.split(',').next())
            .and_then(parse_forwarded_ip)
        {
            return ip;
        }
    }
    socket.unwrap_or_else(|| "unknown".to_string())
}

/// Parse one proxy-supplied address: bare IP, `ip:port`, or `[v6]:port`.
fn parse_forwarded_ip(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(rest) = value.strip_prefix('[') {
        let (ip, _) = rest.split_once(']')?;
        return ip.parse::<std::net::IpAddr>().ok().map(|ip| ip.to_string());
    }
    if let Ok(ip) = value.parse::<std::net::IpAddr>() {
        return Some(ip.to_string());
    }
    value
        .parse::<std::net::SocketAddr>()
        .ok()
        .map(|addr| addr.ip().to_string())
}

/// Constant-time equality over the byte strings (length is not secret).
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

/// Decode one SHA-256 hex digest from the clients file.
fn decode_hash(text: &str) -> Result<[u8; 32], String> {
    if text.len() != 64 {
        return Err(format!(
            "client token hash must be 64 hex digits, got {}",
            text.len()
        ));
    }
    let mut out = [0u8; 32];
    for (chunk, slot) in text
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .zip(out.iter_mut())
    {
        let high = hex_digit(chunk[0]).ok_or_else(|| {
            format!(
                "invalid hex digit in client token hash: {}",
                chunk[0] as char
            )
        })?;
        let low = hex_digit(chunk[1]).ok_or_else(|| {
            format!(
                "invalid hex digit in client token hash: {}",
                chunk[1] as char
            )
        })?;
        *slot = (high << 4) | low;
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

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header is ASCII")
}

pub(crate) fn respond_json<T: serde::Serialize>(request: Request, status: u16, value: &T) {
    let body = serde_json::to_string(value)
        .unwrap_or_else(|_| "{\"error\":\"serialization failed\"}".to_string());
    let response = Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "application/json"));
    let _ = request.respond(response);
}

fn respond_rate_limited(request: Request) {
    let body = json!({ "error": "rate limit exceeded" }).to_string();
    let response = Response::from_string(body)
        .with_status_code(StatusCode(429))
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Retry-After", "1"));
    let _ = request.respond(response);
}

fn respond_empty(request: Request, status: u16) {
    let _ = request.respond(Response::empty(StatusCode(status)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_rejection_keeps_auth_precedence() {
        assert_eq!(capacity_rejection_status("/api/v1/status", false), 401);
        assert_eq!(capacity_rejection_status("/api/v1/status", true), 503);
        assert_eq!(capacity_rejection_status("/api/v1/jobs/public", false), 503);
        assert_eq!(
            capacity_rejection_status("/api/v1/workers/public", false),
            503
        );
        assert_eq!(capacity_rejection_status("/", false), 503);
    }

    #[test]
    fn browser_client_assets_are_served() {
        let (body, content_type) = static_asset("/run").expect("/run is embedded");
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(!body.is_empty());

        let (body, content_type) =
            static_asset("/rotor-worker.js").expect("/rotor-worker.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        assert!(!body.is_empty());

        let (body, content_type) =
            static_asset("/rotor_wasm.wasm").expect("/rotor_wasm.wasm is embedded");
        assert_eq!(content_type, "application/wasm");
        assert_eq!(body.len(), ROTOR_WASM.len());
        assert!(body.len() > 1024);

        let (body, content_type) = static_asset("/key").expect("/key is embedded");
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(!body.is_empty());

        let (body, content_type) = static_asset("/key.js").expect("/key.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        assert!(!body.is_empty());

        let (body, content_type) = static_asset("/puzzle.js").expect("/puzzle.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        assert!(!body.is_empty());
        assert!(
            body.windows(19)
                .any(|window| window == b"/api/v1/jobs/public")
        );

        let (body, content_type) = static_asset("/cabinet").expect("/cabinet is embedded");
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(!body.is_empty());

        for path in ["/cabinet.js", "/monitor.js"] {
            let (body, content_type) = static_asset(path).expect("monitor JS is embedded");
            assert_eq!(content_type, "application/javascript; charset=utf-8");
            assert!(!body.is_empty());
        }
        assert!(static_asset("/monitor").is_none());
    }

    #[test]
    fn theme_script_and_chain_generator_entries_are_served() {
        let (body, content_type) = static_asset("/theme.js").expect("/theme.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let script = std::str::from_utf8(body).expect("theme.js is utf-8");
        assert!(script.contains("rotor-theme"));
        assert!(script.contains("data-theme"));

        let (body, content_type) = static_asset("/tools").expect("/tools is embedded");
        assert_eq!(content_type, "text/html; charset=utf-8");
        let page = std::str::from_utf8(body).expect("tools.html is utf-8");
        for href in [
            "/key?chain=ethereum",
            "/key?chain=bnb",
            "/key?chain=tron",
            "/key?chain=solana",
            "/key?chain=xrp",
            "/key?chain=ton",
            "/key?chain=bitcoin-cash",
            "/key?chain=bitcoin&amp;type=taproot",
            "/key?chain=bitcoin&amp;type=segwit",
            "/mnemonic-converter",
        ] {
            assert!(
                page.contains(href),
                "generator link {href} must be on /tools"
            );
        }
    }

    #[test]
    fn seed_studio_and_mnemonic_converter_are_served() {
        for (path, marker, extra) in [
            ("/seed", "id=\"seed-form\"", "/mnemonic-converter"),
            ("/mnemonic-converter", "id=\"seed-form\"", "/seed"),
        ] {
            let (page, content_type) =
                static_asset(path).unwrap_or_else(|| panic!("{path} is embedded"));
            assert_eq!(content_type, "text/html; charset=utf-8");
            let page = std::str::from_utf8(page).expect("page is UTF-8");
            assert!(page.contains(marker), "{path} is missing {marker}");
            assert!(page.contains(extra), "{path} is missing a link to {extra}");
            for asset in [
                "/seed.js",
                "/seed-crypto.js",
                "/seed-page.js",
                "/seed-studio.css",
            ] {
                assert!(page.contains(asset), "{path} does not load {asset}");
            }
            assert!(
                page.contains("/theme.js?v=20261121e"),
                "{path} does not load the theme script"
            );
        }

        let (script, content_type) =
            static_asset("/seed-crypto.js").expect("/seed-crypto.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let script = std::str::from_utf8(script).expect("seed-crypto.js is UTF-8");
        assert!(script.contains("RotorSeedCrypto"));
        assert!(script.contains("oldPrivateKeys"));
        assert!(script.contains("electrumSeedType"));

        let (engine, content_type) =
            static_asset("/seed-page.js").expect("/seed-page.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let engine = std::str::from_utf8(engine).expect("seed-page.js is UTF-8");
        assert!(engine.contains("RotorSeedCrypto"));
        assert!(engine.contains("checkBalances"));

        let (css, content_type) =
            static_asset("/seed-studio.css").expect("/seed-studio.css is embedded");
        assert_eq!(content_type, "text/css; charset=utf-8");
        assert!(
            std::str::from_utf8(css)
                .expect("css is UTF-8")
                .contains(".seed-count-btn")
        );

        let base = "https://rotor.pxbt.app";
        let (sitemap, _, 200) = seo_asset(base, "/sitemap.xml", "").expect("sitemap") else {
            panic!("sitemap status");
        };
        assert!(
            sitemap.contains(&format!("<loc>{base}/mnemonic-converter</loc>")),
            "sitemap is missing /mnemonic-converter"
        );
    }

    #[test]
    fn rendered_documents_load_the_theme_script() {
        let page = html_document("Test", "", "");
        assert!(page.contains("<script src=\"/theme.js?v=20261121e\"></script>"));
        assert!(page.contains("/site.css?v=20261121e"));
    }

    #[test]
    fn seo_hubs_render_canonical_and_json_ld() {
        let base = "https://rotor.pxbt.app";
        let (body, content_type, status) =
            seo_asset(base, "/private-keys", "").expect("/private-keys");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(
            body.contains("<link rel=\"canonical\" href=\"https://rotor.pxbt.app/private-keys\">")
        );
        assert!(body.contains("application/ld+json"));
        assert!(body.contains("\"@type\":\"BreadcrumbList\""));
        assert!(body.contains("\"@type\":\"ItemList\""));
        assert!(!body.contains("noindex"));
        assert!(body.contains("href=\"/private-keys/bitcoin\""));

        let (body, _, status) =
            seo_asset(base, "/private-keys/bitcoin", "").expect("/private-keys/bitcoin");
        assert_eq!(status, 200);
        assert!(body.contains(
            "<link rel=\"canonical\" href=\"https://rotor.pxbt.app/private-keys/bitcoin\">"
        ));
        assert!(body.matches("class=\"key-row\"").count() >= 60);
        assert!(body.matches("/key/").count() >= 60);
        assert!(body.contains("robots\" content=\"index,follow"));
        assert!(body.contains("Bitcoin keys page"));

        assert_eq!(seo_asset(base, "/private-keys/unknown", "").unwrap().2, 404);
    }

    #[test]
    fn browse_pages_step_sixty_keys_and_later_pages_are_noindex() {
        let base = "https://rotor.pxbt.app";
        let chain = chain_by_slug("bitcoin").expect("bitcoin");
        assert_eq!(format_page_count(&chain_total_pages(chain)), "1.93E+75");
        assert_eq!(
            parse_page_number("0000000000000000000000000000000000000000000000000000000000000002"),
            Some(BigUint::from(2u8))
        );

        let (body, _, status) = seo_asset(base, "/private-keys/bitcoin/2", "").expect("page 2");
        assert_eq!(status, 200);
        assert!(body.contains("000000000000000000000000000000000000000000000000000000000000003d"));
        assert!(body.contains("<meta name=\"robots\" content=\"noindex,follow\">"));
        assert!(
            body.contains("canonical\" href=\"https://rotor.pxbt.app/private-keys/bitcoin/2\"")
        );
        assert!(body.matches("class=\"key-row\"").count() >= 60);

        let (segwit, _, status) =
            seo_asset(base, "/private-keys/bitcoin", "type=segwit").expect("segwit");
        assert_eq!(status, 200);
        assert!(segwit.contains("data-type=\"segwit\""));
        assert!(segwit.contains("data-field=\"btc_p2wpkh\""));

        assert_eq!(
            seo_asset(base, "/private-keys/bitcoin/not-a-page", "")
                .expect("invalid page")
                .2,
            404
        );
        assert_eq!(
            seo_asset(base, "/private-keys/bitcoin/2/extra", "")
                .expect("extra segment")
                .2,
            404
        );
    }

    #[test]
    fn legacy_keys_hubs_redirect_to_private_keys() {
        assert_eq!(redirect_target("/keys"), Some("/private-keys".to_string()));
        assert_eq!(
            redirect_target("/keys/bitcoin"),
            Some("/private-keys/bitcoin".to_string())
        );
        assert_eq!(redirect_target("/keys/unknown"), None);
        // Range pages keep their canonical /keys URL.
        let range = format!("/keys/bitcoin/{}-{}", "1".repeat(64), "2".repeat(64));
        assert_eq!(redirect_target(&range), None);
    }

    #[test]
    fn keys_hub_links_tools_pages() {
        let base = "https://rotor.pxbt.app";
        let (body, _, status) = seo_asset(base, "/keys", "").expect("/keys");
        assert_eq!(status, 200);
        for href in ["/faq", "/brainwallet", "/disclaimer", "/donate"] {
            assert!(body.contains(&format!("href=\"{href}\"")), "missing {href}");
        }
    }

    #[test]
    fn seo_informational_pages_render_metadata_and_breadcrumbs() {
        let base = "https://rotor.pxbt.app";
        let pages = [
            ("/faq", FAQ_TITLE, "FAQ"),
            ("/disclaimer", DISCLAIMER_TITLE, "Disclaimer"),
            ("/donate", DONATE_TITLE, "Donate"),
            ("/brainwallet", BRAINWALLET_TITLE, "Brainwallet"),
        ];
        for (path, title, crumb) in pages {
            let (body, content_type, status) = seo_asset(base, path, "").expect(path);
            assert_eq!(status, 200, "{path}");
            assert_eq!(content_type, "text/html; charset=utf-8", "{path}");
            assert!(body.contains(&format!("<title>{title}</title>")), "{path}");
            assert!(
                body.contains(&format!("<link rel=\"canonical\" href=\"{base}{path}\">")),
                "{path}"
            );
            assert!(body.contains(&format!("<meta property=\"og:title\" content=\"{title}\">")));
            assert!(
                body.contains("<meta name=\"description\""),
                "{path} description"
            );
            assert!(
                body.contains("robots\" content=\"index,follow\""),
                "{path} indexable"
            );
            assert!(
                !body.contains("<meta name=\"robots\" content=\"noindex"),
                "{path} must be indexable"
            );
            assert!(
                body.contains("<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\">"),
                "{path} breadcrumbs"
            );
            assert!(
                body.contains("\"@type\":\"BreadcrumbList\""),
                "{path} breadcrumb JSON-LD"
            );
            assert!(
                body.contains("aria-current=\"page\""),
                "{path} current crumb"
            );
            assert!(body.contains(crumb), "{path} visible crumb label {crumb:?}");
        }
    }

    #[test]
    fn faq_has_questions_and_faq_json_ld() {
        let base = "https://rotor.pxbt.app";
        let (body, _, _) = seo_asset(base, "/faq", "").expect("/faq");
        assert!(body.contains("\"@type\":\"FAQPage\""));
        assert_eq!(body.matches("\"@type\":\"Question\"").count(), FAQ_QA.len());
        assert!(FAQ_QA.len() >= 8);
        assert!(body.contains("What does this site do?"));
        assert!(body.contains("Why are some pages noindex?"));
        assert!(body.contains("What is impossible here?"));
        // Hub links and site links from the FAQ.
        assert!(body.contains("href=\"/keys\""));
        assert!(body.contains("href=\"/keys/bitcoin\""));
        assert!(body.contains("href=\"/disclaimer\""));
        assert!(body.contains("href=\"/docs\""));
        assert!(!body.to_ascii_lowercase().contains("we detect leaked keys"));
    }

    #[test]
    fn disclaimer_states_authorized_use_and_limits() {
        let base = "https://rotor.pxbt.app";
        let (body, _, _) = seo_asset(base, "/disclaimer", "").expect("/disclaimer");
        assert!(body.contains("authorized"));
        assert!(body.contains("No custody, signing or sweeping"));
        assert!(body.contains("Key handling warning"));
        assert!(body.contains("Data providers and API caveats"));
        assert!(body.contains("href=\"/faq\""));
        assert!(body.contains("href=\"/docs\""));
    }

    #[test]
    fn donate_lists_maintainer_addresses_and_payment_link() {
        let base = "https://rotor.pxbt.app";
        let (body, _, _) = seo_asset(base, "/donate", "").expect("/donate");
        for address in [
            "bc1qgkqw02q70d0j00gylp3l5p8tyjd0c4lftrdsz8",
            "TC2d5VsjAY6eAVLrbwhEJtqtHTzbaf926f",
            "0xd451c8720545118a7e6566c54eb1bbbbc0f6a58a",
        ] {
            assert!(body.contains(address), "missing address {address}");
        }
        assert!(body.contains("https://pay.pxbt.app/u/0xd451c8720545118a7e6566c54eb1bbbbc0f6a58a"));
        assert!(body.contains("class=\"mono\""));
    }

    #[test]
    fn brainwallet_shell_has_form_and_client_script() {
        let base = "https://rotor.pxbt.app";
        let (body, _, _) = seo_asset(base, "/brainwallet", "").expect("/brainwallet");
        assert!(body.contains(&format!("<title>{BRAINWALLET_TITLE}</title>")));
        assert!(body.contains("<span>Tools</span>"));
        assert!(body.contains("type=\"password\""));
        assert!(body.contains(">Derive</button>"));
        assert!(body.contains("id=\"brainwallet-generate\""));
        assert!(body.contains("id=\"brainwallet-results\""));
        assert!(body.contains("data-brain-chain=\"all\""));
        assert!(
            body.contains("<script src=\"/brainwallet-engine.js?v=20261121e\" defer></script>")
        );
        assert!(body.contains("<script src=\"/brainwallet.js?v=20261121e\" defer></script>"));
        assert!(body.contains("/theme.js?v=20261121e"));
        assert!(body.contains("Brainwallets are unsafe"));
        // No server-side derivation: the page carries no key payload.
        assert!(!body.contains("window.__ROTOR_KEY__"));

        let (script, content_type) =
            static_asset("/brainwallet.js").expect("/brainwallet.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let needle = b"brainwallet-results";
        assert!(script.windows(needle.len()).any(|w| w == needle));
        let (engine, content_type) =
            static_asset("/brainwallet-engine.js").expect("/brainwallet-engine.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let needle = b"phraseKey";
        assert!(engine.windows(needle.len()).any(|w| w == needle));
    }

    #[test]
    fn brainwallet_chain_pages_and_alias_are_served_and_indexed() {
        let base = "https://rotor.pxbt.app";
        let pages = [
            ("/brainwallet/bitcoin", BRAINWALLET_BITCOIN_TITLE, "bitcoin"),
            (
                "/brainwallet/ethereum",
                BRAINWALLET_ETHEREUM_TITLE,
                "ethereum",
            ),
            ("/brainwallet-generator", BRAINWALLET_TITLE, "all"),
        ];
        for (path, title, focus) in pages {
            let (body, content_type, status) = seo_asset(base, path, "").expect(path);
            assert_eq!(status, 200, "{path}");
            assert_eq!(content_type, "text/html; charset=utf-8", "{path}");
            assert!(
                body.contains(&format!("<title>{title}</title>")),
                "{path} title"
            );
            assert!(
                body.contains(&format!("data-brain-chain=\"{focus}\"")),
                "{path} focus"
            );
            assert!(body.contains("Brainwallets are unsafe"), "{path} warning");
            assert!(
                body.contains("brainwallet-engine.js?v=20261121e"),
                "{path} engine"
            );
            assert!(body.contains("brainwallet.js?v=20261121e"), "{path} script");
        }
        // The alias canonicalizes to the index, not to itself.
        let (alias, _, _) = seo_asset(base, "/brainwallet-generator", "").expect("alias");
        assert!(
            alias.contains("<link rel=\"canonical\" href=\"https://rotor.pxbt.app/brainwallet\">")
        );
        let (ethereum, _, _) = seo_asset(base, "/brainwallet/ethereum", "").expect("ethereum");
        assert!(ethereum.contains(
            "<link rel=\"canonical\" href=\"https://rotor.pxbt.app/brainwallet/ethereum\">"
        ));

        let sitemap = render_sitemap(base);
        for path in [
            "/brainwallet",
            "/brainwallet/bitcoin",
            "/brainwallet/ethereum",
        ] {
            assert!(
                sitemap.contains(&format!("<loc>{base}{path}</loc>")),
                "sitemap missing {path}"
            );
        }
        assert!(!sitemap.contains("/brainwallet-generator"));
    }

    #[test]
    fn unknown_html_path_is_a_404() {
        let base = "https://rotor.pxbt.app";
        assert!(seo_asset(base, "/nope", "").is_none());
        assert!(static_asset("/nope").is_none());
        let (body, content_type, status) = unknown_html_page();
        assert_eq!(status, 404);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(body.contains("Page not found"));
        assert!(body.contains("noindex,nofollow"));
        assert_ne!(body, LANDING);
    }

    #[test]
    fn seo_key_page_injects_key_and_robots_policy() {
        let base = "https://rotor.pxbt.app";
        let key = format!("{:064x}", 1);
        let (body, _, status) = seo_asset(base, &format!("/key/{key}"), "").expect("/key/<hex>");
        assert_eq!(status, 200);
        assert!(body.contains(&format!(
            "window.__ROTOR_KEY__=\"{key}\";window.__ROTOR_CURVE__=\"secp256k1\";"
        )));
        // Curated example keys (1..=64) are indexable.
        assert!(body.contains("robots\" content=\"index,follow\""));
        assert!(body.contains(&format!(
            "<link rel=\"canonical\" href=\"https://rotor.pxbt.app/key/{key}\">"
        )));
        assert!(body.contains(&format!("Private key {}…{}", &key[..8], &key[60..])));
        assert!(body.contains("<nav class=\"breadcrumbs\""));
        assert!(body.contains("\"@type\":\"WebApplication\""));

        // Key 100 is user-supplied and stays out of the index.
        let other = format!("{:064x}", 100);
        let (body, _, status) =
            seo_asset(base, &format!("/key/{other}"), "").expect("/key/<other>");
        assert_eq!(status, 200);
        assert!(body.contains("robots\" content=\"noindex,follow\""));
        assert!(body.contains(&format!(
            "<link rel=\"canonical\" href=\"{base}/key/{other}\">"
        )));

        let (body, _, status) =
            seo_asset(base, &format!("/key/{key}"), "curve=ed25519").expect("ed25519 key");
        assert_eq!(status, 200);
        assert!(body.contains("window.__ROTOR_CURVE__=\"ed25519\""));

        assert_eq!(
            seo_asset(base, &format!("/key/{}", "0".repeat(64)), "")
                .unwrap()
                .2,
            404
        );
        assert_eq!(
            seo_asset(base, &format!("/key/{}", "g".repeat(64)), "")
                .unwrap()
                .2,
            404
        );
        assert_eq!(seo_asset(base, "/key/short", "").unwrap().2, 404);
        // Uppercase hex is accepted and normalized in the emitted key.
        let upper = "A".repeat(63) + "1";
        let (body, _, status) = seo_asset(base, &format!("/key/{upper}"), "").expect("uppercase");
        assert_eq!(status, 200);
        assert!(body.contains(&format!(
            "window.__ROTOR_KEY__=\"{}\"",
            upper.to_ascii_lowercase()
        )));
    }

    #[test]
    fn seo_range_page_renders_metadata_and_payload() {
        let base = "https://rotor.pxbt.app";
        let start = format!("{:064x}", 1);
        let end = format!("{:064x}", 64);
        let path = format!("/keys/bitcoin/{start}-{end}");
        let (body, content_type, status) = seo_asset(base, &path, "").expect("range");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(body.contains(&format!(
            "<title>Bitcoin keys 0x{}…–0x{}… — 64 keys | Rotor</title>",
            &start[..8],
            &end[56..]
        )));
        assert!(body.contains(&format!(
            "<link rel=\"canonical\" href=\"{base}/keys/bitcoin/{start}-{end}\">"
        )));
        assert!(body.contains("name=\"description\""));
        // Curated 1..=64 range: indexable.
        assert!(body.contains("robots\" content=\"index,follow\""));
        assert!(body.contains("\"@type\":\"WebApplication\""));
        assert!(body.contains("\"@type\":\"BreadcrumbList\""));
        assert!(body.contains("\"@type\":\"ItemList\""));
        assert!(body.contains(&format!("0x{}…–0x{}…", &start[..8], &end[56..])));
        assert!(body.contains("\"position\":4"));
        assert!(body.contains(&format!("{base}/key/{start}")));
        assert!(body.contains(&format!("{base}/key/{end}")));
        assert_eq!(body.matches("\"position\":").count(), 4 + 64);
        assert!(body.contains(&format!(
            "window.__ROTOR_RANGE__={{chain:\"bitcoin\",start:\"{start}\",end:\"{end}\"}};"
        )));
        assert!(body.contains("<nav class=\"breadcrumbs\""));
        assert!(body.contains("href=\"/private-keys/bitcoin\""));

        // Uppercase input is normalized in the emitted payload and canonical.
        let upper = format!("{:064X}", 1);
        let upper_end = format!("{:064X}", 64);
        let (body, _, status) = seo_asset(base, &format!("/keys/ethereum/{upper}-{upper_end}"), "")
            .expect("uppercase range");
        assert_eq!(status, 200);
        assert!(body.contains(&format!(
            "window.__ROTOR_RANGE__={{chain:\"ethereum\",start:\"{start}\",end:\"{end}\"}};"
        )));
    }

    #[test]
    fn seo_arbitrary_range_is_noindex() {
        let base = "https://rotor.pxbt.app";
        let start = format!("{:064x}", 100);
        let end = format!("{:064x}", 101);
        let (body, _, status) =
            seo_asset(base, &format!("/keys/tron/{start}-{end}"), "").expect("range");
        assert_eq!(status, 200);
        assert!(body.contains("robots\" content=\"noindex,follow\""));
        assert!(body.contains(&format!(
            "<link rel=\"canonical\" href=\"{base}/keys/tron/{start}-{end}\">"
        )));
        assert_eq!(body.matches("\"position\":").count(), 4 + 2);
    }

    #[test]
    fn seo_invalid_ranges_are_404() {
        let base = "https://rotor.pxbt.app";
        let one = format!("{:064x}", 1);
        let sixty_four = format!("{:064x}", 64);
        let sixty_five = format!("{:064x}", 65);
        let cases = [
            format!("/keys/unknown/{one}-{sixty_four}"),
            format!("/keys/bitcoin/{one}"),
            format!("/keys/bitcoin/{one}-{sixty_five}"), // 65 keys: too wide
            format!("/keys/bitcoin/{sixty_four}-{one}"), // start > end
            format!("/keys/bitcoin/{}-{one}", "0".repeat(63)), // not 64 digits
            format!("/keys/bitcoin/{}-{sixty_four}", "g".repeat(64)), // not hex
            format!("/keys/bitcoin/{one}-{sixty_four}-{sixty_four}"),
        ];
        for path in cases {
            assert_eq!(seo_asset(base, &path, "").unwrap().2, 404, "{path}");
        }
    }

    #[test]
    fn range_js_is_served_as_javascript() {
        let (body, content_type) = static_asset("/range.js").expect("/range.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        assert!(!body.is_empty());
        assert!(body.windows(15).any(|window| window == b"__ROTOR_RANGE__"));
    }

    #[test]
    fn chain_hub_links_the_curated_range() {
        let base = "https://rotor.pxbt.app";
        let one = format!("{:064x}", 1);
        let sixty_four = format!("{:064x}", 64);
        let (body, _, status) = seo_asset(base, "/private-keys/solana", "").expect("hub");
        assert_eq!(status, 200);
        assert!(body.contains(&format!("href=\"/keys/solana/{one}-{sixty_four}\"")));
        assert!(body.contains(&format!("{base}/keys/solana/{one}-{sixty_four}")));
    }

    #[test]
    fn seed_and_vanity_tools_are_served_and_indexed() {
        for path in [
            "/seed",
            "/seed.js",
            "/seed-page.js",
            "/vanity",
            "/vanity.js",
            "/milk-sad",
        ] {
            assert!(static_asset(path).is_some(), "{path} must be embedded");
        }
        let base = "https://rotor.pxbt.app";
        let sitemap = render_sitemap(base);
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/seed</loc>"));
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/vanity</loc>"));
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/milk-sad</loc>"));
        for chain in ["zcash", "sui", "ton"] {
            let path = format!("/private-keys/{chain}");
            let (body, _, status) = seo_asset(base, &path, "").expect("chain hub");
            assert_eq!(status, 200);
            assert!(body.contains("private keys"));
        }
    }

    #[test]
    fn mnemonic_seed_directory_routes_and_assets_are_served() {
        let base = "https://rotor.pxbt.app";

        let (directory, content_type) = static_asset("/mnemonic-seeds").expect("directory");
        assert_eq!(content_type, "text/html; charset=utf-8");
        let directory = std::str::from_utf8(directory).expect("utf-8 html");
        assert!(directory.contains("data-chain=\"\""));
        assert!(directory.contains("href=\"/mnemonic-seeds/bitcoin\""));
        assert!(directory.contains("href=\"/seed\""));

        let (script, content_type) = static_asset("/mnemonic-seeds.js").expect("script");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let script = std::str::from_utf8(script).expect("utf-8 js");
        assert!(script.contains("entropyToMnemonic"));
        assert!(script.contains("mnemonic-seeds"));

        let (body, _, status) = seo_asset(base, "/mnemonic-seeds/bitcoin", "").expect("chain page");
        assert_eq!(status, 200);
        assert!(body.contains("data-chain=\"bitcoin\""));
        assert!(body.contains("data-symbol=\"BTC\""));
        assert!(body.contains("https://mempool.space/address/"));
        assert!(body.contains("Bitcoin mnemonic seeds"));
        assert!(body.contains(
            "<link rel=\"canonical\" href=\"https://rotor.pxbt.app/mnemonic-seeds/bitcoin\">"
        ));
        assert!(body.contains("<body class=\"mnemonic-chain-mode\">"));

        let (page_two, _, status) =
            seo_asset(base, "/mnemonic-seeds/bitcoin/2", "").expect("page two");
        assert_eq!(status, 200);
        assert!(page_two.contains("data-page=\"2\""));
        assert!(page_two.contains("<meta name=\"robots\" content=\"noindex,follow\">"));

        for chain in &CHAINS {
            let path = format!("/mnemonic-seeds/{}", chain.slug);
            let (body, _, status) = seo_asset(base, &path, "").expect("chain route");
            assert_eq!(status, 200, "{path}");
            assert!(body.contains(&format!("data-chain=\"{}\"", chain.slug)));
        }

        for path in [
            "/mnemonic-seeds/unknown",
            "/mnemonic-seeds/bitcoin/not-a-page",
            "/mnemonic-seeds/bitcoin/2/extra",
        ] {
            assert_eq!(
                seo_asset(base, path, "").expect("404 route").2,
                404,
                "{path}"
            );
        }

        assert_eq!(
            redirect_target("/mnemonic-seeds/"),
            Some("/mnemonic-seeds".to_string())
        );
        let sitemap = render_sitemap(base);
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/mnemonic-seeds</loc>"));
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/mnemonic-seeds/bitcoin</loc>"));
    }

    #[test]
    fn wif_key_path_resolves_to_the_hex_key() {
        let base = "https://rotor.pxbt.app";
        let wif = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
        let (body, _, status) = seo_asset(base, &format!("/key/{wif}"), "").expect("WIF key");
        assert_eq!(status, 200);
        assert!(body.contains("Private key 00000000"));
        assert_eq!(
            seo_asset(
                base,
                "/key/KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWx",
                ""
            )
            .expect("bad WIF")
            .2,
            404
        );
    }

    #[test]
    fn monitor_moved_to_cabinet() {
        assert_eq!(redirect_target("/monitor"), Some("/cabinet".to_string()));
        assert_eq!(redirect_target("/cabinet"), None);
        assert_eq!(redirect_target("/monitor.js"), None);
    }

    #[test]
    fn cabinet_wallet_page_and_vault_assets_are_served() {
        let (page, content_type) =
            static_asset("/cabinet/wallet").expect("/cabinet/wallet is embedded");
        assert_eq!(content_type, "text/html; charset=utf-8");
        let html = std::str::from_utf8(page).expect("wallet page is utf-8");
        assert!(html.contains("id=\"wallet-panel\""));
        assert!(html.contains("id=\"wallet-import-form\""));
        assert!(html.contains("id=\"wallet-unlock-form\""));
        assert!(html.contains("<script src=\"/theme.js?v=20261121e\"></script>"));
        assert!(html.contains("<script src=\"/wallet-vault.js?v=20261121e\"></script>"));
        assert!(html.contains("<script src=\"/wallet-evm.js?v=20261121e\"></script>"));
        assert!(html.contains("<script src=\"/wallet-btc.js?v=20261121e\"></script>"));
        assert!(html.contains("<script src=\"/wallet.js?v=20261121e\"></script>"));
        assert!(html.contains("id=\"wallet-btc-send\""));
        assert!(html.contains("id=\"wallet-btc-form\""));

        let (script, content_type) = static_asset("/wallet.js").expect("/wallet.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let script = std::str::from_utf8(script).expect("wallet.js is utf-8");
        assert!(script.contains("rotor-wallet"));
        assert!(script.contains("derive_report"));
        assert!(script.contains("IDLE_MS = 10 * 60 * 1000"));
        assert!(script.contains("pagehide"));

        let (codec, content_type) =
            static_asset("/wallet-vault.js").expect("/wallet-vault.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let codec = std::str::from_utf8(codec).expect("wallet-vault.js is utf-8");
        assert!(codec.contains("PBKDF2-SHA256"));
        assert!(codec.contains("MIN_ITERATIONS = 600000"));
        assert!(codec.contains("AES-GCM"));

        let (btc, content_type) =
            static_asset("/wallet-btc.js").expect("/wallet-btc.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let btc = std::str::from_utf8(btc).expect("wallet-btc.js is utf-8");
        assert!(btc.contains("RotorBtcSend"));
        assert!(btc.contains("mempool.space/testnet/api"));
        assert!(btc.contains("btc_sign_tx"));

        let sitemap = render_sitemap("https://rotor.pxbt.app");
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/cabinet/wallet</loc>"));
    }

    #[test]
    fn robots_and_sitemap_have_expected_content_types() {
        let base = "https://rotor.pxbt.app";
        let (robots, content_type, status) = seo_asset(base, "/robots.txt", "").expect("robots");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/plain; charset=utf-8");
        assert!(robots.contains("Disallow: /api/"));
        assert!(robots.contains("Disallow: /cabinet"));
        assert!(robots.contains("Allow: /cabinet/wallet"));
        assert!(robots.contains("Sitemap: https://rotor.pxbt.app/sitemap.xml"));

        let (sitemap, content_type, status) = seo_asset(base, "/sitemap.xml", "").expect("sitemap");
        assert_eq!(status, 200);
        assert_eq!(content_type, "application/xml; charset=utf-8");
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/private-keys/bitcoin</loc>"));
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/private-keys</loc>"));
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/bitcoin-puzzle</loc>"));
        for path in ["/faq", "/disclaimer", "/donate", "/brainwallet"] {
            assert!(
                sitemap.contains(&format!("<loc>https://rotor.pxbt.app{path}</loc>")),
                "sitemap missing {path}"
            );
        }
        assert!(!sitemap.contains("<loc>https://rotor.pxbt.app/keys</loc>"));
        assert!(!sitemap.contains(&format!("{}/key/{}", base, "0".repeat(64))));
    }

    #[test]
    fn key_utility_pages_are_served_and_indexed() {
        for (path, script, marker) in [
            ("/hex-dec-bin", "/hex-dec-bin.js", "id=\"convert-form\""),
            ("/public-key", "/public-key.js", "id=\"pubkey-form\""),
            ("/pubkey-add", "/pubkey-add.js", "id=\"add-form\""),
            (
                "/keystore-parser",
                "/keystore-parser.js",
                "id=\"keystore-form\"",
            ),
            (
                "/reconstruction",
                "/reconstruction.js",
                "id=\"rebuild-form\"",
            ),
        ] {
            let (page, content_type) =
                static_asset(path).unwrap_or_else(|| panic!("{path} is embedded"));
            assert_eq!(content_type, "text/html; charset=utf-8");
            let page = std::str::from_utf8(page).expect("page is UTF-8");
            assert!(page.contains(marker), "{path} is missing {marker}");
            assert!(page.contains(script), "{path} does not load {script}");

            let (script_body, content_type) =
                static_asset(script).unwrap_or_else(|| panic!("{script} is embedded"));
            assert_eq!(content_type, "application/javascript; charset=utf-8");
            assert!(!script_body.is_empty());
        }

        let (shared, _) = static_asset("/key-tools.js").expect("key-tools.js is embedded");
        let shared = std::str::from_utf8(shared).expect("key-tools.js is UTF-8");
        assert!(shared.contains("assembleKey"));
        assert!(shared.contains("loadWasm"));

        let tools = std::str::from_utf8(TOOLS_PAGE.as_bytes()).expect("tools page is UTF-8");
        for href in [
            "href=\"/hex-dec-bin\"",
            "href=\"/public-key\"",
            "href=\"/pubkey-add\"",
            "href=\"/keystore-parser\"",
            "href=\"/reconstruction\"",
        ] {
            assert!(tools.contains(href), "tools page is missing {href}");
        }

        let base = "https://rotor.pxbt.app";
        let (sitemap, _, 200) = seo_asset(base, "/sitemap.xml", "").expect("sitemap") else {
            panic!("sitemap status");
        };
        for path in [
            "/hex-dec-bin",
            "/public-key",
            "/pubkey-add",
            "/keystore-parser",
            "/reconstruction",
        ] {
            assert!(
                sitemap.contains(&format!("<loc>{base}{path}</loc>")),
                "sitemap is missing {path}"
            );
        }
    }

    #[test]
    fn client_hashes_are_validated() {
        let hash = "0".repeat(64);
        let clients = Clients::parse(&format!(r#"{{"alpha":"{hash}"}}"#)).expect("parse");
        assert_eq!(clients.len(), 1);
        assert!(!clients.is_empty());

        assert!(Clients::parse(r#"{"alpha":"abcd"}"#).is_err());
        assert!(Clients::parse(r#"{"":""}"#).is_err());
        assert!(Clients::parse(&format!(r#"{{"alpha":"{hash}","beta":"{hash}"}}"#)).is_err());
        assert!(Clients::parse("not json").is_err());
    }

    #[test]
    fn embedded_copy_makes_no_forbidden_claims() {
        let surfaces = [
            ("landing", LANDING),
            ("app", APP_PAGE),
            ("me", ME_PAGE),
            ("docs", DOCS_PAGE),
            ("run", RUN_PAGE),
            ("key", KEY_PAGE),
            ("range", RANGE_PAGE),
            ("range.js", RANGE_JS),
            ("site.js", SITE_JS),
            ("key.js", KEY_JS),
            ("monitor", MONITOR_PAGE),
            ("monitor.js", MONITOR_JS),
            ("hex-dec-bin", HEX_DEC_BIN_PAGE),
            ("public-key", PUBLIC_KEY_PAGE),
            ("pubkey-add", PUBKEY_ADD_PAGE),
            ("keystore-parser", KEYSTORE_PARSER_PAGE),
            ("reconstruction", RECONSTRUCTION_PAGE),
        ];
        let forbidden = [
            "we detect leaked keys",
            "detect leaked keys",
            "guaranteed",
            "we can recover your funds",
            "prevent theft",
        ];
        for (name, text) in surfaces {
            let lower = text.to_ascii_lowercase();
            for claim in forbidden {
                assert!(
                    !lower.contains(claim),
                    "{name} contains forbidden claim: {claim:?}"
                );
            }
        }
    }

    #[test]
    fn proxy_headers_are_only_used_when_trusted() {
        let socket = || Some("127.0.0.1".to_string());
        assert_eq!(
            client_ip_from(Some("1.1.1.1"), Some("2.2.2.2"), socket(), false),
            "127.0.0.1"
        );
        assert_eq!(
            client_ip_from(Some("1.1.1.1"), Some("2.2.2.2"), socket(), true),
            "1.1.1.1"
        );
        assert_eq!(
            client_ip_from(None, Some("2.2.2.2, 3.3.3.3"), socket(), true),
            "2.2.2.2"
        );
        assert_eq!(
            client_ip_from(Some("not-an-ip"), Some("2.2.2.2"), socket(), true),
            "2.2.2.2"
        );
        assert_eq!(
            client_ip_from(Some("not-an-ip"), Some("also-bad"), socket(), true),
            "127.0.0.1"
        );
        assert_eq!(client_ip_from(None, None, None, true), "unknown");
        assert_eq!(
            client_ip_from(None, Some("[2001:db8::1]:443, 10.0.0.1"), socket(), true),
            "2001:db8::1"
        );
        assert_eq!(
            client_ip_from(None, Some("1.2.3.4:5678"), socket(), true),
            "1.2.3.4"
        );
    }

    #[test]
    fn site_nav_links_the_new_ia() {
        let base = "https://rotor.pxbt.app";
        let key = format!("{:064x}", 1);
        let end = format!("{:064x}", 64);
        let range = format!("/keys/bitcoin/{key}-{end}");
        let key_path = format!("/key/{key}");
        for path in [
            "/private-keys",
            "/private-keys/bitcoin",
            "/bitcoin-puzzle",
            key_path.as_str(),
            range.as_str(),
        ] {
            let (body, _, status) = seo_asset(base, path, "").expect(path);
            assert_eq!(status, 200, "{path}");
            for link in [
                "href=\"/\"",
                "href=\"/private-keys\"",
                "href=\"/bitcoin-puzzle\"",
                "href=\"/seed\"",
                "href=\"/vanity\"",
                "href=\"/tools\"",
                "href=\"/docs\"",
                "href=\"/cabinet\"",
            ] {
                assert!(body.contains(link), "{path} misses {link}");
            }
        }
    }

    #[test]
    fn bitcoin_puzzle_page_and_script_are_served() {
        let base = "https://rotor.pxbt.app";
        let (body, content_type, status) =
            seo_asset(base, "/bitcoin-puzzle", "").expect("/bitcoin-puzzle");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(
            body.contains("<title>Bitcoin puzzle browser — client-side key search | Rotor</title>")
        );
        assert!(body.contains(&format!(
            "<link rel=\"canonical\" href=\"{base}/bitcoin-puzzle\">"
        )));
        assert!(body.contains("property=\"og:title\""));
        assert!(body.contains("property=\"og:url\""));
        assert!(body.contains("robots\" content=\"index,follow"));
        assert!(body.contains("\"@type\":\"BreadcrumbList\""));
        assert!(body.contains("\"name\":\"Bitcoin Puzzle\""));
        assert!(body.contains("data-puzzle-picker"));
        assert!(body.contains("id=\"unsolved\""));
        assert!(body.contains("data-puzzle-jobs"));
        assert!(body.contains("data-puzzle-summary"));
        assert!(body.contains("<script src=\"/puzzle.js\" defer></script>"));
        assert!(body.contains("<script src=\"/puzzle-browser.js\" defer></script>"));
        assert!(body.contains("href=\"/run\""));
        assert!(body.contains("href=\"/cabinet\""));
        assert!(body.contains("href=\"/docs\""));
        assert!(body.contains("/api/v1/jobs/public"));

        let (js, content_type) = static_asset("/puzzle.js").expect("/puzzle.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        assert!(!js.is_empty());
        assert!(
            js.windows(19)
                .any(|window| window == b"/api/v1/jobs/public")
        );
    }

    #[test]
    fn bitcoin_puzzle_browser_routes_are_served() {
        let base = "https://rotor.pxbt.app";
        let target = "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";
        let (body, content_type, status) =
            seo_asset(base, "/bitcoin-puzzle/71/random", "").expect("#71 random");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(body.contains("<title>Bitcoin Puzzle #71 — Random Keys | Rotor</title>"));
        assert!(body.contains(&format!(
            "<link rel=\"canonical\" href=\"{base}/bitcoin-puzzle/71/random\">"
        )));
        assert!(body.contains("<a href=\"/bitcoin-puzzle\">Bitcoin Puzzle</a>"));
        assert!(body.contains("Puzzle #71"));
        assert!(body.contains("Random Keys"));
        assert!(body.contains("data-puzzle-app"));
        assert!(body.contains(&format!("data-puzzle-target=\"{target}\"")));
        assert!(body.contains("0000000000000000000000000000000000000000000000400000000000000000"));
        assert!(body.contains("00000000000000000000000000000000000000000000007fffffffffffffffff"));
        assert!(body.contains("data-puzzle-mode"));
        assert!(body.contains("Solo Random"));
        assert!(body.contains("Solo Seq"));
        assert!(body.contains(">Team</option>"));
        assert!(body.contains("data-range-preset=\"full\""));
        assert!(body.contains("data-range-preset=\"first\""));
        assert!(body.contains("data-range-preset=\"second\""));
        assert!(body.contains("data-range-preset=\"q4\""));
        assert!(body.contains("data-puzzle-start-btn"));
        assert!(body.contains("data-puzzle-stop-btn"));
        assert!(body.contains("data-puzzle-reset-btn"));
        assert!(body.contains("data-puzzle-check"));
        assert!(body.contains("data-puzzle-match"));
        assert!(body.contains("data-puzzle-copy"));
        assert!(body.contains("<script src=\"/puzzle-browser.js\" defer></script>"));

        let (detail, _, status) =
            seo_asset(base, "/bitcoin-puzzle/71/detail", "").expect("#71 detail");
        assert_eq!(status, 200);
        assert!(detail.contains(&format!(
            "<link rel=\"canonical\" href=\"{base}/bitcoin-puzzle/71/detail\">"
        )));
        assert!(detail.contains(target));
        assert!(detail.contains(&format!("https://mempool.space/address/{target}")));
        assert!(detail.contains(&format!("https://www.blockchain.com/btc/address/{target}")));
        assert!(detail.contains("data-puzzle-balance"));
        assert!(detail.contains("Puzzle #71 is unsolved"));
        assert!(!detail.contains("data-puzzle-app"));

        let (short, _, status) =
            seo_asset(base, "/bitcoin-puzzle/71", "").expect("#71 short route");
        assert_eq!(status, 200);
        assert!(short.contains(
            "<link rel=\"canonical\" href=\"https://rotor.pxbt.app/bitcoin-puzzle/71/detail\">"
        ));

        let (unsolved, _, status) =
            seo_asset(base, "/bitcoin-puzzle/unsolved", "").expect("/bitcoin-puzzle/unsolved");
        assert_eq!(status, 200);
        assert!(
            unsolved
                .contains("<title>Unsolved Bitcoin puzzles — local browser scan | Rotor</title>")
        );
        assert!(unsolved.contains(target));
        assert!(!unsolved.contains("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"));
        assert!(unsolved.contains("data-puzzle-picker"));
    }

    #[test]
    fn bitcoin_puzzle_routes_reject_bad_input() {
        let base = "https://rotor.pxbt.app";
        for path in [
            "/bitcoin-puzzle/0",
            "/bitcoin-puzzle/0/random",
            "/bitcoin-puzzle/161",
            "/bitcoin-puzzle/161/detail",
            "/bitcoin-puzzle/not-a-number/random",
            "/bitcoin-puzzle/71/unknown",
            "/bitcoin-puzzle/71/random/extra",
            "/bitcoin-puzzle/71/detail/extra",
        ] {
            let (_, content_type, status) = seo_asset(base, path, "").expect(path);
            assert_eq!(status, 404, "{path}");
            assert_eq!(content_type, "text/html; charset=utf-8");
        }
    }

    #[test]
    fn puzzle_browser_assets_are_embedded() {
        for path in ["/puzzle-browser.js", "/puzzle-worker.js"] {
            let (body, content_type) = static_asset(path).expect("puzzle asset is embedded");
            assert_eq!(content_type, "application/javascript; charset=utf-8");
            assert!(!body.is_empty());
        }
        let (worker, _) = static_asset("/puzzle-worker.js").expect("puzzle worker");
        let worker = std::str::from_utf8(worker).expect("utf-8 worker");
        assert!(worker.contains("/rotor_wasm.wasm"));
        assert!(worker.contains("set_job"));
        let (browser, _) = static_asset("/puzzle-browser.js").expect("puzzle browser");
        let browser = std::str::from_utf8(browser).expect("utf-8 browser");
        assert!(browser.contains("/puzzle-worker.js"));
        assert!(browser.contains("mempool.space"));
    }

    fn sample_job_view(target: Option<&str>, targets: &[&str]) -> state::JobView {
        state::JobView {
            id: "job-1".to_string(),
            target: target.map(str::to_string),
            targets: targets.iter().map(|text| text.to_string()).collect(),
            mode: "address".to_string(),
            coin: "btc".to_string(),
            comp_mode: "compressed".to_string(),
            start: format!("{:064x}", 1),
            end: format!("{:064x}", 64),
            chunk_width: 64,
            lease_ttl: 600,
            created_at: 1,
            chunks_total: 1,
            chunks_done: 0,
            chunks_leased: 0,
            scanned: 0,
            done: false,
            found: false,
            found_key: Some("client-secret-found-key".to_string()),
        }
    }

    #[test]
    fn public_job_projection_excludes_secrets_and_multi_targets() {
        let single = public_job_json(&sample_job_view(
            Some("1BoatSLRHtKNngkdXEeobR76b53LETtpyT"),
            &[],
        ));
        assert_eq!(single["target"], "1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
        assert_eq!(single["target_count"], 1);
        assert!(single.get("found_key").is_none());
        assert!(single.get("id").is_some());
        assert!(single.get("comp_mode").is_some());

        let multi = public_job_json(&sample_job_view(None, &["addr-a", "addr-b"]));
        assert!(multi["target"].is_null());
        assert_eq!(multi["target_count"], 2);
        assert!(!multi.to_string().contains("addr-a"));

        let none = public_job_json(&sample_job_view(None, &[]));
        assert!(none["target"].is_null());
        assert_eq!(none["target_count"], 0);
    }

    fn http_request(
        addr: SocketAddr,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> (u16, String) {
        use std::io::Write as _;

        let mut stream = std::net::TcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("read timeout");
        let payload = body.unwrap_or("");
        let mut request =
            format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
        if let Some(token) = token {
            request.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        if body.is_some() {
            request.push_str("Content-Type: application/json\r\n");
        }
        request.push_str(&format!(
            "Content-Length: {}\r\n\r\n{payload}",
            payload.len()
        ));
        stream.write_all(request.as_bytes()).expect("write request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        let (head, body) = response.split_once("\r\n\r\n").expect("header terminator");
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
            .expect("status code");
        (status, body.to_string())
    }

    #[test]
    fn public_jobs_endpoint_needs_no_token_and_leaks_no_secrets() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "rotor-coord-public-{}-{nanos}.json",
            std::process::id()
        ));
        let admin = "admin-secret-token";
        let client_token = "client-secret-token";
        let hash: String = crate::hashes::sha256(client_token.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let clients = Clients::parse(&format!(r#"{{"alpha":"{hash}"}}"#)).expect("clients");
        let handle =
            spawn_with_clients("127.0.0.1:0", &path, admin.to_string(), clients).expect("spawn");
        let addr = handle.addr;
        let job = json!({
            "mode": "address",
            "coin": "btc",
            "comp_mode": "compressed",
            "target": "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
            "start": "1",
            "end": "ff",
            "chunk_width": 256,
        });
        let (status, _) = http_request(
            addr,
            "POST",
            "/api/v1/jobs",
            Some(admin),
            Some(&job.to_string()),
        );
        assert_eq!(status, 201);

        let (status, body) = http_request(addr, "GET", "/api/v1/jobs/public", None, None);
        assert_eq!(status, 200);
        let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
        let jobs = value["jobs"].as_array().expect("jobs array");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["target"], "1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
        assert!(!body.contains(admin));
        assert!(!body.contains(client_token));
        assert!(!body.contains(&hash));
        assert!(!body.contains("found_key"));

        drop(handle);
        let _ = std::fs::remove_file(&path);
    }

    fn token_hash(token: &str) -> String {
        crate::hashes::sha256(token.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn temp_state(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "rotor-coord-{label}-{}-{nanos}.json",
            std::process::id()
        ))
    }

    #[test]
    fn public_workers_endpoint_needs_no_token_and_hides_private_data() {
        let path = temp_state("public-workers");
        let admin = "admin-secret-token";
        let alpha_token = "alpha-secret-token";
        let beta_token = "beta-secret-token";
        let gamma_token = "gamma-secret-token";
        let alpha_hash = token_hash(alpha_token);
        let beta_hash = token_hash(beta_token);
        let gamma_hash = token_hash(gamma_token);
        let clients = Clients::parse(&format!(
            r#"{{"alpha":"{alpha_hash}","beta":"{beta_hash}","gamma":"{gamma_hash}"}}"#
        ))
        .expect("clients");
        let handle =
            spawn_with_clients("127.0.0.1:0", &path, admin.to_string(), clients).expect("spawn");
        let addr = handle.addr;

        // beta is disabled and must never appear in the public snapshot.
        let (status, _) = http_request(
            addr,
            "POST",
            "/api/v1/clients/beta/disable",
            Some(admin),
            None,
        );
        assert_eq!(status, 200);

        let job = json!({
            "mode": "address",
            "coin": "btc",
            "comp_mode": "compressed",
            "target": "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
            "start": "1",
            "end": "ff",
            "chunk_width": 16,
        });
        let (status, body) = http_request(
            addr,
            "POST",
            "/api/v1/jobs",
            Some(admin),
            Some(&job.to_string()),
        );
        assert_eq!(status, 201);
        let job: serde_json::Value = serde_json::from_str(&body).expect("job JSON");
        let job_id = job["id"].as_str().expect("job id").to_string();

        let lease = json!({
            "job_id": job_id,
            "mode": "address",
            "coin": "btc",
            "start": "1",
            "end": "ff",
        });
        let (status, body) = http_request(
            addr,
            "POST",
            "/api/v1/lease",
            Some(alpha_token),
            Some(&lease.to_string()),
        );
        assert_eq!(status, 200);
        let lease: serde_json::Value = serde_json::from_str(&body).expect("lease JSON");
        let chunk_index = lease["chunk_index"].as_u64().expect("chunk index");
        let lease_id = lease["lease_id"].as_u64().expect("lease id");

        let heartbeat = json!({
            "job_id": job_id,
            "chunk_index": chunk_index,
            "lease_id": lease_id,
            "scanned": 100,
            "rate": 5.0,
        });
        let (status, _) = http_request(
            addr,
            "POST",
            "/api/v1/heartbeat",
            Some(alpha_token),
            Some(&heartbeat.to_string()),
        );
        assert_eq!(status, 200);

        let (status, body) = http_request(addr, "GET", "/api/v1/workers/public", None, None);
        assert_eq!(status, 200);
        let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
        let workers = value["workers"].as_array().expect("workers array");
        assert_eq!(workers.len(), 2, "disabled beta must be absent");
        assert_eq!(workers[0]["id"], "alpha");
        assert_eq!(workers[1]["id"], "gamma");
        assert_eq!(workers[0]["scanned"], 100);
        assert_eq!(workers[0]["chunks_done"], 0);
        assert_eq!(workers[0]["found"], 0);
        assert_eq!(workers[0]["rate"], 5.0);
        let live = &workers[0]["lease"];
        assert_eq!(live["job_id"], job_id.as_str());
        assert_eq!(live["chunk_index"], chunk_index);
        assert_eq!(live["scanned"], 100);
        assert!(live["expires_at"].as_u64().expect("expiry") > state::now_secs());
        assert!(workers[1]["lease"].is_null());

        assert!(workers[0].get("token").is_none());
        assert!(workers[0].get("token_hash").is_none());
        assert!(!body.contains("token"));
        assert!(!body.contains("beta"));
        assert!(!body.contains(&alpha_hash));
        assert!(!body.contains(&beta_hash));
        assert!(!body.contains(&gamma_hash));
        assert!(!body.contains(alpha_token));
        assert!(!body.contains(beta_token));
        assert!(!body.contains(gamma_token));

        drop(handle);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn public_workers_endpoint_is_rate_limited_per_ip() {
        let path = temp_state("public-workers-rate");
        let hash = token_hash("alpha-secret-token");
        let clients = Clients::parse(&format!(r#"{{"alpha":"{hash}"}}"#)).expect("clients");
        let handle =
            spawn_with_clients("127.0.0.1:0", &path, "admin".to_string(), clients).expect("spawn");
        let addr = handle.addr;

        // The bucket starts at RATE_BURST; a burst beyond it must answer 429.
        let mut limited = false;
        for _ in 0..(RATE_BURST as usize * 5) {
            let (status, body) = http_request(addr, "GET", "/api/v1/workers/public", None, None);
            if status == 429 {
                assert!(body.contains("rate limit exceeded"));
                limited = true;
                break;
            }
            assert_eq!(status, 200);
        }
        assert!(limited, "the endpoint must enforce its per-IP bucket");

        drop(handle);
        let _ = std::fs::remove_file(&path);
    }
}
