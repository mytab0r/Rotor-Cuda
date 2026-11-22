//! Shared TronScan access policy: a global in-flight cap with a bounded wait
//! queue, a short-lived lookup cache and retry backoff.
//!
//! This module performs no I/O. `mod.rs` owns the HTTP call and asks the
//! [`Limiter`] for a slot around it, then stores the outcome in [`Cache`].
//! The orders poller shares the same limiter, so TronScan never sees more than
//! [`MAX_IN_FLIGHT`] requests from one coordinator, no matter how many public
//! lookups arrive at once.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

/// At most this many TronScan calls may be in flight at once.
pub const MAX_IN_FLIGHT: usize = 2;
/// Lookups waiting beyond this many are rejected instead of queued.
pub const QUEUE_CAPACITY: usize = 128;
/// How long a successful lookup is served from memory.
pub const SUCCESS_TTL: Duration = Duration::from_secs(60);
/// How long a provider error is remembered, so a burst of identical failures
/// costs one upstream call.
pub const ERROR_TTL: Duration = Duration::from_secs(10);
/// Upper bound on cached addresses.
pub const CACHE_CAPACITY: usize = 512;
/// Retries after a 429 or 5xx response.
pub const MAX_RETRIES: u32 = 2;
/// Base delay before retry 0 and retry 1.
const BACKOFF_MS: [u64; MAX_RETRIES as usize] = [250, 750];

struct LimiterState {
    in_flight: usize,
    waiting: usize,
    /// Calls that had to wait for a slot.
    waited: u64,
    /// Calls rejected because the wait queue was full.
    rejected: u64,
}

/// Limiter counters for the operator inventory. Process-local, reset on
/// restart, never contains request data.
#[derive(Clone, Debug, Serialize)]
pub struct LimiterStats {
    pub in_flight: usize,
    pub waiting: usize,
    pub max_in_flight: usize,
    pub queue_capacity: usize,
    pub waited: u64,
    pub rejected: u64,
}

/// Bounded concurrency gate. Each [`Slot`] represents one upstream call; the
/// slot is released on drop, waking one waiter.
pub struct Limiter {
    max_in_flight: usize,
    queue_capacity: usize,
    state: Mutex<LimiterState>,
    ready: Condvar,
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new(MAX_IN_FLIGHT, QUEUE_CAPACITY)
    }
}

impl Limiter {
    pub fn new(max_in_flight: usize, queue_capacity: usize) -> Self {
        Self {
            max_in_flight: max_in_flight.max(1),
            queue_capacity,
            state: Mutex::new(LimiterState {
                in_flight: 0,
                waiting: 0,
                waited: 0,
                rejected: 0,
            }),
            ready: Condvar::new(),
        }
    }

    /// Wait for a slot. `None` means the bounded queue is full: the caller
    /// must reject the request rather than pile more waiting work up.
    pub fn acquire(self: &Arc<Self>) -> Option<Slot> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.in_flight < self.max_in_flight {
            state.in_flight += 1;
            return Some(Slot {
                limiter: Arc::clone(self),
            });
        }
        if state.waiting >= self.queue_capacity {
            state.rejected = state.rejected.saturating_add(1);
            return None;
        }
        state.waiting += 1;
        state.waited = state.waited.saturating_add(1);
        loop {
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.in_flight < self.max_in_flight {
                state.in_flight += 1;
                state.waiting -= 1;
                return Some(Slot {
                    limiter: Arc::clone(self),
                });
            }
        }
    }

    /// Snapshot of the gate counters. Does not block on waiters.
    pub fn stats(&self) -> LimiterStats {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        LimiterStats {
            in_flight: state.in_flight,
            waiting: state.waiting,
            max_in_flight: self.max_in_flight,
            queue_capacity: self.queue_capacity,
            waited: state.waited,
            rejected: state.rejected,
        }
    }

    #[cfg(test)]
    fn in_flight(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .in_flight
    }
}

