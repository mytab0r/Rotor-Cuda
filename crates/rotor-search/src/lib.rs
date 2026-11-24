//! Product-neutral CPU search and planning layer.
//!
//! This crate holds the deterministic arithmetic and protocol data that the
//! desktop search engine and the coordinator both need:
//!
//! - 256-bit range endpoints and chunk math ([`range`]);
//! - the SplitMix64 stream and its clock/worker seed ([`rng`]);
//! - BSGS table identity: manifest, baby size, range id and fold checksum
//!   ([`bsgs`]);
//! - the shared stop flag ([`stop`]);
//! - the FNV-1a/64 fold used by table identity and the target prefilter
//!   ([`fnv`]).
//!
//! It has no network, HTTP, GPU, CLI or server-handler code. The desktop
//! engine and GPU drivers keep their own thread orchestration and CUDA
//! dispatch; the coordinator imports only these shared pieces.

pub mod bsgs;
pub mod fnv;
pub mod range;
pub mod rng;
pub mod stop;
