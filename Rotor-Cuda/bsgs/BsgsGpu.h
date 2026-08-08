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

} // namespace rotor_bsgs_gpu
#endif
