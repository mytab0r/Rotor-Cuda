//! End-to-end tests for the coordinator HTTP API and its blocking client.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rotor::base58;
use rotor::bsgs::TableManifest;
use rotor::coordinator::client::CoordinatorClient;
use rotor::coordinator::orders::{Orders, OrdersConfig};
use rotor::coordinator::{
    Clients, ServerOptions, spawn, spawn_with_clients, spawn_with_monitor_options,
    spawn_with_options,
};
use rotor::monitor::store::MonitorStore;
use rotor::scalar::Scalar;
use rotor::secp;
use serde_json::json;
use sha2::{Digest, Sha256};

const TOKEN: &str = "test-token";

struct TempState {
    path: PathBuf,
}

impl TempState {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "rotor-coord-api-{}-{nanos}-{tag}.json",
            std::process::id()
        ));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempState {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(format!("{}.tmp", self.path.display()));
    }
}

fn raw(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> (u16, String, String) {
    raw_with_headers(addr, method, path, token, body, &[])
}

fn raw_with_headers(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> (u16, String, String) {
    let mut stream = TcpStream::connect(addr).expect("connect to coordinator");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("read timeout");
    let payload = body.unwrap_or("");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if body.is_some() {
        request.push_str("Content-Type: application/json\r\n");
    }
    for (name, value) in extra_headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str(&format!(
        "Content-Length: {}\r\n\r\n{payload}",
        payload.len()
    ));
    stream.write_all(request.as_bytes()).expect("write request");
    let mut response = Vec::new();
    stream.read_to_end(&mut response).expect("read response");
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("header terminator");
    let head = String::from_utf8_lossy(&response[..split]).into_owned();
    let body = &response[split + 4..];
    let body = match response_header(&head, "transfer-encoding") {
        Some(value) if value.to_ascii_lowercase().contains("chunked") => decode_chunked(body),
        _ => body.to_vec(),
    };
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .expect("status code");
    (status, head, String::from_utf8_lossy(&body).into_owned())
}

/// Decode a chunked body. tiny_http frames any response at or above 32 KiB, so
/// a large asset arrives chunked; reading the raw bytes would leave chunk sizes
/// inside the payload and miss a string that straddles a chunk boundary.
fn decode_chunked(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(size_end) = rest.windows(2).position(|window| window == b"\r\n") {
        let size_text = String::from_utf8_lossy(&rest[..size_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .unwrap_or(0);
        let after = &rest[size_end + 2..];
        if size == 0 {
            break;
        }
        let take = size.min(after.len());
        out.extend_from_slice(&after[..take]);
        rest = if after.len() >= take + 2 && &after[take..take + 2] == b"\r\n" {
            &after[take + 2..]
        } else {
            &after[take..]
        };
    }
    out
}

fn response_header(head: &str, name: &str) -> Option<String> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(field, _)| field.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().to_string())
}

/// Every value of a repeated response header (`Set-Cookie` in particular).
fn response_headers(head: &str, name: &str) -> Vec<String> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(field, _)| field.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim().to_string())
        .collect()
}

fn cookie_pair<'a>(cookies: &'a [String], name: &str) -> Option<&'a str> {
    cookies.iter().find_map(|cookie| {
        let (pair, _) = cookie.split_once(';').unwrap_or((cookie, ""));
        let (candidate, value) = pair.split_once('=')?;
        (candidate == name).then_some(value)
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Mint a cookie exactly as the documented wire format says, so the test owns
/// the contract instead of calling a helper that could drift with the server.
/// The nonce comes from the OS RNG, like production: a fixed literal here would
/// be a hard-coded cryptographic value even though the test is deterministic
/// in every other respect.
fn test_admin_cookie(token: &str, expires_at: u64) -> String {
    let mut nonce_bytes = [0u8; 16];
    getrandom::getrandom(&mut nonce_bytes).expect("OS random");
    let mut nonce = String::with_capacity(32);
    for byte in nonce_bytes {
        nonce.push_str(&format!("{byte:02x}"));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"rotor-admin-cookie-v1\0");
    hasher.update(token.as_bytes());
    let key: [u8; 32] = hasher.finalize().into();
    let payload = format!("v1.{expires_at}.{nonce}");
    let mac = test_hmac_sha256(&key, payload.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in mac {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("{payload}.{hex}")
}

fn test_hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
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

/// Every admin response must carry the same no-store / noindex header set.
fn assert_admin_headers(head: &str) {
    let admin_headers = [
        ("cache-control", "no-store, private"),
        ("vary", "cookie"),
        ("x-robots-tag", "noindex, nofollow, noarchive"),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
    ];
    for (name, expected) in admin_headers {
        let value =
            response_header(head, name).unwrap_or_else(|| panic!("missing {name} in {head}"));
        assert!(
            value.to_ascii_lowercase().contains(expected),
            "{name} must contain {expected}, got {value}"
        );
    }
    let csp = response_header(head, "content-security-policy").expect("CSP header");
    assert!(csp.contains("default-src 'self'"), "{csp}");
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(csp.contains("script-src 'self'"), "{csp}");
}

/// Build id the coordinator stamped into the served document. Tests do not
/// link against the private `BUILD_ID`; they read what a browser would read.
fn page_build(body: &str) -> String {
    let marker = "data-build=\"";
    let start = body.find(marker).expect("page carries data-build") + marker.len();
    let end = start + body[start..].find('"').expect("closing data-build quote");
    body[start..end].to_string()
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn create_job(addr: SocketAddr, body: serde_json::Value) -> String {
    create_job_as(addr, TOKEN, body)
}

fn create_job_as(addr: SocketAddr, token: &str, body: serde_json::Value) -> String {
    let (status, _, response) = raw(
        addr,
        "POST",
        "/api/v1/jobs",
        Some(token),
        Some(&body.to_string()),
    );
    assert_eq!(status, 201, "create job failed: {response}");
    let value: serde_json::Value = serde_json::from_str(&response).expect("job JSON");
    value["id"].as_str().expect("job id").to_string()
}

fn token_hash(token: &str) -> String {
    hex_bytes(&rotor::hashes::sha256(token.as_bytes()))
}

#[test]
fn auth_is_required_for_the_api_but_not_the_dashboard() {
    let temp = TempState::new("auth");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", None, None);
    assert_eq!(status, 401);
    assert!(body.contains("unauthorized"), "body: {body}");

    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some("wrong-token"), None);
    assert_eq!(status, 401);

    let (status, headers, body) = raw(addr, "GET", "/", None, None);
    assert_eq!(status, 200);
    assert!(
        headers.to_ascii_lowercase().contains("text/html"),
        "headers: {headers}"
    );
    assert!(body.contains("Crypto"));

    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "client-1");
    assert!(client.jobs().expect("jobs").is_empty());

    let unauthorized = CoordinatorClient::new(&format!("{addr}"), "wrong", "client-1");
    assert_eq!(
        unauthorized.jobs().expect_err("wrong token must fail"),
        "unauthorized"
    );

    handle.shutdown();
}

#[test]
fn public_responses_do_not_advertise_the_server() {
    let temp = TempState::new("server-header");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    for path in ["/", "/api/v1/summary", "/api/v1/chain/tron/address"] {
        let (status, head, _) = raw(addr, "GET", path, None, None);
        assert!(
            matches!(status, 200 | 400 | 501),
            "{path} returned {status}"
        );
        if let Some(server) = response_header(&head, "server") {
            assert!(
                server.trim().is_empty(),
                "Server identity leaked on {path}: {head}"
            );
        }
        assert!(
            response_header(&head, "x-powered-by").is_none(),
            "X-Powered-By leaked on {path}: {head}"
        );
    }

    handle.shutdown();
}

#[test]
fn site_assets_revalidate_by_etag() {
    let temp = TempState::new("etag");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let (status, headers, _) = raw(addr, "GET", "/site.css", None, None);
    assert_eq!(status, 200);
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("cache-control: no-cache"),
        "headers: {headers}"
    );
    let etag = response_header(&headers, "ETag").expect("/site.css has an ETag");
    assert!(etag.starts_with('"') && etag.ends_with('"'), "etag: {etag}");

    let (status, headers, body) = raw_with_headers(
        addr,
        "GET",
        "/site.css",
        None,
        None,
        &[("If-None-Match", &etag)],
    );
    assert_eq!(status, 304);
    assert_eq!(
        response_header(&headers, "ETag").as_deref(),
        Some(etag.as_str())
    );
    assert!(body.is_empty(), "304 must not carry a body");

    let (status, _, _) = raw_with_headers(
        addr,
        "GET",
        "/site.css",
        None,
        None,
        &[("If-None-Match", "\"stale\"")],
    );
    assert_eq!(status, 200);
}

#[test]
fn head_mirrors_get_for_public_resources() {
    let temp = TempState::new("head");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    // Read the build id the way a browser does: from the served document.
    let (status, _, page) = raw(addr, "GET", "/docs", None, None);
    assert_eq!(status, 200);
    let build = page_build(&page);

    for path in [
        "/site.css".to_string(),
        "/docs".to_string(),
        "/faq".to_string(),
        "/robots.txt".to_string(),
        format!("/a/{build}/site.css"),
    ] {
        let (get_status, get_headers, get_body) = raw(addr, "GET", &path, None, None);
        let (head_status, head_headers, head_body) = raw(addr, "HEAD", &path, None, None);

        assert_eq!(head_status, get_status, "{path}: HEAD status differs");
        assert_eq!(head_status, 200, "{path}: expected 200");
        assert!(!get_body.is_empty(), "{path}: GET must carry a body");
        assert!(head_body.is_empty(), "{path}: HEAD body must be empty");
        for name in ["Cache-Control", "ETag", "Content-Type"] {
            assert_eq!(
                response_header(&head_headers, name),
                response_header(&get_headers, name),
                "{path}: HEAD {name} differs from GET"
            );
        }
    }

    // An unknown non-API path is still a real 404 for HEAD, with no body.
    let (status, headers, body) = raw(addr, "HEAD", "/definitely-not-a-page", None, None);
    assert_eq!(status, 404);
    assert!(
        headers.to_ascii_lowercase().contains("text/html"),
        "headers: {headers}"
    );
    assert!(body.is_empty(), "HEAD 404 must not carry a body");

    handle.shutdown();
}

#[test]
fn html_references_build_fingerprinted_assets() {
    let temp = TempState::new("fingerprint");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    // Both render paths (static pages and generated SEO pages) must point at
    // the build-prefixed URL; a bare asset reference would be cached with the
    // edge's own TTL instead of the immutable one.
    let mut build = String::new();
    for (route, asset) in [
        ("/", "/site.js"),
        ("/docs", "/site.css"),
        ("/faq", "/site.js"),
    ] {
        let (status, headers, body) = raw(addr, "GET", route, None, None);
        assert_eq!(status, 200, "{route}");
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("cache-control: no-store"),
            "{route}: {headers}"
        );
        build = page_build(&body);
        let fingerprinted = format!("\"/a/{build}{asset}\"");
        assert!(
            body.contains(&fingerprinted),
            "{route} must reference {fingerprinted}"
        );
        assert!(
            !body.contains(&format!("\"{asset}\"")),
            "{route} must not reference the bare {asset}"
        );
        let preload = format!(
            "href=\"/a/{build}/fonts/manrope-latin.woff2\" as=\"font\" type=\"font/woff2\""
        );
        assert!(
            body.contains(&preload),
            "{route} must preload the Manrope webfont with {preload}"
        );
    }

    let (status, headers, _) = raw(addr, "GET", &format!("/a/{build}/site.css"), None, None);
    assert_eq!(status, 200);
    let lower = headers.to_ascii_lowercase();
    assert!(
        lower.contains("cache-control: public, max-age=31536000, immutable"),
        "fingerprinted assets must be immutable: {headers}"
    );
    assert!(lower.contains("etag:"), "immutable assets keep their ETag");
    let etag = response_header(&headers, "ETag").expect("ETag");
    let (status, headers, body) = raw_with_headers(
        addr,
        "GET",
        &format!("/a/{build}/site.css"),
        None,
        None,
        &[("If-None-Match", &etag)],
    );
    assert_eq!(status, 304);
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("cache-control: public, max-age=31536000, immutable"),
        "304 keeps the immutable policy: {headers}"
    );
    assert!(body.is_empty());

    // Old bookmarks and curl keep working on the bare path.
    let (status, _, _) = raw(addr, "GET", "/site.css", None, None);
    assert_eq!(status, 200);

    // A build segment from an older deploy still resolves (the bytes are this
    // build's), so a cached shell does not 404 its assets.
    let (status, _, body_older) = raw(addr, "GET", "/a/older-build/site.css", None, None);
    assert_eq!(status, 200);
    let (_, _, bare_body) = raw(addr, "GET", "/site.css", None, None);
    assert_eq!(body_older, bare_body);

    // An unknown file under the build prefix is a real 404.
    let (status, _, _) = raw(addr, "GET", &format!("/a/{build}/nope.css"), None, None);
    assert_eq!(status, 404);

    // The 404 document is emitted HTML too, so it must not ship bare assets.
    let (status, _, body) = raw(addr, "GET", "/does-not-exist", None, None);
    assert_eq!(status, 404);
    assert!(
        body.contains(&format!("/a/{build}/site.js")),
        "404 page must reference the fingerprinted site.js: {body}"
    );

    handle.shutdown();
}

#[test]
fn pages_load_generated_chain_data_before_consumers() {
    let temp = TempState::new("ssot");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    // The generated chain/provider globals are embedded like every other asset
    // and injected into <head>, so they run before the page scripts that read
    // them. Both URLs must be build-fingerprinted.
    let (status, _, page) = raw(addr, "GET", "/key", None, None);
    assert_eq!(status, 200);
    let build = page_build(&page);
    let generated = format!("/a/{build}/chains.generated.js");
    let consumer = format!("/a/{build}/key.js");
    let generated_at = page
        .find(&generated)
        .unwrap_or_else(|| panic!("/key must load {generated}: {page}"));
    let consumer_at = page
        .find(&consumer)
        .unwrap_or_else(|| panic!("/key must load {consumer}: {page}"));
    assert!(
        generated_at < consumer_at,
        "/key must load {generated} before {consumer}"
    );

    let (status, headers, body) = raw(addr, "GET", &generated, None, None);
    assert_eq!(status, 200);
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("application/javascript"),
        "{generated}: {headers}"
    );
    assert!(
        body.contains("RotorChains"),
        "{generated} misses RotorChains"
    );
    assert!(
        body.contains("RotorProviders"),
        "{generated} misses RotorProviders"
    );

    // A page that does not need balances still gets the shared data, so a
    // later script can read it without a page-local copy.
    let (status, _, docs) = raw(addr, "GET", "/docs", None, None);
    assert_eq!(status, 200);
    assert!(
        docs.contains(&generated),
        "/docs must load the fingerprinted shared data: {docs}"
    );

    handle.shutdown();
}

