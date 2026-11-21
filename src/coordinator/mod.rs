//! Distributed coordinator: a token-protected HTTP/JSON API plus a static
//! dashboard.
//!
//! One thread accepts requests and one thread per request does the work; state
//! lives behind a single mutex. No async runtime, no TLS (terminate it in a
//! reverse proxy).

pub mod chunk_loop;
pub mod client;
pub mod orders;
pub mod puzzles;
pub mod state;
pub mod tron_cache;
pub mod wallets;

use std::collections::HashMap;
use std::io::Read;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

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
const ADDRESS_CODECS_JS: &str = include_str!("../../apps/site/address-codecs.js");
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
const BRAINWALLET_DIRECTORY_JS: &str = include_str!("../../apps/site/brainwallet-directory.js");
const BRAINWALLET_CSS: &str = include_str!("../../apps/site/brainwallet.css");
const BROWSE_JS: &str = include_str!("../../apps/site/browse.js");
const BALANCE_CACHE_JS: &str = include_str!("../../apps/site/balance-cache.js");
const VANITY_PAGE: &str = include_str!("../../apps/site/vanity.html");
const VANITY_JS: &str = include_str!("../../apps/site/vanity.js");
const QR_JS: &str = include_str!("../../apps/site/qr.js");
const VANITY_WORKER_JS: &str = include_str!("../../apps/site/vanity-worker.js");
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
const TX_PAGE: &str = include_str!("../../apps/site/tx.html");
const TX_BITCOIN_PAGE: &str = include_str!("../../apps/site/tx-bitcoin.html");
const TX_ETHEREUM_PAGE: &str = include_str!("../../apps/site/tx-ethereum.html");
const TX_DECODERS_JS: &str = include_str!("../../apps/site/tx-decoders.js");
const TX_PAGE_JS: &str = include_str!("../../apps/site/tx-page.js");
const CABINET_WALLET_PAGE: &str = include_str!("../../apps/site/wallet.html");
const WALLET_JS: &str = include_str!("../../apps/site/wallet.js");
const WALLET_VAULT_JS: &str = include_str!("../../apps/site/wallet-vault.js");
const WALLET_EVM_JS: &str = include_str!("../../apps/site/wallet-evm.js");
const WALLET_BTC_JS: &str = include_str!("../../apps/site/wallet-btc.js");
const SEND_PAGE: &str = include_str!("../../apps/site/send.html");
const SEND_JS: &str = include_str!("../../apps/site/send.js");
const TRON_TX_JS: &str = include_str!("../../apps/site/tron-tx.js");
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
/// TronScan upstream for public TRON lookups. The API key is read once at
/// startup from `TRONSCAN_API_KEY` and only ever sent as a request header.
const TRONSCAN_API_BASE: &str = "https://apilist.tronscanapi.com";
const TRONSCAN_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TRONSCAN_READ_TIMEOUT: Duration = Duration::from_secs(20);
const TRONSCAN_WRITE_TIMEOUT: Duration = Duration::from_secs(20);
const TRONSCAN_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Largest address list one batch lookup accepts.
const TRON_BATCH_MAX: usize = 60;
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
    /// TronScan Pro API key from `TRONSCAN_API_KEY`. Never serialized or
    /// logged; `None` makes `/api/v1/chain/tron/address` answer `501`.
    tronscan_api_key: Option<String>,
    /// Shared TronScan HTTP client, in-flight limiter and lookup cache. The
    /// orders poller uses the same limiter, so provider calls stay bounded
    /// across every route.
    tronscan_agent: ureq::Agent,
    tron_limiter: Arc<tron_cache::Limiter>,
    tron_cache: Arc<tron_cache::Cache>,
    /// Paid-download orders, when `ORDERS_CONFIG` is set. `None` keeps the
    /// order routes answering `503` on coordinator-only servers and tests.
    orders: Option<Arc<orders::Orders>>,
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
#[derive(Clone)]
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
    /// Optional TronScan Pro API key. `None` (the default) reads
    /// `TRONSCAN_API_KEY`; it is never exposed in responses or errors.
    pub tronscan_api_key: Option<String>,
    /// Preloaded paid-download configuration. `None` (the default) reads
    /// `ORDERS_CONFIG` / `ORDERS_HMAC_SECRET` at startup; tests inject a store
    /// here instead of touching the process environment.
    pub orders: Option<Arc<orders::Orders>>,
}

