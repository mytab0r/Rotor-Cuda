//! Host-side fan-out for GPU search devices.
//!
//! Kept independent of the CUDA ABI so the shared output lock, the shared
//! stop/found state and the thread driver are unit-tested without a GPU. The
//! production runner lives in [`crate::gpu_search`] and creates its engine on
//! the owning thread (CUDA device selection is per-thread).
#![cfg_attr(not(feature = "gpu"), allow(dead_code))]

use std::fs::{File, OpenOptions};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;

use crate::cli::Coin;
use crate::engine::{self, Split};
use crate::point::Affine;
use crate::scalar::Scalar;

const LOCK_ERROR: &str = "output file lock poisoned";

/// Serialized hit output.
///
/// Every device writes through this sink. Hit blocks (file and console) and
/// progress lines take the same mutex, so concurrent devices can never
/// interleave their lines or bytes.
pub struct OutputSink {
    file: Mutex<File>,
}

impl OutputSink {
    /// Opens `path` for appending, creating it when missing (the C++ default).
    pub fn open(path: &str) -> Result<Self, String> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| format!("failed to open {path} for writing: {err}"))?;
        Ok(Self {
            file: Mutex::new(file),
        })
    }

    /// Writes one C++ hit block (and its console copy) under the lock.
    pub fn write_block(
        &self,
        key: &Scalar,
        point: &Affine,
        compressed: bool,
        coin: Coin,
    ) -> Result<(), String> {
        let mut file = self.file.lock().map_err(|_| LOCK_ERROR.to_owned())?;
        engine::emit_hit(&mut file, key, point, compressed, coin)
            .map_err(|err| format!("failed to write the output file: {err}"))
    }

    /// Runs `write` with the file lock held so a progress line cannot interleave
    /// with a hit block from another device.
    pub fn progress(&self, write: impl FnOnce()) -> Result<(), String> {
        let _guard = self.file.lock().map_err(|_| LOCK_ERROR.to_owned())?;
        write();
        Ok(())
    }
}

/// One device's slice of the requested range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceJob {
    pub device_id: i32,
    pub start: Split,
    pub end: Split,
}

/// What one device runner scanned and how many keys it published.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeviceOutcome {
    pub scanned: u64,
    /// Hits for the driver to add to the shared counter.
    ///
    /// Runners that update the shared counter while scanning (the GPU runner,
    /// so a hit can stop the other devices at their next batch) report `0`
    /// here. Stub/independent runners report their hits and let [`drive`]
    /// count them.
    pub found: u64,
}

/// A device scan driven by [`drive`].
pub trait DeviceRunner: Send {
    /// Scans until the slice is exhausted, `stop` is set, or an error occurs.
    fn run(&mut self, stop: &AtomicBool) -> Result<DeviceOutcome, String>;
}

