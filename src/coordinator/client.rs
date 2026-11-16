//! Blocking HTTP client for the coordinator API, used by the client engine.
//!
//! Plain HTTP/1.1 over [`std::net::TcpStream`]: one request per connection,
//! `Connection: close`, 10 s timeouts. TLS is intentionally unsupported; put a
//! reverse proxy in front of the coordinator when it leaves loopback.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::Deserialize;

use crate::bsgs::TableManifest;
use crate::coordinator::state::ManifestJson;

/// A chunk granted by the coordinator.
#[derive(Clone, Debug, Deserialize)]
pub struct Lease {
    pub job_id: String,
    pub chunk_index: u64,
    pub start: String,
    pub end: String,
    pub expires_at: u64,
}

/// A job as returned by `GET /api/v1/jobs`.
#[derive(Clone, Debug, Deserialize)]
pub struct JobInfo {
    pub id: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub targets: Vec<String>,
    pub mode: String,
    pub coin: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub found: bool,
    #[serde(default)]
    pub found_key: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub chunks_total: usize,
    #[serde(default)]
    pub chunks_done: usize,
    #[serde(default)]
    pub chunks_leased: usize,
    #[serde(default)]
    pub scanned: u64,
}

/// A BSGS resume point stored on the coordinator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BsgsState {
    pub manifest: TableManifest,
    pub giant_index: u64,
}

/// Client for the coordinator API.
#[derive(Clone, Debug)]
pub struct CoordinatorClient {
    base: String,
    token: String,
    client_id: String,
}

impl CoordinatorClient {
    /// `base` may be `host:port` or `http://host:port`.
    pub fn new(base: &str, token: &str, client_id: &str) -> Self {
        Self {
            base: base.trim().trim_end_matches('/').to_string(),
            token: token.to_string(),
            client_id: client_id.to_string(),
        }
    }

    /// Lease one chunk. `Ok(None)` means no matching job or no free chunk.
    pub fn lease(
        &self,
        job_id: Option<&str>,
        target: Option<&str>,
        mode: &str,
        coin: &str,
        start: &str,
        end: &str,
    ) -> Result<Option<Lease>, String> {
        let mut body = serde_json::Map::new();
        body.insert("client_id".to_string(), serde_json::json!(self.client_id));
        if let Some(job_id) = job_id {
            body.insert("job_id".to_string(), serde_json::json!(job_id));
        }
        if let Some(target) = target {
            body.insert("target".to_string(), serde_json::json!(target));
        }
        body.insert("mode".to_string(), serde_json::json!(mode));
        body.insert("coin".to_string(), serde_json::json!(coin));
        body.insert("start".to_string(), serde_json::json!(start));
        body.insert("end".to_string(), serde_json::json!(end));
        let payload = serde_json::to_string(&serde_json::Value::Object(body))
            .map_err(|err| format!("cannot encode lease request: {err}"))?;
        let (status, body) = self.request("POST", "/api/v1/lease", Some(&payload))?;
        match status {
            200 => serde_json::from_str::<Lease>(&body)
                .map(Some)
                .map_err(|err| format!("bad lease response: {err}")),
            204 | 404 => Ok(None),
            _ => Err(api_error(status, &body)),
        }
    }

    /// Refresh a lease; returns the new expiry.
    pub fn heartbeat(
        &self,
        job_id: &str,
        chunk_index: u64,
        scanned: u64,
        rate: f64,
        done: bool,
    ) -> Result<u64, String> {
        let payload = serde_json::json!({
            "client_id": self.client_id,
            "job_id": job_id,
            "chunk_index": chunk_index,
            "scanned": scanned,
            "rate": rate,
            "done": done,
        })
        .to_string();
        let (status, body) = self.request("POST", "/api/v1/heartbeat", Some(&payload))?;
        if status != 200 {
            return Err(api_error(status, &body));
        }
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|err| format!("bad heartbeat response: {err}"))?;
        value
            .get("expires_at")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "heartbeat response has no expires_at".to_string())
    }

    /// Submit a found key; the coordinator verifies the proof before accepting.
    pub fn submit_result(&self, job_id: &str, key_hex: &str) -> Result<(), String> {
        let payload = serde_json::json!({
            "client_id": self.client_id,
            "job_id": job_id,
            "key": key_hex,
        })
        .to_string();
        let (status, body) = self.request("POST", "/api/v1/result", Some(&payload))?;
        if status == 200 {
            Ok(())
        } else {
            Err(api_error(status, &body))
        }
    }

    /// Create a job; `body` is the `POST /api/v1/jobs` JSON payload.
    pub fn create_job(&self, body: serde_json::Value) -> Result<JobInfo, String> {
        let payload = body.to_string();
        let (status, response) = self.request("POST", "/api/v1/jobs", Some(&payload))?;
        if status != 201 {
            return Err(api_error(status, &response));
        }
        serde_json::from_str::<JobInfo>(&response).map_err(|err| format!("bad job response: {err}"))
    }

    pub fn jobs(&self) -> Result<Vec<JobInfo>, String> {
        let (status, body) = self.request("GET", "/api/v1/jobs", None)?;
        if status != 200 {
            return Err(api_error(status, &body));
        }
        let response: JobsResponse =
            serde_json::from_str(&body).map_err(|err| format!("bad jobs response: {err}"))?;
        Ok(response.jobs)
    }

    pub fn bsgs_get(&self, job_id: &str) -> Result<Option<BsgsState>, String> {
        let path = format!("/api/v1/bsgs/state?job_id={job_id}");
        let (status, body) = self.request("GET", &path, None)?;
        match status {
            200 => {
                let response: BsgsResponse = serde_json::from_str(&body)
                    .map_err(|err| format!("bad bsgs response: {err}"))?;
                Ok(Some(BsgsState {
                    manifest: response.manifest.to_manifest(),
                    giant_index: response.giant_index,
                }))
            }
            404 => Ok(None),
            _ => Err(api_error(status, &body)),
        }
    }

    pub fn bsgs_put(
        &self,
        job_id: &str,
        manifest: &TableManifest,
        giant_index: u64,
    ) -> Result<(), String> {
        let payload = serde_json::json!({
            "job_id": job_id,
            "manifest": ManifestJson::from(manifest),
            "giant_index": giant_index,
        })
        .to_string();
        let (status, body) = self.request("POST", "/api/v1/bsgs/state", Some(&payload))?;
        if status == 200 {
            Ok(())
        } else {
            Err(api_error(status, &body))
        }
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), String> {
        // The token is interpolated into the request head verbatim; a control
        // byte (CR/LF/NUL) would corrupt it, so reject it before connecting.
        if self.token.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(
                "coordinator token contains a control character (CR, LF and other control bytes are not allowed)"
                    .to_string(),
            );
        }
        let host = normalize_base(&self.base)?;
        let mut stream = connect(&host)?;
        let payload = body.unwrap_or("");
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n",
            self.token
        );
        if body.is_some() {
            request.push_str("Content-Type: application/json\r\n");
        }
        request.push_str(&format!("Content-Length: {}\r\n\r\n", payload.len()));
        request.push_str(payload);
        stream
            .write_all(request.as_bytes())
            .map_err(|err| format!("cannot send request to {host}: {err}"))?;
        stream
            .flush()
            .map_err(|err| format!("cannot flush request to {host}: {err}"))?;
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .map_err(|err| format!("cannot read response from {host}: {err}"))?;
        parse_response(&response)
    }
}

