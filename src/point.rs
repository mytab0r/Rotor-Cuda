//! Elliptic-curve points over secp256k1 in affine and Jacobian coordinates.
//!
//! The curve has a = 0, so the addition and doubling formulas from
//! <http://hyperelliptic.org/EFD/g1p/auto-shortw-jacobian-0.html> apply.

use crate::field::Fe;

/// A point in affine coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Affine {
    pub x: Fe,
    pub y: Fe,
}

impl Affine {
    pub fn neg(&self) -> Affine {
        Affine {
            x: self.x,
            y: self.y.neg(),
        }
    }
}

/// A point in Jacobian coordinates; `z == 0` denotes the point at infinity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Jacobian {
    pub x: Fe,
    pub y: Fe,
    pub z: Fe,
}

impl Jacobian {
    pub fn infinity() -> Jacobian {
        Jacobian {
            x: Fe::ZERO,
            y: Fe::ONE,
            z: Fe::ZERO,
        }
    }

    pub fn from_affine(point: &Affine) -> Jacobian {
        Jacobian {
            x: point.x,
            y: point.y,
            z: Fe::ONE,
        }
    }

    pub fn is_infinity(&self) -> bool {
        self.z.is_zero()
    }

    /// Point doubling ("dbl-2009-l").
    pub fn double(&self) -> Jacobian {
        if self.is_infinity() || self.y.is_zero() {
            return Jacobian::infinity();
        }
        let a = self.x.square();
        let b = self.y.square();
        let c = b.square();
        let d = self.x.add(&b).square().sub(&a).sub(&c).double();
        let e = a.double().add(&a);
        let f = e.square();
        let x3 = f.sub(&d.double());
        let y3 = e.mul(&d.sub(&x3)).sub(&c.double().double().double());
        let z3 = self.y.mul(&self.z).double();
        Jacobian {
            x: x3,
            y: y3,
            z: z3,
        }
    }

    /// Mixed addition with an affine point ("madd-2007-bl").
    pub fn add_affine(&self, other: &Affine) -> Jacobian {
        if self.is_infinity() {
            return Jacobian::from_affine(other);
        }
        let z1z1 = self.z.square();
        let u2 = other.x.mul(&z1z1);
        let s2 = other.y.mul(&self.z).mul(&z1z1);
        let h = u2.sub(&self.x);
        let r = s2.sub(&self.y);
        if h.is_zero() {
            return if r.is_zero() {
                self.double()
            } else {
                Jacobian::infinity()
            };
        }
        let hh = h.square();
        let hhh = h.mul(&hh);
        let v = self.x.mul(&hh);
        let x3 = r.square().sub(&hhh).sub(&v.double());
        let y3 = r.mul(&v.sub(&x3)).sub(&self.y.mul(&hhh));
        let z3 = self.z.mul(&h);
        Jacobian {
            x: x3,
            y: y3,
            z: z3,
        }
    }

    /// Convert to affine coordinates with a single inversion.
    pub fn to_affine(&self) -> Option<Affine> {
        let z_inv = self.z.invert()?;
        let z_inv2 = z_inv.square();
        Some(Affine {
            x: self.x.mul(&z_inv2),
            y: self.y.mul(&z_inv2).mul(&z_inv),
        })
    }

    pub fn neg(&self) -> Jacobian {
        Jacobian {
            x: self.x,
            y: self.y.neg(),
            z: self.z,
        }
    }
}

/// Normalize a batch of Jacobian points with one field inversion.
///
/// Points at infinity map to `None`; they are replaced by `z = 1` internally so
/// they do not poison the batch product.
pub fn batch_to_affine(points: &[Jacobian]) -> Vec<Option<Affine>> {
    if points.is_empty() {
        return Vec::new();
    }

    let mut prefix = Vec::with_capacity(points.len());
    let mut product = Fe::ONE;
    for point in points {
        prefix.push(product);
        let z = if point.is_infinity() {
            Fe::ONE
        } else {
            point.z
        };
        product = product.mul(&z);
    }

    let mut inverse = product.invert().expect("batch product of nonzero z values");
    let mut out = vec![None; points.len()];
    for index in (0..points.len()).rev() {
        let point = points[index];
        if point.is_infinity() {
            continue;
        }
        let z_inv = inverse.mul(&prefix[index]);
        inverse = inverse.mul(&point.z);
        let z_inv2 = z_inv.square();
        out[index] = Some(Affine {
            x: point.x.mul(&z_inv2),
            y: point.y.mul(&z_inv2).mul(&z_inv),
        });
    }
    out
}
