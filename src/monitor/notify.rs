//! Telegram alert linking and delivery for the address monitor.
//!
//! The watcher never talks to Telegram. It records events; a detached delivery
//! worker claims them in id order and sends a short message per event. Claiming
//! persists each account's cursor before the send, so a restart cannot replay
//! an already claimed event.
//!
//! The Bot API base is configurable through `ROTOR_TELEGRAM_API_BASE` so tests
//! can point at a local mock server. Tokens are never logged or embedded in
//! error messages.

use std::io::Read;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::json;

use crate::monitor::auth::iso8601;
use crate::monitor::store::{Event, MonitorStore};

/// Default Telegram Bot API origin.
pub const DEFAULT_API_BASE: &str = "https://api.telegram.org";
/// Per-request timeout (the task caps delivery at eight seconds).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// How long the delivery worker waits between store scans.
const DELIVERY_INTERVAL: Duration = Duration::from_secs(1);
/// Maximum events claimed per delivery pass.
const DELIVERY_BATCH: usize = 50;
/// Largest Bot API response buffered.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// Telegram configuration from the environment.
#[derive(Debug, Clone)]
pub struct TelegramConfig {
    pub bot_token: String,
    pub bot_username: String,
    pub api_base: String,
}

impl TelegramConfig {
    /// Read `ROTOR_TELEGRAM_*`. The feature is disabled when the token or the
    /// username is empty.
    pub fn from_env() -> Self {
        let token = std::env::var("ROTOR_TELEGRAM_BOT_TOKEN")
            .unwrap_or_default()
            .trim()
            .to_string();
        let username = std::env::var("ROTOR_TELEGRAM_BOT_USERNAME")
            .unwrap_or_default()
            .trim()
            .trim_start_matches('@')
            .to_string();
        let base = std::env::var("ROTOR_TELEGRAM_API_BASE")
            .unwrap_or_default()
            .trim()
            .trim_end_matches('/')
            .to_string();
        Self {
            bot_token: token,
            bot_username: username,
            api_base: if base.is_empty() {
                DEFAULT_API_BASE.to_string()
            } else {
                base
            },
        }
    }

    /// Both a token and a public username are required.
    pub fn is_enabled(&self) -> bool {
        !self.bot_token.is_empty() && !self.bot_username.is_empty()
    }

    /// Deep link that starts a chat and submits the linking code.
    pub fn deep_link(&self, code: &str) -> String {
        format!(
            "https://t.me/{}?start={}",
            self.bot_username.trim_start_matches('@'),
            code
        )
    }

    /// Absolute webhook URL for `setWebhook`.
    pub fn webhook_url(&self, public_url: &str) -> String {
        format!(
            "{}/api/v1/telegram/webhook",
            public_url.trim_end_matches('/')
        )
    }

    /// Build a sender bound to this configuration.
    pub fn sender(&self) -> TelegramSender {
        TelegramSender::new(&self.api_base, &self.bot_token)
    }

    /// Register the webhook with Telegram. Errors never contain the token.
    pub fn register_webhook(&self, public_url: &str, secret: &str) -> Result<(), String> {
        self.sender()
            .set_webhook(&self.webhook_url(public_url), secret)
    }
}

/// HTTP sender for the Telegram Bot API.
#[derive(Clone)]
pub struct TelegramSender {
    api_base: String,
    token: String,
    agent: ureq::Agent,
}

struct SendFailure {
    message: String,
    retry: bool,
}

impl TelegramSender {
    pub fn new(api_base: &str, token: &str) -> Self {
        let agent = ureq::AgentBuilder::new()
            .user_agent("rotor-monitor/1.0")
            .timeout_connect(REQUEST_TIMEOUT)
            .timeout_read(REQUEST_TIMEOUT)
            .timeout_write(REQUEST_TIMEOUT)
            .build();
        Self {
            api_base: api_base.trim_end_matches('/').to_string(),
            token: token.to_string(),
            agent,
        }
    }

    fn url(&self, method: &str) -> String {
        format!("{}/bot{}/{}", self.api_base, self.token, method)
    }

