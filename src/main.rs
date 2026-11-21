use rotor::chain::Family;
use rotor::cli::{self, SearchMode, USAGE, VERSION_LINE};
use rotor::engine;

fn main() {
    #[cfg(windows)]
    rotor::selfupdate::cleanup_old();

    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() {
        print!("{USAGE}");
        return;
    }

    let config = match cli::parse_from(args) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("  Error: {err}");
            std::process::exit(1);
        }
    };

    if config.coin_deprecated {
        eprintln!(
            "  Warning: --coin is deprecated; use --chain bitcoin or --chain ethereum instead."
        );
    }

    if config.help {
        print!("{USAGE}");
        return;
    }

    if config.version {
        println!("{VERSION_LINE}");
        return;
    }

    if config.list_chains {
        print!("{}", cli::list_chains_text());
        return;
    }

    if config.list {
        #[cfg(feature = "gpu")]
        {
            match rotor::gpu::device_count() {
                Ok(count) => {
                    println!("  CUDA devices: {count}");
                    for index in 0..count {
                        match rotor::gpu::device_name(index) {
                            Ok(name) => println!("  GPU #{index}: {name}"),
                            Err(err) => {
                                eprintln!("  Error: {err}");
                                std::process::exit(2);
                            }
                        }
                    }
                }
                Err(err) => {
                    eprintln!("  Error: {err}");
                    std::process::exit(2);
                }
            }
        }
        #[cfg(not(feature = "gpu"))]
        println!("  GPU support is not compiled into this binary; rebuild with --features gpu.");
        return;
    }

    if config.check {
        println!("  Rotor-Cuda v{}", cli::RELEASE);
        println!();
        println!("  Checking... Secp256K1");
        println!();
        let ok = rotor::selfcheck::run();
        std::process::exit(if ok { 0 } else { 1 });
    }

    if config.check_update || config.update {
        #[cfg(windows)]
        {
            let current = rotor::selfupdate::VERSION;
            match rotor::selfupdate::check_latest("mytab0r/Rotor-Cuda", current) {
                Ok(info) => {
                    if config.check_update {
                        let status = if info.available {
                            "UPDATE AVAILABLE (run --update)"
                        } else {
                            "up to date"
                        };
                        println!(" current: {current}  latest: {}  ->  {status}", info.latest);
                        return;
                    }
                    if !info.available {
                        println!(" already up to date ({current})");
                        return;
                    }
                    println!(" updating {current} -> {} ...", info.latest);
                    let update_args: Vec<String> = std::env::args().skip(1).collect();
                    if let Err(err) = rotor::selfupdate::apply_update(&info, &update_args, true) {
                        println!(" update failed: {err}");
                        std::process::exit(1);
                    }
                    return;
                }
                Err(err) => {
                    println!(" update check failed: {err}");
                    std::process::exit(1);
                }
            }
        }
        #[cfg(not(windows))]
        {
            println!(" self-update is not supported on this platform");
            std::process::exit(2);
        }
    }

    if config.gpu && !cfg!(feature = "gpu") {
        eprintln!(
            "  Error: GPU support is not compiled into this binary; rebuild with --features gpu"
        );
        std::process::exit(2);
    }

    if config.benchmark {
        match rotor::benchmark::run(&config) {
            Ok(code) => std::process::exit(code),
            Err(err) => {
                eprintln!("  Error: {err}");
                std::process::exit(1);
            }
        }
    }

    if config.mnemonic_derive || config.mnemonic_from_entropy.is_some() || config.mnemonic_audit {
        let outcome = if config.mnemonic_audit {
            rotor::mnemonic::run_audit(&config)
        } else if let Some(hex) = config.mnemonic_from_entropy.as_deref() {
            rotor::mnemonic::run_from_entropy(hex)
        } else {
            rotor::mnemonic::run_derive(
                config
                    .mnemonic
                    .as_deref()
                    .expect("--mnemonic-derive was validated"),
                &config.mnemonic_passphrase,
                config
                    .mnemonic_path
                    .as_deref()
                    .unwrap_or(rotor::mnemonic::DEFAULT_PATH),
            )
        };
        if let Err(err) = outcome {
            eprintln!("  Error: {err}");
            std::process::exit(1);
        }
        return;
    }

    if config.mode.is_some() || !config.operands.is_empty() {
        match (config.mode, config.chain.family) {
            (
                Some(
                    SearchMode::Address
                    | SearchMode::Addresses
                    | SearchMode::XPoint
                    | SearchMode::XPoints,
                ),
                Family::SecpHash160,
            )
            | (Some(SearchMode::Address | SearchMode::Addresses), Family::EvmKeccak) => {
                #[cfg(feature = "gpu")]
                if config.gpu {
                    match rotor::gpu_search::run(&config) {
                        Ok(_) => std::process::exit(0),
                        Err(err) => {
                            eprintln!("  Error: {err}");
                            std::process::exit(1);
                        }
                    }
                }
                let outcome = if config.coordinator.is_some() {
                    engine::run_coordinator(&config)
                } else {
                    engine::run(&config)
                };
                if let Err(err) = outcome {
                    eprintln!("  Error: {err}");
                    std::process::exit(1);
                }
            }
            (Some(SearchMode::Bsgs), Family::SecpHash160 | Family::EvmKeccak) => {
                match rotor::bsgs::run_cli(&config) {
                    Ok(code) => std::process::exit(code),
                    Err(err) => {
                        eprintln!("  Error: {err}");
                        std::process::exit(1);
                    }
                }
            }
            _ => {
                let mode = config.mode.unwrap_or(SearchMode::Address);
                eprintln!(
                    "  Error: {}",
                    cli::unsupported_mode_message(config.chain, mode)
                );
                std::process::exit(2);
            }
        }
        return;
    }

    eprintln!("  Error: Missing arguments");
    std::process::exit(1);
}
