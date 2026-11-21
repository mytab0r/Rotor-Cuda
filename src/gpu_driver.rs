//! Host-side fan-out for GPU search devices.
//!
//! Kept independent of the CUDA ABI so the shared output lock, the shared
//! stop/found state and the thread driver are unit-tested without a GPU. The
//! production runner lives in [`crate::gpu_search`] and creates its engine on
//! the owning thread (CUDA device selection is per-thread).
#![cfg_attr(not(feature = "gpu"), allow(dead_code))]

use std::fs::{File, OpenOptions};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;

use crate::chain::ChainDescriptor;
use crate::checkpoint::{self, Checkpoint};
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
        coin: &'static ChainDescriptor,
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
    ///
    /// `scanned` is the live total across every device (used by random mode to
    /// notice a new `-r` epoch); runners may also update it per batch.
    fn run(&mut self, stop: &AtomicBool, scanned: &AtomicU64) -> Result<DeviceOutcome, String>;
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
    // Live total across devices: random mode checks it for a new `-r` epoch.
    let scanned_total = AtomicU64::new(0);

    thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel::<Result<DeviceOutcome, String>>();
        let mut handles = Vec::with_capacity(runners.len());
        for mut runner in runners {
            let sender = sender.clone();
            let scanned_total = &scanned_total;
            handles.push(scope.spawn(move || {
                let result = if stop.load(Ordering::SeqCst) {
                    Ok(DeviceOutcome::default())
                } else {
                    runner.run(stop, scanned_total)
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

/// One device chunk resumed from a checkpoint: shifted `[start, end]`, the
/// cumulative count already scanned by that device (`baseline`), and whether
/// the chunk still has keys left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ResumedChunk {
    pub start: Split,
    pub end: Split,
    pub baseline: u64,
    pub runnable: bool,
}

/// Reads `Rotor-Cuda_Continue.bat`; when no usable checkpoint exists, writes
/// `Rotor-Cuda_START.bat` like the CPU engine does. A zero count is ignored.
pub(crate) fn resume_checkpoint(continue_path: &Path, start_path: &Path) -> Option<Checkpoint> {
    let saved = checkpoint::read_continue(continue_path).filter(|saved| saved.count > 0);
    if saved.is_none()
        && let Err(err) = checkpoint::write_start(start_path, &checkpoint::command_line())
    {
        eprintln!("  Cannot write Rotor-Cuda_START.bat: {err}");
    }
    saved
}

/// Splits `[start, end]` into one chunk per device and shifts each chunk by its
/// saved count. The exact `threads:`/`chunks:` extension wins when it matches
/// the device count; otherwise every device gets `count / devices`. A chunk
/// whose saved count passed its end keeps its baseline (so the checkpoint
/// layout stays stable) but is marked `runnable == false`.
pub(crate) fn resumed_ranges(
    start: Split,
    end: Split,
    devices: usize,
    saved: Option<&Checkpoint>,
) -> Vec<ResumedChunk> {
    let chunks = engine::split_ranges(start, end, devices);
    let offsets = engine::resume_offsets(saved, chunks.len());
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, (low, high))| {
            let baseline = offsets[index];
            match engine::shift_chunk(low, high, baseline, end) {
                Some((start, end)) => ResumedChunk {
                    start,
                    end,
                    baseline,
                    runnable: true,
                },
                None => ResumedChunk {
                    start: low,
                    end: high,
                    baseline,
                    runnable: false,
                },
            }
        })
        .collect()
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
        fn run(
            &mut self,
            stop: &AtomicBool,
            _scanned: &AtomicU64,
        ) -> Result<DeviceOutcome, String> {
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
                    sink.write_block(
                        &key,
                        &point,
                        true,
                        crate::chain::by_id("bitcoin").expect("bitcoin descriptor"),
                    )
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

    fn split(value: u64) -> Split {
        Split::from_u64(value)
    }

    /// Raw continuation file with an explicit `threads:` line, so mismatched
    /// layouts can be tested (the writer always sets `threads = chunks.len()`).
    fn checkpoint_fixture(threads: usize, chunks: &[u64], count: u64) -> String {
        let list = chunks
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        format!(
            ":loop \nrotor.exe -g\ngoto :loop \ncreated: Sun Nov 15 19:42:03 2026\n{count}\n\
             To continue correctly, DO NOT change the parameters in this file! \n\
             If you no longer need the continuation, DELETE this file! \n\
             threads: {threads}\nchunks: {list}\n"
        )
    }

    #[test]
    fn exact_chunk_extension_shifts_each_device_range() {
        let path = temp_path("resume_exact");
        fs::write(&path, checkpoint_fixture(2, &[5, 7], 12)).expect("write fixture");
        let saved = checkpoint::read_continue(&path).expect("parse fixture");

        let ranges = resumed_ranges(split(0x1000), split(0x10FF), 2, Some(&saved));
        assert_eq!(
            ranges,
            vec![
                ResumedChunk {
                    start: split(0x1005),
                    end: split(0x1084),
                    baseline: 5,
                    runnable: true,
                },
                // The second window would end past the range end and is clipped.
                ResumedChunk {
                    start: split(0x1087),
                    end: split(0x10FF),
                    baseline: 7,
                    runnable: true,
                },
            ]
        );

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_device_past_its_chunk_end_is_skipped() {
        let path = temp_path("resume_past_end");
        fs::write(&path, checkpoint_fixture(2, &[5, 300], 305)).expect("write fixture");
        let saved = checkpoint::read_continue(&path).expect("parse fixture");

        let ranges = resumed_ranges(split(0x1000), split(0x10FF), 2, Some(&saved));
        assert_eq!(
            ranges[0],
            ResumedChunk {
                start: split(0x1005),
                end: split(0x1084),
                baseline: 5,
                runnable: true,
            }
        );
        assert!(!ranges[1].runnable, "a fully scanned device must not run");
        assert_eq!(ranges[1].baseline, 300, "the baseline must survive");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn mismatched_threads_fall_back_to_the_even_split() {
        let path = temp_path("resume_fallback");
        fs::write(&path, checkpoint_fixture(3, &[1, 2, 3], 20)).expect("write fixture");
        let saved = checkpoint::read_continue(&path).expect("parse fixture");

        let ranges = resumed_ranges(split(0x1000), split(0x10FF), 2, Some(&saved));
        assert_eq!(
            ranges,
            vec![
                ResumedChunk {
                    start: split(0x100A),
                    end: split(0x1089),
                    baseline: 10,
                    runnable: true,
                },
                ResumedChunk {
                    start: split(0x108A),
                    end: split(0x10FF),
                    baseline: 10,
                    runnable: true,
                },
            ]
        );

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn start_file_is_written_when_no_checkpoint_exists() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "rotor_gpu_checkpoint_{}_{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        let continue_path = dir.join(checkpoint::CONTINUE_FILE);
        let start_path = dir.join(checkpoint::START_FILE);

        assert!(resume_checkpoint(&continue_path, &start_path).is_none());
        let start = fs::read_to_string(&start_path).expect("START.bat was written");
        assert!(
            start.starts_with(":loop \n"),
            "unexpected START.bat: {start}"
        );
        assert!(
            start.contains("goto :loop "),
            "START.bat misses the loop: {start}"
        );

        // A zero-count checkpoint is not usable either.
        fs::write(&continue_path, checkpoint_fixture(1, &[0], 0)).expect("write fixture");
        assert!(resume_checkpoint(&continue_path, &start_path).is_none());

        // A real checkpoint is returned and START.bat is not (re)written.
        fs::remove_file(&start_path).expect("remove START.bat");
        fs::write(&continue_path, checkpoint_fixture(1, &[5], 5)).expect("write fixture");
        let saved = resume_checkpoint(&continue_path, &start_path).expect("valid checkpoint");
        assert_eq!(saved.count, 5);
        assert!(
            !start_path.exists(),
            "a valid checkpoint must not write START.bat"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
