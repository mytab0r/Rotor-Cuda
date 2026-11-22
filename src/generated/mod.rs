//! Generated single-source-of-truth data.
//!
//! Files here are produced by `scripts/gen-ssot.mjs` from `data/*.json`.
//! Do not edit them by hand; `node scripts/gen-ssot.mjs --check` is a CI gate.

/// One `(id, url, label)` provider entry from `data/providers.json`.
pub type ProviderEntry = (&'static str, &'static str, &'static str);

pub mod chains;
