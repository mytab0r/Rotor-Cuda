//! Independent persistence for the address monitor.
//!
//! The store owns its own mutex and its own JSON file so that the monitor's
//! higher-frequency writes never rewrite the coordinator state file. Every
//! mutation rewrites the file atomically (`<path>.tmp` then rename).

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::coordinator::state::now_secs;
use crate::hashes::sha256;

/// On-disk schema version (refuse to guess at a future format).
pub const STORE_VERSION: u32 = 1;
/// Hard per-account watch limit for the MVP.
pub const MAX_WATCHES_PER_USER: usize = 50;
/// How long an identical event is suppressed, in seconds.
pub const EVENT_DEDUPE_WINDOW_SECS: u64 = 60;
/// Bearer session lifetime: 30 days.
pub const SESSION_TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// Telegram linking code lifetime: 10 minutes.
pub const LINK_CODE_TTL_SECS: u64 = 10 * 60;
/// Events older than this are dropped on the next write.
const EVENT_RETENTION_SECS: u64 = 90 * 24 * 60 * 60;
/// Upper bound on retained events, newest kept.
const MAX_EVENTS: usize = 5000;
/// Maximum retained error text in the watcher health record.
const MAX_ERROR_LEN: usize = 300;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Data {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    users: HashMap<String, User>,
    #[serde(default)]
    challenges: HashMap<String, Challenge>,
    #[serde(default)]
    sessions: HashMap<String, Session>,
    #[serde(default)]
    watches: Vec<Watch>,
    #[serde(default)]
    events: Vec<Event>,
    #[serde(default = "default_next_event_id")]
    next_event_id: u64,
    #[serde(default)]
    watcher: WatcherHealth,
    /// Single-use Telegram linking codes, keyed by code.
    #[serde(default)]
    telegram_links: HashMap<String, LinkCode>,
    /// Secret expected in `X-Telegram-Bot-Api-Secret-Token`; generated once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    telegram_webhook_secret: Option<String>,
    /// Highest event id already considered by the delivery worker, per user.
    /// Kept out of the user record so `/me` does not expose internal state.
    #[serde(default)]
    telegram_cursors: HashMap<String, u64>,
}

/// A single-use code that binds a Telegram chat to one account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LinkCode {
    pub code: String,
    pub user_id: String,
    pub expires_at: u64,
}

fn default_version() -> u32 {
    STORE_VERSION
}

fn default_next_event_id() -> u64 {
    1
}

fn default_true() -> bool {
    true
}

/// Per-account notification settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    #[serde(default)]
    pub recovery_opt_in: bool,
    #[serde(default = "default_true")]
    pub alerts_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            recovery_opt_in: false,
            alerts_enabled: true,
        }
    }
}

/// One login identity proven for an account. `address` on the user is the
/// primary identity (the first one added).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
    pub chain: String,
    pub address: String,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub added_at: u64,
}

/// A monitor account. It is separate from the coordinator's `ClientRecord`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    /// Primary identity address (the first identity created for the user).
    pub address: String,
    pub created_at: u64,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub identities: Vec<Identity>,
    /// Bound Telegram chat, when the account linked one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram_chat_id: Option<i64>,
    /// When the chat was linked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram_linked_at: Option<u64>,
}

/// A single-use SIWE challenge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Challenge {
    pub nonce: String,
    #[serde(default = "default_chain")]
    pub chain: String,
    pub address: String,
    pub message: String,
    pub expires_at: u64,
}

fn default_chain() -> String {
    "evm".to_string()
}

/// A bearer session. Only the SHA-256 of the token is persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub token_hash: String,
    pub user_id: String,
    pub created_at: u64,
}

/// One mempool.space stats block (chain or mempool).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BtcStats {
    pub funded_txo_sum: u64,
    pub spent_txo_sum: u64,
    pub tx_count: u64,
}

/// The last successful Bitcoin observation for one watch.
///
/// Keeping the full snapshot (not only the net balance) is what makes the
/// classifier restart-safe: a process restart can no longer re-emit an event
/// for stats that were already reported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BtcSnapshot {
    pub chain: BtcStats,
    pub mempool: BtcStats,
}

impl BtcSnapshot {
    /// Spendable balance in satoshis: confirmed plus mempool deltas.
    pub fn balance(&self) -> i64 {
        let received = self
            .chain
            .funded_txo_sum
            .saturating_add(self.mempool.funded_txo_sum);
        let spent = self
            .chain
            .spent_txo_sum
            .saturating_add(self.mempool.spent_txo_sum);
        sat_to_i64(received).saturating_sub(sat_to_i64(spent))
    }
}

fn sat_to_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

/// A watched address and its last observed counters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Watch {
    pub user_id: String,
    pub chain: String,
    pub address: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub verified: bool,
    /// Last observed balance as a normalized `0x` quantity (EVM) or decimal
    /// satoshis (BTC).
    #[serde(default)]
    pub last_balance: Option<String>,
    /// Last observed transaction count (EVM only).
    #[serde(default)]
    pub last_nonce: Option<u64>,
    #[serde(default)]
    pub last_seen_at: Option<u64>,
    /// Last Bitcoin stats snapshot (BTC only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub btc: Option<BtcSnapshot>,
}

/// A feed entry for one user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: u64,
    pub user_id: String,
    pub chain: String,
    pub address: String,
    pub kind: String,
    pub severity: String,
    pub detail: String,
    pub at: u64,
    #[serde(default)]
    pub seen: bool,
}

/// Watcher liveness, kept in the same file so a restart does not look healthy
/// after a failure.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WatcherHealth {
    #[serde(default)]
    last_ok_at: u64,
    #[serde(default)]
    last_error_at: u64,
    #[serde(default)]
    last_error: String,
}

/// New watch requested over the API.
#[derive(Debug, Clone)]
pub struct NewWatch {
    pub chain: String,
    pub address: String,
    pub label: Option<String>,
    pub verified: bool,
}

/// One EVM observation produced by the watcher.
#[derive(Debug, Clone)]
pub struct Observation {
    pub address: String,
    /// Normalized `0x` balance quantity.
    pub balance: String,
    pub nonce: u64,
}

/// One BTC observation produced by the watcher.
#[derive(Debug, Clone)]
pub struct BtcObservation {
    pub address: String,
    pub chain: BtcStats,
    pub mempool: BtcStats,
}

impl BtcObservation {
    fn snapshot(&self) -> BtcSnapshot {
        BtcSnapshot {
            chain: self.chain,
            mempool: self.mempool,
        }
    }
}

/// The `/me` cabinet snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct MeView {
    pub user: User,
    pub settings: Settings,
    pub watches: Vec<Watch>,
    pub events: Vec<Event>,
}

/// Read-only admin projection of one monitor account in a list. Bearer
/// session token hashes and Telegram link codes are never part of it.
#[derive(Debug, Clone, Serialize)]
pub struct AdminUserSummary {
    pub id: String,
    pub address: String,
    pub created_at: u64,
    pub settings: Settings,
    pub identities: usize,
    pub watches: usize,
    /// Unexpired bearer sessions.
    pub sessions: usize,
    pub last_session_at: Option<u64>,
    pub last_event_at: Option<u64>,
    /// Newest of the last session and the last event, as a cheap activity
    /// signal. The store keeps no per-request timestamp.
    pub last_seen_at: Option<u64>,
    pub telegram_linked: bool,
    pub telegram_linked_at: Option<u64>,
}

/// One account's admin detail. `events` is a bounded tail, newest last.
#[derive(Debug, Clone, Serialize)]
pub struct AdminUserDetail {
    pub id: String,
    pub address: String,
    pub created_at: u64,
    pub settings: Settings,
    pub identities: Vec<Identity>,
    pub watches: usize,
    pub sessions: usize,
    pub last_seen_at: Option<u64>,
    pub telegram: AdminTelegramLink,
    pub events: Vec<Event>,
}

/// The Telegram binding of one account. The chat id is account metadata, not
/// a credential; no link code or webhook secret appears here.
#[derive(Debug, Clone, Serialize)]
pub struct AdminTelegramLink {
    pub linked: bool,
    pub chat_id: Option<i64>,
    pub linked_at: Option<u64>,
}

