//! Processor-free paid downloads: orders, on-chain payment verification and
//! HMAC-signed delivery links.
//!
//! A buyer is identified by an order alone: one fixed deposit address per
//! chain plus a unique atomic-amount suffix above the list price. There are no
//! accounts, no cards, no custody and no private keys. A background thread
//! polls public explorers, credits an order once the configured confirmation
//! count is reached, and issues a link bound to the order and the list. Tokens
//! are stored hashed; the raw link is only ever handed to the buyer.
//!
//! Everything that can be tested without a network lives in pure functions:
//! quoting, suffix allocation, payment matching, link signing and the explorer
//! parsers.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tiny_http::{Method, Request, Response, StatusCode};

use super::state;
use super::tron_cache;
use super::{
    App, TRONSCAN_API_BASE, bearer, client_ip, constant_time_eq, header, query_param, read_body,
    respond_body_error, respond_hidden, respond_json, respond_rate_limited, tron_error_reason,
    tronscan_get,
};

/// Persisted data version; a different version is rejected instead of guessed.
const DATA_VERSION: u32 = 1;
/// Store file name next to the coordinator state file.
const ORDERS_FILE: &str = "orders.json";
/// Smallest poll interval; the design asks for one check every 45 seconds.
const MIN_POLL_INTERVAL_SECS: u64 = 10;
const DEFAULT_POLL_INTERVAL_SECS: u64 = 45;
/// Largest atomic-amount suffix. 9999 base units is a cent-scale offset even
/// for a six-decimal token and a few thousand satoshis for BTC/LTC.
const MAX_AMOUNT_SUFFIX: u128 = 9999;
/// Largest explorer response buffered into memory.
const MAX_UPSTREAM_BYTES: usize = 2 * 1024 * 1024;
/// Contact strings are free text; keep them short and printable.
const MAX_CONTACT_LEN: usize = 200;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const WRITE_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// The `ORDERS_CONFIG` document. Unknown fields are rejected by serde so a
/// typo in an operator file fails at startup instead of being ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrdersConfig {
    pub lists: Vec<ListConfig>,
    #[serde(default)]
    pub confirmations: HashMap<String, u32>,
    pub quote_ttl_secs: u64,
    pub link_ttl_secs: u64,
    pub max_downloads: u32,
    /// Optional second admin credential for scripts. The coordinator admin
    /// token is always accepted for the admin routes.
    #[serde(default)]
    pub admin_token: String,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_secs: u64,
    /// Optional per-chain Esplora base URLs. Defaults cover BTC and LTC.
    #[serde(default)]
    pub esplora: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListConfig {
    pub slug: String,
    pub title: String,
    /// `btc`, `ltc` or `tron`; the poller only verifies these chains.
    pub chain: String,
    pub asset: String,
    pub price_usd_cents: u64,
    /// Micro-USD per one whole unit of `asset`, frozen by the operator.
    pub usd_per_unit_micros: u64,
    pub decimals: u32,
    pub address: String,
    pub file_path: String,
    pub sha256: String,
    #[serde(default = "default_true")]
    pub active: bool,
    /// TRC-20 contract address for a token asset on TRON. `None` means a
    /// native coin transfer.
    #[serde(default)]
    pub contract: Option<String>,
    /// SPDX-style licence identifier delivered alongside the package.
    #[serde(default = "default_licence")]
    pub licence: String,
    /// Optional human-readable provenance for donor-derived data.
    #[serde(default)]
    pub provenance: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_licence() -> String {
    "MIT".to_string()
}

fn default_poll_interval() -> u64 {
    DEFAULT_POLL_INTERVAL_SECS
}

impl OrdersConfig {
    /// Parse and validate an operator configuration document.
    pub fn parse(text: &str) -> Result<Self, String> {
        let config: OrdersConfig = serde_json::from_str(text)
            .map_err(|err| format!("cannot parse orders config: {err}"))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), String> {
        if self.lists.is_empty() {
            return Err("orders config has no lists".to_string());
        }
        if self.quote_ttl_secs == 0 {
            return Err("quote_ttl_secs must be greater than zero".to_string());
        }
        if self.link_ttl_secs == 0 {
            return Err("link_ttl_secs must be greater than zero".to_string());
        }
        if self.max_downloads == 0 {
            return Err("max_downloads must be greater than zero".to_string());
        }
        let mut slugs = HashSet::new();
        let mut address_assets: HashMap<(&str, &str), Option<&str>> = HashMap::new();
        for list in &self.lists {
            if list.slug.is_empty()
                || !list
                    .slug
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            {
                return Err(format!(
                    "list slug {:?} must be non-empty ASCII letters, digits, '-' or '_'",
                    list.slug
                ));
            }
            if !slugs.insert(list.slug.as_str()) {
                return Err(format!("duplicate list slug {}", list.slug));
            }
            if !matches!(list.chain.as_str(), "btc" | "ltc" | "tron") {
                return Err(format!(
                    "list {} uses unsupported chain {:?} (btc, ltc or tron)",
                    list.slug, list.chain
                ));
            }
            if list.asset.trim().is_empty() {
                return Err(format!("list {} has a blank asset", list.slug));
            }
            if list.price_usd_cents == 0 {
                return Err(format!("list {} has a zero price", list.slug));
            }
            if list.usd_per_unit_micros == 0 {
                return Err(format!("list {} has a zero USD rate", list.slug));
            }
            if list.decimals > 18 {
                return Err(format!(
                    "list {} has more than 18 decimals; atomic amounts would overflow",
                    list.slug
                ));
            }
            if list.address.trim().is_empty() || list.file_path.trim().is_empty() {
                return Err(format!(
                    "list {} needs a deposit address and a file path",
                    list.slug
                ));
            }
            if list.sha256.len() != 64 || !list.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(format!(
                    "list {} sha256 must be 64 hexadecimal digits",
                    list.slug
                ));
            }
            if list
                .contract
                .as_deref()
                .is_some_and(|contract| contract.trim().is_empty())
            {
                return Err(format!("list {} has an empty contract address", list.slug));
            }
            if list.licence.is_empty()
                || list.licence.len() > 32
                || !list
                    .licence
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
            {
                return Err(format!(
                    "list {} licence must be 1..=32 ASCII letters, digits, '.', '+' or '-'",
                    list.slug
                ));
            }
            if let Some(provenance) = &list.provenance
                && (provenance.trim().is_empty()
                    || provenance.chars().count() > 300
                    || provenance.chars().any(char::is_control))
            {
                return Err(format!(
                    "list {} provenance must be non-empty printable text of at most 300 characters",
                    list.slug
                ));
            }
            // One fixed address carries only one asset: a native coin and a
            // token at the same address would make amounts ambiguous.
            let contract = list.contract.as_deref().map(str::trim);
            match address_assets.get(&(list.chain.as_str(), list.address.as_str())) {
                Some(existing) if *existing != contract => {
                    return Err(format!(
                        "lists sharing the {} address {} must use the same asset/contract",
                        list.chain, list.address
                    ));
                }
                Some(_) => {}
                None => {
                    address_assets.insert((list.chain.as_str(), list.address.as_str()), contract);
                }
            }
        }
        Ok(())
    }

    fn list(&self, slug: &str) -> Option<&ListConfig> {
        self.lists.iter().find(|list| list.slug == slug)
    }

    /// A list is orderable only when it exists and is `active`. Inactive lists
    /// stay in the file so the artifact and its hash can be staged first.
    fn active_list(&self, slug: &str) -> Option<&ListConfig> {
        self.list(slug).filter(|list| list.active)
    }

    fn confirmations_for(&self, chain: &str) -> u32 {
        self.confirmations
            .get(chain)
            .copied()
            .unwrap_or(match chain {
                "btc" => 3,
                "ltc" => 6,
                "tron" => 19,
                _ => 6,
            })
    }

    fn esplora_base(&self, chain: &str) -> Option<&str> {
        self.esplora.get(chain).map(String::as_str).or(match chain {
            "btc" => Some("https://mempool.space"),
            "ltc" => Some("https://litecoinspace.org"),
            _ => None,
        })
    }
}

// ---------------------------------------------------------------------------
// Persisted data
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OrderStatus {
    AwaitingPayment,
    Confirming,
    Paid,
    Expired,
    LatePaid,
    Revoked,
}

