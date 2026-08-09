// CPU baby-step/giant-step over secp256k1: solve k*G = P for k in [kStart, kEnd].
// Reuses Rotor EC (Secp256K1, Point, Int). Baby-table membership gated by the
// vendored binary-fuse filter (FilterCatalog fold), exact hit confirmed via map
// and a final EC re-check. Sequential and fully resumable: state is (kStart,i).
#ifndef ROTOR_BSGS_CPU_H
#define ROTOR_BSGS_CPU_H

#include <cstdint>
#include <string>
#include "../SECP256k1.h"

namespace rotor_bsgs {

// Bump when the baby-table layout or fold changes so a stale checkpoint that
// names an older version is rejected instead of silently trusted.
constexpr uint32_t BSGS_TABLE_FORMAT_VERSION = 1;

// Canonical identity of a built baby-step table. Mirrors the accepted filter
// manifest (openspec/specs/filters "versioned filter identity"): a checkpoint
// or resume MUST carry one of these and be rejected on any field mismatch.
struct TableManifest {
    uint32_t    format_version = BSGS_TABLE_FORMAT_VERSION;
    std::string curve          = "secp256k1";
    uint64_t    baby_size      = 0;   // m
    std::string range_id;             // "<kStart hex>:<kEnd hex>"
    uint64_t    table_checksum = 0;   // FNV-1a/64 over the baby-step folds
    // A saved manifest is only safe to resume against an identical table.
    bool compatible(const TableManifest& o) const {
        return format_version == o.format_version && curve == o.curve
            && baby_size == o.baby_size && range_id == o.range_id
            && table_checksum == o.table_checksum;
    }
};

struct BsgsResult {
    bool   found = false;
    Int    key;          // recovered scalar k (valid iff found)
    uint64_t giant_steps = 0;
    uint64_t baby_size   = 0;
    TableManifest manifest;   // identity of the table this run built
    std::string error;         // non-empty when backend setup or execution fails
};

// Solve P = k*G for k in [kStart, kEnd] inclusive. m defaults to ceil(sqrt(span)).
// sec must be Init()'d. Deterministic, single-threaded. Returns result; on
// failure found=false (k outside range or not on curve as generated).
BsgsResult solve(Secp256K1& sec, Point& target,
                 const Int& kStart, const Int& kEnd, uint64_t m = 0);

#ifdef WITHGPU
// GPU backend for the same recover-scalar problem. Shares the baby-table build
// with solve(); giant steps run on the CUDA giant-step kernel (BsgsGpu.cu)
// instead of the CPU loop. gpuId selects the device. Result is byte-identical
// to solve() for the same inputs (proven by bsgs_gpu_selftest). On no device /
// launch failure / output overflow, returns found=false with giant_steps=0.
BsgsResult solve_gpu(Secp256K1& sec, Point& target,
                     const Int& kStart, const Int& kEnd,
                     int gpuId, uint64_t m = 0);
#endif

} // namespace rotor_bsgs
#endif