/// One in-flight upstream call. Dropping the slot frees it for the next
/// waiter (or the next caller when nobody is waiting).
pub struct Slot {
    limiter: Arc<Limiter>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut state = self
            .limiter
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.in_flight = state.in_flight.saturating_sub(1);
        drop(state);
        self.limiter.ready.notify_one();
    }
}

/// What a cache lookup found.
pub enum CacheHit {
    Success(Value),
    Error { status: u16, reason: String },
}

enum Entry {
    Success {
        value: Value,
        at: Instant,
    },
    Error {
        status: u16,
        reason: String,
        at: Instant,
    },
}

struct CacheState {
    entries: HashMap<String, Entry>,
    /// Insertion order for eviction; rebuilt only by `insert`.
    order: VecDeque<String>,
    /// Successful lookups served from memory.
    hits: u64,
    /// Lookups with no live entry (absent or expired).
    misses: u64,
    /// Lookups answered with a cached provider error.
    errors: u64,
    /// Last provider error written to the cache, for the operator inventory.
    last_error: Option<CacheErrorInfo>,
}

/// The most recent provider error class, never request data or headers.
#[derive(Clone, Debug, Serialize)]
pub struct CacheErrorInfo {
    pub status: u16,
    pub reason: String,
}

/// Cache counters for the operator inventory. Process-local.
#[derive(Clone, Debug, Serialize)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub errors: u64,
    pub entries: usize,
    pub capacity: usize,
    pub last_error: Option<CacheErrorInfo>,
}

/// Address lookup cache. Successful JSON and provider errors live apart by
/// TTL; both are keyed by chain and address.
pub struct Cache {
    success_ttl: Duration,
    error_ttl: Duration,
    capacity: usize,
    state: Mutex<CacheState>,
}

impl Default for Cache {
    fn default() -> Self {
        Self::new(SUCCESS_TTL, ERROR_TTL, CACHE_CAPACITY)
    }
}

impl Cache {
    pub fn new(success_ttl: Duration, error_ttl: Duration, capacity: usize) -> Self {
        Self {
            success_ttl,
            error_ttl,
            capacity: capacity.max(1),
            state: Mutex::new(CacheState {
                entries: HashMap::new(),
                order: VecDeque::new(),
                hits: 0,
                misses: 0,
                errors: 0,
                last_error: None,
            }),
        }
    }

    pub fn get(&self, chain: &str, address: &str) -> Option<CacheHit> {
        self.get_at(chain, address, Instant::now())
    }

    fn get_at(&self, chain: &str, address: &str, now: Instant) -> Option<CacheHit> {
        let key = cache_key(chain, address);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let hit = match state.entries.get(&key) {
            Some(Entry::Success { value, at }) if now.duration_since(*at) < self.success_ttl => {
                Some(CacheHit::Success(value.clone()))
            }
            Some(Entry::Error { status, reason, at })
                if now.duration_since(*at) < self.error_ttl =>
            {
                Some(CacheHit::Error {
                    status: *status,
                    reason: reason.clone(),
                })
            }
            Some(_) => {
                state.entries.remove(&key);
                None
            }
            None => None,
        };
        match &hit {
            Some(CacheHit::Success(_)) => state.hits = state.hits.saturating_add(1),
            Some(CacheHit::Error { .. }) => state.errors = state.errors.saturating_add(1),
            None => state.misses = state.misses.saturating_add(1),
        }
        hit
    }

    pub fn put_success(&self, chain: &str, address: &str, value: Value) {
        self.put_success_at(chain, address, value, Instant::now());
    }

    fn put_success_at(&self, chain: &str, address: &str, value: Value, at: Instant) {
        self.insert(cache_key(chain, address), Entry::Success { value, at });
    }

    pub fn put_error(&self, chain: &str, address: &str, status: u16, reason: &str) {
        self.put_error_at(chain, address, status, reason, Instant::now());
    }

