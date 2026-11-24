//! Process-wide stop flag shared by the desktop workers and the coordinator
//! chunk loop.
//!
//! The flag is a plain atomic: installing the Ctrl-C handler is the engine's
//! job, and this crate stays free of signal and terminal dependencies.

use std::sync::atomic::{AtomicBool, Ordering};

static STOP: AtomicBool = AtomicBool::new(false);

/// Clears the flag before a run starts.
pub fn reset() {
    STOP.store(false, Ordering::SeqCst);
}

/// Requests a stop at the next batch boundary.
pub fn request() {
    STOP.store(true, Ordering::SeqCst);
}

/// True once a stop was requested.
pub fn requested() -> bool {
    STOP.load(Ordering::SeqCst)
}