#[test]
fn two_clients_lease_disjoint_chunks_and_heartbeat() {
    let temp = TempState::new("lease");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;
    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let start = format!("{:064x}", 0x1000);
    let end = format!("{:064x}", 0x10bf);

    let job_id = create_job(
        addr,
        json!({
            "mode": "xpoint",
            "target": target,
            "start": start,
            "end": end,
            "chunk_width": 0x40,
            "lease_ttl": 600,
        }),
    );

    let first = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "alpha");
    let second = CoordinatorClient::new(&format!("{addr}"), TOKEN, "beta");

    let lease_a = first
        .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
        .expect("lease a")
        .expect("first chunk");
    let lease_b = second
        .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
        .expect("lease b")
        .expect("second chunk");
    assert_ne!(lease_a.chunk_index, lease_b.chunk_index);
    assert_ne!(lease_a.start, lease_b.start);

    let third = CoordinatorClient::new(&format!("{addr}"), TOKEN, "gamma");
    let lease_c = third
        .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
        .expect("lease c")
        .expect("third chunk");
    assert!(![lease_a.chunk_index, lease_b.chunk_index].contains(&lease_c.chunk_index));

    let fourth = CoordinatorClient::new(&format!("{addr}"), TOKEN, "delta");
    assert!(
        fourth
            .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
            .expect("lease d")
            .is_none(),
        "all three chunks are leased"
    );

    let expires_at = first
        .heartbeat(
            &job_id,
            lease_a.chunk_index,
            lease_a.lease_id,
            1_024,
            512.0,
            false,
            &[],
        )
        .expect("heartbeat");
    assert!(expires_at >= lease_a.expires_at);

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let status: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(status["clients"].as_array().expect("clients").len(), 3);
    assert_eq!(status["jobs"][0]["chunks_total"], 3);
    assert_eq!(status["jobs"][0]["chunks_leased"], 3);

    handle.shutdown();
}

#[test]
fn result_requires_a_valid_proof_and_marks_the_job_found() {
    let temp = TempState::new("result");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let key = Scalar::from_u64(42);
    let point = secp::mul_g(&key);
    let address = base58::address_from_hash160(&secp::hash160(&point, true), true);
    let job_id = create_job(
        addr,
        json!({
            "mode": "address",
            "coin": "btc",
            "comp_mode": "compressed",
            "target": address,
            "start": "1",
            "end": "ff",
            "chunk_width": 256,
        }),
    );

    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "finder");
    let lease = client
        .lease(Some(&job_id), None, "address", "btc", "1", "ff")
        .expect("lease")
        .expect("chunk");
    assert_eq!(
        client
            .submit_result(&job_id, lease.lease_id, &Scalar::from_u64(43).to_hex())
            .expect_err("wrong key must fail"),
        "invalid proof"
    );

    client
        .submit_result(&job_id, lease.lease_id, &key.to_hex())
        .expect("valid proof accepted");

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let status: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(status["jobs"][0]["found"], true);
    assert_eq!(status["jobs"][0]["found_key"], key.to_hex());
    assert_eq!(status["results"].as_array().expect("results").len(), 1);
    assert_eq!(status["results"][0]["client_id"], "finder");

    assert!(
        client
            .lease(Some(&job_id), None, "address", "btc", "1", "ff")
            .expect("lease")
            .is_none(),
        "a found job hands out no more chunks"
    );

    handle.shutdown();
}

#[test]
fn bsgs_state_round_trips_and_rejects_a_mismatched_manifest() {
    let temp = TempState::new("bsgs");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let pubkey = hex_bytes(&secp::compress(&secp::mul_g(&Scalar::from_u64(1))));
    let job_id = create_job(
        addr,
        json!({
            "mode": "bsgs",
            "target": pubkey,
            "start": "1",
            "end": "ff",
        }),
    );

    let manifest = TableManifest {
        format_version: 1,
        curve: "secp256k1".to_string(),
        baby_size: 16,
        range_id: "1:ff".to_string(),
        table_checksum: 12_345,
    };

    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "bsgs-1");
    assert_eq!(client.bsgs_get(&job_id).expect("get"), None);
    client
        .bsgs_put(&job_id, &manifest, 7)
        .expect("store checkpoint");
    let stored = client
        .bsgs_get(&job_id)
        .expect("get")
        .expect("stored checkpoint");
    assert_eq!(stored.manifest, manifest);
    assert_eq!(stored.giant_index, 7);

    let mut incompatible = manifest.clone();
    incompatible.table_checksum += 1;
    assert_eq!(
        client
            .bsgs_put(&job_id, &incompatible, 8)
            .expect_err("mismatch must fail"),
        "manifest mismatch"
    );

    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/bsgs/state",
        Some(TOKEN),
        Some(
            &json!({
                "job_id": job_id,
                "manifest": {
                    "format_version": incompatible.format_version,
                    "curve": incompatible.curve,
                    "baby_size": incompatible.baby_size,
                    "range_id": incompatible.range_id,
                    "table_checksum": incompatible.table_checksum,
                },
                "giant_index": 8,
            })
            .to_string(),
        ),
    );
    assert_eq!(status, 409, "body: {body}");
    assert!(body.contains("manifest mismatch"));

    handle.shutdown();
}

#[test]
fn oversized_request_bodies_are_rejected_with_413() {
    let temp = TempState::new("oversized");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    // One byte over the 1 MiB cap; the body is not parsed.
    let body = "x".repeat(1024 * 1024 + 1);
    let (status, _, response) = raw(addr, "POST", "/api/v1/jobs", Some(TOKEN), Some(&body));
    assert_eq!(status, 413, "body: {response}");

    // The server keeps working after a rejected body.
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);

    handle.shutdown();
}

#[test]
fn client_tokens_are_scoped_to_their_endpoints() {
    let temp = TempState::new("client-auth");
    let admin = "admin-token";
    let alpha = "alpha-secret";
    let clients = Clients::parse(&format!(
        r#"{{"alpha":"{}","beta":"{}"}}"#,
        token_hash(alpha),
        token_hash("beta-secret")
    ))
    .expect("clients map");
    let handle =
        spawn_with_clients("127.0.0.1:0", temp.path(), admin.to_string(), clients).expect("spawn");
    let addr = handle.addr;

    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job_as(
        addr,
        admin,
        json!({
            "mode": "xpoint",
            "target": target,
            "start": "1",
            "end": "8",
            "chunk_width": 8,
            "lease_ttl": 600,
        }),
    );

    // Admin: status and jobs are allowed, leasing is not.
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some(admin), None);
    assert_eq!(status, 200);
    let (status, _, _) = raw(addr, "GET", "/api/v1/jobs", Some(admin), None);
    assert_eq!(status, 200);
    let lease_body = json!({
        "client_id": "alpha",
        "job_id": job_id,
        "mode": "xpoint",
        "coin": "btc",
        "start": "1",
        "end": "8",
    })
    .to_string();
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/lease",
        Some(admin),
        Some(&lease_body),
    );
    assert_eq!(status, 403, "admin must not lease: {body}");

    // Client: lease works even when the body claims another client id.
    let spoofed = json!({
        "client_id": "beta",
        "job_id": job_id,
        "mode": "xpoint",
        "coin": "btc",
        "start": "1",
        "end": "8",
    });
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/lease",
        Some(alpha),
        Some(&spoofed.to_string()),
    );
    assert_eq!(status, 200, "client lease failed: {body}");
    let lease: serde_json::Value = serde_json::from_str(&body).expect("lease JSON");
    let lease_id = lease["lease_id"].as_u64().expect("lease_id");
    let chunk_index = lease["chunk_index"].as_u64().expect("chunk_index");

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(alpha), None);
    assert_eq!(status, 200);
    let value: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(
        value["clients"][0]["client_id"], "alpha",
        "the token owns the identity: {body}"
    );

    // A client cannot create jobs.
    let (status, _, _) = raw(
        addr,
        "POST",
        "/api/v1/jobs",
        Some(alpha),
        Some(
            &json!({
                "mode": "xpoint",
                "target": target,
                "start": "1",
                "end": "8",
            })
            .to_string(),
        ),
    );
    assert_eq!(status, 403);

    // Heartbeat and result use the token identity, not the body id.
    let heartbeat = json!({
        "client_id": "beta",
        "job_id": job_id,
        "chunk_index": chunk_index,
        "lease_id": lease_id,
        "scanned": 1,
        "rate": 1.0,
        "done": false,
    })
    .to_string();
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/heartbeat",
        Some(alpha),
        Some(&heartbeat),
    );
    assert_eq!(status, 200, "client heartbeat failed: {body}");

    let result = json!({
        "client_id": "beta",
        "job_id": job_id,
        "lease_id": lease_id,
        "key": Scalar::from_u64(7).to_hex(),
    })
    .to_string();
    let (status, _, body) = raw(addr, "POST", "/api/v1/result", Some(alpha), Some(&result));
    assert_eq!(status, 200, "client result failed: {body}");

    // Unknown and blank tokens are unauthorized.
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some("unknown"), None);
    assert_eq!(status, 401);
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", None, None);
    assert_eq!(status, 401);
    let (status, _, _) = raw(addr, "POST", "/api/v1/lease", Some(""), Some(&lease_body));
    assert_eq!(status, 401);

    handle.shutdown();
}

#[test]
fn completion_challenge_requires_correct_samples() {
    let temp = TempState::new("challenge-api");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job(
        addr,
        json!({
            "mode": "xpoint",
            "target": target,
            "start": "1",
            "end": "8",
            "chunk_width": 8,
            "lease_ttl": 600,
        }),
    );

    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "challenger");
    let lease = client
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "8")
        .expect("lease")
        .expect("chunk");
    assert_eq!(lease.challenge_offsets.len(), 16);

    let heartbeat = |lease_id: u64, done: bool, samples: serde_json::Value| {
        raw(
            addr,
            "POST",
            "/api/v1/heartbeat",
            Some(TOKEN),
            Some(
                &json!({
                    "client_id": "challenger",
                    "job_id": job_id,
                    "chunk_index": lease.chunk_index,
                    "lease_id": lease_id,
                    "scanned": 1,
                    "rate": 1.0,
                    "done": done,
                    "samples": samples,
                })
                .to_string(),
            ),
        )
    };

    // Missing and wrong samples are 400 and the chunk stays leased.
    let (status, _, body) = heartbeat(lease.lease_id, true, json!([]));
    assert_eq!(status, 400, "missing samples: {body}");
    assert!(body.contains("invalid completion sample"), "body: {body}");
    let wrong = json!(vec![vec![0u8; 32]; 16]);
    let (status, _, body) = heartbeat(lease.lease_id, true, wrong);
    assert_eq!(status, 400, "wrong samples: {body}");

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let value: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(value["jobs"][0]["chunks_done"], 0);
    assert_eq!(value["jobs"][0]["chunks_leased"], 1);

    // A stale nonce is 409.
    let (status, _, body) = heartbeat(lease.lease_id.wrapping_add(1), false, json!([]));
    assert_eq!(status, 409, "stale nonce: {body}");
    assert!(body.contains("lease lost"), "body: {body}");

    // Correct samples complete the chunk exactly once.
    let start = Scalar::from_hex(&lease.start).expect("chunk start");
    let samples = rotor::coordinator::state::challenge_samples(
        "xpoint",
        "btc",
        "compressed",
        &start,
        &lease.challenge_offsets,
    )
    .expect("samples");
    let (status, _, body) = heartbeat(lease.lease_id, true, json!(samples));
    assert_eq!(status, 200, "valid samples: {body}");
    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let value: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(value["jobs"][0]["chunks_done"], 1, "exactly one bit set");

    // Replaying the completed lease reports a lost lease.
    let (status, _, _) = heartbeat(lease.lease_id, true, json!([]));
    assert_eq!(status, 409);

    handle.shutdown();
}

#[test]
fn burst_is_rate_limited_with_retry_after() {
    let temp = TempState::new("rate-limit");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let mut limited = None;
    for _ in 0..80 {
        let (status, headers, _) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
        if status == 429 {
            limited = Some(headers);
            break;
        }
        assert_eq!(status, 200, "requests before the burst limit must pass");
    }
    let headers = limited.expect("the burst limit must reject a request");
    assert!(
        headers.to_ascii_lowercase().contains("retry-after: 1"),
        "429 must carry Retry-After: {headers}"
    );

    handle.shutdown();
}

#[test]
fn state_survives_a_coordinator_restart() {
    let temp = TempState::new("restart");
    let target = secp::mul_g(&Scalar::from_u64(11)).x.to_hex();
    let start = format!("{:064x}", 0x2000);
    let end = format!("{:064x}", 0x207f);
    let job_id;
    let first_index;

    {
        let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
        let addr = handle.addr;
        job_id = create_job(
            addr,
            json!({
                "mode": "xpoint",
                "target": target,
                "start": start,
                "end": end,
                "chunk_width": 0x40,
            }),
        );
        let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "alpha");
        let lease = client
            .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
            .expect("lease")
            .expect("first chunk");
        first_index = lease.chunk_index;
        handle.shutdown();
    }

    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("respawn");
    let addr = handle.addr;
    let client = CoordinatorClient::new(&format!("http://{addr}"), TOKEN, "beta");

    let jobs = client.jobs().expect("jobs after restart");
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].id, job_id);

    let lease = client
        .lease(Some(&job_id), None, "xpoint", "btc", &start, &end)
        .expect("lease after restart")
        .expect("second chunk");
    assert_ne!(
        lease.chunk_index, first_index,
        "the chunk leased before the restart is still reserved"
    );

    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let status: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    let clients = status["clients"].as_array().expect("clients");
    assert!(
        clients.iter().any(|client| client["client_id"] == "alpha"),
        "the pre-restart lease survived: {body}"
    );

    handle.shutdown();
}

