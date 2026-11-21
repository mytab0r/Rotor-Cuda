//! Minimal rust-gpu compute shader used to prove the toolchain end to end.
//!
//! It is intentionally not the secp kernel: the spike only answers whether a
//! Rust shader crate can be compiled to SPIR-V for Vulkan on this machine.
#![no_std]

use spirv_std::glam::UVec3;
use spirv_std::spirv;

#[spirv(compute(threads(64)))]
pub fn main(
    #[spirv(global_invocation_id)] id: UVec3,
    #[spirv(storage_buffer, descriptor_set = 0, binding = 0)] out: &mut [u32],
) {
    let index = id.x as usize;
    if index < out.len() {
        out[index] = (id.x).wrapping_mul(3).wrapping_add(1);
    }
}