#[derive(Debug, Deserialize)]
struct JobsResponse {
    jobs: Vec<JobInfo>,
}

#[derive(Debug, Deserialize)]
struct BsgsResponse {
    manifest: ManifestJson,
    giant_index: u64,
}

/// Strip `http://` and a trailing slash; reject `https://`.
fn normalize_base(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if base.starts_with("https://") {
        return Err(
            "https is not supported by the coordinator client; terminate TLS at a reverse proxy and use http://"
                .to_string(),
        );
    }
    let base = base.strip_prefix("http://").unwrap_or(base);
    if base.is_empty() {
        return Err("coordinator base URL is empty".to_string());
    }
    Ok(base.to_string())
}

fn connect(host: &str) -> Result<TcpStream, String> {
    let addresses = host
        .to_socket_addrs()
        .map_err(|err| format!("cannot resolve {host}: {err}"))?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .map_err(|err| format!("cannot set read timeout: {err}"))?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(10)))
                    .map_err(|err| format!("cannot set write timeout: {err}"))?;
                return Ok(stream);
            }
            Err(err) => last_error = Some(err),
        }
    }
    Err(match last_error {
        Some(err) => format!("cannot connect to {host}: {err}"),
        None => format!("cannot connect to {host}: no addresses"),
    })
}

fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response: no header terminator".to_string())?;
    let headers = String::from_utf8_lossy(&raw[..split]);
    let mut lines = headers.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "malformed HTTP response: no status line".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("malformed HTTP status line: {status_line}"))?
        .parse::<u16>()
        .map_err(|err| format!("malformed HTTP status code: {err}"))?;

    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            let value = value.trim();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse::<usize>().ok();
            } else if name.eq_ignore_ascii_case("transfer-encoding")
                && value.eq_ignore_ascii_case("chunked")
            {
                chunked = true;
            }
        }
    }

    let body = &raw[split + 4..];
    let decoded = if chunked {
        decode_chunked(body)?
    } else if let Some(length) = content_length {
        body[..length.min(body.len())].to_vec()
    } else {
        body.to_vec()
    };
    Ok((status, String::from_utf8_lossy(&decoded).into_owned()))
}

fn decode_chunked(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = data
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "malformed chunked body: missing size line".to_string())?;
        let size_text = std::str::from_utf8(&data[..line_end])
            .map_err(|err| format!("malformed chunk size: {err}"))?;
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|err| format!("malformed chunk size: {err}"))?;
        data = &data[line_end + 2..];
        if size == 0 {
            break;
        }
        if data.len() < size + 2 {
            return Err("truncated chunked body".to_string());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
    Ok(out)
}

fn api_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body)
        && let Some(error) = value.get("error").and_then(serde_json::Value::as_str)
    {
        return error.to_string();
    }
    let body = body.trim();
    if body.is_empty() {
        format!("HTTP {status}")
    } else {
        body.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_with_control_characters_are_rejected_before_connecting() {
        // Port 9 is unreachable, so a connection attempt would fail with a
        // different error; this proves the token check runs first.
        let client = CoordinatorClient::new("127.0.0.1:9", "good\r\nX-Injected: 1", "client-1");
        let err = client.jobs().expect_err("CRLF token must be rejected");
        assert!(err.contains("control character"), "unexpected error: {err}");

        let client = CoordinatorClient::new("127.0.0.1:9", "good\ntoken", "client-1");
        assert!(client.jobs().is_err());

        let client = CoordinatorClient::new("127.0.0.1:9", "good\0token", "client-1");
        assert!(client.jobs().is_err());
    }
}