/// One event waiting for Telegram delivery.
#[derive(Debug, Clone)]
pub struct Alert {
    pub event: Event,
    pub chat_id: i64,
}

/// Monitor data with its own lock and file.
pub struct MonitorStore {
    path: PathBuf,
    data: Mutex<Data>,
}

impl MonitorStore {
    /// Open (or create) the monitor store at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
            && !parent.is_dir()
        {
            return Err(format!(
                "monitor state directory does not exist: {}",
                parent.display()
            ));
        }
        let mut data = match fs::read(&path) {
            Ok(bytes) => {
                let data: Data = serde_json::from_slice(&bytes)
                    .map_err(|err| format!("cannot parse {}: {err}", path.display()))?;
                if data.version != STORE_VERSION {
                    return Err(format!(
                        "{}: unsupported monitor state version {}; this build expects version {STORE_VERSION}",
                        path.display(),
                        data.version
                    ));
                }
                data
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Data {
                version: STORE_VERSION,
                next_event_id: default_next_event_id(),
                ..Data::default()
            },
            Err(err) => return Err(format!("cannot read {}: {err}", path.display())),
        };
        let migrated = migrate_identities(&mut data);
        let store = Self {
            path,
            data: Mutex::new(data),
        };
        if migrated {
            let mut data = store.lock();
            store.save_locked(&mut data)?;
        }
        Ok(store)
    }

