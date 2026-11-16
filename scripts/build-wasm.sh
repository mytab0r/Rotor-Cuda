#!/bin/sh
# Build the browser client's wasm core and embed it into the coordinator's
# static assets (web/rotor_wasm.wasm).
#
# Requires the wasm target once: rustup target add wasm32-unknown-unknown
set -eu

cd "$(dirname "$0")/.."

cargo build -p rotor-wasm --target wasm32-unknown-unknown --release

out=target/wasm32-unknown-unknown/release/rotor_wasm.wasm
if [ ! -f "$out" ]; then
    # Fall back to whatever cdylib the crate produced.
    for candidate in target/wasm32-unknown-unknown/release/*.wasm; do
        if [ -f "$candidate" ]; then
            out=$candidate
            break
        fi
    done
fi
if [ ! -f "$out" ]; then
    echo "error: no wasm artifact under target/wasm32-unknown-unknown/release/" >&2
    exit 1
fi

cp "$out" web/rotor_wasm.wasm
echo "copied $out -> web/rotor_wasm.wasm"