impl OrderStatus {
    fn as_str(self) -> &'static str {
        match self {
            OrderStatus::AwaitingPayment => "awaiting_payment",
            OrderStatus::Confirming => "confirming",
            OrderStatus::Paid => "paid",
            OrderStatus::Expired => "expired",
            OrderStatus::LatePaid => "late_paid",
            OrderStatus::Revoked => "revoked",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Order {
    id: String,
    list: String,
    chain: String,
    asset: String,
    /// Atomic units, decimal string (chain-native precision).
    amount: String,
    deposit_address: String,
    #[serde(default)]
    contact: Option<String>,
    status: OrderStatus,
    created_at: u64,
    expires_at: u64,
    #[serde(default)]
    paid_at: Option<u64>,
    /// SHA-256 of the one-time order token, lowercase hex.
    order_token_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Payment {
    order_id: String,
    chain: String,
    txid: String,
    vout: u64,
    amount: String,
    confirmations: u32,
    seen_at: u64,
    #[serde(default)]
    confirmed_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entitlement {
    order_id: String,
    list: String,
    token_hash: String,
    /// Random component signed into the link; lets the status page rebuild the
    /// same token without storing the token itself.
    nonce: String,
    expires_at: u64,
    max_downloads: u32,
    downloads: u32,
    #[serde(default)]
    revoked_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OrdersData {
    version: u32,
    #[serde(default)]
    orders: Vec<Order>,
    #[serde(default)]
    payments: Vec<Payment>,
    #[serde(default)]
    entitlements: Vec<Entitlement>,
}

impl Default for OrdersData {
    fn default() -> Self {
        Self {
            version: DATA_VERSION,
            orders: Vec::new(),
            payments: Vec::new(),
            entitlements: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
struct VersionProbe {
    #[serde(default)]
    version: Option<u32>,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Configured orders plus the JSON store next to the coordinator state.
pub struct Orders {
    config: OrdersConfig,
    secret: Vec<u8>,
    path: PathBuf,
    data: Mutex<OrdersData>,
}

impl std::fmt::Debug for Orders {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Orders")
            .field("lists", &self.config.lists.len())
            .field("path", &self.path)
            .finish()
    }
}

impl Orders {
    /// Build a store from an already parsed configuration. `path` is the JSON
    /// store file (tests pick their own; production uses `ORDERS_FILE` next to
    /// the coordinator state).
    pub fn new(config: OrdersConfig, secret: &[u8], path: PathBuf) -> Result<Self, String> {
        if secret.len() < 16 {
            return Err("ORDERS_HMAC_SECRET must be at least 16 bytes".to_string());
        }
        let data = load_data(&path)?;
        Ok(Self {
            config,
            secret: secret.to_vec(),
            path,
            data: Mutex::new(data),
        })
    }

    /// Parse `config_path` and open the store.
    pub fn open(config_path: &Path, secret: &[u8], store_path: PathBuf) -> Result<Self, String> {
        let text = fs::read_to_string(config_path)
            .map_err(|err| format!("cannot read {}: {err}", config_path.display()))?;
        let config = OrdersConfig::parse(&text)?;
        Self::new(config, secret, store_path)
    }

    /// Load from `ORDERS_CONFIG` / `ORDERS_HMAC_SECRET`. `None` means the
    /// feature is off and the routes answer 503.
    pub fn from_env(state_path: &Path) -> Result<Option<Self>, String> {
        let config_path = std::env::var("ORDERS_CONFIG")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(config_path) = config_path else {
            return Ok(None);
        };
        let secret = std::env::var("ORDERS_HMAC_SECRET").unwrap_or_default();
        let secret = secret.trim().to_string();
        if secret.is_empty() {
            return Err(
                "ORDERS_CONFIG is set but ORDERS_HMAC_SECRET is missing; use at least 32 random bytes"
                    .to_string(),
            );
        }
        let directory = state_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let store = directory.join(ORDERS_FILE);
        Self::open(Path::new(&config_path), secret.as_bytes(), store).map(Some)
    }

    fn lock(&self) -> MutexGuard<'_, OrdersData> {
        self.data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Atomically rewrite the store (`tmp` + rename), like the coordinator
    /// state file.
    fn persist(&self, data: &OrdersData) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(data)
            .map_err(|err| format!("cannot serialize orders: {err}"))?;
        let mut tmp = self.path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, json).map_err(|err| format!("cannot write {}: {err}", tmp.display()))?;
        fs::rename(&tmp, &self.path)
            .map_err(|err| format!("cannot replace {}: {err}", self.path.display()))
    }

    // -- order creation -----------------------------------------------------

    fn create(&self, request: CreateOrderRequest, now: u64) -> Result<CreatedOrder, CreateError> {
        let contact = match request.contact {
            Some(contact) => {
                let contact = contact.trim().to_string();
                if contact.is_empty() {
                    None
                } else if contact.chars().count() > MAX_CONTACT_LEN
                    || contact.chars().any(|ch| ch.is_control())
                {
                    return Err(CreateError::BadContact);
                } else {
                    Some(contact)
                }
            }
            None => None,
        };
        let list = self
            .config
            .active_list(&request.list)
            .ok_or(CreateError::UnknownList)?
            .clone();
        let base = quote_amount(
            list.price_usd_cents,
            list.usd_per_unit_micros,
            list.decimals,
        )
        .filter(|amount| *amount > 0)
        .ok_or_else(|| {
            CreateError::Store("the configured price/rate produces a zero atomic amount".into())
        })?;

        let id = random_hex(16).map_err(CreateError::Store)?;
        let order_token = random_hex(32).map_err(CreateError::Store)?;
        let order_token_hash = hex(&crate::hashes::sha256(order_token.as_bytes()));

        let mut data = self.lock();
        expire_locked(&mut data, now);
        // Amounts must be unique per deposit address, not merely per list: one
        // fixed address is shared by every list on the same chain, and the
        // amount is the only identifier a payment carries.
        let taken: Vec<u128> = data
            .orders
            .iter()
            .filter(|order| {
                order.chain == list.chain
                    && order.deposit_address == list.address
                    && !matches!(order.status, OrderStatus::Paid | OrderStatus::Revoked)
            })
            .filter_map(|order| order.amount.parse::<u128>().ok())
            .collect();
        let amount = allocate_amount(base, &taken).ok_or_else(|| {
            CreateError::Store("no unique atomic amount is available for this list".into())
        })?;
        let order = Order {
            id: id.clone(),
            list: list.slug.clone(),
            chain: list.chain.clone(),
            asset: list.asset.clone(),
            amount: amount.to_string(),
            deposit_address: list.address.clone(),
            contact,
            status: OrderStatus::AwaitingPayment,
            created_at: now,
            expires_at: now.saturating_add(self.config.quote_ttl_secs),
            paid_at: None,
            order_token_hash,
        };
        let expires_at = order.expires_at;
        data.orders.push(order);
        self.persist(&data).map_err(CreateError::Store)?;
        Ok(CreatedOrder {
            order_id: id,
            asset: list.asset,
            amount: amount.to_string(),
            address: list.address,
            expires_at,
            order_token,
        })
    }

    // -- read paths ---------------------------------------------------------

    fn expire(&self, now: u64) -> Result<(), String> {
        let mut data = self.lock();
        if expire_locked(&mut data, now) {
            self.persist(&data)?;
        }
        Ok(())
    }

    fn status(&self, id: &str, token: Option<&str>, now: u64) -> Result<Value, u16> {
        let Some(token) = token.filter(|token| !token.is_empty()) else {
            return Err(404);
        };
        let data = self.lock();
        let order = data
            .orders
            .iter()
            .find(|order| order.id == id)
            .ok_or(404u16)?;
        if !token_hash_matches(token, &order.order_token_hash) {
            return Err(404);
        }
        let status = if order.status == OrderStatus::AwaitingPayment && now >= order.expires_at {
            OrderStatus::Expired
        } else {
            order.status
        };
        let mut body = json!({
            "order_id": order.id,
            "list": order.list,
            "chain": order.chain,
            "asset": order.asset,
            "amount": order.amount,
            "address": order.deposit_address,
            "status": status.as_str(),
            "created_at": order.created_at,
            "expires_at": order.expires_at,
            "confirmations_required": self.config.confirmations_for(&order.chain),
        });
        body["licence_url"] = json!(format!("/api/v1/orders/{}/licence?token={token}", order.id));
        if order.status == OrderStatus::Paid
            && let Some(entitlement) = data
                .entitlements
                .iter()
                .find(|entitlement| entitlement.order_id == order.id)
            && download_gate(entitlement, now) == DownloadGate::Allowed
        {
            let token = sign_link(
                &self.secret,
                &order.id,
                &order.list,
                entitlement.expires_at,
                &entitlement.nonce,
            );
            body["download_url"] = json!(format!(
                "/api/v1/orders/{}/download?token={token}",
                order.id
            ));
            body["downloads_left"] = json!(
                entitlement
                    .max_downloads
                    .saturating_sub(entitlement.downloads)
            );
            body["download_expires_at"] = json!(entitlement.expires_at);
        }
        Ok(body)
    }

    /// The licence/attribution document delivered alongside the package.
    fn licence_document(&self, id: &str, token: &str, _now: u64) -> Result<String, u16> {
        let data = self.lock();
        let order = data
            .orders
            .iter()
            .find(|order| order.id == id)
            .ok_or(404u16)?;
        if !token_hash_matches(token, &order.order_token_hash) {
            return Err(404);
        }
        let list = self.config.list(&order.list).ok_or(404u16)?;
        Ok(render_licence_document(list))
    }

    /// Slug for the attachment filename; read after `licence_document` has
    /// already verified the order and token.
    fn licence_slug(&self, id: &str) -> Option<String> {
        let data = self.lock();
        let order = data.orders.iter().find(|order| order.id == id)?;
        self.config.list(&order.list).map(|list| list.slug.clone())
    }

    /// Snapshot of orders a payment can still credit.
    fn open_orders(&self) -> Vec<OpenOrder> {
        let data = self.lock();
        data.orders
            .iter()
            .filter(|order| needs_payment_watch(order.status))
            .map(|order| OpenOrder {
                list: order.list.clone(),
                chain: order.chain.clone(),
                address: order.deposit_address.clone(),
            })
            .collect()
    }

    // -- payment application ------------------------------------------------

    /// Credit incoming payments for one deposit address. Matching is by exact
    /// quoted amount (or a sole overpayment); one `(chain, txid, vout)` pays one
    /// order. Returns the number of orders that became paid.
    fn apply_incoming(
        &self,
        chain: &str,
        address: &str,
        incoming: &[Incoming],
        required: u32,
        now: u64,
    ) -> Result<usize, String> {
        let mut data = self.lock();
        let mut credits = 0usize;
        for payment in incoming {
            let existing = data.payments.iter().position(|seen| {
                seen.chain == chain && seen.txid == payment.txid && seen.vout == payment.vout
            });
            if let Some(index) = existing {
                // A repeat poll only updates confirmations.
                data.payments[index].confirmations = data.payments[index]
                    .confirmations
                    .max(payment.confirmations);
                if payment.confirmations >= required {
                    data.payments[index].confirmed_at.get_or_insert(now);
                    let order_id = data.payments[index].order_id.clone();
                    if let Some(position) = data.orders.iter().position(|order| {
                        order.id == order_id && order.status == OrderStatus::Confirming
                    }) {
                        mark_paid(&mut data, position, now, &self.config, &self.secret)?;
                        credits += 1;
                    }
                }
                continue;
            }

            let open: Vec<(String, u128)> = data
                .orders
                .iter()
                .filter(|order| {
                    order.chain == chain
                        && order.deposit_address == address
                        && needs_payment_watch(order.status)
                })
                .filter_map(|order| {
                    order
                        .amount
                        .parse::<u128>()
                        .ok()
                        .map(|amount| (order.id.clone(), amount))
                })
                .collect();
            let order_id = match match_payment(payment.amount, &open) {
                Match::Exact(id) | Match::Overpaid(id) => id,
                Match::Under | Match::Ambiguous => continue,
            };
            let Some(position) = data.orders.iter().position(|order| order.id == order_id) else {
                continue;
            };
            data.payments.push(Payment {
                order_id: order_id.clone(),
                chain: chain.to_string(),
                txid: payment.txid.clone(),
                vout: payment.vout,
                amount: payment.amount.to_string(),
                confirmations: payment.confirmations,
                seen_at: now,
                confirmed_at: (payment.confirmations >= required).then_some(now),
            });
            if now >= data.orders[position].expires_at {
                // Paid after the quote window: recorded for manual handling,
                // never auto-delivered.
                data.orders[position].status = OrderStatus::LatePaid;
                continue;
            }
            if payment.confirmations >= required {
                mark_paid(&mut data, position, now, &self.config, &self.secret)?;
                credits += 1;
            } else {
                data.orders[position].status = OrderStatus::Confirming;
            }
        }
        self.persist(&data)?;
        Ok(credits)
    }

    // -- delivery -----------------------------------------------------------

    /// Validate the link and entitlement, verify the artifact hash and consume
    /// one download. The returned file is rewound and ready to stream.
    fn open_download(&self, id: &str, token: &str, now: u64) -> Result<ReadyDownload, u16> {
        let (file_path, sha256) = {
            let data = self.lock();
            let order = data
                .orders
                .iter()
                .find(|order| order.id == id)
                .ok_or(404u16)?;
            let entitlement = data
                .entitlements
                .iter()
                .find(|entitlement| entitlement.order_id == id)
                .ok_or(404u16)?;
            match verify_link(&self.secret, &order.id, &order.list, token, now) {
                LinkVerdict::Ok => {}
                LinkVerdict::Expired => return Err(410),
                LinkVerdict::Invalid => return Err(404),
            }
            if entitlement.list != order.list {
                return Err(404);
            }
            if download_gate(entitlement, now) != DownloadGate::Allowed {
                return Err(410);
            }
            let list = self.config.list(&order.list).ok_or(500u16)?.clone();
            (list.file_path, list.sha256)
        };

        let mut file = File::open(&file_path).map_err(|err| {
            eprintln!("rotor-coord: orders: cannot open {file_path}: {err}");
            500u16
        })?;
        let digest = hash_reader(&mut file).map_err(|err| {
            eprintln!("rotor-coord: orders: cannot hash {file_path}: {err}");
            500u16
        })?;
        if !digest.eq_ignore_ascii_case(&sha256) {
            eprintln!("rotor-coord: orders: {file_path} does not match its configured sha256");
            return Err(500);
        }
        file.seek(SeekFrom::Start(0)).map_err(|err| {
            eprintln!("rotor-coord: orders: cannot rewind {file_path}: {err}");
            500u16
        })?;
        let length = file
            .metadata()
            .map_err(|err| {
                eprintln!("rotor-coord: orders: cannot stat {file_path}: {err}");
                500u16
            })?
            .len();

        {
            let mut data = self.lock();
            let Some(entitlement) = data
                .entitlements
                .iter_mut()
                .find(|entitlement| entitlement.order_id == id)
            else {
                return Err(404);
            };
            if download_gate(entitlement, now) != DownloadGate::Allowed {
                return Err(410);
            }
            entitlement.downloads = entitlement.downloads.saturating_add(1);
            self.persist(&data).map_err(|err| {
                eprintln!("rotor-coord: orders: cannot record a download: {err}");
                500u16
            })?;
        }
        let file_name = Path::new(&file_path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| {
                !name.is_empty()
                    && name.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
                    })
            })
            .unwrap_or("download.bin")
            .to_string();
        Ok(ReadyDownload {
            file,
            length,
            file_name,
        })
    }

    // -- admin --------------------------------------------------------------

    fn revoke(&self, id: &str, now: u64) -> Result<(), u16> {
        let mut data = self.lock();
        let Some(order) = data.orders.iter_mut().find(|order| order.id == id) else {
            return Err(404);
        };
        order.status = OrderStatus::Revoked;
        if let Some(entitlement) = data
            .entitlements
            .iter_mut()
            .find(|entitlement| entitlement.order_id == id)
        {
            entitlement.revoked_at = Some(now);
        }
        self.persist(&data).map_err(|err| {
            eprintln!("rotor-coord: orders: cannot record a revocation: {err}");
            500u16
        })
    }

    // -- admin inventory ----------------------------------------------------

    /// Configuration footprint without any credential or HMAC material.
    pub fn admin_summary(&self) -> AdminOrdersSummary {
        AdminOrdersSummary {
            configured: true,
            lists: self.config.lists.len(),
            active_lists: self.config.lists.iter().filter(|list| list.active).count(),
            poll_interval_secs: self.config.poll_interval_secs,
        }
    }

    /// One page of orders, newest first. The order token hash never leaves the
    /// store.
    pub fn admin_orders(&self, offset: usize, limit: usize) -> (Vec<AdminOrder>, usize) {
        let data = self.lock();
        let total = data.orders.len();
        let page = data
            .orders
            .iter()
            .rev()
            .skip(offset)
            .take(limit)
            .map(|order| AdminOrder {
                id: order.id.clone(),
                list: order.list.clone(),
                chain: order.chain.clone(),
                asset: order.asset.clone(),
                amount: order.amount.clone(),
                deposit_address: order.deposit_address.clone(),
                contact: order.contact.clone(),
                status: order.status.as_str(),
                created_at: order.created_at,
                expires_at: order.expires_at,
                paid_at: order.paid_at,
            })
            .collect();
        (page, total)
    }

    /// One page of recorded payments, newest first.
    pub fn admin_payments(&self, offset: usize, limit: usize) -> (Vec<AdminPayment>, usize) {
        let data = self.lock();
        let total = data.payments.len();
        let page = data
            .payments
            .iter()
            .rev()
            .skip(offset)
            .take(limit)
            .map(|payment| AdminPayment {
                order_id: payment.order_id.clone(),
                chain: payment.chain.clone(),
                txid: payment.txid.clone(),
                vout: payment.vout,
                amount: payment.amount.clone(),
                confirmations: payment.confirmations,
                seen_at: payment.seen_at,
                confirmed_at: payment.confirmed_at,
            })
            .collect();
        (page, total)
    }
}

/// Operator-facing order row. No token hash, no entitlement nonce.
#[derive(Clone, Debug, Serialize)]
pub struct AdminOrder {
    pub id: String,
    pub list: String,
    pub chain: String,
    pub asset: String,
    pub amount: String,
    pub deposit_address: String,
    pub contact: Option<String>,
    pub status: &'static str,
    pub created_at: u64,
    pub expires_at: u64,
    pub paid_at: Option<u64>,
}

/// Operator-facing payment row.
#[derive(Clone, Debug, Serialize)]
pub struct AdminPayment {
    pub order_id: String,
    pub chain: String,
    pub txid: String,
    pub vout: u64,
    pub amount: String,
    pub confirmations: u32,
    pub seen_at: u64,
    pub confirmed_at: Option<u64>,
}

/// Orders configuration footprint for the integrations panel.
#[derive(Clone, Debug, Serialize)]
pub struct AdminOrdersSummary {
    pub configured: bool,
    pub lists: usize,
    pub active_lists: usize,
    pub poll_interval_secs: u64,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Orders whose deposit address must still be watched. Expired quotes stay in
/// the watch set so a payment that arrives just after the window is recorded
/// as `late_paid` instead of disappearing.
fn needs_payment_watch(status: OrderStatus) -> bool {
    matches!(
        status,
        OrderStatus::AwaitingPayment | OrderStatus::Confirming | OrderStatus::Expired
    )
}

fn expire_locked(data: &mut OrdersData, now: u64) -> bool {
    let mut changed = false;
    for order in &mut data.orders {
        if order.status == OrderStatus::AwaitingPayment && now >= order.expires_at {
            order.status = OrderStatus::Expired;
            changed = true;
        }
    }
    changed
}

/// Base atomic amount from a USD price frozen at the configured rate.
/// Rounded up so the seller is never underpaid by a fraction of a unit.
fn quote_amount(price_usd_cents: u64, usd_per_unit_micros: u64, decimals: u32) -> Option<u128> {
    if usd_per_unit_micros == 0 || decimals > 18 {
        return None;
    }
    let numerator = u128::from(price_usd_cents)
        .checked_mul(10_000)? // cents -> micro-USD
        .checked_mul(10u128.checked_pow(decimals)?)?;
    let denominator = u128::from(usd_per_unit_micros);
    Some(numerator.div_ceil(denominator))
}

/// Pick `base + suffix` not used by another order on the same deposit address.
fn allocate_amount(base: u128, taken: &[u128]) -> Option<u128> {
    (1..=MAX_AMOUNT_SUFFIX)
        .map(|suffix| base.saturating_add(suffix))
        .find(|amount| !taken.contains(amount))
}

#[derive(Debug, PartialEq, Eq)]
enum Match {
    Exact(String),
    Overpaid(String),
    Under,
    Ambiguous,
}

/// Decide which open order a payment credits.
///
/// Exact amount equality is the unique identifier. An overpayment is credited
/// only when exactly one open order is at or below the paid amount, so a
/// transfer can never be split between two orders.
fn match_payment(paid: u128, open: &[(String, u128)]) -> Match {
    let exact: Vec<&(String, u128)> = open.iter().filter(|(_, amount)| *amount == paid).collect();
    match exact.len() {
        1 => return Match::Exact(exact[0].0.clone()),
        0 => {}
        _ => return Match::Ambiguous,
    }
    let below: Vec<&(String, u128)> = open.iter().filter(|(_, amount)| *amount < paid).collect();
    match below.len() {
        1 => Match::Overpaid(below[0].0.clone()),
        0 => Match::Under,
        _ => Match::Ambiguous,
    }
}

#[cfg(test)]
fn payment_key(chain: &str, txid: &str, vout: u64) -> String {
    format!("{chain}:{txid}:{vout}")
}

#[cfg(test)]
fn duplicate_payment(payments: &[Payment], chain: &str, txid: &str, vout: u64) -> bool {
    let key = payment_key(chain, txid, vout);
    payments
        .iter()
        .any(|payment| payment_key(&payment.chain, &payment.txid, payment.vout) == key)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key_block = [0u8; BLOCK];
    if key.len() > BLOCK {
        key_block.copy_from_slice(&crate::hashes::sha256(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0u8; BLOCK];
    let mut opad = [0u8; BLOCK];
    for index in 0..BLOCK {
        ipad[index] = key_block[index] ^ 0x36;
        opad[index] = key_block[index] ^ 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner.finalize());
    let mut out = [0u8; 32];
    out.copy_from_slice(&outer.finalize());
    out
}

/// `v1.<expires_at>.<nonce>.<hmac>`, bound to the order and the list.
fn sign_link(secret: &[u8], order_id: &str, list: &str, expires_at: u64, nonce: &str) -> String {
    let message = format!("v1|{order_id}|{list}|{expires_at}|{nonce}");
    let mac = hmac_sha256(secret, message.as_bytes());
    format!("v1.{expires_at}.{nonce}.{}", hex(&mac))
}

#[derive(Debug, PartialEq, Eq)]
enum LinkVerdict {
    Ok,
    Expired,
    Invalid,
}

fn verify_link(secret: &[u8], order_id: &str, list: &str, token: &str, now: u64) -> LinkVerdict {
    let mut parts = token.split('.');
    let version = parts.next();
    let expires_at = parts.next();
    let nonce = parts.next();
    let mac = parts.next();
    if parts.next().is_some() || version != Some("v1") {
        return LinkVerdict::Invalid;
    }
    let (Some(expires_at), Some(nonce), Some(mac)) = (expires_at, nonce, mac) else {
        return LinkVerdict::Invalid;
    };
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return LinkVerdict::Invalid;
    }
    let Ok(expires_at) = expires_at.parse::<u64>() else {
        return LinkVerdict::Invalid;
    };
    let expected = sign_link(secret, order_id, list, expires_at, nonce);
    let expected_mac = expected.rsplit('.').next().unwrap_or_default();
    if !constant_time_eq(mac.as_bytes(), expected_mac.as_bytes()) {
        return LinkVerdict::Invalid;
    }
    if now >= expires_at {
        LinkVerdict::Expired
    } else {
        LinkVerdict::Ok
    }
}

#[derive(Debug, PartialEq, Eq)]
enum DownloadGate {
    Allowed,
    Expired,
    Exhausted,
    Revoked,
}

fn download_gate(entitlement: &Entitlement, now: u64) -> DownloadGate {
    if entitlement.revoked_at.is_some() {
        return DownloadGate::Revoked;
    }
    if now >= entitlement.expires_at {
        return DownloadGate::Expired;
    }
    if entitlement.downloads >= entitlement.max_downloads {
        return DownloadGate::Exhausted;
    }
    DownloadGate::Allowed
}

fn token_hash_matches(token: &str, expected: &str) -> bool {
    let digest = hex(&crate::hashes::sha256(token.as_bytes()));
    constant_time_eq(digest.as_bytes(), expected.as_bytes())
}

/// Standard MIT body; the copyright line is prepended per list.
const MIT_LICENCE_BODY: &str =
    "Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the \"Software\"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
";

fn mit_notice(holder: &str) -> String {
    format!("MIT License\n\nCopyright (c) {holder}\n\n{MIT_LICENCE_BODY}")
}

/// Build the plain-text licence/attribution page for one list. Pure: the
/// copyright holder is chosen from the configured provenance, never guessed.
fn render_licence_document(list: &ListConfig) -> String {
    let mut out = format!(
        "{} ({})\nLicence: {}\n",
        list.title, list.slug, list.licence
    );
    if let Some(provenance) = &list.provenance {
        out.push_str(&format!("Provenance: {provenance}\n"));
    }
    out.push('\n');
    match list.licence.as_str() {
        "MIT" => {
            let donor = list.provenance.as_deref().is_some_and(|provenance| {
                let lower = provenance.to_ascii_lowercase();
                lower.contains("mmdrza") || lower.contains("rich-address-wallet")
            });
            let holder = if donor {
                "2022 MMDRZA"
            } else {
                "2026 the Rotor project contributors"
            };
            out.push_str(&mit_notice(holder));
        }
        "CC0-1.0" => out.push_str(
            "This package is a derived work dedicated to the public domain under\n\
             CC0 1.0 Universal.\n\
             https://creativecommons.org/publicdomain/zero/1.0/\n",
        ),
        other => out.push_str(&format!(
            "Licence: {other}\nContact the operator for the full licence terms.\n"
        )),
    }
    out
}

fn mark_paid(
    data: &mut OrdersData,
    position: usize,
    now: u64,
    config: &OrdersConfig,
    secret: &[u8],
) -> Result<(), String> {
    let order = &mut data.orders[position];
    order.status = OrderStatus::Paid;
    order.paid_at = Some(now);
    let order_id = order.id.clone();
    let list = order.list.clone();
    if data
        .entitlements
        .iter()
        .any(|entitlement| entitlement.order_id == order_id)
    {
        return Ok(());
    }
    let nonce = random_hex(16)?;
    let expires_at = now.saturating_add(config.link_ttl_secs);
    let token = sign_link(secret, &order_id, &list, expires_at, &nonce);
    data.entitlements.push(Entitlement {
        order_id,
        list,
        token_hash: hex(&crate::hashes::sha256(token.as_bytes())),
        nonce,
        expires_at,
        max_downloads: config.max_downloads,
        downloads: 0,
        revoked_at: None,
    });
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).map_err(|err| format!("cannot read randomness: {err}"))?;
    Ok(hex(&buffer))
}

fn hash_reader(reader: &mut impl Read) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn load_data(path: &Path) -> Result<OrdersData, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(OrdersData::default()),
        Err(err) => return Err(format!("cannot read {}: {err}", path.display())),
    };
    let probe: VersionProbe = serde_json::from_slice(&bytes)
        .map_err(|err| format!("cannot parse {}: {err}", path.display()))?;
    if probe.version != Some(DATA_VERSION) {
        return Err(format!(
            "{}: unsupported orders store version {:?}; this build expects version {DATA_VERSION}. Move or delete the file to start fresh.",
            path.display(),
            probe.version
        ));
    }
    serde_json::from_slice(&bytes).map_err(|err| format!("cannot parse {}: {err}", path.display()))
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CreateOrderRequest {
    list: String,
    #[serde(default)]
    contact: Option<String>,
}

struct CreatedOrder {
    order_id: String,
    asset: String,
    amount: String,
    address: String,
    expires_at: u64,
    order_token: String,
}

enum CreateError {
    UnknownList,
    BadContact,
    Store(String),
}

struct ReadyDownload {
    file: File,
    length: u64,
    file_name: String,
}

/// Serve every `/api/v1/orders/*` and admin orders route. Returns after
/// responding. The routes are matched before the client-token matrix: buyers
/// have no client account.
pub(super) fn handle(
    app: &App,
    orders: Arc<Orders>,
    request: Request,
    method: Method,
    path: &str,
    query: &str,
) {
    match (method, path) {
        (Method::Post, "/api/v1/orders") => {
            let ip = client_ip(&request, app.trust_proxy);
            if !app.rate.allow(&format!("orders:{ip}")) {
                return respond_rate_limited(request);
            }
            create_order(&orders, request);
        }
        (Method::Get, value) if value.starts_with("/api/v1/orders/") => {
            let ip = client_ip(&request, app.trust_proxy);
            let rest = &value["/api/v1/orders/".len()..];
            if let Some(id) = rest.strip_suffix("/download") {
                if !app
                    .rate
                    .allow_with(&format!("orders-download:{ip}"), 0.2, 2.0)
                {
                    return respond_rate_limited(request);
                }
                let token = query_param(query, "token")
                    .map(str::to_string)
                    .or_else(|| bearer(&request).map(str::to_string))
                    .unwrap_or_default();
                return download(&orders, request, id, &token);
            }
            if let Some(id) = rest.strip_suffix("/licence") {
                if !app.rate.allow(&format!("orders:{ip}")) {
                    return respond_rate_limited(request);
                }
                let token = query_param(query, "token")
                    .map(str::to_string)
                    .or_else(|| bearer(&request).map(str::to_string))
                    .unwrap_or_default();
                return licence(&orders, request, id, &token);
            }
            if !app.rate.allow(&format!("orders:{ip}")) {
                return respond_rate_limited(request);
            }
            let token = bearer(&request)
                .map(str::to_string)
                .or_else(|| query_param(query, "token").map(str::to_string));
            order_status(&orders, request, rest, token.as_deref());
        }
        (Method::Post, value) if value.starts_with("/api/v1/admin/orders/") => {
            if !admin_authorized(app, &orders, &request) {
                return respond_json(request, 401, &json!({ "error": "unauthorized" }));
            }
            let rest = &value["/api/v1/admin/orders/".len()..];
            let Some(id) = rest.strip_suffix("/revoke") else {
                return respond_json(request, 404, &json!({ "error": "not found" }));
            };
            match orders.revoke(id, state::now_secs()) {
                Ok(()) => respond_json(request, 200, &json!({ "ok": true, "status": "revoked" })),
                Err(404) => respond_json(request, 404, &json!({ "error": "not found" })),
                Err(_) => respond_json(request, 500, &json!({ "error": "cannot revoke order" })),
            }
        }
        (Method::Post, "/api/v1/admin/payments/reconcile") => {
            if !admin_authorized(app, &orders, &request) {
                return respond_json(request, 401, &json!({ "error": "unauthorized" }));
            }
            let agent = build_agent();
            match poll_once(
                &orders,
                &agent,
                app.tronscan_api_key.as_deref(),
                &app.tron_limiter,
            ) {
                Ok(credits) => {
                    respond_json(request, 200, &json!({ "ok": true, "credits": credits }))
                }
                Err(err) => {
                    eprintln!("rotor-coord: orders reconcile failed: {err}");
                    respond_json(request, 502, &json!({ "error": "poll failed" }))
                }
            }
        }
        _ => respond_json(request, 404, &json!({ "error": "not found" })),
    }
}

fn admin_authorized(app: &App, orders: &Orders, request: &Request) -> bool {
    let Some(presented) = bearer(request) else {
        return false;
    };
    if constant_time_eq(presented.as_bytes(), app.admin_token.as_bytes()) {
        return true;
    }
    !orders.config.admin_token.is_empty()
        && constant_time_eq(presented.as_bytes(), orders.config.admin_token.as_bytes())
}

fn create_order(orders: &Orders, mut request: Request) {
    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(error) => return respond_body_error(request, error),
    };
    let create: CreateOrderRequest = match serde_json::from_str(&body) {
        Ok(create) => create,
        Err(err) => {
            return respond_json(
                request,
                400,
                &json!({ "error": format!("invalid JSON: {err}") }),
            );
        }
    };
    match orders.create(create, state::now_secs()) {
        Ok(created) => respond_json(
            request,
            201,
            &json!({
                "order_id": created.order_id,
                "asset": created.asset,
                "amount": created.amount,
                "address": created.address,
                "expires_at": created.expires_at,
                "order_token": created.order_token,
            }),
        ),
        Err(CreateError::UnknownList) => {
            respond_json(request, 404, &json!({ "error": "unknown list" }))
        }
        Err(CreateError::BadContact) => {
            respond_json(request, 400, &json!({ "error": "invalid contact" }))
        }
        Err(CreateError::Store(message)) => {
            eprintln!("rotor-coord: orders: cannot create an order: {message}");
            respond_json(request, 500, &json!({ "error": "cannot create order" }))
        }
    }
}

fn order_status(orders: &Orders, request: Request, id: &str, token: Option<&str>) {
    match orders.status(id, token, state::now_secs()) {
        Ok(body) => respond_json(request, 200, &body),
        Err(status) => respond_json(request, status, &json!({ "error": "not found" })),
    }
}

fn download(orders: &Orders, request: Request, id: &str, token: &str) {
    match orders.open_download(id, token, state::now_secs()) {
        Ok(ready) => {
            let headers = vec![
                header("Content-Type", "application/octet-stream"),
                header(
                    "Content-Disposition",
                    &format!("attachment; filename=\"{}\"", ready.file_name),
                ),
                header("Cache-Control", "no-store"),
                header("Referrer-Policy", "no-referrer"),
                header("X-Robots-Tag", "noindex"),
                header("X-Content-Type-Options", "nosniff"),
            ];
            let length = usize::try_from(ready.length).ok();
            let response = Response::new(StatusCode(200), headers, ready.file, length, None);
            respond_hidden(request, response);
        }
        Err(410) => respond_json(
            request,
            410,
            &json!({ "error": "download link is no longer valid" }),
        ),
        Err(_) => respond_json(request, 404, &json!({ "error": "not found" })),
    }
}

fn licence(orders: &Orders, request: Request, id: &str, token: &str) {
    match orders.licence_document(id, token, state::now_secs()) {
        Ok(document) => {
            let slug = orders
                .licence_slug(id)
                .unwrap_or_else(|| "package".to_string());
            let headers = vec![
                header("Content-Type", "text/plain; charset=utf-8"),
                header(
                    "Content-Disposition",
                    &format!("attachment; filename=\"{slug}-LICENCE.txt\""),
                ),
                header("Cache-Control", "no-store"),
                header("X-Robots-Tag", "noindex"),
            ];
            let length = document.len();
            let response = Response::new(
                StatusCode(200),
                headers,
                std::io::Cursor::new(document.into_bytes()),
                Some(length),
                None,
            );
            respond_hidden(request, response);
        }
        Err(status) => respond_json(request, status, &json!({ "error": "not found" })),
    }
}

// ---------------------------------------------------------------------------
// On-chain poller
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct OpenOrder {
    list: String,
    chain: String,
    address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Incoming {
    txid: String,
    vout: u64,
    amount: u128,
    confirmations: u32,
}

/// Start the poller thread. Detached; process exit ends it.
pub(super) fn spawn_poller(
    orders: Arc<Orders>,
    tronscan_api_key: Option<String>,
    tron_limiter: Arc<tron_cache::Limiter>,
) {
    let _ = thread::Builder::new()
        .name("orders-poller".to_string())
        .spawn(move || {
            let agent = build_agent();
            let interval =
                Duration::from_secs(orders.config.poll_interval_secs.max(MIN_POLL_INTERVAL_SECS));
            loop {
                if let Err(err) =
                    poll_once(&orders, &agent, tronscan_api_key.as_deref(), &tron_limiter)
                {
                    eprintln!("rotor-coord: orders poller: {err}");
                }
                thread::sleep(interval);
            }
        });
}

fn poll_once(
    orders: &Orders,
    agent: &ureq::Agent,
    tronscan_key: Option<&str>,
    tron_limiter: &Arc<tron_cache::Limiter>,
) -> Result<usize, String> {
    let now = state::now_secs();
    orders.expire(now)?;
    let open = orders.open_orders();
    if open.is_empty() {
        return Ok(0);
    }
    let mut groups: HashMap<(String, String, Option<String>), Vec<OpenOrder>> = HashMap::new();
    for order in open {
        let contract = orders
            .config
            .list(&order.list)
            .and_then(|list| list.contract.clone());
        groups
            .entry((order.chain.clone(), order.address.clone(), contract))
            .or_default()
            .push(order);
    }
    let mut credits = 0usize;
    for ((chain, address, contract), _) in groups {
        let required = orders.config.confirmations_for(&chain);
        let incoming = match chain.as_str() {
            "btc" | "ltc" => {
                let Some(base) = orders.config.esplora_base(&chain) else {
                    continue;
                };
                fetch_esplora(agent, base, &address)?
            }
            "tron" => {
                let Some(key) = tronscan_key else {
                    eprintln!(
                        "rotor-coord: orders poller: TRONSCAN_API_KEY is unset; TRON orders stay awaiting_payment"
                    );
                    continue;
                };
                fetch_tron(
                    agent,
                    key,
                    &address,
                    contract.as_deref(),
                    required,
                    tron_limiter,
                )?
            }
            _ => continue,
        };
        credits += orders.apply_incoming(&chain, &address, &incoming, required, now)?;
    }
    Ok(credits)
}

fn build_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .user_agent("rotor-coord/2.0 orders-poller")
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .timeout_write(WRITE_TIMEOUT);
    if let Ok(connector) = ureq::native_tls::TlsConnector::new() {
        builder = builder.tls_connector(Arc::new(connector));
    }
    builder.build()
}

fn fetch_text(agent: &ureq::Agent, url: &str) -> Result<String, String> {
    let response = agent.get(url).call().map_err(|err| match err {
        ureq::Error::Status(status, _) => format!("upstream status {status}"),
        ureq::Error::Transport(_) => "upstream unreachable".to_string(),
    })?;
    let mut body = String::new();
    response
        .into_reader()
        .take(MAX_UPSTREAM_BYTES as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|_| "upstream response is unreadable".to_string())?;
    if body.len() > MAX_UPSTREAM_BYTES {
        return Err("upstream response exceeds the size limit".to_string());
    }
    Ok(body)
}

fn fetch_json(agent: &ureq::Agent, url: &str) -> Result<Value, String> {
    let body = fetch_text(agent, url)?;
    serde_json::from_str(&body).map_err(|_| "upstream response is not JSON".to_string())
}

fn fetch_esplora(agent: &ureq::Agent, base: &str, address: &str) -> Result<Vec<Incoming>, String> {
    let base = base.trim_end_matches('/');
    let tip: u64 = fetch_text(agent, &format!("{base}/api/blocks/tip/height"))?
        .trim()
        .parse()
        .map_err(|_| "upstream tip height is not a number".to_string())?;
    let value = fetch_json(agent, &format!("{base}/api/address/{address}/txs"))?;
    Ok(parse_esplora_txs(&value, address, tip))
}

fn fetch_tron(
    agent: &ureq::Agent,
    key: &str,
    address: &str,
    contract: Option<&str>,
    required: u32,
    tron_limiter: &Arc<tron_cache::Limiter>,
) -> Result<Vec<Incoming>, String> {
    if let Some(contract) = contract {
        let url = format!(
            "{TRONSCAN_API_BASE}/api/token_trc20/transfers?limit=50&start=0&contract_address={contract}&relatedAddress={address}"
        );
        let value = tronscan_get(agent, &[("TRON-PRO-API-KEY", key)], &url, tron_limiter)
            .map_err(|error| tron_error_reason(error).to_string())?;
        Ok(parse_trc20_transfers(&value, address, required))
    } else {
        let url = format!(
            "{TRONSCAN_API_BASE}/api/transaction?sort=-timestamp&count=true&limit=50&start=0&address={address}"
        );
        let value = tronscan_get(agent, &[("TRON-PRO-API-KEY", key)], &url, tron_limiter)
            .map_err(|error| tron_error_reason(error).to_string())?;
        Ok(parse_tron_transfers(&value, address, required))
    }
}

/// Extract outputs paying `address` from one Esplora address transaction list.
fn parse_esplora_txs(value: &Value, address: &str, tip: u64) -> Vec<Incoming> {
    let Some(transactions) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for transaction in transactions {
        let Some(txid) = transaction.get("txid").and_then(Value::as_str) else {
            continue;
        };
        let status = transaction.get("status");
        let confirmed = status
            .and_then(|status| status.get("confirmed"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let height = status
            .and_then(|status| status.get("block_height"))
            .and_then(Value::as_u64);
        let confirmations = if confirmed {
            height
                .map(|height| tip.saturating_sub(height) as u32 + 1)
                .unwrap_or(1)
        } else {
            0
        };
        let Some(outputs) = transaction.get("vout").and_then(Value::as_array) else {
            continue;
        };
        for (index, output) in outputs.iter().enumerate() {
            if output.get("scriptpubkey_address").and_then(Value::as_str) != Some(address) {
                continue;
            }
            let Some(amount) = output.get("value").and_then(Value::as_u64) else {
                continue;
            };
            out.push(Incoming {
                txid: txid.to_string(),
                vout: index as u64,
                amount: u128::from(amount),
                confirmations,
            });
        }
    }
    out
}

fn decimal_u128(value: Option<&Value>) -> Option<u128> {
    let value = value?;
    if let Some(number) = value.as_u64() {
        return Some(u128::from(number));
    }
    let text = value.as_str()?.trim();
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Native TRX transfers to `address` from the TronScan transaction list.
fn parse_tron_transfers(value: &Value, address: &str, required: u32) -> Vec<Incoming> {
    let Some(rows) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        if row.get("contractType").and_then(Value::as_i64) != Some(1) {
            continue;
        }
        if row.get("toAddress").and_then(Value::as_str) != Some(address) {
            continue;
        }
        if let Some(result) = row.get("contractRet").and_then(Value::as_str)
            && result != "SUCCESS"
        {
            continue;
        }
        let Some(txid) = row.get("hash").and_then(Value::as_str) else {
            continue;
        };
        let Some(amount) = decimal_u128(row.get("amount")) else {
            continue;
        };
        let confirmations = row
            .get("confirmations")
            .and_then(Value::as_u64)
            .map(|count| count as u32)
            .or_else(|| {
                row.get("confirmed")
                    .and_then(Value::as_bool)
                    .filter(|confirmed| *confirmed)
                    .map(|_| required)
            })
            .unwrap_or(0);
        out.push(Incoming {
            txid: txid.to_string(),
            vout: 0,
            amount,
            confirmations,
        });
    }
    out
}

/// TRC-20 transfers to `address`. TronScan only flags a transfer `confirmed`
/// once it is final; that is treated as satisfying the TRON threshold.
fn parse_trc20_transfers(value: &Value, address: &str, required: u32) -> Vec<Incoming> {
    let Some(rows) = value.get("token_transfers").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        if row.get("to_address").and_then(Value::as_str) != Some(address) {
            continue;
        }
        if let Some(result) = row.get("contractRet").and_then(Value::as_str)
            && result != "SUCCESS"
        {
            continue;
        }
        let Some(txid) = row.get("transaction_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(amount) = decimal_u128(row.get("quant")) else {
            continue;
        };
        let confirmations = if row
            .get("confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            required
        } else {
            0
        };
        out.push(Incoming {
            txid: txid.to_string(),
            vout: 0,
            amount,
            confirmations,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";

    fn config_text(active: bool) -> String {
        format!(
            r#"{{
                "lists": [{{
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
                }}],
                "confirmations": {{"btc": 3}},
                "quote_ttl_secs": 1800,
                "link_ttl_secs": 604800,
                "max_downloads": 5
            }}"#,
            "ab".repeat(32)
        )
    }

    fn entitlement(expires_at: u64, downloads: u32, max_downloads: u32) -> Entitlement {
        Entitlement {
            order_id: "o1".to_string(),
            list: "btc-pack".to_string(),
            token_hash: String::new(),
            nonce: "00".repeat(16),
            expires_at,
            max_downloads,
            downloads,
            revoked_at: None,
        }
    }

    #[test]
    fn quote_rounds_up_and_suffixes_stay_unique() {
        // $29 at $60,000/BTC in 8 decimals = 48_333.33 -> 48_334 sats.
        assert_eq!(quote_amount(2900, 60_000_000_000, 8), Some(48_334));
        assert_eq!(quote_amount(1, 1_000_000, 0), Some(1));
        assert_eq!(quote_amount(0, 1_000_000, 8), Some(0));
        assert_eq!(quote_amount(100, 0, 8), None);
        let base = 48_334;
        assert_eq!(allocate_amount(base, &[]), Some(base + 1));
        assert_eq!(allocate_amount(base, &[base + 1, base + 2]), Some(base + 3));
        let taken: Vec<u128> = (1..=MAX_AMOUNT_SUFFIX).map(|s| base + s).collect();
        assert_eq!(allocate_amount(base, &taken), None);
    }

    #[test]
    fn payment_matching_handles_exact_over_under_and_ambiguity() {
        let open = vec![
            ("first".to_string(), 1001u128),
            ("second".to_string(), 5002u128),
        ];
        assert_eq!(match_payment(1001, &open), Match::Exact("first".into()));
        assert_eq!(match_payment(5002, &open), Match::Exact("second".into()));
        assert_eq!(match_payment(4000, &open), Match::Overpaid("first".into()));
        assert_eq!(match_payment(9000, &open), Match::Ambiguous);
        let single = vec![("only".to_string(), 1001u128)];
        assert_eq!(match_payment(9000, &single), Match::Overpaid("only".into()));
        assert_eq!(match_payment(500, &single), Match::Under);
        let duplicate_amounts = vec![("a".to_string(), 1001u128), ("b".to_string(), 1001u128)];
        assert_eq!(match_payment(1001, &duplicate_amounts), Match::Ambiguous);
    }

    #[test]
    fn one_transaction_output_pays_one_order_only_once() {
        let payments = vec![Payment {
            order_id: "a".into(),
            chain: "btc".into(),
            txid: "deadbeef".into(),
            vout: 1,
            amount: "1001".into(),
            confirmations: 0,
            seen_at: 1,
            confirmed_at: None,
        }];
        assert!(duplicate_payment(&payments, "btc", "deadbeef", 1));
        assert!(!duplicate_payment(&payments, "btc", "deadbeef", 0));
        assert!(!duplicate_payment(&payments, "ltc", "deadbeef", 1));
        assert_eq!(payment_key("btc", "deadbeef", 1), "btc:deadbeef:1");
    }

    #[test]
    fn link_tokens_sign_verify_and_reject_tampering() {
        let nonce = "ab".repeat(16);
        let token = sign_link(SECRET, "order-1", "btc-pack", 2_000, &nonce);
        assert_eq!(
            verify_link(SECRET, "order-1", "btc-pack", &token, 1_999),
            LinkVerdict::Ok
        );
        assert_eq!(
            verify_link(SECRET, "order-1", "btc-pack", &token, 2_000),
            LinkVerdict::Expired
        );
        assert_eq!(
            verify_link(SECRET, "order-2", "btc-pack", &token, 1),
            LinkVerdict::Invalid
        );
        assert_eq!(
            verify_link(SECRET, "order-1", "eth-pack", &token, 1),
            LinkVerdict::Invalid
        );
        let mut tampered = token.clone();
        let last = tampered.pop().expect("mac digit");
        tampered.push(if last == '0' { '1' } else { '0' });
        assert_ne!(tampered, token);
        assert_eq!(
            verify_link(SECRET, "order-1", "btc-pack", &tampered, 1),
            LinkVerdict::Invalid
        );
        assert_eq!(
            verify_link(SECRET, "order-1", "btc-pack", "garbage", 1),
            LinkVerdict::Invalid
        );
    }

    #[test]
    fn download_gate_enforces_expiry_cap_and_revocation() {
        let now = 1_000;
        let fresh = entitlement(now + 10, 0, 5);
        assert_eq!(download_gate(&fresh, now), DownloadGate::Allowed);
        assert_eq!(download_gate(&fresh, now + 10), DownloadGate::Expired);
        let capped = entitlement(now + 10, 5, 5);
        assert_eq!(download_gate(&capped, now), DownloadGate::Exhausted);
        let mut revoked = fresh;
        revoked.revoked_at = Some(now);
        assert_eq!(download_gate(&revoked, now), DownloadGate::Revoked);
    }

    #[test]
    fn config_parsing_rejects_inactive_and_invalid_documents() {
        let config = OrdersConfig::parse(&config_text(true)).expect("valid config");
        assert!(config.active_list("btc-pack").is_some());
        assert_eq!(config.confirmations_for("btc"), 3);
        assert_eq!(config.confirmations_for("tron"), 19);
        assert_eq!(config.confirmations_for("ltc"), 6);

        let inactive = OrdersConfig::parse(&config_text(false)).expect("parse");
        assert!(inactive.active_list("btc-pack").is_none());
        assert!(inactive.list("btc-pack").is_some());

        let mut duplicate = config.clone();
        duplicate.lists.push(config.lists[0].clone());
        assert!(duplicate.validate().unwrap_err().contains("duplicate"));

        let mut bad_chain = config.clone();
        bad_chain.lists[0].chain = "doge".to_string();
        assert!(
            bad_chain
                .validate()
                .unwrap_err()
                .contains("unsupported chain")
        );

        let mut mixed_assets = config.clone();
        let mut native = config.lists[0].clone();
        native.slug = "trx-native".into();
        native.chain = "tron".into();
        native.address = "Tsame".into();
        native.contract = None;
        let mut token = native.clone();
        token.slug = "usdt-trc20".into();
        token.contract = Some("Tcontract".into());
        mixed_assets.lists = vec![native, token];
        assert!(
            mixed_assets
                .validate()
                .unwrap_err()
                .contains("same asset/contract")
        );

        assert!(OrdersConfig::parse("{}").is_err());
        assert!(OrdersConfig::parse("{ not json }").is_err());
    }

    #[test]
    fn esplora_parser_keeps_only_outputs_to_the_deposit_address() {
        let value = json!([{
            "txid": "aa",
            "status": {"confirmed": true, "block_height": 98},
            "vout": [
                {"scriptpubkey_address": "other", "value": 1},
                {"scriptpubkey_address": "ours", "value": 48335},
                {"scriptpubkey_address": "ours", "value": 10}
            ]
        }, {
            "txid": "bb",
            "status": {"confirmed": false},
            "vout": [{"scriptpubkey_address": "ours", "value": 5}]
        }]);
        let incoming = parse_esplora_txs(&value, "ours", 100);
        assert_eq!(
            incoming,
            vec![
                Incoming {
                    txid: "aa".into(),
                    vout: 1,
                    amount: 48_335,
                    confirmations: 3
                },
                Incoming {
                    txid: "aa".into(),
                    vout: 2,
                    amount: 10,
                    confirmations: 3
                },
                Incoming {
                    txid: "bb".into(),
                    vout: 0,
                    amount: 5,
                    confirmations: 0
                }
            ]
        );
    }

    #[test]
    fn tron_parsers_read_transfer_contracts_and_trc20_rows() {
        let native = json!({"data": [
            {"hash": "aa", "contractType": 1, "toAddress": "Tours", "amount": 48335,
             "contractRet": "SUCCESS", "confirmations": 19},
            {"hash": "bb", "contractType": 1, "toAddress": "Tother", "amount": 1},
            {"hash": "cc", "contractType": 31, "toAddress": "Tours", "amount": 1},
            {"hash": "dd", "contractType": 1, "toAddress": "Tours", "amount": 1,
             "contractRet": "REVERT"}
        ]});
        assert_eq!(
            parse_tron_transfers(&native, "Tours", 19),
            vec![Incoming {
                txid: "aa".into(),
                vout: 0,
                amount: 48_335,
                confirmations: 19
            }]
        );
        let trc20 = json!({"token_transfers": [
            {"transaction_id": "ee", "to_address": "Tours", "quant": "1000000",
             "contractRet": "SUCCESS", "confirmed": true},
            {"transaction_id": "ff", "to_address": "Tother", "quant": "1"}
        ]});
        assert_eq!(
            parse_trc20_transfers(&trc20, "Tours", 19),
            vec![Incoming {
                txid: "ee".into(),
                vout: 0,
                amount: 1_000_000,
                confirmations: 19
            }]
        );
    }

    #[test]
    fn incoming_payments_credit_once_and_late_payments_are_flagged() {
        let directory = std::env::temp_dir().join(format!(
            "rotor-orders-incoming-{}-{}",
            std::process::id(),
            state::now_secs()
        ));
        fs::create_dir_all(&directory).expect("temp directory");
        let orders = Orders::new(
            OrdersConfig::parse(&config_text(true)).expect("config"),
            SECRET,
            directory.join("orders.json"),
        )
        .expect("store");
        let order = orders
            .create(
                CreateOrderRequest {
                    list: "btc-pack".into(),
                    contact: None,
                },
                1_000,
            )
            .map_err(|_| "create")
            .expect("order");
        let amount: u128 = order.amount.parse().expect("amount");

        // One confirmation is not enough: the order is only confirming.
        let seen = vec![Incoming {
            txid: "aa".into(),
            vout: 1,
            amount,
            confirmations: 1,
        }];
        assert_eq!(
            orders
                .apply_incoming("btc", "bc1qexample", &seen, 3, 1_100)
                .expect("apply"),
            0
        );
        assert_eq!(orders.lock().orders[0].status, OrderStatus::Confirming);

        // Reaching the threshold pays it and creates one entitlement.
        let confirmed = vec![Incoming {
            confirmations: 3,
            ..seen[0].clone()
        }];
        assert_eq!(
            orders
                .apply_incoming("btc", "bc1qexample", &confirmed, 3, 1_200)
                .expect("apply"),
            1
        );
        assert_eq!(orders.lock().orders[0].status, OrderStatus::Paid);
        assert_eq!(orders.lock().entitlements.len(), 1);

        // The same (chain, txid, vout) never pays twice.
        assert_eq!(
            orders
                .apply_incoming("btc", "bc1qexample", &confirmed, 3, 1_300)
                .expect("apply"),
            0
        );
        assert_eq!(orders.lock().entitlements.len(), 1);

        // Underpayment stays awaiting; a late payment is flagged for support.
        let second = orders
            .create(
                CreateOrderRequest {
                    list: "btc-pack".into(),
                    contact: None,
                },
                1_000,
            )
            .map_err(|_| "create")
            .expect("order");
        let under = vec![Incoming {
            txid: "bb".into(),
            vout: 0,
            amount: second.amount.parse::<u128>().unwrap() - 1,
            confirmations: 6,
        }];
        assert_eq!(
            orders
                .apply_incoming("btc", "bc1qexample", &under, 3, 1_400)
                .expect("apply"),
            0
        );
        let late_paid = vec![Incoming {
            txid: "cc".into(),
            vout: 0,
            amount: second.amount.parse::<u128>().unwrap(),
            confirmations: 6,
        }];
        assert_eq!(
            orders
                .apply_incoming("btc", "bc1qexample", &late_paid, 3, 2_900)
                .expect("apply"),
            0
        );
        let data = orders.lock();
        let late = data
            .orders
            .iter()
            .find(|order| order.id == second.order_id)
            .expect("second order");
        assert_eq!(late.status, OrderStatus::LatePaid);
        assert_eq!(data.entitlements.len(), 1);
        drop(data);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn creating_an_order_allocates_a_unique_amount_and_hashes_the_token() {
        let directory = std::env::temp_dir().join(format!(
            "rotor-orders-unit-{}-{}",
            std::process::id(),
            state::now_secs()
        ));
        fs::create_dir_all(&directory).expect("temp directory");
        let store_path = directory.join("orders.json");
        let orders = Orders::new(
            OrdersConfig::parse(&config_text(true)).expect("config"),
            SECRET,
            store_path.clone(),
        )
        .expect("store");
        let first = orders
            .create(
                CreateOrderRequest {
                    list: "btc-pack".into(),
                    contact: None,
                },
                1_000,
            )
            .map_err(|_| "create")
            .expect("order");
        let second = orders
            .create(
                CreateOrderRequest {
                    list: "btc-pack".into(),
                    contact: Some("buyer@example.com".into()),
                },
                1_000,
            )
            .map_err(|_| "create")
            .expect("order");
        assert_ne!(first.amount, second.amount);
        assert_eq!(first.expires_at, 2_800);
        // The raw order token is never stored, only its hash.
        let text = fs::read_to_string(&store_path).expect("store file");
        assert!(!text.contains(&first.order_token));
        assert!(text.contains(&hex(&crate::hashes::sha256(first.order_token.as_bytes()))));
        // Unknown and inactive lists are refused.
        assert!(matches!(
            orders.create(
                CreateOrderRequest {
                    list: "nope".into(),
                    contact: None
                },
                1_000
            ),
            Err(CreateError::UnknownList)
        ));
        let inactive = Orders::new(
            OrdersConfig::parse(&config_text(false)).expect("config"),
            SECRET,
            directory.join("orders-inactive.json"),
        )
        .expect("store");
        assert!(matches!(
            inactive.create(
                CreateOrderRequest {
                    list: "btc-pack".into(),
                    contact: None
                },
                1_000
            ),
            Err(CreateError::UnknownList)
        ));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn licence_document_renders_mit_and_configured_provenance() {
        let config = OrdersConfig::parse(&config_text(true)).expect("config");
        assert_eq!(config.lists[0].licence, "MIT");
        assert!(config.lists[0].provenance.is_none());

        let document = render_licence_document(&config.lists[0]);
        assert!(document.contains("Bitcoin package (btc-pack)"));
        assert!(document.contains("Licence: MIT"));
        assert!(document.contains("Copyright (c) 2026 the Rotor project contributors"));
        assert!(!document.contains("Provenance:"));

        let mut donor = config.clone();
        donor.lists[0].provenance =
            Some("Curated from the mirrored Rich-Address-Wallet release files.".to_string());
        let document = render_licence_document(&donor.lists[0]);
        assert!(document.contains("Provenance: Curated from the mirrored Rich-Address-Wallet"));
        assert!(document.contains("Copyright (c) 2022 MMDRZA"));
    }

    #[test]
    fn licence_document_renders_cc0_notice() {
        let mut config = OrdersConfig::parse(&config_text(true)).expect("config");
        config.lists[0].licence = "CC0-1.0".to_string();
        let document = render_licence_document(&config.lists[0]);
        assert!(document.contains("Licence: CC0-1.0"));
        assert!(document.contains("CC0 1.0 Universal"));
        assert!(document.contains("https://creativecommons.org/publicdomain/zero/1.0/"));
    }

    #[test]
    fn licence_document_requires_the_order_and_its_token() {
        let directory = std::env::temp_dir().join(format!(
            "rotor-orders-licence-{}-{}",
            std::process::id(),
            state::now_secs()
        ));
        fs::create_dir_all(&directory).expect("temp directory");
        let orders = Orders::new(
            OrdersConfig::parse(&config_text(true)).expect("config"),
            SECRET,
            directory.join("orders.json"),
        )
        .expect("store");
        let order = orders
            .create(
                CreateOrderRequest {
                    list: "btc-pack".into(),
                    contact: None,
                },
                1_000,
            )
            .map_err(|_| "create")
            .expect("order");

        assert_eq!(
            orders.licence_document("missing", &order.order_token, 1_000),
            Err(404)
        );
        assert_eq!(
            orders.licence_document(&order.order_id, "wrong", 1_000),
            Err(404)
        );
        let document = orders
            .licence_document(&order.order_id, &order.order_token, 1_000)
            .expect("document");
        assert!(document.contains("Bitcoin package (btc-pack)"));
        assert!(document.contains("Licence: MIT"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn config_validation_rejects_bad_licence_and_provenance() {
        let config = OrdersConfig::parse(&config_text(true)).expect("config");

        let mut empty = config.clone();
        empty.lists[0].licence = String::new();
        assert!(empty.validate().unwrap_err().contains("licence"));

        let mut blank = config.clone();
        blank.lists[0].licence = " ".to_string();
        assert!(blank.validate().unwrap_err().contains("licence"));

        let mut oversized = config.clone();
        oversized.lists[0].licence = "a".repeat(33);
        assert!(oversized.validate().unwrap_err().contains("licence"));

        let mut illegal = config.clone();
        illegal.lists[0].licence = "MIT/x".to_string();
        assert!(illegal.validate().unwrap_err().contains("licence"));

        let mut control = config.clone();
        control.lists[0].provenance = Some("bad\u{0}text".to_string());
        assert!(control.validate().unwrap_err().contains("provenance"));

        let mut valid = config;
        valid.lists[0].licence = "CC0-1.0".to_string();
        valid.lists[0].provenance = Some("Derived from donor-provided data.".to_string());
        assert!(valid.validate().is_ok());
    }
}