/// Runs one thread per device, joins all of them and sums the scanned keys.
///
/// The first error sets `stop` (the other devices finish their current batch
/// and exit) and is returned after all threads join. A runner's reported hits
/// are added to `found` as soon as its outcome arrives; reaching `stop_after`
/// sets `stop` too.
pub fn drive(
    runners: Vec<Box<dyn DeviceRunner>>,
    stop: &AtomicBool,
    found: &AtomicU64,
    stop_after: u64,
) -> Result<u64, String> {
    let mut scanned = 0u64;
    let mut first_error: Option<String> = None;

    thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel::<Result<DeviceOutcome, String>>();
        let mut handles = Vec::with_capacity(runners.len());
        for mut runner in runners {
            let sender = sender.clone();
            handles.push(scope.spawn(move || {
                let result = if stop.load(Ordering::SeqCst) {
                    Ok(DeviceOutcome::default())
                } else {
                    runner.run(stop)
                };
                let _ = sender.send(result);
            }));
        }
        drop(sender);

        for result in receiver {
            match result {
                Ok(outcome) => {
                    scanned = scanned.saturating_add(outcome.scanned);
                    if outcome.found > 0 {
                        let total =
                            found.fetch_add(outcome.found, Ordering::SeqCst) + outcome.found;
                        if total >= stop_after {
                            stop.store(true, Ordering::SeqCst);
                        }
                    }
                }
                Err(err) => {
                    stop.store(true, Ordering::SeqCst);
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                }
            }
        }

        for handle in handles {
            if handle.join().is_err() {
                stop.store(true, Ordering::SeqCst);
                if first_error.is_none() {
                    first_error = Some("GPU worker thread panicked".to_owned());
                }
            }
        }
    });

    match first_error {
        Some(err) => Err(err),
        None => Ok(scanned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::Barrier;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    /// A runner with a fixed outcome that can optionally wait for `stop`.
    struct StubRunner {
        scanned: u64,
        found: u64,
        error: Option<&'static str>,
        wait_for_stop: bool,
        runs: Option<Arc<AtomicUsize>>,
        barrier: Option<Arc<Barrier>>,
    }

    impl StubRunner {
        fn new(scanned: u64, found: u64) -> Self {
            Self {
                scanned,
                found,
                error: None,
                wait_for_stop: false,
                runs: None,
                barrier: None,
            }
        }

        fn waiting(scanned: u64, found: u64) -> Self {
            Self {
                wait_for_stop: true,
                ..Self::new(scanned, found)
            }
        }

        fn failing(error: &'static str) -> Self {
            Self {
                error: Some(error),
                ..Self::new(0, 0)
            }
        }

        /// Makes sure every runner entered `run` before any outcome is sent.
        fn at(mut self, barrier: &Arc<Barrier>) -> Self {
            self.barrier = Some(Arc::clone(barrier));
            self
        }
    }

    impl DeviceRunner for StubRunner {
        fn run(&mut self, stop: &AtomicBool) -> Result<DeviceOutcome, String> {
            if let Some(runs) = &self.runs {
                runs.fetch_add(1, Ordering::SeqCst);
            }
            if let Some(barrier) = &self.barrier {
                barrier.wait();
            }
            if let Some(error) = self.error {
                return Err(error.to_owned());
            }
            if self.wait_for_stop {
                let started = Instant::now();
                while !stop.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(5) {
                    thread::sleep(Duration::from_millis(1));
                }
            }
            Ok(DeviceOutcome {
                scanned: self.scanned,
                found: self.found,
            })
        }
    }

    fn runner(runner: StubRunner) -> Box<dyn DeviceRunner> {
        Box::new(runner)
    }

    #[test]
    fn scanned_counts_sum_across_runners() {
        let stop = AtomicBool::new(false);
        let found = AtomicU64::new(0);
        let scanned = drive(
            vec![
                runner(StubRunner::new(10, 0)),
                runner(StubRunner::new(25, 0)),
            ],
            &stop,
            &found,
            5,
        )
        .expect("no runner failed");
        assert_eq!(scanned, 35);
        assert_eq!(found.load(Ordering::SeqCst), 0);
        assert!(!stop.load(Ordering::SeqCst));
    }

    #[test]
    fn a_found_key_stops_the_other_runner() {
        let stop = AtomicBool::new(false);
        let found = AtomicU64::new(0);
        let barrier = Arc::new(Barrier::new(2));
        let started = Instant::now();
        let scanned = drive(
            vec![
                runner(StubRunner::new(1, 1).at(&barrier)),
                runner(StubRunner::waiting(2, 0).at(&barrier)),
            ],
            &stop,
            &found,
            1,
        )
        .expect("no runner failed");
        assert_eq!(scanned, 3);
        assert_eq!(found.load(Ordering::SeqCst), 1);
        assert!(stop.load(Ordering::SeqCst), "stop must be set after a hit");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the waiting runner must observe the shared stop"
        );
    }

    #[test]
    fn an_error_aborts_the_other_runner() {
        let stop = AtomicBool::new(false);
        let found = AtomicU64::new(0);
        let barrier = Arc::new(Barrier::new(2));
        let started = Instant::now();
        let err = drive(
            vec![
                runner(StubRunner::failing("device exploded").at(&barrier)),
                runner(StubRunner::waiting(2, 0).at(&barrier)),
            ],
            &stop,
            &found,
            1,
        )
        .expect_err("the error must be returned");
        assert!(err.contains("device exploded"), "unexpected error: {err}");
        assert!(stop.load(Ordering::SeqCst), "stop must abort the others");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the waiting runner must observe the shared stop"
        );
    }

    #[test]
    fn stop_after_uses_the_summed_hit_count() {
        let stop = AtomicBool::new(false);
        let found = AtomicU64::new(0);
        let scanned = drive(
            vec![runner(StubRunner::new(1, 2)), runner(StubRunner::new(1, 2))],
            &stop,
            &found,
            4,
        )
        .expect("no runner failed");
        assert_eq!(scanned, 2);
        assert_eq!(found.load(Ordering::SeqCst), 4);
        assert!(stop.load(Ordering::SeqCst));

        // One hit below the threshold does not stop anything.
        let stop = AtomicBool::new(false);
        let found = AtomicU64::new(0);
        drive(vec![runner(StubRunner::new(1, 2))], &stop, &found, 4).expect("no runner failed");
        assert_eq!(found.load(Ordering::SeqCst), 2);
        assert!(!stop.load(Ordering::SeqCst));
    }

    #[test]
    fn an_already_stopped_run_starts_no_runner() {
        let stop = AtomicBool::new(true);
        let found = AtomicU64::new(0);
        let runs = Arc::new(AtomicUsize::new(0));
        let mut first = StubRunner::new(1, 0);
        first.runs = Some(Arc::clone(&runs));
        let mut second = StubRunner::new(1, 0);
        second.runs = Some(Arc::clone(&runs));
        let scanned =
            drive(vec![runner(first), runner(second)], &stop, &found, 1).expect("no runner failed");
        assert_eq!(scanned, 0);
        assert_eq!(runs.load(Ordering::SeqCst), 0);
    }

    fn temp_path(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "rotor_gpu_sink_{tag}_{}_{nanos}.txt",
            std::process::id()
        ))
    }

    #[test]
    fn concurrent_blocks_never_interleave() {
        const THREADS: usize = 4;
        const BLOCKS: usize = 10;

        let path = temp_path("blocks");
        let sink =
            Arc::new(OutputSink::open(path.to_str().expect("utf-8 temp path")).expect("sink"));
        let mut handles = Vec::new();
        for thread_index in 0..THREADS {
            let sink = Arc::clone(&sink);
            handles.push(thread::spawn(move || {
                for block in 0..BLOCKS {
                    let key = Scalar::from_u64(0x1000 + (thread_index * BLOCKS + block) as u64);
                    let point = crate::secp::mul_g(&key);
                    sink.write_block(&key, &point, true, Coin::Btc)
                        .expect("block write");
                }
            }));
        }
        for handle in handles {
            handle.join().expect("writer thread");
        }

        let text = fs::read_to_string(&path).expect("read output");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), THREADS * BLOCKS * 5, "every block is complete");
        let separator = "=".repeat(86);
        let (blocks, remainder) = lines.as_chunks::<5>();
        assert!(
            remainder.is_empty(),
            "a partial block remained: {remainder:?}"
        );
        for (index, block) in blocks.iter().enumerate() {
            assert!(block[0].starts_with("PubAddress: "), "block {index}");
            assert!(block[1].starts_with("Priv (WIF): "), "block {index}");
            assert!(block[2].starts_with("Priv (HEX): "), "block {index}");
            assert!(block[3].starts_with("PubK (HEX): "), "block {index}");
            assert_eq!(block[4], separator, "block {index} terminator");
        }
        let mut keys: Vec<&str> = lines
            .iter()
            .filter_map(|line| line.strip_prefix("Priv (HEX): "))
            .collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), THREADS * BLOCKS, "no block was lost");

        let _ = fs::remove_file(&path);
    }
}
