// Host launcher for BsgsGpu.cu. No CLI wiring yet: compile/link integration first.
#include "BsgsGpu.h"

#ifdef _WIN32
#include <cuda_runtime.h>
#else
#include <cuda_runtime.h>
#endif

namespace rotor_bsgs_gpu {
extern "C" __global__ void bsgs_giant_kernel(const uint64_t*, const uint64_t*,
                                             uint32_t, uint32_t, uint64_t*, uint8_t*);

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
    const size_t parityBytes = points * sizeof(uint8_t);

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