    /// Send one message, retrying once on a transient failure.
    pub fn send_message(&self, chat_id: i64, text: &str) -> Result<(), String> {
        let body = json!({
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": true,
        })
        .to_string();
        match self.post("sendMessage", &body) {
            Ok(()) => Ok(()),
            Err(failure) if failure.retry => {
                thread::sleep(Duration::from_millis(250));
                self.post("sendMessage", &body)
                    .map_err(|failure| failure.message)
            }
            Err(failure) => Err(failure.message),
        }
    }

    /// Register or update the Bot API webhook.
    pub fn set_webhook(&self, url: &str, secret: &str) -> Result<(), String> {
        let body = json!({
            "url": url,
            "secret_token": secret,
            "allowed_updates": ["message"],
        })
        .to_string();
        match self.post("setWebhook", &body) {
            Ok(()) => Ok(()),
            Err(failure) if failure.retry => {
                thread::sleep(Duration::from_millis(250));
                self.post("setWebhook", &body)
                    .map_err(|failure| failure.message)
            }
            Err(failure) => Err(failure.message),
        }
    }

    /// POST a JSON body. The URL and token are never included in errors.
    fn post(&self, method: &str, body: &str) -> Result<(), SendFailure> {
        let response = match self
            .agent
            .post(&self.url(method))
            .set("Content-Type", "application/json")
            .send_string(body)
        {
            Ok(response) => response,
            Err(ureq::Error::Status(code, _)) => {
                return Err(SendFailure {
                    message: format!("Telegram API returned HTTP {code}"),
                    retry: code == 429 || code >= 500,
                });
            }
            Err(ureq::Error::Transport(_)) => {
                return Err(SendFailure {
                    message: "Telegram API request failed".to_string(),
                    retry: true,
                });
            }
        };
        // Drain the body so the connection can be reused; content is unused.
        let mut sink = Vec::new();
        let _ = response
            .into_reader()
            .take(MAX_RESPONSE_BYTES as u64 + 1)
            .read_to_end(&mut sink);
        Ok(())
    }
}

/// A short, key-free alert message.
pub fn format_alert(event: &Event) -> String {
    format!(
        "Monitor alert: {} ({})\nChain: {}\nAddress: {}\nDetail: {}\nTime: {}",
        event.kind,
        event.severity,
        event.chain,
        event.address,
        event.detail,
        iso8601(event.at)
    )
}

/// Claim and deliver one batch of pending alerts. Returns how many were sent.
pub fn deliver_once(store: &MonitorStore, sender: &TelegramSender) -> Result<usize, String> {
    let alerts = store.claim_alerts(DELIVERY_BATCH)?;
    let mut sent = 0;
    for alert in alerts {
        let text = format_alert(&alert.event);
        match sender.send_message(alert.chat_id, &text) {
            Ok(()) => sent += 1,
            Err(message) => {
                // No token, chat id or address in the log line.
                eprintln!("rotor-coord: telegram delivery failed: {message}");
            }
        }
    }
    Ok(sent)
}

