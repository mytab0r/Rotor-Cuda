use rotor::cli::{self, Coin, SearchMode, USAGE, VERSION_LINE};
use rotor::engine;

fn main() {
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
        println!("  GPU code not compiled, use -DWITHGPU when compiling.");
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
        println!("  self-update is not supported in this build");
        std::process::exit(2);
    }

    if config.gpu {
        println!("  GPU code not compiled, use -DWITHGPU when compiling.");
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