fn create_client_as(addr: SocketAddr, admin: &str, name: &str) -> (String, String) {
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/clients",
        Some(admin),
        Some(&json!({ "name": name }).to_string()),
    );
    assert_eq!(status, 201, "create client failed: {body}");
    let value: serde_json::Value = serde_json::from_str(&body).expect("client JSON");
    assert_eq!(value["name"], name);
    let id = value["id"].as_str().expect("client id").to_string();
    let token = value["token"].as_str().expect("client token").to_string();
    assert_eq!(token.len(), 64, "token must be 32 bytes of hex");
    (id, token)
}

fn xpoint_job_body(target: &str, start: &str, end: &str) -> serde_json::Value {
    json!({
        "mode": "xpoint",
        "target": target,
        "start": start,
        "end": end,
        "chunk_width": 8,
        "lease_ttl": 600,
    })
}

#[test]
fn admin_account_endpoints_and_disabled_tokens() {
    let temp = TempState::new("accounts");
    let handle = spawn_with_options(
        "127.0.0.1:0",
        temp.path(),
        TOKEN.to_string(),
        Clients::default(),
        false,
    )
    .expect("spawn");
    let addr = handle.addr;

    // Registration is closed by default.
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/register",
        None,
        Some(&json!({ "name": "Eve" }).to_string()),
    );
    assert_eq!(status, 403, "closed registration: {body}");

    // The admin creates an account and receives the token once.
    let (alpha_id, alpha_token) = create_client_as(addr, TOKEN, "Alpha");

    // The list is admin-only and never leaks the token hash.
    let (status, _, body) = raw(addr, "GET", "/api/v1/clients", Some(TOKEN), None);
    assert_eq!(status, 200);
    let value: serde_json::Value = serde_json::from_str(&body).expect("clients JSON");
    let clients = value["clients"].as_array().expect("clients");
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0]["id"], alpha_id.as_str());
    assert_eq!(clients[0]["name"], "Alpha");
    assert!(clients[0].get("token_hash").is_none(), "hash must not leak");
    assert!(clients[0]["history"].is_array());

    // A client token cannot use admin endpoints.
    let (status, _, _) = raw(addr, "GET", "/api/v1/clients", Some(&alpha_token), None);
    assert_eq!(status, 403);
    let (status, _, _) = raw(
        addr,
        "POST",
        "/api/v1/clients",
        Some(&alpha_token),
        Some(&json!({ "name": "Sneaky" }).to_string()),
    );
    assert_eq!(status, 403);

    // Admin creates the job; the client leases it.
    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job_as(addr, TOKEN, xpoint_job_body(&target, "1", "8"));
    let client = CoordinatorClient::new(&format!("http://{addr}"), &alpha_token, "alpha");
    let lease = client
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "8")
        .expect("lease")
        .expect("chunk");
    assert!(
        client
            .heartbeat(
                &job_id,
                lease.chunk_index,
                lease.lease_id,
                64,
                10.0,
                false,
                &[]
            )
            .is_ok()
    );

    // The cabinet is scoped to the token; the admin has no record.
    let (status, _, body) = raw(addr, "GET", "/api/v1/me", Some(&alpha_token), None);
    assert_eq!(status, 200, "me failed: {body}");
    let me: serde_json::Value = serde_json::from_str(&body).expect("me JSON");
    assert_eq!(me["client"]["id"], alpha_id.as_str());
    assert_eq!(me["rank"], 1);
    assert_eq!(me["lease"]["job_id"], job_id.as_str());
    assert_eq!(me["client"]["scanned_total"], 64);
    let (status, _, _) = raw(addr, "GET", "/api/v1/me", Some(TOKEN), None);
    assert_eq!(status, 403, "the admin has no personal cabinet");

    // Disabling revokes the token and releases its lease.
    let disable_path = format!("/api/v1/clients/{alpha_id}/disable");
    let (status, _, body) = raw(addr, "POST", &disable_path, Some(TOKEN), None);
    assert_eq!(status, 200, "disable failed: {body}");
    let (status, _, _) = raw(addr, "GET", "/api/v1/me", Some(&alpha_token), None);
    assert_eq!(status, 401, "a disabled token must be unauthorized");
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", Some(&alpha_token), None);
    assert_eq!(status, 401);
    let (status, _, body) = raw(addr, "GET", "/api/v1/status", Some(TOKEN), None);
    assert_eq!(status, 200);
    let status: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert!(
        status["clients"].as_array().expect("clients").is_empty(),
        "the disabled client's lease must be released: {body}"
    );
    let (status, _, _) = raw(
        addr,
        "POST",
        "/api/v1/clients/missing/disable",
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 404);

    handle.shutdown();
}

#[test]
fn registration_is_flag_gated_and_rate_limited() {
    let temp = TempState::new("register");
    let handle = spawn_with_options(
        "127.0.0.1:0",
        temp.path(),
        TOKEN.to_string(),
        Clients::default(),
        true,
    )
    .expect("spawn");
    let addr = handle.addr;

    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/register",
        None,
        Some(&json!({ "name": "Eve" }).to_string()),
    );
    assert_eq!(status, 201, "registration failed: {body}");
    let created: serde_json::Value = serde_json::from_str(&body).expect("register JSON");
    let token = created["token"].as_str().expect("token").to_string();
    assert_eq!(token.len(), 64);

    // A second registration from the same IP inside the window is throttled.
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/register",
        None,
        Some(&json!({ "name": "Mallory" }).to_string()),
    );
    assert_eq!(status, 429, "second registration: {body}");

    // The new token can immediately lease a job created by the admin.
    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job_as(addr, TOKEN, xpoint_job_body(&target, "1", "8"));
    let client = CoordinatorClient::new(&format!("http://{addr}"), &token, "eve");
    let lease = client
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "8")
        .expect("lease")
        .expect("chunk");
    assert!(lease.chunk_index < 8);

    // The public summary reports the flag and counts the account.
    let (status, _, body) = raw(addr, "GET", "/api/v1/summary", None, None);
    assert_eq!(status, 200);
    let summary: serde_json::Value = serde_json::from_str(&body).expect("summary JSON");
    assert_eq!(summary["registration_open"], true);
    assert_eq!(summary["totals"]["jobs"], 1);
    assert_eq!(summary["leaderboard"][0]["name"], "Eve");

    // A bad name is rejected before an account is created.
    let temp2 = TempState::new("register-invalid");
    let handle2 = spawn_with_options(
        "127.0.0.1:0",
        temp2.path(),
        TOKEN.to_string(),
        Clients::default(),
        true,
    )
    .expect("spawn");
    let (status, _, body) = raw(
        handle2.addr,
        "POST",
        "/api/v1/register",
        None,
        Some(&json!({ "name": "<script>" }).to_string()),
    );
    assert_eq!(status, 400, "html name: {body}");
    handle2.shutdown();

    handle.shutdown();
}

#[test]
fn cabinet_is_scoped_and_the_leaderboard_is_ordered() {
    let temp = TempState::new("cabinet");
    let handle = spawn_with_options(
        "127.0.0.1:0",
        temp.path(),
        TOKEN.to_string(),
        Clients::default(),
        false,
    )
    .expect("spawn");
    let addr = handle.addr;

    let (alpha_id, alpha_token) = create_client_as(addr, TOKEN, "Alpha");
    let (beta_id, beta_token) = create_client_as(addr, TOKEN, "Beta");
    let target = secp::mul_g(&Scalar::from_u64(7)).x.to_hex();
    let job_id = create_job_as(addr, TOKEN, xpoint_job_body(&target, "1", "10"));

    let alpha = CoordinatorClient::new(&format!("http://{addr}"), &alpha_token, "alpha");
    let beta = CoordinatorClient::new(&format!("http://{addr}"), &beta_token, "beta");
    let alpha_lease = alpha
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "10")
        .expect("lease")
        .expect("chunk");
    let beta_lease = beta
        .lease(Some(&job_id), None, "xpoint", "btc", "1", "10")
        .expect("lease")
        .expect("chunk");
    assert_ne!(alpha_lease.chunk_index, beta_lease.chunk_index);
    alpha
        .heartbeat(
            &job_id,
            alpha_lease.chunk_index,
            alpha_lease.lease_id,
            100,
            10.0,
            false,
            &[],
        )
        .expect("alpha heartbeat");
    beta.heartbeat(
        &job_id,
        beta_lease.chunk_index,
        beta_lease.lease_id,
        50,
        5.0,
        false,
        &[],
    )
    .expect("beta heartbeat");

    // A heartbeat cannot borrow another client's lease.
    beta.heartbeat(
        &job_id,
        alpha_lease.chunk_index,
        alpha_lease.lease_id,
        100,
        1.0,
        false,
        &[],
    )
    .expect_err("a foreign lease nonce is rejected");

    let (status, _, body) = raw(addr, "GET", "/api/v1/summary", None, None);
    assert_eq!(status, 200);
    let summary: serde_json::Value = serde_json::from_str(&body).expect("summary JSON");
    assert_eq!(summary["totals"]["scanned"], 150);
    assert_eq!(summary["totals"]["clients_active"], 2);
    assert_eq!(summary["totals"]["jobs"], 1);
    assert_eq!(summary["leaderboard"][0]["id"], alpha_id.as_str());
    assert_eq!(summary["leaderboard"][1]["id"], beta_id.as_str());

    let (status, _, body) = raw(addr, "GET", "/api/v1/me", Some(&alpha_token), None);
    assert_eq!(status, 200);
    let me: serde_json::Value = serde_json::from_str(&body).expect("me JSON");
    assert_eq!(me["client"]["id"], alpha_id.as_str());
    assert_eq!(me["rank"], 1);
    assert_eq!(me["lease"]["job_id"], job_id.as_str());
    assert_eq!(me["job"]["id"], job_id.as_str());

    // An accepted result is credited only to the submitting client.
    alpha
        .submit_result(&job_id, alpha_lease.lease_id, &Scalar::from_u64(7).to_hex())
        .expect("valid proof");
    let (status, _, body) = raw(addr, "GET", "/api/v1/me", Some(&alpha_token), None);
    assert_eq!(status, 200);
    let me: serde_json::Value = serde_json::from_str(&body).expect("me JSON");
    assert_eq!(me["client"]["found"], 1);
    assert_eq!(me["results"].as_array().expect("results").len(), 1);
    assert!(me["lease"].is_null(), "the found job drops its leases");
    let (status, _, body) = raw(addr, "GET", "/api/v1/me", Some(&beta_token), None);
    assert_eq!(status, 200);
    let me: serde_json::Value = serde_json::from_str(&body).expect("me JSON");
    assert_eq!(me["client"]["found"], 0);
    assert!(me["results"].as_array().expect("results").is_empty());

    let (status, _, body) = raw(addr, "GET", "/api/v1/summary", None, None);
    assert_eq!(status, 200);
    let summary: serde_json::Value = serde_json::from_str(&body).expect("summary JSON");
    assert_eq!(summary["totals"]["results"], 1);
    assert_eq!(summary["leaderboard"][0]["found"], 1);

    handle.shutdown();
}

#[test]
fn public_pages_and_assets_are_served() {
    let temp = TempState::new("pages");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let checks: [(&str, &[&str]); 12] = [
        (
            "/",
            &[
                "Crypto",
                "id=\"contribute\"",
                "href=\"/run\"",
                "class=\"tool-card\" href=\"/seed\"",
                "href=\"/private-keys\"",
                "href=\"/bitcoin-puzzle\"",
                "href=\"/brainwallet\"",
                "href=\"/cabinet\"",
                "href=\"/docs\"",
            ],
        ),
        (
            "/run",
            &[
                "id=\"join-form\"",
                "id=\"leaderboard-body\"",
                "How it works",
                "--coordinator",
                "/api/v1/register",
                "/api/v1/summary",
                "Team mode — pooled chunk leasing",
                "data-puzzle-summary",
                "data-puzzle-jobs",
                "/puzzle.js",
            ],
        ),
        (
            "/app",
            &[
                "id=\"jobs\"",
                "id=\"leaderboard-body\"",
                "/api/v1/status",
                "id=\"global-scanned\"",
            ],
        ),
        (
            "/me",
            &["id=\"sparkline\"", "/api/v1/me", "id=\"me-token\""],
        ),
        (
            "/docs",
            &["--coordinator", "--token", "-m addresses", "--client-id"],
        ),
        (
            "/cabinet/wallet",
            &[
                "id=\"wallet-panel\"",
                "id=\"wallet-unlock-form\"",
                "id=\"wallet-onboard-key\"",
                "id=\"wallet-onboard-seed\"",
                "id=\"wallet-assets\"",
                "/assets.generated.js",
                "/wallet-summary.js",
                "/wallet-assets.js",
                "/wallet-vault.js",
                "/wallet-swap.js",
                "id=\"wallet-swap\"",
                "id=\"wallet-swap-quote\"",
                "/theme.js",
            ],
        ),
        (
            "/bitcoin-puzzle",
            &[
                "Contributing? The pooled job board and the lease worker live on the",
                "href=\"/run\"",
            ],
        ),
        (
            "/bitcoin-puzzle/71",
            &[
                "class=\"puzzle-tabs\" aria-label=\"Puzzle views\"",
                "href=\"/run\">Team</a>",
            ],
        ),
        (
            "/key",
            &[
                "class=\"address-type-panel key-address-panel\"",
                "id=\"format-panel\"",
                "id=\"format-cards\"",
            ],
        ),
        ("/site.css", &[":root", "--bg", "@media"]),
        ("/site.js", &["window.Rotor", "sparkline", "TOKEN_KEY"]),
        (
            "/wc-links.js",
            &["RotorWcLinks", "metamask.app.link", "link.trustwallet.com"],
        ),
    ];
    for (path, needles) in checks {
        let (status, headers, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        if path.ends_with(".css") {
            assert!(
                headers.to_ascii_lowercase().contains("text/css"),
                "{path}: {headers}"
            );
        }
        for needle in needles {
            assert!(body.contains(needle), "{path} misses {needle}");
        }
    }

    // The wallet vault codec and page script are served as JavaScript.
    for (path, needle) in [
        ("/wallet.js", "rotor-wallet"),
        ("/wallet-summary.js", "RotorWalletSummary"),
        ("/wallet-assets.js", "RotorWalletAssets"),
        ("/assets.generated.js", "RotorAssetsData"),
        ("/wallet-vault.js", "PBKDF2-SHA256"),
        ("/wallet-btc.js", "RotorBtcSend"),
        ("/wallet-tron.js", "RotorTronWallet"),
        ("/wallet-swap.js", "RotorSwap"),
        ("/vanity-worker.js", "derive_report"),
    ] {
        let (status, headers, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("application/javascript"),
            "{path}: {headers}"
        );
        assert!(body.contains(needle), "{path} misses {needle}");
    }

    // Unknown non-API paths are a real 404, not a landing-page fallback.
    let (status, _, _) = raw(addr, "GET", "/anything", None, None);
    assert_eq!(status, 404);

    // The parity map is internal docs now; its old public route is gone.
    for path in [
        "/site-map",
        "/site-map.css",
        "/site-map.js",
        "/site-map-data.js",
    ] {
        let (status, _, _) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 404, "{path} must not be served");
    }
    let (status, _, sitemap) = raw(addr, "GET", "/sitemap.xml", None, None);
    assert_eq!(status, 200);
    assert!(
        !sitemap.contains("/site-map"),
        "sitemap.xml must not list the internal parity map"
    );

    // The authenticated API is still protected.
    let (status, _, _) = raw(addr, "GET", "/api/v1/status", None, None);
    assert_eq!(status, 401);

    handle.shutdown();
}

