// C ABI for the GPU address/xpoint search (C++ `Rotor::FindKeyGPU` path).
//
// Unlike `GPU/GPUEngine.cu`, this translation unit does NOT need the GMP-based
// C++ core: the generator table (G..1024G, 2048G), the per-thread starting
// keys, the bloom filter and the single target all arrive from Rust. The
// device kernels below are copies of the `__global__` wrappers in
// GPUEngine.cu:49-129; keep them in sync if the fork's kernels change.
//
// `BsgsGpu.cu` is unity-included at the end: GPUMath/GPUCompute declare
// non-inline `__device__` globals, so all device primitives must live in one
// CUDA translation unit (the same reason GPUEngine.cu includes it).
#include <cuda_runtime.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "GPUMath.h"
#include "GPUHash.h"
#include "GPUCompute.h"

namespace {

enum SearchMode {
    SEARCH_MODE_MA = 1, // multiple addresses
    SEARCH_MODE_SA = 2, // single address
    SEARCH_MODE_MX = 3, // multiple x points
    SEARCH_MODE_SX = 4, // single x point
};
enum CompMode { SEARCH_COMPRESSED = 0, SEARCH_UNCOMPRESSED = 1, SEARCH_BOTH = 2 };
enum CoinType { COIN_BTC = 1, COIN_ETH = 2 };

// GPUEngine.h
constexpr uint32_t kStepSize = 1024 * 2;
constexpr uint32_t kItemSizeA = 28;
constexpr uint32_t kItemSizeX = 40;
constexpr uint32_t kGrpSize = 1024 * 2; // GPUMath.h

// ---------------------------------------------------------------------------
// Kernel wrappers (copy of GPUEngine.cu:49-129)

__global__ void compute_keys_mode_ma(uint32_t mode, uint8_t* bloomLookUp, int bloomBits,
                                     uint8_t bloomHashes, uint64_t* keys, uint32_t maxFound,
                                     uint32_t* found) {
    int xPtr = (blockIdx.x * blockDim.x) * 8;
    int yPtr = xPtr + 4 * blockDim.x;
    ComputeKeysSEARCH_MODE_MA(mode, keys + xPtr, keys + yPtr, bloomLookUp, bloomBits, bloomHashes,
                              maxFound, found);
}

__global__ void compute_keys_comp_mode_ma(uint32_t mode, uint8_t* bloomLookUp, int bloomBits,
                                          uint8_t bloomHashes, uint64_t* keys, uint32_t maxFound,
                                          uint32_t* found) {
    int xPtr = (blockIdx.x * blockDim.x) * 8;
    int yPtr = xPtr + 4 * blockDim.x;
    ComputeKeysSEARCH_MODE_MA(mode, keys + xPtr, keys + yPtr, bloomLookUp, bloomBits, bloomHashes,
                              maxFound, found);
}

__global__ void compute_keys_mode_sa(uint32_t mode, uint32_t* hash160, uint64_t* keys,
                                     uint32_t maxFound, uint32_t* found) {
    int xPtr = (blockIdx.x * blockDim.x) * 8;
    int yPtr = xPtr + 4 * blockDim.x;
    ComputeKeysSEARCH_MODE_SA(mode, keys + xPtr, keys + yPtr, hash160, maxFound, found);
}

__global__ void compute_keys_comp_mode_sa(uint32_t mode, uint32_t* hash160, uint64_t* keys,
                                          uint32_t maxFound, uint32_t* found) {
    int xPtr = (blockIdx.x * blockDim.x) * 8;
    int yPtr = xPtr + 4 * blockDim.x;
    ComputeKeysSEARCH_MODE_SA(mode, keys + xPtr, keys + yPtr, hash160, maxFound, found);
}

__global__ void compute_keys_comp_mode_mx(uint32_t mode, uint8_t* bloomLookUp, int bloomBits,
                                          uint8_t bloomHashes, uint64_t* keys, uint32_t maxFound,
                                          uint32_t* found) {
    int xPtr = (blockIdx.x * blockDim.x) * 8;
    int yPtr = xPtr + 4 * blockDim.x;
    ComputeKeysSEARCH_MODE_MX(mode, keys + xPtr, keys + yPtr, bloomLookUp, bloomBits, bloomHashes,
                              maxFound, found);
}

__global__ void compute_keys_comp_mode_sx(uint32_t mode, uint32_t* xpoint, uint64_t* keys,
                                          uint32_t maxFound, uint32_t* found) {
    int xPtr = (blockIdx.x * blockDim.x) * 8;
    int yPtr = xPtr + 4 * blockDim.x;
    ComputeKeysSEARCH_MODE_SX(mode, keys + xPtr, keys + yPtr, xpoint, maxFound, found);
}

__global__ void compute_keys_mode_eth_ma(uint8_t* bloomLookUp, int bloomBits, uint8_t bloomHashes,
                                         uint64_t* keys, uint32_t maxFound, uint32_t* found) {
    int xPtr = (blockIdx.x * blockDim.x) * 8;
    int yPtr = xPtr + 4 * blockDim.x;
    ComputeKeysSEARCH_ETH_MODE_MA(keys + xPtr, keys + yPtr, bloomLookUp, bloomBits, bloomHashes,
                                  maxFound, found);
}

__global__ void compute_keys_mode_eth_sa(uint32_t* hash, uint64_t* keys, uint32_t maxFound,
                                         uint32_t* found) {
    int xPtr = (blockIdx.x * blockDim.x) * 8;
    int yPtr = xPtr + 4 * blockDim.x;
    ComputeKeysSEARCH_ETH_MODE_SA(keys + xPtr, keys + yPtr, hash, maxFound, found);
}

// ---------------------------------------------------------------------------

void set_err(char* err, unsigned err_len, const char* msg) {
    if (!err || err_len == 0) return;
    std::snprintf(err, (size_t)err_len, "%s", msg ? msg : "");
}

bool cuda_ok(cudaError_t status, const char* what, char* err, unsigned err_len) {
    if (status == cudaSuccess) return true;
    std::string message = std::string(what) + ": " + cudaGetErrorString(status);
    set_err(err, err_len, message.c_str());
    return false;
}

struct Engine {
    uint64_t* d_keys = nullptr;       // nbThread * 8 limbs, strided layout
    uint64_t* h_keys = nullptr;       // host staging for the strided layout
    uint64_t* d_gx = nullptr;         // 1024 points * 4 limbs
    uint64_t* d_gy = nullptr;
    uint64_t* d_2gx = nullptr;        // 4 limbs
    uint64_t* d_2gy = nullptr;
    uint8_t* d_bloom = nullptr;
    uint32_t* d_single = nullptr;     // 5 or 8 u32
    uint32_t* d_out = nullptr;
    uint32_t* h_out = nullptr;

