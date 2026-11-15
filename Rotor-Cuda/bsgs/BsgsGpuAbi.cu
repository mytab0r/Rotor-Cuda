// C ABI shim over the GPU BSGS host launcher (BsgsGpu.cu).
//
// The Rust side (src/gpu.rs) declares these functions with `extern "C"` and
// allocates every output buffer itself: no heap allocation crosses the ABI,
// and every failure is reported through a NUL-terminated `err` string.
#include "BsgsGpu.h"

#include <cuda_runtime.h>

#include <cstdio>
#include <cstring>
#include <string>

namespace {

// snprintf-based, tolerating a null/zero-length caller buffer.
void set_err(char* err, unsigned err_len, const char* msg) {
    if (!err || err_len == 0) return;
    if (!msg) msg = "";
    std::snprintf(err, (size_t)err_len, "%s", msg);
}

} // namespace

extern "C" {

int rotor_gpu_device_count(char* err, unsigned err_len) {
    int count = 0;
    cudaError_t e = cudaGetDeviceCount(&count);
    if (e != cudaSuccess) {
        set_err(err, err_len, cudaGetErrorString(e));
        return -1;
    }
    return count;
}

int rotor_gpu_device_name(int device_index, char* buf, unsigned buf_len) {
    if (!buf || buf_len == 0) return 1;

    int count = 0;
    if (cudaGetDeviceCount(&count) != cudaSuccess) return 1;
    if (device_index < 0 || device_index >= count) return 1;

    cudaDeviceProp prop;
    if (cudaGetDeviceProperties(&prop, device_index) != cudaSuccess) return 1;

    std::snprintf(buf, (size_t)buf_len, "%s", prop.name);
    return 0;
}

int rotor_bsgs_gpu_giant_dp(
    const uint64_t* start_xy, const uint64_t* stride_xy,
    uint32_t n_walks, uint32_t n_steps, uint32_t w, uint32_t dp_bits,
    uint32_t max_hits, int device_index,
    uint32_t* out_walk, uint32_t* out_step, uint64_t* out_x,
    uint8_t* out_parity,
    uint64_t* out_total, uint32_t* out_stored,
    char* err, unsigned err_len) {
    if (!start_xy || !stride_xy) {
        set_err(err, err_len, "rotor_bsgs_gpu_giant_dp: start_xy and stride_xy are required");
        return 1;
    }
    if (!out_total || !out_stored) {
        set_err(err, err_len, "rotor_bsgs_gpu_giant_dp: out_total and out_stored are required");
        return 1;
    }
    if (max_hits > 0 && (!out_walk || !out_step || !out_x || !out_parity)) {
        set_err(err, err_len,
                "rotor_bsgs_gpu_giant_dp: hit buffers are required when max_hits > 0");
        return 1;
    }

    rotor_bsgs_gpu::DpResult out;
    std::string error;
    if (!rotor_bsgs_gpu::launch_giant_dp(start_xy, stride_xy, n_walks, n_steps, w,
                                         dp_bits, max_hits, device_index, out,
                                         error)) {
        set_err(err, err_len, error.c_str());
        return 1;
    }

    const size_t available = out.hits.size();
    const uint32_t stored =
        available < (size_t)max_hits ? (uint32_t)available : max_hits;
    for (uint32_t i = 0; i < stored; ++i) {
        const rotor_bsgs_gpu::DpHit& h = out.hits[i];
        out_walk[i] = h.walk;
        out_step[i] = h.step;
        out_x[i * 4 + 0] = h.x[0];
        out_x[i * 4 + 1] = h.x[1];
        out_x[i * 4 + 2] = h.x[2];
        out_x[i * 4 + 3] = h.x[3];
        out_parity[i] = h.parity;
    }
    *out_total = out.total;
    *out_stored = stored;
    return 0;
}

} // extern "C"