/// The contributor pool console lives on /run, not on the /bitcoin-puzzle SEO
/// hub: the hub only carries one line pointing contributors at /run. Fails if
/// the console (or a `#team` anchor) drifts back onto the search page.
#[test]
fn puzzle_console_lives_on_run_not_the_seo_hub() {
    let temp = TempState::new("puzzle-console");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let (status, _, puzzle) = raw(addr, "GET", "/bitcoin-puzzle", None, None);
    assert_eq!(status, 200);
    assert!(
        puzzle.contains("Contributing? The pooled job board and the lease worker live on the"),
        "/bitcoin-puzzle must point contributors at /run"
    );
    assert!(
        !puzzle.contains("id=\"team\""),
        "/bitcoin-puzzle must not host the pool console"
    );
    assert!(
        !puzzle.contains("data-puzzle-jobs"),
        "/bitcoin-puzzle must not render the public job board"
    );
    assert!(
        !puzzle.contains("#team"),
        "/bitcoin-puzzle must not carry a #team anchor"
    );

    let (status, _, run) = raw(addr, "GET", "/run", None, None);
    assert_eq!(status, 200);
    assert!(
        run.contains("Team mode — pooled chunk leasing"),
        "/run owns the pool console"
    );
    assert!(run.contains("id=\"team\""));
    assert!(run.contains("data-puzzle-jobs"));
    assert!(run.contains("data-puzzle-summary"));
    assert!(run.contains("/puzzle.js"));

    handle.shutdown();
}

/// Every public content route must carry exactly one shared footer, and the
/// app/cabinet shells must carry none. This is the route-level guard for the
/// footer helper: it fails if a render path (static page, SEO page or a future
/// route) bypasses `with_site_footer`. It also pins HTML to `no-store` so an
/// edge cache cannot keep serving a stale shell without the footer.
#[test]
fn every_public_content_route_renders_exactly_one_footer() {
    let temp = TempState::new("footer-routes");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let content_routes = [
        "/",
        "/docs",
        "/key",
        "/key/hex",
        "/key/wif",
        "/key/0000000000000000000000000000000000000000000000000000000000000001",
        "/private-keys",
        "/private-keys/bitcoin",
        "/private-keys/bitcoin/2",
        "/seed",
        "/mnemonic-seeds",
        "/mnemonic-seeds/bitcoin",
        "/mnemonic-seeds/bitcoin/2",
        "/mnemonic-converter",
        "/brainwallet",
        "/brainwallet-generator",
        "/brainwallet/bitcoin",
        "/brainwallet/bitcoin/2",
        "/bitcoin-puzzle",
        "/bitcoin-puzzle/unsolved",
        "/bitcoin-puzzle/71",
        "/bitcoin-puzzle/71/random",
        "/tools",
        "/vanity",
        "/send",
        "/send/bitcoin",
        "/send/ethereum",
        "/send/bnb",
        "/send/usdt",
        "/send/tron",
        "/wallets",
        "/faq",
        "/disclaimer",
        "/donate",
        "/milk-sad",
        "/hex-dec-bin",
        "/public-key",
        "/pubkey-add",
        "/keystore-parser",
        "/reconstruction",
        "/tx",
        "/tx/bitcoin",
        "/tx/ethereum",
        "/keys/tron/0000000000000000000000000000000000000000000000000000000000000001-0000000000000000000000000000000000000000000000000000000000000004",
    ];
    for path in content_routes {
        let (status, headers, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        assert_eq!(
            body.matches("<footer class=\"site-footer\">").count(),
            1,
            "{path} must render exactly one footer"
        );
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("cache-control: no-store"),
            "{path} must not let an edge cache keep a stale shell: {headers}"
        );
    }

    for path in ["/app", "/run", "/me", "/cabinet", "/cabinet/wallet"] {
        let (status, _, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        assert_eq!(
            body.matches("class=\"site-footer\"").count(),
            0,
            "{path} is an app/cabinet shell and must not render the marketing footer"
        );
    }

    handle.shutdown();
}

/// Density regression guard: a browse listing row carries the hex key, the
/// address cell and the balance cell, and never a WIF. The WIF is key-level
/// and stays on `/key/<hex>`. The listing is rendered by `browse.js`, so this
/// test checks both the served row markup and the shipped script; the static
/// detector id is `browse-row-wif` in scripts/check-token-usage.mjs.
#[test]
fn browse_listing_rows_carry_no_wif() {
    let temp = TempState::new("browse-row-wif");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let is_base58 =
        |byte: u8| byte.is_ascii_alphanumeric() && !matches!(byte, b'0' | b'O' | b'I' | b'l');

    for path in ["/private-keys/bitcoin", "/private-keys/tron"] {
        let (status, _, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        let start = body.find("<div class=\"key-row\"").expect("listing row");
        let after = &body[start + 1..];
        let end = after
            .find("<div class=\"key-row\"")
            .map_or(body.len(), |index| start + 1 + index);
        let row = &body[start..end];
        assert!(
            row.contains("class=\"col-key\""),
            "{path} row misses the key cell"
        );
        assert!(
            row.contains("class=\"col-address\""),
            "{path} row misses the address cell"
        );
        assert!(
            row.contains("class=\"col-balance\""),
            "{path} row misses the balance cell"
        );
        assert!(!row.contains("Priv (WIF)"), "{path} row labels a WIF");
        assert!(!row.contains("key-wif"), "{path} row renders a WIF line");
        for token in row.split(|ch: char| !ch.is_ascii_alphanumeric()) {
            let wif_shaped = matches!(token.len(), 51 | 52)
                && matches!(token.as_bytes()[0], b'5' | b'K' | b'L')
                && token.bytes().all(is_base58);
            assert!(
                !wif_shaped,
                "{path} row carries the WIF-shaped value {token}"
            );
        }
    }

    let (status, _, browse_js) = raw(addr, "GET", "/browse.js", None, None);
    assert_eq!(status, 200, "/browse.js");
    assert!(
        !browse_js.contains("key-wif") && !browse_js.contains("renderKeyCell"),
        "browse.js must not render a WIF into a listing row"
    );

    let key_hex = "0000000000000000000000000000000000000000000000000000000000000001";
    let (status, _, key_page) = raw(addr, "GET", &format!("/key/{key_hex}"), None, None);
    assert_eq!(status, 200, "/key/<hex>");
    assert!(
        key_page.contains(&format!("window.__ROTOR_KEY__=\"{key_hex}\"")),
        "/key/<hex> misses the key payload"
    );
    let (status, _, tools) = raw(addr, "GET", "/key-tools.js", None, None);
    assert_eq!(status, 200, "/key-tools.js");
    assert!(
        tools.contains("id: 'wif'") && tools.contains("wif_compressed"),
        "/key/<hex> lost the client-side WIF fact"
    );

    handle.shutdown();
}

/// `/key/<WIF>` decodes a WIF to the same padded hex key. Uncompressed
/// Litecoin and Dogecoin WIFs start with `6`, so the first-byte prefilter must
/// admit them; a 51-character `6…` value that is not a valid WIF still 404s.
#[test]
fn key_url_accepts_uncompressed_litecoin_and_dogecoin_wifs() {
    let temp = TempState::new("key-wif-uncompressed");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let key_hex = "0000000000000000000000000000000000000000000000000000000000000001";
    for wif in [
        "6u823ozcyt2rjPH8Z2ErsSXJB5PPQwK7VVTwwN4mxLBFrao69XQ", // Litecoin 0xb0, uncompressed
        "6J8csdv3eDrnJcpSEb4shfjMh2JTiG9MKzC1Yfge4Y4GyUsjdM6", // Dogecoin 0x9e, uncompressed
    ] {
        let (status, _, body) = raw(addr, "GET", &format!("/key/{wif}"), None, None);
        assert_eq!(status, 200, "{wif}");
        assert!(
            body.contains(&format!("window.__ROTOR_KEY__=\"{key_hex}\"")),
            "{wif} must decode to the padded hex key"
        );
    }

    // Same length and leading `6`, but a broken checksum: neither a WIF nor
    // hex, so the route stays a 404.
    let bad = "6u823ozcyt2rjPH8Z2ErsSXJB5PPQwK7VVTwwN4mxLBFrao69XR";
    let (status, _, _) = raw(addr, "GET", &format!("/key/{bad}"), None, None);
    assert_eq!(status, 404, "{bad}");

    handle.shutdown();
}

/// The BTC listing row model: every address form of a legacy key is visible
/// at once (the compressed and uncompressed P2PKH lines), with no disclosure.
/// The page keeps 60 keys but declares the address total it renders (120 for
/// legacy BTC, 60 for a single-address chain). The key copy is a real 44px
/// action. Detector ids: `browse-row-address-count` and `browse-row-key-copy`
/// in scripts/ui-audit.mjs.
#[test]
fn browse_listing_row_shows_every_address_without_disclosure() {
    let temp = TempState::new("browse-row-model");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    let (status, _, body) = raw(addr, "GET", "/private-keys/bitcoin", None, None);
    assert_eq!(status, 200);
    for needle in [
        "data-keys-per-page=\"60\"",
        "data-addresses-per-key=\"2\"",
        "data-addresses-per-page=\"120\"",
        "id=\"page-address-count\">120 addresses",
    ] {
        assert!(body.contains(needle), "bitcoin page misses {needle}");
    }
    let start = body.find("<div class=\"key-row\"").expect("listing row");
    let after = &body[start + 1..];
    let end = after
        .find("<div class=\"key-row\"")
        .map_or(body.len(), |index| start + 1 + index);
    let row = &body[start..end];
    assert!(
        row.contains(
            "class=\"icon-button icon-button--sm icon-button--quiet row-action copy-btn\""
        ),
        "the row key copy action must use the shared dense icon-button (44px hit area, 28px visual on desktop)"
    );
    assert!(
        row.contains("aria-label=\"Copy private key\"")
            && row.contains("data-tooltip=\"Copy private key\""),
        "the row key copy action must be labelled and carry the tooltip primitive"
    );
    assert!(
        !row.contains("display:none"),
        "the row key copy action must not ship hidden"
    );

    let (status, _, browse_js) = raw(addr, "GET", "/browse.js", None, None);
    assert_eq!(status, 200, "/browse.js");
    for needle in [
        "addressEntriesFor",
        "addr-line",
        "page-address-count",
        "data-addresses-per-page",
    ] {
        assert!(
            browse_js.contains(needle),
            "browse.js lost the address row hook {needle}"
        );
    }
    for removed in [
        "addr-extra",
        "addr-extra-toggle",
        "addr-expanded",
        "balance-extra",
    ] {
        assert!(
            !browse_js.contains(removed),
            "browse.js still carries the removed disclosure hook {removed}"
        );
    }
    let (status, _, site_css) = raw(addr, "GET", "/site.css", None, None);
    assert_eq!(status, 200, "/site.css");
    for removed in [".addr-extra", ".addr-expanded", ".balance-extra"] {
        assert!(
            !site_css.contains(removed),
            "site.css still carries the removed disclosure rule {removed}"
        );
    }

    // A single-address chain keeps 60 keys and declares 60 addresses; the
    // per-page total is honest, not copied from the legacy BTC value.
    let (status, _, ethereum) = raw(addr, "GET", "/private-keys/ethereum", None, None);
    assert_eq!(status, 200);
    for needle in [
        "data-addresses-per-key=\"1\"",
        "data-addresses-per-page=\"60\"",
        "id=\"page-address-count\">60 addresses",
    ] {
        assert!(ethereum.contains(needle), "ethereum page misses {needle}");
    }

    handle.shutdown();
}

/// UTXO chains keep the donor's Balance / Received / TX row; account-model
/// chains show Balance / Active. The summary markup is chain-shaped, so this
/// guards both variants against a regression to one shared three-card row.
#[test]
fn private_key_pages_shape_summary_cards_by_chain_model() {
    let temp = TempState::new("summary-cards");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    for path in [
        "/private-keys/ethereum",
        "/private-keys/tron",
        "/private-keys/solana",
    ] {
        let (status, _, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        assert!(
            body.contains("id=\"total-active\""),
            "{path} misses the Active card"
        );
        assert!(
            !body.contains("id=\"total-received\""),
            "{path} must not render the Received card"
        );
        assert!(
            !body.contains(">Received<"),
            "{path} must not render the Received label"
        );
        assert!(
            body.contains("balance-summary balance-summary--account"),
            "{path} misses the account summary class"
        );
    }

    for path in [
        "/private-keys/bitcoin",
        "/private-keys/litecoin",
        "/private-keys/zcash",
    ] {
        let (status, _, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        assert!(
            body.contains("id=\"total-received\""),
            "{path} misses the Received card"
        );
        assert!(
            body.contains("id=\"total-tx\""),
            "{path} misses the TX card"
        );
        assert!(
            !body.contains("id=\"total-active\""),
            "{path} must not render the Active card"
        );
    }

    handle.shutdown();
}

#[test]
fn send_routes_are_served_with_testnet_only_copy() {
    let temp = TempState::new("send");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    for path in [
        "/send",
        "/send/bitcoin",
        "/send/ethereum",
        "/send/bnb",
        "/send/usdt",
        "/send/tron",
    ] {
        let (status, headers, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 200, "{path}");
        assert!(
            headers.to_ascii_lowercase().contains("text/html"),
            "{path}: {headers}"
        );
        assert!(body.contains("TESTNET"), "{path} must say TESTNET");
        assert!(
            body.contains("id=\"send-key\""),
            "{path} misses the key input"
        );
        assert!(
            body.contains("id=\"send-prepare\""),
            "{path} misses prepare"
        );
        assert!(body.contains("/send.js"), "{path} misses /send.js");
        assert!(
            body.contains("/wallet-btc.js"),
            "{path} misses the BTC kernel"
        );
        assert!(
            body.contains("/wallet-evm.js"),
            "{path} misses the EVM kernel"
        );
        assert!(
            body.contains("/tron-tx.js"),
            "{path} misses the TRON helper"
        );
    }

    let (status, headers, script) = raw(addr, "GET", "/send.js", None, None);
    eprintln!(
        "DEBUG headers={:?} len={} head={:?}",
        headers,
        script.len(),
        &script[..40.min(script.len())]
    );
    assert_eq!(status, 200);
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("application/javascript"),
        "/send.js: {headers}"
    );
    // The mainnet gates are in the served script, not just in the tests.
    assert!(script.contains("assertTestnetChain"));
    assert!(script.contains("Mainnet sending is disabled"));
    assert!(script.contains("RotorProviders"));
    assert!(script.contains("Blocked an EVM RPC outside the testnet allowlist"));
    assert!(script.contains("a9059cbb"));
    assert!(script.contains("tron-nile"));

    // The testnet endpoints live once, in the generated shared data.
    let (status, _, generated) = raw(addr, "GET", "/chains.generated.js", None, None);
    assert_eq!(status, 200);
    assert!(generated.contains("mempool.space/testnet/api"));
    assert!(generated.contains("bsc-testnet-rpc.publicnode.com"));
    assert!(generated.contains("https://api.nileex.io"));

    let (status, headers, tron) = raw(addr, "GET", "/tron-tx.js", None, None);
    assert_eq!(status, 200);
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("application/javascript"),
        "/tron-tx.js: {headers}"
    );
    assert!(tron.contains("RotorProviders"));
    assert!(tron.contains("RotorTronSend"));
    assert!(!tron.contains("https://api.trongrid.io"));

    let (status, _, sitemap) = raw(addr, "GET", "/sitemap.xml", None, None);
    assert_eq!(status, 200);
    for path in [
        "/send",
        "/send/bitcoin",
        "/send/ethereum",
        "/send/bnb",
        "/send/usdt",
        "/send/tron",
    ] {
        assert!(
            sitemap.contains(&format!("{path}</loc>")),
            "sitemap missing {path}"
        );
    }

    handle.shutdown();
}

/// Minimal HTTP upstream used to prove the wallet download route streams
/// through the coordinator and maps upstream failures to clean statuses.
struct MockUpstream {
    base: String,
    hits: Arc<AtomicUsize>,
    mode: Arc<AtomicUsize>,
    paths: Arc<Mutex<Vec<String>>>,
}

impl MockUpstream {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock upstream");
        let addr = listener.local_addr().expect("mock address");
        let hits = Arc::new(AtomicUsize::new(0));
        let mode = Arc::new(AtomicUsize::new(0));
        let paths = Arc::new(Mutex::new(Vec::new()));
        let hits_thread = Arc::clone(&hits);
        let mode_thread = Arc::clone(&mode);
        let paths_thread = Arc::clone(&paths);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                paths_thread.lock().unwrap().push(path);
                hits_thread.fetch_add(1, Ordering::SeqCst);
                let body = b"mock-wallet-dataset";
                let head = match mode_thread.load(Ordering::SeqCst) {
                    1 => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                    2 => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                    _ => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    ),
                };
                let _ = stream.write_all(head.as_bytes());
                if mode_thread.load(Ordering::SeqCst) == 0 {
                    let _ = stream.write_all(body);
                }
            }
        });
        Self {
            base: format!("http://{addr}"),
            hits,
            mode,
            paths,
        }
    }

    fn set_mode(&self, mode: usize) {
        self.mode.store(mode, Ordering::SeqCst);
    }
}