    fn put_error_at(&self, chain: &str, address: &str, status: u16, reason: &str, at: Instant) {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.last_error = Some(CacheErrorInfo {
                status,
                reason: reason.to_string(),
            });
        }
        self.insert(
            cache_key(chain, address),
            Entry::Error {
                status,
                reason: reason.to_string(),
                at,
            },
        );
    }

    /// Insert and evict the least recently inserted key beyond capacity.
    fn insert(&self, key: String, entry: Entry) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.entries.insert(key.clone(), entry);
        state.order.retain(|existing| existing != &key);
        state.order.push_back(key);
        while state.entries.len() > self.capacity {
            let Some(oldest) = state.order.pop_front() else {
                break;
            };
            state.entries.remove(&oldest);
        }
    }

    /// Snapshot of the cache counters and the last provider error class.
    pub fn stats(&self) -> CacheStats {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        CacheStats {
            hits: state.hits,
            misses: state.misses,
            errors: state.errors,
            entries: state.entries.len(),
            capacity: self.capacity,
            last_error: state.last_error.clone(),
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entries
            .len()
    }
}

fn cache_key(chain: &str, address: &str) -> String {
    format!("{chain}|{address}")
}

/// Base delay before retry number `attempt` (0-based): 250 ms, then 750 ms.
pub fn backoff_base(attempt: u32) -> Duration {
    let index = (attempt as usize).min(BACKOFF_MS.len() - 1);
    Duration::from_millis(BACKOFF_MS[index])
}

/// Jittered retry delay. `fraction` in `[0, 1]` spreads the base over
/// `[0.75, 1.25]`, keeping the lowest bound non-zero.
pub fn backoff_delay(attempt: u32, fraction: f64) -> Duration {
    let base = backoff_base(attempt).as_millis() as f64;
    let spread = fraction.clamp(0.0, 1.0);
    Duration::from_millis((base * (0.75 + 0.5 * spread)).round() as u64)
}

/// Delay for the production retry path.
pub fn retry_delay(attempt: u32) -> Duration {
    backoff_delay(attempt, jitter_fraction())
}