    fn lock(&self) -> MutexGuard<'_, Data> {
        self.data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Atomically rewrite the store file (`tmp` + rename). Expired challenges
    /// and sessions are pruned here so the file cannot grow forever.
    fn save_locked(&self, data: &mut Data) -> Result<(), String> {
        let now = now_secs();
        data.challenges
            .retain(|_, challenge| challenge.expires_at > now);
        data.sessions
            .retain(|_, session| now.saturating_sub(session.created_at) <= SESSION_TTL_SECS);
        data.telegram_links.retain(|_, link| link.expires_at > now);
        let json = serde_json::to_vec_pretty(data)
            .map_err(|err| format!("cannot serialize monitor state: {err}"))?;
        let mut tmp = self.path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, json).map_err(|err| format!("cannot write {}: {err}", tmp.display()))?;
        fs::rename(&tmp, &self.path)
            .map_err(|err| format!("cannot replace {}: {err}", self.path.display()))
    }

    /// Find a user by wallet address or create one (EVM convenience wrapper).
    pub fn upsert_user(&self, address: &str) -> Result<User, String> {
        self.upsert_identity("evm", address)
    }

    /// Find a user by `(chain, address)` or create one whose primary identity
    /// is that address.
    pub fn upsert_identity(&self, chain: &str, address: &str) -> Result<User, String> {
        let (chain, address) = canonicalize_address(chain, address)?;
        let mut data = self.lock();
        if let Some(user) = find_identity(&data, &chain, &address) {
            return Ok(user.clone());
        }
        let now = now_secs();
        let user = User {
            id: format!("u_{}", random_hex(8)?),
            address: address.clone(),
            created_at: now,
            settings: Settings::default(),
            identities: vec![Identity {
                chain,
                address,
                verified: true,
                added_at: now,
            }],
            telegram_chat_id: None,
            telegram_linked_at: None,
        };
        data.users.insert(user.id.clone(), user.clone());
        self.save_locked(&mut data)?;
        Ok(user)
    }

    /// Resolve the account that already owns `(chain, address)`.
    pub fn find_user_by_identity(&self, chain: &str, address: &str) -> Option<User> {
        let (chain, address) = canonicalize_address(chain, address).ok()?;
        let data = self.lock();
        find_identity(&data, &chain, &address).cloned()
    }

    /// Attach a verified identity to an existing account. Returns the updated
    /// user, or `None` when the account does not exist. An identity already
    /// owned by a different account is rejected instead of silently merging.
    pub fn add_identity(
        &self,
        user_id: &str,
        chain: &str,
        address: &str,
        verified: bool,
    ) -> Result<Option<User>, String> {
        let (chain, address) = canonicalize_address(chain, address)?;
        let mut data = self.lock();
        if let Some(owner) = find_identity(&data, &chain, &address) {
            if owner.id != user_id {
                return Err("address is already linked to another account".to_string());
            }
            return Ok(Some(owner.clone()));
        }
        let Some(user) = data.users.get_mut(user_id) else {
            return Ok(None);
        };
        user.identities.push(Identity {
            chain,
            address,
            verified,
            added_at: now_secs(),
        });
        let user = user.clone();
        self.save_locked(&mut data)?;
        Ok(Some(user))
    }

    /// Generate an opaque challenge nonce (16 random bytes, hex).
    pub fn new_nonce(&self) -> Result<String, String> {
        random_hex(16)
    }

    /// Store a challenge, dropping expired ones first.
    pub fn put_challenge(
        &self,
        nonce: &str,
        chain: &str,
        address: &str,
        message: &str,
        expires_at: u64,
    ) -> Result<(), String> {
        let now = now_secs();
        let mut data = self.lock();
        data.challenges
            .retain(|_, challenge| challenge.expires_at > now);
        data.challenges.insert(
            nonce.to_string(),
            Challenge {
                nonce: nonce.to_string(),
                chain: chain.to_string(),
                address: address.to_string(),
                message: message.to_string(),
                expires_at,
            },
        );
        self.save_locked(&mut data)
    }

    /// Look up a challenge without consuming it.
    pub fn challenge(&self, nonce: &str) -> Option<Challenge> {
        let data = self.lock();
        data.challenges.get(nonce).cloned()
    }

    /// Remove and return a challenge after successful verification.
    pub fn consume_challenge(&self, nonce: &str) -> Result<Option<Challenge>, String> {
        let mut data = self.lock();
        let Some(challenge) = data.challenges.remove(nonce) else {
            return Ok(None);
        };
        self.save_locked(&mut data)?;
        Ok(Some(challenge))
    }

    /// Create a session and return the plaintext token once.
    pub fn create_session(&self, user_id: &str) -> Result<String, String> {
        let token = random_hex(32)?;
        let token_hash = hex_encode(&sha256(token.as_bytes()));
        let mut data = self.lock();
        data.sessions.insert(
            token_hash.clone(),
            Session {
                token_hash,
                user_id: user_id.to_string(),
                created_at: now_secs(),
            },
        );
        self.save_locked(&mut data)?;
        Ok(token)
    }

    /// Resolve a bearer token to its user id, rejecting expired sessions.
    pub fn resolve_session(&self, token: &str) -> Option<String> {
        let token_hash = hex_encode(&sha256(token.as_bytes()));
        let mut data = self.lock();
        let (created_at, user_id) = {
            let session = data.sessions.get(&token_hash)?;
            (session.created_at, session.user_id.clone())
        };
        if now_secs().saturating_sub(created_at) > SESSION_TTL_SECS {
            data.sessions.remove(&token_hash);
            let _ = self.save_locked(&mut data);
            return None;
        }
        Some(user_id)
    }

    /// Revoke a bearer session.
    pub fn delete_session(&self, token: &str) -> Result<bool, String> {
        let token_hash = hex_encode(&sha256(token.as_bytes()));
        let mut data = self.lock();
        let removed = data.sessions.remove(&token_hash).is_some();
        if removed {
            self.save_locked(&mut data)?;
        }
        Ok(removed)
    }

    /// Fetch a user record.
    pub fn user(&self, user_id: &str) -> Option<User> {
        let data = self.lock();
        data.users.get(user_id).cloned()
    }

    /// One page of monitor accounts for the operator inventory, newest first.
    /// Sessions, watches and events are aggregated in one pass each, so the
    /// cost does not grow with the page size. The store has no index, so the
    /// listing itself is O(accounts) with a bounded response.
    pub fn admin_users(&self, offset: usize, limit: usize) -> (Vec<AdminUserSummary>, usize) {
        let now = now_secs();
        let data = self.lock();
        let mut sessions: HashMap<&str, (usize, u64)> = HashMap::new();
        for session in data.sessions.values() {
            if now.saturating_sub(session.created_at) > SESSION_TTL_SECS {
                continue;
            }
            let entry = sessions
                .entry(session.user_id.as_str())
                .or_insert((0, session.created_at));
            entry.0 += 1;
            entry.1 = entry.1.max(session.created_at);
        }
        let mut watches: HashMap<&str, usize> = HashMap::new();
        for watch in &data.watches {
            *watches.entry(watch.user_id.as_str()).or_insert(0) += 1;
        }
        let mut last_event: HashMap<&str, u64> = HashMap::new();
        for event in &data.events {
            let slot = last_event.entry(event.user_id.as_str()).or_insert(event.at);
            *slot = (*slot).max(event.at);
        }
        let mut users: Vec<&User> = data.users.values().collect();
        users.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let total = users.len();
        let page = users
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|user| {
                let session_info = sessions.get(user.id.as_str()).copied();
                let last_session_at = session_info.map(|(_, at)| at);
                let last_event_at = last_event.get(user.id.as_str()).copied();
                AdminUserSummary {
                    id: user.id.clone(),
                    address: user.address.clone(),
                    created_at: user.created_at,
                    settings: user.settings.clone(),
                    identities: user.identities.len(),
                    watches: watches.get(user.id.as_str()).copied().unwrap_or(0),
                    sessions: session_info.map(|(count, _)| count).unwrap_or(0),
                    last_session_at,
                    last_event_at,
                    last_seen_at: last_session_at.max(last_event_at),
                    telegram_linked: user.telegram_chat_id.is_some(),
                    telegram_linked_at: user.telegram_linked_at,
                }
            })
            .collect();
        (page, total)
    }

    /// One account with settings, identities, the Telegram binding and a
    /// bounded event tail (newest last). `event_limit` is clamped to 1..=200.
    pub fn admin_user(&self, user_id: &str, event_limit: usize) -> Option<AdminUserDetail> {
        let now = now_secs();
        let event_limit = event_limit.clamp(1, 200);
        let data = self.lock();
        let user = data.users.get(user_id)?;
        let sessions = data
            .sessions
            .values()
            .filter(|session| {
                session.user_id == user_id
                    && now.saturating_sub(session.created_at) <= SESSION_TTL_SECS
            })
            .count();
        let last_session_at = data
            .sessions
            .values()
            .filter(|session| {
                session.user_id == user_id
                    && now.saturating_sub(session.created_at) <= SESSION_TTL_SECS
            })
            .map(|session| session.created_at)
            .max();
        let watches = data
            .watches
            .iter()
            .filter(|watch| watch.user_id == user_id)
            .count();
        let mut events: Vec<Event> = Vec::with_capacity(event_limit.min(64));
        let mut last_event_at = None;
        // Walk backwards and stop after `event_limit` matches: the caller only
        // needs the tail, and the store must not copy the whole history while
        // holding the lock.
        for event in data.events.iter().rev() {
            if event.user_id != user_id {
                continue;
            }
            last_event_at.get_or_insert(event.at);
            events.push(event.clone());
            if events.len() >= event_limit {
                break;
            }
        }
        events.reverse();
        Some(AdminUserDetail {
            id: user.id.clone(),
            address: user.address.clone(),
            created_at: user.created_at,
            settings: user.settings.clone(),
            identities: user.identities.clone(),
            watches,
            sessions,
            last_seen_at: last_session_at.max(last_event_at),
            telegram: AdminTelegramLink {
                linked: user.telegram_chat_id.is_some(),
                chat_id: user.telegram_chat_id,
                linked_at: user.telegram_linked_at,
            },
            events,
        })
    }

    /// One page of the global event tail, newest first, optionally scoped to
    /// one account. Bounded: only the page is cloned.
    pub fn admin_events(
        &self,
        user_id: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> (Vec<Event>, usize) {
        let data = self.lock();
        let mut items = Vec::with_capacity(limit.min(64));
        let mut total = 0usize;
        for event in data.events.iter().rev() {
            if user_id.is_some_and(|wanted| event.user_id != wanted) {
                continue;
            }
            if total >= offset && items.len() < limit {
                items.push(event.clone());
            }
            total += 1;
        }
        (items, total)
    }

    /// Add watches for one user; existing `(chain, address)` pairs are kept
    /// and only their label/verification state is refreshed.
    pub fn add_watches(&self, user_id: &str, watches: Vec<NewWatch>) -> Result<Vec<Watch>, String> {
        let mut data = self.lock();
        let existing: HashSet<(String, String)> = data
            .watches
            .iter()
            .filter(|watch| watch.user_id == user_id)
            .map(|watch| (watch.chain.clone(), watch.address.clone()))
            .collect();
        let current = existing.len();
        let mut incoming: HashSet<(String, String)> = HashSet::new();
        for watch in &watches {
            incoming.insert((watch.chain.clone(), watch.address.clone()));
        }
        let new_count = incoming.difference(&existing).count();
        if current + new_count > MAX_WATCHES_PER_USER {
            return Err(format!(
                "address limit reached: {MAX_WATCHES_PER_USER} watches per account"
            ));
        }
        for new_watch in watches {
            match data.watches.iter_mut().find(|watch| {
                watch.user_id == user_id
                    && watch.chain == new_watch.chain
                    && watch.address == new_watch.address
            }) {
                Some(watch) => {
                    watch.verified |= new_watch.verified;
                    if let Some(label) = new_watch.label {
                        watch.label = Some(label);
                    }
                }
                None => data.watches.push(Watch {
                    user_id: user_id.to_string(),
                    chain: new_watch.chain,
                    address: new_watch.address,
                    label: new_watch.label,
                    verified: new_watch.verified,
                    last_balance: None,
                    last_nonce: None,
                    last_seen_at: None,
                    btc: None,
                }),
            }
        }
        self.save_locked(&mut data)?;
        Ok(watches_for(&data, user_id))
    }

    /// Remove one watch. Returns false when the user does not own it.
    pub fn delete_watch(&self, user_id: &str, chain: &str, address: &str) -> Result<bool, String> {
        let mut data = self.lock();
        let before = data.watches.len();
        data.watches.retain(|watch| {
            !(watch.user_id == user_id && watch.chain == chain && watch.address == address)
        });
        let removed = data.watches.len() != before;
        if removed {
            self.save_locked(&mut data)?;
        }
        Ok(removed)
    }

    /// Full cabinet snapshot (`/me`).
    pub fn me(&self, user_id: &str) -> Option<MeView> {
        let data = self.lock();
        let user = data.users.get(user_id)?.clone();
        let mut events: Vec<Event> = data
            .events
            .iter()
            .filter(|event| event.user_id == user_id)
            .cloned()
            .collect();
        let start = events.len().saturating_sub(100);
        events.drain(..start);
        Some(MeView {
            settings: user.settings.clone(),
            user,
            watches: watches_for(&data, user_id),
            events,
        })
    }

    /// Events for one user newer than `since` (by event id), newest 100.
    pub fn feed(&self, user_id: &str, since: Option<u64>) -> Vec<Event> {
        let data = self.lock();
        let since = since.unwrap_or(0);
        let mut events: Vec<Event> = data
            .events
            .iter()
            .filter(|event| event.user_id == user_id && event.id > since)
            .cloned()
            .collect();
        let start = events.len().saturating_sub(100);
        events.drain(..start);
        events
    }

    /// Update notification settings; `None` means "leave unchanged".
    pub fn update_settings(
        &self,
        user_id: &str,
        recovery_opt_in: Option<bool>,
        alerts_enabled: Option<bool>,
    ) -> Result<Option<Settings>, String> {
        let mut data = self.lock();
        let Some(user) = data.users.get_mut(user_id) else {
            return Ok(None);
        };
        if let Some(value) = recovery_opt_in {
            user.settings.recovery_opt_in = value;
        }
        if let Some(value) = alerts_enabled {
            user.settings.alerts_enabled = value;
        }
        let settings = user.settings.clone();
        self.save_locked(&mut data)?;
        Ok(Some(settings))
    }

    /// Create a 10-minute single-use Telegram linking code for `user_id`.
    pub fn create_link_code(&self, user_id: &str) -> Result<LinkCode, String> {
        self.create_link_code_with_ttl(user_id, LINK_CODE_TTL_SECS)
    }

    /// Create a linking code with an explicit lifetime (tests use short TTLs).
    /// Any older code for the same account is dropped: one active code.
    pub fn create_link_code_with_ttl(
        &self,
        user_id: &str,
        ttl_secs: u64,
    ) -> Result<LinkCode, String> {
        let mut data = self.lock();
        if !data.users.contains_key(user_id) {
            return Err("user not found".to_string());
        }
        data.telegram_links
            .retain(|_, link| link.user_id != user_id);
        let code = random_hex(16)?;
        let link = LinkCode {
            code: code.clone(),
            user_id: user_id.to_string(),
            expires_at: now_secs().saturating_add(ttl_secs),
        };
        data.telegram_links.insert(code, link.clone());
        self.save_locked(&mut data)?;
        Ok(link)
    }

    /// Remove and return a linking code. Codes are single-use and expire after
    /// [`LINK_CODE_TTL_SECS`].
    pub fn consume_link_code(&self, code: &str) -> Result<Option<LinkCode>, String> {
        let mut data = self.lock();
        let Some(link) = data.telegram_links.remove(code) else {
            return Ok(None);
        };
        self.save_locked(&mut data)?;
        if link.expires_at <= now_secs() {
            return Ok(None);
        }
        Ok(Some(link))
    }

    /// Bind a Telegram chat to the account. A chat can only belong to one
    /// account: any previous owner is unlinked first.
    pub fn link_telegram(&self, user_id: &str, chat_id: i64) -> Result<bool, String> {
        let mut data = self.lock();
        if !data.users.contains_key(user_id) {
            return Ok(false);
        }
        for (id, user) in data.users.iter_mut() {
            if id != user_id && user.telegram_chat_id == Some(chat_id) {
                user.telegram_chat_id = None;
                user.telegram_linked_at = None;
            }
        }
        let cursor = data.next_event_id.saturating_sub(1);
        let Some(user) = data.users.get_mut(user_id) else {
            return Ok(false);
        };
        user.telegram_chat_id = Some(chat_id);
        user.telegram_linked_at = Some(now_secs());
        // Linking starts from now: old events are not replayed as alerts.
        data.telegram_cursors.insert(user_id.to_string(), cursor);
        self.save_locked(&mut data)?;
        Ok(true)
    }

    /// Clear the bound chat. Alerts stop immediately.
    pub fn unlink_telegram(&self, user_id: &str) -> Result<bool, String> {
        let mut data = self.lock();
        let Some(user) = data.users.get_mut(user_id) else {
            return Ok(false);
        };
        let linked = user.telegram_chat_id.take().is_some();
        user.telegram_linked_at = None;
        if linked {
            self.save_locked(&mut data)?;
        }
        Ok(linked)
    }

    /// `Some(true)` when the account exists and has a linked chat.
    pub fn telegram_status(&self, user_id: &str) -> Option<bool> {
        let data = self.lock();
        data.users
            .get(user_id)
            .map(|user| user.telegram_chat_id.is_some())
    }

    /// Return the persisted webhook secret, if one was generated.
    pub fn webhook_secret(&self) -> Option<String> {
        let data = self.lock();
        data.telegram_webhook_secret.clone()
    }

    /// Whether the webhook secret is persisted, without copying the value.
    pub fn has_webhook_secret(&self) -> bool {
        let data = self.lock();
        data.telegram_webhook_secret.is_some()
    }

    /// Generate and persist the webhook secret on first call.
    pub fn ensure_webhook_secret(&self) -> Result<String, String> {
        let mut data = self.lock();
        if let Some(secret) = &data.telegram_webhook_secret {
            return Ok(secret.clone());
        }
        let secret = random_hex(32)?;
        data.telegram_webhook_secret = Some(secret.clone());
        self.save_locked(&mut data)?;
        Ok(secret)
    }

    /// Claim up to `limit` events for Telegram delivery.
    ///
    /// Each account's cursor is advanced and persisted before this returns, so
    /// a restart cannot send the same event twice. Events for accounts with
    /// alerts disabled still advance the cursor but produce no alert.
    pub fn claim_alerts(&self, limit: usize) -> Result<Vec<Alert>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut data = self.lock();
        let bindings: HashMap<String, (i64, bool, u64)> = data
            .users
            .iter()
            .filter_map(|(id, user)| {
                user.telegram_chat_id.map(|chat_id| {
                    (
                        id.clone(),
                        (
                            chat_id,
                            user.settings.alerts_enabled,
                            data.telegram_cursors.get(id).copied().unwrap_or(0),
                        ),
                    )
                })
            })
            .collect();
        if bindings.is_empty() {
            return Ok(Vec::new());
        }
        let mut alerts = Vec::new();
        let mut cursors: HashMap<String, u64> = HashMap::new();
        for event in &data.events {
            if alerts.len() >= limit {
                break;
            }
            let Some((chat_id, enabled, cursor)) = bindings.get(&event.user_id).copied() else {
                continue;
            };
            if event.id <= cursor {
                continue;
            }
            cursors.insert(event.user_id.clone(), event.id);
            if enabled {
                alerts.push(Alert {
                    event: event.clone(),
                    chat_id,
                });
            }
        }
        if !cursors.is_empty() {
            for (user_id, cursor) in cursors {
                let entry = data.telegram_cursors.entry(user_id).or_insert(0);
                *entry = (*entry).max(cursor);
            }
            self.save_locked(&mut data)?;
        }
        Ok(alerts)
    }

    /// Record an event unless an identical one landed within the dedupe
    /// window. Returns the stored event, or `None` when suppressed.
    pub fn record_event(
        &self,
        user_id: &str,
        chain: &str,
        address: &str,
        kind: &str,
        severity: &str,
        detail: &str,
    ) -> Result<Option<Event>, String> {
        let now = now_secs();
        let mut data = self.lock();
        let event = record_event_locked(
            &mut data,
            EventInput {
                user_id,
                chain,
                address,
                kind,
                severity,
                detail,
            },
            now,
        );
        self.save_locked(&mut data)?;
        Ok(event)
    }

    /// Owner user ids whose watches match any of the given canonical pairs.
    pub fn exposure_matches(&self, pairs: &[(String, String)]) -> Vec<String> {
        let wanted: HashSet<(&str, &str)> = pairs
            .iter()
            .map(|(chain, address)| (chain.as_str(), address.as_str()))
            .collect();
        let data = self.lock();
        let mut owners: Vec<String> = data
            .watches
            .iter()
            .filter(|watch| wanted.contains(&(watch.chain.as_str(), watch.address.as_str())))
            .map(|watch| watch.user_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        owners.sort();
        owners
    }

    /// Compare public lookup addresses with every watch. Returns the number of
    /// distinct matched `(chain, address)` pairs and records one `lookup`
    /// event per matched owner (deduplicated within the window).
    pub fn record_exposure(&self, pairs: &[(String, String)]) -> Result<usize, String> {
        let wanted: HashSet<(&str, &str)> = pairs
            .iter()
            .map(|(chain, address)| (chain.as_str(), address.as_str()))
            .collect();
        let now = now_secs();
        let mut data = self.lock();
        let matches: Vec<(String, String, String)> = data
            .watches
            .iter()
            .filter(|watch| wanted.contains(&(watch.chain.as_str(), watch.address.as_str())))
            .map(|watch| {
                (
                    watch.user_id.clone(),
                    watch.chain.clone(),
                    watch.address.clone(),
                )
            })
            .collect();
        let mut matched: HashSet<(String, String)> = HashSet::new();
        for (user_id, chain, address) in matches {
            matched.insert((chain.clone(), address.clone()));
            record_event_locked(
                &mut data,
                EventInput {
                    user_id: &user_id,
                    chain: &chain,
                    address: &address,
                    kind: "lookup",
                    severity: "high",
                    detail: "address looked up on /key",
                },
                now,
            );
        }
        if !matched.is_empty() {
            self.save_locked(&mut data)?;
        }
        Ok(matched.len())
    }

    /// Unique EVM addresses to poll.
    pub fn evm_watch_addresses(&self) -> Vec<String> {
        let data = self.lock();
        let mut addresses: Vec<String> = data
            .watches
            .iter()
            .filter(|watch| watch.chain == "evm")
            .map(|watch| watch.address.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        addresses.sort();
        addresses
    }

    /// Apply one poll result: the first observation sets the baseline, later
    /// changes produce per-owner events. Returns the newly recorded events.
    pub fn apply_evm_observations(
        &self,
        observations: &[Observation],
    ) -> Result<Vec<Event>, String> {
        let now = now_secs();
        let by_address: HashMap<&str, &Observation> = observations
            .iter()
            .map(|observation| (observation.address.as_str(), observation))
            .collect();
        let mut data = self.lock();
        data.watcher.last_ok_at = now;
        let mut created = Vec::new();
        for index in 0..data.watches.len() {
            let watch = &data.watches[index];
            if watch.chain != "evm" {
                continue;
            }
            let Some(observation) = by_address.get(watch.address.as_str()) else {
                continue;
            };
            let balance = observation.balance.clone();
            let nonce = observation.nonce;
            let mut changes: Vec<(&'static str, &'static str, String)> = Vec::new();
            if let Some(old) = &watch.last_balance
                && old != &balance
            {
                changes.push(("balance", "high", format!("balance {old} -> {balance}")));
            }
            if let Some(old) = watch.last_nonce
                && old != nonce
            {
                changes.push(("nonce", "critical", format!("nonce {old} -> {nonce}")));
            }
            let user_id = watch.user_id.clone();
            let chain = watch.chain.clone();
            let address = watch.address.clone();
            let watch = &mut data.watches[index];
            watch.last_balance = Some(balance);
            watch.last_nonce = Some(nonce);
            watch.last_seen_at = Some(now);
            for (kind, severity, detail) in changes {
                if let Some(event) = record_event_locked(
                    &mut data,
                    EventInput {
                        user_id: &user_id,
                        chain: &chain,
                        address: &address,
                        kind,
                        severity,
                        detail: &detail,
                    },
                    now,
                ) {
                    created.push(event);
                }
            }
        }
        self.save_locked(&mut data)?;
        Ok(created)
    }

    /// Unique BTC addresses to poll.
    pub fn btc_watch_addresses(&self) -> Vec<String> {
        let data = self.lock();
        let mut addresses: Vec<String> = data
            .watches
            .iter()
            .filter(|watch| watch.chain == "btc")
            .map(|watch| watch.address.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        addresses.sort();
        addresses
    }

    /// Apply BTC poll results. The first observation per watch sets the
    /// baseline; later changes produce at most one event per watch. The
    /// updated snapshot is persisted in the same write as the event, so a
    /// restart cannot replay it.
    pub fn apply_btc_observations(
        &self,
        observations: &[BtcObservation],
    ) -> Result<Vec<Event>, String> {
        let now = now_secs();
        let by_address: HashMap<&str, &BtcObservation> = observations
            .iter()
            .map(|observation| (observation.address.as_str(), observation))
            .collect();
        let mut data = self.lock();
        data.watcher.last_ok_at = now;
        let mut created = Vec::new();
        for index in 0..data.watches.len() {
            let watch = &data.watches[index];
            if watch.chain != "btc" {
                continue;
            }
            let Some(observation) = by_address.get(watch.address.as_str()) else {
                continue;
            };
            let next = observation.snapshot();
            let change = watch
                .btc
                .as_ref()
                .and_then(|prev| classify_btc(prev, &next));
            let user_id = watch.user_id.clone();
            let chain = watch.chain.clone();
            let address = watch.address.clone();
            let watch = &mut data.watches[index];
            watch.last_balance = Some(next.balance().to_string());
            watch.last_seen_at = Some(now);
            watch.btc = Some(next);
            if let Some((kind, severity, detail)) = change
                && let Some(event) = record_event_locked(
                    &mut data,
                    EventInput {
                        user_id: &user_id,
                        chain: &chain,
                        address: &address,
                        kind,
                        severity,
                        detail: &detail,
                    },
                    now,
                )
            {
                created.push(event);
            }
        }
        self.save_locked(&mut data)?;
        Ok(created)
    }

    /// Remember a watcher failure without losing the last success time.
    pub fn record_watcher_error(&self, message: &str) {
        let mut data = self.lock();
        data.watcher.last_error_at = now_secs();
        data.watcher.last_error = truncate(message, MAX_ERROR_LEN);
        let _ = self.save_locked(&mut data);
    }

    /// `(last_ok_at, last_error_at, last_error)` for diagnostics.
    pub fn watcher_health(&self) -> (u64, u64, String) {
        let data = self.lock();
        (
            data.watcher.last_ok_at,
            data.watcher.last_error_at,
            data.watcher.last_error.clone(),
        )
    }
}

/// Backfill identities for accounts written before multi-chain login: the
/// primary EVM address becomes their first verified identity.
fn migrate_identities(data: &mut Data) -> bool {
    let mut changed = false;
    for user in data.users.values_mut() {
        if user.identities.is_empty() {
            user.identities.push(Identity {
                chain: "evm".to_string(),
                address: user.address.clone(),
                verified: true,
                added_at: user.created_at,
            });
            changed = true;
        }
    }
    changed
}

fn find_identity<'a>(data: &'a Data, chain: &str, address: &str) -> Option<&'a User> {
    data.users.values().find(|user| {
        user.identities
            .iter()
            .any(|identity| identity.chain == chain && identity.address == address)
    })
}

