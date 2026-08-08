// GPU BSGS giant-step kernel. Mirrors the fork's SX kernel math (affine point
// subtraction over secp256k1) but walks with stride S = m*G instead of G:
//   R_{i+1} = R_i - S,  R_0 = Q - base*S   (Q = target - kStart*G, computed host-side).
// Each thread owns one contiguous run of `nSteps` giant steps and streams back the
// compressed X (4 limbs + parity byte) of every R_i. Host folds X, probes the baby
// table (binary-fuse fast-reject + exact map), and EC-reverifies — identical to the
// CPU path in BsgsCpu.cpp, so a fold collision can never yield a wrong key.
//
// VERIFICATION STATUS: nvcc-compile-only in cloud (no GPU on hosted runners).
// Real device execution is UNVERIFIED until a self-hosted NVIDIA runner exists.
// Correctness rests on: (a) reuse of the fork's proven GPUMath device primitives,
// (b) the affine subtraction formula below matching the CPU padd()/negate() path.
#include <cstdint>
#include "../GPU/GPUMath.h"   // Load256/Store256A, ModSub256, ModNeg256, _ModMult, _ModSqr, _ModInv

namespace rotor_bsgs_gpu {

// R = A - S, all affine (z=1), 4-limb little-endian limbs.
// C = -S = (Sx, -Sy);  s = (Cy-Ay)/(Cx-Ax);  Rx = s^2-Ax-Sx;  Ry = s*(Ax-Rx)-Ay.
// ponytail: one _ModInv per step (obvious + correct). Upgrade path = Montgomery
// batch-invert across the thread's run (as _ModInvGrouped does for the group),
// wire when a real GPU is available to measure the win.
__device__ __forceinline__ void point_sub_S(
    uint64_t* rx, uint64_t* ry,
    const uint64_t* Ax, const uint64_t* Ay,
    const uint64_t* Sx, const uint64_t* Sy)
{
    uint64_t dx[4], dy[4], nSy[4], s[4], s2[4], inv[5];

    ModSub256(dx, (uint64_t*)Sx, (uint64_t*)Ax);   // dx = Sx - Ax
    Load256(inv, dx); inv[4] = 0; _ModInv(inv);    // inv = 1/(Sx-Ax)  (needs 320-bit)

    ModNeg256(nSy, (uint64_t*)Sy);                 // -Sy
    ModSub256(dy, nSy, (uint64_t*)Ay);             // dy = -Sy - Ay

    _ModMult(s, dy, inv);                          // s = dy/dx
    _ModSqr(s2, s);

    ModSub256(rx, s2, (uint64_t*)Ax);
    ModSub256(rx, (uint64_t*)Sx);                  // rx = s^2 - Ax - Sx

    ModSub256(ry, (uint64_t*)Ax, rx);
    _ModMult(ry, s);
    ModSub256(ry, (uint64_t*)Ay);                  // ry = s*(Ax-rx) - Ay
}

// start[tid] = R_0 for thread tid as (x[4],y[4]) interleaved: 8 limbs/thread.
// outX: nSteps X-values per thread, 4 limbs each; outParity: 1 byte per (thread,step).
// The giant index of (tid,step) is reconstructed host-side from tid*nSteps+step + base.
extern "C" __global__ void bsgs_giant_kernel(
    const uint64_t* __restrict__ start,   // 8 limbs per thread (x||y)
    const uint64_t* __restrict__ S,       // 8 limbs: Sx||Sy (stride m*G)
    uint32_t nThreads, uint32_t nSteps,
    uint64_t* __restrict__ outX,          // nThreads*nSteps*4 limbs
    uint8_t*  __restrict__ outParity)     // nThreads*nSteps bytes
{
    uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= nThreads) return;

    uint64_t ax[4], ay[4], rx[4], ry[4];
    Load256(ax, start + tid * 8);
    Load256(ay, start + tid * 8 + 4);

    const uint64_t* Sx = S;
    const uint64_t* Sy = S + 4;