#[test]
fn wallet_catalog_is_public_and_downloads_stream_through_our_origin() {
    let coordinator_state = TempState::new("wallets");
    let monitor_state = TempState::new("wallets-monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let upstream = MockUpstream::start();
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            open_registration: false,
            trust_proxy: false,
            monitor_domain: "127.0.0.1".to_string(),
            wallets_upstream: Some(upstream.base.clone()),
            tronscan_api_key: None,
            edge_proxy_url: None,
            edge_proxy_secret: None,
            orders: None,
            admin_user: None,
            admin_password: None,
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;

    // Catalogue: public, six chains, license notice, no upstream host.
    let (status, headers, body) = raw(addr, "GET", "/api/v1/wallets", None, None);
    assert_eq!(status, 200, "catalogue: {body}");
    assert!(headers.to_ascii_lowercase().contains("application/json"));
    assert!(!body.contains("github.com"), "upstream host leaked: {body}");
    assert!(body.contains("Copyright (c) 2022 MMDRZA"), "{body}");
    let catalog: serde_json::Value = serde_json::from_str(&body).expect("catalogue JSON");
    assert_eq!(catalog["datasets"].as_array().unwrap().len(), 6);
    assert_eq!(catalog["license"]["name"], "MIT");
    assert_eq!(
        catalog["datasets"][0]["download"],
        "/api/v1/wallets/bitcoin/download"
    );

    // Single-chain lookup and the strict allowlist.
    let (status, _, body) = raw(addr, "GET", "/api/v1/wallets/dash", None, None);
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"chain\":\"dash\""));
    assert!(!body.contains("github.com"));
    let (status, _, _) = raw(addr, "GET", "/api/v1/wallets/bitcoincash", None, None);
    assert_eq!(status, 404, "only the slug allowlist may resolve");
    let (status, _, _) = raw(addr, "GET", "/api/v1/wallets/../secret", None, None);
    assert_eq!(status, 404);

    // Storefront page and machine-readable license file.
    let (status, _, page) = raw(addr, "GET", "/wallets", None, None);
    assert_eq!(status, 200);
    assert!(page.contains("Rich-address wallet databases"), "{page}");
    assert!(
        page.contains("/api/v1/wallets/bitcoin/download"),
        "download must stay on our origin"
    );
    assert!(page.contains("/wallets/LICENSE.txt"));
    assert!(page.contains("Request access"));
    assert!(page.contains("Copyright (c) 2022 MMDRZA"));
    assert!(
        !page.contains("github.com/Pymmdrza"),
        "page links upstream: {page}"
    );
    assert!(
        !page.contains("/releases/download"),
        "page leaks the upstream release host: {page}"
    );
    let (status, headers, license) = raw(addr, "GET", "/wallets/LICENSE.txt", None, None);
    assert_eq!(status, 200);
    assert!(headers.to_ascii_lowercase().contains("text/plain"));
    assert!(license.contains("MIT License"));
    assert!(license.contains("Copyright (c) 2022 MMDRZA"));

    // The landing page links to /wallets only, never to the upstream host.
    let (status, _, landing) = raw(addr, "GET", "/", None, None);
    assert_eq!(status, 200);
    assert!(landing.contains("href=\"/wallets\""));
    assert!(
        !landing.contains("github.com/Pymmdrza"),
        "landing leaks upstream: {landing}"
    );
    assert!(
        !landing.contains("/releases/download"),
        "landing leaks the upstream release host: {landing}"
    );

    // Successful proxied download.
    let (status, headers, body) = raw(addr, "GET", "/api/v1/wallets/bitcoin/download", None, None);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body, "mock-wallet-dataset");
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("content-disposition: attachment")
    );
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("content-type: application/gzip")
    );
    assert!(
        headers.to_ascii_lowercase().contains("rel=\"license\""),
        "MIT notice must travel with the data: {headers}"
    );
    let requested = upstream.paths.lock().unwrap().clone();
    assert_eq!(requested.len(), 1);
    assert_eq!(requested[0], "/Bitcoin/Latest_Rich_Bitcoin_Address.txt.gz");

    // Upstream failure is a clean 502, not a leaked error page.
    upstream.set_mode(1);
    let (status, _, body) = raw(addr, "GET", "/api/v1/wallets/ethereum/download", None, None);
    assert_eq!(status, 502, "{body}");
    assert!(body.contains("upstream download failed"));
    assert!(!body.contains("github.com"));

    // The download bucket allows a burst of two, then answers 429 without
    // calling upstream again.
    let hits_before = upstream.hits.load(Ordering::SeqCst);
    let (status, _, _) = raw(addr, "GET", "/api/v1/wallets/dogecoin/download", None, None);
    assert_eq!(status, 429);
    assert_eq!(upstream.hits.load(Ordering::SeqCst), hits_before);

    handle.shutdown();
}

#[test]
fn tron_lookup_refuses_without_a_provider_key() {
    let coordinator_state = TempState::new("tron");
    let monitor_state = TempState::new("tron-monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            tronscan_api_key: None,
            edge_proxy_url: None,
            edge_proxy_secret: None,
            ..ServerOptions::default()
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;

    // A valid address still cannot be answered without the operator's key.
    let (status, headers, body) = raw(
        addr,
        "GET",
        "/api/v1/chain/tron/address?address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        None,
        None,
    );
    assert_eq!(status, 501, "{body}");
    assert!(
        headers.to_ascii_lowercase().contains("application/json"),
        "{headers}"
    );
    assert!(body.contains("no_provider"), "{body}");

    // Malformed addresses and a missing query never reach the provider.
    let (status, _, body) = raw(
        addr,
        "GET",
        "/api/v1/chain/tron/address?address=0R7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        None,
        None,
    );
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("invalid tron address"), "{body}");
    let (status, _, body) = raw(addr, "GET", "/api/v1/chain/tron/address", None, None);
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("missing address"), "{body}");

    // The route is GET-only and public.
    let (status, _, _) = raw(addr, "POST", "/api/v1/chain/tron/address", None, Some("{}"));
    assert_eq!(status, 405);

    handle.shutdown();
}

#[test]
fn tron_batch_validates_and_requires_a_provider_key() {
    let coordinator_state = TempState::new("tron-batch");
    let monitor_state = TempState::new("tron-batch-monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            tronscan_api_key: None,
            edge_proxy_url: None,
            edge_proxy_secret: None,
            ..ServerOptions::default()
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;
    let address = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

    // A valid batch without a key answers 501 instead of inventing data.
    let body = json!({ "addresses": [address] }).to_string();
    let (status, headers, body) = raw(
        addr,
        "POST",
        "/api/v1/chain/tron/addresses",
        None,
        Some(&body),
    );
    assert_eq!(status, 501, "{body}");
    assert!(
        headers.to_ascii_lowercase().contains("application/json"),
        "{headers}"
    );
    assert!(body.contains("no_provider"), "{body}");

    // More than 60 addresses is rejected before any provider call.
    let many: Vec<&str> = (0..61).map(|_| address).collect();
    let body = json!({ "addresses": many }).to_string();
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/chain/tron/addresses",
        None,
        Some(&body),
    );
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("too many addresses"), "{body}");

    // A malformed address rejects the whole batch.
    let body = json!({ "addresses": ["0R7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"] }).to_string();
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/chain/tron/addresses",
        None,
        Some(&body),
    );
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("invalid tron address"), "{body}");

    // Malformed JSON and a missing field are 400, not a provider error.
    for body in ["not json", "{}", r#"{"addresses": [1]}"#] {
        let (status, _, response) = raw(
            addr,
            "POST",
            "/api/v1/chain/tron/addresses",
            None,
            Some(body),
        );
        assert_eq!(status, 400, "{body}: {response}");
    }

    // The batch route is POST-only and public.
    let (status, _, _) = raw(addr, "GET", "/api/v1/chain/tron/addresses", None, None);
    assert_eq!(status, 405);

    handle.shutdown();
}

#[test]
fn tron_transactions_validates_and_requires_a_provider_key() {
    let coordinator_state = TempState::new("tron-tx");
    let monitor_state = TempState::new("tron-tx-monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            tronscan_api_key: None,
            edge_proxy_url: None,
            edge_proxy_secret: None,
            ..ServerOptions::default()
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;
    let address = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

    // A valid address without a provider answers 501 and never caches the
    // address-specific body in a shared cache.
    let (status, headers, body) = raw(
        addr,
        "GET",
        &format!("/api/v1/chain/tron/transactions?address={address}"),
        None,
        None,
    );
    assert_eq!(status, 501, "{body}");
    assert!(
        headers.to_ascii_lowercase().contains("application/json"),
        "{headers}"
    );
    assert_eq!(
        response_header(&headers, "Cache-Control").as_deref(),
        Some("no-store")
    );
    assert!(body.contains("no_provider"), "{body}");

    // Malformed addresses and a missing query never reach the provider.
    let (status, headers, body) = raw(
        addr,
        "GET",
        "/api/v1/chain/tron/transactions?address=0R7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        None,
        None,
    );
    assert_eq!(status, 400, "{body}");
    assert_eq!(
        response_header(&headers, "Cache-Control").as_deref(),
        Some("no-store")
    );
    assert!(body.contains("invalid tron address"), "{body}");
    let (status, _, body) = raw(addr, "GET", "/api/v1/chain/tron/transactions", None, None);
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("missing address"), "{body}");

    // The route is GET-only and public.
    let (status, _, _) = raw(
        addr,
        "POST",
        "/api/v1/chain/tron/transactions",
        None,
        Some("{}"),
    );
    assert_eq!(status, 405);

    handle.shutdown();
}

