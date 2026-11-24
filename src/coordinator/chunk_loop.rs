//! Generic coordinator chunk loop for scanners that cannot use CPU workers.
//!
//! Mirrors the desktop engine's `run_coordinator`: lease a chunk, scan it,
//! refresh the lease, submit a found key and re-lease until the job is done. The CPU
//! coordinator path keeps its parallel workers; this loop exists for a backend
//! that owns its whole device and scans one window at a time (the GPU).
//!
//! A scan is synchronous, so heartbeats happen between chunks and at the end of
//! each chunk; a chunk scan longer than the lease TTL cannot be refreshed while
//! it runs, so its lease may expire and the chunk may be handed to another
//! client (keep the chunk width below `lease_ttl * device rate`). A heartbeat
//! that is lost because the job is already found/done is a normal stop; a lost
//! lease on a still-active job aborts. `No CPU fallback`: every coordinator or
//! proof error aborts the run.

use std::thread;
use std::time::{Duration, Instant};

use crate::coordinator::client::{CoordinatorClient, JobInfo, Lease};
use crate::coordinator::state::challenge_samples;
use rotor_core::scalar::Scalar;
use rotor_search::stop;

/// Keys covered by one scan and the first key it found, if any.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanOutcome {
    pub scanned: u64,
    pub found: Option<Scalar>,
}

/// A backend that scans one inclusive `[start, end]` key window.
///
/// The scanner must stop at the next batch boundary when
/// [`stop::requested`] becomes true.
pub trait ChunkScanner {
    fn scan(&mut self, start: &Scalar, end: &Scalar) -> Result<ScanOutcome, String>;

    /// Called with the lease before its scan, so a scanner that submits a key
    /// itself can echo the lease nonce.
    fn on_lease(&mut self, _lease: &Lease) {}
}

/// The job fields `POST /api/v1/lease` matches on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseJob {
    pub mode: String,
    pub coin: String,
    /// Compression accepted by the job (`compressed`, `uncompressed`, `both`).
    pub comp_mode: String,
    /// Single-target modes pass the operand so the server can match the job;
    /// multi-target modes leave it `None`.
    pub target: Option<String>,
    pub start: String,
    pub end: String,
}

/// How long a client waits when the job exists but every chunk is leased.
const RETRY_DELAY: Duration = Duration::from_secs(2);
/// Minimum spacing between progress heartbeats (a chunk's final heartbeat is
/// always sent).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

/// Leases and scans chunks until the job is found/done, Ctrl-C is pressed, or
/// a coordinator/proof error occurs.
///
/// Returns the total number of keys scanned and the submitted key, if the
/// scanner found one. A `204` lease (job done) ends the loop normally.
pub fn run_leases(
    client: &CoordinatorClient,
    job: &LeaseJob,
    scanner: &mut dyn ChunkScanner,
) -> Result<(u64, Option<Scalar>), String> {
    let mut total_scanned = 0u64;

    loop {
        if stop::requested() {
            break;
        }

        let lease = match client.lease(
            None,
            job.target.as_deref(),
            &job.mode,
            &job.coin,
            &job.start,
            &job.end,
        ) {
            Ok(Some(lease)) => lease,
            Ok(None) => {
                if job_is_finished(client, job)? {
                    break;
                }
                // The job exists but every chunk is leased or in flight.
                thread::sleep(RETRY_DELAY);
                continue;
            }
            Err(err) => return Err(format!("coordinator lease failed: {err}")),
        };

        let (Some(start), Some(end)) =
            (Scalar::from_hex(&lease.start), Scalar::from_hex(&lease.end))
        else {
            return Err("coordinator lease returned a range outside the curve order".to_owned());
        };
        if end < start {
            return Err("coordinator lease returned END below START".to_owned());
        }

        let started = Instant::now();
        scanner.on_lease(&lease);
        let outcome = scanner.scan(&start, &end)?;
        total_scanned = total_scanned.saturating_add(outcome.scanned);
        let rate = outcome.scanned as f64 / started.elapsed().as_secs_f64().max(1e-9);

        if let Some(key) = outcome.found {
            client
                .submit_result(&lease.job_id, lease.lease_id, &key.to_hex())
                .map_err(|err| format!("coordinator rejected the found key: {err}"))?;
            return Ok((total_scanned, Some(key)));
        }

        // Ctrl-C abandons a partially scanned chunk; it must not be marked done.
        if stop::requested() {
            break;
        }

        if started.elapsed() >= HEARTBEAT_INTERVAL
            && !heartbeat(
                client,
                job,
                &lease.job_id,
                lease.chunk_index,
                lease.lease_id,
                outcome.scanned,
                rate,
                false,
                &[],
            )?
        {
            break;
        }
        // Completion proves the chunk window: hash the keys at the lease's
        // challenge offsets (BSGS leases have no key window and are exempt).
        let samples = if job.mode == "bsgs" {
            Vec::new()
        } else {
            challenge_samples(
                &job.mode,
                &job.coin,
                &job.comp_mode,
                &start,
                &lease.challenge_offsets,
            )
            .map_err(|err| format!("cannot build completion samples: {err}"))?
        };
        if !heartbeat(
            client,
            job,
            &lease.job_id,
            lease.chunk_index,
            lease.lease_id,
            outcome.scanned,
            rate,
            true,
            &samples,
        )? {
            break;
        }
    }

    Ok((total_scanned, None))
}