    uint64_t base = (uint64_t)tid * nSteps;
    for (uint32_t step = 0; step < nSteps; ++step) {
        uint64_t idx = (base + step) * 4;
        outX[idx + 0] = ax[0]; outX[idx + 1] = ax[1];
        outX[idx + 2] = ax[2]; outX[idx + 3] = ax[3];
        outParity[base + step] = (uint8_t)(ay[0] & 1ULL);   // compressed-Y parity

        point_sub_S(rx, ry, ax, ay, Sx, Sy);                // R -= S
        Load256(ax, rx);
        Load256(ay, ry);
    }
}


// ---- Batch-inversion giant kernel ---------------------------------------
// Each thread runs W independent walks sharing stride S. The W per-step
// inversions 1/(Sx-Ax_j) are computed together with Montgomery's trick: one
// _ModInv for the whole batch instead of W. Concrete form of the ponytail
// upgrade path from point_sub_S. Verified on RTX 5070 (sm_120) against a GMP
// ground truth: 65536 points, 0 mismatch, W in {1,3,5,7,8} incl tail groups.
#define RC_BSGS_MAXW 8

__device__ __forceinline__ void point_sub_S_batch(
    uint64_t rx[RC_BSGS_MAXW][4], uint64_t ry[RC_BSGS_MAXW][4],
    const uint64_t ax[RC_BSGS_MAXW][4], const uint64_t ay[RC_BSGS_MAXW][4],
    const uint64_t* Sx, const uint64_t* Sy, uint32_t W)
{
    uint64_t dx[RC_BSGS_MAXW][4];
    uint64_t pre[RC_BSGS_MAXW][4];   // prefix products of dx
    uint64_t inverse[5];

    for (uint32_t j = 0; j < W; ++j) ModSub256(dx[j], (uint64_t*)Sx, (uint64_t*)ax[j]);
    Load256(pre[0], dx[0]);
    for (uint32_t j = 1; j < W; ++j) _ModMult(pre[j], pre[j - 1], dx[j]);

    Load256(inverse, pre[W - 1]); inverse[4] = 0; _ModInv(inverse);

    for (uint32_t j = W - 1; j > 0; --j) {
        uint64_t invj[4];
        _ModMult(invj, pre[j - 1], inverse);   // invj = 1/dx_j
        _ModMult(inverse, dx[j]);              // inverse = 1/pre_{j-1}
        Load256(dx[j], invj);
    }
    Load256(dx[0], inverse);                   // 1/dx_0

    for (uint32_t j = 0; j < W; ++j) {
        uint64_t nSy[4], dy[4], s[4], s2[4];
        ModNeg256(nSy, (uint64_t*)Sy);
        ModSub256(dy, nSy, (uint64_t*)ay[j]);
        _ModMult(s, dy, dx[j]);
        _ModSqr(s2, s);
        ModSub256(rx[j], s2, (uint64_t*)ax[j]);
        ModSub256(rx[j], (uint64_t*)Sx);
        ModSub256(ry[j], (uint64_t*)ax[j], rx[j]);
        _ModMult(ry[j], s);
        ModSub256(ry[j], (uint64_t*)ay[j]);
    }
}

