//! Distributed coordinator: a token-protected HTTP/JSON API plus a static
//! dashboard.
//!
//! One thread accepts requests and one thread per request does the work; state
//! lives behind a single mutex. No async runtime, no TLS (terminate it in a
//! reverse proxy).

pub mod chunk_loop;
pub mod client;
pub mod state;

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
const MONITOR_PAGE: &str = include_str!("../../apps/site/monitor.html");
const MONITOR_JS: &str = include_str!("../../apps/site/monitor.js");
const ROTOR_WORKER: &str = include_str!("../../apps/site/rotor-worker.js");
const ROTOR_WASM: &[u8] = include_bytes!("../../apps/site/rotor_wasm.wasm");
const WALLETCONNECT_JS: &[u8] = include_bytes!("../../apps/site/walletconnect.js");
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
        let now = Instant::now();
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let bucket = buckets.entry(key.to_string()).or_insert_with(|| Bucket {
            tokens: RATE_BURST,
            last: now,
        });
        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * RATE_PER_SECOND).min(RATE_BURST);
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
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            open_registration: false,
            trust_proxy: false,
            monitor_domain: "localhost".to_string(),
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
    if path == "/api/v1/summary" || path == "/api/v1/register" || path == "/api/v1/monitor/config" {
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
            respond_redirect(request, location);
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
            // Unknown non-API paths fall back to the landing page.
            let response = Response::from_string(LANDING)
                .with_header(header("Content-Type", "text/html; charset=utf-8"));
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

    // The address monitor has its own store, sessions and rate limits; its
    // routes never enter the coordinator token matrix below.
    if path.starts_with("/api/v1/monitor/") {
        match app.monitor.as_ref() {
            Some(store) => crate::monitor::api::handle(
                store,
                &app.monitor_domain,
                app.trust_proxy,
                request,
                &method,
                path,
                query,
            ),
            None => respond_json(request, 404, &json!({"error": "not found"})),
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
        "/walletconnect.js" => Some((WALLETCONNECT_JS, "application/javascript; charset=utf-8")),
        "/favicon.ico" => Some((FAVICON_ICO, "image/x-icon")),
        "/favicon.png" => Some((FAVICON_PNG, "image/png")),
        "/cabinet" => Some((MONITOR_PAGE.as_bytes(), "text/html; charset=utf-8")),
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

/// `/monitor` was renamed to `/cabinet`; keep the old URL as a permanent
/// redirect and serve the same assets from both script paths.
fn redirect_target(path: &str) -> Option<&'static str> {
    (path == "/monitor").then_some("/cabinet")
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

/// One server-rendered chain hub under `/keys/<slug>`.
struct ChainHub {
    slug: &'static str,
    name: &'static str,
    description: &'static str,
    intro: &'static str,
    /// Solana key pages derive on ed25519; the others default to secp256k1.
    curve_suffix: &'static str,
}

const CHAINS: [ChainHub; 4] = [
    ChainHub {
        slug: "bitcoin",
        name: "Bitcoin",
        description: "Bitcoin private key examples with legacy P2PKH, SegWit and Taproot address derivation.",
        intro: "Every private key maps to Bitcoin addresses. Open an example key to see its P2PKH, SegWit and Taproot addresses derived locally in your browser.",
        curve_suffix: "",
    },
    ChainHub {
        slug: "ethereum",
        name: "Ethereum",
        description: "Ethereum and EVM private key examples derived from secp256k1 keys.",
        intro: "Ethereum addresses come from the secp256k1 public key. Open an example key to see its EVM address derived locally in your browser.",
        curve_suffix: "",
    },
    ChainHub {
        slug: "tron",
        name: "TRON",
        description: "TRON private key examples with Base58Check address derivation.",
        intro: "TRON addresses use the same secp256k1 curve as Bitcoin and EVM. Open an example key to see its Base58Check address derived locally in your browser.",
        curve_suffix: "",
    },
    ChainHub {
        slug: "solana",
        name: "Solana",
        description: "Solana private key examples derived on the ed25519 curve.",
        intro: "Solana accounts use ed25519 keys. Every key page on this hub switches the derivation to ed25519 and runs locally in your browser.",
        curve_suffix: "?curve=ed25519",
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
    if path == "/keys" {
        return Some((render_keys_hub(base), HTML, 200));
    }
    if let Some(rest) = path.strip_prefix("/keys/") {
        if let Some((slug, range_text)) = rest.split_once('/') {
            let Some(chain) = chain_by_slug(slug) else {
                return Some((render_seo_not_found(), HTML, 404));
            };
            return Some(match parse_key_range(range_text) {
                Some(range) => (render_range_page(base, chain, &range), HTML, 200),
                None => (render_seo_not_found(), HTML, 404),
            });
        }
        return Some(match chain_by_slug(rest) {
            Some(chain) => (render_chain_hub(base, chain), HTML, 200),
            None => (render_seo_not_found(), HTML, 404),
        });
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

fn site_header() -> &'static str {
    "<header class=\"site-nav\">\
     <a class=\"brand\" href=\"/\">Rotor <span>Coordinator</span></a>\
     <nav>\
     <a href=\"/keys\" class=\"active\">Keys</a>\
     <a href=\"/app\">App</a>\
     <a href=\"/cabinet\">Cabinet</a>\
     <a href=\"/docs\">Docs</a>\
     </nav></header>"
}

fn html_document(title: &str, head_extra: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n\
         <link rel=\"stylesheet\" href=\"/site.css\">\n\
         {head_extra}</head>\n<body>\n{body}</body>\n</html>\n",
        escape_attr(title)
    )
}

fn json_ld(value: &serde_json::Value) -> String {
    format!("<script type=\"application/ld+json\">{value}</script>\n")
}

fn render_key_page(base: &str, key: &str, curve: &str) -> String {
    let first = &key[..8];
    let last = &key[key.len() - 4..];
    let short = format!("{first}…{last}");
    let canonical = format!("{base}/key/{key}");
    let title = format!("Private key {short} — Bitcoin, EVM, TRON addresses | Rotor");
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
            { "@type": "ListItem", "position": 2, "name": "Keys", "item": format!("{base}/keys") },
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
        ("Keys", Some("/keys")),
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
    html.replacen(
        "<script src=\"/key.js",
        &format!("{payload}<script src=\"/key.js"),
        1,
    )
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
            { "@type": "ListItem", "position": 2, "name": "Keys", "item": format!("{base}/keys") },
            { "@type": "ListItem", "position": 3, "name": chain.name, "item": format!("{base}/keys/{}", chain.slug) },
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

    let chain_href = format!("/keys/{}", chain.slug);
    let crumbs = breadcrumb_nav(&[
        ("Home", Some("/")),
        ("Keys", Some("/keys")),
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
    html.replacen(
        "<script src=\"/range.js",
        &format!("{payload}<script src=\"/range.js"),
        1,
    )
}

fn render_keys_hub(base: &str) -> String {
    let canonical = format!("{base}/keys");
    let title = "Private key explorer — Bitcoin, Ethereum, TRON, Solana | Rotor";
    let description = "Browse Rotor's public key hubs for Bitcoin, Ethereum, TRON and Solana. Each hub lists deterministic example private keys and derives addresses locally in your browser.";
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
            { "@type": "ListItem", "position": 2, "name": "Keys", "item": canonical },
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
                "url": format!("{base}/keys/{}", chain.slug),
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
        cards.push_str(&format!(
            "<li><h2><a href=\"/keys/{}\">{}</a></h2><p>{}</p></li>",
            chain.slug,
            chain.name,
            escape_attr(chain.description)
        ));
    }
    let body = format!(
        "{}{}<main class=\"key-page\">{}<section class=\"hero\"><h1>Private key explorer</h1>\
         <p>Pick a chain hub to browse deterministic example private keys. Every key page derives public addresses in the browser and never asks for a seed phrase.</p></section>\
         <section class=\"card\"><h2>Chains</h2><ul class=\"key-chains\">{cards}</ul></section>\
         <section class=\"card\"><h2>What this page shows</h2>\
         <p>These pages explain how a private key maps to public addresses on each chain. They list example keys only; no balances, holdings or account values are shown.</p></section>\
         </main>",
        site_header(),
        "",
        breadcrumb_nav(&[("Home", Some("/")), ("Keys", None)]),
    );
    html_document(title, &head, &body)
}

fn render_chain_hub(base: &str, chain: &ChainHub) -> String {
    let canonical = format!("{base}/keys/{}", chain.slug);
    let title = format!(
        "{} private key explorer — 64 example keys | Rotor",
        chain.name
    );
    let description = format!(
        "{} Open one of 64 deterministic example private keys to derive public addresses locally in your browser.",
        chain.description
    );
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
    let crumb_label = chain.name;
    let ld_crumbs = json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": format!("{base}/") },
            { "@type": "ListItem", "position": 2, "name": "Keys", "item": format!("{base}/keys") },
            { "@type": "ListItem", "position": 3, "name": crumb_label, "item": canonical },
        ],
    });

    let mut rows = String::new();
    let mut entries = Vec::with_capacity(64);
    for value in 1u8..=64 {
        let hex = format!("{value:064x}");
        let short = format!("{}…{}", &hex[..8], &hex[56..]);
        rows.push_str(&format!(
            "<tr><td>{value}</td><td><a class=\"mono\" href=\"/key/{hex}{}\">{short}</a></td></tr>",
            chain.curve_suffix
        ));
        entries.push(json!({
            "@type": "ListItem",
            "position": value,
            "url": format!("{base}/key/{hex}{}", chain.curve_suffix),
        }));
    }
    let curated_start = format!("{:064x}", 1u8);
    let curated_end = format!("{:064x}", 64u8);
    let curated_range = format!("/keys/{}/{curated_start}-{curated_end}", chain.slug);
    entries.push(json!({
        "@type": "ListItem",
        "position": 65,
        "name": "Curated key range 1–64",
        "url": format!("{base}{curated_range}"),
    }));
    let ld_items = json!({
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": format!("{} example private keys", chain.name),
        "numberOfItems": 65,
        "itemListElement": entries,
    });
    let head = hub_head(
        &canonical,
        &title,
        &description,
        &[ld_app, ld_crumbs, ld_items],
    );

    let mut other_links = String::new();
    for other in CHAINS.iter().filter(|other| other.slug != chain.slug) {
        other_links.push_str(&format!(
            "<li><a href=\"/keys/{}\">{}</a></li>",
            other.slug, other.name
        ));
    }
    let body = format!(
        "{}{}<main class=\"key-page\">{}<section class=\"hero\"><h1>{} private key explorer</h1>\
         <p>{}</p></section>\
         <section class=\"card\"><h2>Example keys</h2>\
         <p>The same 64 deterministic keys (1 to 64) appear on every hub. Each link opens the key page for that chain.</p>\
         <p><a href=\"{curated_range}\">Browse the curated 1–64 key range</a> to derive all 64 example keys on one page.</p>\
         <table class=\"keys-table\"><thead><tr><th>#</th><th>Private key</th></tr></thead><tbody>{rows}</tbody></table></section>\
         <section class=\"card\"><h2>Other chains</h2><ul>{other_links}</ul></section>\
         <section class=\"card\"><h2>What this page shows</h2>\
         <p>Each key page derives public addresses from the key locally in your browser. This hub lists no balances, holdings or account values; nothing is fetched until you open a key and request a balance check.</p></section>\
         </main>",
        site_header(),
        "",
        breadcrumb_nav(&[
            ("Home", Some("/")),
            ("Keys", Some("/keys")),
            (crumb_label, None)
        ]),
        chain.name,
        escape_attr(chain.intro),
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
        "  <url><loc>{}/keys</loc></url>\n",
        escape_attr(base)
    ));
    for chain in &CHAINS {
        urls.push_str(&format!(
            "  <url><loc>{}/keys/{}</loc></url>\n",
            escape_attr(base),
            chain.slug
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
    fn seo_hubs_render_canonical_and_json_ld() {
        let base = "https://rotor.pxbt.app";
        let (body, content_type, status) = seo_asset(base, "/keys", "").expect("/keys");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(body.contains("<link rel=\"canonical\" href=\"https://rotor.pxbt.app/keys\">"));
        assert!(body.contains("application/ld+json"));
        assert!(body.contains("\"@type\":\"BreadcrumbList\""));
        assert!(body.contains("\"@type\":\"ItemList\""));
        assert!(!body.contains("noindex"));

        let (body, _, status) = seo_asset(base, "/keys/bitcoin", "").expect("/keys/bitcoin");
        assert_eq!(status, 200);
        assert!(
            body.contains("<link rel=\"canonical\" href=\"https://rotor.pxbt.app/keys/bitcoin\">")
        );
        assert!(body.contains("<table class=\"keys-table\">"));
        assert!(body.matches("/key/").count() >= 64);
        assert!(body.contains("robots\" content=\"index,follow"));

        assert_eq!(seo_asset(base, "/keys/unknown", "").unwrap().2, 404);
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
        assert!(body.contains("href=\"/keys/bitcoin\""));

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
        let (body, _, status) = seo_asset(base, "/keys/solana", "").expect("hub");
        assert_eq!(status, 200);
        assert!(body.contains(&format!("href=\"/keys/solana/{one}-{sixty_four}\"")));
        assert!(body.contains(&format!("{base}/keys/solana/{one}-{sixty_four}")));
    }

    #[test]
    fn monitor_moved_to_cabinet() {
        assert_eq!(redirect_target("/monitor"), Some("/cabinet"));
        assert_eq!(redirect_target("/cabinet"), None);
        assert_eq!(redirect_target("/monitor.js"), None);
    }

    #[test]
    fn robots_and_sitemap_have_expected_content_types() {
        let base = "https://rotor.pxbt.app";
        let (robots, content_type, status) = seo_asset(base, "/robots.txt", "").expect("robots");
        assert_eq!(status, 200);
        assert_eq!(content_type, "text/plain; charset=utf-8");
        assert!(robots.contains("Disallow: /api/"));
        assert!(robots.contains("Disallow: /cabinet"));
        assert!(robots.contains("Sitemap: https://rotor.pxbt.app/sitemap.xml"));

        let (sitemap, content_type, status) = seo_asset(base, "/sitemap.xml", "").expect("sitemap");
        assert_eq!(status, 200);
        assert_eq!(content_type, "application/xml; charset=utf-8");
        assert!(sitemap.contains("<loc>https://rotor.pxbt.app/keys/bitcoin</loc>"));
        assert!(!sitemap.contains("/key/"));
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
}
