//! Coordinator state: jobs, chunks, leases, results, BSGS state, and its JSON
//! persistence.
//!
//! Every mutation happens under the caller's mutex and rewrites the whole state
//! file atomically (`<path>.tmp` then rename), so a crash never leaves a
//! half-written file behind.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::base58;
use crate::bsgs::TableManifest;
use crate::field::Fe;
use crate::point::Affine;
use crate::scalar::Scalar;
use crate::secp;

/// Default chunk width (`0x10000000`).
pub const DEFAULT_CHUNK_WIDTH: u64 = 0x1000_0000;
/// Default lease TTL in seconds.
pub const DEFAULT_LEASE_TTL: u64 = 600;
/// Refuse jobs that would need more chunks than this.
pub const MAX_CHUNKS: usize = 1_000_000;

/// Error text used across the state, HTTP and client layers.
pub const ERR_JOB_NOT_FOUND: &str = "job not found";
pub const ERR_LEASE_LOST: &str = "lease lost";
pub const ERR_INVALID_PROOF: &str = "invalid proof";
pub const ERR_MANIFEST_MISMATCH: &str = "manifest mismatch";

/// One slice `[start, end]` (inclusive, hex) of a job's key range.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Chunk {
    pub index: u64,
    pub start: String,
    pub end: String,
    pub done: bool,
    /// Keys covered by the latest scan of this chunk; kept after completion so
    /// the job total does not collapse when the lease disappears.
    #[serde(default)]
    pub scanned: u64,
}

/// A search job. Range endpoints are canonical 64-digit lowercase hex.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub target: Option<String>,
    pub targets: Vec<String>,
    pub mode: String,
    pub coin: String,
    pub comp_mode: String,
    pub start: String,
    pub end: String,
    pub chunk_width: u64,
    pub lease_ttl: u64,
    pub created_at: u64,
    pub chunks: Vec<Chunk>,
    pub done: bool,
    pub found: bool,
    pub found_key: Option<String>,
}

/// A client's reservation of one chunk.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lease {
    pub client_id: String,
    pub job_id: String,
    pub chunk_index: u64,
    pub expires_at: u64,
    pub scanned: u64,
    pub rate: f64,
    pub started_at: u64,
}

/// An accepted proof, kept for the dashboard.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResultRecord {
    pub job_id: String,
    pub client_id: String,
    pub key: String,
    pub found_at: u64,
}

/// BSGS table identity in its JSON form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestJson {
    pub format_version: u32,
    pub curve: String,
    pub baby_size: u64,
    pub range_id: String,
    pub table_checksum: u64,
}

impl From<&TableManifest> for ManifestJson {
    fn from(manifest: &TableManifest) -> Self {
        Self {
            format_version: manifest.format_version,
            curve: manifest.curve.clone(),
            baby_size: manifest.baby_size,
            range_id: manifest.range_id.clone(),
            table_checksum: manifest.table_checksum,
        }
    }
}

impl ManifestJson {
    pub fn to_manifest(&self) -> TableManifest {
        TableManifest {
            format_version: self.format_version,
            curve: self.curve.clone(),
            baby_size: self.baby_size,
            range_id: self.range_id.clone(),
            table_checksum: self.table_checksum,
        }
    }
}

/// Persisted BSGS resume point for a job.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct BsgsEntry {
    manifest: ManifestJson,
    giant_index: u64,
}

/// BSGS resume point as returned by [`State::bsgs_get`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BsgsState {
    pub manifest: TableManifest,
    pub giant_index: u64,
}

/// Request body for [`State::create_job`]; also the `POST /api/v1/jobs` body.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NewJob {
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub targets: Vec<String>,
    pub mode: String,
    #[serde(default)]
    pub coin: Option<String>,
    #[serde(default)]
    pub comp_mode: Option<String>,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub chunk_width: Option<u64>,
    #[serde(default)]
    pub lease_ttl: Option<u64>,
}

/// Request body for [`State::lease`]; also the `POST /api/v1/lease` body.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LeaseRequest {
    pub client_id: String,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub coin: Option<String>,
    pub start: String,
    pub end: String,
}

/// A job with its live counters, as served by the API and dashboard.
#[derive(Clone, Debug, Serialize)]
pub struct JobView {
    pub id: String,
    pub target: Option<String>,
    pub targets: Vec<String>,
    pub mode: String,
    pub coin: String,
    pub comp_mode: String,
    pub start: String,
    pub end: String,
    pub chunk_width: u64,
    pub lease_ttl: u64,
    pub created_at: u64,
    pub chunks_total: usize,
    pub chunks_done: usize,
    pub chunks_leased: usize,
    pub scanned: u64,
    pub done: bool,
    pub found: bool,
    pub found_key: Option<String>,
}

/// An active lease, as served by `GET /api/v1/status`.
#[derive(Clone, Debug, Serialize)]
pub struct ClientView {
    pub client_id: String,
    pub job_id: String,
    pub chunk_index: u64,
    pub scanned: u64,
    pub rate: f64,
    pub expires_at: u64,
}

/// A stored BSGS resume point, as served by `GET /api/v1/status`.
#[derive(Clone, Debug, Serialize)]
pub struct BsgsView {
    pub job_id: String,
    pub manifest: ManifestJson,
    pub giant_index: u64,
}

/// Snapshot returned by [`State::status`] and `GET /api/v1/status`.
#[derive(Clone, Debug, Serialize)]
pub struct StatusView {
    pub jobs: Vec<JobView>,
    pub clients: Vec<ClientView>,
    pub results: Vec<ResultRecord>,
    pub bsgs: Vec<BsgsView>,
}

