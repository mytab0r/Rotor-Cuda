// secp256k1 scalar multiplication spike for wgpu/WGSL.
//
// Field arithmetic is Montgomery multiplication over 2^16 limbs (WGSL has no
// u64, so a 32x32 product is emulated with u16 limbs). Every field element is
// `array<u32, 16>`, limbs little-endian. Points are `array<u32, 48>`:
// X at 0..15, Y at 16..31, Z at 32..47 (Jacobian, Z = 0 is infinity).
//
// Entry points:
//   mul_main     one scalar multiplication per invocation (4-bit window)
//   field_bench  ITER dependent Montgomery multiplications per invocation

const P: array<u32, 16> = array<u32, 16>(
    0xfc2fu, 0xffffu, 0xfffeu, 0xffffu,
    0xffffu, 0xffffu, 0xffffu, 0xffffu,
    0xffffu, 0xffffu, 0xffffu, 0xffffu,
    0xffffu, 0xffffu, 0xffffu, 0xffffu,
);

// R^2 mod p, used to enter Montgomery form.
const R2: array<u32, 16> = array<u32, 16>(
    0x90a1u, 0x000eu, 0x07a2u, 0x0000u, 0x0001u, 0u, 0u, 0u,
    0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u,
);

// R mod p = 2^32 + 977, the Montgomery representation of 1 (used for Z).
const R_MONT: array<u32, 16> = array<u32, 16>(
    0x03d1u, 0x0000u, 0x0001u, 0u, 0u, 0u, 0u, 0u,
    0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u,
);

// Plain 1, used to leave Montgomery form.
const ONE: array<u32, 16> = array<u32, 16>(
    1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u,
    0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u,
);

// -p^-1 mod 2^16.
const N0: u32 = 0x3531u;

const ITER: u32 = 512u;

// params[0..15] = scalar base, params[16] = capture flag.
@group(0) @binding(0) var<storage, read> params: array<u32>;
// 16 affine entries: entry j at j*32, X then Y.
@group(0) @binding(1) var<storage, read> table: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
// bench_in[0..15] = a, bench_in[16..31] = b (Montgomery form).
@group(0) @binding(3) var<storage, read> bench_in: array<u32>;
@group(0) @binding(4) var<storage, read_write> bench_out: array<u32>;

fn fe_zero() -> array<u32, 16> {
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        r[i] = 0u;
    }
    return r;
}

fn fe_is_zero(a: array<u32, 16>) -> bool {
    var aa = a;
    for (var i = 0u; i < 16u; i = i + 1u) {
        if (aa[i] != 0u) {
            return false;
        }
    }
    return true;
}

// a >= P for a 16-limb value.
fn fe_ge_p(a: array<u32, 16>) -> bool {
    var aa = a;
    for (var idx = 0u; idx < 16u; idx = idx + 1u) {
        let i = 15u - idx;
        if (aa[i] > P[i]) {
            return true;
        }
        if (aa[i] < P[i]) {
            return false;
        }
    }
    return true;
}

// a >= P for a 17-limb value.
fn fe_ge_p17(a: array<u32, 17>) -> bool {
    var aa = a;
    if (aa[16] != 0u) {
        return true;
    }
    for (var idx = 0u; idx < 16u; idx = idx + 1u) {
        let i = 15u - idx;
        if (aa[i] > P[i]) {
            return true;
        }
        if (aa[i] < P[i]) {
            return false;
        }
    }
    return true;
}

fn fe_sub_p17(a: array<u32, 17>) -> array<u32, 17> {
    var aa = a;
    var r: array<u32, 17>;
    var borrow = 0u;
    for (var i = 0u; i < 16u; i = i + 1u) {
        let d = i32(aa[i]) - i32(P[i]) - i32(borrow);
        if (d < 0) {
            r[i] = u32(d + 65536);
            borrow = 1u;
        } else {
            r[i] = u32(d);
            borrow = 0u;
        }
    }
    r[16] = aa[16] - borrow;
    return r;
}

fn fe_add(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
    var aa = a;
    var bb = b;
    var t: array<u32, 17>;
    var carry = 0u;
    for (var i = 0u; i < 16u; i = i + 1u) {
        let s = aa[i] + bb[i] + carry;
        t[i] = s & 0xffffu;
        carry = s >> 16u;
    }
    t[16] = carry;
    if (fe_ge_p17(t)) {
        t = fe_sub_p17(t);
    }
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        r[i] = t[i];
    }
    return r;
}

fn fe_sub(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
    var aa = a;
    var bb = b;
    var r: array<u32, 16>;
    var borrow = 0u;
    for (var i = 0u; i < 16u; i = i + 1u) {
        let d = i32(aa[i]) - i32(bb[i]) - i32(borrow);
        if (d < 0) {
            r[i] = u32(d + 65536);
            borrow = 1u;
        } else {
            r[i] = u32(d);
            borrow = 0u;
        }
    }
    if (borrow != 0u) {
        var carry = 0u;
        for (var i = 0u; i < 16u; i = i + 1u) {
            let s = r[i] + P[i] + carry;
            r[i] = s & 0xffffu;
            carry = s >> 16u;
        }
    }
    return r;
}

