// CPU BSGS core. See BsgsCpu.h. All EC ops are AFFINE (z=1): the fork's
// projective Add() mishandles the equal-point case (G+G), so we use
// AddDirect/DoubleDirect via a padd() helper with infinity + doubling guards.
// Baby membership = vendored binary-fuse (fast reject) + exact map for j; every
// candidate is EC-reverified so a fold collision can never yield a wrong key.
#include "BsgsCpu.h"
#include "../filter/binaryfusefilter.h"

#include <unordered_map>
#include <vector>
#include <cmath>
#include <cstring>

namespace rotor_bsgs {

// FNV-1a/64 over the 32 X bytes — identical fold to FilterCatalog::fold_key.
static uint64_t fold32(const uint8_t* p) {
    uint64_t h = 1469598103934665603ULL;
    for (int i = 0; i < 32; ++i) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}

// -P : affine, negate Y in the field. Input must be reduced (z=1).
static Point negate(Point p) { p.y.ModNeg(); return p; }

// Affine add with full case analysis. a,b must be affine (z=1) or infinity(0,0).
// Result is affine or infinity. Handles a==b (double) and a==-b (infinity).
static Point padd(Secp256K1& sec, Point a, Point b) {
    if (a.isZero()) return b;
    if (b.isZero()) return a;
    if (a.x.IsEqual(&b.x)) {
        if (a.y.IsEqual(&b.y)) return sec.DoubleDirect(a);
        Point inf; inf.Clear(); return inf;      // a == -b -> infinity
    }
    return sec.AddDirect(a, b);
}

BsgsResult solve(Secp256K1& sec, Point& target,
                 const Int& kStart, const Int& kEnd, uint64_t m) {
    BsgsResult R;

    Int spanI; spanI.Set((Int*)&kEnd); { Int ks; ks.Set((Int*)&kStart); spanI.Sub(&ks); }
    uint64_t span = spanI.bits64[0];           // low 64 bits; caller keeps CPU ranges sane
    if (m == 0) { double s = std::sqrt((double)span + 1.0); m = (uint64_t)s + 1; }
    if (m < 1) m = 1;
    R.baby_size = m;

    // Q = target - kStart*G  ->  solve Q = k'*G, k' in [0, span].
    Int ksMut; ksMut.Set((Int*)&kStart);
    Point startPt = sec.ComputePublicKey(&ksMut);
    Point negStart = negate(startPt);
    Point Q = padd(sec, target, negStart);

    // --- baby table: x(j*G) for j in [1, m] ---
    std::unordered_map<uint64_t, uint32_t> babyMap;
    babyMap.reserve(m * 2);
    std::vector<uint64_t> folds; folds.reserve(m);
    uint8_t xb[32];
    Point cur = sec.G;                          // j = 1
    for (uint64_t j = 1; j <= m; ++j) {
        sec.GetXBytes(true, cur, xb);
        uint64_t f = fold32(xb);
        folds.push_back(f);
        babyMap.emplace(f, (uint32_t)j);
        if (j < m) cur = padd(sec, cur, sec.G);
    }

    // Fast-reject filter over baby folds. Map stays authoritative.
    binary_fuse8_t fuse; bool haveFuse = false;
    if (folds.size() >= 2 && binary_fuse8_allocate((uint32_t)folds.size(), &fuse)) {
        std::vector<uint64_t> copy = folds;
        haveFuse = binary_fuse8_populate(copy.data(), (uint32_t)copy.size(), &fuse);
        if (!haveFuse) binary_fuse8_free(&fuse);
    }

    // --- giant steps: R_i = Q - i*(m*G) ---   stride S = m*G
    Int mScalar; mScalar.SetInt32(0); mScalar.Add((uint64_t)m);
    Point S = sec.ComputePublicKey(&mScalar);
    Point negS = negate(S);

    uint64_t giants = (m > 0) ? (span / m + 1) : 1;
    Point Ri = Q;
    for (uint64_t i = 0; i <= giants; ++i) {
        R.giant_steps = i + 1;

        if (Ri.isZero()) {                       // Q == i*S  => k' = i*m
            uint64_t kp = i * m;
            Int k; k.Set((Int*)&kStart); k.Add(kp);
            R.found = true; R.key = k; break;
        }
        sec.GetXBytes(true, Ri, xb);
        uint64_t f = fold32(xb);

        bool maybe = haveFuse ? binary_fuse8_contain(f, &fuse) : true;
        if (maybe) {
            auto it = babyMap.find(f);
            if (it != babyMap.end()) {
                uint32_t j = it->second;         // Ri ?= j*G  => Q = i*S + j*G
                uint64_t kp = i * m + j;
                if (kp <= span) {
                    Int k; k.Set((Int*)&kStart); k.Add(kp);
                    Int kMut; kMut.Set(&k);
                    Point chk = sec.ComputePublicKey(&kMut);
                    if (chk.equals(target)) { R.found = true; R.key = k; break; }
                    // else fold collision, keep walking
                }
            }
        }
        Ri = padd(sec, Ri, negS);                // Ri -= S
    }

    if (haveFuse) binary_fuse8_free(&fuse);
    return R;
}

} // namespace rotor_bsgs
