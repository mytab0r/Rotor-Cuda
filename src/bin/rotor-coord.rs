//! `rotor-coord`: run the distributed coordinator.
//!
//! The admin token comes from `--token` or `ROTOR_COORD_TOKEN`; `--clients`
//! maps client ids to SHA-256 token hashes. The state file is a single
//! atomically written JSON document. TLS is not implemented — bind to loopback
//! and use a reverse proxy for remote clients.

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use rotor::coordinator::{self, Clients, ServerOptions};
use rotor::monitor::notify::{self, TelegramConfig};
use rotor::monitor::store::MonitorStore;
use rotor::monitor::watcher::{self, WatcherConfig};

const USAGE: &str = "\
rotor-coord - distributed rotor coordinator

Usage: rotor-coord [OPTIONS]
  --bind ADDR            listen address (default 127.0.0.1:7878)
  --token TOKEN          admin API token (or ROTOR_COORD_TOKEN)
  --clients FILE         client token map { \"client-id\": \"<sha256 hex>\" }
  --open-registration    allow public POST /api/v1/register (1/min per IP)
  --state PATH           state file (default coordinator.json)
  --monitor-state PATH   monitor store file (default monitor.json)
  --monitor-interval N   EVM poll interval in seconds, min 10 (default 300)
  --monitor-rpc URL      EVM JSON-RPC endpoint
                         (default https://ethereum-rpc.publicnode.com)
  --monitor-btc-rpc URL  Bitcoin address API base
                         (default https://mempool.space)
  --monitor-domain HOST  fixed SIWE domain shown in login challenges
                         (default localhost; never taken from Host)
  --trust-proxy          trust CF-Connecting-IP / X-Forwarded-For for rate
                         limits (only behind a reverse proxy; default off)
  -h, --help             show this help
";

struct Options {
    bind: String,
    token: String,
    clients: Option<PathBuf>,
    open_registration: bool,
    state: PathBuf,
    monitor_state: PathBuf,
    monitor_interval: u64,
    monitor_rpc: String,
    monitor_btc_rpc: String,
    monitor_domain: String,
    trust_proxy: bool,
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match parse(&args) {
        Ok(Some(options)) => run(options),
        Ok(None) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("rotor-coord: {message}");
            ExitCode::from(2)
        }
    }
}

fn parse(args: &[String]) -> Result<Option<Options>, String> {
    let mut bind = "127.0.0.1:7878".to_string();
    let mut token = None;
    let mut clients = None;
    let mut open_registration = false;
    let mut state = PathBuf::from("coordinator.json");
    let mut monitor_state = PathBuf::from("monitor.json");
    let mut monitor_interval = 300u64;
    let mut monitor_rpc = "https://ethereum-rpc.publicnode.com".to_string();
    let mut monitor_btc_rpc = "https://mempool.space".to_string();
    let mut monitor_domain = "localhost".to_string();
    let mut trust_proxy = false;

    let mut index = 0;
    while index < args.len() {
        let argument = args[index].clone();
        let (name, inline) = match argument.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (argument, None),
        };

        let value = |index: &mut usize| -> Result<String, String> {
            if let Some(value) = inline.clone() {
                return Ok(value);
            }
            *index += 1;
            args.get(*index)
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };

        match name.as_str() {
            "-h" | "--help" => return Ok(None),
            "--bind" => bind = value(&mut index)?,
            "--token" => token = Some(value(&mut index)?),
            "--clients" => clients = Some(PathBuf::from(value(&mut index)?)),
            "--open-registration" => open_registration = true,
            "--state" => state = PathBuf::from(value(&mut index)?),
            "--monitor-state" => monitor_state = PathBuf::from(value(&mut index)?),
            "--monitor-interval" => {
                monitor_interval = value(&mut index)?
                    .parse::<u64>()
                    .map_err(|err| format!("--monitor-interval must be a number: {err}"))?;
            }
            "--monitor-rpc" => monitor_rpc = value(&mut index)?,
            "--monitor-btc-rpc" => monitor_btc_rpc = value(&mut index)?,
            "--monitor-domain" => monitor_domain = value(&mut index)?,
            "--trust-proxy" => trust_proxy = true,
            other => return Err(format!("unknown argument: {other}\n\n{USAGE}")),
        }
        index += 1;
    }

    let token = match token.or_else(|| env::var("ROTOR_COORD_TOKEN").ok()) {
        Some(token) if !token.is_empty() => token,
        _ => return Err("--token or ROTOR_COORD_TOKEN is required".to_string()),
    };
    if monitor_interval < 10 {
        return Err("--monitor-interval must be at least 10 seconds".to_string());
    }
    if monitor_rpc.trim().is_empty() {
        return Err("--monitor-rpc must not be empty".to_string());
    }
    if monitor_btc_rpc.trim().is_empty() {
        return Err("--monitor-btc-rpc must not be empty".to_string());
    }
    let monitor_domain = rotor::monitor::auth::normalize_domain(&monitor_domain)
        .map_err(|err| format!("--monitor-domain: {err}"))?;

    Ok(Some(Options {
        bind,
        token,
        clients,
        open_registration,
        state,
        monitor_state,
        monitor_interval,
        monitor_rpc,
        monitor_btc_rpc,
        monitor_domain,
        trust_proxy,
    }))
}

fn run(options: Options) -> ExitCode {
    if !is_loopback(&options.bind) {
        eprintln!(
            "warning: binding {} is not loopback; the coordinator has no TLS. Put it behind a reverse proxy.",
            options.bind
        );
    }
    let clients = match options.clients.as_deref() {
        Some(path) => match Clients::load(path) {
            Ok(clients) => clients,
            Err(message) => {
                eprintln!("rotor-coord: {message}");
                return ExitCode::from(1);
            }
        },
        None => Clients::default(),
    };
    if clients.is_empty() {
        println!(
            "clients: none imported; accounts come from the state file (single-token legacy mode only while it has no accounts)"
        );
    } else {
        println!(
            "clients: {} imported from the file on first start",
            clients.len()
        );
    }
    if options.open_registration {
        println!("open registration: enabled (1/min per IP)");
    }
    if options.trust_proxy {
        println!("trust proxy: CF-Connecting-IP / X-Forwarded-For used for rate limits");
    }
    let monitor = match MonitorStore::open(&options.monitor_state) {
        Ok(monitor) => Arc::new(monitor),
        Err(message) => {
            eprintln!("rotor-coord: {message}");
            return ExitCode::from(1);
        }
    };
    let server_options = ServerOptions {
        open_registration: options.open_registration,
        trust_proxy: options.trust_proxy,
        monitor_domain: options.monitor_domain.clone(),
    };
    // Telegram alerts are optional. The coordinator reads the same environment
    // for its webhook route; this copy drives registration and delivery.
    let telegram = TelegramConfig::from_env();
    match coordinator::spawn_with_monitor_options(
        &options.bind,
        &options.state,
        options.token,
        clients,
        server_options,
        Arc::clone(&monitor),
    ) {
        Ok(handle) => {
            println!("rotor-coord listening on http://{}", handle.addr);
            println!("state: {}", options.state.display());
            println!("monitor state: {}", options.monitor_state.display());
            println!(
                "monitor watcher: every {}s via {} (BTC via {})",
                options.monitor_interval, options.monitor_rpc, options.monitor_btc_rpc
            );
            if telegram.is_enabled() {
                let webhook = telegram.webhook_url(&coordinator::public_url());
                start_telegram(&monitor, telegram);
                println!("telegram: alerts enabled; webhook {webhook}");
            } else {
                println!(
                    "telegram: disabled (set ROTOR_TELEGRAM_BOT_TOKEN and ROTOR_TELEGRAM_BOT_USERNAME)"
                );
            }
            let _watcher = watcher::spawn(
                Arc::clone(&monitor),
                WatcherConfig {
                    interval_secs: options.monitor_interval,
                    rpc_url: options.monitor_rpc,
                    btc_api_url: options.monitor_btc_rpc,
                },
            );
            loop {
                std::thread::park();
            }
        }
        Err(message) => {
            eprintln!("rotor-coord: {message}");
            ExitCode::from(1)
        }
    }
}

/// Persist the webhook secret, register the webhook in the background and
/// start the delivery worker. Failures are logged without the bot token.
fn start_telegram(monitor: &Arc<MonitorStore>, telegram: TelegramConfig) {
    let secret = match monitor.ensure_webhook_secret() {
        Ok(secret) => Some(secret),
        Err(message) => {
            eprintln!("rotor-coord: telegram webhook secret: {message}");
            None
        }
    };
    if let Some(secret) = secret {
        let config = telegram.clone();
        let url_base = coordinator::public_url();
        std::thread::spawn(move || match config.register_webhook(&url_base, &secret) {
            Ok(()) => eprintln!("rotor-coord: telegram webhook registered"),
            Err(message) => {
                eprintln!("rotor-coord: telegram webhook registration failed: {message}")
            }
        });
    }
    let _delivery = notify::spawn(Arc::clone(monitor), telegram);
}

fn is_loopback(bind: &str) -> bool {
    let host = match bind.rsplit_once(':') {
        Some((host, _)) => host,
        None => bind,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}