fn watches_for(data: &Data, user_id: &str) -> Vec<Watch> {
    let mut watches: Vec<Watch> = data
        .watches
        .iter()
        .filter(|watch| watch.user_id == user_id)
        .cloned()
        .collect();
    watches.sort_by(|left, right| {
        (left.chain.as_str(), left.address.as_str())
            .cmp(&(right.chain.as_str(), right.address.as_str()))
    });
    watches
}

struct EventInput<'a> {
    user_id: &'a str,
    chain: &'a str,
    address: &'a str,
    kind: &'a str,
    severity: &'a str,
    detail: &'a str,
}

fn record_event_locked(data: &mut Data, input: EventInput<'_>, now: u64) -> Option<Event> {
    let EventInput {
        user_id,
        chain,
        address,
        kind,
        severity,
        detail,
    } = input;
    let duplicate = data.events.iter().rev().take(200).any(|event| {
        event.user_id == user_id
            && event.chain == chain
            && event.address == address
            && event.kind == kind
            && event.detail == detail
            && now.saturating_sub(event.at) <= EVENT_DEDUPE_WINDOW_SECS
    });
    if duplicate {
        return None;
    }
    let id = data.next_event_id.max(1);
    data.next_event_id = id.saturating_add(1);
    let event = Event {
        id,
        user_id: user_id.to_string(),
        chain: chain.to_string(),
        address: address.to_string(),
        kind: kind.to_string(),
        severity: severity.to_string(),
        detail: detail.to_string(),
        at: now,
        seen: false,
    };
    data.events.push(event.clone());
    data.events
        .retain(|event| now.saturating_sub(event.at) <= EVENT_RETENTION_SECS);
    let excess = data.events.len().saturating_sub(MAX_EVENTS);
    if excess > 0 {
        data.events.drain(..excess);
    }
    Some(event)
}

