// CPU baby-step/giant-step over secp256k1: solve k*G = P for k in [kStart, kEnd].
// Reuses Rotor EC (Secp256K1, Point, Int). Baby-table membership gated by the
// vendored binary-fuse filter (FilterCatalog fold), exact hit confirmed via map
// and a final EC re-check. Sequential and fully resumable: state is (kStart,i).
#ifndef ROTOR_BSGS_CPU_H
#define ROTOR_BSGS_CPU_H

#include <cstdint>
#include <string>
#include "../SECP256K1.h"

namespace rotor_bsgs {

struct BsgsResult {
    bool   found = false;
    Int    key;          // recovered scalar k (valid iff found)
    uint64_t giant_steps = 0;
    uint64_t baby_size   = 0;
};

// Solve P = k*G for k in [kStart, kEnd] inclusive. m defaults to ceil(sqrt(span)).
// sec must be Init()'d. Deterministic, single-threaded. Returns result; on
// failure found=false (k outside range or not on curve as generated).
BsgsResult solve(Secp256K1& sec, Point& target,
                 const Int& kStart, const Int& kEnd, uint64_t m = 0);

} // namespace rotor_bsgs
#endif