/// A granted chunk, as served by `POST /api/v1/lease`.
#[derive(Clone, Debug, Serialize)]
pub struct LeaseView {
    pub job_id: String,
    pub chunk_index: u64,
    pub start: String,
    pub end: String,
    pub expires_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    jobs: Vec<Job>,
    #[serde(default)]
    leases: Vec<Lease>,
    #[serde(default)]
    results: Vec<ResultRecord>,
    #[serde(default)]
    bsgs: HashMap<String, BsgsEntry>,
}

/// The coordinator's in-memory state plus the path it is persisted to.
#[derive(Debug)]
pub struct State {
    path: PathBuf,
    data: Data,
}

impl State {
    /// Load the state file at `path`; a missing file is an empty state.
    pub fn open(path: impl AsRef<Path>) -> Result<State, String> {
        let path = path.as_ref().to_path_buf();
        let data = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|err| format!("cannot parse {}: {err}", path.display()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Data::default(),
            Err(err) => return Err(format!("cannot read {}: {err}", path.display())),
        };
        Ok(State { path, data })
    }

    /// Alias for [`State::open`], kept for the documented API.
    pub fn load(path: impl AsRef<Path>) -> Result<State, String> {
        State::open(path)
    }

    /// Atomically rewrite the state file (`tmp` + rename).
    pub fn save(&self) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(&self.data)
            .map_err(|err| format!("cannot serialize state: {err}"))?;
        let mut tmp = self.path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, json).map_err(|err| format!("cannot write {}: {err}", tmp.display()))?;
        fs::rename(&tmp, &self.path)
            .map_err(|err| format!("cannot replace {}: {err}", self.path.display()))
    }

    /// Validate and store a new job, slicing its range into disjoint chunks.
    pub fn create_job(&mut self, request: NewJob) -> Result<JobView, String> {
        let mode = request.mode.trim().to_ascii_lowercase();
        if !matches!(
            mode.as_str(),
            "address" | "addresses" | "xpoint" | "xpoints" | "bsgs"
        ) {
            return Err(format!("invalid mode: {}", request.mode));
        }
        let coin = request
            .coin
            .as_deref()
            .unwrap_or("btc")
            .trim()
            .to_ascii_lowercase();
        if coin != "btc" && coin != "eth" {
            return Err(format!("invalid coin: {coin}"));
        }
        let comp_mode = request
            .comp_mode
            .as_deref()
            .unwrap_or("compressed")
            .trim()
            .to_ascii_lowercase();
        if !matches!(comp_mode.as_str(), "compressed" | "uncompressed" | "both") {
            return Err(format!("invalid comp_mode: {comp_mode}"));
        }
        if coin == "eth" && matches!(mode.as_str(), "xpoint" | "xpoints") {
            return Err("ETH supports only address and addresses modes".to_string());
        }

        let (target, targets) = validate_targets(&request, &mode, &coin)?;

        let start = parse_scalar_hex(&request.start)
            .ok_or_else(|| format!("invalid start: {}", request.start))?;
        let end = parse_scalar_hex(&request.end)
            .ok_or_else(|| format!("invalid end: {}", request.end))?;
        if start > end {
            return Err("start must not exceed end".to_string());
        }

        let chunk_width = request.chunk_width.unwrap_or(DEFAULT_CHUNK_WIDTH);
        if chunk_width == 0 {
            return Err("chunk_width must be positive".to_string());
        }
        let lease_ttl = request.lease_ttl.unwrap_or(DEFAULT_LEASE_TTL);
        if lease_ttl == 0 {
            return Err("lease_ttl must be positive".to_string());
        }

        let span = scalar_to_u128(&end.sub(&start))
            .ok_or_else(|| "range is too wide; use a smaller range".to_string())?;
        let count = span / u128::from(chunk_width) + 1;
        if count > MAX_CHUNKS as u128 {
            return Err(format!(
                "range needs {count} chunks; increase chunk_width (limit {MAX_CHUNKS})"
            ));
        }

        let mut chunks = Vec::with_capacity(count as usize);
        let mut position = start;
        for index in 0..count as u64 {
            let candidate = position.add_u64(chunk_width - 1);
            let chunk_end = if candidate < position || candidate > end {
                end
            } else {
                candidate
            };
            chunks.push(Chunk {
                index,
                start: position.to_hex(),
                end: chunk_end.to_hex(),
                done: false,
                scanned: 0,
            });
            if chunk_end == end {
                break;
            }
            position = chunk_end.add_u64(1);
        }

        let created_at = now_secs();
        let id = self.next_job_id(created_at);
        self.data.jobs.push(Job {
            id: id.clone(),
            target,
            targets,
            mode,
            coin,
            comp_mode,
            start: start.to_hex(),
            end: end.to_hex(),
            chunk_width,
            lease_ttl,
            created_at,
            chunks,
            done: false,
            found: false,
            found_key: None,
        });
        self.save()?;
        self.job_view_by_id(&id, now_secs())
            .ok_or_else(|| ERR_JOB_NOT_FOUND.to_string())
    }

    pub fn list_jobs(&self) -> Vec<JobView> {
        let now = now_secs();
        self.data
            .jobs
            .iter()
            .map(|job| self.job_view(job, now))
            .collect()
    }

    /// Grant the first free chunk of the requested (or first matching) job.
    ///
    /// `Ok(None)` means the job exists but every chunk is done or leased.
    /// `Err` is a bad request or [`ERR_JOB_NOT_FOUND`].
    pub fn lease(&mut self, request: LeaseRequest, now: u64) -> Result<Option<LeaseView>, String> {
        let client_id = request.client_id.trim().to_string();
        if client_id.is_empty() {
            return Err("client_id is required".to_string());
        }
        let mode = request.mode.trim().to_ascii_lowercase();
        let coin = request
            .coin
            .as_deref()
            .unwrap_or("btc")
            .trim()
            .to_ascii_lowercase();
        let start = canonical_range_hex(&request.start)?;
        let end = canonical_range_hex(&request.end)?;
        let target = match request.target.as_deref() {
            Some(text) if !text.trim().is_empty() => Some(normalize_target(&mode, &coin, text)?),
            _ => None,
        };

        let job_index = match request.job_id.as_deref() {
            Some(job_id) => {
                let job_id = job_id.trim();
                self.data
                    .jobs
                    .iter()
                    .position(|job| job.id == job_id)
                    .ok_or_else(|| ERR_JOB_NOT_FOUND.to_string())?
            }
            None => self
                .data
                .jobs
                .iter()
                .position(|job| {
                    !job.found
                        && !job.done
                        && job.mode == mode
                        && job.coin == coin
                        && job.start == start
                        && job.end == end
                        && target.as_deref().is_none_or(|wanted| {
                            job.target.as_deref() == Some(wanted)
                                || job.targets.iter().any(|known| known == wanted)
                        })
                })
                .ok_or_else(|| ERR_JOB_NOT_FOUND.to_string())?,
        };

        let (job_id, lease_ttl, chunk_index, chunk_start, chunk_end) = {
            let job = &self.data.jobs[job_index];
            if job.found || job.done {
                return Ok(None);
            }
            let chosen = job.chunks.iter().find(|chunk| {
                !chunk.done
                    && !self.data.leases.iter().any(|lease| {
                        lease.job_id == job.id
                            && lease.chunk_index == chunk.index
                            && lease.expires_at > now
                    })
            });
            let Some(chunk) = chosen else {
                return Ok(None);
            };
            (
                job.id.clone(),
                job.lease_ttl,
                chunk.index,
                chunk.start.clone(),
                chunk.end.clone(),
            )
        };

        let expires_at = now.saturating_add(lease_ttl);
        self.data
            .leases
            .retain(|lease| !(lease.job_id == job_id && lease.chunk_index == chunk_index));
        if let Some(chunk) = self.data.jobs[job_index]
            .chunks
            .iter_mut()
            .find(|chunk| chunk.index == chunk_index)
        {
            // A fresh lease rescans the chunk from its start.
            chunk.scanned = 0;
        }
        self.data.leases.push(Lease {
            client_id,
            job_id: job_id.clone(),
            chunk_index,
            expires_at,
            scanned: 0,
            rate: 0.0,
            started_at: now,
        });
        self.save()?;
        Ok(Some(LeaseView {
            job_id,
            chunk_index,
            start: chunk_start,
            end: chunk_end,
            expires_at,
        }))
    }

    /// Refresh a lease and optionally finish its chunk. Returns the new expiry.
    // The signature is part of the documented state API.
    #[allow(clippy::too_many_arguments)]
    pub fn heartbeat(
        &mut self,
        client_id: &str,
        job_id: &str,
        chunk_index: u64,
        scanned: u64,
        rate: f64,
        done: bool,
        now: u64,
    ) -> Result<u64, String> {
        let position = self
            .data
            .leases
            .iter()
            .position(|lease| lease.job_id == job_id && lease.chunk_index == chunk_index)
            .ok_or_else(|| ERR_LEASE_LOST.to_string())?;
        let lease = &self.data.leases[position];
        if lease.client_id != client_id || now >= lease.expires_at {
            return Err(ERR_LEASE_LOST.to_string());
        }
        let lease_ttl = self
            .data
            .jobs
            .iter()
            .find(|job| job.id == job_id)
            .map(|job| job.lease_ttl)
            .ok_or_else(|| ERR_LEASE_LOST.to_string())?;
        let expires_at = now.saturating_add(lease_ttl);
        let rate = if rate.is_finite() { rate.max(0.0) } else { 0.0 };
        {
            let lease = &mut self.data.leases[position];
            lease.scanned = scanned;
            lease.rate = rate;
            lease.expires_at = expires_at;
        }
        if let Some(job) = self.data.jobs.iter_mut().find(|job| job.id == job_id) {
            if let Some(chunk) = job
                .chunks
                .iter_mut()
                .find(|chunk| chunk.index == chunk_index)
            {
                // Keep the high-water mark: the done heartbeat carries the same
                // count, and the chunk outlives the lease that reported it.
                chunk.scanned = chunk.scanned.max(scanned);
                if done {
                    chunk.done = true;
                }
            }
            if done && job.chunks.iter().all(|chunk| chunk.done) {
                job.done = true;
            }
        }
        if done {
            self.data
                .leases
                .retain(|lease| !(lease.job_id == job_id && lease.chunk_index == chunk_index));
        }
        self.save()?;
        Ok(expires_at)
    }

    /// Verify and record a found key; invalid proofs are rejected.
    pub fn submit_result(
        &mut self,
        client_id: &str,
        job_id: &str,
        key_hex: &str,
    ) -> Result<(), String> {
        let key = {
            let job = self
                .data
                .jobs
                .iter()
                .find(|job| job.id == job_id)
                .ok_or_else(|| ERR_JOB_NOT_FOUND.to_string())?;
            verify_result(job, key_hex)?
        };
        let key_text = key.to_hex();
        if !self
            .data
            .results
            .iter()
            .any(|result| result.job_id == job_id && result.key == key_text)
        {
            self.data.results.push(ResultRecord {
                job_id: job_id.to_string(),
                client_id: client_id.to_string(),
                key: key_text.clone(),
                found_at: now_secs(),
            });
        }
        if let Some(job) = self.data.jobs.iter_mut().find(|job| job.id == job_id) {
            job.found = true;
            job.found_key = Some(key_text);
            job.done = true;
        }
        self.data.leases.retain(|lease| lease.job_id != job_id);
        self.save()
    }

    pub fn status(&self, now: u64) -> StatusView {
        let jobs = self
            .data
            .jobs
            .iter()
            .map(|job| self.job_view(job, now))
            .collect();
        let clients = self
            .data
            .leases
            .iter()
            .filter(|lease| lease.expires_at > now)
            .map(|lease| ClientView {
                client_id: lease.client_id.clone(),
                job_id: lease.job_id.clone(),
                chunk_index: lease.chunk_index,
                scanned: lease.scanned,
                rate: lease.rate,
                expires_at: lease.expires_at,
            })
            .collect();
        let mut bsgs: Vec<BsgsView> = self
            .data
            .bsgs
            .iter()
            .map(|(job_id, entry)| BsgsView {
                job_id: job_id.clone(),
                manifest: entry.manifest.clone(),
                giant_index: entry.giant_index,
            })
            .collect();
        bsgs.sort_by(|left, right| left.job_id.cmp(&right.job_id));
        StatusView {
            jobs,
            clients,
            results: self.data.results.clone(),
            bsgs,
        }
    }

    pub fn bsgs_get(&self, job_id: &str) -> Option<BsgsState> {
        self.data.bsgs.get(job_id).map(|entry| BsgsState {
            manifest: entry.manifest.to_manifest(),
            giant_index: entry.giant_index,
        })
    }

    /// Store a BSGS resume point; a different table for the same job conflicts.
    ///
    /// A `giant_index` past the last giant step of the job's range means the
    /// client walked the whole range, so the job is marked done.
    pub fn bsgs_put(
        &mut self,
        job_id: &str,
        manifest: TableManifest,
        giant_index: u64,
    ) -> Result<(), String> {
        let giants = {
            let job = self
                .data
                .jobs
                .iter()
                .find(|job| job.id == job_id)
                .ok_or_else(|| ERR_JOB_NOT_FOUND.to_string())?;
            if job.mode != "bsgs" {
                return Err("job is not bsgs".to_string());
            }
            if let Some(stored) = self.data.bsgs.get(job_id)
                && !stored.manifest.to_manifest().compatible(&manifest)
            {
                return Err(ERR_MANIFEST_MISMATCH.to_string());
            }
            bsgs_giant_count(job, manifest.baby_size)
        };
        self.data.bsgs.insert(
            job_id.to_string(),
            BsgsEntry {
                manifest: ManifestJson::from(&manifest),
                giant_index,
            },
        );
        if let Some(giants) = giants
            && u128::from(giant_index) > giants
            && let Some(job) = self.data.jobs.iter_mut().find(|job| job.id == job_id)
        {
            job.done = true;
        }
        self.save()
    }

    fn next_job_id(&self, now: u64) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0);
        let mut attempt = 0u64;
        loop {
            let id = format!("{now:016x}{nanos:08x}{attempt:04x}");
            if !self.data.jobs.iter().any(|job| job.id == id) {
                return id;
            }
            attempt += 1;
        }
    }

    fn job_view_by_id(&self, id: &str, now: u64) -> Option<JobView> {
        self.data
            .jobs
            .iter()
            .find(|job| job.id == id)
            .map(|job| self.job_view(job, now))
    }

    fn job_view(&self, job: &Job, now: u64) -> JobView {
        let chunks_total = job.chunks.len();
        let chunks_done = job.chunks.iter().filter(|chunk| chunk.done).count();
        let leases: Vec<&Lease> = self
            .data
            .leases
            .iter()
            .filter(|lease| lease.job_id == job.id)
            .collect();
        let chunks_leased = leases.iter().filter(|lease| lease.expires_at > now).count();
        let scanned = job
            .chunks
            .iter()
            .fold(0u64, |acc, chunk| acc.saturating_add(chunk.scanned));
        JobView {
            id: job.id.clone(),
            target: job.target.clone(),
            targets: job.targets.clone(),
            mode: job.mode.clone(),
            coin: job.coin.clone(),
            comp_mode: job.comp_mode.clone(),
            start: job.start.clone(),
            end: job.end.clone(),
            chunk_width: job.chunk_width,
            lease_ttl: job.lease_ttl,
            created_at: job.created_at,
            chunks_total,
            chunks_done,
            chunks_leased,
            scanned,
            done: job.done,
            found: job.found,
            found_key: job.found_key.clone(),
        }
    }
}

