// FilterCatalog: versioned, non-overwriting filter sets for Rotor-Cuda.
// Wraps FastFilter binary-fuse (MIT) with a manifest + atomic publish.
// Contract mirrors openspec/specs/filters/spec.md.
#ifndef ROTOR_FILTER_CATALOG_H
#define ROTOR_FILTER_CATALOG_H

#include <cstdint>
#include <string>
#include <vector>

namespace rotor_filter {

constexpr uint32_t FILTER_FORMAT_VERSION = 1;

// Canonical identity of one generated set. Every field lands in manifest.txt.
struct Manifest {
    std::string coin;        // "btc" | "eth"
    uint32_t    bits = 0;    // puzzle bit width
    std::string range_id;    // caller-chosen range label, e.g. "8000000000-ffffffffff"
    std::string kind = "binary-fuse";
    uint32_t    format_version = FILTER_FORMAT_VERSION;
    std::string curve = "secp256k1";
    std::string endianness = "native";
    uint64_t    key_count = 0;
    uint64_t    payload_checksum = 0; // FNV-1a/64 of filter.bin
    // ponytail: FNV-1a checksum detects corruption/mismatch, not tamper.
    //           swap for SHA-256 (project has sha256.cpp) if integrity must be crypto-strong.
};

// Fold an arbitrary target (hash160/xpoint bytes) into a 64-bit fuse key.
// Collisions only add false positives; a generated member is never a false negative.
uint64_t fold_key(const void* buf, size_t len);

// Build + publish a binary-fuse set at <root>/<coin>/<bits>/<range_id>/<kind>/.
// Atomic: writes to a temp dir, then renames into place. Fails (no mutation) if
// the canonical path already exists. On success, m.payload_checksum/key_count filled.
// Returns true on success; err carries the reason on failure.
bool publish(const std::string& root, Manifest& m,
             const std::vector<uint64_t>& keys, std::string& err);

// Loaded, queryable filter set.
struct LoadedFilter {
    Manifest manifest;
    // opaque fuse state owned here; see .cpp
    void* impl = nullptr;
    ~LoadedFilter();
    bool contains(uint64_t key) const;
};

// Load a published set from its <kind> directory. Verifies manifest vs payload
// checksum, format version and curve; rejects on mismatch. Returns false + err.
bool load(const std::string& kind_dir, LoadedFilter& out, std::string& err);

std::string canonical_dir(const std::string& root, const Manifest& m);

} // namespace rotor_filter
#endif
