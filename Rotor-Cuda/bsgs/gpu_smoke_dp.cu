// GPU BSGS distinguished-point (DP) filter device-run smoke on a real NVIDIA
// GPU. Cloud CANNOT do this (no GPU on hosted runners); run locally on RTX 5070.
//
// Proves three things about launch_giant_dp (A2 on-device DP filter):
//   1. correctness  — every emitted hit's canonical X equals the GMP ground
//                      truth (a - step*m)*G reduced mod P, and low dpBits are 0;
//   2. is-distinguished — each stored hit genuinely has low dpBits == 0 (the
//                      device canonicalization + low-bit test is right);
//   3. completeness — brute-force count of DPs over the full independent GMP
//                      walk equals out.total (device found ALL of them, none
//                      spuriously added).
//
// Ground truth is libgmp double-and-add over secp256k1 — a separate impl from
// the device math, so agreement is real evidence.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <vector>
#include <string>
#include <gmp.h>
#include "bsgs/BsgsGpu.h"   // rotor_bsgs_gpu::launch_giant_dp / DpResult

static const char* P_HEX = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F";
static const char* GX_HEX= "79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798";
static const char* GY_HEX= "483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8";

struct Pt { mpz_t x, y; bool inf; };
static mpz_t P, Gx, Gy;

static void pt_init(Pt& r){ mpz_inits(r.x,r.y,NULL); r.inf=true; }
static void pt_clear(Pt& r){ mpz_clears(r.x,r.y,NULL); }
static void pt_set(Pt& r,const mpz_t x,const mpz_t y){ mpz_set(r.x,x); mpz_set(r.y,y); r.inf=false; }
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
        Pt d; pt_init(d); ec_add(d,acc,acc); pt_set(acc,d.x,d.y); pt_clear(d);
        if(mpz_tstbit(k,i)){ Pt a2; pt_init(a2); ec_add(a2,acc,base); pt_set(acc,a2.x,a2.y); pt_clear(a2); }
    }
    pt_set(R,acc.x,acc.y);
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

// least-residue X as 4 LE limbs (canonical)
static void x_canon_limbs(const Pt& p, uint64_t x[4]){
    mpz_t t; mpz_init(t); mpz_mod(t,p.x,P);
    for(int i=0;i<4;i++){ x[i]=mpz_get_ui(t); mpz_fdiv_q_2exp(t,t,64); }
    mpz_clear(t);
}

