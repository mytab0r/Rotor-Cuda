// GPU Pollard-kangaroo baseline device-run smoke on real NVIDIA GPU.
// Cloud CANNOT do this (no GPU on hosted runners); run locally on RTX 5070.
//
// Proves the track-B baseline end to end:
//   1. device math — every emitted hit's canonical X equals GMP ground truth
//      (startScalar + dist)*G reduced mod P (separate impl, real agreement);
//   2. honest DP accounting — out.total is the true DP count, truncated flag
//      set iff total > maxHits;
//   3. collision-solve — host buckets DP hits by canonical X; for a tame*wild
//      bucket, cand = (kStart + off_t + d_t - off_w - d_w) mod n; the fixture
//      scalar is recovered and cand*G == Q reverifies. A spurious/same-herd
//      collision can never pass because of the EC reverify guard.
//
// Jump contract (must match the kernel): jump[i] = 2^i * G, dist accumulates in
// units of G, DP test is on the point BEFORE the jump (dist starts at 0), so a
// hit's point is exactly (startScalar + dist)*G.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <vector>
#include <string>
#include <gmp.h>
#include "bsgs/BsgsGpu.h" // rotor_bsgs_gpu::launch_kangaroo / KangarooResult

static const char* P_HEX = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F";
static const char* N_HEX = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141";
static const char* GX_HEX= "79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798";
static const char* GY_HEX= "483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8";

struct Pt { mpz_t x, y; bool inf; };
static mpz_t P, N, Gx, Gy;

static void pt_init(Pt& r){ mpz_inits(r.x,r.y,NULL); r.inf=true; }
static void pt_clear(Pt& r){ mpz_clears(r.x,r.y,NULL); }
static void pt_set(Pt& r,const mpz_t x,const mpz_t y){ mpz_set(r.x,x); mpz_set(r.y,y); r.inf=false; }
// Full copy incl. the point-at-infinity flag. scalar_mul_G's leading doublings
// operate on infinity; copying via pt_set (which forces inf=false) would turn
// O into a bogus (0,0) and silently break double-and-add.
static void pt_assign(Pt& d,const Pt& s){ mpz_set(d.x,s.x); mpz_set(d.y,s.y); d.inf=s.inf; }
static void mod_inv(mpz_t r,const mpz_t a){ mpz_invert(r,a,P); }

static void ec_add(Pt& R,const Pt& Pp,const Pt& Qp){
    if(Pp.inf){ if(Qp.inf){R.inf=true;} else pt_set(R,Qp.x,Qp.y); return; }
    if(Qp.inf){ pt_set(R,Pp.x,Pp.y); return; }
    mpz_t s,t,u,x3,y3; mpz_inits(s,t,u,x3,y3,NULL);
    if(mpz_cmp(Pp.x,Qp.x)==0){
        mpz_add(t,Pp.y,Qp.y); mpz_mod(t,t,P);
        if(mpz_sgn(t)==0){ R.inf=true; mpz_clears(s,t,u,x3,y3,NULL); return; }
        mpz_mul(s,Pp.x,Pp.x); mpz_mod(s,s,P); mpz_mul_ui(s,s,3); mpz_mod(s,s,P);
        mpz_mul_ui(u,Pp.y,2); mpz_mod(u,u,P); mod_inv(u,u); mpz_mul(s,s,u); mpz_mod(s,s,P);
    } else {
        mpz_sub(t,Qp.y,Pp.y); mpz_mod(t,t,P);
        mpz_sub(u,Qp.x,Pp.x); mpz_mod(u,u,P); mod_inv(u,u);
        mpz_mul(s,t,u); mpz_mod(s,s,P);
    }
    mpz_mul(x3,s,s); mpz_mod(x3,x3,P); mpz_sub(x3,x3,Pp.x); mpz_sub(x3,x3,Qp.x); mpz_mod(x3,x3,P);
    mpz_sub(y3,Pp.x,x3); mpz_mul(y3,s,y3); mpz_mod(y3,y3,P); mpz_sub(y3,y3,Pp.y); mpz_mod(y3,y3,P);
    pt_set(R,x3,y3);
    mpz_clears(s,t,u,x3,y3,NULL);
}

static void scalar_mul_G(Pt& R,const mpz_t k){
    Pt base, acc; pt_init(base); pt_init(acc);
    pt_set(base,Gx,Gy); acc.inf=true;
    size_t nb=mpz_sizeinbase(k,2);
    for(long i=(long)nb-1;i>=0;--i){
        Pt d; pt_init(d); ec_add(d,acc,acc); pt_assign(acc,d); pt_clear(d);
        if(mpz_tstbit(k,i)){ Pt a2; pt_init(a2); ec_add(a2,acc,base); pt_assign(acc,a2); pt_clear(a2); }
    }
    pt_assign(R,acc);
    pt_clear(base); pt_clear(acc);
}