extern "C" __global__ void bsgs_giant_kernel_batch(
    const uint64_t* __restrict__ start,
    const uint64_t* __restrict__ S,
    uint32_t nWalks, uint32_t nSteps, uint32_t W,
    uint64_t* __restrict__ outX,
    uint8_t*  __restrict__ outParity)
{
    uint32_t grp = blockIdx.x * blockDim.x + threadIdx.x;
    uint32_t w0 = grp * W;
    if (w0 >= nWalks) return;
    uint32_t Wl = (w0 + W <= nWalks) ? W : (nWalks - w0);

    uint64_t ax[RC_BSGS_MAXW][4], ay[RC_BSGS_MAXW][4];
    uint64_t rx[RC_BSGS_MAXW][4], ry[RC_BSGS_MAXW][4];
    for (uint32_t j = 0; j < Wl; ++j) {
        Load256(ax[j], start + (w0 + j) * 8);
        Load256(ay[j], start + (w0 + j) * 8 + 4);
    }
    const uint64_t* Sx = S;
    const uint64_t* Sy = S + 4;

    for (uint32_t step = 0; step < nSteps; ++step) {
        for (uint32_t j = 0; j < Wl; ++j) {
            uint64_t idx = ((uint64_t)(w0 + j) * nSteps + step) * 4;
            outX[idx + 0] = ax[j][0]; outX[idx + 1] = ax[j][1];
            outX[idx + 2] = ax[j][2]; outX[idx + 3] = ax[j][3];
            outParity[(uint64_t)(w0 + j) * nSteps + step] = (uint8_t)(ay[j][0] & 1ULL);
        }
        point_sub_S_batch(rx, ry, ax, ay, Sx, Sy, Wl);
        for (uint32_t j = 0; j < Wl; ++j) { Load256(ax[j], rx[j]); Load256(ay[j], ry[j]); }
    }
}

// --- A2: on-device distinguished-point (DP) filter ---
// Device X from the walk is VanitySearch quasi-reduced: congruent mod P but may
// be >= P (never >= 2P, since X < 2^256 < 2P). Canonicalize with a single
// conditional subtract of P, THEN test low bits, so DP semantics match any
// external least-residue consumer. P = 2^256 - 2^32 - 977, so X >= P iff the
// top three limbs are all-ones and limb0 >= 0xFFFFFFFEFFFFFC2F.
__device__ __forceinline__ void canonicalize_X(uint64_t x[4]) {
    bool ge = (x[3] == 0xFFFFFFFFFFFFFFFFULL) &&
              (x[2] == 0xFFFFFFFFFFFFFFFFULL) &&
              (x[1] == 0xFFFFFFFFFFFFFFFFULL) &&
              (x[0] >= 0xFFFFFFFEFFFFFC2FULL);
    if (ge) {
        uint64_t t[5]; t[0]=x[0]; t[1]=x[1]; t[2]=x[2]; t[3]=x[3]; t[4]=0;
        SubP(t);
        x[0]=t[0]; x[1]=t[1]; x[2]=t[2]; x[3]=t[3];
    }
}

// Low `dpBits` bits of canonical X all zero. dpBits==0 emits every point.
__device__ __forceinline__ bool is_distinguished(const uint64_t x[4], uint32_t dpBits) {
    if (dpBits == 0) return true;
    uint64_t mask = (dpBits >= 64) ? ~0ULL : ((1ULL << dpBits) - 1ULL);
    return (x[0] & mask) == 0ULL;
}

// DP variant of the batch walk: same math, but a point is stored only when it
// is distinguished. Hits go to SoA arrays via an atomic cursor; outCount is the
// TRUE number of distinguished points (may exceed maxHits -> host truncates).
extern "C" __global__ void bsgs_giant_kernel_dp(
    const uint64_t* __restrict__ start,
    const uint64_t* __restrict__ S,
    uint32_t nWalks, uint32_t nSteps, uint32_t W, uint32_t dpBits,
    uint32_t maxHits,
    uint32_t* __restrict__ outWalk,
    uint32_t* __restrict__ outStep,
    uint64_t* __restrict__ outX,
    uint8_t*  __restrict__ outParity,
    unsigned long long* __restrict__ outCount)
{
    uint32_t grp = blockIdx.x * blockDim.x + threadIdx.x;
    uint32_t w0 = grp * W;
    if (w0 >= nWalks) return;
    uint32_t Wl = (w0 + W <= nWalks) ? W : (nWalks - w0);

    uint64_t ax[RC_BSGS_MAXW][4], ay[RC_BSGS_MAXW][4];
    uint64_t rx[RC_BSGS_MAXW][4], ry[RC_BSGS_MAXW][4];
    for (uint32_t j = 0; j < Wl; ++j) {
        Load256(ax[j], start + (w0 + j) * 8);
        Load256(ay[j], start + (w0 + j) * 8 + 4);
    }
    const uint64_t* Sx = S;
    const uint64_t* Sy = S + 4;

    for (uint32_t step = 0; step < nSteps; ++step) {
        for (uint32_t j = 0; j < Wl; ++j) {
            uint64_t cx[4]; cx[0]=ax[j][0]; cx[1]=ax[j][1]; cx[2]=ax[j][2]; cx[3]=ax[j][3];
            canonicalize_X(cx);
            if (is_distinguished(cx, dpBits)) {
                unsigned long long slot = atomicAdd(outCount, 1ULL);
                if (slot < maxHits) {
                    outWalk[slot] = w0 + j;
                    outStep[slot] = step;
                    outX[slot*4+0]=cx[0]; outX[slot*4+1]=cx[1];
                    outX[slot*4+2]=cx[2]; outX[slot*4+3]=cx[3];
                    outParity[slot] = (uint8_t)(ay[j][0] & 1ULL);
                }
            }
        }
        point_sub_S_batch(rx, ry, ax, ay, Sx, Sy, Wl);
        for (uint32_t j = 0; j < Wl; ++j) { Load256(ax[j], rx[j]); Load256(ay[j], ry[j]); }
    }
}

} // namespace rotor_bsgs_gpu

