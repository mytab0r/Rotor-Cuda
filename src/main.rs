use rotor::cli::{self, Coin, SearchMode, USAGE, VERSION_LINE};
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

    if config.help {
        print!("{USAGE}");
        return;
    }

    if config.version {
        println!("{VERSION_LINE}");
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

    if config.mode.is_some() || !config.operands.is_empty() {
        match (config.mode, config.coin) {
            (
                Some(
                    SearchMode::Address
                    | SearchMode::Addresses
                    | SearchMode::XPoint
                    | SearchMode::XPoints,
                ),
                Coin::Btc,
            )
            | (Some(SearchMode::Address | SearchMode::Addresses), Coin::Eth) => {
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
                if let Err(err) = engine::run(&config) {
                    eprintln!("  Error: {err}");
                    std::process::exit(1);
                }
            }
            (Some(SearchMode::Bsgs), Coin::Btc | Coin::Eth) => {
                match rotor::bsgs::run_cli(&config) {
                    Ok(code) => std::process::exit(code),
                    Err(err) => {
                        eprintln!("  Error: {err}");
                        std::process::exit(1);
                    }
                }
            }
            _ => {
                println!("  not implemented in this milestone");
                std::process::exit(2);
            }
        }
        return;
    }

    eprintln!("  Error: Missing arguments");
    std::process::exit(1);
}