/// Sends one heartbeat and classifies its failure.
///
/// Returns `Ok(true)` when the lease was refreshed, `Ok(false)` when it was
/// lost because the job is already found/done (a normal stop), and an error
/// when the job is still active or its state cannot be read.
// The signature mirrors [`CoordinatorClient::heartbeat`].
#[allow(clippy::too_many_arguments)]
fn heartbeat(
    client: &CoordinatorClient,
    job: &LeaseJob,
    job_id: &str,
    chunk_index: u64,
    lease_id: u64,
    scanned: u64,
    rate: f64,
    done: bool,
    samples: &[Vec<u8>],
) -> Result<bool, String> {
    match client.heartbeat(job_id, chunk_index, lease_id, scanned, rate, done, samples) {
        Ok(_) => Ok(true),
        Err(err) => {
            if job_is_finished(client, job)? {
                Ok(false)
            } else {
                Err(format!("coordinator heartbeat failed (lease lost?): {err}"))
            }
        }
    }
}

/// True when the matching job is found/done; errors when no job matches.
fn job_is_finished(client: &CoordinatorClient, job: &LeaseJob) -> Result<bool, String> {
    let jobs = client
        .jobs()
        .map_err(|err| format!("coordinator jobs query failed: {err}"))?;
    match jobs.iter().find(|entry| job_matches(entry, job)) {
        Some(entry) => Ok(entry.found || entry.done),
        None => Err("no matching coordinator job; create it first".to_owned()),
    }
}

fn job_matches(entry: &JobInfo, job: &LeaseJob) -> bool {
    entry.mode == job.mode
        && entry.coin == job.coin
        && same_hex(&entry.start, &job.start)
        && same_hex(&entry.end, &job.end)
        && match job.target.as_deref() {
            Some(wanted) => {
                target_matches(&job.mode, &job.coin, entry.target.as_deref(), wanted)
                    || entry
                        .targets
                        .iter()
                        .any(|known| target_matches(&job.mode, &job.coin, Some(known), wanted))
            }
            None => true,
        }
}

fn same_hex(stored: &str, wanted: &str) -> bool {
    match (Scalar::from_hex(stored), Scalar::from_hex(wanted)) {
        (Some(stored), Some(wanted)) => stored == wanted,
        _ => stored.trim().eq_ignore_ascii_case(wanted.trim()),
    }
}

/// Compares a job target with the requested one, canonicalizing hex forms
/// (the server stores X coordinates and ETH addresses as padded lowercase hex).
fn target_matches(mode: &str, coin: &str, stored: Option<&str>, wanted: &str) -> bool {
    let Some(stored) = stored else {
        return false;
    };
    match (mode, coin) {
        ("xpoint", _) | ("address", "eth") => normalize_hex(stored) == normalize_hex(wanted),
        _ => stored.trim() == wanted.trim(),
    }
}

fn normalize_hex(text: &str) -> String {
    let text = text.trim();
    let text = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    let text = text.trim_start_matches('0');
    if text.is_empty() {
        "0".to_owned()
    } else {
        text.to_ascii_lowercase()
    }
}