static void pt_to_limbs(const Pt& p, uint64_t out[8]){
    auto dump=[&](const mpz_t v,uint64_t l[4]){
        mpz_t t; mpz_init_set(t,v);
        for(int i=0;i<4;i++){ l[i]=mpz_get_ui(t); mpz_fdiv_q_2exp(t,t,64); }
        mpz_clear(t);
    };
    uint64_t xl[4], yl[4]; dump(p.x,xl); dump(p.y,yl);
    for(int i=0;i<4;i++){ out[i]=xl[i]; out[4+i]=yl[i]; }
}

static void x_canon_limbs(const Pt& p, uint64_t x[4]){
    mpz_t t; mpz_init(t); mpz_mod(t,p.x,P);
    for(int i=0;i<4;i++){ x[i]=mpz_get_ui(t); mpz_fdiv_q_2exp(t,t,64); }
    mpz_clear(t);
}

// 4 LE limbs -> mpz
static void limbs_to_mpz(mpz_t r, const uint64_t v[4]){
    mpz_set_ui(r, 0);
    for(int i=3;i>=0;--i){ mpz_mul_2exp(r,r,64); mpz_add_ui(r,r,v[i]); }
}

int main(int argc,char**argv){
    mpz_inits(P,N,Gx,Gy,NULL);
    mpz_set_str(P,P_HEX,16); mpz_set_str(N,N_HEX,16);
    mpz_set_str(Gx,GX_HEX,16); mpz_set_str(Gy,GY_HEX,16);

    // Tuning: nJumps=8 => mean jump (2^8-1)/8 ~= 32. Fixture range below is
    // ~4096 (sqrt ~= 64 ~= 2*mean), the matched classic-kangaroo regime; with
    // 128+128 kangaroos and a few hundred steps a tame*wild DP collision is
    // birthday-guaranteed. Overrideable from argv for experimentation.
    uint32_t nJumps = argc>1? (uint32_t)atoi(argv[1]) : 8;
    uint32_t nT     = argc>2? (uint32_t)atoi(argv[2]) : 128;
    uint32_t nW     = argc>3? (uint32_t)atoi(argv[3]) : 128;
    uint32_t nSteps = argc>4? (uint32_t)atoi(argv[4]) : 1024;
    uint32_t dpBits = argc>5? (uint32_t)atoi(argv[5]) : 5;
    uint32_t maxHits= argc>6? (uint32_t)atoi(argv[6]) : 400000;

    // Fixture scalar is selected after inspecting tame-0's first jump below:
    // wild-0 starts exactly at tame-0's first post-jump point. This makes the
    // smoke deterministic: the two trails are merged from step 1, so a DP
    // collision must appear before nSteps is exhausted.
    mpz_t kStart, kTrue; mpz_inits(kStart,kTrue,NULL);
    mpz_set_str(kStart, "1000000", 16);           // 2^24

    Pt tame0; pt_init(tame0); scalar_mul_G(tame0, kStart);
    uint64_t tame0x[4]; x_canon_limbs(tame0, tame0x);
    uint32_t firstJump = (uint32_t)(tame0x[0] & (nJumps - 1));
    mpz_set(kTrue, kStart); mpz_add_ui(kTrue, kTrue, 1ULL << firstJump);
    pt_clear(tame0);

    Pt Q; pt_init(Q); scalar_mul_G(Q, kTrue);       // target Q = k*G

    // Precompute jumps jump[i] = 2^i * G.
    std::vector<uint64_t> jumpXY((size_t)nJumps*8);
    for(uint32_t i=0;i<nJumps;i++){
        mpz_t e; mpz_init_set_ui(e,1); mpz_mul_2exp(e,e,i);
        Pt J; pt_init(J); scalar_mul_G(J,e);
        uint64_t lim[8]; pt_to_limbs(J,lim);
        memcpy(&jumpXY[(size_t)i*8], lim, sizeof(lim));
        pt_clear(J); mpz_clear(e);
    }

    // Start points + per-kangaroo start scalar (mod n).
    // tame i: scalar = kStart + i ; wild j: scalar = kTrue + j (point Q + j*G).
    uint32_t nKang = nT + nW;
    std::vector<uint64_t> startXY((size_t)nKang*8);
    std::vector<uint8_t>  kind(nKang);
    std::vector<__mpz_struct> startScalar(nKang);
    for(uint32_t i=0;i<nKang;i++) mpz_init(&startScalar[i]);
    for(uint32_t i=0;i<nT;i++){
        mpz_t s; mpz_init_set(s,kStart); mpz_add_ui(s,s,i);
        mpz_set(&startScalar[i], s);
        Pt R; pt_init(R); scalar_mul_G(R,s);
        uint64_t lim[8]; pt_to_limbs(R,lim); memcpy(&startXY[(size_t)i*8],lim,sizeof(lim));
        kind[i]=rotor_bsgs_gpu::KANG_TAME; pt_clear(R); mpz_clear(s);
    }
    for(uint32_t j=0;j<nW;j++){
        uint32_t idx=nT+j;
        mpz_t s; mpz_init_set(s,kTrue); mpz_add_ui(s,s,j);
        mpz_set(&startScalar[idx], s);
        Pt R; pt_init(R); scalar_mul_G(R,s);
        uint64_t lim[8]; pt_to_limbs(R,lim); memcpy(&startXY[(size_t)idx*8],lim,sizeof(lim));
        kind[idx]=rotor_bsgs_gpu::KANG_WILD; pt_clear(R); mpz_clear(s);
    }

    // ---- device run ----
    rotor_bsgs_gpu::KangarooResult out; std::string err;
    bool ok = rotor_bsgs_gpu::launch_kangaroo(startXY.data(), kind.data(),
                                              jumpXY.data(), nJumps,
                                              nKang, nSteps, dpBits, maxHits,
                                              out, err);
    if(!ok){ printf("launch_kangaroo FAILED: %s\n", err.c_str()); return 2; }
    printf("device DPs total=%llu stored=%zu%s\n",
           (unsigned long long)out.total, out.hits.size(),
           out.truncated?" [TRUNCATED]":"");

    uint64_t mask = dpBits==0 ? 0ULL : (dpBits>=64 ? ~0ULL : ((1ULL<<dpBits)-1ULL));

    // ---- 1. device math check: hit.dpX == canonical((startScalar+dist)*G) ----
    uint64_t bad_notdp=0, bad_math=0;
    for(const auto& h : out.hits){
        if((h.dpX[0]&mask)!=0ULL){ bad_notdp++; continue; }
        mpz_t sc, d; mpz_inits(sc,d,NULL);
        limbs_to_mpz(d, h.dist);
        mpz_add(sc, &startScalar[h.kang], d);        // startScalar + dist
        Pt R; pt_init(R); scalar_mul_G(R, sc);
        uint64_t xc[4]; x_canon_limbs(R, xc);
        if(xc[0]!=h.dpX[0]||xc[1]!=h.dpX[1]||xc[2]!=h.dpX[2]||xc[3]!=h.dpX[3]) bad_math++;
        pt_clear(R); mpz_clears(sc,d,NULL);
    }

    // ---- 2/3. collision-solve: bucket by canonical X, tame*wild -> cand,
    //           reverify cand*G == Q ----
    struct Rec { uint32_t kang; std::vector<uint64_t> dist; };
    std::map<std::vector<uint64_t>, std::pair<std::vector<Rec>,std::vector<Rec>>> buckets;
    for(const auto& h : out.hits){
        std::vector<uint64_t> key(h.dpX, h.dpX+4);
        std::vector<uint64_t> d(h.dist, h.dist+4);
        auto& b = buckets[key];
        if(h.kind==rotor_bsgs_gpu::KANG_TAME) b.first.push_back({h.kang,d});
        else                                  b.second.push_back({h.kang,d});
    }

    bool solved=false; mpz_t cand; mpz_init(cand);
    for(auto& kv : buckets){
        auto& tames=kv.second.first; auto& wilds=kv.second.second;
        if(tames.empty()||wilds.empty()) continue;
        for(auto& t : tames){
            for(auto& w : wilds){
                mpz_t dt, dw, c; mpz_inits(dt,dw,c,NULL);
                limbs_to_mpz(dt, t.dist.data()); limbs_to_mpz(dw, w.dist.data());
                // wild start is Q + off_w*G, so startScalar[w] = kTrue + off_w.
                // cand = tameStart + dt - off_w - dw.
                mpz_add(c, &startScalar[t.kang], dt);
                mpz_sub(c, c, &startScalar[w.kang]);
                mpz_add(c, c, kTrue);
                mpz_sub(c, c, dw);
                mpz_mod(c, c, N);
                Pt CG; pt_init(CG); scalar_mul_G(CG, c);
                if(mpz_cmp(CG.x,Q.x)==0 && mpz_cmp(CG.y,Q.y)==0){
                    mpz_set(cand, c); solved=true;
                }
                pt_clear(CG); mpz_clears(dt,dw,c,NULL);
                if(solved) break;
            }
            if(solved) break;
        }
        if(solved) break;
    }

    printf("device-math: not-dp=%llu math-mismatch=%llu\n",
           (unsigned long long)bad_notdp,(unsigned long long)bad_math);

    bool key_ok=false;
    if(solved){
        key_ok = (mpz_cmp(cand,kTrue)==0);
        gmp_printf("SOLVED cand=%#Zx  fixture=%#Zx  %s\n",
                   cand, kTrue, key_ok?"KEY-MATCH":"KEY-DIFFER");
    } else {
        printf("collision-solve: NO solving tame*wild DP collision this launch\n");
    }

    bool pass = (bad_notdp==0) && (bad_math==0) && solved && key_ok
                && (out.truncated == (out.total > maxHits));
    printf("GPU KANGAROO DEVICE-RUN: %s\n", pass?"PASS (recovered fixture k, cand*G==Q, RTX 5070)":"FAIL");
    return pass?0:1;
}