/// Start the detached delivery worker. Returns `None` when Telegram is not
/// configured, so callers can skip the thread entirely.
pub fn spawn(store: Arc<MonitorStore>, config: TelegramConfig) -> Option<JoinHandle<()>> {
    if !config.is_enabled() {
        return None;
    }
    Some(thread::spawn(move || {
        let sender = config.sender();
        loop {
            if let Err(message) = deliver_once(&store, &sender) {
                eprintln!("rotor-coord: telegram delivery: {message}");
            }
            thread::sleep(DELIVERY_INTERVAL);
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, MutexGuard};
    use std::time::{SystemTime, UNIX_EPOCH};

    const ADDRESS: &str = "0x1111111111111111111111111111111111111111";

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
                "rotor-monitor-notify-{}-{nanos}-{tag}.json",
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

    /// Minimal Bot API mock: records every JSON body and answers `ok`.
    struct MockTelegram {
        base: String,
        bodies: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl MockTelegram {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
            listener.set_nonblocking(true).expect("nonblocking");
            let base = format!("http://{}", listener.local_addr().expect("addr"));
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let recorded = Arc::clone(&bodies);
            let stopping = Arc::clone(&stop);
            let handle = thread::spawn(move || {
                while !stopping.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                            let body = read_http_body(&mut stream);
                            recorded.lock().expect("bodies").push(body);
                            let response = "HTTP/1.1 200 OK\r\n\
                                Content-Type: application/json\r\n\
                                Content-Length: 11\r\n\
                                Connection: close\r\n\r\n{\"ok\":true}";
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                base,
                bodies,
                stop,
                handle: Some(handle),
            }
        }

        fn bodies(&self) -> MutexGuard<'_, Vec<String>> {
            self.bodies.lock().expect("bodies")
        }
    }

    impl Drop for MockTelegram {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn read_http_body(stream: &mut std::net::TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = stream.read(&mut chunk).unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some((head, body_start)) = split_headers(&buffer) {
                let length = String::from_utf8_lossy(head)
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if buffer.len() >= body_start + length {
                    return String::from_utf8_lossy(&buffer[body_start..body_start + length])
                        .into_owned();
                }
            }
            if buffer.len() > 64 * 1024 {
                break;
            }
        }
        String::new()
    }

    fn split_headers(buffer: &[u8]) -> Option<(&[u8], usize)> {
        buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| (&buffer[..position], position + 4))
    }

    fn config(base: &str) -> TelegramConfig {
        TelegramConfig {
            bot_token: "test-token".to_string(),
            bot_username: "test_bot".to_string(),
            api_base: base.to_string(),
        }
    }

    #[test]
    fn format_alert_has_the_expected_fields() {
        let event = Event {
            id: 7,
            user_id: "u_1".to_string(),
            chain: "btc".to_string(),
            address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa".to_string(),
            kind: "incoming".to_string(),
            severity: "info".to_string(),
            detail: "balance 0 -> 1000 sats".to_string(),
            at: 1_700_000_000,
            seen: false,
        };
        let text = format_alert(&event);
        assert!(text.contains("incoming (info)"));
        assert!(text.contains("btc"));
        assert!(text.contains("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
        assert!(text.contains("balance 0 -> 1000 sats"));
    }

    #[test]
    fn delivery_sends_once_and_respects_settings_and_unlink() {
        let temp = TempStore::new("delivery");
        let mock = MockTelegram::start();
        let sender = config(&mock.base).sender();
        let user = temp.store.upsert_user(ADDRESS).expect("user");
        temp.store.link_telegram(&user.id, 424242).expect("link");

        temp.store
            .record_event(&user.id, "btc", ADDRESS, "incoming", "info", "first")
            .expect("record")
            .expect("event");
        assert_eq!(deliver_once(&temp.store, &sender).expect("deliver"), 1);
        {
            let bodies = mock.bodies();
            assert_eq!(bodies.len(), 1);
            assert!(bodies[0].contains("\"chat_id\":424242"));
            assert!(bodies[0].contains("incoming"));
        }
        // Already claimed: no duplicate.
        assert_eq!(deliver_once(&temp.store, &sender).expect("deliver"), 0);

        // Alerts disabled: the event is consumed without a message.
        temp.store
            .update_settings(&user.id, None, Some(false))
            .expect("settings");
        temp.store
            .record_event(&user.id, "btc", ADDRESS, "incoming", "info", "second")
            .expect("record");
        assert_eq!(deliver_once(&temp.store, &sender).expect("deliver"), 0);
        assert_eq!(mock.bodies().len(), 1);

        // Unlinked: nothing is delivered again.
        temp.store
            .update_settings(&user.id, None, Some(true))
            .expect("settings");
        temp.store.unlink_telegram(&user.id).expect("unlink");
        temp.store
            .record_event(&user.id, "btc", ADDRESS, "incoming", "info", "third")
            .expect("record");
        assert_eq!(deliver_once(&temp.store, &sender).expect("deliver"), 0);
        assert_eq!(mock.bodies().len(), 1);
    }
}