// Montgomery multiplication: returns a*b*R^-1 mod p.
fn fe_mul(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
    var aa = a;
    var bb = b;
    var t: array<u32, 18>;
    for (var i = 0u; i < 18u; i = i + 1u) {
        t[i] = 0u;
    }
    for (var i = 0u; i < 16u; i = i + 1u) {
        var c = 0u;
        for (var j = 0u; j < 16u; j = j + 1u) {
            let s = t[j] + aa[j] * bb[i] + c;
            t[j] = s & 0xffffu;
            c = s >> 16u;
        }
        let s2 = t[16] + c;
        t[16] = s2 & 0xffffu;
        t[17] = s2 >> 16u;

        let m = (t[0] * N0) & 0xffffu;
        var c2 = 0u;
        for (var j = 0u; j < 16u; j = j + 1u) {
            let s = t[j] + m * P[j] + c2;
            let low = s & 0xffffu;
            c2 = s >> 16u;
            if (j > 0u) {
                t[j - 1u] = low;
            }
        }
        let s3 = t[16] + c2;
        t[15] = s3 & 0xffffu;
        t[16] = t[17] + (s3 >> 16u);
        t[17] = 0u;
    }

    var wide: array<u32, 17>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        wide[i] = t[i];
    }
    wide[16] = t[16];
    if (fe_ge_p17(wide)) {
        wide = fe_sub_p17(wide);
    }
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        r[i] = wide[i];
    }
    return r;
}

fn fe_double(a: array<u32, 16>) -> array<u32, 16> {
    return fe_add(a, a);
}

fn fe_triple(a: array<u32, 16>) -> array<u32, 16> {
    return fe_add(fe_double(a), a);
}

fn fe_times8(a: array<u32, 16>) -> array<u32, 16> {
    let d = fe_double(a);
    return fe_double(fe_double(d));
}

fn fe_from_normal(a: array<u32, 16>) -> array<u32, 16> {
    return fe_mul(a, R2);
}

fn fe_to_normal(a: array<u32, 16>) -> array<u32, 16> {
    return fe_mul(a, ONE);
}

fn fe_get(p: array<u32, 48>, offset: u32) -> array<u32, 16> {
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        r[i] = p[offset + i];
    }
    return r;
}

fn fe_get32(p: array<u32, 32>, offset: u32) -> array<u32, 16> {
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        r[i] = p[offset + i];
    }
    return r;
}

fn pt_set(p: array<u32, 48>, offset: u32, v: array<u32, 16>) -> array<u32, 48> {
    var r = p;
    for (var i = 0u; i < 16u; i = i + 1u) {
        r[offset + i] = v[i];
    }
    return r;
}

fn pt_infinity() -> array<u32, 48> {
    var r: array<u32, 48>;
    for (var i = 0u; i < 48u; i = i + 1u) {
        r[i] = 0u;
    }
    return r;
}

fn pt_is_infinity(p: array<u32, 48>) -> bool {
    return fe_is_zero(fe_get(p, 32u));
}

fn pt_from_affine(q: array<u32, 32>) -> array<u32, 48> {
    var r = pt_infinity();
    r = pt_set(r, 0u, fe_get32(q, 0u));
    r = pt_set(r, 16u, fe_get32(q, 16u));
    return pt_set(r, 32u, R_MONT);
}

// Jacobian doubling for y^2 = x^3 + 7 (a = 0).
fn pt_double(p: array<u32, 48>) -> array<u32, 48> {
    if (pt_is_infinity(p)) {
        return p;
    }
    let x = fe_get(p, 0u);
    let y = fe_get(p, 16u);
    let z = fe_get(p, 32u);
    if (fe_is_zero(y)) {
        return pt_infinity();
    }
    let a = fe_mul(x, x);
    let b = fe_mul(y, y);
    let c = fe_mul(b, b);
    let xb = fe_add(x, b);
    let d0 = fe_mul(xb, xb);
    let d = fe_double(fe_sub(fe_sub(d0, a), c));
    let e = fe_triple(a);
    let f = fe_mul(e, e);
    let x3 = fe_sub(f, fe_double(d));
    let y3 = fe_sub(fe_mul(e, fe_sub(d, x3)), fe_times8(c));
    let z3 = fe_double(fe_mul(y, z));
    var r = pt_infinity();
    r = pt_set(r, 0u, x3);
    r = pt_set(r, 16u, y3);
    return pt_set(r, 32u, z3);
}

