//! Blocking HTTP(S) client for the coordinator API, used by the client engine.
//!
//! One request per call over [`ureq`] with the `native-tls` backend (SChannel
//! on Windows, OpenSSL on Linux), so both `http://` and `https://` base URLs
//! work. A bare `host:port` base defaults to plain HTTP, which keeps localhost
//! tests and the in-process coordinator simple.

use std::time::Duration;

use serde::Deserialize;
use ureq::Agent;

use crate::bsgs::TableManifest;
use crate::coordinator::state::{CHALLENGE_SAMPLES, ManifestJson};

/// A chunk granted by the coordinator.
#[derive(Clone, Debug, Deserialize)]
pub struct Lease {
    pub job_id: String,
    pub chunk_index: u64,
    pub start: String,
    pub end: String,
    pub expires_at: u64,
    /// Nonce that binds heartbeats and results to this lease.
    pub lease_id: u64,
    /// Key offsets inside the chunk whose hashes complete the lease.
    pub challenge_offsets: [u32; CHALLENGE_SAMPLES],
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
    agent: Agent,
}

impl CoordinatorClient {
    /// `base` may be `host:port`, `http://host:port` or `https://host:port`.
    pub fn new(base: &str, token: &str, client_id: &str) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(10))
            .timeout_write(Duration::from_secs(10))
            .build();
        Self {
            base: base.trim().trim_end_matches('/').to_string(),
            token: token.to_string(),
            client_id: client_id.to_string(),
            agent,
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
    ///
    /// `samples` is required when `done` is true (16 hashes of the keys at the
    /// lease's challenge offsets) and ignored for progress heartbeats.
    #[allow(clippy::too_many_arguments)]
    pub fn heartbeat(
        &self,
        job_id: &str,
        chunk_index: u64,
        lease_id: u64,
        scanned: u64,
        rate: f64,
        done: bool,
        samples: &[Vec<u8>],
    ) -> Result<u64, String> {
        let payload = serde_json::json!({
            "client_id": self.client_id,
            "job_id": job_id,
            "chunk_index": chunk_index,
            "lease_id": lease_id,
            "scanned": scanned,
            "rate": rate,
            "done": done,
            "samples": samples,
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
    pub fn submit_result(&self, job_id: &str, lease_id: u64, key_hex: &str) -> Result<(), String> {
        let payload = serde_json::json!({
            "client_id": self.client_id,
            "job_id": job_id,
            "lease_id": lease_id,
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
        // A control byte (CR/LF/NUL) in the token would corrupt the header, so
        // reject it before any connection attempt.
        if self.token.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(
                "coordinator token contains a control character (CR, LF and other control bytes are not allowed)"
                    .to_string(),
            );
        }
        let base = normalize_base(&self.base)?;
        let url = format!("{base}{path}");
        let request = match method {
            "GET" => self.agent.get(&url),
            "POST" => self.agent.post(&url),
            other => return Err(format!("unsupported HTTP method: {other}")),
        }
        .set("Authorization", &format!("Bearer {}", self.token));
        let outcome = match body {
            Some(payload) => request
                .set("Content-Type", "application/json")
                .send_string(payload),
            None => request.call(),
        };
        match outcome {
            Ok(response) => {
                let status = response.status();
                let body = response
                    .into_string()
                    .map_err(|err| format!("cannot read response from {url}: {err}"))?;
                Ok((status, body))
            }
            Err(ureq::Error::Status(status, response)) => {
                let body = response.into_string().unwrap_or_default();
                Ok((status, body))
            }
            Err(ureq::Error::Transport(err)) => Err(format!("cannot reach {url}: {err}")),
        }
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

/// Accept `http://` and `https://` bases; a bare `host:port` means plain HTTP.
fn normalize_base(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("coordinator base URL is empty".to_string());
    }
    if base.starts_with("http://") || base.starts_with("https://") {
        return Ok(base.to_string());
    }
    Ok(format!("http://{base}"))
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

/// Hashes of the keys at `offsets` inside a leased chunk, in wire form.
///
/// The coordinator recomputes the same bytes from `start + offset` and rejects
/// a completion whose samples do not match. BSGS jobs are exempt (offsets there
/// are giant-table indices, not keys) and return no samples.
pub use crate::coordinator::state::challenge_samples;

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

    #[test]
    fn https_urls_are_accepted_by_the_parser() {
        // No network: only the URL normalization is exercised.
        assert_eq!(
            normalize_base("https://rotor.example").expect("https base"),
            "https://rotor.example"
        );
        assert_eq!(
            normalize_base(" https://rotor.example/ ").expect("https base with slash"),
            "https://rotor.example"
        );
        assert_eq!(
            normalize_base("http://127.0.0.1:7878").expect("http base"),
            "http://127.0.0.1:7878"
        );
        assert_eq!(
            normalize_base("127.0.0.1:7878").expect("bare base"),
            "http://127.0.0.1:7878"
        );
        assert!(normalize_base("  ").is_err());
    }
}