/// Classify a BTC stats change into `(kind, severity, detail)`.
///
/// A new chain transaction is "outgoing" unless it also brought funds in, in
/// which case it is an ordinary incoming transaction. Mempool-only movement
/// stays informational: it is not yet confirmed.
pub fn classify_btc(
    prev: &BtcSnapshot,
    next: &BtcSnapshot,
) -> Option<(&'static str, &'static str, String)> {
    let old_balance = prev.balance();
    let new_balance = next.balance();
    let spent_up = next.chain.spent_txo_sum > prev.chain.spent_txo_sum;
    let received_up = next.chain.funded_txo_sum > prev.chain.funded_txo_sum;
    let tx_up = next.chain.tx_count > prev.chain.tx_count;
    if spent_up || (tx_up && !received_up) {
        return Some((
            "outgoing",
            "high",
            format!(
                "balance {old_balance} -> {new_balance} sats; spent {} -> {} sats; tx {} -> {}",
                prev.chain.spent_txo_sum,
                next.chain.spent_txo_sum,
                prev.chain.tx_count,
                next.chain.tx_count
            ),
        ));
    }
    if received_up {
        return Some((
            "incoming",
            "info",
            format!(
                "balance {old_balance} -> {new_balance} sats; received {} -> {} sats; tx {} -> {}",
                prev.chain.funded_txo_sum,
                next.chain.funded_txo_sum,
                prev.chain.tx_count,
                next.chain.tx_count
            ),
        ));
    }
    if next.mempool != prev.mempool {
        return Some((
            "mempool",
            "info",
            format!(
                "mempool received {} -> {}, spent {} -> {}, tx {} -> {}; balance {old_balance} -> {new_balance} sats",
                prev.mempool.funded_txo_sum,
                next.mempool.funded_txo_sum,
                prev.mempool.spent_txo_sum,
                next.mempool.spent_txo_sum,
                prev.mempool.tx_count,
                next.mempool.tx_count
            ),
        ));
    }
    None
}

