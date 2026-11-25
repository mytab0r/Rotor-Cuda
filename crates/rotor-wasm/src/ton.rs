//! TON wallet addresses, re-exported from `rotor-core`.
//!
//! The address implementation lives in `rotor_core::address::ton`; the WASM
//! adapter keeps this module so the derivation report's call path stays
//! unchanged. The core API is versioned (`TonWalletVersion`) and exposes the
//! whole supported set through `ton_addresses`, so the report emits every
//! version from one ordered list.

pub(crate) use rotor_core::address::ton::{TonWalletVersion, ton_addresses as addresses};