/// Unix time in seconds.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Verify `key_hex * G` against the job's target; returns the scalar.
pub fn verify_result(job: &Job, key_hex: &str) -> Result<Scalar, String> {
    let key = parse_scalar_hex(key_hex).ok_or_else(|| ERR_INVALID_PROOF.to_string())?;
    if key.is_zero() {
        return Err(ERR_INVALID_PROOF.to_string());
    }
    let point = secp::mul_g(&key);
    if job_matches(job, &point) {
        Ok(key)
    } else {
        Err(ERR_INVALID_PROOF.to_string())
    }
}

fn validate_targets(
    request: &NewJob,
    mode: &str,
    coin: &str,
) -> Result<(Option<String>, Vec<String>), String> {
    match mode {
        "address" => {
            let raw = request
                .target
                .as_deref()
                .ok_or_else(|| "address mode needs a target".to_string())?;
            if coin == "btc" {
                let payload = base58::decode_check(raw.trim())
                    .map_err(|err| format!("invalid address: {err}"))?;
                if payload.len() != 21 || payload[0] != 0 {
                    return Err("invalid address: expected a mainnet P2PKH payload".to_string());
                }
                Ok((Some(raw.trim().to_string()), Vec::new()))
            } else {
                Ok((Some(normalize_hex_width(raw, 40)?), Vec::new()))
            }
        }
        "xpoint" | "bsgs" => {
            let raw = request
                .target
                .as_deref()
                .ok_or_else(|| format!("{mode} mode needs a target"))?;
            Ok((Some(normalize_target(mode, coin, raw)?), Vec::new()))
        }
        "addresses" | "xpoints" => {
            let targets = collect_targets(request, mode, coin)?;
            Ok((None, targets))
        }
        _ => Err(format!("invalid mode: {mode}")),
    }
}