fn orders_config(active: bool) -> String {
    format!(
        r#"{{
            "lists": [
                {{
                    "slug": "btc-pack",
                    "title": "Bitcoin package",
                    "chain": "btc",
                    "asset": "BTC",
                    "price_usd_cents": 2900,
                    "usd_per_unit_micros": 60000000000,
                    "decimals": 8,
                    "address": "bc1qexample",
                    "file_path": "/tmp/btc-pack.zip",
                    "sha256": "{}",
                    "active": {active}
                }},
                {{
                    "slug": "ltc-pack",
                    "title": "Litecoin package",
                    "chain": "ltc",
                    "asset": "LTC",
                    "price_usd_cents": 2900,
                    "usd_per_unit_micros": 80000000,
                    "decimals": 8,
                    "address": "ltc1qexample",
                    "file_path": "/tmp/ltc-pack.zip",
                    "sha256": "{}",
                    "active": false
                }}
            ],
            "confirmations": {{"btc": 3, "ltc": 6, "tron": 19}},
            "quote_ttl_secs": 1800,
            "link_ttl_secs": 604800,
            "max_downloads": 5,
            "poll_interval_secs": 86400,
            "esplora": {{"btc": "http://127.0.0.1:9", "ltc": "http://127.0.0.1:9"}}
        }}"#,
        "ab".repeat(32),
        "cd".repeat(32)
    )
}

