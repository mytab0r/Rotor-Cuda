//! Product-neutral cryptographic and address layer.
//!
//! This crate holds the single implementation of every first-party primitive
//! that the desktop, the WASM adapter and the site share: secp256k1 field and
//! scalar arithmetic, curve points, hashes, Base58/WIF, chain descriptors and
//! address encoders, and the pure BIP39/BIP32 helpers.
//!
//! It has no network, GPU, CUDA, BSGS, search, coordinator, CLI, filesystem or
//! clock dependency. A caller that needs randomness supplies entropy from the
//! OS RNG or an environment secret.

pub mod address;
pub mod base58;
pub mod chain;
pub mod field;
pub mod generated;
pub mod hashes;
pub mod mnemonic;
pub mod point;
pub mod scalar;
pub mod secp;