    int device = 0;
    int nb_thread = 0;
    int nb_thread_per_group = 128;
    int nb_thread_group = 0;
    int search_mode = 0;
    int comp_mode = 0;
    int coin_type = 0;
    uint32_t max_found = 0;
    uint32_t output_size = 0;
    uint32_t item_size = 0;
    uint32_t item_size32 = 0;
    uint32_t hash_len = 20;
    uint64_t bloom_bits = 0;
    uint8_t bloom_hashes = 0;
    std::string name;

    bool call_kernel(char* err, unsigned err_len) {
        if (!cuda_ok(cudaMemset(d_out, 0, 4), "reset hit counter", err, err_len)) return false;
        const int blocks = nb_thread / nb_thread_per_group;
        const int threads = nb_thread_per_group;
        if (coin_type == COIN_BTC) {
            switch (search_mode) {
            case SEARCH_MODE_MA:
                if (comp_mode == SEARCH_COMPRESSED) {
                    compute_keys_comp_mode_ma<<<blocks, threads>>>(comp_mode, d_bloom, (int)bloom_bits,
                                                                   bloom_hashes, d_keys, max_found, d_out);
                } else {
                    compute_keys_mode_ma<<<blocks, threads>>>(comp_mode, d_bloom, (int)bloom_bits,
                                                              bloom_hashes, d_keys, max_found, d_out);
                }
                break;
            case SEARCH_MODE_SA:
                if (comp_mode == SEARCH_COMPRESSED) {
                    compute_keys_comp_mode_sa<<<blocks, threads>>>(comp_mode, d_single, d_keys,
                                                                   max_found, d_out);
                } else {
                    compute_keys_mode_sa<<<blocks, threads>>>(comp_mode, d_single, d_keys, max_found,
                                                              d_out);
                }
                break;
            case SEARCH_MODE_MX:
                compute_keys_comp_mode_mx<<<blocks, threads>>>(comp_mode, d_bloom, (int)bloom_bits,
                                                               bloom_hashes, d_keys, max_found, d_out);
                break;
            case SEARCH_MODE_SX:
                compute_keys_comp_mode_sx<<<blocks, threads>>>(comp_mode, d_single, d_keys, max_found,
                                                               d_out);
                break;
            default:
                set_err(err, err_len, "unknown search mode");
                return false;
            }
        } else {
            switch (search_mode) {
            case SEARCH_MODE_MA:
                compute_keys_mode_eth_ma<<<blocks, threads>>>(d_bloom, (int)bloom_bits, bloom_hashes,
                                                              d_keys, max_found, d_out);
                break;
            case SEARCH_MODE_SA:
                compute_keys_mode_eth_sa<<<blocks, threads>>>(d_single, d_keys, max_found, d_out);
                break;
            default:
                set_err(err, err_len, "ethereum does not support xpoint search");
                return false;
            }
        }
        return cuda_ok(cudaGetLastError(), "kernel launch", err, err_len);
    }
};

void free_engine(Engine* e) {
    if (!e) return;
    cudaFree(e->d_keys);
    if (e->h_keys) free(e->h_keys);
    cudaFree(e->d_gx);
    cudaFree(e->d_gy);
    cudaFree(e->d_2gx);
    cudaFree(e->d_2gy);
    cudaFree(e->d_bloom);
    cudaFree(e->d_single);
    cudaFree(e->d_out);
    if (e->h_out) free(e->h_out);
    delete e;
}

} // namespace