fn collect_targets(request: &NewJob, mode: &str, coin: &str) -> Result<Vec<String>, String> {
    let mut raw: Vec<String> = request
        .targets
        .iter()
        .map(|target| target.trim().to_string())
        .filter(|target| !target.is_empty())
        .collect();
    if raw.is_empty()
        && let Some(text) = &request.target
    {
        raw = text
            .split(|character: char| character.is_whitespace() || character == ',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect();
    }
    if raw.is_empty() {
        return Err("targets must not be empty".to_string());
    }
    raw.iter()
        .map(|text| match mode {
            "addresses" => normalize_hex_width(text, 40),
            _ => normalize_target(mode, coin, text),
        })
        .collect()
}

fn normalize_target(mode: &str, coin: &str, text: &str) -> Result<String, String> {
    match mode {
        "address" if coin == "eth" => normalize_hex_width(text, 40),
        "address" => {
            let text = text.trim();
            if text.is_empty() {
                Err("target is required".to_string())
            } else {
                Ok(text.to_string())
            }
        }
        "addresses" => normalize_hex_width(text, 40),
        "xpoint" | "xpoints" => {
            let value = normalize_hex_width(text, 64)?;
            Fe::from_hex(&value).ok_or_else(|| format!("invalid X coordinate: {text}"))?;
            Ok(value)
        }
        "bsgs" => {
            let text = strip_hex_prefix(text).to_ascii_lowercase();
            let mut compressed = true;
            secp::parse_pubkey_hex(&text, &mut compressed)?;
            Ok(text)
        }
        _ => Ok(text.trim().to_ascii_lowercase()),
    }
}

fn job_matches(job: &Job, point: &Affine) -> bool {
    match job.mode.as_str() {
        "bsgs" => {
            let Some(target) = job.target.as_deref() else {
                return false;
            };
            let mut compressed = true;
            match secp::parse_pubkey_hex(target, &mut compressed) {
                Ok(stored) => stored == *point,
                Err(_) => false,
            }
        }
        "xpoint" => job
            .target
            .as_deref()
            .is_some_and(|target| target.eq_ignore_ascii_case(&point.x.to_hex())),
        "address" => address_matches(job, point),
        "addresses" => {
            let flags = comp_flags(&job.comp_mode, &job.coin);
            job.targets.iter().any(|target| {
                flags
                    .iter()
                    .any(|&compressed| derived_hex(job, point, compressed) == *target)
            })
        }
        "xpoints" => {
            let x = point.x.to_hex();
            job.targets.iter().any(|target| target == &x)
        }
        _ => false,
    }
}

fn address_matches(job: &Job, point: &Affine) -> bool {
    let Some(target) = job.target.as_deref() else {
        return false;
    };
    if job.coin == "eth" {
        return derived_hex(job, point, false) == target;
    }
    let Ok(payload) = base58::decode_check(target) else {
        return false;
    };
    if payload.len() != 21 || payload[0] != 0 {
        return false;
    }
    comp_flags(&job.comp_mode, &job.coin)
        .iter()
        .any(|&compressed| secp::hash160(point, compressed).as_slice() == &payload[1..])
}

fn derived_hex(job: &Job, point: &Affine, compressed: bool) -> String {
    if job.coin == "eth" {
        hex20(&secp::eth_address(point))
    } else {
        hex20(&secp::hash160(point, compressed))
    }
}

fn hex20(bytes: &[u8; 20]) -> String {
    let mut out = String::with_capacity(40);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn comp_flags(comp_mode: &str, coin: &str) -> &'static [bool] {
    if coin == "eth" {
        return &[false];
    }
    match comp_mode {
        "uncompressed" => &[false],
        "both" => &[true, false],
        _ => &[true],
    }
}

fn parse_scalar_hex(text: &str) -> Option<Scalar> {
    Scalar::from_hex(strip_hex_prefix(text))
}

fn strip_hex_prefix(text: &str) -> &str {
    let text = text.trim();
    text.strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text)
}

