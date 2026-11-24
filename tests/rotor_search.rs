//! Pins the P1b boundary: the root crate re-exports the shared search types
//! instead of owning copies, so the desktop and the coordinator use one
//! implementation.
//!
//! The type-identity check is compile-time: restoring a local `U256` or
//! `TableManifest` in the root crate makes `same_type` fail to type-check.

use rotor::bsgs::TableManifest as RootManifest;
use rotor::cli::U256 as RootU256;
use rotor_search::bsgs::TableManifest as SearchManifest;
use rotor_search::range::U256 as SearchU256;

fn same_type<T>(_: &T, _: &T) {}

#[test]
fn root_reexports_are_the_rotor_search_types() {
    let root_manifest = RootManifest::default();
    let search_manifest = SearchManifest::default();
    same_type(&root_manifest, &search_manifest);

    let root_key = RootU256::ZERO;
    let search_key = SearchU256::ZERO;
    same_type(&root_key, &search_key);
}