impl std::fmt::Debug for ServerOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerOptions")
            .field("open_registration", &self.open_registration)
            .field("trust_proxy", &self.trust_proxy)
            .field("monitor_domain", &self.monitor_domain)
            .field("wallets_upstream", &self.wallets_upstream)
            .field(
                "tronscan_api_key_configured",
                &self.tronscan_api_key.is_some(),
            )
            .field("orders_configured", &self.orders.is_some())
            .finish()
    }
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            open_registration: false,
            trust_proxy: false,
            monitor_domain: "localhost".to_string(),
            wallets_upstream: None,
            tronscan_api_key: std::env::var("TRONSCAN_API_KEY")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            orders: None,
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
    let tronscan_api_key = options
        .tronscan_api_key
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let orders = match options.orders.clone() {
        Some(orders) => Some(orders),
        None => orders::Orders::from_env(state_path)?.map(Arc::new),
    };
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
        tronscan_api_key,
        tronscan_agent: tronscan_agent(),
        tron_limiter: Arc::new(tron_cache::Limiter::default()),
        tron_cache: Arc::new(tron_cache::Cache::default()),
        orders,
        telegram: Arc::new(crate::monitor::notify::TelegramConfig::from_env()),
    });
    // The poller is detached and does nothing until an order exists.
    if let Some(orders) = app.orders.clone() {
        orders::spawn_poller(
            orders,
            app.tronscan_api_key.clone(),
            Arc::clone(&app.tron_limiter),
        );
    }
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
        || path == "/api/v1/chain/tron/address"
        || path == "/api/v1/chain/tron/addresses"
        || path == "/api/v1/orders"
        || path.starts_with("/api/v1/orders/")
        || path.starts_with("/api/v1/admin/orders/")
        || path == "/api/v1/admin/payments/reconcile"
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
            let body = if content_type.starts_with("text/html") {
                with_site_footer(path, body)
            } else {
                body
            };
            let cache = if content_type.starts_with("text/html") {
                "no-store"
            } else {
                "no-cache"
            };
            let response = Response::from_string(body)
                .with_status_code(StatusCode(status))
                .with_header(header("Content-Type", content_type))
                .with_header(header("Cache-Control", cache));
            let _ = request.respond(response);
            return;
        }
        if let Some((body, content_type)) = static_asset(path) {
            let body = if content_type.starts_with("text/html") {
                with_site_footer(path, String::from_utf8_lossy(body).into_owned()).into_bytes()
            } else {
                body.to_vec()
            };
            let cache = if content_type.starts_with("text/html") {
                "no-store"
            } else {
                "no-cache"
            };
            let response = Response::from_data(body)
                .with_header(header("Content-Type", content_type))
                .with_header(header("Cache-Control", cache));
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

    // Paid downloads: buyers have no client account, so these routes bypass
    // the client-token matrix like the public wallet catalogue. Without
    // ORDERS_CONFIG the whole surface answers 503 rather than pretending to
    // accept orders.
    if path == "/api/v1/orders"
        || path.starts_with("/api/v1/orders/")
        || path.starts_with("/api/v1/admin/orders/")
        || path == "/api/v1/admin/payments/reconcile"
    {
        match app.orders.clone() {
            Some(orders) => orders::handle(&app, orders, request, method, path, query),
            None => respond_json(request, 503, &json!({ "error": "orders_not_configured" })),
        }
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

    // Public TRON lookup. TronScan is called server-side with the operator's
    // API key; without a key the route refuses rather than inventing data.
    if path == "/api/v1/chain/tron/addresses" {
        if method == Method::Post {
            return tron_addresses(&app, request);
        }
        return respond_json(request, 405, &json!({ "error": "method not allowed" }));
    }
    if path == "/api/v1/chain/tron/address" {
        if method == Method::Get {
            return tron_address(&app, request, query);
        }
        return respond_json(request, 405, &json!({ "error": "method not allowed" }));
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
        "/address-codecs.js" => Some((
            ADDRESS_CODECS_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
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
        "/brainwallet-directory.js" => Some((
            BRAINWALLET_DIRECTORY_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/brainwallet.css" => Some((BRAINWALLET_CSS.as_bytes(), "text/css; charset=utf-8")),
        "/browse.js" => Some((
            BROWSE_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/balance-cache.js" => Some((
            BALANCE_CACHE_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/vanity" => Some((VANITY_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/vanity.js" => Some((
            VANITY_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/qr.js" => Some((QR_JS.as_bytes(), "application/javascript; charset=utf-8")),
        "/vanity-worker.js" => Some((
            VANITY_WORKER_JS.as_bytes(),
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
        "/tx" => Some((TX_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/tx/bitcoin" => Some((TX_BITCOIN_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/tx/ethereum" => Some((TX_ETHEREUM_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/tx-decoders.js" => Some((
            TX_DECODERS_JS.as_bytes(),
            "application/javascript; charset=utf-8",
        )),
        "/tx-page.js" => Some((
            TX_PAGE_JS.as_bytes(),
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
        "/send" | "/send/bitcoin" | "/send/ethereum" | "/send/bnb" | "/send/usdt"
        | "/send/tron" => Some((SEND_PAGE.as_bytes(), "text/html; charset=utf-8")),
        "/send.js" => Some((SEND_JS.as_bytes(), "application/javascript; charset=utf-8")),
        "/tron-tx.js" => Some((
            TRON_TX_JS.as_bytes(),
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

/// Permanent redirects to the canonical naming: `/monitor` -> `/cabinet`,
/// the donor aliases `/vanity-generator` -> `/vanity` and `/downloads` ->
/// `/wallets`, and the old `/keys` hubs -> `/private-keys`. Key-range pages
/// keep their `/keys/<chain>/<start>-<end>` URLs and are not redirected.
fn redirect_target(path: &str) -> Option<String> {
    if path == "/monitor" {
        return Some("/cabinet".to_string());
    }
    if path == "/vanity-generator" {
        return Some("/vanity".to_string());
    }
    if path == "/downloads" {
        return Some("/wallets".to_string());
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
    if let Some(rest) = path.strip_prefix("/bitcoin-puzzle/") {
        let rest = rest.trim_end_matches('/');
        if let Some(raw) = rest.strip_suffix("/detail")
            && let Ok(number) = raw.parse::<u32>()
            && puzzles::puzzle(number).is_some()
        {
            return Some(format!("/bitcoin-puzzle/{number}"));
        }
    }
    None
}

fn redirect_response(location: &str) -> Response<std::io::Empty> {
    Response::empty(StatusCode(301)).with_header(header("Location", location))
}

fn respond_redirect(request: Request, location: &str) {
    let _ = request.respond(redirect_response(location));
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
        desc: "P2PKH · 1...",
        field: "btc_p2pkh",
    },
    AddressType {
        value: "segwit",
        label: "SegWit",
        desc: "P2WPKH · bc1q...",
        field: "btc_p2wpkh",
    },
    AddressType {
        value: "script",
        label: "Nested SegWit",
        desc: "P2SH · 3...",
        field: "btc_p2sh_p2wpkh",
    },
    AddressType {
        value: "taproot",
        label: "Taproot",
        desc: "P2TR · bc1p...",
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
    AddressType {
        value: "taproot",
        label: "Taproot",
        desc: "P2TR · ltc1p…",
        field: "ltc_p2tr",
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

    /// UTXO chains summarise Balance / Received / TX; account-model chains
    /// summarise Balance / Active, as the donor does.
    fn is_utxo(self) -> bool {
        matches!(
            self,
            Self::Bitcoin | Self::Litecoin | Self::BitcoinCash | Self::Dogecoin | Self::Zcash
        )
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
        curve_suffix: "",
        kind: AddressKind::Tron,
        color: "#ff4d4d",
        icon: "chain-tron",
        explorer: "https://tronscan.org/#/address/",
    },
    ChainHub {
        slug: "ton",
        name: "TON",
        symbol: "TON",
        description: "TON Wallet v4R2 addresses derived from the ed25519 public key.",
        curve_suffix: "?curve=ed25519",
        kind: AddressKind::Ton,
        color: "#0098ea",
        icon: "chain-ton",
        explorer: "https://tonviewer.com/",
    },
    ChainHub {
        slug: "sui",
        name: "Sui",
        symbol: "SUI",
        description: "Sui ed25519 accounts hashed with BLAKE2b-256.",
        curve_suffix: "?curve=ed25519",
        kind: AddressKind::Sui,
        color: "#6fbcf0",
        icon: "chain-sui",
        explorer: "https://suiscan.xyz/mainnet/account/",
    },
    ChainHub {
        slug: "xrp",
        name: "XRP",
        symbol: "XRP",
        description: "Classic r-addresses with the Ripple Base58 alphabet.",
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
        curve_suffix: "",
        kind: AddressKind::Zcash,
        color: "#ecb244",
        icon: "chain-zcash",
        explorer: "https://blockchair.com/zcash/address/",
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
        return Some((render_brainwallet_index(base), HTML, 200));
    }
    if path == "/brainwallet-generator" || path == "/brainwallet-generator/" {
        return Some((render_brainwallet_generator(base), HTML, 200));
    }
    if let Some(rest) = path.strip_prefix("/brainwallet/") {
        let rest = rest.trim_end_matches('/');
        if rest.is_empty() {
            return Some((render_brainwallet_index(base), HTML, 200));
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
                (render_brainwallet_directory(base, chain, raw), HTML, 200)
            }
            Some(_) => (render_seo_not_found(), HTML, 404),
            None => (render_brainwallet_directory(base, chain, "1"), HTML, 200),
        });
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
    if let Some(value) = path.strip_prefix("/key/") {
        let curve = if query.split('&').any(|pair| pair == "curve=ed25519") {
            "ed25519"
        } else {
            "secp256k1"
        };
        let decoded = percent_decode(value);
        return Some(match normalized_key_hex(&decoded, curve) {
            Some(key) => (render_key_page(base, &key, curve), HTML, 200),
            None if is_key_value(&decoded) => {
                (render_key_value_page(base, &decoded, curve), HTML, 200)
            }
            None => (render_seo_not_found(), HTML, 404),
        });
    }
    None
}

/// Donor key URL forms: an optional `0x`/`0X` prefix and 1..=64 hex digits,
/// left-padded to 32 bytes. A short numeric string is hex here, not decimal —
/// the donor's hex route reads it the same way; decimal stays on `/key/decimal`.
fn prefixed_hex_key(value: &str) -> Option<String> {
    let digits = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    if digits.is_empty()
        || digits.len() > 64
        || !digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(format!("{digits:0>64}").to_ascii_lowercase())
}

/// The key a donor key URL names: 1..=64 hex digits (optional `0x` prefix,
/// left-padded to 64) or a mainnet WIF; non-zero, and secp256k1 keys must also
/// be below the curve order (the existing scalar parser enforces that).
/// Returns lowercase.
fn normalized_key_hex(hex: &str, curve: &str) -> Option<String> {
    // A mainnet WIF is accepted in the /key/<value> path as well, matching the
    // donor-style key links. Bitcoin, Litecoin and Dogecoin share the encoding;
    // the version byte is decoded to the same 32-byte secp256k1 key here.
    if curve != "ed25519"
        && (51..=52).contains(&hex.len())
        && matches!(
            hex.as_bytes().first(),
            Some(b'5' | b'K' | b'L' | b'T' | b'Q')
        )
        && let Ok(decoded) = bs58::decode(hex).with_check(None).into_vec()
    {
        let key = match decoded.as_slice() {
            [0x80 | 0xb0 | 0x9e, rest @ ..] if rest.len() == 32 => Some(rest.to_vec()),
            [0x80 | 0xb0 | 0x9e, rest @ .., 0x01] if rest.len() == 32 => Some(rest.to_vec()),
            _ => None,
        };
        if let Some(key) = key {
            let lower = key
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            return crate::scalar::Scalar::from_hex(&lower)
                .filter(|value| !value.is_zero())
                .map(|_| lower);
        }
        // Not a valid WIF: a 51/52-digit hex value is still a donor key URL.
    }
    let lower = prefixed_hex_key(hex)?;
    if curve == "ed25519" {
        if lower.bytes().all(|byte| byte == b'0') {
            return None;
        }
    } else if !crate::scalar::Scalar::from_hex(&lower).is_some_and(|value| !value.is_zero()) {
        return None;
    }
    Some(lower)
}

/// Decode `%XX` escapes from a URL path segment without adding a dependency.
/// Invalid escapes are kept verbatim.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = char::from(bytes[index + 1]).to_digit(16);
            let low = char::from(bytes[index + 2]).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

const RIPPLE_ALPHABET: &[u8] = b"rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/// An XRP family seed (`s…`) or bare private-key secret (`p…`). The search
/// modal links these to the key page; the browser verifies the checksum.
fn looks_like_xrp_secret(value: &str) -> bool {
    if !(25..=60).contains(&value.len()) {
        return false;
    }
    match value.as_bytes().first() {
        Some(b's' | b'p') => {}
        _ => return false,
    }
    value.bytes().all(|byte| RIPPLE_ALPHABET.contains(&byte))
}

fn is_base58_keypair(value: &str) -> bool {
    if !(80..=100).contains(&value.len()) {
        return false;
    }
    bs58::decode(value)
        .into_vec()
        .map(|bytes| bytes.len() == 64)
        .unwrap_or(false)
}

fn is_json_keypair(value: &str) -> bool {
    let trimmed = value.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return false;
    }
    let Ok(serde_json::Value::Array(bytes)) = serde_json::from_str::<serde_json::Value>(trimmed)
    else {
        return false;
    };
    if bytes.len() != 32 && bytes.len() != 64 {
        return false;
    }
    bytes.iter().all(|item| {
        item.as_u64()
            .is_some_and(|number| number <= u64::from(u8::MAX))
    })
}

/// Values the donor-style search modal routes to `/key/<value>` that are not
/// normalized to hex server-side. The key page derives them in the browser.
fn is_key_value(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('/')
        && (looks_like_xrp_secret(value) || is_base58_keypair(value) || is_json_keypair(value))
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
            out.push_str("<span class=\"breadcrumbs__sep\" aria-hidden=\"true\">/</span>");
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
         <a class=\"brand\" href=\"/\"><span class=\"brand-mark\">{key}</span><span class=\"brand-name\">Crypto<span>.</span></span></a>\
         <nav aria-label=\"Main\">\
         <a href=\"/\" data-nav=\"home\">{grid}<span>Home</span></a>\
         <a href=\"/private-keys\" data-nav=\"directory\">{key2}<span>Directory</span></a>\
         <a href=\"/mnemonic-seeds\" data-nav=\"seeds\">{seed}<span>Seeds</span></a>\
         <a href=\"/bitcoin-puzzle\" data-nav=\"puzzle\">{puzzle}<span>Puzzle</span></a>\
         <a href=\"/vanity\" data-nav=\"vanity\">{vanity}<span>Vanity</span></a>\
         <a href=\"/milk-sad\" data-nav=\"milk-sad\">{shield}<span>Milk Sad</span></a>\
         <a href=\"/tools\" data-nav=\"tools\">{tools}<span>Tools</span></a>\
         <a href=\"/docs\" data-nav=\"docs\">{book}<span>Docs</span></a>\
         </nav>\
         <div class=\"nav-tools\">\
         <a class=\"icon-button icon-button--quiet icon-button--lg\" href=\"/key\" data-nav=\"search\" aria-label=\"Search wallet\" data-tooltip=\"Search wallet\">{search}</a>\
         <a class=\"chip chip--primary\" href=\"/cabinet\" data-nav=\"cabinet\" aria-label=\"Cabinet\">{wallet}<span>Cabinet</span></a>\
         </div></header>",
        key = ui_icon("ui-rotor", "icon"),
        grid = ui_icon("ui-grid", "icon"),
        key2 = ui_icon("ui-key", "icon"),
        seed = ui_icon("ui-key", "icon"),
        puzzle = ui_icon("ui-puzzle", "icon"),
        vanity = ui_icon("ui-tools", "icon"),
        shield = ui_icon("ui-shield", "icon"),
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

/// Current static-asset query token. It is also printed in the footer so a
/// visitor can name the build they see; keep it in step with `?v=` everywhere.
const ASSET_VERSION: &str = "20261128b";
const REPOSITORY_URL: &str = "https://github.com/mytab0r/Rotor-Cuda";

/// One marketing footer for every public content page. The app and cabinet
/// shells intentionally omit it (`is_app_shell`), and `with_site_footer`
/// inserts it once for both static and generated HTML.
fn site_footer() -> String {
    format!(
        "<footer class=\"site-footer\">\
         <nav aria-label=\"Footer\">\
         <a href=\"/faq\">FAQ</a>\
         <a href=\"/disclaimer\">Disclaimer</a>\
         <a href=\"/donate\">Donate</a>\
         <a href=\"/docs\">Docs</a>\
         <a href=\"{REPOSITORY_URL}\" rel=\"noopener noreferrer\">GitHub</a>\
         </nav>\
         <div class=\"site-footer__meta\"><span>© 2026 Crypto</span><span>v{ASSET_VERSION}</span></div>\
         </footer>"
    )
}

fn is_app_shell(path: &str) -> bool {
    matches!(
        path,
        "/app" | "/run" | "/me" | "/cabinet" | "/cabinet/wallet"
    )
}

/// Add the shared footer to a served HTML document unless it is an app shell
/// or already carries one. Fails safe (returns the input) when `</body>` is
/// missing so a malformed page is not silently rewritten.
fn with_site_footer(path: &str, html: String) -> String {
    if is_app_shell(path)
        || html.contains("<footer class=\"site-footer\"")
        || !html.contains("</body>")
    {
        return html;
    }
    html.replacen("</body>", &format!("{}\n</body>", site_footer()), 1)
}

fn html_document(title: &str, head_extra: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n\
         <link rel=\"stylesheet\" href=\"/site.css?v=20261128b\">\n\
         <script src=\"/theme.js?v=20261128b\"></script>\n\
         {head_extra}</head>\n<body>\n{body}\n{footer}\n<script src=\"/search.js?v=20261128b\"></script>\n<script src=\"/site.js?v=20261128b\"></script>\n</body>\n</html>\n",
        escape_attr(title),
        footer = site_footer(),
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
        "<title>Crypto - private key explorer</title>",
        &format!("<title>{title} | Crypto</title>"),
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
        "Derives automatically as you type: 64 hex characters (optional 0x), a decimal integer, a Bitcoin WIF, a Solana keypair JSON array, or any other text as a brainwallet phrase (key = SHA-256 of the text). The key stays in memory only and is cleared when you leave the page.",
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
    let title = format!("Private key {short} — Bitcoin, EVM, Solana and TRON addresses | Crypto");
    let description = format!(
        "Derive Bitcoin, EVM and TRON addresses from private key {short} in your browser. Crypto shows public addresses only; the key is never sent to a server."
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
        "<title>Crypto - private key explorer</title>",
        &format!("<title>{}</title>", escape_attr(&title)),
        1,
    );
    html = html.replacen("</head>", &format!("{head}</head>"), 1);
    html = html.replacen(
        "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\"><a href=\"/\">Home</a> <span class=\"breadcrumbs__sep\" aria-hidden=\"true\">/</span> <a href=\"/tools\">Tools</a> <span class=\"breadcrumbs__sep\" aria-hidden=\"true\">/</span> <span aria-current=\"page\">Key explorer</span></nav>",
        &crumbs,
        1,
    );
    replace_site_nav(html.replacen(
        "<script src=\"/key.js",
        &format!("{payload}<script src=\"/key.js"),
        1,
    ))
}

fn render_key_value_page(_base: &str, value: &str, curve: &str) -> String {
    let title = "Private key details | Crypto";
    let encoded = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned());
    let payload = format!(
        "<script>window.__ROTOR_KEY__={encoded};window.__ROTOR_CURVE__=\"{curve}\";</script>\n"
    );
    let mut html = KEY_PAGE.replacen(
        "<title>Crypto - private key explorer</title>",
        &format!("<title>{title}</title>"),
        1,
    );
    html = html.replacen(
        "</head>",
        "<meta name=\"robots\" content=\"noindex,nofollow\">\n</head>",
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
    let title = format!(
        "{} keys {label} — {} keys | Crypto",
        chain.name, range.count
    );
    let description = format!(
        "{} private keys from 0x{start_short}… to 0x{end_short}… (inclusive), derived locally in your browser. Crypto shows public addresses only; the keys are never sent to a server.",
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
        "<title>Crypto - key range</title>",
        &format!("<title>{}</title>", escape_attr(&title)),
        1,
    );
    html = html.replacen("</head>", &format!("{head}</head>"), 1);
    html = html.replacen(
        "<nav class=\"breadcrumbs\" id=\"range-breadcrumbs\" aria-label=\"Breadcrumb\"></nav>",
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
    let title = "Private keys directory — browse keys on 18 chains | Crypto";
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
    let crumbs = breadcrumb_nav(&[("Home", Some("/")), ("Chains", None)]);
    let body = format!(
        "{}{}<main class=\"directory-page\">{crumbs}\
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

const FAQ_TITLE: &str = "FAQ — how Crypto key tools and alerts work | Crypto";
const FAQ_DESCRIPTION: &str = "Answers about Crypto's browser key derivation, the /keys hubs, noindex pages, the address watchlist and Telegram alerts, and what the tools cannot do.";

/// Honest Q&A used both for the visible FAQ and its `FAQPage` JSON-LD.
const FAQ_QA: [(&str, &str); 9] = [
    (
        "What does this site do?",
        "Crypto explains how private keys map to public addresses on Bitcoin, Ethereum, TRON, Solana, Litecoin, Dogecoin, Bitcoin Cash and XRP. It derives addresses from a key you control in your browser and runs an authorized puzzle search engine and an address watchlist. It does not hold, sign for or move funds.",
    ),
    (
        "Is my key sent to a server?",
        "No. Derivation runs locally with WebAssembly in your browser. The page does not receive, log or transmit the key, and the site never asks for a seed phrase.",
    ),
    (
        "Do you ask for seed phrases?",
        "No. The web tools accept single private keys only, for educational use. There is no custody: Crypto cannot hold funds, sign transactions or sweep balances.",
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
        "Deriving an address from a key does not prove that the address is observable, funded, used or known to anyone else. You cannot derive a private key from an address, and Crypto cannot know whether a key was used somewhere else.",
    ),
    (
        "Can I use this to find or recover someone else's keys?",
        "No. Use Crypto only for keys and addresses you own or are explicitly authorized to test, such as public puzzles and research. Deriving a key does not give lawful access to funds.",
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
         <p>How Crypto derives addresses, what the key pages show, and what the tools cannot do.</p></section>\
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

const DISCLAIMER_TITLE: &str = "Disclaimer — educational and authorized use | Crypto";
const DISCLAIMER_DESCRIPTION: &str = "Crypto is provided for education, research and authorized testing only. It is not a wallet, holds no funds, signs nothing, and cannot sweep balances.";

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
         <p>Crypto is an educational and research tool. Read this page before using any key or address feature.</p></section>\
         <section class=\"card\"><h2>Educational and authorized use only</h2>\
         <p>The site explains how keys map to addresses and lets you test that mapping. Use it only with keys and addresses you own or are explicitly authorized to test, such as public puzzles and security research. Do not use it to access funds you do not control.</p></section>\
         <section class=\"card\"><h2>No custody, signing or sweeping</h2>\
         <p>Crypto is not a wallet. It does not hold funds, sign transactions, broadcast transfers or sweep balances, and it never asks for a seed phrase. Any signing or transaction feature is separate and gated; nothing on these pages moves value.</p></section>\
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

const DONATE_TITLE: &str = "Donate — support Crypto development | Crypto";
const DONATE_DESCRIPTION: &str = "Maintainer donation addresses for Crypto: Bitcoin, USDT-TRC20 and EVM, plus a hosted payment link. Select an address and copy it in your browser.";

fn render_donate(base: &str) -> String {
    let canonical = format!("{base}/donate");
    let ld_crumbs = breadcrumb_ld(base, &[("Home", Some("/")), ("Donate", Some("/donate"))]);
    let head = hub_head(&canonical, DONATE_TITLE, DONATE_DESCRIPTION, &[ld_crumbs]);
    let body = format!(
        "{}{}<main class=\"key-page\">{}<section class=\"hero\">\
         <h1>Donate</h1>\
         <p>Support maintenance of Crypto. These are the maintainer's own addresses; select an address to copy it with your browser.</p></section>\
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

const BRAINWALLET_TITLE: &str = "Brainwallet directory — 18,890 passphrases on 18 chains | Crypto";
const BRAINWALLET_DESCRIPTION: &str = "Browse 18,890 deterministic two-word brainwallet passphrases on 18 chains, 60 per page. SHA-256 keys and chain addresses are derived locally in your browser; balance checks are optional. Brainwallets are unsafe for real funds.";
const BRAINWALLET_GENERATOR_TITLE: &str =
    "Brainwallet generator — passphrase to key and address | Crypto";
const BRAINWALLET_GENERATOR_DESCRIPTION: &str = "Turn one passphrase into its SHA-256 key and an address on 18 chains. Choose one, three, five or ten addresses, copy the WIF, copy all or download CSV. Brainwallets are unsafe for real funds.";
const BRAINWALLET_CORPUS_SIZE: u32 = 18_890;
const BRAINWALLET_ROWS_PER_PAGE: u32 = 60;
const BRAINWALLET_TOTAL_PAGES: u32 = BRAINWALLET_CORPUS_SIZE.div_ceil(BRAINWALLET_ROWS_PER_PAGE);
const BRAINWALLET_WARNING: &str = "Brainwallets are unsafe for real funds. A phrase people can remember is guessable and such keys are swept quickly. Use only throwaway phrases you are authorized to test; never a phrase that protects funds.";

fn brainwallet_page_href(slug: &str, page: u32) -> String {
    if page <= 1 {
        format!("/brainwallet/{slug}")
    } else {
        format!("/brainwallet/{slug}/{page}")
    }
}

fn brainwallet_chain_tabs(active: Option<&str>) -> String {
    let mut out = String::from(
        "<div class=\"chain-tabs\" id=\"brainwallet-chain-tabs\" role=\"navigation\" aria-label=\"Chains\">",
    );
    for chain in &CHAINS {
        let is_active = active == Some(chain.slug);
        out.push_str(&format!(
            "<a class=\"chain-tab chip{}\" href=\"/brainwallet/{}\" style=\"--chain:{}\"{}>{}{}</a>",
            if is_active { " active" } else { "" },
            chain.slug,
            chain.color,
            if is_active {
                " aria-current=\"page\""
            } else {
                ""
            },
            chain_icon(chain, "chain-tab-icon"),
            chain.name,
        ));
    }
    out.push_str("</div>");
    out
}

fn brainwallet_pager(slug: &str, page: u32) -> String {
    let previous = page.saturating_sub(1).max(1);
    let next = (page + 1).min(BRAINWALLET_TOTAL_PAGES);
    let at_first = page <= 1;
    let at_last = page >= BRAINWALLET_TOTAL_PAGES;
    format!(
        "<nav class=\"pager\" aria-label=\"Directory pages\">\
         <a class=\"pager-btn\" data-bw-first href=\"{}\" aria-disabled=\"{}\">{}First</a>\
         <a class=\"pager-btn\" data-bw-prev href=\"{}\" aria-disabled=\"{}\">{}Previous</a>\
         <a class=\"pager-btn pager-btn--random\" data-bw-random href=\"{}\" aria-disabled=\"false\">{}Random</a>\
         <a class=\"pager-btn\" data-bw-next href=\"{}\" aria-disabled=\"{}\">Next{}</a>\
         <a class=\"pager-btn\" data-bw-last href=\"{}\" aria-disabled=\"{}\">Last{}</a>\
         </nav>",
        brainwallet_page_href(slug, 1),
        at_first,
        ui_icon("ui-first", "icon"),
        brainwallet_page_href(slug, previous),
        at_first,
        ui_icon("ui-prev", "icon"),
        brainwallet_page_href(slug, page),
        ui_icon("ui-random", "icon"),
        brainwallet_page_href(slug, next),
        at_last,
        ui_icon("ui-next", "icon"),
        brainwallet_page_href(slug, BRAINWALLET_TOTAL_PAGES),
        at_last,
        ui_icon("ui-last", "icon"),
    )
}

fn brainwallet_jump(suffix: &str, page: u32) -> String {
    format!(
        "<form class=\"page-jump bw-jump\">\
         <label for=\"brainwallet-page-input-{suffix}\">Page</label>\
         <input id=\"brainwallet-page-input-{suffix}\" inputmode=\"numeric\" autocomplete=\"off\" value=\"{page}\">\
         <button type=\"submit\" class=\"primary\">Jump {}</button>\
         </form>",
        ui_icon("ui-arrow-right", "icon"),
    )
}

fn brainwallet_pager_block(slug: &str, page: u32, suffix: &str) -> String {
    format!(
        "<section class=\"browse-controls bw-pager-block\">{} {}</section>",
        brainwallet_pager(slug, page),
        brainwallet_jump(suffix, page),
    )
}

fn brainwallet_warning() -> String {
    format!("<p class=\"notice brainwallet-warning\" role=\"note\">{BRAINWALLET_WARNING}</p>")
}

fn brainwallet_address_types(chain: &ChainHub) -> String {
    let types = chain.kind.types();
    if types.len() <= 1 {
        return String::new();
    }
    let mut out = String::from(
        "<div class=\"bw-controls\"><span class=\"bw-type-label\">Address type</span>\
         <div class=\"bw-type-tabs\" role=\"group\" aria-label=\"Bitcoin address type\">",
    );
    for (index, kind) in types.iter().enumerate() {
        out.push_str(&format!(
            "<button type=\"button\" class=\"bw-type-btn{}\" data-type=\"{}\" aria-pressed=\"{}\">{}</button>",
            if index == 0 { " active" } else { "" },
            kind.value,
            index == 0,
            kind.label,
        ));
    }
    out.push_str(
        "</div><a class=\"bw-generator-link\" href=\"/brainwallet-generator\">One passphrase? Open the generator</a></div>",
    );
    out
}

fn render_brainwallet_index(base: &str) -> String {
    let canonical = format!("{base}/brainwallet");
    let ld_crumbs = breadcrumb_ld(
        base,
        &[
            ("Home", Some("/")),
            ("Tools", Some("/tools")),
            ("Brainwallet", Some("/brainwallet")),
        ],
    );
    let mut head = hub_head(
        &canonical,
        BRAINWALLET_TITLE,
        BRAINWALLET_DESCRIPTION,
        &[ld_crumbs],
    );
    head.push_str("<link rel=\"stylesheet\" href=\"/brainwallet.css?v=20261128b\">\n");
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Tools", Some("/tools")),
        ("Brainwallet", None),
    ]);
    let mut cards = String::new();
    for chain in &CHAINS {
        cards.push_str(&format!(
            "<a class=\"chain-card directory-card\" href=\"/brainwallet/{}\" style=\"--chain:{}\" title=\"{} brainwallet directory\">\
             <span class=\"chain-icon-wrap\">{}</span>\
             <span class=\"chain-name\">{}</span>\
             <span class=\"chain-meta\">{} · 18,890 passphrases</span>\
             </a>",
            chain.slug,
            chain.color,
            escape_attr(chain.name),
            chain_icon(chain, "chain-card-icon"),
            chain.name,
            chain.symbol,
        ));
    }
    let body = format!(
        "{}<main class=\"browse-page brainwallet-page brainwallet-index\">\
         {crumbs}\
         <section class=\"browse-hero\">\
           <div class=\"browse-hero-title\"><svg class=\"browse-hero-icon\" aria-hidden=\"true\"><use href=\"/icons.svg#ui-key\"></use></svg><h1>Brainwallet directory</h1></div>\
           <p>18,890 deterministic two-word passphrases across 18 chains, 60 per page. Pick a chain, derive its addresses locally and optionally check public balances.</p>\
           <span class=\"bw-index-count\">18,890 passphrases · 315 pages per chain · 18 chains</span>\
         </section>\
         {warning}\
         <section class=\"directory-links\">\
           <a href=\"/brainwallet-generator\">Brainwallet generator</a>\
           <a href=\"/key\">Key calculator</a>\
           <a href=\"/seed\">Seed phrase</a>\
           <a href=\"/private-keys\">Private key directory</a>\
         </section>\
         <div class=\"chain-grid directory-grid\">{cards}</div>\
         <section class=\"card brainwallet-index-note\">\
           <h2>How the directory works</h2>\
           <p>Each chain page enumerates the same deterministic corpus: two words from a fixed 138-word list, sliced to 18,890 unique phrases and split into 315 pages of 60 rows. The page hashes each phrase with SHA-256 in your browser, derives the chain address with the shared WebAssembly core, and can check public balances.</p>\
           <p>The passphrase, SHA-256 key and derived private keys never leave the page. They are not stored, not put in the URL, and are cleared when you leave. Balance lookups send only the public address, and only when the visible toggle is on. Use the <a href=\"/brainwallet-generator\">generator</a> for a single passphrase of your own.</p>\
         </section>\
         <aside class=\"edu-note\"><strong>Educational purpose.</strong> Finding a funded brainwallet by enumeration is infeasible. These pages are a derivation reference, not a wallet and not a recovery service.</aside>\
         </main>",
        site_header(),
        warning = brainwallet_warning(),
    );
    html_document(BRAINWALLET_TITLE, &head, &body)
}

fn render_brainwallet_directory(base: &str, chain: &ChainHub, requested: &str) -> String {
    let page = parse_page_number(requested)
        .and_then(|value| value.to_u32())
        .unwrap_or(1)
        .clamp(1, BRAINWALLET_TOTAL_PAGES);
    let self_url = format!("{base}{}", brainwallet_page_href(chain.slug, page));
    let title = if page == 1 {
        format!(
            "{} brainwallet directory — 60 passphrases per page | Crypto",
            chain.name
        )
    } else {
        format!(
            "{} brainwallet directory — page {} of {} | Crypto",
            chain.name, page, BRAINWALLET_TOTAL_PAGES
        )
    };
    let description = format!(
        "Browse 18,890 deterministic {} brainwallet passphrases, 60 per page. SHA-256 keys and addresses are derived locally in your browser; balance checks are optional. Page {} of {}.",
        chain.name, page, BRAINWALLET_TOTAL_PAGES
    );
    let robots = if page == 1 {
        "index,follow"
    } else {
        "noindex,follow"
    };
    let curve = chain.kind.curve();
    let initial_type = chain
        .kind
        .types()
        .first()
        .map(|kind| kind.value)
        .unwrap_or("legacy");
    let ld_app = json!({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": format!("{} brainwallet directory", chain.name),
        "url": self_url,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires JavaScript and WebAssembly",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "description": description,
    });
    let chain_path = format!("/brainwallet/{}", chain.slug);
    let ld_crumbs = breadcrumb_ld(
        base,
        &[
            ("Home", Some("/")),
            ("Brainwallet", Some("/brainwallet")),
            (chain.name, Some(chain_path.as_str())),
        ],
    );
    let head = format!(
        "<meta name=\"description\" content=\"{}\">\n\
         <link rel=\"canonical\" href=\"{}\">\n\
         <meta name=\"robots\" content=\"{}\">\n\
         <meta property=\"og:type\" content=\"website\">\n\
         <meta property=\"og:title\" content=\"{}\">\n\
         <meta property=\"og:description\" content=\"{}\">\n\
         <meta property=\"og:url\" content=\"{}\">\n\
         <link rel=\"stylesheet\" href=\"/brainwallet.css?v=20261128b\">\n\
         {}{}",
        escape_attr(&description),
        escape_attr(&self_url),
        robots,
        escape_attr(&title),
        escape_attr(&description),
        escape_attr(&self_url),
        json_ld(&ld_app),
        json_ld(&ld_crumbs),
    );
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Brainwallet", Some("/brainwallet")),
        (chain.name, None),
    ]);
    let body = format!(
        "{}<main class=\"browse-page brainwallet-page brainwallet-directory\" \
         data-chain=\"{}\" data-symbol=\"{}\" data-explorer=\"{}\" data-curve=\"{}\" \
         data-page=\"{}\" data-type=\"{}\" style=\"--chain:{}\">\
         {crumbs}\
         <section class=\"browse-hero\">\
           <div class=\"browse-hero-title\">{icon}<h1>{} brainwallet directory</h1></div>\
           <p>Deterministic two-word passphrases, 60 per page. Each row shows its SHA-256 private key, the {} address and an optional public balance. Everything is derived in this browser.</p>\
         </section>\
         {warning}\
         {tabs}\
         <section class=\"page-info\">\
           <div class=\"page-info-text\">\
             <svg class=\"page-info-icon\" aria-hidden=\"true\"><use href=\"/icons.svg#ui-key\"></use></svg>\
             <span>Page <strong id=\"brainwallet-page-number\">#{page}</strong> of <strong id=\"brainwallet-total-pages\">#{total_pages}</strong> (<strong id=\"brainwallet-total-count\">18,890</strong> passphrases)</span>\
             <span class=\"page-percent\" id=\"brainwallet-page-percent\"></span>\
           </div>\
           <div class=\"progress-track\" id=\"brainwallet-page-progress\" role=\"progressbar\" aria-label=\"Position in the corpus\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"0\"><span id=\"brainwallet-page-bar\" style=\"width:0%\"></span></div>\
         </section>\
         {pager_top}\
         {types}\
         <section class=\"balance-summary\" aria-label=\"Balance summary\">\
           <div class=\"stat-card\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\" id=\"brainwallet-total-balance\">—</span></div>\
           <div class=\"stat-card\"><span class=\"stat-label\">Active</span><span class=\"stat-value\" id=\"brainwallet-total-active\">—</span></div>\
           <div class=\"stat-card\"><span class=\"stat-label\">Received</span><span class=\"stat-value\" id=\"brainwallet-total-received\">—</span></div>\
           <div class=\"stat-card\"><span class=\"stat-label\">Transactions</span><span class=\"stat-value\" id=\"brainwallet-total-tx\">—</span></div>\
           <p class=\"balance-note\" id=\"brainwallet-note\"><label class=\"bw-auto-balance\"><input type=\"checkbox\" id=\"brainwallet-balance-toggle\" checked> Check balances for BTC and EVM rows after deriving.</label> <span class=\"bw-badge\" id=\"brainwallet-balance-badge\" data-state=\"on\">auto</span> <span id=\"brainwallet-note-text\">Public addresses only; passphrases and keys stay in this browser.</span></p>\
         </section>\
         <section class=\"keys-panel\">\
           <div class=\"keys-header bw-rows-header\">\
             <div>Private key / passphrase</div>\
             <div>Address</div>\
             <div class=\"bw-balance\">Balance</div>\
           </div>\
           <div id=\"brainwallet-rows\" class=\"bw-rows\"></div>\
           <div class=\"bw-derive\">\
             <span class=\"bw-derive-text\" id=\"brainwallet-derive-text\">Preparing the derivation core…</span>\
             <div class=\"progress-track\" role=\"progressbar\" aria-label=\"Derivation progress\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"0\" id=\"brainwallet-derive-progress\"><span id=\"brainwallet-derive-bar\" style=\"width:0%\"></span></div>\
           </div>\
         </section>\
         {pager_bottom}\
         <p class=\"browse-footnote\">These are deterministic test passphrases, not a wallet. Nothing is signed or swept. Balance checks send only the derived public addresses to a public provider; passphrases and private keys never leave this page, are not stored and are cleared when you leave.</p>\
         </main>\
         <script src=\"/brainwallet-engine.js?v=20261128b\" defer></script>\
         <script src=\"/brainwallet-directory.js?v=20261128b\" defer></script>",
        site_header(),
        escape_attr(chain.slug),
        escape_attr(chain.symbol),
        escape_attr(chain.explorer),
        curve,
        page,
        escape_attr(initial_type),
        escape_attr(chain.color),
        chain.name,
        chain.name,
        warning = brainwallet_warning(),
        tabs = brainwallet_chain_tabs(Some(chain.slug)),
        pager_top = brainwallet_pager_block(chain.slug, page, "top"),
        types = brainwallet_address_types(chain),
        pager_bottom = brainwallet_pager_block(chain.slug, page, "bottom"),
        icon = chain_icon(chain, "browse-hero-icon"),
        total_pages = BRAINWALLET_TOTAL_PAGES,
    );
    html_document(&title, &head, &body)
}

fn render_brainwallet_generator(base: &str) -> String {
    let canonical = format!("{base}/brainwallet-generator");
    let ld_crumbs = breadcrumb_ld(
        base,
        &[
            ("Home", Some("/")),
            ("Brainwallet", Some("/brainwallet")),
            ("Generator", Some("/brainwallet-generator")),
        ],
    );
    let mut head = hub_head(
        &canonical,
        BRAINWALLET_GENERATOR_TITLE,
        BRAINWALLET_GENERATOR_DESCRIPTION,
        &[ld_crumbs],
    );
    head.push_str("<link rel=\"stylesheet\" href=\"/brainwallet.css?v=20261128b\">\n");
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Brainwallet", Some("/brainwallet")),
        ("Generator", None),
    ]);
    let mut options = String::new();
    for chain in &CHAINS {
        options.push_str(&format!(
            "<option value=\"{}\">{} ({})</option>",
            escape_attr(chain.slug),
            escape_attr(chain.name),
            escape_attr(chain.symbol),
        ));
    }
    let body = format!(
        "{}<main class=\"key-page brainwallet-generator\">\
         {crumbs}\
         <section class=\"hero\">\
           <h1>Brainwallet generator</h1>\
           <p>Turn one passphrase into its SHA-256 private key and an address on any of 18 chains. Pick one, three, five or ten addresses; everything is derived in this browser.</p>\
         </section>\
         {warning}\
         <section class=\"card\" aria-label=\"Passphrase input\">\
           <h2>Passphrase</h2>\
           <form id=\"brainwallet-form\" class=\"key-form\" autocomplete=\"off\" data-brain-mode=\"generator\">\
             <div class=\"bw-form-grid\">\
               <label>Network<select id=\"brainwallet-network\" class=\"mono\">{options}</select></label>\
               <label>Passphrase<input id=\"brainwallet-input\" type=\"password\" class=\"mono\" autocomplete=\"new-password\" spellcheck=\"false\" autocapitalize=\"off\" data-lpignore=\"true\" data-1p-ignore=\"true\" aria-describedby=\"brainwallet-help\"></label>\
               <label>Addresses<select id=\"brainwallet-count\"><option value=\"1\" selected>1</option><option value=\"3\">3</option><option value=\"5\">5</option><option value=\"10\">10</option></select></label>\
             </div>\
             <div class=\"bw-actions\">\
               <button type=\"submit\" class=\"primary\" id=\"brainwallet-derive\">Generate &amp; Check Balance</button>\
               <button type=\"button\" id=\"brainwallet-generate\" title=\"Fill a random test phrase; nothing is derived until you press Generate\">Generate random phrase</button>\
               <button type=\"button\" id=\"brainwallet-clear\" title=\"Clear the phrase and results\">Clear</button>\
             </div>\
             <label class=\"bw-auto-balance\"><input type=\"checkbox\" id=\"brainwallet-auto-balance\"> Check the public balance for BTC and EVM after generating (opt-in; sends only the public address)</label>\
           </form>\
           <p id=\"brainwallet-help\" class=\"muted key-help\">The key is SHA-256 of the UTF-8 phrase, exactly like the key search brainwallet path. Extra addresses use key + n and are labelled. The phrase stays in this browser, is never stored and is never put in the URL; results are cleared when you leave.</p>\
           <p id=\"brainwallet-status\" class=\"muted key-help\" role=\"status\" hidden></p>\
           <p id=\"brainwallet-error\" class=\"error brainwallet-error\" role=\"alert\" hidden></p>\
         </section>\
         <section class=\"card\" aria-label=\"Results\">\
           <div class=\"brainwallet-results-head\">\
             <button type=\"button\" id=\"brainwallet-copy-all\" disabled>Copy all</button>\
             <button type=\"button\" id=\"brainwallet-csv\" disabled>Download CSV</button>\
           </div>\
           <div id=\"brainwallet-results\" class=\"mono\">Enter a throwaway passphrase and press Generate.</div>\
         </section>\
         <p class=\"browse-footnote\">Browse the full corpus in the <a href=\"/brainwallet\">brainwallet directory</a>, inspect one key in the <a href=\"/key\">key calculator</a>, or convert a seed in the <a href=\"/seed\">seed tool</a>.</p>\
         </main>\
         <script src=\"/brainwallet-engine.js?v=20261128b\" defer></script>\
         <script src=\"/brainwallet.js?v=20261128b\" defer></script>",
        site_header(),
        warning = brainwallet_warning(),
    );
    html_document(BRAINWALLET_GENERATOR_TITLE, &head, &body)
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
            "{} private keys — browse addresses and balances | Crypto",
            chain.name
        )
    } else {
        format!(
            "{} private keys — page {} of {} | Crypto",
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
        // The donor's chain tabs default TON and Bitcoin Cash to the legacy
        // address type with an explicit `?type=legacy`; the other 16 chains
        // link to the bare slug.
        let href = match other.slug {
            "ton" | "bitcoin-cash" => format!("/private-keys/{}?type=legacy", other.slug),
            _ => format!("/private-keys/{}", other.slug),
        };
        tabs.push_str(&format!(
            "<a class=\"chain-tab chip{active}\" href=\"{href}\" style=\"--chain:{}\">{}<span>{}</span></a>",
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
             <button type=\"button\" class=\"icon-button icon-button--quiet icon-button--lg copy-btn\" data-copy=\"{hex}\" aria-label=\"Copy private key\" data-tooltip=\"Copy private key\">{copy}</button>\
             </div>\
             <div class=\"col-address\"><span class=\"cell-skeleton\">Calculating…</span></div>\
             <div class=\"col-balance\"><span class=\"cell-skeleton\">—</span></div>\
             </div>",
            copy = ui_icon("ui-copy", "icon"),
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
        // The donor's Bitcoin search select spells the address prefix out.
        let label = match (chain.slug, kind.value) {
            ("bitcoin", "legacy") => "Legacy (1...)",
            ("bitcoin", "segwit") => "SegWit (bc1q...)",
            ("bitcoin", "script") => "Nested (3...)",
            ("bitcoin", "taproot") => "Taproot (bc1p...)",
            _ => kind.label,
        };
        search_options.push_str(&format!(
            "<option value=\"{}\"{}>{}</option>",
            kind.value,
            if kind.value == active_type.value {
                " selected"
            } else {
                ""
            },
            label
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
    let first_disabled = page == page_one;
    let prev_disabled = first_disabled;
    let next_disabled = page >= total;
    let last_disabled = next_disabled;
    let random = random_page(chain);
    let curve_data = chain.kind.curve();
    let retry_icon = ui_icon("ui-retry", "icon");
    // The donor labels the balance column with the coin, not the chain.
    let balance_label = if chain.slug == "bitcoin" {
        "BTC"
    } else {
        chain.name
    };
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Private Keys", Some("/private-keys")),
        (chain.name, None),
    ]);
    // UTXO chains keep the donor's Balance / Received / TX row; account-model
    // chains show Balance / Active instead.
    let (summary_class, summary_cards) = if chain.kind.is_utxo() {
        (
            "balance-summary",
            "<div class=\"stat-card\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\" id=\"total-balance\">—</span></div>\
             <div class=\"stat-card\"><span class=\"stat-label\">Received</span><span class=\"stat-value\" id=\"total-received\">—</span></div>\
             <div class=\"stat-card\"><span class=\"stat-label\">TX</span><span class=\"stat-value\" id=\"total-tx\">—</span></div>",
        )
    } else {
        (
            "balance-summary balance-summary--account",
            "<div class=\"stat-card\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\" id=\"total-balance\">—</span></div>\
             <div class=\"stat-card\"><span class=\"stat-label\">Active</span><span class=\"stat-value\" id=\"total-active\">—</span></div>",
        )
    };

    let body = format!(
        "{}{}<main class=\"browse-page\" style=\"--chain:{}\" data-chain=\"{}\" data-symbol=\"{}\" data-explorer=\"{}\" data-type=\"{}\" data-field=\"{}\" data-curve=\"{}\" data-pages=\"{}\" data-page=\"{}\">\
         {crumbs}\
         <h1 class=\"visually-hidden\">{} private keys</h1>\
         <div class=\"chain-tabs\" role=\"navigation\" aria-label=\"Chains\">{tabs}</div>\
         <section class=\"page-info\">\
           <div class=\"page-info-text\">{}<span>{} keys page <strong>#{}</strong> out of <strong>#{}</strong></span><span class=\"page-percent\">{}</span></div>\
           <div class=\"progress-track\" role=\"progressbar\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"{}\"><span style=\"width:{}\"></span></div>\
         </section>\
         <section class=\"browse-controls\">\
           <nav class=\"pager\" aria-label=\"Key pages\">\
             <a class=\"pager-btn\" href=\"{}\" aria-disabled=\"{}\">{} First</a>\
             <a class=\"pager-btn\" href=\"{}\" aria-disabled=\"{}\">{} Previous</a>\
             <a class=\"pager-btn pager-btn--random\" href=\"{}\" aria-disabled=\"false\">{} Random</a>\
             <a class=\"pager-btn\" href=\"{}\" aria-disabled=\"{}\">Next {}</a>\
             <a class=\"pager-btn\" href=\"{}\" aria-disabled=\"{}\">Last {}</a>\
           </nav>\
           <form class=\"page-jump\" id=\"browse-jump\">\
             <label for=\"browse-page-input\">Page</label>\
             <input id=\"browse-page-input\" inputmode=\"numeric\" autocomplete=\"off\" value=\"{}\">\
             <button type=\"submit\" class=\"primary\">Jump {}</button>\
           </form>\
         </section>\
         <section class=\"search-panel\">\
           <form id=\"browse-search\" class=\"browse-search\">\
             <div class=\"search-leading\">{}</div>\
             <input id=\"browse-search-input\" type=\"text\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"HEX, WIF (5/K/L), or Brainwallet\" aria-label=\"Search a private key, WIF or brainwallet\">\
             {search_select}\
             <button type=\"submit\" class=\"primary\">{} Search</button>\
           </form>\
           <p class=\"search-hint\">Supports 64-char HEX, WIF (5.../K.../L...), or any text as brainwallet</p>\
         </section>\
         <section class=\"{summary_class}\" aria-label=\"Balance summary\">\
           {summary_cards}\
           <div class=\"balance-refresh\">\
             <button type=\"button\" class=\"balance-refresh-btn\" id=\"balance-refresh\" aria-label=\"Refresh 0 failed or stale balances\" disabled>{retry_icon}<span>Refresh failed / stale</span><span class=\"balance-refresh-count\" id=\"balance-refresh-count\" aria-hidden=\"true\">0</span></button>\
             <span class=\"visually-hidden\" id=\"balance-refresh-status\" role=\"status\" aria-atomic=\"true\"></span>\
           </div>\
           <p class=\"balance-note\" id=\"balance-note\">Balances are checked in your browser for the addresses on this page.</p>\
         </section>\
         {type_selector}\
         <section class=\"keys-panel\">\
           <div class=\"keys-header\"><div class=\"col-key\">{} Private Key</div><div class=\"col-address\">{} Address</div><div class=\"col-balance\">{} {balance_label} Balance</div></div>\
           <div id=\"keys-container\">{rows}</div>\
         </section>\
         <p class=\"browse-range-link\"><a href=\"/keys/{}/{curated_start}-{curated_end}\">Open the curated 1–64 key range</a></p>\n         <p class=\"browse-footnote\">These are deterministic example keys, not a wallet. Nothing is signed or swept. Balance checks send the derived public addresses to a public chain data provider; the private key never leaves this page. Only search keys and funds you are authorized to use.</p>\
         </main>\n         <script src=\"/balance-cache.js?v=20261128b\"></script>\n         <script src=\"/browse.js?v=20261128b\"></script>",
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
        chain_icon(chain, "page-info-icon"),
        chain.name,
        page_text,
        total_text,
        percent,
        percent,
        percent,
        browse_page_href(chain, &page_one, active_type.value),
        first_disabled,
        ui_icon("ui-first", "icon"),
        browse_page_href(chain, &prev, active_type.value),
        prev_disabled,
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
        next_disabled,
        ui_icon("ui-next", "icon"),
        browse_page_href(chain, &total, active_type.value),
        last_disabled,
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
        "<span class=\"pz-pill solved\">Solved</span>".to_string()
    } else {
        "<span class=\"pz-pill\">Unsolved</span>".to_string()
    }
}

/// Classic puzzle funding: puzzle `n` holds `n * 0.1 BTC`.
///
/// The 2015 puzzle transaction funds address `n` with `n` tenths of a coin, so
/// the solved/unsolved split also yields the claimed/remaining prize totals.
fn puzzle_prize_btc(number: u32) -> f64 {
    f64::from(number) / 10.0
}

fn puzzle_prize_sum_btc(solved: bool) -> f64 {
    puzzles::all()
        .filter(|item| item.solved == solved)
        .map(|item| puzzle_prize_btc(item.number))
        .sum()
}

fn format_btc(value: f64) -> String {
    format!("{value:.1} BTC")
}

fn group_digits(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + value.len() / 3);
    let len = value.len();
    for (index, byte) in value.bytes().enumerate() {
        if index > 0 && (len - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(byte as char);
    }
    out
}

/// Number of scalar values in puzzle `n` as grouped decimal digits.
fn puzzle_keyspace_decimal(number: u32) -> String {
    let keys = BigUint::from(1u8) << (number - 1);
    group_digits(&keys.to_string())
}

fn pz_copy_button(value: &str, label: &str) -> String {
    format!(
        "<button type=\"button\" class=\"icon-button icon-button--quiet icon-button--lg\" data-copy=\"{}\" aria-label=\"Copy {}\" data-tooltip=\"Copy {}\">{}</button>",
        escape_attr(value),
        escape_attr(label),
        escape_attr(label),
        ui_icon("ui-copy", "icon")
    )
}

fn pz_icon_link(href: &str, label: &str, icon: &str, external: bool) -> String {
    let extra = if external {
        " target=\"_blank\" rel=\"noopener noreferrer\""
    } else {
        ""
    };
    format!(
        "<a class=\"icon-button icon-button--quiet icon-button--lg\" href=\"{}\" aria-label=\"{}\" data-tooltip=\"{}\"{}>{}</a>",
        escape_attr(href),
        escape_attr(label),
        escape_attr(label),
        extra,
        ui_icon(icon, "icon")
    )
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
    let step_href = |step: u32| {
        if tab == "detail" {
            format!("/bitcoin-puzzle/{step}")
        } else {
            format!("/bitcoin-puzzle/{step}/{}", escape_attr(tab))
        }
    };
    let prev = if number > 1 {
        format!(
            "<a class=\"puzzle-step\" rel=\"prev\" href=\"{}\">&larr; #{}</a>",
            step_href(number - 1),
            number - 1
        )
    } else {
        "<span class=\"puzzle-step disabled\">&larr; Prev</span>".to_string()
    };
    let next = if number < puzzles::PUZZLE_COUNT {
        format!(
            "<a class=\"puzzle-step\" rel=\"next\" href=\"{}\">#{} &rarr;</a>",
            step_href(number + 1),
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
        ("detail", "Detail", format!("/bitcoin-puzzle/{number}")),
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

fn puzzle_row(item: puzzles::Puzzle) -> String {
    let (start_hex, end_hex) = puzzles::range_hex(item.number).expect("puzzle range");
    let bits = item.number - 1;
    let solved = if item.solved { "true" } else { "false" };
    let status_word = if item.solved { "solved" } else { "unsolved" };
    let search = format!(
        "{} {} {}",
        item.number,
        item.target.to_lowercase(),
        status_word
    );
    format!(
        "<tr data-puzzle-row data-solved=\"{solved}\" data-search=\"{search}\">\
         <td data-label=\"Puzzle\" class=\"pz-num\">#{number}</td>\
         <td data-label=\"Status\">{status}</td>\
         <td data-label=\"Address\" class=\"pz-addr\"><span class=\"pz-cell\"><code>{target}</code>{copy}</span></td>\
         <td data-label=\"Range\" class=\"pz-range\" title=\"2^{bits} .. 2^{number} - 1\">\
         <span class=\"pz-cell pz-range-stack\">\
         <span class=\"pz-range-text\">2<sup>{bits}</sup>–2<sup>{number}</sup>−1</span>\
         <span class=\"pz-range-hex\">{start_short}…{end_short}</span></span></td>\
         <td data-label=\"Balance\" class=\"pz-balance\" data-balance-address=\"{target}\">—</td>\
         <td data-label=\"TX\" class=\"pz-tx\"><a class=\"pz-tx-link\" data-tx-address=\"{target}\" \
         href=\"https://mempool.space/address/{target}\" target=\"_blank\" rel=\"noopener noreferrer\">—</a></td>\
         <td data-label=\"Actions\" class=\"pz-actions\"><span class=\"pz-cell pz-actions-stack\">\
         <a class=\"pz-link\" href=\"/bitcoin-puzzle/{number}\">Detail</a>\
         <a class=\"pz-link\" href=\"/bitcoin-puzzle/{number}/random\">Random</a></span></td>\
         </tr>",
        solved = solved,
        search = escape_attr(&search),
        number = item.number,
        status = puzzle_badge(item.solved),
        target = escape_attr(item.target),
        copy = pz_copy_button(item.target, "address"),
        bits = bits,
        start_short = &start_hex[48..],
        end_short = &end_hex[48..],
    )
}

fn puzzle_table(only_unsolved: bool) -> String {
    let mut rows = String::new();
    for item in puzzles::all().filter(|item| !only_unsolved || !item.solved) {
        rows.push_str(&puzzle_row(item));
    }
    format!(
        "<div class=\"pz-table-wrap table-scroll\"><table class=\"pz-table data-table\" aria-label=\"Bitcoin puzzles\">\
         <thead><tr>\
         <th scope=\"col\">#</th>\
         <th scope=\"col\">Status</th>\
         <th scope=\"col\">Address</th>\
         <th scope=\"col\">Range</th>\
         <th scope=\"col\">Balance</th>\
         <th scope=\"col\">TX</th>\
         <th scope=\"col\">Actions</th>\
         </tr></thead><tbody data-puzzle-rows>{rows}</tbody></table></div>\
         <p class=\"pz-empty\" data-puzzle-empty hidden>No puzzles match this filter.</p>"
    )
}

fn puzzle_filter_bar(total: usize, solved: usize, unsolved: usize) -> String {
    format!(
        "<div class=\"pz-toolbar\">\
         <div class=\"segmented\" role=\"group\" aria-label=\"Filter puzzles\">\
         <button type=\"button\" class=\"segmented__item\" data-puzzle-filter=\"all\" aria-pressed=\"false\">All <span>{total}</span></button>\
         <button type=\"button\" class=\"segmented__item\" data-puzzle-filter=\"solved\" aria-pressed=\"false\">Solved <span>{solved}</span></button>\
         <button type=\"button\" class=\"segmented__item\" data-puzzle-filter=\"unsolved\" aria-pressed=\"true\">Unsolved <span>{unsolved}</span></button>\
         </div>\
         <label class=\"pz-search\">{icon}<span class=\"pz-visually-hidden\">Search puzzles</span>\
         <input type=\"search\" data-puzzle-search placeholder=\"Search #, address or status\" autocomplete=\"off\" spellcheck=\"false\"></label>\
         </div>",
        icon = ui_icon("ui-search", "icon"),
    )
}

fn puzzle_stat(label: &str, value: &str, note: &str) -> String {
    format!(
        "<div class=\"pz-stat\"><span class=\"pz-stat-label\">{label}</span>\
         <span class=\"pz-stat-value\">{value}</span>\
         <span class=\"pz-stat-note\">{note}</span></div>"
    )
}

fn puzzle_picker_card(number: u32, tab: &str) -> String {
    format!(
        "<section class=\"card pz-picker-card\"><h2>Jump to a puzzle</h2>{}</section>",
        puzzle_picker(number, tab)
    )
}

/// Default `<title>` in the embedded mnemonic seed shell. Chain pages swap it
/// for a chain-specific title; the directory keeps it.
const MNEMONIC_SEEDS_DEFAULT_TITLE: &str =
    "Mnemonic seeds directory — browse BIP39 phrases by chain | Crypto";
const MNEMONIC_SEEDS_DEFAULT_DESCRIPTION: &str = "Browse deterministic BIP39 mnemonic seeds chain by chain: 60 phrases per page, 12/18/24 words, BIP32 paths, Bitcoin address types and balance checks. Everything is derived in your browser.";
const MNEMONIC_SEEDS_DEFAULT_CANONICAL: &str = "https://rotor.pxbt.app/mnemonic-seeds";
const MNEMONIC_SEEDS_DEFAULT_MAIN: &str = "<main class=\"browse-page mnemonic-seeds-page\" data-chain=\"\" data-symbol=\"\" data-explorer=\"\" data-curve=\"0\" data-page=\"1\" style=\"--chain:#f7931a\">";
const MNEMONIC_SEEDS_DEFAULT_INTRO: &str = "<span data-chain-intro>Browse deterministic seed phrases: enumerate English BIP39 phrases across the entropy space, 60 per page, and derive the matching addresses locally.</span>";

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
            "{} mnemonic seeds — 60 BIP39 phrases per page | Crypto",
            chain.name
        )
    } else {
        format!(
            "{} mnemonic seeds — page {} | Crypto",
            chain.name, page_text
        )
    };
    let description = format!(
        "Browse deterministic {} mnemonic seeds, 60 per page. Choose 12, 18 or 24 words, a BIP32 path and an address type, then derive addresses and balances in your browser. Page {}.",
        chain.name, page_text
    );
    let intro = format!(
        "Browse deterministic {} seed phrases: enumerate 60 BIP39 phrases per page, choose 12, 18 or 24 words, a BIP32 path and an address type, then derive the matching addresses locally.",
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
        "<span data-chain-name aria-current=\"page\">Directory</span>",
        &format!(
            "<span data-chain-name aria-current=\"page\">{}</span>",
            escape_attr(chain.name)
        ),
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
    let title = "Bitcoin puzzle browser — client-side key search | Crypto";
    let description = "Browse all 160 public Bitcoin puzzles in one table: target address, key range, live balance and transaction count. Filter solved and unsolved puzzles and scan a range locally in your browser with WebAssembly.";
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
    let total = puzzles::PUZZLE_COUNT as usize;
    let unsolved = total - solved;
    let claimed = puzzle_prize_sum_btc(true);
    let left = puzzle_prize_sum_btc(false);
    let lowest_unsolved = puzzles::all()
        .find(|item| !item.solved)
        .map(|item| item.number)
        .unwrap_or(1);
    let stats = format!(
        "{}{}{}{}",
        puzzle_stat(
            "BTC claimed",
            &format_btc(claimed),
            "sum of solved puzzle prizes"
        ),
        puzzle_stat(
            "BTC left",
            &format_btc(left),
            "still locked in unsolved targets"
        ),
        puzzle_stat("Solved", &solved.to_string(), "targets already spent"),
        puzzle_stat("Unsolved", &unsolved.to_string(), "still open to search"),
    );
    let body = format!(
        "{}{crumbs}<main class=\"key-page puzzle-page\">\
         <section class=\"puzzle-hero\">\
         <div class=\"puzzle-hero-copy\">\
         <span class=\"pz-eyebrow\">Public puzzle #1–#160</span>\
         <h1>Bitcoin Puzzle</h1>\
         <p>Every public puzzle in one table. Compare the target, range and on-chain balance, open a puzzle for detail, or start a random or sequential scan of its key range — all in your browser with WebAssembly. No private key or scan result leaves the page.</p>\
         <div class=\"puzzle-hero-actions\">\
         <a class=\"btn primary\" href=\"/bitcoin-puzzle/{lowest_unsolved}/random\">Start hunting · #{lowest_unsolved}</a>\
         <a class=\"btn\" href=\"#puzzles\">Browse all {total}</a>\
         </div></div>\
         <div class=\"pz-stats\">{stats}</div></section>\
         <div class=\"pz-intro\">\
         <section class=\"card\"><h2>What is a Bitcoin puzzle?</h2>\
         <p>Each puzzle is a public Bitcoin address whose private key sits inside a known bit range. Puzzle n covers every key from 2^(n−1) to 2^n−1, so the search space doubles with every step. A match is the single key whose public key hashes to the target address.</p>\
         <p class=\"puzzle-note\">The embedded target list contains {solved} solved and {unsolved} unsolved puzzles, sourced from the public dataset (privatekeyfinder.io, crawled 2026-11-19). Prize totals assume the classic n × 0.1 BTC funding.</p></section>\
         <section class=\"card\"><h2>Popular tools</h2>\
         <div class=\"pz-tools\">\
         <a class=\"pz-tool\" href=\"/private-keys\"><span>Private key browser</span><small>Derive addresses chain by chain</small></a>\
         <a class=\"pz-tool\" href=\"/brainwallet\"><span>Brainwallet auditor</span><small>Test passphrase-derived keys</small></a>\
         <a class=\"pz-tool\" href=\"/mnemonic-seeds\"><span>Mnemonic seeds</span><small>Browse BIP39 phrases and paths</small></a>\
         <a class=\"pz-tool\" href=\"/vanity\"><span>Vanity generator</span><small>Search for a readable prefix</small></a>\
         <a class=\"pz-tool\" href=\"/tools\"><span>All key tools</span><small>WIF, hex, decimal and more</small></a>\
         <a class=\"pz-tool\" href=\"/run\"><span>Run a worker</span><small>Scan leased chunks for the pool</small></a>\
         </div></section></div>\
         {picker}\
         <section class=\"puzzle-cta\">\
         <div><h2>Ready to hunt?</h2><p>Open the lowest unsolved puzzle and scan its range locally.</p></div>\
         <a class=\"btn primary\" href=\"/bitcoin-puzzle/{lowest_unsolved}/random\">Start Hunting · #{lowest_unsolved}</a>\
         </section>\
         <section class=\"card\" id=\"puzzles\">\
         <div class=\"pz-section-head\"><div><h2>All puzzles</h2>\
         <p class=\"puzzle-note\">Balances and transaction counts load live from mempool.space as rows scroll into view. Range is the inclusive bit span of each puzzle.</p></div>\
         <span class=\"pz-live\">live via mempool.space</span></div>\
         {filters}{table}</section>\
         <section class=\"card\" id=\"team\"><h2>Team mode — pooled chunk leasing</h2>\
         <p>Team mode is Crypto's coordinator pool: a job is split into fixed-size chunks, each contributor leases one chunk and scans it on their own hardware. A worker receives only its slice of the range, and an expired lease returns the chunk to the pool. This is separate from the local puzzle browser above; the two never mix in one run.</p>\
         <h3>Live public jobs</h3>\
         <div data-puzzle-summary></div>\
         <div data-puzzle-jobs></div>\
         <noscript><p>Enable JavaScript to load live job statistics, or read the JSON at <a href=\"/api/v1/jobs/public\">/api/v1/jobs/public</a>.</p></noscript>\
         <p class=\"puzzle-actions\"><a class=\"button\" href=\"/run\">Run a worker</a> <a class=\"button\" href=\"/cabinet\">Open the cabinet</a> <a class=\"button\" href=\"/docs\">Read the docs</a></p></section>\
         </main>\
         <script src=\"/puzzle-browser.js\" defer></script>\
         <script src=\"/puzzle.js\" defer></script>",
        site_header(),
        solved = solved,
        unsolved = unsolved,
        total = total,
        lowest_unsolved = lowest_unsolved,
        stats = stats,
        picker = puzzle_picker_card(lowest_unsolved, "random"),
        filters = puzzle_filter_bar(total, solved, unsolved),
        table = puzzle_table(false),
    );
    html_document(title, &head, &body)
}

fn render_puzzle_unsolved(base: &str) -> String {
    let canonical = format!("{base}/bitcoin-puzzle/unsolved");
    let title = "Unsolved Bitcoin puzzles — local browser scan | Crypto";
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
    let solved = puzzles::PUZZLE_COUNT as usize - unsolved;
    let body = format!(
        "{}{crumbs}<main class=\"key-page puzzle-page\">\
         <section class=\"puzzle-hero puzzle-hero-compact\">\
         <div class=\"puzzle-hero-copy\"><span class=\"pz-eyebrow\">Public puzzle #1–#160</span>\
         <h1>Unsolved Bitcoin puzzles</h1>\
         <p>{unsolved} puzzles in the public set are still unsolved. Their targets and ranges are listed below; open one to inspect it or start a local browser scan.</p>\
         <div class=\"puzzle-hero-actions\"><a class=\"btn\" href=\"/bitcoin-puzzle\">Back to all {total}</a></div></div>\
         <div class=\"pz-stats\">{unsolved_stat}{solved_stat}{claimed_stat}</div></section>\
         {picker}\
         <section class=\"card\" id=\"puzzles\">\
         <div class=\"pz-section-head\"><div><h2>Unsolved targets</h2>\
         <p class=\"puzzle-note\">Ranges follow 2^(n−1) to 2^n−1. A puzzle leaves this list when its target address is spent; balances load live from mempool.space as rows scroll into view.</p></div>\
         <span class=\"pz-live\">live via mempool.space</span></div>\
         <div class=\"pz-toolbar\"><div></div><label class=\"pz-search\">{icon}<span class=\"pz-visually-hidden\">Search unsolved puzzles</span>\
         <input type=\"search\" data-puzzle-search placeholder=\"Search # or address\" autocomplete=\"off\" spellcheck=\"false\"></label></div>\
         {table}</section>\
         </main>\
         <script src=\"/puzzle-browser.js\" defer></script>",
        site_header(),
        unsolved = unsolved,
        total = puzzles::PUZZLE_COUNT,
        unsolved_stat = puzzle_stat("Unsolved", &unsolved.to_string(), "still open to search"),
        solved_stat = puzzle_stat("Solved", &solved.to_string(), "already spent"),
        claimed_stat = puzzle_stat(
            "BTC left",
            &format_btc(puzzle_prize_sum_btc(false)),
            "still locked in these targets"
        ),
        picker = puzzle_picker_card(71, "random"),
        icon = ui_icon("ui-search", "icon"),
        table = puzzle_table(true),
    );
    html_document(title, &head, &body)
}

fn puzzle_fact(label: &str, value: &str) -> String {
    format!(
        "<div class=\"pz-fact\"><span class=\"pz-k\">{label}</span><span class=\"pz-v\">{value}</span></div>"
    )
}

fn render_puzzle_page(base: &str, number: u32, random: bool) -> String {
    let item = puzzles::puzzle(number).expect("route validated the puzzle number");
    let (start_hex, end_hex) =
        puzzles::range_hex(number).expect("route validated the puzzle number");
    let view = if random { "random" } else { "detail" };
    let view_label = if random { "Random Keys" } else { "Detail" };
    let canonical = if random {
        format!("{base}/bitcoin-puzzle/{number}/random")
    } else {
        format!("{base}/bitcoin-puzzle/{number}")
    };
    let title = if random {
        format!("Bitcoin Puzzle #{number} — Random Keys | Crypto")
    } else {
        format!("Bitcoin Puzzle #{number} — Detail | Crypto")
    };
    let description = if random {
        format!(
            "Scan the key range of public Bitcoin puzzle #{number} locally in your browser. Target {}, random or sequential WASM workers, no key upload.",
            item.target
        )
    } else {
        format!(
            "Puzzle #{number} detail: target {}, inclusive key range, decimal key space, balance and explorer links. The search runs locally in the browser.",
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
            { "@type": "ListItem", "position": 3, "name": format!("Puzzle #{number}"), "item": format!("{base}/bitcoin-puzzle/{number}") },
            { "@type": "ListItem", "position": 4, "name": view_label },
        ],
    });
    let head = hub_head(&canonical, &title, &description, &[ld_app, ld_crumbs]);

    let puzzle_label = format!("Puzzle #{number}");
    let detail_href = format!("/bitcoin-puzzle/{number}");
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

    let header = format!(
        "<section class=\"card puzzle-head\">\
         <div class=\"puzzle-head-row\"><div><span class=\"pz-eyebrow\">Puzzle #{number}</span>\
         <h1>Bitcoin Puzzle #{number}</h1>\
         <p class=\"puzzle-note\">{status_sentence}</p></div>{status}</div>\
         {picker}{tabs}</section>",
        number = number,
        status_sentence = status_sentence,
        status = status,
        picker = puzzle_picker(number, view),
        tabs = puzzle_tabs(number, view),
    );

    let content = if random {
        render_puzzle_random(number, item.target, &start_hex, &end_hex, item.solved)
    } else {
        render_puzzle_detail(number, item.target, &start_hex, &end_hex, item.solved)
    };

    let body = format!(
        "{}{crumbs}<main class=\"key-page puzzle-page\">{header}{content}</main>\
         <script src=\"/puzzle-browser.js\" defer></script>",
        site_header(),
    );
    html_document(&title, &head, &body)
}

fn render_puzzle_detail(
    number: u32,
    target: &str,
    start_hex: &str,
    end_hex: &str,
    solved: bool,
) -> String {
    let bits = number - 1;
    let status = puzzle_badge(solved);
    let solved_pct = if solved { 100 } else { 0 };
    let status_progress = if solved {
        "Solved: the target address is spent. Global search progress is not published, so this bar shows the solved / unsolved status only."
    } else {
        "Unsolved: the target address still holds the prize. Global search progress is not published; Random Keys shows the progress of your own local run."
    };
    let facts = format!(
        "{}{}{}{}{}{}{}{}",
        puzzle_fact(
            "Target address",
            &format!(
                "<code class=\"pz-mono\">{}</code>{}",
                escape_attr(target),
                pz_copy_button(target, "target address")
            )
        ),
        puzzle_fact("Status", &status),
        puzzle_fact(
            "Range start",
            &format!(
                "<code class=\"pz-mono\">{start_hex}</code>{}",
                pz_copy_button(start_hex, "range start")
            )
        ),
        puzzle_fact(
            "Range end",
            &format!(
                "<code class=\"pz-mono\">{end_hex}</code>{}",
                pz_copy_button(end_hex, "range end")
            )
        ),
        puzzle_fact(
            "Difficulty",
            &format!(
                "<strong>2<sup>{bits}</sup> keys</strong><span class=\"pz-sub\">{bits}-bit scalar space</span>"
            )
        ),
        puzzle_fact(
            "Key space",
            &format!(
                "<code class=\"pz-mono pz-wrap\">{}</code>",
                puzzle_keyspace_decimal(number)
            )
        ),
        puzzle_fact(
            "Balance",
            "<strong data-puzzle-balance>—</strong><span class=\"pz-sub\" data-puzzle-balance-state>loading via mempool.space</span><button type=\"button\" class=\"pz-mini\" data-puzzle-check>Check</button>"
        ),
        puzzle_fact(
            "Transactions",
            &format!(
                "<a class=\"pz-tx-link\" data-tx-address=\"{target}\" href=\"https://mempool.space/address/{target}\" target=\"_blank\" rel=\"noopener noreferrer\">mempool.space</a><span class=\"pz-sub\">live transaction count</span>"
            )
        ),
    );
    format!(
        "<section class=\"card\" data-puzzle-target=\"{target}\">\
         <div class=\"pz-section-head\"><div><h2>Puzzle facts</h2>\
         <p class=\"puzzle-note\">Copy any value with the icon next to it. Balance is read from mempool.space for this public address; the page never sends a private key or scan result.</p></div>\
         <div class=\"pz-icon-row\">\
         {blockchain}{mempool}</div></div>\
         <div class=\"pz-facts\">{facts}</div>\
         <div class=\"puzzle-progress\"><div class=\"progress\" role=\"img\" aria-label=\"Puzzle solved status\"><span class=\"bar\" style=\"width:{solved_pct}%\"></span></div>\
         <p class=\"puzzle-progress-text\">{status_progress}</p></div>\
         <div class=\"pz-actions-row\">\
         <a class=\"btn primary\" href=\"/bitcoin-puzzle/{number}/random\">Open Random Keys</a>\
         <a class=\"btn\" href=\"/private-keys/bitcoin?key={start_hex}\">Derive start key</a>\
         </div></section>\
         <section class=\"card\"><h2>How this range works</h2>\
         <p class=\"puzzle-note\">Puzzle n spans every private key from 2^(n−1) to 2^n−1, so puzzle #{number} covers {bits} bits. A valid match is the single key whose public key hashes to the target address; every other key in the range is discarded.</p>\
         <p class=\"puzzle-note\">Splits only narrow the search window. They do not change the target, the range formula, or the difficulty per tested key.</p></section>",
        target = escape_attr(target),
        blockchain = pz_icon_link(
            &format!("https://www.blockchain.com/btc/address/{target}"),
            "Open target on Blockchain.com",
            "ui-blockchain",
            true
        ),
        mempool = pz_icon_link(
            &format!("https://mempool.space/address/{target}"),
            "Open target on mempool.space",
            "ui-mempool",
            true
        ),
        facts = facts,
        solved_pct = solved_pct,
        status_progress = status_progress,
        number = number,
        start_hex = start_hex,
    )
}

fn render_puzzle_random(
    number: u32,
    target: &str,
    start_hex: &str,
    end_hex: &str,
    solved: bool,
) -> String {
    let mut worker_options = String::new();
    for count in 1..=8 {
        let selected = if count == 1 { " selected" } else { "" };
        worker_options.push_str(&format!(
            "<option value=\"{count}\"{selected}>{count}</option>"
        ));
    }
    let presets = "<div class=\"pz-presets\" role=\"group\" aria-label=\"Range presets\">\
         <button type=\"button\" class=\"chip\" data-range-preset=\"full\" aria-pressed=\"true\">Full</button>\
         <button type=\"button\" class=\"chip\" data-range-preset=\"first\" aria-pressed=\"false\">1st half</button>\
         <button type=\"button\" class=\"chip\" data-range-preset=\"second\" aria-pressed=\"false\">2nd half</button>\
         <button type=\"button\" class=\"chip\" data-range-preset=\"q1\" aria-pressed=\"false\">Q1</button>\
         <button type=\"button\" class=\"chip\" data-range-preset=\"q2\" aria-pressed=\"false\">Q2</button>\
         <button type=\"button\" class=\"chip\" data-range-preset=\"q3\" aria-pressed=\"false\">Q3</button>\
         <button type=\"button\" class=\"chip\" data-range-preset=\"q4\" aria-pressed=\"false\">Q4</button>\
         </div>";
    format!(
        "<section class=\"card puzzle-app\" data-puzzle-app data-puzzle-number=\"{number}\" data-puzzle-target=\"{target}\" data-puzzle-start=\"{start_hex}\" data-puzzle-end=\"{end_hex}\" data-puzzle-solved=\"{solved}\">\
         <div class=\"pz-app-head\"><div><h2>Random keys — local WASM scan</h2>\
         <p class=\"puzzle-note\">The scan generates keys inside the selected range, hashes them with the Crypto WebAssembly core and discards every miss. Nothing is uploaded; the optional balance check only reads this public target address.</p></div>\
         <span class=\"pz-wasm\" data-puzzle-wasm>idle</span></div>\
         <div class=\"pz-target-row\"><span class=\"pz-k\">Target</span>\
         <code class=\"pz-mono\">{target}</code>{copy}{blockchain}{mempool}\
         <span class=\"pz-target-balance\"><span class=\"pz-k\">Balance</span>\
         <strong data-puzzle-balance>—</strong>\
         <span class=\"pz-sub\" data-puzzle-balance-state>loading via mempool.space</span></span></div>\
         <div class=\"pz-range-row\">\
         <label>Range start <input class=\"mono\" data-puzzle-start-input value=\"{start_hex}\" spellcheck=\"false\" autocomplete=\"off\" aria-label=\"Range start in hex\"></label>\
         <label>Range end <input class=\"mono\" data-puzzle-end-input value=\"{end_hex}\" spellcheck=\"false\" autocomplete=\"off\" aria-label=\"Range end in hex\"></label>\
         </div>\
         {presets}\
         <div class=\"pz-control-row\">\
         <button type=\"button\" data-puzzle-resume-btn disabled title=\"Restore the last range saved in this browser\">Resume</button>\
         <button type=\"button\" data-puzzle-reset-btn>Reset</button>\
         <button type=\"button\" data-puzzle-check>Check balance</button>\
         </div>\
         <div class=\"pz-control-row pz-run-row\">\
         <div class=\"segmented\" role=\"group\" aria-label=\"Scan mode\">\
         <button type=\"button\" class=\"segmented__item\" data-puzzle-mode data-mode-value=\"team\" aria-pressed=\"false\">Team</button>\
         <button type=\"button\" class=\"segmented__item\" data-puzzle-mode data-mode-value=\"random\" aria-pressed=\"true\">Solo Random</button>\
         <button type=\"button\" class=\"segmented__item\" data-puzzle-mode data-mode-value=\"seq\" aria-pressed=\"false\">Solo Seq</button>\
         </div>\
         <label class=\"pz-inline\">Workers <select data-puzzle-workers>{worker_options}</select></label>\
         <button type=\"button\" class=\"primary\" data-puzzle-start-btn>Start</button>\
         <button type=\"button\" data-puzzle-stop-btn disabled>Stop</button>\
         </div>\
         <p class=\"puzzle-state\" data-puzzle-state role=\"status\" aria-live=\"polite\">Ready. Press Start or Space.</p>\
         <div class=\"puzzle-team-note\" data-puzzle-team-note hidden>Team mode is the coordinator pool, not this local scan. <a href=\"/bitcoin-puzzle#team\">Open the pooled job board</a> or <a href=\"/run\">run a lease worker</a>. Local and leased work never mix.</div>\
         <div class=\"pz-metrics\">\
         <div class=\"pz-metric\"><span class=\"pz-k\">Generated</span><strong data-puzzle-generated>0</strong></div>\
         <div class=\"pz-metric\"><span class=\"pz-k\">Speed</span><strong><span data-puzzle-speed>0</span> <small>keys/s</small></strong></div>\
         <div class=\"pz-metric\"><span class=\"pz-k\">Workers</span><strong data-puzzle-worker-count>0</strong></div>\
         <div class=\"pz-metric\"><span class=\"pz-k\">Match</span><strong data-puzzle-match-count>0</strong></div>\
         <div class=\"pz-metric\"><span class=\"pz-k\">ETA</span><strong data-puzzle-eta>—</strong></div>\
         <div class=\"pz-metric\"><span class=\"pz-k\">Network</span><strong data-puzzle-network title=\"Local-only scan; nothing is uploaded.\">0 · local</strong></div>\
         </div>\
         <div class=\"puzzle-progress\"><div class=\"progress\" role=\"progressbar\" aria-label=\"Local scan progress\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"0\" data-puzzle-progress-bar><span class=\"bar\" data-puzzle-progress style=\"width:0%\"></span></div>\
         <p class=\"puzzle-progress-text\" data-puzzle-progress-text>No keys scanned yet.</p></div>\
         <div class=\"puzzle-match\" data-puzzle-match hidden>\
         <h3>MATCH FOUND</h3>\
         <p class=\"puzzle-match-target\">Target <code>{target}</code></p>\
         <div class=\"puzzle-match-key\"><span>Private key</span><code data-puzzle-match-key></code><button type=\"button\" data-puzzle-copy>Copy</button></div>\
         <p class=\"puzzle-note\">The key stayed in this browser. Verify it against the target before using it anywhere.</p>\
         </div>\
         <section class=\"pz-community\" data-puzzle-community aria-live=\"polite\">\
         <div class=\"pz-section-head\"><div><h3>Community hunt</h3>\
         <p class=\"puzzle-note\">Shared coordinator-pool progress from <code>/api/v1/summary</code>. It is separate from this local scan.</p></div></div>\
         <p class=\"puzzle-state\" data-puzzle-community-state>Loading coordinator summary…</p>\
         <div class=\"pz-community-stats\" data-puzzle-community-stats hidden></div></section>\
         <section class=\"pz-results\">\
         <div class=\"pz-section-head\"><div><h3>Live generated keys</h3>\
         <p class=\"puzzle-note\">Sampled keys derived locally by the WASM core, newest first. Balances are not checked per sample; a row is marked Match only when it equals the target.</p></div>\
         <span class=\"pz-live\" data-puzzle-results-count>0 rows</span></div>\
         <div class=\"pz-table-wrap table-scroll\"><table class=\"pz-table pz-results-table data-table\" aria-label=\"Generated keys\">\
         <thead><tr><th scope=\"col\">#</th><th scope=\"col\">Private key</th><th scope=\"col\">Address</th><th scope=\"col\">Balance</th><th scope=\"col\">Received</th><th scope=\"col\">Match</th></tr></thead>\
         <tbody data-puzzle-results></tbody></table></div>\
         <p class=\"pz-empty\" data-puzzle-results-empty>No sampled keys yet. Start a scan to fill this table.</p></section>\
         </section>",
        number = number,
        target = escape_attr(target),
        copy = pz_copy_button(target, "target address"),
        blockchain = pz_icon_link(
            &format!("https://www.blockchain.com/btc/address/{target}"),
            "Open target on Blockchain.com",
            "ui-blockchain",
            true
        ),
        mempool = pz_icon_link(
            &format!("https://mempool.space/address/{target}"),
            "Open target on mempool.space",
            "ui-mempool",
            true
        ),
        start_hex = start_hex,
        end_hex = end_hex,
        presets = presets,
        worker_options = worker_options,
    )
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
        "  <url><loc>{}/brainwallet</loc></url>\n",
        escape_attr(base)
    ));
    urls.push_str(&format!(
        "  <url><loc>{}/brainwallet-generator</loc></url>\n",
        escape_attr(base)
    ));
    for chain in &CHAINS {
        urls.push_str(&format!(
            "  <url><loc>{}/brainwallet/{}</loc></url>\n",
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
        "/bitcoin-puzzle/71",
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
        "/tx",
        "/tx/bitcoin",
        "/tx/ethereum",
        "/send",
        "/send/bitcoin",
        "/send/ethereum",
        "/send/bnb",
        "/send/usdt",
        "/send/tron",
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
        "Not found | Crypto",
        "<meta name=\"robots\" content=\"noindex,nofollow\">\n",
        "<header class=\"site-nav\"><a class=\"brand\" href=\"/\">Crypto<span>.</span></a></header>\
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

/// `GET /api/v1/chain/tron/address?address=...`: public TRON balance and
/// transaction count proxied through TronScan. The API key stays server-side.
fn tron_address(app: &App, request: Request, query: &str) {
    let ip = client_ip(&request, app.trust_proxy);
    if !app.rate.allow(&format!("public-tron:{ip}")) {
        return respond_rate_limited(request);
    }
    let Some(address) = query_param(query, "address") else {
        return respond_json(request, 400, &json!({ "error": "missing address" }));
    };
    if !valid_tron_address(address) {
        return respond_json(request, 400, &json!({ "error": "invalid tron address" }));
    }
    let Some(key) = app.tronscan_api_key.as_deref() else {
        return respond_json(request, 501, &json!({ "error": "no_provider" }));
    };
    match tron_lookup(app, key, address) {
        Ok(body) => respond_json(request, 200, &body),
        Err(error) => respond_tron_error(request, error),
    }
}

#[derive(Deserialize)]
struct TronBatchRequest {
    addresses: Vec<String>,
}

/// `POST /api/v1/chain/tron/addresses` with `{"addresses": [...]}`.
///
/// A batch is one public request but still runs through the same limiter and
/// cache as the per-address route, one address at a time. Per-address failures
/// stay in the results map so one bad upstream answer does not drop the batch.
fn tron_addresses(app: &App, mut request: Request) {
    let ip = client_ip(&request, app.trust_proxy);
    if !app.rate.allow(&format!("public-tron:{ip}")) {
        return respond_rate_limited(request);
    }
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let addresses = match validate_tron_batch(&body) {
        Ok(addresses) => addresses,
        Err(message) => return respond_json(request, 400, &json!({ "error": message })),
    };
    let Some(key) = app.tronscan_api_key.as_deref() else {
        return respond_json(request, 501, &json!({ "error": "no_provider" }));
    };
    let mut results = serde_json::Map::with_capacity(addresses.len());
    for address in addresses {
        let value = match tron_lookup(app, key, &address) {
            Ok(value) => value,
            Err(error) => json!({ "error": error.reason }),
        };
        results.insert(address, value);
    }
    respond_json(request, 200, &json!({ "results": results }));
}

/// Parse and validate a batch body. Duplicate addresses are folded into one
/// lookup; a single malformed address rejects the whole request.
fn validate_tron_batch(body: &str) -> Result<Vec<String>, &'static str> {
    let batch: TronBatchRequest = serde_json::from_str(body).map_err(|_| "invalid JSON body")?;
    if batch.addresses.len() > TRON_BATCH_MAX {
        return Err("too many addresses (maximum 60)");
    }
    let mut unique: Vec<String> = Vec::with_capacity(batch.addresses.len());
    for address in batch.addresses {
        if !valid_tron_address(&address) {
            return Err("invalid tron address");
        }
        if !unique.contains(&address) {
            unique.push(address);
        }
    }
    Ok(unique)
}

/// Base58 address shape: 34 characters starting with `T`. The checksum is
/// not verified here; TronScan rejects a malformed account on its own.
fn valid_tron_address(address: &str) -> bool {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    address.len() == 34
        && address.starts_with('T')
        && address.bytes().all(|byte| ALPHABET.contains(&byte))
}

/// DNS order from this host often puts AAAA first. A container without an
/// IPv6 route then fails the connect before the A record is tried, which
/// surfaced as "provider unreachable" for every TronScan call. Try IPv4
/// addresses first and keep the IPv6 ones as a fallback.
struct Ipv4FirstResolver;

impl ureq::Resolver for Ipv4FirstResolver {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
        let mut v4 = Vec::new();
        let mut v6 = Vec::new();
        for addr in netloc.to_socket_addrs()? {
            if addr.is_ipv4() {
                v4.push(addr);
            } else {
                v6.push(addr);
            }
        }
        v4.extend(v6);
        Ok(v4)
    }
}

fn tronscan_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .resolver(Ipv4FirstResolver)
        .user_agent("rotor-coord/2.0 tronscan-proxy")
        .timeout_connect(TRONSCAN_CONNECT_TIMEOUT)
        .timeout_read(TRONSCAN_READ_TIMEOUT)
        .timeout_write(TRONSCAN_WRITE_TIMEOUT);
    // ureq only uses native-tls when the connector is attached explicitly.
    if let Ok(connector) = ureq::native_tls::TlsConnector::new() {
        builder = builder.tls_connector(Arc::new(connector));
    }
    builder.build()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TronFetchError {
    NotFound,
    RateLimited,
    Unavailable,
    Rejected,
    Transport,
    Body,
    Busy,
}

/// One TronScan GET through the shared limiter, with two retries on 429/5xx
/// (250 ms, then 750 ms, both jittered). Errors never contain the API key or
/// the request headers.
fn tronscan_get(
    agent: &ureq::Agent,
    key: &str,
    url: &str,
    limiter: &Arc<tron_cache::Limiter>,
) -> Result<serde_json::Value, TronFetchError> {
    let mut attempt = 0;
    loop {
        let Some(slot) = limiter.acquire() else {
            return Err(TronFetchError::Busy);
        };
        let status = match agent.get(url).set("TRON-PRO-API-KEY", key).call() {
            Ok(response) => {
                let mut body = String::new();
                let read = response
                    .into_reader()
                    .take(TRONSCAN_MAX_BODY_BYTES as u64 + 1)
                    .read_to_string(&mut body);
                drop(slot);
                if read.is_err() {
                    return Err(TronFetchError::Body);
                }
                if body.len() > TRONSCAN_MAX_BODY_BYTES {
                    return Err(TronFetchError::Body);
                }
                return serde_json::from_str(&body).map_err(|_| TronFetchError::Body);
            }
            Err(ureq::Error::Status(status, _)) => {
                drop(slot);
                status
            }
            Err(ureq::Error::Transport(_)) => {
                drop(slot);
                return Err(TronFetchError::Transport);
            }
        };
        if matches!(status, 429 | 500..=599) && attempt < tron_cache::MAX_RETRIES {
            thread::sleep(tron_cache::retry_delay(attempt));
            attempt += 1;
            continue;
        }
        return Err(match status {
            404 => TronFetchError::NotFound,
            429 => TronFetchError::RateLimited,
            500..=599 => TronFetchError::Unavailable,
            _ => TronFetchError::Rejected,
        });
    }
}

fn tron_error_reason(error: TronFetchError) -> &'static str {
    match error {
        TronFetchError::NotFound => "provider returned no data",
        TronFetchError::RateLimited => "provider rate limited",
        TronFetchError::Unavailable => "provider unavailable",
        TronFetchError::Rejected => "provider rejected the request",
        TronFetchError::Transport => "provider unreachable",
        TronFetchError::Body => "provider response timed out or was unreadable",
        TronFetchError::Busy => "provider queue is full",
    }
}

fn tron_error_status(error: TronFetchError) -> u16 {
    match error {
        TronFetchError::RateLimited | TronFetchError::Busy => 503,
        _ => 502,
    }
}

/// An error surfaced to a public client. Cached provider errors keep their
/// original status and reason.
struct TronLookupError {
    status: u16,
    reason: String,
}

fn respond_tron_error(request: Request, error: TronLookupError) {
    let body = json!({ "error": error.reason }).to_string();
    let mut response = Response::from_string(body)
        .with_status_code(StatusCode(error.status))
        .with_header(header("Content-Type", "application/json"));
    if error.status == 503 {
        response = response.with_header(header("Retry-After", "2"));
    }
    let _ = request.respond(response);
}

fn tron_lookup(app: &App, key: &str, address: &str) -> Result<serde_json::Value, TronLookupError> {
    if let Some(hit) = app.tron_cache.get("tron", address) {
        return match hit {
            tron_cache::CacheHit::Success(value) => Ok(value),
            tron_cache::CacheHit::Error { status, reason } => {
                Err(TronLookupError { status, reason })
            }
        };
    }
    match tron_lookup_uncached(&app.tronscan_agent, key, address, &app.tron_limiter) {
        Ok(value) => {
            app.tron_cache.put_success("tron", address, value.clone());
            Ok(value)
        }
        Err(error) => {
            let status = tron_error_status(error);
            let reason = tron_error_reason(error).to_string();
            // A full local queue is not a provider answer; caching it would
            // keep rejecting after capacity frees up.
            if error != TronFetchError::Busy {
                app.tron_cache.put_error("tron", address, status, &reason);
            }
            Err(TronLookupError { status, reason })
        }
    }
}

fn tron_lookup_uncached(
    agent: &ureq::Agent,
    key: &str,
    address: &str,
    limiter: &Arc<tron_cache::Limiter>,
) -> Result<serde_json::Value, TronFetchError> {
    let account_url = format!("{TRONSCAN_API_BASE}/api/accountv2?address={address}");
    let account = match tronscan_get(agent, key, &account_url, limiter) {
        Ok(value) => value,
        // An unknown account is an empty account, not an upstream failure.
        Err(TronFetchError::NotFound) => serde_json::Value::Null,
        Err(error) => return Err(error),
    };
    let transaction_url = format!(
        "{TRONSCAN_API_BASE}/api/transaction?sort=-timestamp&count=true&limit=1&start=0&address={address}"
    );
    let transaction = match tronscan_get(agent, key, &transaction_url, limiter) {
        Ok(value) => value,
        Err(TronFetchError::NotFound) => serde_json::Value::Null,
        Err(error) => return Err(error),
    };
    tron_response(address, &account, &transaction).map_err(|_| TronFetchError::Body)
}

/// TronScan reports the balance of very large accounts as a negative int64
/// when its own 64-bit counter overflows. That is not a real balance: the
/// caller gets `balance_sun: null` plus `balance_error` instead of a wrong
/// number.
fn parse_tron_balance(account: &serde_json::Value) -> Result<Option<String>, ()> {
    let Some(value) = account.get("balance") else {
        return Ok(Some("0".to_string()));
    };
    match value {
        serde_json::Value::Null => Ok(Some("0".to_string())),
        serde_json::Value::Number(number) => {
            if let Some(balance) = number.as_i64() {
                return if balance < 0 {
                    Ok(None)
                } else {
                    Ok(Some(balance.to_string()))
                };
            }
            if let Some(balance) = number.as_u64() {
                return Ok(Some(balance.to_string()));
            }
            match number.as_f64() {
                Some(balance) if balance.is_finite() && balance >= 0.0 => {
                    Ok(Some(format!("{balance:.0}")))
                }
                _ => Ok(None),
            }
        }
        serde_json::Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                Ok(Some("0".to_string()))
            } else if text.starts_with('-') {
                Ok(None)
            } else if text.bytes().all(|byte| byte.is_ascii_digit()) {
                Ok(Some(text.to_string()))
            } else {
                Err(())
            }
        }
        _ => Err(()),
    }
}

fn tron_count_at(value: &serde_json::Value, key: &str) -> Option<u64> {
    let field = value.get(key)?;
    if let Some(count) = field.as_u64() {
        return Some(count);
    }
    if let Some(count) = field.as_i64() {
        return u64::try_from(count).ok();
    }
    field.as_str()?.trim().parse::<u64>().ok()
}

fn parse_tron_tx_count(transaction: &serde_json::Value, account: &serde_json::Value) -> u64 {
    tron_count_at(transaction, "rangeTotal")
        .or_else(|| tron_count_at(transaction, "total"))
        .or_else(|| tron_count_at(transaction, "totalTransactionCount"))
        .or_else(|| tron_count_at(account, "totalTransactionCount"))
        .unwrap_or(0)
}

fn parse_tron_last_tx(transaction: &serde_json::Value) -> Option<u64> {
    let first = transaction.get("data")?.as_array()?.first()?;
    ["timestamp", "block_ts"].into_iter().find_map(|key| {
        let field = first.get(key)?;
        if let Some(stamp) = field.as_u64() {
            return Some(stamp);
        }
        if let Some(stamp) = field.as_i64() {
            return u64::try_from(stamp).ok();
        }
        field.as_str()?.trim().parse::<u64>().ok()
    })
}

fn tron_response(
    address: &str,
    account: &serde_json::Value,
    transaction: &serde_json::Value,
) -> Result<serde_json::Value, &'static str> {
    let balance = if account.is_null() {
        Some("0".to_string())
    } else {
        parse_tron_balance(account).map_err(|_| "unexpected provider response")?
    };
    let overflow = balance.is_none();
    let mut response = json!({
        "chain": "tron",
        "address": address,
        "balance_sun": balance,
        "tx_count": parse_tron_tx_count(transaction, account),
        "last_tx_at": parse_tron_last_tx(transaction),
        "source": "tronscan",
    });
    if overflow {
        response["balance_error"] = json!("provider_overflow");
    }
    Ok(response)
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

        let (body, content_type) =
            static_asset("/address-codecs.js").expect("/address-codecs.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        assert!(!body.is_empty());

        let (body, content_type) =
            static_asset("/balance-cache.js").expect("/balance-cache.js is embedded");
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
    fn send_routes_and_tron_helper_are_embedded() {
        for path in [
            "/send",
            "/send/bitcoin",
            "/send/ethereum",
            "/send/bnb",
            "/send/usdt",
            "/send/tron",
        ] {
            let (body, content_type) =
                static_asset(path).unwrap_or_else(|| panic!("{path} is embedded"));
            assert_eq!(content_type, "text/html; charset=utf-8");
            let page = std::str::from_utf8(body).expect("send.html is UTF-8");
            assert!(page.contains("id=\"send-key\""), "{path} misses the form");
            assert!(page.contains("/send.js"), "{path} misses /send.js");
            assert!(page.contains("/tron-tx.js"), "{path} misses /tron-tx.js");
        }

        let (body, content_type) = static_asset("/tron-tx.js").expect("/tron-tx.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let script = std::str::from_utf8(body).expect("tron-tx.js is UTF-8");
        // The Nile-only host gate ships in the served asset, not just in tests.
        assert!(script.contains("api.nileex.io"));
        assert!(script.contains("RotorTronSend"));
        assert!(script.contains("/wallet/broadcasttransaction"));
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
                page.contains("/theme.js?v=20261128b"),
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
                .contains(".seed-controls")
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
        assert!(page.contains("<script src=\"/theme.js?v=20261128b\"></script>"));
        assert!(page.contains("/site.css?v=20261128b"));
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
        assert_eq!(body.matches("<nav class=\"breadcrumbs\"").count(), 1);
        let crumbs = breadcrumb_nav_slice(&body, "/private-keys");
        assert_eq!(crumbs.matches("aria-current=\"page\"").count(), 1);
        assert!(crumbs.contains("<span aria-current=\"page\">Chains</span>"));

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
    fn address_type_component_is_shared_across_key_and_chain_pages() {
        let base = "https://rotor.pxbt.app";
        let (browse, _, status) = seo_asset(base, "/private-keys/bitcoin", "").expect("browse");
        assert_eq!(status, 200);
        for needle in [
            "<section class=\"address-type-panel\"",
            "class=\"address-type-card active\"",
            "class=\"type-name\"",
            "class=\"type-desc\"",
        ] {
            assert!(browse.contains(needle), "chain page misses {needle}");
        }
        for needle in [
            "<div class=\"address-type-panel key-address-panel\"",
            "class=\"address-type-card\"",
            "class=\"type-name\"",
            "class=\"type-desc\"",
            "data-row=\"btc_p2pkh\"",
            "id=\"btc-panel\"",
        ] {
            assert!(KEY_PAGE.contains(needle), "key page misses {needle}");
        }
        for legacy in ["key-type", "key-types", "key-btc-panel"] {
            assert!(!KEY_PAGE.contains(legacy), "key page still uses {legacy}");
            assert!(
                !SITE_CSS.contains(legacy),
                "site.css still defines {legacy}"
            );
        }
        assert!(SITE_CSS.contains(".address-type-card[aria-pressed=\"true\"]"));
        assert!(SITE_CSS.contains(".address-type-card:focus-visible"));
    }

    #[test]
    fn litecoin_directory_exposes_taproot_card_and_field() {
        let base = "https://rotor.pxbt.app";
        let (body, _, status) =
            seo_asset(base, "/private-keys/litecoin", "").expect("/private-keys/litecoin");
        assert_eq!(status, 200);
        assert!(body.contains("data-type=\"taproot\""));

        let (taproot, _, status) =
            seo_asset(base, "/private-keys/litecoin", "type=taproot").expect("taproot");
        assert_eq!(status, 200);
        assert!(taproot.contains("data-type=\"taproot\""));
        assert!(taproot.contains("data-field=\"ltc_p2tr\""));
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
    fn donor_route_aliases_redirect_to_canonical_paths() {
        assert_eq!(
            redirect_target("/vanity-generator"),
            Some("/vanity".to_string())
        );
        assert_eq!(redirect_target("/downloads"), Some("/wallets".to_string()));
        // Exact paths only: subpaths are not alias hubs.
        assert_eq!(redirect_target("/vanity-generator/"), None);
        assert_eq!(redirect_target("/vanity-generator/foo"), None);
        assert_eq!(redirect_target("/downloads/foo"), None);
        assert_eq!(redirect_target("/vanity"), None);
        assert_eq!(redirect_target("/wallets"), None);
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

    /// The breadcrumb nav slice. Several landmarks legitimately carry
    /// `aria-current="page"`; only this one is the trail.
    fn breadcrumb_nav_slice<'a>(body: &'a str, path: &str) -> &'a str {
        let start = body
            .find("<nav class=\"breadcrumbs\"")
            .unwrap_or_else(|| panic!("{path} is missing a breadcrumb nav"));
        let end = body[start..]
            .find("</nav>")
            .map(|offset| start + offset + "</nav>".len())
            .expect("breadcrumb nav is closed");
        &body[start..end]
    }

    #[test]
    fn public_pages_render_one_breadcrumb_and_one_current_crumb() {
        let base = "https://rotor.pxbt.app";
        // Static pages are served verbatim and `seo_asset` owns only the
        // dynamic surface; mirror the request precedence to get a status.
        let pages = [
            ("/docs", "Docs"),
            ("/key", "Key explorer"),
            ("/vanity", "Vanity address generator"),
            ("/seed", "Seed phrase studio"),
            ("/mnemonic-converter", "Mnemonic converter"),
            ("/milk-sad", "Milk Sad"),
            ("/tools", "Tools"),
            ("/hex-dec-bin", "Hex, decimal and binary converter"),
            ("/public-key", "Public key to addresses"),
            ("/pubkey-add", "Add public keys"),
            ("/keystore-parser", "Ethereum keystore parser"),
            ("/reconstruction", "Byte-fragment assembler"),
            ("/tx", "Transaction decoders"),
            ("/tx/bitcoin", "Bitcoin"),
            ("/tx/ethereum", "Ethereum"),
            ("/send", "Send transaction"),
            ("/send/bitcoin", "Send transaction"),
            ("/send/ethereum", "Send transaction"),
            ("/send/bnb", "Send transaction"),
            ("/send/usdt", "Send transaction"),
            ("/send/tron", "Send transaction"),
        ];
        for (path, label) in pages {
            let (body, status) = if let Some((body, _, status)) = seo_asset(base, path, "") {
                (body, status)
            } else {
                let (body, content_type) =
                    static_asset(path).unwrap_or_else(|| panic!("{path} is not served"));
                assert_eq!(content_type, "text/html; charset=utf-8", "{path}");
                (
                    String::from_utf8(body.to_vec()).expect("page is valid UTF-8"),
                    200,
                )
            };
            assert_eq!(status, 200, "{path}");
            assert_eq!(
                body.matches("<nav class=\"breadcrumbs\"").count(),
                1,
                "{path} must have exactly one breadcrumb nav"
            );
            let crumbs = breadcrumb_nav_slice(&body, path);
            assert_eq!(
                crumbs.matches("aria-current=\"page\"").count(),
                1,
                "{path} must have exactly one current crumb"
            );
            let crumb = format!("<span aria-current=\"page\">{label}</span>");
            assert!(
                crumbs.contains(&crumb),
                "{path} missing current crumb {crumb:?}"
            );
        }
    }

    #[test]
    fn site_footer_is_shared_and_skips_app_shells() {
        let page = with_site_footer(
            "/docs",
            "<html><body><main>Docs</main></body></html>".into(),
        );
        assert_eq!(page.matches("<footer class=\"site-footer\">").count(), 1);
        for href in [
            "/faq",
            "/disclaimer",
            "/donate",
            "/docs",
            "https://github.com/",
        ] {
            assert!(page.contains(href), "footer misses {href}");
        }
        assert!(page.contains("© 2026 Crypto"));
        assert!(page.contains(ASSET_VERSION));

        // The app and cabinet shells intentionally have no footer.
        for path in ["/app", "/run", "/me", "/cabinet", "/cabinet/wallet"] {
            let shell =
                with_site_footer(path, "<html><body><main>Shell</main></body></html>".into());
            assert!(
                !shell.contains("site-footer"),
                "{path} must not render the marketing footer"
            );
        }

        // A page that already carries one is never given a second.
        let once = with_site_footer("/docs", page.clone());
        assert_eq!(once.matches("<footer class=\"site-footer\">").count(), 1);
        assert!(html_document("T", "", "<main>x</main>").contains("site-footer"));
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
    fn brainwallet_index_lists_18_chains_and_links_the_generator() {
        let base = "https://rotor.pxbt.app";
        let (body, content_type, status) =
            seo_asset(base, "/brainwallet", "").expect("/brainwallet");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(body.contains(&format!("<title>{BRAINWALLET_TITLE}</title>")));
        assert!(body.contains("<span aria-current=\"page\">Brainwallet</span>"));
        assert!(body.contains("18,890"));
        assert!(body.contains("315 pages"));
        assert!(body.contains("href=\"/brainwallet-generator\""));
        assert!(body.contains("brainwallet.css?v=20261128b"));
        assert!(body.contains("<span>Tools</span>"));
        for chain in &CHAINS {
            assert!(
                body.contains(&format!("href=\"/brainwallet/{}\"", chain.slug)),
                "missing chain tile {}",
                chain.slug
            );
        }
        assert_eq!(
            body.matches("class=\"chain-card directory-card\"").count(),
            CHAINS.len()
        );
        // The index is a directory, not the calculator.
        assert!(!body.contains("id=\"brainwallet-form\""));
        assert!(!body.contains("type=\"password\""));
        assert!(!body.contains("brainwallet-directory.js"));
        assert!(body.contains("robots\" content=\"index,follow\""));
        assert!(body.contains("\"@type\":\"BreadcrumbList\""));
        assert!(body.contains(BRAINWALLET_WARNING));
        assert!(body.contains("brainwallet.css?v=20261128b"));
    }

    #[test]
    fn brainwallet_directory_pages_paginate_and_link_assets() {
        let base = "https://rotor.pxbt.app";
        for (path, slug) in [
            ("/brainwallet/bitcoin", "bitcoin"),
            ("/brainwallet/ethereum", "ethereum"),
            ("/brainwallet/solana", "solana"),
            ("/brainwallet/ton", "ton"),
        ] {
            let (body, content_type, status) = seo_asset(base, path, "").expect(path);
            assert_eq!(status, 200, "{path}");
            assert_eq!(content_type, "text/html; charset=utf-8", "{path}");
            assert!(body.contains(&format!("data-chain=\"{slug}\"")), "{path}");
            assert!(body.contains("data-page=\"1\""), "{path}");
            assert!(body.contains("id=\"brainwallet-rows\""), "{path}");
            assert!(body.contains("id=\"brainwallet-balance-toggle\""), "{path}");
            assert!(body.contains("id=\"brainwallet-chain-tabs\""), "{path}");
            assert!(
                body.contains("id=\"brainwallet-total-pages\">#315<"),
                "{path}"
            );
            assert!(
                body.contains("id=\"brainwallet-total-count\">18,890<"),
                "{path}"
            );
            assert!(body.contains("Brainwallets are unsafe"), "{path}");
            assert!(body.contains("brainwallet-engine.js?v=20261128b"), "{path}");
            assert!(
                body.contains("brainwallet-directory.js?v=20261128b"),
                "{path}"
            );
            assert!(body.contains("brainwallet.css?v=20261128b"), "{path}");
            // The directory has no Derive button.
            assert!(!body.contains("id=\"brainwallet-derive\""), "{path}");
        }

        // Page 1 is indexable; page 315 is the 50-row tail and is noindex.
        let (page1, _, _) = seo_asset(base, "/brainwallet/bitcoin", "").expect("page 1");
        assert!(page1.contains("robots\" content=\"index,follow\""));
        let (page315, _, status) =
            seo_asset(base, "/brainwallet/bitcoin/315", "").expect("page 315");
        assert_eq!(status, 200);
        assert!(page315.contains("data-page=\"315\""));
        assert!(page315.contains("id=\"brainwallet-page-number\">#315<"));
        assert!(page315.contains("robots\" content=\"noindex,follow\""));
        let (clamped, _, _) = seo_asset(base, "/brainwallet/bitcoin/999", "").expect("clamped");
        assert!(clamped.contains("data-page=\"315\""));
        assert_eq!(
            seo_asset(base, "/brainwallet/unknown", "").map(|(_, _, status)| status),
            Some(404)
        );
        assert_eq!(
            seo_asset(base, "/brainwallet/bitcoin/nope", "").map(|(_, _, status)| status),
            Some(404)
        );

        // Bitcoin and Litecoin expose the address-type switch; EVM chains do not.
        let (btc, _, _) = seo_asset(base, "/brainwallet/bitcoin", "").expect("btc");
        for kind in ["legacy", "segwit", "script", "taproot"] {
            assert!(btc.contains(&format!("data-type=\"{kind}\"")), "{kind}");
        }
        let (ltc, _, _) = seo_asset(base, "/brainwallet/litecoin", "").expect("ltc");
        for kind in ["legacy", "segwit", "script", "taproot"] {
            assert!(ltc.contains(&format!("data-type=\"{kind}\"")), "{kind}");
        }
        let (eth, _, _) = seo_asset(base, "/brainwallet/ethereum", "").expect("eth");
        assert!(!eth.contains("data-type=\"segwit\""));
    }

    #[test]
    fn brainwallet_generator_is_the_canonical_calculator() {
        let base = "https://rotor.pxbt.app";
        let (body, content_type, status) =
            seo_asset(base, "/brainwallet-generator", "").expect("/brainwallet-generator");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(body.contains(&format!("<title>{BRAINWALLET_GENERATOR_TITLE}</title>")));
        assert!(body.contains(&format!(
            "<link rel=\"canonical\" href=\"{base}/brainwallet-generator\">"
        )));
        assert!(body.contains("robots\" content=\"index,follow\""));
        assert!(body.contains("id=\"brainwallet-network\""));
        for chain in &CHAINS {
            assert!(
                body.contains(&format!("<option value=\"{}\">", chain.slug)),
                "missing network option {}",
                chain.slug
            );
        }
        assert!(body.contains("id=\"brainwallet-count\""));
        assert!(body.contains(">Generate &amp; Check Balance</button>"));
        assert!(body.contains("id=\"brainwallet-auto-balance\""));
        assert!(body.contains("id=\"brainwallet-copy-all\""));
        assert!(body.contains("id=\"brainwallet-csv\""));
        assert!(body.contains("type=\"password\""));
        assert!(body.contains("brainwallet-engine.js?v=20261128b"));
        assert!(body.contains("brainwallet.js?v=20261128b"));
        assert!(body.contains("brainwallet.css?v=20261128b"));
        // Trailing slash resolves to the same canonical page.
        assert!(seo_asset(base, "/brainwallet-generator/", "").is_some());

        let (directory, content_type) =
            static_asset("/brainwallet-directory.js").expect("/brainwallet-directory.js");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        assert!(String::from_utf8_lossy(directory).contains("brainwallet-balance-toggle"));
        let (css, content_type) = static_asset("/brainwallet.css").expect("/brainwallet.css");
        assert_eq!(content_type, "text/css; charset=utf-8");
        assert!(String::from_utf8_lossy(css).contains(".bw-row"));
        let (engine, _) = static_asset("/brainwallet-engine.js").expect("/brainwallet-engine.js");
        let engine = String::from_utf8_lossy(engine);
        assert!(engine.contains("pageRows"));
        assert!(engine.contains("corpusPhrase"));
        let (generator, _) = static_asset("/brainwallet.js").expect("/brainwallet.js");
        let generator = String::from_utf8_lossy(generator);
        assert!(generator.contains("brainwallet-results"));
        assert!(generator.contains("brainwallet-network"));

        let sitemap = render_sitemap(base);
        for path in ["/brainwallet", "/brainwallet-generator"] {
            assert!(
                sitemap.contains(&format!("<loc>{base}{path}</loc>")),
                "sitemap missing {path}"
            );
        }
        for chain in &CHAINS {
            assert!(
                sitemap.contains(&format!("<loc>{base}/brainwallet/{}</loc>", chain.slug)),
                "sitemap missing /brainwallet/{}",
                chain.slug
            );
        }
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
        assert_eq!(body.matches("<nav class=\"breadcrumbs\"").count(), 1);
        assert_eq!(
            breadcrumb_nav_slice(&body, "/key/<hex>")
                .matches("aria-current=\"page\"")
                .count(),
            1
        );
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
    fn seo_key_page_accepts_short_and_prefixed_hex() {
        let base = "https://rotor.pxbt.app";
        let key_one = format!("{:064x}", 1);
        let key_two = format!("{:064x}", 2);
        for path in [
            "/key/1".to_string(),
            "/key/0x1".to_string(),
            "/key/0X1".to_string(),
            format!("/key/0x{key_two}"),
            format!("/key/0X{key_two}"),
        ] {
            let (body, _, status) = seo_asset(base, &path, "").expect(&path);
            assert_eq!(status, 200, "{path}");
            let expected = if path.ends_with(&key_two) {
                key_two.clone()
            } else {
                key_one.clone()
            };
            assert!(
                body.contains(&format!("window.__ROTOR_KEY__=\"{expected}\"")),
                "{path} must render the left-padded key"
            );
        }
        // The plain 64-digit form is unchanged.
        let (body, _, status) =
            seo_asset(base, &format!("/key/{key_one}"), "").expect("/key/<64 hex>");
        assert_eq!(status, 200);
        assert!(body.contains(&format!("window.__ROTOR_KEY__=\"{key_one}\"")));
        // Arbitrary non-key text stays a real 404, not a donor soft-404.
        assert_eq!(seo_asset(base, "/key/zzz", "").unwrap().2, 404);
        assert_eq!(seo_asset(base, "/key/0x0", "").unwrap().2, 404);
        assert_eq!(
            seo_asset(base, &format!("/key/{}", "f".repeat(65)), "")
                .unwrap()
                .2,
            404
        );
    }

    #[test]
    fn seo_key_page_serves_xrp_and_keypair_values() {
        let base = "https://rotor.pxbt.app";
        let family_seed = "snoPBrXtMeMyMHUVTgbuqAfg1SUTb";
        let (body, _, status) =
            seo_asset(base, &format!("/key/{family_seed}"), "").expect("/key/<xrp secret>");
        assert_eq!(status, 200);
        assert!(body.contains(&format!("window.__ROTOR_KEY__=\"{family_seed}\"")));
        assert!(body.contains("noindex,nofollow"));

        let json = format!(
            "[{}]",
            (0..32).map(|n| n.to_string()).collect::<Vec<_>>().join(",")
        );
        let encoded = format!("/key/{}", json.replace('[', "%5B").replace(']', "%5D"));
        let (body, _, status) = seo_asset(base, &encoded, "").expect("/key/<json keypair>");
        assert_eq!(status, 200);
        assert!(body.contains(&format!("window.__ROTOR_KEY__=\"{json}\"")));

        let base58 = bs58::encode([7u8; 64]).into_string();
        let (body, _, status) =
            seo_asset(base, &format!("/key/{base58}"), "").expect("/key/<base58 keypair>");
        assert_eq!(status, 200);
        assert!(body.contains(&format!("window.__ROTOR_KEY__=\"{base58}\"")));

        assert_eq!(percent_decode("%5B1%2C2%5D"), "[1,2]");
        assert!(!is_key_value("short"));
        assert!(is_key_value(family_seed));
        assert!(is_key_value(&base58));
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
            "<title>Bitcoin keys 0x{}…–0x{}… — 64 keys | Crypto</title>",
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
            "/qr.js",
            "/vanity-worker.js",
            "/milk-sad",
        ] {
            assert!(static_asset(path).is_some(), "{path} must be embedded");
        }
        let (worker, content_type) = static_asset("/vanity-worker.js").expect("vanity worker");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let worker = std::str::from_utf8(worker).expect("utf-8 worker");
        assert!(worker.contains("/rotor_wasm.wasm"));
        assert!(worker.contains("derive_report"));
        let (page_js, _) = static_asset("/vanity.js").expect("vanity page script");
        assert!(
            std::str::from_utf8(page_js)
                .expect("utf-8 vanity")
                .contains("/vanity-worker.js")
        );
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
        assert!(script.contains("privateKeyFor"));
        assert!(script.contains("Copy mnemonic"));
        assert!(script.contains("phraseText.textContent = entry.phrase"));
        assert!(SITE_CSS.contains("col-mnemonic"));

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
        let wifs = [
            // key 1, compressed, on each supported mainnet version byte
            "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn", // Bitcoin 0x80
            "T33ydQRKp4FCW5LCLLUB7deioUMoveiwekdwUwyfRDeGZm76aUjV", // Litecoin 0xb0
            "QNcdLVw8fHkixm6NNyN6nVwxKek4u7qrioRbQmjxac5TVoTtZuot", // Dogecoin 0x9e
        ];
        for wif in wifs {
            let (body, _, status) = seo_asset(base, &format!("/key/{wif}"), "").expect("WIF key");
            assert_eq!(status, 200, "{wif}");
            assert!(body.contains("Private key 00000000"), "{wif}");
        }
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
        assert!(html.contains("<script src=\"/theme.js?v=20261128b\"></script>"));
        assert!(html.contains("<script src=\"/wallet-vault.js?v=20261128b\"></script>"));
        assert!(html.contains("<script src=\"/wallet-evm.js?v=20261128b\"></script>"));
        assert!(html.contains("<script src=\"/wallet-btc.js?v=20261128b\"></script>"));
        assert!(html.contains("<script src=\"/wallet.js?v=20261128b\"></script>"));
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
    fn tx_decoder_pages_and_assets_are_served() {
        let (index, content_type) = static_asset("/tx").expect("/tx is embedded");
        assert_eq!(content_type, "text/html; charset=utf-8");
        let index = std::str::from_utf8(index).expect("tx.html is UTF-8");
        for href in ["href=\"/tx/bitcoin\"", "href=\"/tx/ethereum\""] {
            assert!(index.contains(href), "/tx is missing {href}");
        }

        for (path, marker) in [
            ("/tx/bitcoin", "id=\"btc-form\""),
            ("/tx/ethereum", "id=\"evm-form\""),
        ] {
            let (page, content_type) =
                static_asset(path).unwrap_or_else(|| panic!("{path} is embedded"));
            assert_eq!(content_type, "text/html; charset=utf-8");
            let page = std::str::from_utf8(page).expect("tx page is UTF-8");
            assert!(page.contains(marker), "{path} is missing {marker}");
            for script in ["/tx-decoders.js", "/tx-page.js"] {
                assert!(page.contains(script), "{path} does not load {script}");
            }
        }

        let (decoders, content_type) =
            static_asset("/tx-decoders.js").expect("/tx-decoders.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        let decoders = std::str::from_utf8(decoders).expect("tx-decoders.js is UTF-8");
        assert!(decoders.contains("decodeBitcoin"));
        assert!(decoders.contains("decodeEthereum"));
        assert!(decoders.contains("fee unavailable without prevouts"));
        assert!(decoders.contains("RLP is truncated"));

        let (page_script, content_type) =
            static_asset("/tx-page.js").expect("/tx-page.js is embedded");
        assert_eq!(content_type, "application/javascript; charset=utf-8");
        assert!(!page_script.is_empty());

        let tools = std::str::from_utf8(TOOLS_PAGE.as_bytes()).expect("tools page is UTF-8");
        for href in ["href=\"/tx/bitcoin\"", "href=\"/tx/ethereum\""] {
            assert!(tools.contains(href), "tools page is missing {href}");
        }

        let base = "https://rotor.pxbt.app";
        let sitemap = render_sitemap(base);
        for path in ["/tx", "/tx/bitcoin", "/tx/ethereum"] {
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
            ("address-codecs.js", ADDRESS_CODECS_JS),
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
        let render = |path: &str| -> String {
            if let Some((body, _, status)) = seo_asset(base, path, "") {
                assert_eq!(status, 200, "{path}");
                return body;
            }
            // Static pages are served from the embedded shell after seo_asset.
            let (bytes, _) = static_asset(path).unwrap_or_else(|| panic!("{path} is not served"));
            String::from_utf8_lossy(bytes).into_owned()
        };
        for path in [
            "/private-keys",
            "/private-keys/bitcoin",
            "/bitcoin-puzzle",
            "/mnemonic-seeds",
            "/mnemonic-seeds/bitcoin",
            "/seed",
            key_path.as_str(),
            range.as_str(),
        ] {
            let body = render(path);
            for link in [
                "href=\"/\"",
                "href=\"/private-keys\"",
                "href=\"/bitcoin-puzzle\"",
                "href=\"/mnemonic-seeds\"",
                "href=\"/vanity\"",
                "href=\"/milk-sad\"",
                "href=\"/tools\"",
                "href=\"/docs\"",
                "href=\"/cabinet\"",
            ] {
                assert!(body.contains(link), "{path} misses {link}");
            }
            /* The Seeds item belongs to the browsable directory; the studio
             * (/seed) is a tool page and must never be the nav destination. */
            let nav_start = body
                .find("<nav aria-label=\"Main\">")
                .unwrap_or_else(|| panic!("{path} has no main nav"));
            let nav_end = nav_start
                + body[nav_start..]
                    .find("</nav>")
                    .unwrap_or_else(|| panic!("{path} has no nav close"))
                + "</nav>".len();
            let nav = &body[nav_start..nav_end];
            assert!(
                nav.contains("href=\"/mnemonic-seeds\" data-nav=\"seeds\""),
                "{path} Seeds nav must point at /mnemonic-seeds"
            );
            assert!(
                !nav.contains("href=\"/seed\""),
                "{path} Seeds nav must not point at the /seed studio"
            );
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
            body.contains(
                "<title>Bitcoin puzzle browser — client-side key search | Crypto</title>"
            )
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
        assert!(body.contains("id=\"puzzles\""));
        assert!(body.contains("class=\"pz-table data-table\""));
        assert_eq!(body.matches("data-puzzle-row data-solved").count(), 160);
        assert!(body.contains("data-puzzle-filter=\"all\""));
        assert!(body.contains("data-puzzle-filter=\"solved\""));
        assert!(body.contains("data-puzzle-filter=\"unsolved\""));
        assert!(body.contains("data-puzzle-filter=\"all\" aria-pressed=\"false\""));
        assert!(body.contains("data-puzzle-filter=\"unsolved\" aria-pressed=\"true\""));
        assert!(body.contains("data-puzzle-search"));
        assert!(body.contains("Start hunting"));
        assert!(body.contains("BTC claimed"));
        assert!(body.contains("BTC left"));
        assert!(body.contains("What is a Bitcoin puzzle?"));
        assert!(body.contains("Popular tools"));
        assert!(body.contains("data-balance-address"));
        assert!(body.contains("data-tx-address"));
        assert!(body.contains("data-copy"));
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
        assert!(body.contains("<title>Bitcoin Puzzle #71 — Random Keys | Crypto</title>"));
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
        assert!(body.contains("data-mode-value=\"random\""));
        assert!(body.contains("data-mode-value=\"seq\""));
        assert!(body.contains("data-mode-value=\"team\""));
        assert!(body.contains("data-puzzle-resume-btn"));
        assert!(body.contains("data-puzzle-results"));
        assert!(body.contains("data-puzzle-community"));
        assert!(body.contains("data-puzzle-check"));
        assert!(body.contains("data-puzzle-match"));
        assert!(body.contains("data-puzzle-copy"));
        assert_eq!(body.matches("class=\"pz-metric\"").count(), 6);
        assert!(body.contains(">Generated</span>"));
        assert!(body.contains(">Speed</span>"));
        assert!(body.contains(">ETA</span>"));
        assert!(body.contains(">Network</span>"));
        assert!(body.contains("data-range-preset=\"full\""));
        assert!(body.contains("data-range-preset=\"first\""));
        assert!(body.contains("data-range-preset=\"second\""));
        assert!(body.contains("data-range-preset=\"q4\""));
        assert!(body.contains("data-puzzle-start-btn"));
        assert!(body.contains("data-puzzle-stop-btn"));
        assert!(body.contains("data-puzzle-reset-btn"));
        assert!(body.contains("<script src=\"/puzzle-browser.js\" defer></script>"));

        let (detail, _, status) =
            seo_asset(base, "/bitcoin-puzzle/71/detail", "").expect("#71 detail");
        assert_eq!(status, 200);
        assert!(detail.contains(&format!(
            "<link rel=\"canonical\" href=\"{base}/bitcoin-puzzle/71\">"
        )));
        assert!(detail.contains(target));
        assert!(detail.contains(&format!("https://mempool.space/address/{target}")));
        assert!(detail.contains(&format!("https://www.blockchain.com/btc/address/{target}")));
        assert!(detail.contains("data-puzzle-balance"));
        assert!(detail.contains("Puzzle #71 is unsolved"));
        assert!(detail.contains("data-puzzle-check"));
        assert!(detail.contains("data-copy"));
        assert!(detail.contains("1,180,591,620,717,411,303,424"));
        assert!(detail.contains(
            "/private-keys/bitcoin?key=0000000000000000000000000000000000000000000000400000000000000000"
        ));
        assert!(!detail.contains("data-puzzle-app"));

        let (short, _, status) =
            seo_asset(base, "/bitcoin-puzzle/71", "").expect("#71 short route");
        assert_eq!(status, 200);
        assert!(short.contains(
            "<link rel=\"canonical\" href=\"https://rotor.pxbt.app/bitcoin-puzzle/71\">"
        ));
        assert!(!short.contains("/bitcoin-puzzle/71/detail"));

        let (unsolved, _, status) =
            seo_asset(base, "/bitcoin-puzzle/unsolved", "").expect("/bitcoin-puzzle/unsolved");
        assert_eq!(status, 200);
        assert!(
            unsolved
                .contains("<title>Unsolved Bitcoin puzzles — local browser scan | Crypto</title>")
        );
        assert!(unsolved.contains(target));
        assert!(!unsolved.contains("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"));
        assert!(unsolved.contains("data-puzzle-picker"));
    }

    #[test]
    fn puzzle_detail_alias_redirects_permanently_to_short_url() {
        assert_eq!(
            redirect_target("/bitcoin-puzzle/71/detail"),
            Some("/bitcoin-puzzle/71".to_string())
        );
        assert_eq!(
            redirect_target("/bitcoin-puzzle/71/detail/"),
            Some("/bitcoin-puzzle/71".to_string())
        );
        // The already-canonical views and unknown puzzle numbers do not redirect.
        assert_eq!(redirect_target("/bitcoin-puzzle/71"), None);
        assert_eq!(redirect_target("/bitcoin-puzzle/71/random"), None);
        assert_eq!(redirect_target("/bitcoin-puzzle/0/detail"), None);
        assert_eq!(redirect_target("/bitcoin-puzzle/161/detail"), None);
        assert_eq!(redirect_target("/bitcoin-puzzle/71/detail/extra"), None);

        let response = redirect_response("/bitcoin-puzzle/71");
        assert_eq!(response.status_code().0, 301);
        assert_eq!(
            format!("{}", response.headers()[0]),
            "Location: /bitcoin-puzzle/71"
        );
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

    #[test]
    fn tron_address_shape_is_validated() {
        assert!(valid_tron_address("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"));
        for bad in [
            "",
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6",
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tt",
            "AR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60",
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6O",
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6I",
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6l",
        ] {
            assert!(!valid_tron_address(bad), "must reject {bad}");
        }
    }

    #[test]
    fn tron_batch_body_is_validated_and_deduplicated() {
        let address = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
        let body = json!({ "addresses": [address, address] }).to_string();
        assert_eq!(
            validate_tron_batch(&body).expect("valid batch"),
            vec![address.to_string()],
            "duplicates fold into one lookup"
        );

        let sixty: Vec<&str> = (0..60).map(|_| address).collect();
        let body = json!({ "addresses": sixty }).to_string();
        assert_eq!(validate_tron_batch(&body).expect("60 is allowed").len(), 1);

        let sixty_one: Vec<&str> = (0..61).map(|_| address).collect();
        let body = json!({ "addresses": sixty_one }).to_string();
        assert_eq!(
            validate_tron_batch(&body),
            Err("too many addresses (maximum 60)")
        );

        let body = json!({ "addresses": ["0R7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"] }).to_string();
        assert_eq!(validate_tron_batch(&body), Err("invalid tron address"));

        assert_eq!(
            validate_tron_batch("not json"),
            Err("invalid JSON body"),
            "malformed JSON is a 400, not a provider error"
        );
        assert_eq!(
            validate_tron_batch("{}"),
            Err("invalid JSON body"),
            "a missing addresses field is a 400"
        );
        assert_eq!(
            validate_tron_batch(r#"{"addresses": [1]}"#),
            Err("invalid JSON body"),
            "non-string addresses are a 400"
        );
    }

    #[test]
    fn tron_balance_parsing_handles_overflow_and_strings() {
        assert_eq!(
            parse_tron_balance(&json!({ "balance": 1393900000 })),
            Ok(Some("1393900000".to_string()))
        );
        assert_eq!(
            parse_tron_balance(&json!({ "balance": u64::MAX })),
            Ok(Some(u64::MAX.to_string()))
        );
        assert_eq!(
            parse_tron_balance(&json!({ "balance": i64::MIN })),
            Ok(None),
            "a negative provider balance is an overflow, not a real value"
        );
        assert_eq!(parse_tron_balance(&json!({ "balance": "-1" })), Ok(None));
        assert_eq!(
            parse_tron_balance(&json!({ "balance": "1000000" })),
            Ok(Some("1000000".to_string()))
        );
        assert_eq!(
            parse_tron_balance(&json!({ "balance": null })),
            Ok(Some("0".to_string()))
        );
        assert_eq!(parse_tron_balance(&json!({})), Ok(Some("0".to_string())));
        assert_eq!(parse_tron_balance(&json!({ "balance": "nope" })), Err(()));
    }

    #[test]
    fn tron_transaction_parsing_reads_count_and_timestamp() {
        let tx = json!({
            "rangeTotal": 1015112,
            "total": 1015112,
            "data": [{ "timestamp": 1700000000000u64 }]
        });
        assert_eq!(parse_tron_tx_count(&tx, &json!({})), 1015112);
        assert_eq!(parse_tron_last_tx(&tx), Some(1700000000000));
        assert_eq!(parse_tron_last_tx(&json!({ "data": [] })), None);
        assert_eq!(
            parse_tron_tx_count(&json!({ "total": "42" }), &json!({})),
            42
        );
        assert_eq!(
            parse_tron_tx_count(&json!({}), &json!({ "totalTransactionCount": 7 })),
            7
        );
        assert_eq!(
            parse_tron_last_tx(&json!({ "data": [{ "block_ts": "1700000000001" }] })),
            Some(1700000000001)
        );
    }

    #[test]
    fn tron_response_reports_overflow_without_a_wrong_balance() {
        let address = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
        let tx = json!({
            "rangeTotal": 1015112,
            "data": [{ "timestamp": 1700000000000u64 }]
        });

        let overflow =
            tron_response(address, &json!({ "balance": i64::MIN }), &tx).expect("response");
        assert_eq!(overflow["chain"], "tron");
        assert_eq!(overflow["address"], address);
        assert!(overflow["balance_sun"].is_null());
        assert_eq!(overflow["balance_error"], "provider_overflow");
        assert_eq!(overflow["tx_count"], 1015112);
        assert_eq!(overflow["last_tx_at"], 1700000000000u64);
        assert_eq!(overflow["source"], "tronscan");

        let normal = tron_response(
            address,
            &json!({ "balance": 1393900000 }),
            &json!({ "total": 3 }),
        )
        .expect("response");
        assert_eq!(normal["balance_sun"], "1393900000");
        assert!(normal.get("balance_error").is_none());
        assert_eq!(normal["tx_count"], 3);
        assert!(normal["last_tx_at"].is_null());

        let inactive = tron_response(address, &serde_json::Value::Null, &serde_json::Value::Null)
            .expect("response");
        assert_eq!(inactive["balance_sun"], "0");
        assert_eq!(inactive["tx_count"], 0);
        assert!(inactive["last_tx_at"].is_null());
    }
}
