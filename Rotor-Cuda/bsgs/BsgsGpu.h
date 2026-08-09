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
    uint64_t x[4];      // canonical X (least residue mod P); zero for infinity
    uint8_t  parity;   // Y parity of the quasi-reduced point
    bool infinity;      // exact giant-boundary infinity marker
};
struct DpResult {
    std::vector<DpHit> hits;
    uint64_t total = 0;      // distinguished points found (pre-truncation)
    bool truncated = false;  // total > maxHits
};
bool launch_giant_dp(const uint64_t* startXY, const uint64_t* strideXY,
                     uint32_t nWalks, uint32_t nSteps, uint32_t W,
                     uint32_t dpBits, uint32_t maxHits,
                     int deviceIndex, DpResult& out, std::string& error);

// --- Track B: Pollard kangaroo baseline (classic 2-herd, K~=2.0) ---
// Each thread walks one kangaroo. The jump is data-dependent:
//   j = canonical_X(P).limb0 & (nJumps-1);  P += jump[j];  dist += 2^j
// jump[i] = 2^i * G, host-precomputed as X[4]||Y[4] LE limbs, nJumps a power of
// two in 1..64. A point is emitted only when its canonical X is distinguished
// (low `dpBits` bits zero) -- same canonicalize + DP test + atomic-cursor SoA
// emission as launch_giant_dp. Each hit carries its herd `kind`, canonical DP
// X, and the 4-limb accumulated distance. The tame/wild collision-solve and the
// key*G==target reverify are host-side (not in this launcher): the kernel is a
// pure bounded DP producer. `dpBits` in 0..64. `out.total` is the true DP count
// (may exceed maxHits -> out.truncated). GPU kangaroo is not CLI-exposed.
enum KangKind : uint8_t { KANG_TAME = 0, KANG_WILD = 1 };
struct KangHit {
    uint8_t  kind;      // KANG_TAME or KANG_WILD
    uint32_t kang;      // kangaroo index (maps back to its start offset)
    uint64_t dpX[4];    // canonical X (least residue mod P)
    uint64_t dist[4];   // accumulated jump distance (little-endian limbs)
    uint8_t  parity;    // Y parity of the quasi-reduced point (informational)
};
struct KangarooResult {
    std::vector<KangHit> hits;
    uint64_t total = 0;      // distinguished points found (pre-truncation)
    bool truncated = false;  // total > maxHits
};
// startXY: nKang points (X[4]||Y[4] LE) -- kind[i] herd of kangaroo i.
// jumpXY: nJumps points (X[4]||Y[4] LE), jump[i] = 2^i*G. nJumps power of two.
bool launch_kangaroo(const uint64_t* startXY, const uint8_t* kind,
                     const uint64_t* jumpXY, uint32_t nJumps,
                     uint32_t nKang, uint32_t nSteps,
                     uint32_t dpBits, uint32_t maxHits,
                     KangarooResult& out, std::string& error);

} // namespace rotor_bsgs_gpu
#endif