#[test]
fn orders_are_public_but_need_configuration_and_an_active_list() {
    // Unconfigured: every order route refuses instead of accepting an order.
    let coordinator_state = TempState::new("orders-off");
    let monitor_state = TempState::new("orders-off-monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            orders: None,
            ..ServerOptions::default()
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;
    let (status, headers, body) = raw(
        addr,
        "POST",
        "/api/v1/orders",
        None,
        Some(r#"{"list":"btc-pack"}"#),
    );
    assert_eq!(status, 503, "{body}");
    assert!(
        headers.to_ascii_lowercase().contains("application/json"),
        "{headers}"
    );
    assert!(body.contains("orders_not_configured"), "{body}");
    let (status, _, _) = raw(addr, "GET", "/api/v1/orders/abc", None, None);
    assert_eq!(status, 503);
    handle.shutdown();

    // Configured: inactive and unknown lists are 404, an active list is 201.
    let coordinator_state = TempState::new("orders-on");
    let monitor_state = TempState::new("orders-on-monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let orders_store = TempState::new("orders-store");
    let orders = Arc::new(
        Orders::new(
            OrdersConfig::parse(&orders_config(true)).expect("orders config"),
            b"0123456789abcdef0123456789abcdef",
            orders_store.path().to_path_buf(),
        )
        .expect("orders store"),
    );
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            orders: Some(Arc::clone(&orders)),
            ..ServerOptions::default()
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;

    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/orders",
        None,
        Some(r#"{"list":"nope"}"#),
    );
    assert_eq!(status, 404, "{body}");
    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/orders",
        None,
        Some(r#"{"list":"ltc-pack"}"#),
    );
    assert_eq!(status, 404, "inactive lists must not be orderable: {body}");

    let (status, _, body) = raw(
        addr,
        "POST",
        "/api/v1/orders",
        None,
        Some(r#"{"list":"btc-pack","contact":"buyer@example.com"}"#),
    );
    assert_eq!(status, 201, "{body}");
    let created: serde_json::Value = serde_json::from_str(&body).expect("order JSON");
    let order_id = created["order_id"].as_str().expect("order id").to_string();
    let order_token = created["order_token"]
        .as_str()
        .expect("order token")
        .to_string();
    assert_eq!(created["asset"], "BTC");
    assert_eq!(created["address"], "bc1qexample");
    assert!(
        created["amount"]
            .as_str()
            .expect("amount")
            .parse::<u128>()
            .unwrap()
            > 0
    );
    assert_ne!(order_token, order_id);

    // Status polling needs the one-time order token.
    let (status, _, body) = raw(
        addr,
        "GET",
        &format!("/api/v1/orders/{order_id}?token=wrong"),
        None,
        None,
    );
    assert_eq!(status, 404, "{body}");
    let (status, _, body) = raw(
        addr,
        "GET",
        &format!("/api/v1/orders/{order_id}"),
        Some(&order_token),
        None,
    );
    assert_eq!(status, 200, "{body}");
    let status_body: serde_json::Value = serde_json::from_str(&body).expect("status JSON");
    assert_eq!(status_body["status"], "awaiting_payment");
    assert!(status_body.get("download_url").is_none());

    // A bad download token is a 404, never a hint that the order exists.
    let (status, _, _) = raw(
        addr,
        "GET",
        &format!("/api/v1/orders/{order_id}/download?token=forged"),
        None,
        None,
    );
    assert_eq!(status, 404);

    // Admin revoke is behind the coordinator admin token.
    let (status, _, _) = raw(
        addr,
        "POST",
        &format!("/api/v1/admin/orders/{order_id}/revoke"),
        None,
        None,
    );
    assert_eq!(status, 401);
    let (status, _, body) = raw(
        addr,
        "POST",
        &format!("/api/v1/admin/orders/{order_id}/revoke"),
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("revoked"), "{body}");

    handle.shutdown();
}

// ---------------------------------------------------------------- admin auth

fn admin_login(addr: SocketAddr) -> (String, String, String) {
    let body = json!({"token": TOKEN}).to_string();
    let (status, head, response) = raw(addr, "POST", "/cabinet/admin/login", None, Some(&body));
    assert_eq!(status, 200, "{response}");
    let cookies = response_headers(&head, "set-cookie");
    let session = cookie_pair(&cookies, "rotor_admin")
        .expect("session cookie")
        .to_string();
    let csrf = cookie_pair(&cookies, "rotor_admin_csrf")
        .expect("csrf cookie")
        .to_string();
    (session, csrf, response)
}

#[test]
fn admin_login_sets_signed_cookie_and_csrf() {
    let temp = TempState::new("admin-login");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let (status, head, body) = raw(
        handle.addr,
        "POST",
        "/cabinet/admin/login",
        None,
        Some(&json!({"token": TOKEN}).to_string()),
    );
    assert_eq!(status, 200, "{body}");
    assert!(
        !body.contains(TOKEN),
        "login response must not echo the token"
    );
    let parsed: serde_json::Value = serde_json::from_str(&body).expect("login JSON");
    let csrf_json = parsed["csrf_token"].as_str().expect("csrf_token");
    assert_eq!(csrf_json.len(), 32);
    let expires_at = parsed["expires_at"].as_u64().expect("expires_at");

    let cookies = response_headers(&head, "set-cookie");
    let session = cookie_pair(&cookies, "rotor_admin").expect("session cookie");
    let session_header = cookies
        .iter()
        .find(|cookie| cookie.starts_with("rotor_admin="))
        .expect("session Set-Cookie");
    for flag in [
        "HttpOnly",
        "SameSite=Strict",
        "Path=/cabinet/admin",
        "Max-Age=43200",
        "Secure",
    ] {
        assert!(
            session_header.contains(flag),
            "cookie misses {flag}: {session_header}"
        );
    }

    let csrf_cookie = cookie_pair(&cookies, "rotor_admin_csrf").expect("csrf cookie");
    assert_eq!(csrf_cookie, csrf_json);
    let csrf_header = cookies
        .iter()
        .find(|cookie| cookie.starts_with("rotor_admin_csrf="))
        .expect("csrf Set-Cookie");
    assert!(
        !csrf_header.contains("HttpOnly"),
        "the CSRF cookie must be readable by admin.js: {csrf_header}"
    );
    assert!(csrf_header.contains("Path=/cabinet/admin"));

    let parts: Vec<&str> = session.split('.').collect();
    assert_eq!(parts.len(), 4, "{session}");
    assert_eq!(parts[0], "v1");
    assert_eq!(parts[1].parse::<u64>().expect("exp"), expires_at);
    assert_eq!(parts[2].len(), 32);
    assert_eq!(parts[3].len(), 64);
    let now = now_secs();
    assert!(expires_at > now);
    assert!(expires_at <= now + 12 * 60 * 60 + 5, "{expires_at}");

    handle.shutdown();
}

#[test]
fn admin_login_accepts_the_operator_password() {
    let coordinator_state = TempState::new("admin-password");
    let monitor_state = TempState::new("admin-password-monitor");
    let store = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        coordinator_state.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            open_registration: false,
            trust_proxy: false,
            monitor_domain: "127.0.0.1".to_string(),
            wallets_upstream: None,
            tronscan_api_key: None,
            edge_proxy_url: None,
            edge_proxy_secret: None,
            orders: None,
            admin_user: Some("owner".to_string()),
            admin_password: Some("correct horse battery".to_string()),
        },
        Arc::clone(&store),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;

    let (status, head, body) = raw(
        addr,
        "POST",
        "/cabinet/admin/login",
        None,
        Some(&json!({"user": "owner", "password": "correct horse battery"}).to_string()),
    );
    assert_eq!(status, 200, "{body}");
    let cookies = response_headers(&head, "set-cookie");
    assert!(
        cookie_pair(&cookies, "rotor_admin").is_some(),
        "sign-in must set the session cookie"
    );
    assert!(
        !body.contains("correct horse"),
        "the response must not echo the password"
    );

    for (label, body) in [
        (
            "wrong password",
            json!({"user": "owner", "password": "wrong"}),
        ),
        (
            "wrong user",
            json!({"user": "admin", "password": "correct horse battery"}),
        ),
        ("empty", json!({"user": "", "password": ""})),
    ] {
        let (status, _, _) = raw(
            addr,
            "POST",
            "/cabinet/admin/login",
            None,
            Some(&body.to_string()),
        );
        assert_eq!(status, 401, "{label} must be refused");
    }

    let (status, _, body) = raw(
        addr,
        "POST",
        "/cabinet/admin/login",
        None,
        Some(&json!({"token": TOKEN}).to_string()),
    );
    assert_eq!(status, 200, "the coordinator token still signs in: {body}");

    handle.shutdown();
}

#[test]
fn admin_rejects_tampered_expired_and_rotated_cookies() {
    let temp = TempState::new("admin-cookie");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;
    let now = now_secs();

    let valid = test_admin_cookie(TOKEN, now + 3600);
    let cookie_header = format!("rotor_admin={valid}");
    let (status, _, body) = raw_with_headers(
        addr,
        "GET",
        "/cabinet/admin",
        None,
        None,
        &[("Cookie", cookie_header.as_str())],
    );
    assert_eq!(status, 200, "minted cookie must validate: {body}");

    let mut tampered = valid.clone();
    // Change the last MAC nibble to a different digit. Comparing the pushed
    // value with the popped one (not with the new last char) makes the tamper
    // deterministic: the old version could reproduce the original cookie when
    // the last two hex digits happened to be "01".
    let last = tampered.pop().expect("MAC digit");
    tampered.push(if last == '0' { '1' } else { '0' });
    let expired = test_admin_cookie(TOKEN, now.saturating_sub(1));
    let rotated = test_admin_cookie("different-admin-token", now + 3600);
    // A correctly signed cookie may not outlive the documented 12 h TTL.
    let overlong = test_admin_cookie(TOKEN, now + 12 * 60 * 60 + 3600);

    for (label, cookie) in [
        ("tampered MAC", tampered),
        ("expired exp", expired),
        ("different token", rotated),
        ("exp beyond the TTL", overlong),
    ] {
        let header = format!("rotor_admin={cookie}");
        let (status, head, _) = raw_with_headers(
            addr,
            "GET",
            "/cabinet/admin",
            None,
            None,
            &[("Cookie", header.as_str())],
        );
        assert_eq!(status, 302, "{label} must not open the dashboard");
        assert_eq!(
            response_header(&head, "location").as_deref(),
            Some("/cabinet/admin/login"),
            "{label}"
        );
        assert_admin_headers(&head);
    }

    handle.shutdown();
}

#[test]
fn admin_login_locks_out_after_five_failures() {
    let temp = TempState::new("admin-lockout");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;
    let bad = json!({"token": "wrong-token"}).to_string();

    for attempt in 1..=5 {
        let (status, head, body) = raw(addr, "POST", "/cabinet/admin/login", None, Some(&bad));
        if attempt < 5 {
            assert_eq!(status, 401, "attempt {attempt}: {body}");
        } else {
            assert_eq!(status, 429, "the fifth failure must lock: {body}");
            let retry = response_header(&head, "retry-after").expect("Retry-After");
            assert!(retry.parse::<u64>().expect("numeric Retry-After") > 0);
            assert_admin_headers(&head);
        }
    }

    // The correct token stays locked for the rest of the window.
    let good = json!({"token": TOKEN}).to_string();
    let (status, _, body) = raw(addr, "POST", "/cabinet/admin/login", None, Some(&good));
    assert_eq!(
        status, 429,
        "lockout must not be bypassed by a good token: {body}"
    );
    assert!(!body.contains(TOKEN));

    handle.shutdown();
}

#[test]
fn admin_logout_needs_csrf_and_origin_and_clears_cookies() {
    // Logout is client-side by design: this proves the clear `Set-Cookie`
    // headers, not server-side invalidation of a copied cookie (the stateless
    // trade-off documented in the proposal).
    let temp = TempState::new("admin-logout");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;
    let (session, csrf, _) = admin_login(addr);
    let cookie = format!("rotor_admin={session}; rotor_admin_csrf={csrf}");

    let (status, _, _) = raw_with_headers(
        addr,
        "POST",
        "/cabinet/admin/logout",
        None,
        None,
        &[("Cookie", cookie.as_str())],
    );
    assert_eq!(status, 403, "logout without the CSRF header must fail");

    let wrong_csrf = "0".repeat(32);
    let (status, _, _) = raw_with_headers(
        addr,
        "POST",
        "/cabinet/admin/logout",
        None,
        None,
        &[
            ("Cookie", cookie.as_str()),
            ("X-CSRF-Token", wrong_csrf.as_str()),
        ],
    );
    assert_eq!(status, 403, "a wrong CSRF token must fail");

    let evil_origin = "https://evil.example";
    let (status, _, _) = raw_with_headers(
        addr,
        "POST",
        "/cabinet/admin/logout",
        None,
        None,
        &[
            ("Cookie", cookie.as_str()),
            ("X-CSRF-Token", csrf.as_str()),
            ("Origin", evil_origin),
        ],
    );
    assert_eq!(status, 403, "a cross-origin logout must fail");

    let origin = format!("http://{addr}");
    let (status, head, body) = raw_with_headers(
        addr,
        "POST",
        "/cabinet/admin/logout",
        None,
        None,
        &[
            ("Cookie", cookie.as_str()),
            ("X-CSRF-Token", csrf.as_str()),
            ("Origin", origin.as_str()),
        ],
    );
    assert_eq!(status, 200, "{body}");
    assert!(!body.contains(TOKEN));
    assert_admin_headers(&head);
    let cleared = response_headers(&head, "set-cookie");
    assert_eq!(cleared.len(), 2, "{cleared:?}");
    let session_clear = cleared
        .iter()
        .find(|cookie| cookie.starts_with("rotor_admin="))
        .expect("session clear");
    let csrf_clear = cleared
        .iter()
        .find(|cookie| cookie.starts_with("rotor_admin_csrf="))
        .expect("csrf clear");
    for header in [session_clear, csrf_clear] {
        assert!(header.contains("Max-Age=0"), "{header}");
        assert!(header.contains("Path=/cabinet/admin"), "{header}");
    }

    handle.shutdown();
}

#[test]
fn admin_gate_headers_and_moved_design_gallery() {
    let temp = TempState::new("admin-gate");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;

    // No session: HTML redirects, API answers 401, and `/design` is gone.
    for path in [
        "/cabinet/admin",
        "/cabinet/admin/design",
        "/cabinet/admin/site-map",
    ] {
        let (status, head, _) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 302, "{path}");
        assert_eq!(
            response_header(&head, "location").as_deref(),
            Some("/cabinet/admin/login"),
            "{path}"
        );
        assert_admin_headers(&head);
    }
    let (status, head, body) = raw(addr, "GET", "/cabinet/admin/api/overview", None, None);
    assert_eq!(status, 401, "{body}");
    assert_admin_headers(&head);
    let (status, _, _) = raw(addr, "GET", "/design", None, None);
    assert_eq!(status, 404, "/design must be removed");

    let (session, _, _) = admin_login(addr);
    let cookie = format!("rotor_admin={session}");

    // Dashboard with the cookie, and the admin header set on every response.
    let (status, head, body) = raw_with_headers(
        addr,
        "GET",
        "/cabinet/admin",
        None,
        None,
        &[("Cookie", cookie.as_str())],
    );
    assert_eq!(status, 200, "{body}");
    assert_admin_headers(&head);
    assert!(
        !body.contains(TOKEN),
        "dashboard must not contain the token"
    );
    assert!(!body.contains("<style"), "admin page must not inline CSS");
    assert!(
        !body.contains("<script>"),
        "admin page must not inline JavaScript"
    );

    // The API works with the cookie and, without it, with the bearer token.
    let (status, head, body) = raw_with_headers(
        addr,
        "GET",
        "/cabinet/admin/api/overview",
        None,
        None,
        &[("Cookie", cookie.as_str())],
    );
    assert_eq!(status, 200, "{body}");
    assert_admin_headers(&head);
    assert!(!body.contains(TOKEN), "overview must not contain the token");
    let overview: serde_json::Value = serde_json::from_str(&body).expect("overview JSON");
    assert!(overview["build_id"].is_string());
    assert!(overview["uptime_secs"].is_u64());
    assert!(overview["jobs"]["total"].is_u64());
    assert!(overview["leases"]["active"].is_u64());
    assert!(overview["clients"]["registered"].is_u64());

    let (status, _, body) = raw(
        addr,
        "GET",
        "/cabinet/admin/api/overview",
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 200, "bearer must work for admin API calls: {body}");
    assert!(!body.contains(TOKEN));

    // Bearer is for API calls only: HTML still needs the cookie.
    let (status, _, _) = raw(addr, "GET", "/cabinet/admin", Some(TOKEN), None);
    assert_eq!(status, 302, "bearer alone must not open admin HTML");

    // The gallery moved behind the cookie and no longer ships inline CSS.
    let (status, head, body) = raw_with_headers(
        addr,
        "GET",
        "/cabinet/admin/design",
        None,
        None,
        &[("Cookie", cookie.as_str())],
    );
    assert_eq!(status, 200, "{body}");
    assert_admin_headers(&head);
    assert!(!body.contains(TOKEN));
    assert!(!body.contains("<style"), "gallery must not inline CSS");

    // Admin assets carry the same headers even though they need no session.
    let (status, head, _) = raw(addr, "GET", "/admin.js", None, None);
    assert_eq!(status, 200);
    assert_admin_headers(&head);
    let (status, _, _) = raw(addr, "GET", "/admin.css", None, None);
    assert_eq!(status, 200);

    // The routing map page renders data/routes.json and keeps the admin rules.
    let (status, head, body) = raw_with_headers(
        addr,
        "GET",
        "/cabinet/admin/site-map",
        None,
        None,
        &[("Cookie", cookie.as_str())],
    );
    assert_eq!(status, 200, "{body}");
    assert_admin_headers(&head);
    assert!(!body.contains(TOKEN));
    assert!(!body.contains("<style"), "route map must not inline CSS");
    assert!(
        !body.contains("<script>"),
        "route map must not inline JavaScript"
    );
    assert!(body.contains("Route map"), "{body}");
    assert!(body.contains("site-map-admin.js"), "{body}");
    assert!(body.contains("map-family"), "{body}");

    // The map JSON is session/bearer gated and carries the route families.
    let (status, head, body) = raw(addr, "GET", "/cabinet/admin/api/site-map", None, None);
    assert_eq!(status, 401, "{body}");
    assert_admin_headers(&head);
    let (status, head, body) = raw(
        addr,
        "GET",
        "/cabinet/admin/api/site-map",
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 200, "{body}");
    assert_admin_headers(&head);
    assert!(!body.contains(TOKEN));
    let map: serde_json::Value = serde_json::from_str(&body).expect("route map JSON");
    let routes = map["routes"].as_array().expect("routes array");
    assert!(routes.len() >= 80, "only {} route families", routes.len());
    assert!(
        routes.iter().any(|route| route["pattern"] == "/key/:hex"),
        "the map must list /key/:hex"
    );

    // The page script is an admin asset: no session needed, no-store headers.
    let (status, head, _) = raw(addr, "GET", "/site-map-admin.js", None, None);
    assert_eq!(status, 200);
    assert_admin_headers(&head);

    handle.shutdown();
}

// ------------------------------------------------------- admin inventory

const ADMIN_INVENTORY_ENDPOINTS: &[&str] = &[
    "/cabinet/admin/api/clients",
    "/cabinet/admin/api/monitor/users",
    "/cabinet/admin/api/monitor/events",
    "/cabinet/admin/api/jobs",
    "/cabinet/admin/api/workers",
    "/cabinet/admin/api/leases",
    "/cabinet/admin/api/orders",
    "/cabinet/admin/api/payments",
];

const ADMIN_SINGLE_ENDPOINTS: &[&str] = &[
    "/cabinet/admin/api/providers",
    "/cabinet/admin/api/integrations",
    "/cabinet/admin/api/audit",
];

fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn admin_inventory_endpoints_need_auth_and_paginate() {
    let temp = TempState::new("admin-inventory");
    let monitor_state = TempState::new("admin-inventory-monitor");
    let monitor = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let user_a = monitor
        .upsert_user("0x0000000000000000000000000000000000000001")
        .expect("user a");
    let user_b = monitor
        .upsert_user("0x0000000000000000000000000000000000000002")
        .expect("user b");
    assert!(monitor.link_telegram(&user_a.id, 424242).expect("link"));
    let session_token = monitor.create_session(&user_a.id).expect("session");
    monitor
        .record_event(
            &user_a.id,
            "evm",
            "0x0000000000000000000000000000000000000001",
            "incoming",
            "info",
            "balance changed",
        )
        .expect("event");

    let orders_state = TempState::new("admin-inventory-orders");
    let orders = Arc::new(
        Orders::new(
            OrdersConfig::parse(&orders_config(true)).expect("orders config"),
            b"0123456789abcdef0123456789abcdef",
            orders_state.path().to_path_buf(),
        )
        .expect("orders store"),
    );
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        temp.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            orders: Some(Arc::clone(&orders)),
            tronscan_api_key: Some("inventory-provider-key".to_string()),
            ..ServerOptions::default()
        },
        Arc::clone(&monitor),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;

    // Every endpoint is behind the cookie/bearer gate.
    for path in ADMIN_INVENTORY_ENDPOINTS
        .iter()
        .chain(ADMIN_SINGLE_ENDPOINTS)
    {
        let (status, head, body) = raw(addr, "GET", path, None, None);
        assert_eq!(status, 401, "{path}: {body}");
        assert_admin_headers(&head);
    }

    // Bearer works and the standard page envelope is present.
    for path in ADMIN_INVENTORY_ENDPOINTS {
        let (status, head, body) = raw(addr, "GET", path, Some(TOKEN), None);
        assert_eq!(status, 200, "{path}: {body}");
        assert_admin_headers(&head);
        assert!(!body.contains(TOKEN), "{path} leaked the admin token");
        let value: serde_json::Value = serde_json::from_str(&body).expect("page JSON");
        assert!(value["items"].is_array(), "{path}: {body}");
        assert_eq!(value["page"], 1, "{path}");
        assert_eq!(value["page_size"], 50, "{path}");
        assert!(value["total"].is_u64(), "{path}: {body}");
        assert!(value["has_more"].is_boolean(), "{path}: {body}");
    }
    for path in ADMIN_SINGLE_ENDPOINTS {
        let (status, head, body) = raw(addr, "GET", path, Some(TOKEN), None);
        assert_eq!(status, 200, "{path}: {body}");
        assert_admin_headers(&head);
        assert!(!body.contains(TOKEN), "{path} leaked the admin token");
        let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
        assert!(value.is_object(), "{path}: {body}");
    }

    // The page-size cap is enforced, never trusted from the query.
    let (status, _, body) = raw(
        addr,
        "GET",
        "/cabinet/admin/api/clients?page_size=5000",
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 200, "{body}");
    let value: serde_json::Value = serde_json::from_str(&body).expect("clients JSON");
    assert_eq!(value["page_size"], 200, "page size must be capped: {body}");

    // Clients paginate and the second page is distinct.
    create_client_as(addr, TOKEN, "alpha");
    create_client_as(addr, TOKEN, "beta");
    let (_, _, first) = raw(
        addr,
        "GET",
        "/cabinet/admin/api/clients?page=1&page_size=1",
        Some(TOKEN),
        None,
    );
    let (_, _, second) = raw(
        addr,
        "GET",
        "/cabinet/admin/api/clients?page=2&page_size=1",
        Some(TOKEN),
        None,
    );
    let first: serde_json::Value = serde_json::from_str(&first).expect("first page");
    let second: serde_json::Value = serde_json::from_str(&second).expect("second page");
    assert_eq!(first["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(second["items"].as_array().map(Vec::len), Some(1));
    assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
    assert_eq!(first["total"], 2);
    assert_eq!(first["has_more"], true);

    // Monitor accounts paginate, and the detail never includes a session
    // token or its hash.
    let (_, _, body) = raw(
        addr,
        "GET",
        "/cabinet/admin/api/monitor/users?page=1&page_size=1",
        Some(TOKEN),
        None,
    );
    let users: serde_json::Value = serde_json::from_str(&body).expect("users JSON");
    assert_eq!(users["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(users["total"], 2, "two monitor accounts: {body}");
    let detail_path = format!("/cabinet/admin/api/monitor/users/{}", user_a.id);
    let (status, _, body) = raw(addr, "GET", &detail_path, Some(TOKEN), None);
    assert_eq!(status, 200, "{body}");
    assert!(
        !body.contains(&session_token),
        "detail leaked the session token"
    );
    assert!(
        !body.contains(&sha256_hex(&session_token)),
        "detail leaked the session hash"
    );
    assert!(
        !body.contains("token_hash"),
        "detail exposed a hash field: {body}"
    );
    let detail: serde_json::Value = serde_json::from_str(&body).expect("detail JSON");
    assert_eq!(detail["telegram"]["linked"], true);
    assert_eq!(detail["telegram"]["chat_id"], 424242);
    assert_eq!(detail["sessions"], 1);
    assert!(detail["settings"]["alerts_enabled"].is_boolean());
    assert!(
        detail["events"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
    );

    let (status, _, body) = raw(
        addr,
        "GET",
        &format!("/cabinet/admin/api/monitor/users/{}?page_size=1", user_a.id),
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 200, "{body}");
    let detail: serde_json::Value = serde_json::from_str(&body).expect("detail JSON");
    assert_eq!(detail["events"].as_array().map(Vec::len), Some(1));

    // Orders paginate; two orders share a deposit address but not an amount.
    for _ in 0..2 {
        let (status, _, body) = raw(
            addr,
            "POST",
            "/api/v1/orders",
            None,
            Some(r#"{"list":"btc-pack"}"#),
        );
        assert_eq!(status, 201, "{body}");
    }
    let (status, _, body) = raw(
        addr,
        "GET",
        "/cabinet/admin/api/orders?page=1&page_size=1",
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 200, "{body}");
    let orders: serde_json::Value = serde_json::from_str(&body).expect("orders JSON");
    assert_eq!(orders["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(orders["total"], 2, "{body}");
    assert_eq!(orders["has_more"], true);

    // The empty state is honest: the audit store ships later.
    let (_, _, body) = raw(addr, "GET", "/cabinet/admin/api/audit", Some(TOKEN), None);
    let audit: serde_json::Value = serde_json::from_str(&body).expect("audit JSON");
    assert_eq!(audit["items"].as_array().map(Vec::len), Some(0));
    assert_eq!(audit["available"], false);

    // Two seeded accounts keep distinct ids.
    assert_ne!(user_a.id, user_b.id);
    handle.shutdown();
}

#[test]
fn admin_inventory_payloads_never_contain_configured_secrets() {
    const TRONSCAN_SECRET: &str = "tronscan-secret-admin-test";
    const EDGE_SECRET: &str = "edge-secret-admin-test";
    const ORDERS_HMAC: &str = "orders-hmac-secret-admin-test-0123456789";
    const ORDERS_ADMIN: &str = "orders-admin-secret-admin-test";

    let temp = TempState::new("admin-secrets");
    let monitor_state = TempState::new("admin-secrets-monitor");
    let monitor = Arc::new(MonitorStore::open(monitor_state.path()).expect("monitor store"));
    let user = monitor
        .upsert_user("0x0000000000000000000000000000000000000003")
        .expect("user");
    let session_token = monitor.create_session(&user.id).expect("session");

    // Inject the second orders credential into the existing fixture config.
    let config_text = orders_config(true).replacen(
        "\"lists\"",
        &format!("\"admin_token\": \"{ORDERS_ADMIN}\", \"lists\""),
        1,
    );
    let orders_state = TempState::new("admin-secrets-orders");
    let orders = Arc::new(
        Orders::new(
            OrdersConfig::parse(&config_text).expect("orders config"),
            ORDERS_HMAC.as_bytes(),
            orders_state.path().to_path_buf(),
        )
        .expect("orders store"),
    );
    let handle = spawn_with_monitor_options(
        "127.0.0.1:0",
        temp.path(),
        TOKEN.to_string(),
        Clients::default(),
        ServerOptions {
            orders: Some(Arc::clone(&orders)),
            tronscan_api_key: Some(TRONSCAN_SECRET.to_string()),
            edge_proxy_url: Some("https://proxy.example".to_string()),
            edge_proxy_secret: Some(EDGE_SECRET.to_string()),
            ..ServerOptions::default()
        },
        Arc::clone(&monitor),
    )
    .expect("spawn coordinator");
    let addr = handle.addr;

    // Create an order so the inventory serializes an order row; the public
    // response carries the one-time token, the admin inventory must not.
    let (status, _, created) = raw(
        addr,
        "POST",
        "/api/v1/orders",
        None,
        Some(r#"{"list":"btc-pack"}"#),
    );
    assert_eq!(status, 201, "{created}");
    let created: serde_json::Value = serde_json::from_str(&created).expect("created order");
    let order_token = created["order_token"].as_str().expect("order token");

    let mut payloads = String::new();
    for path in ADMIN_INVENTORY_ENDPOINTS
        .iter()
        .chain(ADMIN_SINGLE_ENDPOINTS)
        .copied()
        .chain(std::iter::once("/cabinet/admin/api/overview"))
    {
        let (status, _, body) = raw(addr, "GET", path, Some(TOKEN), None);
        assert_eq!(status, 200, "{path}: {body}");
        payloads.push_str(&body);
        payloads.push('\n');
    }
    let detail_path = format!("/cabinet/admin/api/monitor/users/{}", user.id);
    let (status, _, body) = raw(addr, "GET", &detail_path, Some(TOKEN), None);
    assert_eq!(status, 200, "{body}");
    payloads.push_str(&body);

    for (label, secret) in [
        ("admin token", TOKEN),
        ("TRONSCAN_API_KEY", TRONSCAN_SECRET),
        ("EDGE_PROXY_SECRET", EDGE_SECRET),
        ("ORDERS_HMAC_SECRET", ORDERS_HMAC),
        ("orders admin token", ORDERS_ADMIN),
        ("order token", order_token),
        ("monitor session token", &session_token),
        ("monitor session hash", &sha256_hex(&session_token)),
    ] {
        assert!(
            !payloads.contains(secret),
            "admin payloads leaked the {label}"
        );
    }
    for field in [
        "token_hash",
        "order_token_hash",
        "\"webhook_secret\":",
        "telegram_webhook_secret",
    ] {
        assert!(
            !payloads.contains(field),
            "admin payloads exposed a {field} field"
        );
    }
    // Integration names are allowed; values are not.
    assert!(payloads.contains("ROTOR_TELEGRAM_BOT_TOKEN"));
    assert!(payloads.contains("TRONSCAN_API_KEY"));

    handle.shutdown();
}

#[test]
fn admin_panels_render_with_states_and_no_inline_code() {
    let temp = TempState::new("admin-panels");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;
    let (session, _, _) = admin_login(addr);
    let cookie = format!("rotor_admin={session}");
    let panels = [
        "/cabinet/admin",
        "/cabinet/admin/clients",
        "/cabinet/admin/monitor",
        "/cabinet/admin/jobs",
        "/cabinet/admin/orders",
        "/cabinet/admin/providers",
        "/cabinet/admin/integrations",
        "/cabinet/admin/audit",
    ];
    for path in panels {
        let (status, head, body) = raw_with_headers(
            addr,
            "GET",
            path,
            None,
            None,
            &[("Cookie", cookie.as_str())],
        );
        assert_eq!(status, 200, "{path}: {body}");
        assert_admin_headers(&head);
        assert!(!body.contains(TOKEN), "{path} embedded the admin token");
        assert!(!body.contains("<style"), "{path} inlined CSS");
        assert!(!body.contains("<script>"), "{path} inlined JavaScript");
        for panel in [
            "overview",
            "clients",
            "monitor",
            "jobs",
            "orders",
            "providers",
            "integrations",
            "audit",
        ] {
            assert!(
                body.contains(&format!("data-panel=\"{panel}\"")),
                "{path} is missing the {panel} panel"
            );
        }
        assert!(
            body.matches("class=\"empty-state\"").count() >= 7,
            "{path} must carry the real empty states"
        );
        assert!(
            body.matches("data-role=\"error\"").count() >= 7,
            "{path} must carry one error state per panel"
        );
        assert!(
            body.matches("data-role=\"loading\"").count() >= 7,
            "{path} must carry one loading state per panel"
        );
    }
    handle.shutdown();
}

// ------------------------------------------------------------- analytics

#[test]
fn analytics_collector_is_cors_scoped_private_and_persisted() {
    let temp = TempState::new("analytics");
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("spawn");
    let addr = handle.addr;
    const COLLECT: &str = "/api/v1/analytics/collect";

    // A foreign origin is refused before the body is read, and no CORS header
    // is echoed back.
    let body = json!({"event": "view", "path": "/private-keys/ethereum"}).to_string();
    let (status, head, _) = raw_with_headers(
        addr,
        "POST",
        COLLECT,
        None,
        Some(&body),
        &[("Origin", "https://evil.example")],
    );
    assert_eq!(status, 403);
    assert_eq!(response_header(&head, "access-control-allow-origin"), None);

    // Malformed and oversized bodies are rejected and never counted.
    for bad in [
        "",
        "{}",
        "{\"event\":\"click\",\"path\":\"/\"}",
        "{\"event\":\"view\",\"path\":\"not-a-path\"}",
        "{\"event\":\"view\",\"path\":\"/\",\"referrer_host\":\"https://a/b\"}",
    ] {
        let (status, _, _) = raw(addr, "POST", COLLECT, None, Some(bad));
        assert_eq!(status, 400, "{bad}");
    }
    let oversized = json!({
        "event": "view",
        "path": "/",
        "pad": "x".repeat(5000),
    })
    .to_string();
    let (status, _, _) = raw(addr, "POST", COLLECT, None, Some(&oversized));
    assert_eq!(status, 413);

    // Preflight is answered only for the two site origins.
    let (status, head, _) = raw_with_headers(
        addr,
        "OPTIONS",
        COLLECT,
        None,
        None,
        &[("Origin", "https://rotor.pxbt.app")],
    );
    assert_eq!(status, 204);
    assert_eq!(
        response_header(&head, "access-control-allow-origin").as_deref(),
        Some("https://rotor.pxbt.app")
    );
    assert!(
        response_header(&head, "access-control-allow-methods")
            .expect("allow-methods")
            .contains("POST")
    );
    let (status, _, _) = raw_with_headers(
        addr,
        "OPTIONS",
        COLLECT,
        None,
        None,
        &[("Origin", "https://evil.example")],
    );
    assert_eq!(status, 403);

    // First allowed beacon: desktop Chrome from Germany.
    let chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
    let body = json!({
        "event": "view",
        "path": "/private-keys/ethereum",
        "referrer_host": "search.example",
    })
    .to_string();
    let (status, head, _) = raw_with_headers(
        addr,
        "POST",
        COLLECT,
        None,
        Some(&body),
        &[
            ("Origin", "https://rotor.pxbt.app"),
            ("CF-IPCountry", "DE"),
            ("User-Agent", chrome),
        ],
    );
    assert_eq!(status, 204);
    assert_eq!(
        response_header(&head, "access-control-allow-origin").as_deref(),
        Some("https://rotor.pxbt.app")
    );
    assert!(
        response_header(&head, "cache-control")
            .expect("cache-control")
            .contains("no-store")
    );
    assert_eq!(
        response_header(&head, "set-cookie"),
        None,
        "the collector must not set a cookie"
    );

    // Second allowed beacon: a bot with no geo header.
    let body = json!({
        "event": "view",
        "path": "/bitcoin-puzzle/66",
    })
    .to_string();
    let (status, head, _) = raw_with_headers(
        addr,
        "POST",
        COLLECT,
        None,
        Some(&body),
        &[
            ("Origin", "https://rotor-site-b8c.pages.dev"),
            (
                "User-Agent",
                "Googlebot/2.1 (+http://www.google.com/bot.html)",
            ),
        ],
    );
    assert_eq!(status, 204);
    assert_eq!(
        response_header(&head, "access-control-allow-origin").as_deref(),
        Some("https://rotor-site-b8c.pages.dev")
    );

    // Unauthenticated admin surfaces stay closed: JSON 401, HTML redirect.
    let (status, _, _) = raw(addr, "GET", "/cabinet/admin/api/analytics", None, None);
    assert_eq!(status, 401);
    let (status, head, _) = raw(addr, "GET", "/cabinet/admin/analytics", None, None);
    assert_eq!(status, 302);
    assert_eq!(
        response_header(&head, "location").as_deref(),
        Some("/cabinet/admin/login")
    );
    assert_admin_headers(&head);

    // The page script is an admin asset and needs no session.
    let (status, head, _) = raw(addr, "GET", "/analytics-admin.js", None, None);
    assert_eq!(status, 200);
    assert_admin_headers(&head);

    // Aggregate API with the bearer token.
    let (status, head, body) = raw(
        addr,
        "GET",
        "/cabinet/admin/api/analytics",
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 200, "{body}");
    assert_admin_headers(&head);
    assert!(!body.contains(TOKEN));
    let snapshot: serde_json::Value = serde_json::from_str(&body).expect("analytics JSON");
    assert_eq!(snapshot["today"]["views"], 2);
    assert_eq!(snapshot["week"]["views"], 2);
    assert_eq!(snapshot["retention_hours"], 168);
    assert_eq!(snapshot["timezone"], "UTC");
    assert_eq!(snapshot["hourly"].as_array().expect("hourly").len(), 24);
    assert_eq!(snapshot["daily"].as_array().expect("daily").len(), 7);

    let routes = snapshot["routes"].as_array().expect("routes");
    assert!(
        routes
            .iter()
            .any(|row| row["name"] == "/private-keys" && row["views"] == 1)
    );
    assert!(
        routes
            .iter()
            .any(|row| row["name"] == "/bitcoin-puzzle" && row["views"] == 1)
    );
    let countries = snapshot["countries"].as_array().expect("countries");
    assert!(
        countries
            .iter()
            .any(|row| row["name"] == "DE" && row["views"] == 1)
    );
    assert!(
        countries
            .iter()
            .any(|row| row["name"] == "unknown" && row["views"] == 1)
    );
    let devices = snapshot["devices"].as_array().expect("devices");
    assert!(devices.iter().any(|row| row["name"] == "desktop"));
    assert!(devices.iter().any(|row| row["name"] == "bot"));
    let browsers = snapshot["browsers"].as_array().expect("browsers");
    assert!(browsers.iter().any(|row| row["name"] == "chrome"));
    let referrers = snapshot["referrers"].as_array().expect("referrers");
    assert!(
        referrers
            .iter()
            .any(|row| row["name"] == "search.example" && row["views"] == 1)
    );
    assert!(snapshot["coordinator"]["served_requests_total"].is_u64());
    assert!(snapshot["coordinator"]["max_concurrent_requests"].is_u64());

    // The persisted document contains counters only: no user agent, no IP.
    let stored = fs::read_to_string(temp.path()).expect("read state");
    assert!(stored.contains("\"analytics\""), "{stored}");
    assert!(
        !stored.contains("Mozilla"),
        "user agent must never be stored"
    );
    assert!(
        !stored.contains("AppleWebKit"),
        "user agent must never be stored"
    );
    assert!(
        !stored.contains("Googlebot"),
        "user agent must never be stored"
    );
    assert!(!stored.contains("127.0.0.1"), "IP must never be stored");

    // Restarting the coordinator keeps the persisted day.
    handle.shutdown();
    let handle = spawn("127.0.0.1:0", temp.path(), TOKEN.to_string()).expect("respawn");
    let (status, _, body) = raw(
        handle.addr,
        "GET",
        "/cabinet/admin/api/analytics",
        Some(TOKEN),
        None,
    );
    assert_eq!(status, 200, "{body}");
    let snapshot: serde_json::Value = serde_json::from_str(&body).expect("analytics JSON");
    assert_eq!(
        snapshot["today"]["views"], 2,
        "graceful shutdown must flush coalesced counters: {body}"
    );
    handle.shutdown();
}

/// The coordinator must consume the shared crates, never the desktop modules.
///
/// The sources are embedded at compile time so the universal revert tier sees
/// the change: restoring an old `use crate::engine`/`bsgs`/`cli` import turns
/// this test red even though the runtime behaviour is identical.
#[test]
fn coordinator_modules_import_shared_crates_not_desktop_modules() {
    const SOURCES: &[(&str, &str)] = &[
        ("state.rs", include_str!("../src/coordinator/state.rs")),
        (
            "chunk_loop.rs",
            include_str!("../src/coordinator/chunk_loop.rs"),
        ),
        ("client.rs", include_str!("../src/coordinator/client.rs")),
        ("mod.rs", include_str!("../src/coordinator/mod.rs")),
        ("orders.rs", include_str!("../src/coordinator/orders.rs")),
    ];
    const FORBIDDEN: &[&str] = &[
        "use crate::engine",
        "use crate::bsgs",
        "use crate::cli",
        "use crate::field",
        "use crate::point",
        "use crate::scalar",
        "use crate::secp",
    ];
    for (file, source) in SOURCES {
        for forbidden in FORBIDDEN {
            assert!(
                !source.contains(forbidden),
                "{file} imports a desktop module: `{forbidden}`"
            );
        }
    }
}