fn canonical_range_hex(text: &str) -> Result<String, String> {
    parse_scalar_hex(text)
        .map(|value| value.to_hex())
        .ok_or_else(|| format!("invalid hex range value: {text}"))
}

fn normalize_hex_width(text: &str, width: usize) -> Result<String, String> {
    let text = strip_hex_prefix(text);
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("invalid hexadecimal value: {text}"));
    }
    let trimmed = text.trim_start_matches('0');
    let trimmed = if trimmed.is_empty() { "0" } else { trimmed };
    if trimmed.len() > width {
        return Err(format!(
            "hexadecimal value is longer than {width} digits: {text}"
        ));
    }
    Ok(format!("{:0>width$}", trimmed.to_ascii_lowercase()))
}

/// Number of giant steps (`span / baby_size + 1`) for a BSGS job's range.
///
/// `None` when the range or the baby size cannot be represented.
fn bsgs_giant_count(job: &Job, baby_size: u64) -> Option<u128> {
    if baby_size == 0 {
        return None;
    }
    let start = parse_scalar_hex(&job.start)?;
    let end = parse_scalar_hex(&job.end)?;
    if end < start {
        return None;
    }
    let span = scalar_to_u128(&end.sub(&start))?;
    span.checked_div(u128::from(baby_size))
        .and_then(|value| value.checked_add(1))
}

