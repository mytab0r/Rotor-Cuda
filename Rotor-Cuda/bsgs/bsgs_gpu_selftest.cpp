// GPU BSGS backend self-check. Requires WITHGPU and a CUDA device.
// The same known scalars are recovered by CPU and GPU; this catches the
// canonical-X limb/byte fold boundary where a wrong fold can silently miss hits.
#include "BsgsCpu.h"
#include <cassert>
#include <cstdio>

#ifdef WITHGPU
static Int fromU64(uint64_t v) { Int x; x.SetInt32(0); x.Add(v); return x; }

static void check(Secp256K1& sec, uint64_t k, const Int& lo, const Int& hi, uint64_t m) {
    Int ki = fromU64(k);
    Point P = sec.ComputePublicKey(&ki);
    rotor_bsgs::BsgsResult cpu = rotor_bsgs::solve(sec, P, lo, hi, m);
    rotor_bsgs::BsgsResult gpu = rotor_bsgs::solve_gpu(sec, P, lo, hi, 0, m);
    Int want = fromU64(k);
    assert(cpu.found && cpu.key.IsEqual(&want) && "CPU ground truth failed");
    assert(gpu.found && gpu.key.IsEqual(&want) && "GPU recovery failed");
    assert(gpu.key.IsEqual(&cpu.key) && "GPU/CPU key mismatch");
}
#endif

int main() {
#ifndef WITHGPU
    printf("GPU BSGS SELFTEST SKIPPED: build with -DWITHGPU\n");
    return 0;
#else
    Secp256K1 sec; sec.Init();
    const uint64_t base = 1000, span = 4095;
    Int lo = fromU64(base), hi = fromU64(base + span);
    // m=64 gives 64-step giant boundaries; cover start, boundary, middle, end.
    check(sec, base,          lo, hi, 64);
    check(sec, base + 64,     lo, hi, 64);
    check(sec, base + 127,    lo, hi, 64);
    check(sec, base + span/2, lo, hi, 64);
    check(sec, base + span,   lo, hi, 64);
    printf("GPU BSGS SELFTEST: CPU==GPU==fixture for start/boundary/middle/end\n");
    return 0;
#endif
}