int main(int argc,char**argv){
    mpz_inits(P,Gx,Gy,NULL);
    mpz_set_str(P,P_HEX,16); mpz_set_str(Gx,GX_HEX,16); mpz_set_str(Gy,GY_HEX,16);

    const uint32_t nWalks = argc>1? (uint32_t)atoi(argv[1]) : 256;
    const uint32_t nSteps = argc>2? (uint32_t)atoi(argv[2]) : 256;
    const uint64_t m      = argc>3? (uint64_t)strtoull(argv[3],0,10) : 1000000ULL;
    const uint32_t W      = argc>4? (uint32_t)atoi(argv[4]) : 4;
    const uint32_t dpBits = argc>5? (uint32_t)atoi(argv[5]) : 8;
    const uint32_t maxHits= argc>6? (uint32_t)atoi(argv[6]) : 100000;
    const uint64_t A_BASE   = 500000000ULL;
    const uint64_t A_STRIDE = 777777777ULL;

    Pt S; pt_init(S); { mpz_t mm; mpz_init_set_ui(mm,m); scalar_mul_G(S,mm); mpz_clear(mm); }
    uint64_t strideXY[8]; pt_to_limbs(S,strideXY);

    std::vector<uint64_t> startXY(nWalks*8);
    std::vector<uint64_t> aScalar(nWalks);
    for(uint32_t w=0;w<nWalks;w++){
        uint64_t a = A_BASE + (uint64_t)w*A_STRIDE; aScalar[w]=a;
        Pt R0; pt_init(R0); { mpz_t aa; mpz_init_set_ui(aa,a); scalar_mul_G(R0,aa); mpz_clear(aa);}
        uint64_t lim[8]; pt_to_limbs(R0,lim);
        memcpy(&startXY[w*8],lim,sizeof(lim)); pt_clear(R0);
    }

    // ---- GPU run ----
    rotor_bsgs_gpu::DpResult out; std::string err;
    bool ok = rotor_bsgs_gpu::launch_giant_dp(startXY.data(), strideXY,
                                              nWalks, nSteps, W, dpBits, maxHits, out, err);
    if(!ok){ fprintf(stderr,"launch_giant_dp FAILED: %s\n", err.c_str()); return 2; }
    printf("launch_giant_dp OK: %u walks x %u steps (W=%u, dpBits=%u) -> total=%llu stored=%zu%s\n",
           nWalks,nSteps,W,dpBits,(unsigned long long)out.total,out.hits.size(),
           out.truncated?" [TRUNCATED]":"");

    const uint64_t mask = dpBits==0 ? 0ULL : (dpBits>=64 ? ~0ULL : ((1ULL<<dpBits)-1ULL));

    // ---- ground truth: full GMP walk, count DPs and index expected canonical X ----
    // key = (walk<<32 | step) -> expected canonical X limbs
    std::map<uint64_t, std::vector<uint64_t>> expDP;
    uint64_t gmpDPcount=0;
    Pt negS; pt_init(negS); pt_set(negS,S.x,S.y); mpz_sub(negS.y,P,negS.y);
    for(uint32_t w=0; w<nWalks; ++w){
        Pt R; pt_init(R);
        { mpz_t aa; mpz_init_set_ui(aa,aScalar[w]); scalar_mul_G(R,aa); mpz_clear(aa); }
        for(uint32_t step=0; step<nSteps; ++step){
            uint64_t xc[4]; x_canon_limbs(R,xc);
            if((xc[0]&mask)==0ULL){
                gmpDPcount++;
                uint64_t key=((uint64_t)w<<32)|step;
                expDP[key]=std::vector<uint64_t>(xc,xc+4);
            }
            Pt Rn; pt_init(Rn); ec_add(Rn,R,negS); pt_set(R,Rn.x,Rn.y); pt_clear(Rn);
        }
        pt_clear(R);
    }
    pt_clear(negS);

    // ---- verify each stored hit ----
    uint64_t bad_notdp=0, bad_xmismatch=0, bad_nokey=0;
    for(const auto& h : out.hits){
        // is-distinguished: device already canonicalized; low bits must be 0
        if((h.x[0]&mask)!=0ULL){ bad_notdp++; continue; }
        uint64_t key=((uint64_t)h.walk<<32)|h.step;
        auto it=expDP.find(key);
        if(it==expDP.end()){ bad_nokey++; continue; }
        const auto& ex=it->second;
        if(ex[0]!=h.x[0]||ex[1]!=h.x[1]||ex[2]!=h.x[2]||ex[3]!=h.x[3]) bad_xmismatch++;
    }

    printf("GMP DP count=%llu   device total=%llu   %s\n",
           (unsigned long long)gmpDPcount,(unsigned long long)out.total,
           gmpDPcount==out.total?"COUNT-MATCH":"COUNT-DIFFER");
    printf("stored-hit checks: not-distinguished=%llu x-mismatch=%llu unknown-key=%llu\n",
           (unsigned long long)bad_notdp,(unsigned long long)bad_xmismatch,(unsigned long long)bad_nokey);

    bool pass = (gmpDPcount==out.total) && !bad_notdp && !bad_xmismatch && !bad_nokey;
    if(!pass){ printf("GPU BSGS DP-FILTER DEVICE-RUN: FAIL\n"); return 1; }
    printf("GPU BSGS DP-FILTER DEVICE-RUN: PASS (device DP == GMP ground truth on RTX 5070)\n");
    return 0;
}