extern "C" {

// Creates a search engine. `thread_groups < 0` means multiProcessorCount * 8.
// bloom_data/bloom_size/bloom_bits/bloom_hashes are required for MA/MX;
// single_target (5 or 8 u32) is required for SA/SX. gen_x/gen_y hold 1024
// points (x[4] || y[4] little-endian limbs each), two_gn is 2048G (8 limbs).
int rotor_addr_gpu_create(int device_index, int thread_groups, int threads_per_group,
                          uint32_t max_found, int search_mode, int comp_mode, int coin_type,
                          const uint8_t* bloom_data, uint64_t bloom_size, uint64_t bloom_bits,
                          uint8_t bloom_hashes, const uint32_t* single_target,
                          const uint64_t* gen_x, const uint64_t* gen_y, const uint64_t* two_gn,
                          void** out_engine, uint32_t* out_nb_thread, char* err,
                          unsigned err_len) {
    if (!out_engine || !out_nb_thread || !gen_x || !gen_y || !two_gn) {
        set_err(err, err_len, "rotor_addr_gpu_create: null output or generator table");
        return 1;
    }
    *out_engine = nullptr;
    *out_nb_thread = 0;
    const bool multi = search_mode == SEARCH_MODE_MA || search_mode == SEARCH_MODE_MX;
    if (multi && (!bloom_data || bloom_size == 0 || bloom_bits == 0 || bloom_hashes == 0)) {
        set_err(err, err_len, "rotor_addr_gpu_create: multi-address mode needs a bloom filter");
        return 1;
    }
    if (!multi && !single_target) {
        set_err(err, err_len, "rotor_addr_gpu_create: single mode needs a target");
        return 1;
    }
    if (threads_per_group <= 0) {
        set_err(err, err_len, "rotor_addr_gpu_create: threads_per_group must be positive");
        return 1;
    }
    if (threads_per_group > 1024) {
        set_err(err, err_len, "rotor_addr_gpu_create: threads_per_group exceeds 1024");
        return 1;
    }
    if (threads_per_group % 32 != 0) {
        set_err(err, err_len, "rotor_addr_gpu_create: threads_per_group must be a multiple of 32");
        return 1;
    }

    int device_count = 0;
    if (!cuda_ok(cudaGetDeviceCount(&device_count), "cudaGetDeviceCount", err, err_len)) return 1;
    if (device_count <= 0) {
        set_err(err, err_len, "no CUDA device available");
        return 1;
    }
    if (device_index < 0 || device_index >= device_count) {
        std::string message = "invalid CUDA device id " + std::to_string(device_index) + " (found " +
                              std::to_string(device_count) + ")";
        set_err(err, err_len, message.c_str());
        return 1;
    }
    if (!cuda_ok(cudaSetDevice(device_index), "cudaSetDevice", err, err_len)) return 1;

    cudaDeviceProp prop;
    if (!cuda_ok(cudaGetDeviceProperties(&prop, device_index), "cudaGetDeviceProperties", err,
                 err_len))
        return 1;
    if (thread_groups < 0) thread_groups = prop.multiProcessorCount * 8;
    if (thread_groups <= 0) {
        set_err(err, err_len, "rotor_addr_gpu_create: thread_groups must be positive");
        return 1;
    }

    Engine* e = new Engine();
    e->device = device_index;
    e->nb_thread_per_group = threads_per_group;
    e->nb_thread_group = thread_groups;
    e->nb_thread = thread_groups * threads_per_group;
    e->search_mode = search_mode;
    e->comp_mode = comp_mode;
    e->coin_type = coin_type;
    e->max_found = max_found;
    e->item_size = search_mode == SEARCH_MODE_MX || search_mode == SEARCH_MODE_SX ? kItemSizeX
                                                                                : kItemSizeA;
    e->item_size32 = e->item_size / 4;
    e->hash_len = search_mode == SEARCH_MODE_MX || search_mode == SEARCH_MODE_SX ? 32 : 20;
    e->output_size = max_found * e->item_size + 4;
    e->bloom_bits = bloom_bits;
    e->bloom_hashes = bloom_hashes;

    char tmp[512];
    std::snprintf(tmp, sizeof(tmp), "GPU #%d %s Grid(%dx%d)", device_index, prop.name,
                  e->nb_thread_group, e->nb_thread_per_group);
    e->name = tmp;

    const size_t key_bytes = (size_t)e->nb_thread * 8 * sizeof(uint64_t);
    const size_t gen_bytes = (size_t)1024 * 4 * sizeof(uint64_t);
    if (!cuda_ok(cudaMalloc((void**)&e->d_keys, key_bytes), "cudaMalloc(keys)", err, err_len) ||
        !cuda_ok(cudaMalloc((void**)&e->d_gx, gen_bytes), "cudaMalloc(gx)", err, err_len) ||
        !cuda_ok(cudaMalloc((void**)&e->d_gy, gen_bytes), "cudaMalloc(gy)", err, err_len) ||
        !cuda_ok(cudaMalloc((void**)&e->d_2gx, 4 * sizeof(uint64_t)), "cudaMalloc(2gx)", err,
                 err_len) ||
        !cuda_ok(cudaMalloc((void**)&e->d_2gy, 4 * sizeof(uint64_t)), "cudaMalloc(2gy)", err,
                 err_len) ||
        !cuda_ok(cudaMalloc((void**)&e->d_out, e->output_size), "cudaMalloc(out)", err, err_len)) {
        free_engine(e);
        return 1;
    }
    e->h_out = (uint32_t*)malloc(e->output_size);
    e->h_keys = (uint64_t*)malloc(key_bytes);
    if (!e->h_out || !e->h_keys) {
        set_err(err, err_len, "out of memory for the host staging buffers");
        free_engine(e);
        return 1;
    }

    if (!cuda_ok(cudaMemcpy(e->d_gx, gen_x, gen_bytes, cudaMemcpyHostToDevice), "copy gx", err,
                 err_len) ||
        !cuda_ok(cudaMemcpy(e->d_gy, gen_y, gen_bytes, cudaMemcpyHostToDevice), "copy gy", err,
                 err_len) ||
        !cuda_ok(cudaMemcpy(e->d_2gx, two_gn, 4 * sizeof(uint64_t), cudaMemcpyHostToDevice),
                 "copy 2gx", err, err_len) ||
        !cuda_ok(cudaMemcpy(e->d_2gy, two_gn + 4, 4 * sizeof(uint64_t), cudaMemcpyHostToDevice),
                 "copy 2gy", err, err_len) ||
        !cuda_ok(cudaMemcpyToSymbol(Gx, &e->d_gx, sizeof(uint64_t*)), "symbol Gx", err, err_len) ||
        !cuda_ok(cudaMemcpyToSymbol(Gy, &e->d_gy, sizeof(uint64_t*)), "symbol Gy", err, err_len) ||
        !cuda_ok(cudaMemcpyToSymbol(_2Gnx, &e->d_2gx, sizeof(uint64_t*)), "symbol 2Gx", err,
                 err_len) ||
        !cuda_ok(cudaMemcpyToSymbol(_2Gny, &e->d_2gy, sizeof(uint64_t*)), "symbol 2Gy", err,
                 err_len)) {
        free_engine(e);
        return 1;
    }

    if (multi) {
        if (!cuda_ok(cudaMalloc((void**)&e->d_bloom, bloom_size), "cudaMalloc(bloom)", err, err_len) ||
            !cuda_ok(cudaMemcpy(e->d_bloom, bloom_data, bloom_size, cudaMemcpyHostToDevice),
                     "copy bloom", err, err_len)) {
            free_engine(e);
            return 1;
        }
    } else {
        const size_t target_bytes = search_mode == SEARCH_MODE_SX ? 8 * sizeof(uint32_t)
                                                                  : 5 * sizeof(uint32_t);
        if (!cuda_ok(cudaMalloc((void**)&e->d_single, target_bytes), "cudaMalloc(target)", err,
                     err_len) ||
            !cuda_ok(cudaMemcpy(e->d_single, single_target, target_bytes, cudaMemcpyHostToDevice),
                     "copy target", err, err_len)) {
            free_engine(e);
            return 1;
        }
    }

    // GPUEngine.cu: the group kernel uses ~32 KiB of per-thread local memory.
    if (!cuda_ok(cudaDeviceSetCacheConfig(cudaFuncCachePreferL1), "cache config", err, err_len) ||
        !cuda_ok(cudaDeviceSetLimit(cudaLimitStackSize, 49152), "stack size", err, err_len) ||
        !cuda_ok(cudaGetLastError(), "device setup", err, err_len)) {
        free_engine(e);
        return 1;
    }

    *out_engine = e;
    *out_nb_thread = (uint32_t)e->nb_thread;
    return 0;
}

// Uploads nbThread starting points (x[4] || y[4] little-endian limbs) and
// launches the first kernel batch.
int rotor_addr_gpu_set_keys(void* engine, const uint64_t* xy, char* err, unsigned err_len) {
    Engine* e = (Engine*)engine;
    if (!e || !xy) {
        set_err(err, err_len, "rotor_addr_gpu_set_keys: null engine or keys");
        return 1;
    }
    const size_t bytes = (size_t)e->nb_thread * 8 * sizeof(uint64_t);
    // The kernels read keys as x[0..3] || y[0..3] with a blockDim stride
    // (Load256A), exactly the layout GPUEngine::SetKeys builds.
    const int g = e->nb_thread_per_group;
    for (int base = 0; base < e->nb_thread; base += g) {
        for (int j = 0; j < g; ++j) {
            const uint64_t* src = xy + (size_t)(base + j) * 8;
            for (int k = 0; k < 4; ++k) {
                e->h_keys[8 * base + j + k * g] = src[k];
                e->h_keys[8 * base + j + (4 + k) * g] = src[4 + k];
            }
        }
    }
    if (!cuda_ok(cudaMemcpy(e->d_keys, e->h_keys, bytes, cudaMemcpyHostToDevice), "copy keys", err,
                 err_len))
        return 1;
    return e->call_kernel(err, err_len) ? 0 : 1;
}

// Reads the previous batch's hits and launches the next batch. `out_hash` has a
// fixed 32-byte stride; hash modes fill the first 20 bytes.
int rotor_addr_gpu_launch(void* engine, uint32_t* out_tid, uint32_t* out_incr, uint8_t* out_mode,
                          uint8_t* out_hash, uint32_t* out_total, uint32_t* out_stored, char* err,
                          unsigned err_len) {
    Engine* e = (Engine*)engine;
    if (!e || !out_tid || !out_incr || !out_mode || !out_hash || !out_total || !out_stored) {
        set_err(err, err_len, "rotor_addr_gpu_launch: null engine or output buffer");
        return 1;
    }
    uint32_t raw = 0;
    if (!cuda_ok(cudaMemcpy(&raw, e->d_out, sizeof(raw), cudaMemcpyDeviceToHost), "copy count", err,
                 err_len))
        return 1;
    const uint32_t stored = raw < e->max_found ? raw : e->max_found;
    const size_t bytes = (size_t)stored * e->item_size + 4;
    if (stored > 0 &&
        !cuda_ok(cudaMemcpy(e->h_out, e->d_out, bytes, cudaMemcpyDeviceToHost), "copy hits", err,
                 err_len))
        return 1;
    for (uint32_t i = 0; i < stored; ++i) {
        const uint32_t* item = e->h_out + 1 + (size_t)i * e->item_size32;
        const uint32_t packed = item[1];
        out_tid[i] = item[0];
        out_incr[i] = packed >> 16;
        out_mode[i] = (packed & 0x8000u) != 0;
        std::memcpy(out_hash + (size_t)i * 32, (const uint8_t*)(item + 2), e->hash_len);
    }
    *out_total = raw;
    *out_stored = stored;
    return e->call_kernel(err, err_len) ? 0 : 1;
}

void rotor_addr_gpu_destroy(void* engine) { free_engine((Engine*)engine); }

int rotor_addr_gpu_name(void* engine, char* buf, unsigned buf_len) {
    Engine* e = (Engine*)engine;
    if (!e || !buf || buf_len == 0) return 1;
    std::snprintf(buf, (size_t)buf_len, "%s", e->name.c_str());
    return 0;
}

int rotor_addr_gpu_step_size(void) { return (int)kStepSize; }
int rotor_addr_gpu_group_size(void) { return (int)kGrpSize; }

} // extern "C"

// Unity include: keeps every non-inline __device__ global in this one TU.
#include "../bsgs/BsgsGpu.cu"
