// Host-side launcher for the GPU BSGS giant-step kernel.
// Device execution remains opt-in; callers get false + error when no CUDA device exists.
#ifndef ROTOR_BSGS_GPU_H
#define ROTOR_BSGS_GPU_H

#include <cstdint>
#include <string>
#include <vector>

namespace rotor_bsgs_gpu {

struct GiantBatch {
    std::vector<uint64_t> x;      // four little-endian limbs per (thread, step)
    std::vector<uint8_t> parity; // Y parity per (thread, step)
};

// Launch nThreads independent giant walks, each emitting nSteps points.
// startXY and strideXY contain X[4] || Y[4] little-endian limbs.
// Returns false on invalid sizes, CUDA setup/launch/copy failure, or no device.
bool launch_giant(const uint64_t* startXY, const uint64_t* strideXY,
                  uint32_t nThreads, uint32_t nSteps,
                  GiantBatch& out, std::string& error);

// Batch-inversion variant: each CUDA thread advances W independent walks that
// share the stride S, so the W modular inversions per giant step fold into a
// single _ModInv via Montgomery's trick (prefix products). Upgrade path noted
// in point_sub_S. Output layout matches launch_giant with nThreads = nWalks:
// point (walk, step) at index walk*nSteps + step, so existing verifiers work
// unchanged. W in 1..8. Measured up to ~1.65x on RTX 5070 for wide/short walks.
bool launch_giant_batch(const uint64_t* startXY, const uint64_t* strideXY,
                        uint32_t nWalks, uint32_t nSteps, uint32_t W,
                        GiantBatch& out, std::string& error);

// Distinguished-point variant. Runs the same batch-inversion giant walk but,
// instead of storing every point, emits a point only when the low `dpBits`
// bits of its canonical (least-residue) X are zero. This removes the per-point
// store that dominates the plain walk and is the on-device shape a real BSGS
// baby-table match / DP-kangaroo needs. `dpBits` in 0..64 (0 = emit all).
// Hits are appended to `out.hits` up to `maxHits`; `out.total` is the true
// number of distinguished points found (may exceed maxHits -> out.truncated).
// W in 1..8. Output uses canonical X, unlike the raw quasi-reduced launchers.
struct DpHit {
    uint32_t walk;
    uint32_t step;
    uint64_t x[4];      // canonical X (least residue mod P)
    uint8_t  parity;    // Y parity of the quasi-reduced point
};
struct DpResult {
    std::vector<DpHit> hits;
    uint64_t total = 0;      // distinguished points found (pre-truncation)
    bool truncated = false;  // total > maxHits
};
bool launch_giant_dp(const uint64_t* startXY, const uint64_t* strideXY,
                     uint32_t nWalks, uint32_t nSteps, uint32_t W,
                     uint32_t dpBits, uint32_t maxHits,
                     DpResult& out, std::string& error);

} // namespace rotor_bsgs_gpu
#endif
