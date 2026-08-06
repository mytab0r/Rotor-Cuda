// CPU BSGS core. See BsgsCpu.h. Baby membership = vendored binary-fuse (fast
// reject) + exact map for j; every candidate is EC-reverified so a fold
// collision can never yield a wrong key.
#include "BsgsCpu.h"
#include "../filter/binaryfusefilter.h"

#include <unordered_map>
#include <vector>
#include <cmath>
#include <cstring>

namespace rotor_bsgs {

// FNV-1a/64 over the 32 X bytes — identical fold to FilterCatalog::fold_key so
// on-disk baby-table filters and in-memory ones agree.
static uint64_t fold32(const uint8_t* p) {
    uint64_t h = 1469598103934665603ULL;
    for (int i = 0; i < 32; ++i) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}

// -P : negate Y in the field (affine). Input must be reduced.
static Point negate(Point p) { p.y.ModNeg(); return p; }

BsgsResult solve(Secp256K1& sec, Point& target,
                 const Int& kStart, const Int& kEnd, uint64_t m) {
    BsgsResult R;

    // span = kEnd - kStart (inclusive count = span+1). Assume it fits 64-bit for
    // a CPU run; larger ranges are the GPU port's job.
    Int spanI; spanI.Set((Int*)&kEnd); { Int ks; ks.Set((Int*)&kStart); spanI.Sub(&ks); }
    uint64_t span = spanI.bits64[0];           // low 64 bits; caller keeps CPU ranges sane
    if (m == 0) { double s = std::sqrt((double)span + 1.0); m = (uint64_t)s + 1; }
    if (m < 1) m = 1;
    R.baby_size = m;

    // Q = target - kStart*G  ->  solve Q = k'*G, k' in [0, span].
    Int ksMut; ksMut.Set((Int*)&kStart);
    Point startPt = sec.ComputePublicKey(&ksMut);
    Point Q = sec.Add(target, negate(startPt)); Q.Reduce();

    // --- baby table: x(j*G) for j in [1, m] ---  (j=0 is identity, handled below)
    std::unordered_map<uint64_t, uint32_t> babyMap;
    babyMap.reserve(m * 2);
    std::vector<uint64_t> folds; folds.reserve(m);
    uint8_t xb[32];
    Point cur = sec.G;                          // j = 1
    for (uint64_t j = 1; j <= m; ++j) {
        cur.Reduce();
        sec.GetXBytes(true, cur, xb);
        uint64_t f = fold32(xb);
        folds.push_back(f);
        babyMap.emplace(f, (uint32_t)j);
        if (j < m) cur = sec.Add(cur, sec.G);
    }

    // Fast-reject filter over baby folds. Needs >=2 distinct entries; if fuse
    // build fails (rare hash bad-luck) fall through to map-only (still correct).
    binary_fuse8_t fuse; bool haveFuse = false;
    if (folds.size() >= 2 &&
        binary_fuse8_allocate((uint32_t)folds.size(), &fuse)) {
        std::vector<uint64_t> copy = folds;     // populate mutates input
        haveFuse = binary_fuse8_populate(copy.data(), (uint32_t)copy.size(), &fuse);
        if (!haveFuse) binary_fuse8_free(&fuse);
    }

    // --- giant steps: R_i = Q - i*(m*G) ---   stride S = m*G
    Int mScalar; mScalar.SetInt32(0); mScalar.Add((uint64_t)m);
    Point S = sec.ComputePublicKey(&mScalar); S.Reduce();
    Point negS = negate(S);

    uint64_t giants = (m > 0) ? (span / m + 1) : 1;
    Point Ri = Q;
    for (uint64_t i = 0; i <= giants; ++i) {
        R.giant_steps = i + 1;

        // k' = i*m + 0  (Q == i*S exactly -> Ri is identity)
        if (Ri.isZero()) {
            uint64_t kp = i * m;
            Int k; k.Set((Int*)&kStart); k.Add(kp);
            R.found = true; R.key = k; break;
        }
        Ri.Reduce();
        sec.GetXBytes(true, Ri, xb);
        uint64_t f = fold32(xb);

        bool maybe = haveFuse ? binary_fuse8_contain(f, &fuse) : true;
        if (maybe) {
            auto it = babyMap.find(f);
            if (it != babyMap.end()) {
                uint32_t j = it->second;                 // Ri ?= j*G  => Q = i*S + j*G
                uint64_t kp = i * m + j;
                if (kp <= span + 1) {
                    Int k; k.Set((Int*)&kStart); k.Add(kp);
                    Int kMut; kMut.Set(&k);
                    Point chk = sec.ComputePublicKey(&kMut); chk.Reduce();
                    Point tRed = target; tRed.Reduce();
                    if (chk.equals(tRed)) { R.found = true; R.key = k; break; }
                    // else: fold collision, keep walking
                }
            }
        }
        Ri = sec.Add(Ri, negS);                          // Ri -= S
    }

    if (haveFuse) binary_fuse8_free(&fuse);
    return R;
}

} // namespace rotor_bsgs
