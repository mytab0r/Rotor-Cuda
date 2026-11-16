//! Distributed coordinator: a token-protected HTTP/JSON API plus a static
//! dashboard.
//!
//! One thread accepts requests and one thread per request does the work; state
//! lives behind a single mutex. No async runtime, no TLS (terminate it in a
//! reverse proxy).

pub mod chunk_loop;
pub mod client;
pub mod state;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use serde::Deserialize;
use serde_json::json;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use state::{ERR_JOB_NOT_FOUND, ERR_MANIFEST_MISMATCH};

/// The dashboard is embedded so the binary stays a single file.
const DASHBOARD: &str = include_str!("../../web/index.html");

struct App {
    state: Mutex<state::State>,
    token: String,
}

impl App {
    fn lock(&self) -> MutexGuard<'_, state::State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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

/// Bind and serve. `bind` may use port `0`; the real address is in [`ServerHandle::addr`].
pub fn spawn(bind: &str, state_path: &Path, token: String) -> Result<ServerHandle, String> {
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
        token,
    });
    let listener = Arc::clone(&server);
    let join = thread::spawn(move || {
        for request in listener.incoming_requests() {
            let app = Arc::clone(&app);
            thread::spawn(move || handle(app, request));
        }
    });
    Ok(ServerHandle {
        addr,
        server,
        join: Some(join),
    })
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

    if !authorized(&request, &app.token) {
        respond_json(request, 401, &json!({"error": "unauthorized"}));
        return;
    }

    match (method, path) {
        (Method::Get, "/api/v1/jobs") => {
            let jobs = app.lock().list_jobs();
            respond_json(request, 200, &json!({ "jobs": jobs }));
        }
        (Method::Post, "/api/v1/jobs") => create_job(&app, request),
        (Method::Post, "/api/v1/lease") => lease(&app, request),
        (Method::Post, "/api/v1/heartbeat") => heartbeat(&app, request),
        (Method::Post, "/api/v1/result") => submit_result(&app, request),
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
        Err(message) => return respond_json(request, 400, &json!({ "error": message })),
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

fn lease(app: &App, mut request: Request) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(message) => return respond_json(request, 400, &json!({ "error": message })),
    };
    let lease_request: state::LeaseRequest = match serde_json::from_str(&body) {
        Ok(lease_request) => lease_request,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
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
    client_id: String,
    job_id: String,
    chunk_index: u64,
    #[serde(default)]
    scanned: u64,
    #[serde(default)]
    rate: f64,
    #[serde(default)]
    done: bool,
}

fn heartbeat(app: &App, mut request: Request) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(message) => return respond_json(request, 400, &json!({ "error": message })),
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
    let now = state::now_secs();
    let result = app.lock().heartbeat(
        &heartbeat.client_id,
        &heartbeat.job_id,
        heartbeat.chunk_index,
        heartbeat.scanned,
        heartbeat.rate,
        heartbeat.done,
        now,
    );
    match result {
        Ok(expires_at) => respond_json(request, 200, &json!({ "expires_at": expires_at })),
        Err(message) => respond_json(request, 409, &json!({ "error": message })),
    }
}

#[derive(Deserialize)]
struct ResultRequest {
    client_id: String,
    job_id: String,
    key: String,
}

fn submit_result(app: &App, mut request: Request) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(message) => return respond_json(request, 400, &json!({ "error": message })),
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
    let result = app.lock().submit_result(
        &result_request.client_id,
        &result_request.job_id,
        &result_request.key,
    );
    match result {
        Ok(()) => respond_json(request, 200, &json!({ "accepted": true })),
        Err(message) if message == ERR_JOB_NOT_FOUND => {
            respond_json(request, 404, &json!({ "error": message }))
        }
        Err(message) => respond_json(request, 400, &json!({ "error": message })),
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
        Err(message) => return respond_json(request, 400, &json!({ "error": message })),
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

fn read_body(request: &mut Request) -> Result<String, String> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|err| format!("cannot read request body: {err}"))?;
    Ok(body)
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

fn authorized(request: &Request, token: &str) -> bool {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
        .is_some_and(|presented| constant_time_eq(presented.as_bytes(), token.as_bytes()))
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

fn respond_empty(request: Request, status: u16) {
    let _ = request.respond(Response::empty(StatusCode(status)));
}
