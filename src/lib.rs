// The shared cryptographic and address layer lives in `rotor-core`; these
// re-exports keep every existing `rotor::<module>` path and every `crate::<module>`
// reference in the desktop code compiling unchanged.
pub use rotor_core::{address, base58, chain, field, generated, hashes, point, scalar, secp};

pub mod benchmark;
pub mod bsgs;
pub mod bsgs_workfile;
pub mod checkpoint;
pub mod cli;
pub mod coordinator;
pub mod engine;
pub mod filter;
#[cfg(feature = "gpu")]
pub mod gpu;
#[cfg(any(feature = "gpu", test))]
pub(crate) mod gpu_driver;
#[cfg(any(feature = "gpu", test))]
pub(crate) mod gpu_plan;
#[cfg(any(feature = "gpu", test))]
pub(crate) mod gpu_random;
#[cfg(feature = "gpu")]
pub mod gpu_search;
pub mod mnemonic;
pub mod monitor;
pub mod selfcheck;
pub mod selfupdate;
pub mod targets_text;