fn scalar_to_u128(value: &Scalar) -> Option<u128> {
    if (128..256).any(|index| value.bit(index)) {
        return None;
    }
    let bytes = value.to_bytes_be();
    let mut low = [0u8; 16];
    low.copy_from_slice(&bytes[16..]);
    Some(u128::from_be_bytes(low))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempState {
        path: PathBuf,
    }

    impl TempState {
        fn new(tag: &str) -> Self {
            let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "rotor-coord-{}-{nanos}-{unique}-{tag}.json",
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

    fn hex(value: u64) -> String {
        format!("{value:064x}")
    }

    fn hex_bytes(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    fn xpoint_target(key: u64) -> String {
        secp::mul_g(&Scalar::from_u64(key)).x.to_hex()
    }

    fn xpoint_job(state: &mut State, key: u64, start: u64, end: u64, width: u64) -> JobView {
        state
            .create_job(NewJob {
                target: Some(xpoint_target(key)),
                targets: Vec::new(),
                mode: "xpoint".to_string(),
                coin: None,
                comp_mode: None,
                start: hex(start),
                end: hex(end),
                chunk_width: Some(width),
                lease_ttl: Some(60),
            })
            .expect("create xpoint job")
    }

    fn lease_request(job_id: &str, client: &str, start: u64, end: u64) -> LeaseRequest {
        LeaseRequest {
            client_id: client.to_string(),
            job_id: Some(job_id.to_string()),
            target: None,
            mode: "xpoint".to_string(),
            coin: None,
            start: hex(start),
            end: hex(end),
        }
    }

    #[test]
    fn chunks_tile_the_range_without_overlap() {
        let temp = TempState::new("tiling");
        let mut state = State::open(temp.path()).expect("open");
        let job = xpoint_job(&mut state, 7, 0x100, 0x2ff, 0x100);

        let mut leases = Vec::new();
        loop {
            let request = lease_request(&job.id, &format!("client-{}", leases.len()), 0x100, 0x2ff);
            match state.lease(request, 1_000).expect("lease") {
                Some(lease) => leases.push(lease),
                None => break,
            }
        }

        assert_eq!(leases.len(), 2, "the range needs two 0x100-wide chunks");
        assert_eq!(leases[0].start, hex(0x100));
        assert_eq!(leases[0].end, hex(0x1ff));
        assert_eq!(leases[1].start, hex(0x200));
        assert_eq!(leases[1].end, hex(0x2ff));
    }

    #[test]
    fn lease_exhaustion_then_ttl_release() {
        let temp = TempState::new("exhaustion");
        let mut state = State::open(temp.path()).expect("open");
        let job = xpoint_job(&mut state, 7, 1, 0xff, 0x100);

        let first = state
            .lease(lease_request(&job.id, "a", 1, 0xff), 1_000)
            .expect("lease a")
            .expect("chunk available");
        assert_eq!(first.chunk_index, 0);
        assert_eq!(first.expires_at, 1_060);

        assert!(
            state
                .lease(lease_request(&job.id, "b", 1, 0xff), 1_000)
                .expect("lease b")
                .is_none(),
            "the only chunk is leased"
        );

        // At the exact expiry the lease is available again.
        let second = state
            .lease(lease_request(&job.id, "b", 1, 0xff), 1_060)
            .expect("re-lease b")
            .expect("expired chunk is free");
        assert_eq!(second.chunk_index, 0);
    }

    #[test]
    fn heartbeat_refreshes_until_expiry_or_reassignment() {
        let temp = TempState::new("heartbeat");
        let mut state = State::open(temp.path()).expect("open");
        let job = xpoint_job(&mut state, 7, 1, 0xff, 0x100);

        state
            .lease(lease_request(&job.id, "a", 1, 0xff), 1_000)
            .expect("lease")
            .expect("chunk");

        let refreshed = state
            .heartbeat("a", &job.id, 0, 512, 100.0, false, 1_030)
            .expect("heartbeat");
        assert_eq!(refreshed, 1_090);

        assert_eq!(
            state.heartbeat("b", &job.id, 0, 0, 0.0, false, 1_030),
            Err(ERR_LEASE_LOST.to_string())
        );

        // Past the refreshed expiry the lease is lost even for its owner.
        assert_eq!(
            state.heartbeat("a", &job.id, 0, 0, 0.0, false, 1_090),
            Err(ERR_LEASE_LOST.to_string())
        );

        // Another client takes the expired chunk; the first owner is now lost.
        state
            .lease(lease_request(&job.id, "b", 1, 0xff), 1_200)
            .expect("lease b")
            .expect("expired chunk");
        assert_eq!(
            state.heartbeat("a", &job.id, 0, 0, 0.0, false, 1_201),
            Err(ERR_LEASE_LOST.to_string())
        );
    }

    #[test]
    fn completion_marks_the_job_done() {
        let temp = TempState::new("complete");
        let mut state = State::open(temp.path()).expect("open");
        let job = xpoint_job(&mut state, 7, 1, 0xff, 0x100);

        state
            .lease(lease_request(&job.id, "a", 1, 0xff), 1_000)
            .expect("lease")
            .expect("chunk");
        state
            .heartbeat("a", &job.id, 0, 256, 10.0, true, 1_010)
            .expect("finish chunk");

        let jobs = state.list_jobs();
        assert_eq!(jobs[0].chunks_done, 1);
        assert!(jobs[0].done);
        assert!(
            state
                .lease(lease_request(&job.id, "b", 1, 0xff), 1_020)
                .expect("lease")
                .is_none()
        );
    }

    #[test]
    fn state_survives_reload() {
        let temp = TempState::new("reload");
        let job_id = {
            let mut state = State::open(temp.path()).expect("open");
            let job = xpoint_job(&mut state, 42, 1, 0xff, 0x100);
            let bsgs_job = state
                .create_job(NewJob {
                    target: Some(hex_bytes(&secp::compress(&secp::mul_g(&Scalar::from_u64(
                        1,
                    ))))),
                    targets: Vec::new(),
                    mode: "bsgs".to_string(),
                    coin: None,
                    comp_mode: None,
                    start: hex(1),
                    end: hex(0xff),
                    chunk_width: Some(0x100),
                    lease_ttl: Some(60),
                })
                .expect("bsgs job");
            let manifest = TableManifest {
                format_version: 1,
                curve: "secp256k1".to_string(),
                baby_size: 10,
                range_id: "1:ff".to_string(),
                table_checksum: 7,
            };
            state
                .bsgs_put(&bsgs_job.id, manifest, 3)
                .expect("store bsgs state");

            state
                .lease(lease_request(&job.id, "a", 1, 0xff), 1_000)
                .expect("lease")
                .expect("chunk");
            state
                .submit_result("a", &job.id, &Scalar::from_u64(42).to_hex())
                .expect("valid proof");
            job.id.clone()
        };

        let state = State::open(temp.path()).expect("reopen");
        let jobs = state.list_jobs();
        assert_eq!(jobs.len(), 2);
        let found = jobs.iter().find(|job| job.id == job_id).expect("job");
        assert!(found.found);
        let expected_key = Scalar::from_u64(42).to_hex();
        assert_eq!(found.found_key.as_deref(), Some(expected_key.as_str()));

        let status = state.status(1_100);
        assert_eq!(status.results.len(), 1);
        assert_eq!(status.results[0].job_id, job_id);
        assert_eq!(status.bsgs.len(), 1);
        assert_eq!(status.bsgs[0].giant_index, 3);
        assert!(state.bsgs_get(&status.bsgs[0].job_id).is_some());
    }

    #[test]
    fn invalid_proof_is_rejected() {
        let temp = TempState::new("invalid");
        let mut state = State::open(temp.path()).expect("open");
        let job = xpoint_job(&mut state, 7, 1, 0xff, 0x100);

        assert_eq!(
            state.submit_result("a", &job.id, &Scalar::from_u64(8).to_hex()),
            Err(ERR_INVALID_PROOF.to_string())
        );
        assert_eq!(
            state.submit_result("a", &job.id, &Scalar::ZERO.to_hex()),
            Err(ERR_INVALID_PROOF.to_string())
        );
        assert_eq!(
            state.submit_result("a", &job.id, "not-hex"),
            Err(ERR_INVALID_PROOF.to_string())
        );
        assert!(!state.list_jobs()[0].found);

        state
            .submit_result("a", &job.id, &Scalar::from_u64(7).to_hex())
            .expect("valid xpoint proof");
        assert!(state.list_jobs()[0].found);
    }

    #[test]
    fn address_proof_matches_base58check_target() {
        let temp = TempState::new("address");
        let mut state = State::open(temp.path()).expect("open");
        let key = Scalar::from_u64(777);
        let point = secp::mul_g(&key);
        let address = base58::address_from_hash160(&secp::hash160(&point, true), true);
        let job = state
            .create_job(NewJob {
                target: Some(address),
                targets: Vec::new(),
                mode: "address".to_string(),
                coin: Some("btc".to_string()),
                comp_mode: Some("compressed".to_string()),
                start: hex(1),
                end: hex(0xffff),
                chunk_width: Some(0x100),
                lease_ttl: Some(60),
            })
            .expect("address job");

        state
            .submit_result("a", &job.id, &key.to_hex())
            .expect("valid address proof");
        assert_eq!(
            state.submit_result("a", &job.id, &Scalar::from_u64(778).to_hex()),
            Err(ERR_INVALID_PROOF.to_string())
        );
    }

    #[test]
    fn bsgs_manifest_mismatch_is_rejected() {
        let temp = TempState::new("bsgs");
        let mut state = State::open(temp.path()).expect("open");
        let target = hex_bytes(&secp::compress(&secp::mul_g(&Scalar::from_u64(1))));
        let job = state
            .create_job(NewJob {
                target: Some(target),
                targets: Vec::new(),
                mode: "bsgs".to_string(),
                coin: None,
                comp_mode: None,
                start: hex(1),
                end: hex(0xff),
                chunk_width: Some(0x100),
                lease_ttl: Some(60),
            })
            .expect("bsgs job");

        let manifest = TableManifest {
            format_version: 1,
            curve: "secp256k1".to_string(),
            baby_size: 16,
            range_id: "1:ff".to_string(),
            table_checksum: 99,
        };
        state
            .bsgs_put(&job.id, manifest.clone(), 5)
            .expect("store manifest");
        state
            .bsgs_put(&job.id, manifest.clone(), 6)
            .expect("same manifest is compatible");
        assert_eq!(state.bsgs_get(&job.id).expect("stored").giant_index, 6);

        let mut other = manifest;
        other.table_checksum = 100;
        assert_eq!(
            state.bsgs_put(&job.id, other, 7),
            Err(ERR_MANIFEST_MISMATCH.to_string())
        );
    }

    #[test]
    fn scanned_survives_chunk_completion_and_reload() {
        let temp = TempState::new("scanned");
        let job = {
            let mut state = State::open(temp.path()).expect("open");
            let job = xpoint_job(&mut state, 7, 1, 0xff, 0x100);
            state
                .lease(lease_request(&job.id, "a", 1, 0xff), 1_000)
                .expect("lease")
                .expect("chunk");
            state
                .heartbeat("a", &job.id, 0, 64, 10.0, false, 1_010)
                .expect("progress");
            state
                .heartbeat("a", &job.id, 0, 64, 10.0, true, 1_020)
                .expect("finish chunk");
            let status = state.status(1_030);
            assert!(
                status.clients.is_empty(),
                "the done heartbeat drops the lease"
            );
            assert!(
                status.jobs[0].scanned >= 64,
                "scanned dropped to {} after completion",
                status.jobs[0].scanned
            );
            job.id.clone()
        };

        let state = State::open(temp.path()).expect("reopen");
        let status = state.status(1_030);
        let job = status.jobs.iter().find(|view| view.id == job).expect("job");
        assert!(job.done);
        assert!(
            job.scanned >= 64,
            "scanned dropped to {} after reload",
            job.scanned
        );
    }

    #[test]
    fn bsgs_put_marks_the_job_done_after_the_last_giant_step() {
        let temp = TempState::new("bsgs-done");
        let mut state = State::open(temp.path()).expect("open");
        let target = hex_bytes(&secp::compress(&secp::mul_g(&Scalar::from_u64(1))));
        let new_job = |state: &mut State| {
            state
                .create_job(NewJob {
                    target: Some(target.clone()),
                    targets: Vec::new(),
                    mode: "bsgs".to_string(),
                    coin: None,
                    comp_mode: None,
                    start: hex(1),
                    end: hex(0xff),
                    chunk_width: Some(0x100),
                    lease_ttl: Some(60),
                })
                .expect("bsgs job")
        };
        let manifest = TableManifest {
            format_version: 1,
            curve: "secp256k1".to_string(),
            baby_size: 16,
            range_id: "1:ff".to_string(),
            table_checksum: 7,
        };
        // span = 0xfe, giants = 0xfe / 16 + 1 = 16; index 17 is past the walk.
        let giants = (0xfeu128 / 16) + 1;

        let unfinished = new_job(&mut state);
        state
            .bsgs_put(&unfinished.id, manifest.clone(), 0)
            .expect("store the resume point");
        let finished = new_job(&mut state);
        state
            .bsgs_put(&finished.id, manifest, giants as u64 + 1)
            .expect("store the final resume point");

        let status = state.status(1_100);
        let view = |id: &str| {
            status
                .jobs
                .iter()
                .find(|job| job.id == id)
                .expect("job view")
        };
        assert!(!view(&unfinished.id).done, "an early index is not a finish");
        assert!(!view(&finished.id).found);
        assert!(
            view(&finished.id).done,
            "a pass past the last index finishes"
        );
    }

    #[test]
    fn status_snapshot_has_the_documented_shape() {
        let temp = TempState::new("snapshot");
        let mut state = State::open(temp.path()).expect("open");
        let job = xpoint_job(&mut state, 5, 1, 0x1ff, 0x100);
        state
            .lease(lease_request(&job.id, "client-a", 1, 0x1ff), 1_000)
            .expect("lease")
            .expect("chunk");
        state
            .submit_result("client-a", &job.id, &Scalar::from_u64(5).to_hex())
            .expect("valid proof");

        let value: serde_json::Value =
            serde_json::to_value(state.status(1_100)).expect("status serializes");
        let object = value.as_object().expect("status object");
        for key in ["jobs", "clients", "results", "bsgs"] {
            assert!(object.contains_key(key), "status misses {key}");
        }
        let job = &value["jobs"][0];
        for key in [
            "id",
            "target",
            "targets",
            "mode",
            "coin",
            "comp_mode",
            "start",
            "end",
            "chunk_width",
            "lease_ttl",
            "created_at",
            "chunks_total",
            "chunks_done",
            "chunks_leased",
            "scanned",
            "done",
            "found",
            "found_key",
        ] {
            assert!(job.get(key).is_some(), "job view misses {key}");
        }
        let result = &value["results"][0];
        for key in ["job_id", "client_id", "key", "found_at"] {
            assert!(result.get(key).is_some(), "result view misses {key}");
        }
    }
}
