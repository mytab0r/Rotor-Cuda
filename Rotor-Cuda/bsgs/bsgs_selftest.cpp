// Self-check for CPU BSGS. No framework: asserts + exit code.
// Picks known scalars in a range, derives pubkeys via real EC, recovers them,
// asserts the recovered scalar matches. Covers: hit at range start, middle,
// end, and a giant/baby boundary; plus a negative (target outside range).
#include "BsgsCpu.h"
#include <cassert>
#include <cstdio>
#include <cstring>

using namespace rotor_bsgs;

static Int fromU64(uint64_t v) { Int x; x.SetInt32(0); x.Add(v); return x; }

static bool recover(Secp256K1& sec, uint64_t k,
                    const Int& lo, const Int& hi, uint64_t m) {
    Int ki = fromU64(k);
    Point P = sec.ComputePublicKey(&ki);
    BsgsResult r = solve(sec, P, lo, hi, m);
    if (!r.found) return false;
    Int want = fromU64(k);
    return r.key.IsEqual(&want);
}

int main() {
    Secp256K1 sec; sec.Init();

    // range [1000, 1000+span]
    const uint64_t base = 1000, span = 4095;   // 4096 keys -> m ~ 64
    Int lo = fromU64(base), hi = fromU64(base + span);

    // auto m
    assert(recover(sec, base,          lo, hi, 0) && "hit at range start");
    assert(recover(sec, base + span/2, lo, hi, 0) && "hit in middle");
    assert(recover(sec, base + span,   lo, hi, 0) && "hit at range end");
    printf("auto-m hits: OK\n");

    // explicit m forces giant/baby boundary crossing
    assert(recover(sec, base + 64,  lo, hi, 64) && "hit on giant boundary");
    assert(recover(sec, base + 127, lo, hi, 64) && "hit mid-second-giant");
    printf("explicit-m hits: OK\n");

    // negative: scalar just outside the range must NOT be found
    {
        Int ki = fromU64(base + span + 1);
        Point P = sec.ComputePublicKey(&ki);
        BsgsResult r = solve(sec, P, lo, hi, 0);
        assert(!r.found && "out-of-range key must not be reported");
        printf("out-of-range reject: OK\n");
    }

    // resumability proxy: same inputs -> identical answer, no shared state
    assert(recover(sec, base + 7, lo, hi, 0));
    assert(recover(sec, base + 7, lo, hi, 0));
    printf("deterministic re-run: OK\n");

    printf("ALL BSGS CPU SELFTESTS PASSED\n");
    return 0;
}
