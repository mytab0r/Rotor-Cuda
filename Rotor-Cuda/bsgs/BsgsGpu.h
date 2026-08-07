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

} // namespace rotor_bsgs_gpu
#endif
