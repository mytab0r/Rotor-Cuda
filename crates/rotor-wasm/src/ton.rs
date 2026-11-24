//! TON wallet W5 address, re-exported from `rotor-core`.
//!
//! The address implementation lives in `rotor_core::address::ton`; the WASM
//! adapter keeps this module so its internal call path and the derivation
//! report stay unchanged. The core API is versioned (`TonWalletVersion`), so
//! v3R2, v4R2 and W5 are one implementation and adding a contract version does
//! not change this call.

pub(crate) use rotor_core::address::ton::ton_w5_address as w5_address;
