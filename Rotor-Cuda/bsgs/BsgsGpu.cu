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
} // namespace rotor_bsgs_gpu