/// Map a client-supplied chain name to its canonical key.
pub fn canonical_chain(chain: &str) -> Result<&'static str, String> {
    match chain.trim().to_ascii_lowercase().as_str() {
        "evm" | "ethereum" | "eth" => Ok("evm"),
        "btc" | "bitcoin" => Ok("btc"),
        "solana" | "sol" => Ok("solana"),
        "tron" | "trx" => Ok("tron"),
        other => Err(format!(
            "unsupported chain: {other}; supports evm, btc, solana and tron"
        )),
    }
}

/// Canonicalize a Solana address: Base58 of exactly 32 ed25519 pubkey bytes.
pub fn canonicalize_solana(address: &str) -> Result<String, String> {
    let trimmed = address.trim();
    let bytes = bs58::decode(trimmed)
        .into_vec()
        .map_err(|err| format!("invalid Solana address: {err}"))?;
    if bytes.len() != 32 {
        return Err("Solana address must be a 32-byte ed25519 public key".to_string());
    }
    Ok(bs58::encode(bytes).into_string())
}

/// Canonicalize a TRON address: Base58Check over a 21-byte payload whose first
/// byte is the `0x41` mainnet version.
pub fn canonicalize_tron(address: &str) -> Result<String, String> {
    let trimmed = address.trim();
    let payload = crate::base58::decode_check(trimmed)
        .map_err(|err| format!("invalid TRON address: {err}"))?;
    if payload.len() != 21 {
        return Err("TRON address payload must be 21 bytes".to_string());
    }
    if payload[0] != 0x41 {
        return Err("TRON address must use the 0x41 mainnet version".to_string());
    }
    Ok(crate::base58::encode_check(&payload))
}

/// Canonicalize an EVM address to `0x` + 40 lowercase hex digits.
pub fn canonicalize_evm(address: &str) -> Result<String, String> {
    let trimmed = address.trim();
    let hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .ok_or_else(|| "EVM address must start with 0x".to_string())?;
    if hex.len() != 40 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("EVM address must be 0x followed by 40 hex digits".to_string());
    }
    Ok(format!("0x{}", hex.to_ascii_lowercase()))
}

/// BTC address check: Base58Check checksum, or full BIP173/BIP350 bech32
/// checksum and witness-program validation.
pub fn canonicalize_btc(address: &str) -> Result<String, String> {
    let trimmed = address.trim();
    let lower = trimmed.to_ascii_lowercase();
    let is_bech32 = ["bc1", "tb1", "bcrt1"]
        .iter()
        .any(|prefix| lower.starts_with(prefix));
    if is_bech32 {
        if trimmed != lower {
            return Err("bech32 addresses must be lowercase".to_string());
        }
        validate_bech32(&lower)?;
        return Ok(lower);
    }
    let payload = crate::base58::decode_check(trimmed)?;
    if payload.len() != 21 {
        return Err("invalid Base58Check address length".to_string());
    }
    match payload[0] {
        0x00 | 0x05 => Ok(trimmed.to_string()),
        version => Err(format!("unsupported Base58Check version: 0x{version:02x}")),
    }
}

const BECH32_CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

fn bech32_polymod(values: &[u8]) -> u32 {
    const GENERATOR: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let mut checksum = 1u32;
    for value in values {
        let top = checksum >> 25;
        checksum = ((checksum & 0x01ff_ffff) << 5) ^ u32::from(*value);
        for (index, generator) in GENERATOR.iter().enumerate() {
            if (top >> index) & 1 == 1 {
                checksum ^= generator;
            }
        }
    }
    checksum
}

fn bech32_hrp_expand(hrp: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(hrp.len() * 2 + 1);
    out.extend(hrp.bytes().map(|byte| byte >> 5));
    out.push(0);
    out.extend(hrp.bytes().map(|byte| byte & 31));
    out
}

