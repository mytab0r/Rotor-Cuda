// CPU BSGS core. See BsgsCpu.h. All EC ops are AFFINE (z=1): the fork's
// projective Add() mishandles the equal-point case (G+G), so we use
// AddDirect/DoubleDirect via a padd() helper with infinity + doubling guards.
// Baby membership = vendored binary-fuse (fast reject) + exact map for j; every
// candidate is EC-reverified so a fold collision can never yield a wrong key.
#include "BsgsCpu.h"
#include "BsgsGpu.h"
#include "../filter/binaryfusefilter.h"

#include <unordered_map>
#include <vector>
#include <cmath>
#include <cstring>
#include <cstdio>

namespace rotor_bsgs {

// FNV-1a/64 over the 32 X bytes — identical fold to FilterCatalog::fold_key.
static uint64_t fold32(const uint8_t* p) {
    uint64_t h = 1469598103934665603ULL;
    for (int i = 0; i < 32; ++i) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}

// FNV-1a/64 over the little-endian bytes of the baby-step folds. This is the
// table_checksum: two tables with the same m+range but different contents (bad
// EC, changed fold) get different checksums, so a mismatched resume is rejected.
static uint64_t fold_table(const std::vector<uint64_t>& folds) {
    uint64_t h = 1469598103934665603ULL;
    for (uint64_t f : folds)
        for (int b = 0; b < 8; ++b) { h ^= (uint8_t)(f >> (b * 8)); h *= 1099511628211ULL; }
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

// Baby table shared by the CPU and GPU giant-step drivers. Holds the exact-map
// (authoritative), the binary-fuse fast-reject filter, the versioned manifest,
// and the derived quantities the giant loop needs (m, Q, stride S). Built once
// per solve so both backends fold X the SAME way -- see solve_gpu.
struct BabyTable {
    uint64_t m = 1;
    uint64_t span = 0;
    Point S;                                     // stride m*G
    std::unordered_map<uint64_t, uint32_t> map;  // fold(x(j*G)) -> j, j in [1,m]
    binary_fuse8_t fuse{};
    bool haveFuse = false;
    TableManifest manifest;

    ~BabyTable() { if (haveFuse) binary_fuse8_free(&fuse); }
    BabyTable() = default;
    BabyTable(BabyTable&& other) noexcept
        : m(other.m), span(other.span), S(other.S), map(std::move(other.map)),
          fuse(other.fuse), haveFuse(other.haveFuse), manifest(std::move(other.manifest)) {
        other.haveFuse = false;
        other.fuse = binary_fuse8_t{};
    }
    BabyTable(const BabyTable&) = delete;
    BabyTable& operator=(const BabyTable&) = delete;
};

static BabyTable build_baby(Secp256K1& sec,
                            const Int& kStart, const Int& kEnd, uint64_t m) {
    BabyTable bt;

    Int spanI; spanI.Set((Int*)&kEnd); { Int ks; ks.Set((Int*)&kStart); spanI.Sub(&ks); }
    bt.span = spanI.bits64[0];                   // low 64 bits; caller keeps ranges sane
    if (m == 0) { double s = std::sqrt((double)bt.span + 1.0); m = (uint64_t)s + 1; }
    if (m < 1) m = 1;
    bt.m = m;

    // --- baby table: x(j*G) for j in [1, m] ---
    bt.map.reserve(m * 2);
    std::vector<uint64_t> folds; folds.reserve(m);
    uint8_t xb[32];
    Point cur = sec.G;                          // j = 1
    for (uint64_t j = 1; j <= m; ++j) {
        sec.GetXBytes(true, cur, xb);
        uint64_t f = fold32(xb);
        folds.push_back(f);
        bt.map.emplace(f, (uint32_t)j);
        if (j < m) cur = padd(sec, cur, sec.G);
    }

    // Versioned identity of this table (see TableManifest). Checksum binds the
    // actual baby-step content so a checkpoint from a different table is rejected.
    bt.manifest.format_version = BSGS_TABLE_FORMAT_VERSION;
    bt.manifest.curve          = "secp256k1";
    bt.manifest.baby_size      = m;
    bt.manifest.range_id       = ((Int&)kStart).GetBase16() + ":" + ((Int&)kEnd).GetBase16();
    bt.manifest.table_checksum = fold_table(folds);

    // Fast-reject filter over baby folds. Map stays authoritative.
    if (folds.size() >= 2 && binary_fuse8_allocate((uint32_t)folds.size(), &bt.fuse)) {
        std::vector<uint64_t> copy = folds;
        bt.haveFuse = binary_fuse8_populate(copy.data(), (uint32_t)copy.size(), &bt.fuse);
        if (!bt.haveFuse) binary_fuse8_free(&bt.fuse);
    }

    // stride S = m*G
    Int mScalar; mScalar.SetInt32(0); mScalar.Add((uint64_t)m);
    bt.S = sec.ComputePublicKey(&mScalar);
    return bt;
}

BsgsResult solve(Secp256K1& sec, Point& target,
                 const Int& kStart, const Int& kEnd, uint64_t m) {
    BsgsResult R;

    BabyTable bt = build_baby(sec, kStart, kEnd, m);
    R.baby_size = bt.m;
    R.manifest  = bt.manifest;

    // Q = target - kStart*G  (target-dependent, so done here not in build_baby)
    Int ksMut; ksMut.Set((Int*)&kStart);
    Point negStart = negate(sec.ComputePublicKey(&ksMut));
    Point Q = padd(sec, target, negStart);
    Point negS = negate(bt.S);

    uint8_t xb[32];
    uint64_t giants = (bt.m > 0) ? (bt.span / bt.m + 1) : 1;
    Point Ri = Q;
    for (uint64_t i = 0; i <= giants; ++i) {
        R.giant_steps = i + 1;

        if (Ri.isZero()) {                       // Q == i*S  => k' = i*m
            uint64_t kp = i * bt.m;
            Int k; k.Set((Int*)&kStart); k.Add(kp);
            R.found = true; R.key = k; break;
        }
        sec.GetXBytes(true, Ri, xb);
        uint64_t f = fold32(xb);

        bool maybe = bt.haveFuse ? binary_fuse8_contain(f, &bt.fuse) : true;
        if (maybe) {
            auto it = bt.map.find(f);
            if (it != bt.map.end()) {
                uint32_t j = it->second;         // Ri ?= j*G  => Q = i*S + j*G
                uint64_t kp = i * bt.m + j;
                if (kp <= bt.span) {
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

    return R;
}

#ifdef WITHGPU
BsgsResult solve_gpu(Secp256K1& sec, Point& target,
                     const Int& kStart, const Int& kEnd,
                     int gpuId, uint64_t m) {
    BsgsResult R;
    BabyTable bt = build_baby(sec, kStart, kEnd, m);
    R.baby_size = bt.m;
    R.manifest = bt.manifest;

    Int ksMut; ksMut.Set((Int*)&kStart);
    Point negStart = negate(sec.ComputePublicKey(&ksMut));
    Point walkStart = padd(sec, target, negStart); // Q = target - kStart*G

    const uint64_t giantPoints = bt.span / bt.m + 1;
    const uint32_t nSteps = 1024;
    // ponytail: bounded host buffer, chunked launcher; raise only after measured GPU memory allows it.
    const uint64_t maxBatchPoints = 1ULL << 20;
    const uint64_t strideStep = (uint64_t)nSteps * bt.m;
    uint64_t batchBase = 0;
    Point batchStart = walkStart;
    uint64_t stride[8];
    std::memcpy(stride, bt.S.x.bits64, 4 * sizeof(uint64_t));
    std::memcpy(stride + 4, bt.S.y.bits64, 4 * sizeof(uint64_t));
    uint8_t xb[32];

    while (batchBase < giantPoints) {
        const uint64_t remaining = giantPoints - batchBase;
        const uint64_t batchPoints = std::min(remaining, maxBatchPoints);
        const uint32_t nWalks = (uint32_t)((batchPoints + nSteps - 1) / nSteps);
        const uint64_t emittedPoints = (uint64_t)nWalks * nSteps;
        if (nWalks == 0 || emittedPoints > UINT32_MAX) {
            R.error = "GPU-BSGS batch dimensions overflow";
            return R;
        }

        std::vector<uint64_t> starts((size_t)nWalks * 8);
        Point currentStart = batchStart;
        for (uint32_t walk = 0; walk < nWalks; ++walk) {
            // Infinity has no canonical X, so resolve exact batch-boundary hits
            // on host instead of sending (0,0) into the affine GPU kernel.
            if (currentStart.isZero()) {
                const uint64_t i = batchBase + (uint64_t)walk * nSteps;
                if (i < giantPoints) {
                    Int k; k.Set((Int*)&kStart); k.Add(i * bt.m);
                    R.found = true; R.key = k;
                    return R;
                }
                // Rounded final walk is outside the range; keep kernel input finite.
                currentStart = sec.G;
            }
            std::memcpy(&starts[(size_t)walk * 8], currentStart.x.bits64, 4 * sizeof(uint64_t));
            std::memcpy(&starts[(size_t)walk * 8 + 4], currentStart.y.bits64, 4 * sizeof(uint64_t));
            if (walk + 1 < nWalks) {
                Int chunkScalar; chunkScalar.SetInt32(0);
                chunkScalar.Add(strideStep);
                Point chunk = sec.ComputePublicKey(&chunkScalar);
                currentStart = padd(sec, currentStart, negate(chunk));
            }
        }

        rotor_bsgs_gpu::DpResult out;
        std::string error;
        bool ok = rotor_bsgs_gpu::launch_giant_dp(
            starts.data(), stride, nWalks, nSteps, 8, 0,
            (uint32_t)emittedPoints, gpuId, out, error);
        if (!ok || out.truncated) {
            R.error = !ok ? error : "GPU-BSGS output truncated; reduce range or use CPU-BSGS";
            return R;
        }
        R.giant_steps += out.total;
        for (const rotor_bsgs_gpu::DpHit& hit : out.hits) {
            const uint64_t i = batchBase + (uint64_t)hit.walk * nSteps + hit.step;
            if (i >= giantPoints) continue;

            // GPU limbs are LE and canonical; fold through exact CPU path.
            Point hitPoint;
            hitPoint.x.SetInt32(0); hitPoint.y.SetInt32(0); hitPoint.z.SetInt32(1);
            std::memcpy(hitPoint.x.bits64, hit.x, 4 * sizeof(uint64_t));
            sec.GetXBytes(true, hitPoint, xb);
            uint64_t f = fold32(xb);
            bool maybe = bt.haveFuse ? binary_fuse8_contain(f, &bt.fuse) : true;
            if (!maybe) continue;
            auto it = bt.map.find(f);
            if (it == bt.map.end()) continue;

            uint64_t kp = i * bt.m + it->second;
            if (kp > bt.span) continue;
            Int k; k.Set((Int*)&kStart); k.Add(kp);
            Int kMut; kMut.Set(&k);
            Point chk = sec.ComputePublicKey(&kMut);
            if (chk.equals(target)) {
                R.found = true;
                R.key = k;
                return R;
            }
        }
        const uint64_t covered = (uint64_t)nWalks * nSteps;
        batchBase += covered;
        if (batchBase < giantPoints) {
            Int chunkScalar; chunkScalar.SetInt32(0);
            chunkScalar.Add(covered * bt.m);
            Point chunk = sec.ComputePublicKey(&chunkScalar);
            batchStart = padd(sec, batchStart, negate(chunk));
        }
    }
    return R;
}
#endif

} // namespace rotor_bsgs
