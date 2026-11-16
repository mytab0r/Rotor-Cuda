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

use crate::hashes::sha256;
use state::{ERR_INVALID_SAMPLE, ERR_JOB_NOT_FOUND, ERR_LEASE_LOST, ERR_MANIFEST_MISMATCH};

/// The dashboard is embedded so the binary stays a single file.
const DASHBOARD: &str = include_str!("../../web/index.html");
/// Largest request body the coordinator buffers (JSON commands are tiny).
const MAX_BODY_BYTES: usize = 1024 * 1024;
/// Requests handled concurrently; the rest are rejected with 503.
const MAX_CONCURRENT_REQUESTS: usize = 32;
/// Per-token rate limit: requests per second and the bucket depth.
const RATE_PER_SECOND: f64 = 20.0;
const RATE_BURST: f64 = 40.0;

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

    /// Client id whose stored hash matches the presented token, if any.
    ///
    /// Every entry is compared in constant time and the iteration never exits
    /// early on a match, so timing does not reveal which client matched.
    fn identify(&self, token: &str) -> Option<String> {
        let digest = sha256(token.as_bytes());
        let mut found = None;
        for (id, stored) in &self.tokens {
            if constant_time_eq(&digest, stored) {
                found = Some(id.clone());
            }
        }
        found
    }
}

/// Accepted identity for one request.
#[derive(Clone)]
enum Identity {
    /// The admin token (`--token`/`ROTOR_COORD_TOKEN`).
    Admin,
    /// A client from the `--clients` map.
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

struct App {
    state: Mutex<state::State>,
    admin_token: String,
    clients: Clients,
    rate: RateLimiter,
}

impl App {
    fn lock(&self) -> MutexGuard<'_, state::State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// True when no `--clients` file was given: the single admin token is
    /// accepted for every endpoint (legacy mode).
    fn legacy(&self) -> bool {
        self.clients.is_empty()
    }

    fn identity(&self, request: &Request) -> Option<Identity> {
        let presented = bearer(request)?;
        if constant_time_eq(presented.as_bytes(), self.admin_token.as_bytes()) {
            return Some(Identity::Admin);
        }
        self.clients.identify(presented).map(Identity::Client)
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
        if method == &Method::Post && path == "/api/v1/jobs" {
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
    spawn_with_clients(bind, state_path, token, Clients::default())
}

/// Bind and serve with the given per-client token map.
///
/// An empty map keeps the legacy single-token behavior (the admin token works
/// on every endpoint). With a map, lease/heartbeat/result require a client
/// token and job creation requires the admin token.
pub fn spawn_with_clients(
    bind: &str,
    state_path: &Path,
    token: String,
    clients: Clients,
) -> Result<ServerHandle, String> {
    if token.is_empty() {
        return Err("the coordinator token must not be empty".to_string());
    }
    let state = state::State::open(state_path)?;
    let server = Server::http(bind).map_err(|err| format!("cannot bind {bind}: {err}"))?;
    let addr = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| format!("cannot resolve the bound address of {bind}"))?;
    let server = Arc::new(server);
    let app = Arc::new(App {
        state: Mutex::new(state),
        admin_token: token,
        clients,
        rate: RateLimiter::default(),
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

    if method == Method::Get && path == "/" {
        let response = Response::from_string(DASHBOARD)
            .with_header(header("Content-Type", "text/html; charset=utf-8"));
        let _ = request.respond(response);
        return;
    }

    if !path.starts_with("/api/v1/") {
        respond_json(request, 404, &json!({"error": "not found"}));
        return;
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
        (Method::Get, "/api/v1/bsgs/state") => bsgs_get(&app, request, query),
        (Method::Post, "/api/v1/bsgs/state") => bsgs_put(&app, request),
        _ => respond_json(request, 404, &json!({"error": "not found"})),
    }
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
enum BodyError {
    TooLarge,
    Io(String),
}

fn read_body(request: &mut Request) -> Result<String, BodyError> {
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

fn respond_body_error(request: Request, error: BodyError) {
    match error {
        BodyError::TooLarge => respond_json(
            request,
            413,
            &json!({ "error": "request body exceeds 1 MiB" }),
        ),
        BodyError::Io(message) => respond_json(request, 400, &json!({ "error": message })),
    }
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
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

fn respond_json<T: serde::Serialize>(request: Request, status: u16, value: &T) {
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
}