/// Convert 5-bit groups to bytes, rejecting non-zero padding.
fn convert_5_to_8(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    let mut out = Vec::new();
    for value in data {
        accumulator = (accumulator << 5) | u32::from(*value);
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    if bits >= 5 || ((accumulator << (8 - bits)) & 0xff) != 0 {
        return Err("invalid bech32 padding".to_string());
    }
    Ok(out)
}

/// Verify a BIP173/BIP350 bech32 or bech32m checksum and witness program.
fn validate_bech32(address: &str) -> Result<(), String> {
    if address.len() > 90 {
        return Err("bech32 address is too long".to_string());
    }
    let Some((hrp, payload)) = address.rsplit_once('1') else {
        return Err("invalid bech32 address".to_string());
    };
    if !matches!(hrp, "bc" | "tb" | "bcrt") {
        return Err("unsupported bech32 prefix".to_string());
    }
    let mut data = Vec::with_capacity(payload.len());
    for byte in payload.bytes() {
        let position = BECH32_CHARSET
            .iter()
            .position(|candidate| *candidate == byte)
            .ok_or_else(|| "invalid bech32 character".to_string())?;
        data.push(position as u8);
    }
    if data.len() < 7 {
        return Err("invalid bech32 payload length".to_string());
    }
    let mut values = bech32_hrp_expand(hrp);
    values.extend_from_slice(&data);
    let checksum = bech32_polymod(&values);
    let (payload, _checksum) = data.split_at(data.len() - 6);
    let witness_version = *payload
        .first()
        .ok_or_else(|| "bech32 witness version is missing".to_string())?;
    if witness_version > 16 {
        return Err("invalid bech32 witness version".to_string());
    }
    let expected = if witness_version == 0 { 1 } else { 0x2bc8_30a3 };
    if checksum != expected {
        return Err("invalid bech32 checksum".to_string());
    }
    let program = convert_5_to_8(&payload[1..])?;
    if program.len() < 2 || program.len() > 40 {
        return Err("invalid bech32 witness program length".to_string());
    }
    if witness_version == 0 && !matches!(program.len(), 20 | 32) {
        return Err("invalid v0 witness program length".to_string());
    }
    Ok(())
}

/// Canonicalize a `(chain, address)` pair.
pub fn canonicalize_address(chain: &str, address: &str) -> Result<(String, String), String> {
    let chain = canonical_chain(chain)?;
    let address = match chain {
        "evm" => canonicalize_evm(address)?,
        "btc" => canonicalize_btc(address)?,
        "solana" => canonicalize_solana(address)?,
        "tron" => canonicalize_tron(address)?,
        _ => return Err(format!("unsupported chain: {chain}")),
    };
    Ok((chain.to_string(), address))
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer)
        .map_err(|err| format!("cannot obtain random bytes: {err}"))?;
    Ok(hex_encode(&buffer))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn truncate(text: &str, max: usize) -> String {
    let mut out = text.to_string();
    if out.len() > max {
        out.truncate(max);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempStore {
        path: PathBuf,
        store: MonitorStore,
    }

    impl TempStore {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "rotor-monitor-store-{}-{nanos}-{tag}.json",
                std::process::id()
            ));
            let store = MonitorStore::open(&path).expect("open store");
            Self { path, store }
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_file(format!("{}.tmp", self.path.display()));
        }
    }

    const ADDRESS: &str = "0x1111111111111111111111111111111111111111";
    const OTHER: &str = "0x2222222222222222222222222222222222222222";

    fn new_watch(chain: &str, address: &str, verified: bool) -> NewWatch {
        NewWatch {
            chain: chain.to_string(),
            address: address.to_string(),
            label: None,
            verified,
        }
    }

    #[test]
    fn addresses_are_canonicalized_and_validated() {
        assert_eq!(
            canonicalize_evm("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap(),
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert!(canonicalize_evm("1111111111111111111111111111111111111111").is_err());
        assert!(canonicalize_evm("0x1234").is_err());
        assert_eq!(canonical_chain("Ethereum").unwrap(), "evm");
        assert_eq!(canonical_chain("solana").unwrap(), "solana");
        assert_eq!(canonical_chain("trx").unwrap(), "tron");
        assert!(canonical_chain("doge").unwrap_err().contains("evm, btc"));
        // Base58Check: the genesis P2PKH address has a valid checksum.
        assert_eq!(
            canonicalize_btc("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").unwrap(),
            "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
        );
        assert!(canonicalize_btc("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb").is_err());
        // BIP173 bech32 (v0) and BIP350 bech32m (v1) checksums.
        assert_eq!(
            canonicalize_btc("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").unwrap(),
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
        );
        assert!(canonicalize_btc("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5").is_err());
        assert!(canonicalize_btc("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4").is_err());
        assert_eq!(
            canonicalize_btc("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0")
                .unwrap(),
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
        );
    }

    #[test]
    fn expired_challenges_are_pruned() {
        let temp = TempStore::new("prune");
        let now = now_secs();
        temp.store
            .put_challenge("stale", "evm", ADDRESS, "message", now.saturating_sub(1))
            .expect("put challenge");
        assert!(temp.store.challenge("stale").is_none());
    }

    #[test]
    fn add_delete_and_limit() {
        let temp = TempStore::new("add-delete");
        let user = temp.store.upsert_user(ADDRESS).expect("user");
        assert_eq!(user.address, ADDRESS);
        let watches = temp
            .store
            .add_watches(&user.id, vec![new_watch("evm", ADDRESS, true)])
            .expect("add");
        assert_eq!(watches.len(), 1);
        assert!(watches[0].verified);

        // Idempotent re-add keeps a single row.
        let watches = temp
            .store
            .add_watches(&user.id, vec![new_watch("evm", ADDRESS, true)])
            .expect("re-add");
        assert_eq!(watches.len(), 1);

        assert!(
            temp.store
                .delete_watch(&user.id, "evm", ADDRESS)
                .expect("delete")
        );
        assert!(
            !temp
                .store
                .delete_watch(&user.id, "evm", ADDRESS)
                .expect("delete again")
        );

        let many: Vec<NewWatch> = (1..=MAX_WATCHES_PER_USER + 1)
            .map(|index| new_watch("evm", &format!("0x{index:040x}"), true))
            .collect();
        assert!(temp.store.add_watches(&user.id, many).is_err());
    }

    #[test]
    fn expired_sessions_are_rejected() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "rotor-monitor-store-{}-{nanos}-session.json",
            std::process::id()
        ));
        let now = now_secs();
        let old_token = "expired-token";
        let fresh_token = "fresh-token";
        let old_hash = hex_encode(&sha256(old_token.as_bytes()));
        let fresh_hash = hex_encode(&sha256(fresh_token.as_bytes()));
        let data = serde_json::json!({
            "version": STORE_VERSION,
            "sessions": {
                (old_hash.clone()): {
                    "token_hash": old_hash,
                    "user_id": "u_old",
                    "created_at": now.saturating_sub(SESSION_TTL_SECS + 1),
                },
                (fresh_hash.clone()): {
                    "token_hash": fresh_hash,
                    "user_id": "u_fresh",
                    "created_at": now,
                },
            },
        });
        fs::write(&path, data.to_string()).expect("write monitor state");
        let store = MonitorStore::open(&path).expect("open store");
        assert!(store.resolve_session(old_token).is_none());
        assert_eq!(
            store.resolve_session(fresh_token).as_deref(),
            Some("u_fresh")
        );
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{}.tmp", path.display()));
    }

    #[test]
    fn identities_are_migrated_and_looked_up() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "rotor-monitor-store-{}-{nanos}-identity.json",
            std::process::id()
        ));
        let legacy = serde_json::json!({
            "version": STORE_VERSION,
            "users": {
                "u_legacy": {"id": "u_legacy", "address": ADDRESS, "created_at": 1},
            },
        });
        fs::write(&path, legacy.to_string()).expect("write legacy state");

        let store = MonitorStore::open(&path).expect("open store");
        let user = store
            .find_user_by_identity("evm", ADDRESS)
            .expect("migrated identity");
        assert_eq!(user.id, "u_legacy");
        assert_eq!(user.identities.len(), 1);
        assert!(user.identities[0].verified);
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read state")).expect("json");
        assert_eq!(raw["users"]["u_legacy"]["identities"][0]["chain"], "evm");

        // A second identity links to the same user instead of a new account.
        let sol = "11111111111111111111111111111111";
        let linked = store
            .add_identity("u_legacy", "solana", sol, true)
            .expect("link")
            .expect("user exists");
        assert_eq!(linked.identities.len(), 2);
        assert_eq!(
            store
                .find_user_by_identity("solana", sol)
                .expect("lookup")
                .id,
            "u_legacy"
        );

        // An identity owned by one account cannot move to another.
        let other = store.upsert_user(OTHER).expect("second user");
        assert!(store.add_identity(&other.id, "solana", sol, true).is_err());

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{}.tmp", path.display()));
    }

    #[test]
    fn events_deduplicate_within_the_window() {
        let temp = TempStore::new("dedupe");
        let user = temp.store.upsert_user(ADDRESS).expect("user");
        let first = temp
            .store
            .record_event(
                &user.id,
                "evm",
                ADDRESS,
                "nonce",
                "critical",
                "nonce 1 -> 2",
            )
            .expect("record");
        assert!(first.is_some());
        let second = temp
            .store
            .record_event(
                &user.id,
                "evm",
                ADDRESS,
                "nonce",
                "critical",
                "nonce 1 -> 2",
            )
            .expect("record");
        assert!(second.is_none());
        assert_eq!(temp.store.feed(&user.id, None).len(), 1);

        // A different detail is a different event.
        let third = temp
            .store
            .record_event(
                &user.id,
                "evm",
                ADDRESS,
                "nonce",
                "critical",
                "nonce 2 -> 3",
            )
            .expect("record");
        assert!(third.is_some());
    }

    #[test]
    fn exposure_matches_once_and_records_one_lookup() {
        let temp = TempStore::new("exposure");
        let user = temp.store.upsert_user(ADDRESS).expect("user");
        temp.store
            .add_watches(&user.id, vec![new_watch("evm", ADDRESS, true)])
            .expect("add");
        let pairs = vec![("evm".to_string(), ADDRESS.to_string())];
        assert_eq!(temp.store.exposure_matches(&pairs), vec![user.id.clone()]);
        assert_eq!(temp.store.record_exposure(&pairs).expect("expose"), 1);
        assert_eq!(temp.store.record_exposure(&pairs).expect("expose"), 1);
        let events = temp.store.feed(&user.id, None);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "lookup");
        assert_eq!(events[0].severity, "high");

        // Unwatched and non-canonical input never matches.
        let unmatched = vec![
            ("evm".to_string(), OTHER.to_string()),
            ("btc".to_string(), OTHER.to_string()),
        ];
        assert_eq!(temp.store.record_exposure(&unmatched).expect("expose"), 0);
    }

    #[test]
    fn observations_baseline_then_emit_changes() {
        let temp = TempStore::new("observations");
        let user = temp.store.upsert_user(ADDRESS).expect("user");
        temp.store
            .add_watches(&user.id, vec![new_watch("evm", ADDRESS, true)])
            .expect("add");

        let baseline = temp
            .store
            .apply_evm_observations(&[Observation {
                address: ADDRESS.to_string(),
                balance: "0x10".to_string(),
                nonce: 1,
            }])
            .expect("baseline");
        assert!(baseline.is_empty());
        assert!(temp.store.feed(&user.id, None).is_empty());

        let changes = temp
            .store
            .apply_evm_observations(&[Observation {
                address: ADDRESS.to_string(),
                balance: "0x0".to_string(),
                nonce: 2,
            }])
            .expect("change");
        assert_eq!(changes.len(), 2);
        let kinds: HashSet<&str> = changes.iter().map(|event| event.kind.as_str()).collect();
        assert!(kinds.contains("balance"));
        assert!(kinds.contains("nonce"));
    }

    #[test]
    fn btc_classifier_covers_the_decision_table() {
        let stats = |funded, spent, tx| BtcStats {
            funded_txo_sum: funded,
            spent_txo_sum: spent,
            tx_count: tx,
        };
        let snap = |chain, mempool| BtcSnapshot { chain, mempool };
        let base = snap(stats(1_000, 0, 1), BtcStats::default());

        assert!(classify_btc(&base, &base).is_none(), "no change, no event");

        let incoming = snap(stats(5_000, 0, 2), BtcStats::default());
        let (kind, severity, detail) = classify_btc(&base, &incoming).expect("incoming");
        assert_eq!((kind, severity), ("incoming", "info"));
        assert!(detail.contains("balance 1000 -> 5000 sats"));
        assert!(detail.contains("tx 1 -> 2"));

        let spent = snap(stats(5_000, 3_000, 3), BtcStats::default());
        let (kind, severity, detail) = classify_btc(&incoming, &spent).expect("outgoing");
        assert_eq!((kind, severity), ("outgoing", "high"));
        assert!(detail.contains("spent 0 -> 3000 sats"));

        // A new tx with no incoming funds is outgoing even without spent_sum
        // moving (for example a reorg/replace). Both stay chain-level.
        let new_tx = snap(stats(5_000, 3_000, 4), BtcStats::default());
        let (kind, _, _) = classify_btc(&spent, &new_tx).expect("outgoing tx");
        assert_eq!(kind, "outgoing");

        // Mempool-only movement is informational.
        let mempool = snap(stats(5_000, 3_000, 4), stats(700, 0, 1));
        let (kind, severity, detail) = classify_btc(&new_tx, &mempool).expect("mempool");
        assert_eq!((kind, severity), ("mempool", "info"));
        assert!(detail.contains("mempool received 0 -> 700"));
    }

    #[test]
    fn btc_observations_baseline_emit_once_and_survive_restart() {
        let temp = TempStore::new("btc-observations");
        let btc_address = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
        let user = temp
            .store
            .upsert_identity("btc", btc_address)
            .expect("user");
        temp.store
            .add_watches(&user.id, vec![new_watch("btc", btc_address, false)])
            .expect("add");
        let observation = |funded, spent, tx| BtcObservation {
            address: btc_address.to_string(),
            chain: BtcStats {
                funded_txo_sum: funded,
                spent_txo_sum: spent,
                tx_count: tx,
            },
            mempool: BtcStats::default(),
        };

        // First successful poll only sets the baseline.
        let events = temp
            .store
            .apply_btc_observations(&[observation(0, 0, 0)])
            .expect("baseline");
        assert!(events.is_empty());
        let watch = temp.store.me(&user.id).expect("me").watches.remove(0);
        assert_eq!(watch.last_balance.as_deref(), Some("0"));
        assert!(watch.last_seen_at.is_some());
        assert!(watch.btc.is_some());

        let events = temp
            .store
            .apply_btc_observations(&[observation(1_000, 0, 1)])
            .expect("incoming");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "incoming");
        assert_eq!(events[0].severity, "info");

        // Reopening from disk must not replay the same stats.
        let reopened = MonitorStore::open(&temp.path).expect("reopen");
        let events = reopened
            .apply_btc_observations(&[observation(1_000, 0, 1)])
            .expect("repeat");
        assert!(events.is_empty(), "restart replayed a known change");
    }

    #[test]
    fn link_codes_expire_and_are_single_use() {
        let temp = TempStore::new("link-codes");
        let user = temp.store.upsert_user(ADDRESS).expect("user");

        let link = temp.store.create_link_code(&user.id).expect("create code");
        assert_eq!(link.user_id, user.id);
        assert!(link.expires_at > now_secs());
        assert_eq!(link.code.len(), 32);

        let consumed = temp
            .store
            .consume_link_code(&link.code)
            .expect("consume")
            .expect("valid code");
        assert_eq!(consumed.user_id, user.id);
        // Single use: the second attempt finds nothing.
        assert!(
            temp.store
                .consume_link_code(&link.code)
                .expect("consume twice")
                .is_none()
        );

        // Expired codes are rejected even when they are still on disk.
        let stale = temp
            .store
            .create_link_code_with_ttl(&user.id, 0)
            .expect("create stale");
        assert!(
            temp.store
                .consume_link_code(&stale.code)
                .expect("consume stale")
                .is_none()
        );
        assert!(temp.store.create_link_code("u_missing").is_err());
    }

    #[test]
    fn telegram_binding_unlink_and_alert_cursor_survive_restart() {
        let temp = TempStore::new("telegram-bind");
        let user = temp.store.upsert_user(ADDRESS).expect("user");
        assert_eq!(temp.store.telegram_status(&user.id), Some(false));
        assert!(temp.store.link_telegram(&user.id, 424242).expect("link"));
        assert_eq!(temp.store.telegram_status(&user.id), Some(true));
        let linked = temp.store.user(&user.id).expect("user");
        assert_eq!(linked.telegram_chat_id, Some(424242));
        assert!(linked.telegram_linked_at.is_some());

        let event = temp
            .store
            .record_event(&user.id, "btc", ADDRESS, "incoming", "info", "first")
            .expect("record")
            .expect("event");
        let alerts = temp.store.claim_alerts(10).expect("claim");
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].event.id, event.id);
        assert_eq!(alerts[0].chat_id, 424242);

        // The cursor is persisted before delivery: a reopen sends nothing.
        let reopened = MonitorStore::open(&temp.path).expect("reopen");
        assert!(reopened.claim_alerts(10).expect("claim again").is_empty());

        assert!(reopened.unlink_telegram(&user.id).expect("unlink"));
        assert_eq!(reopened.telegram_status(&user.id), Some(false));
        reopened
            .record_event(&user.id, "btc", ADDRESS, "incoming", "info", "second")
            .expect("record");
        assert!(
            reopened
                .claim_alerts(10)
                .expect("claim unlinked")
                .is_empty()
        );
    }

    #[test]
    fn webhook_secret_is_generated_once() {
        let temp = TempStore::new("webhook-secret");
        assert!(temp.store.webhook_secret().is_none());
        let first = temp.store.ensure_webhook_secret().expect("secret");
        let second = temp.store.ensure_webhook_secret().expect("secret again");
        assert_eq!(first, second);
        assert_eq!(temp.store.webhook_secret().as_deref(), Some(first.as_str()));
    }

    #[test]
    fn settings_round_trip() {
        let temp = TempStore::new("settings");
        let user = temp.store.upsert_user(ADDRESS).expect("user");
        let settings = temp
            .store
            .update_settings(&user.id, Some(true), None)
            .expect("update")
            .expect("user exists");
        assert!(settings.recovery_opt_in);
        assert!(settings.alerts_enabled);
        let settings = temp
            .store
            .update_settings(&user.id, None, Some(false))
            .expect("update")
            .expect("user exists");
        assert!(settings.recovery_opt_in);
        assert!(!settings.alerts_enabled);
    }

    #[test]
    fn admin_user_reads_only_the_bounded_event_tail() {
        let temp = TempStore::new("admin-tail");
        let user = temp.store.upsert_user(ADDRESS).expect("user");
        for index in 0..25 {
            temp.store
                .record_event(
                    &user.id,
                    "btc",
                    ADDRESS,
                    "incoming",
                    "info",
                    &format!("event {index}"),
                )
                .expect("record");
        }
        let detail = temp.store.admin_user(&user.id, 10).expect("detail");
        assert_eq!(detail.events.len(), 10, "only the tail is read");
        // Newest last, oldest-to-newest within the tail.
        assert_eq!(detail.events.first().expect("first").detail, "event 15");
        assert_eq!(detail.events.last().expect("last").detail, "event 24");
        let newest_at = detail.events.last().expect("last").at;
        assert_eq!(detail.last_seen_at, Some(newest_at));
    }
}
