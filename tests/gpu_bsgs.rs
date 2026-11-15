//! CPU/GPU BSGS equivalence. Requires `--features gpu` and a CUDA device;
//! without a device each test prints a skip line instead of silently passing.

#![cfg(feature = "gpu")]

use rotor::bsgs;
use rotor::scalar::Scalar;
use rotor::secp;

fn has_device() -> bool {
    if rotor::gpu::device_count().unwrap_or(0) == 0 {
        eprintln!("skipping: no CUDA device");
        return false;
    }
    true
}

#[test]
fn cpu_gpu_agree_on_fixture() {
    if !has_device() {
        return;
    }

    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let target = secp::mul_g(&k);
    let start = k.sub(&Scalar::from_u64(0x400));
    let end = k.add(&Scalar::from_u64(0x400));
    let m = 64;

    let cpu = bsgs::solve(&target, &start, &end, m);
    let gpu = bsgs::solve_gpu(&target, &start, &end, m, 0);

    assert!(cpu.error.is_none(), "CPU error: {:?}", cpu.error);
    assert!(gpu.error.is_none(), "GPU error: {:?}", gpu.error);
    assert!(cpu.found, "CPU did not find k");
    assert!(gpu.found, "GPU did not find k");
    assert_eq!(cpu.key, gpu.key);
    assert_eq!(gpu.key, k);
}

#[test]
fn not_found_agrees() {
    if !has_device() {
        return;
    }

    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let target = secp::mul_g(&k);
    let start = k.add(&Scalar::from_u64(1));
    let end = k.add(&Scalar::from_u64(0x400));
    let m = 64;

    let cpu = bsgs::solve(&target, &start, &end, m);
    let gpu = bsgs::solve_gpu(&target, &start, &end, m, 0);

    assert!(cpu.error.is_none(), "CPU error: {:?}", cpu.error);
    assert!(gpu.error.is_none(), "GPU error: {:?}", gpu.error);
    assert!(!cpu.found, "CPU unexpectedly found k");
    assert!(!gpu.found, "GPU unexpectedly found k");
}