fn jitter_fraction() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    let mixed = (nanos as u64).wrapping_mul(6_364_136_223_846_793_005);
    (mixed >> 33) as f64 / (1u64 << 31) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn limiter_caps_in_flight_and_unblocks_waiters() {
        let limiter = Arc::new(Limiter::new(2, 8));
        let first = limiter.acquire().expect("first slot");
        let second = limiter.acquire().expect("second slot");
        assert_eq!(limiter.in_flight(), 2);

        // A third caller has to wait until one slot is released.
        let waiter = {
            let limiter = Arc::clone(&limiter);
            std::thread::spawn(move || {
                let slot = limiter.acquire().expect("queued slot");
                assert_eq!(limiter.in_flight(), 2);
                drop(slot);
            })
        };
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(limiter.in_flight(), 2, "waiter must not exceed the cap");

        drop(first);
        waiter.join().expect("waiter thread");
        assert_eq!(limiter.in_flight(), 1);
        drop(second);
        assert_eq!(limiter.in_flight(), 0);
    }

    #[test]
    fn limiter_rejects_when_the_bounded_queue_is_full() {
        let limiter = Arc::new(Limiter::new(1, 1));
        let held = limiter.acquire().expect("in-flight slot");
        let queued = {
            let limiter = Arc::clone(&limiter);
            std::thread::spawn(move || limiter.acquire())
        };
        // Give the waiter time to enter the queue.
        std::thread::sleep(Duration::from_millis(30));
        assert!(
            limiter.acquire().is_none(),
            "a full queue must reject instead of waiting"
        );
        drop(held);
        assert!(queued.join().expect("queued thread").is_some());
    }

    #[test]
    fn counters_track_hits_misses_errors_and_rejections() {
        let cache = Cache::new(Duration::from_secs(60), Duration::from_secs(10), 8);
        let empty = cache.stats();
        assert_eq!((empty.hits, empty.misses, empty.errors), (0, 0, 0));
        assert!(cache.get("tron", "Tmissing").is_none());
        cache.put_success("tron", "Taddr", json!({ "balance_sun": "7" }));
        assert!(matches!(
            cache.get("tron", "Taddr"),
            Some(CacheHit::Success(_))
        ));
        cache.put_error("tron", "Tbad", 502, "provider unavailable");
        assert!(matches!(
            cache.get("tron", "Tbad"),
            Some(CacheHit::Error { status: 502, .. })
        ));
        let stats = cache.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.errors, 1);
        assert_eq!(stats.entries, 2);
        let last = stats.last_error.expect("last error class");
        assert_eq!(last.status, 502);
        assert_eq!(last.reason, "provider unavailable");

        let limiter = Arc::new(Limiter::new(1, 0));
        let slot = limiter.acquire().expect("in-flight slot");
        assert!(limiter.acquire().is_none());
        let stats = limiter.stats();
        assert_eq!(stats.in_flight, 1);
        assert_eq!(stats.rejected, 1);
        assert_eq!(stats.max_in_flight, 1);
        drop(slot);
        assert_eq!(limiter.stats().in_flight, 0);
    }

    #[test]
    fn cache_serves_success_until_its_ttl_expires() {
        let cache = Cache::new(Duration::from_secs(60), Duration::from_secs(10), 8);
        let now = Instant::now();
        cache.put_success_at("tron", "Taddr", json!({ "balance_sun": "7" }), now);
        match cache.get_at("tron", "Taddr", now) {
            Some(CacheHit::Success(value)) => assert_eq!(value["balance_sun"], "7"),
            _ => panic!("fresh success must hit"),
        }
        assert!(
            cache
                .get_at("tron", "Taddr", now + Duration::from_secs(60))
                .is_none(),
            "success expires at the TTL"
        );
        // The expired entry was dropped, so a different chain misses too.
        assert!(cache.get_at("tron", "Tother", now).is_none());
    }

    #[test]
    fn cache_remembers_provider_errors_for_ten_seconds() {
        let cache = Cache::new(Duration::from_secs(60), Duration::from_secs(10), 8);
        let now = Instant::now();
        cache.put_error_at("tron", "Taddr", 503, "provider rate limited", now);
        match cache.get_at("tron", "Taddr", now + Duration::from_secs(9)) {
            Some(CacheHit::Error { status, reason }) => {
                assert_eq!(status, 503);
                assert_eq!(reason, "provider rate limited");
            }
            _ => panic!("error must be cached for 10 s"),
        }
        assert!(
            cache
                .get_at("tron", "Taddr", now + Duration::from_secs(10))
                .is_none(),
            "error expires at its own TTL"
        );
    }

    #[test]
    fn cache_evicts_the_oldest_entry_at_capacity() {
        let cache = Cache::new(SUCCESS_TTL, ERROR_TTL, 2);
        let now = Instant::now();
        cache.put_success_at("tron", "Tone", json!(1), now);
        cache.put_success_at("tron", "Ttwo", json!(2), now);
        cache.put_success_at("tron", "Tthree", json!(3), now);
        assert_eq!(cache.len(), 2);
        assert!(cache.get_at("tron", "Tone", now).is_none());
        assert!(cache.get_at("tron", "Ttwo", now).is_some());
        assert!(cache.get_at("tron", "Tthree", now).is_some());
    }

    #[test]
    fn backoff_follows_250_then_750_ms_with_bounded_jitter() {
        assert_eq!(backoff_base(0), Duration::from_millis(250));
        assert_eq!(backoff_base(1), Duration::from_millis(750));
        assert_eq!(backoff_base(2), Duration::from_millis(750));

        let low = backoff_delay(0, 0.0).as_millis();
        let high = backoff_delay(0, 1.0).as_millis();
        assert!((187..=188).contains(&low), "low jitter was {low}");
        assert!((312..=313).contains(&high), "high jitter was {high}");
        let low = backoff_delay(1, 0.0).as_millis();
        let high = backoff_delay(1, 1.0).as_millis();
        assert!((562..=563).contains(&low), "low jitter was {low}");
        assert!((937..=938).contains(&high), "high jitter was {high}");
        for attempt in 0..MAX_RETRIES {
            let delay = retry_delay(attempt);
            assert!(delay >= backoff_delay(attempt, 0.0));
            assert!(delay <= backoff_delay(attempt, 1.0));
        }
    }
}