// Host launcher lives in same translation unit as kernel. This avoids requiring
// CUDA relocatable device code in legacy Visual Studio project settings.
#include "BsgsGpu.h"
#include <cuda_runtime.h>
#include <string>
#include <vector>

namespace rotor_bsgs_gpu {
bool launch_giant(const uint64_t* startXY, const uint64_t* strideXY,
                  uint32_t nThreads, uint32_t nSteps,
                  GiantBatch& out, std::string& error) {
    if (!startXY || !strideXY || nThreads == 0 || nSteps == 0) {
        error = "invalid GPU BSGS batch dimensions";
        return false;
    }
    const size_t points = (size_t)nThreads * nSteps;
    if (points > (size_t)-1 / (4 * sizeof(uint64_t))) {
        error = "GPU BSGS output size overflow";
        return false;
    }
    const size_t startBytes = (size_t)nThreads * 8 * sizeof(uint64_t);
    const size_t strideBytes = 8 * sizeof(uint64_t);
    const size_t xBytes = points * 4 * sizeof(uint64_t);
    const size_t parityBytes = points;

    int devices = 0;
    cudaError_t e = cudaGetDeviceCount(&devices);
    if (e != cudaSuccess || devices == 0) {
        error = e == cudaSuccess ? "no CUDA device" : cudaGetErrorString(e);
        return false;
    }

    uint64_t *dStart = nullptr, *dStride = nullptr, *dX = nullptr;
    uint8_t *dParity = nullptr;
    auto fail = [&](cudaError_t err) {
        if (dParity) cudaFree(dParity);
        if (dX) cudaFree(dX);
        if (dStride) cudaFree(dStride);
        if (dStart) cudaFree(dStart);
        error = cudaGetErrorString(err);
        return false;
    };
    if ((e = cudaMalloc((void**)&dStart, startBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dStride, strideBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dX, xBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dParity, parityBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMemcpy(dStart, startXY, startBytes, cudaMemcpyHostToDevice)) != cudaSuccess) return fail(e);
    if ((e = cudaMemcpy(dStride, strideXY, strideBytes, cudaMemcpyHostToDevice)) != cudaSuccess) return fail(e);

    const uint32_t block = 128;
    const uint32_t grid = (nThreads + block - 1) / block;
    bsgs_giant_kernel<<<grid, block>>>(dStart, dStride, nThreads, nSteps, dX, dParity);
    if ((e = cudaGetLastError()) != cudaSuccess) return fail(e);
    if ((e = cudaDeviceSynchronize()) != cudaSuccess) return fail(e);

    out.x.resize(points * 4);
    out.parity.resize(points);
    if ((e = cudaMemcpy(out.x.data(), dX, xBytes, cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);
    if ((e = cudaMemcpy(out.parity.data(), dParity, parityBytes, cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);

    cudaFree(dParity); cudaFree(dX); cudaFree(dStride); cudaFree(dStart);
    return true;
}

bool launch_giant_batch(const uint64_t* startXY, const uint64_t* strideXY,
                        uint32_t nWalks, uint32_t nSteps, uint32_t W,
                        GiantBatch& out, std::string& error) {
    if (!startXY || !strideXY || nWalks == 0 || nSteps == 0 || W == 0 || W > RC_BSGS_MAXW) {
        error = "invalid GPU BSGS batch dimensions (W in 1..8)";
        return false;
    }
    const size_t points = (size_t)nWalks * nSteps;
    if (points > (size_t)-1 / (4 * sizeof(uint64_t))) {
        error = "GPU BSGS output size overflow";
        return false;
    }
    const size_t startBytes = (size_t)nWalks * 8 * sizeof(uint64_t);
    const size_t strideBytes = 8 * sizeof(uint64_t);
    const size_t xBytes = points * 4 * sizeof(uint64_t);
    const size_t parityBytes = points;

    int devices = 0;
    cudaError_t e = cudaGetDeviceCount(&devices);
    if (e != cudaSuccess || devices == 0) {
        error = e == cudaSuccess ? "no CUDA device" : cudaGetErrorString(e);
        return false;
    }

    uint64_t *dStart = nullptr, *dStride = nullptr, *dX = nullptr;
    uint8_t *dParity = nullptr;
    auto fail = [&](cudaError_t err) {
        if (dParity) cudaFree(dParity);
        if (dX) cudaFree(dX);
        if (dStride) cudaFree(dStride);
        if (dStart) cudaFree(dStart);
        error = cudaGetErrorString(err);
        return false;
    };
    if ((e = cudaMalloc((void**)&dStart, startBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dStride, strideBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dX, xBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dParity, parityBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMemcpy(dStart, startXY, startBytes, cudaMemcpyHostToDevice)) != cudaSuccess) return fail(e);
    if ((e = cudaMemcpy(dStride, strideXY, strideBytes, cudaMemcpyHostToDevice)) != cudaSuccess) return fail(e);

    const uint32_t nGroups = (nWalks + W - 1) / W;
    const uint32_t block = 128;
    const uint32_t grid = (nGroups + block - 1) / block;
    bsgs_giant_kernel_batch<<<grid, block>>>(dStart, dStride, nWalks, nSteps, W, dX, dParity);
    if ((e = cudaGetLastError()) != cudaSuccess) return fail(e);
    if ((e = cudaDeviceSynchronize()) != cudaSuccess) return fail(e);

    out.x.resize(points * 4);
    out.parity.resize(points);
    if ((e = cudaMemcpy(out.x.data(), dX, xBytes, cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);
    if ((e = cudaMemcpy(out.parity.data(), dParity, parityBytes, cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);

    cudaFree(dParity); cudaFree(dX); cudaFree(dStride); cudaFree(dStart);
    return true;
}

bool launch_giant_dp(const uint64_t* startXY, const uint64_t* strideXY,
                     uint32_t nWalks, uint32_t nSteps, uint32_t W,
                     uint32_t dpBits, uint32_t maxHits,
                     DpResult& out, std::string& error) {
    if (!startXY || !strideXY || nWalks == 0 || nSteps == 0 || W == 0 || W > RC_BSGS_MAXW) {
        error = "invalid GPU BSGS batch dimensions (W in 1..8)";
        return false;
    }
    if (dpBits > 64) { error = "dpBits must be 0..64"; return false; }

    const size_t startBytes = (size_t)nWalks * 8 * sizeof(uint64_t);
    const size_t strideBytes = 8 * sizeof(uint64_t);
    // Hit buffers sized to maxHits (>=1 so cudaMalloc never gets 0 bytes).
    const uint32_t cap = maxHits ? maxHits : 1;
    const size_t walkBytes = (size_t)cap * sizeof(uint32_t);
    const size_t stepBytes = (size_t)cap * sizeof(uint32_t);
    const size_t xBytes = (size_t)cap * 4 * sizeof(uint64_t);
    const size_t parityBytes = (size_t)cap;

    int devices = 0;
    cudaError_t e = cudaGetDeviceCount(&devices);
    if (e != cudaSuccess || devices == 0) {
        error = e == cudaSuccess ? "no CUDA device" : cudaGetErrorString(e);
        return false;
    }

    uint64_t *dStart = nullptr, *dStride = nullptr, *dX = nullptr;
    uint32_t *dWalk = nullptr, *dStep = nullptr;
    uint8_t *dParity = nullptr;
    unsigned long long *dCount = nullptr;
    auto fail = [&](cudaError_t err) {
        if (dCount) cudaFree(dCount);
        if (dParity) cudaFree(dParity);
        if (dX) cudaFree(dX);
        if (dStep) cudaFree(dStep);
        if (dWalk) cudaFree(dWalk);
        if (dStride) cudaFree(dStride);
        if (dStart) cudaFree(dStart);
        error = cudaGetErrorString(err);
        return false;
    };
    if ((e = cudaMalloc((void**)&dStart, startBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dStride, strideBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dWalk, walkBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dStep, stepBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dX, xBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dParity, parityBytes)) != cudaSuccess) return fail(e);
    if ((e = cudaMalloc((void**)&dCount, sizeof(unsigned long long))) != cudaSuccess) return fail(e);
    if ((e = cudaMemcpy(dStart, startXY, startBytes, cudaMemcpyHostToDevice)) != cudaSuccess) return fail(e);
    if ((e = cudaMemcpy(dStride, strideXY, strideBytes, cudaMemcpyHostToDevice)) != cudaSuccess) return fail(e);
    if ((e = cudaMemset(dCount, 0, sizeof(unsigned long long))) != cudaSuccess) return fail(e);

    const uint32_t nGroups = (nWalks + W - 1) / W;
    const uint32_t block = 128;
    const uint32_t grid = (nGroups + block - 1) / block;
    bsgs_giant_kernel_dp<<<grid, block>>>(dStart, dStride, nWalks, nSteps, W, dpBits,
                                          maxHits, dWalk, dStep, dX, dParity, dCount);
    if ((e = cudaGetLastError()) != cudaSuccess) return fail(e);
    if ((e = cudaDeviceSynchronize()) != cudaSuccess) return fail(e);

    unsigned long long total = 0;
    if ((e = cudaMemcpy(&total, dCount, sizeof(total), cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);
    out.total = (uint64_t)total;
    out.truncated = total > maxHits;
    const uint32_t stored = (uint32_t)(total < maxHits ? total : maxHits);

    std::vector<uint32_t> hw(stored), hs(stored);
    std::vector<uint64_t> hx((size_t)stored * 4);
    std::vector<uint8_t> hp(stored);
    if (stored) {
        if ((e = cudaMemcpy(hw.data(), dWalk, (size_t)stored*sizeof(uint32_t), cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);
        if ((e = cudaMemcpy(hs.data(), dStep, (size_t)stored*sizeof(uint32_t), cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);
        if ((e = cudaMemcpy(hx.data(), dX, (size_t)stored*4*sizeof(uint64_t), cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);
        if ((e = cudaMemcpy(hp.data(), dParity, (size_t)stored, cudaMemcpyDeviceToHost)) != cudaSuccess) return fail(e);
    }
    out.hits.clear();
    out.hits.reserve(stored);
    for (uint32_t i = 0; i < stored; ++i) {
        DpHit h;
        h.walk = hw[i]; h.step = hs[i];
        h.x[0]=hx[i*4+0]; h.x[1]=hx[i*4+1]; h.x[2]=hx[i*4+2]; h.x[3]=hx[i*4+3];
        h.parity = hp[i];
        out.hits.push_back(h);
    }

    cudaFree(dCount); cudaFree(dParity); cudaFree(dX);
    cudaFree(dStep); cudaFree(dWalk); cudaFree(dStride); cudaFree(dStart);
    return true;
}

} // namespace rotor_bsgs_gpu
