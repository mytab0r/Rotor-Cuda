//! `rotor-coord`: run the distributed coordinator.
//!
//! The token comes from `--token` or `ROTOR_COORD_TOKEN`; the state file is a
//! single atomically written JSON document. TLS is not implemented — bind to
//! loopback and use a reverse proxy for remote clients.

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use rotor::coordinator;

const USAGE: &str = "\
rotor-coord - distributed rotor coordinator

Usage: rotor-coord [OPTIONS]
  --bind ADDR     listen address (default 127.0.0.1:7878)
  --token TOKEN   API token (or ROTOR_COORD_TOKEN)
  --state PATH    state file (default coordinator.json)
  -h, --help      show this help
";

struct Options {
    bind: String,
    token: String,
    state: PathBuf,
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
    let mut state = PathBuf::from("coordinator.json");

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
            "--state" => state = PathBuf::from(value(&mut index)?),
            other => return Err(format!("unknown argument: {other}\n\n{USAGE}")),
        }
        index += 1;
    }

    let token = match token.or_else(|| env::var("ROTOR_COORD_TOKEN").ok()) {
        Some(token) if !token.is_empty() => token,
        _ => return Err("--token or ROTOR_COORD_TOKEN is required".to_string()),
    };

    Ok(Some(Options { bind, token, state }))
}

fn run(options: Options) -> ExitCode {
    if !is_loopback(&options.bind) {
        eprintln!(
            "warning: binding {} is not loopback; the coordinator has no TLS. Put it behind a reverse proxy.",
            options.bind
        );
    }
    match coordinator::spawn(&options.bind, &options.state, options.token) {
        Ok(handle) => {
            println!("rotor-coord listening on http://{}", handle.addr);
            println!("state: {}", options.state.display());
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

fn is_loopback(bind: &str) -> bool {
    let host = match bind.rsplit_once(':') {
        Some((host, _)) => host,
        None => bind,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}
