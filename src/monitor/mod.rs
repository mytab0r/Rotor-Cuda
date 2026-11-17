//! Address activity monitor ("watch my addresses").
//!
//! The MVP backend lives beside the coordinator but owns its own state:
//! wallet login, the watchlist, an EVM baseline watcher and the transparent
//! `/key` exposure check. It never accepts or stores private key material.

pub mod api;
pub mod auth;
pub mod notify;
pub mod store;
pub mod watcher;

pub use store::MonitorStore;