// Jacobian P + affine Q.
fn pt_add_affine(p: array<u32, 48>, q: array<u32, 32>) -> array<u32, 48> {
    if (pt_is_infinity(p)) {
        return pt_from_affine(q);
    }
    let x1 = fe_get(p, 0u);
    let y1 = fe_get(p, 16u);
    let z1 = fe_get(p, 32u);
    let x2 = fe_get32(q, 0u);
    let y2 = fe_get32(q, 16u);

    let z1z1 = fe_mul(z1, z1);
    let u2 = fe_mul(x2, z1z1);
    let s2 = fe_mul(y2, fe_mul(z1z1, z1));
    let h = fe_sub(u2, x1);
    let r = fe_sub(s2, y1);
    if (fe_is_zero(h)) {
        if (fe_is_zero(r)) {
            return pt_double(p);
        }
        return pt_infinity();
    }
    let h2 = fe_mul(h, h);
    let h3 = fe_mul(h2, h);
    let u1h2 = fe_mul(x1, h2);
    let x3 = fe_sub(fe_sub(fe_mul(r, r), h3), fe_double(u1h2));
    let y3 = fe_sub(fe_mul(r, fe_sub(u1h2, x3)), fe_mul(y1, h3));
    let z3 = fe_mul(z1, h);
    var out_pt = pt_infinity();
    out_pt = pt_set(out_pt, 0u, x3);
    out_pt = pt_set(out_pt, 16u, y3);
    return pt_set(out_pt, 32u, z3);
}

// 4 bits at `window` (0 = most significant 4 bits of the 256-bit scalar).
// Window start bits are 252, 248, ..., 0; (252 - 4*w) % 16 is always 0/4/8/12,
// so a window never crosses a limb.
fn window_bits(k: array<u32, 16>, window: u32) -> u32 {
    var kk = k;
    let bit = 252u - window * 4u;
    let limb = bit / 16u;
    let off = bit % 16u;
    return (kk[limb] >> off) & 0xfu;
}

fn load_table_fe(offset: u32) -> array<u32, 16> {
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        r[i] = table[offset + i];
    }
    return r;
}

fn load_table_affine(index: u32) -> array<u32, 32> {
    var q: array<u32, 32>;
    let base = index * 32u;
    let x = fe_from_normal(load_table_fe(base));
    let y = fe_from_normal(load_table_fe(base + 16u));
    for (var i = 0u; i < 16u; i = i + 1u) {
        q[i] = x[i];
        q[16u + i] = y[i];
    }
    return q;
}

fn scalar_mul(k: array<u32, 16>) -> array<u32, 48> {
    var acc = pt_infinity();
    var started = false;
    for (var w = 0u; w < 64u; w = w + 1u) {
        if (started) {
            for (var d = 0u; d < 4u; d = d + 1u) {
                acc = pt_double(acc);
            }
        }
        let nibble = window_bits(k, w);
        if (nibble != 0u) {
            let q = load_table_affine(nibble);
            if (!started) {
                acc = pt_from_affine(q);
                started = true;
            } else {
                acc = pt_add_affine(acc, q);
            }
        }
    }
    return acc;
}

fn write_point(p: array<u32, 48>, offset: u32) {
    let xn = fe_to_normal(fe_get(p, 0u));
    let yn = fe_to_normal(fe_get(p, 16u));
    let zn = fe_to_normal(fe_get(p, 32u));
    for (var i = 0u; i < 16u; i = i + 1u) {
        out[offset + i] = xn[i];
        out[offset + 16u + i] = yn[i];
        out[offset + 32u + i] = zn[i];
    }
}

@compute @workgroup_size(64)
fn mul_main(@builtin(global_invocation_id) gid3: vec3<u32>) {
    let gid = gid3.x;
    var k: array<u32, 16>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        k[i] = params[i];
    }
    // Add the thread index to the base scalar.
    var carry = gid;
    for (var i = 0u; i < 16u; i = i + 1u) {
        if (carry == 0u) {
            break;
        }
        let s = k[i] + (carry & 0xffffu);
        k[i] = s & 0xffffu;
        carry = (carry >> 16u) + (s >> 16u);
    }

    let p = scalar_mul(k);
    let capture = params[16];
    if (capture != 0u || gid == 0u) {
        write_point(p, gid * 48u);
    }
}

@compute @workgroup_size(64)
fn field_bench(@builtin(global_invocation_id) gid3: vec3<u32>) {
    let gid = gid3.x;
    var a: array<u32, 16>;
    var b: array<u32, 16>;
    for (var i = 0u; i < 16u; i = i + 1u) {
        a[i] = bench_in[i];
        b[i] = bench_in[16u + i];
    }
    // Vary the starting value per thread without leaving the Montgomery domain
    // bounds for the chosen seed (a is small relative to p).
    a[0] = (a[0] + (gid & 0xffffu)) & 0xffffu;
    for (var i = 0u; i < ITER; i = i + 1u) {
        a = fe_mul(a, b);
    }
    if (gid == 0u) {
        for (var i = 0u; i < 16u; i = i + 1u) {
            bench_out[i] = a[i];
        }
    }
}
