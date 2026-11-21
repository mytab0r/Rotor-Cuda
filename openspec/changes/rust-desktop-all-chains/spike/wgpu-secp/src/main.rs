//! wgpu/WGSL secp256k1 spike: correctness + throughput on the local GPU.
//!
//! This is a throwaway spike, not production code. It measures:
//!   1. generic 256-bit k*G with a 4-bit window (double-and-add),
//!   2. raw Montgomery field-multiplication throughput.
//!
//! It verifies both against k256/num-bigint before printing numbers.

use std::time::Instant;

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, FieldBytes, ProjectivePoint, Scalar};
use num_bigint::BigUint;
use num_traits::{One, Zero};

const LIMBS: usize = 16;
const POINT_WORDS: usize = 48;
const TABLE_WORDS: usize = 16 * 32;
const ITER: usize = 512;

fn p() -> BigUint {
    BigUint::parse_bytes(
        b"fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f",
        16,
    )
    .unwrap()
}

fn r() -> BigUint {
    (BigUint::one() << 256) % p()
}

fn r_inv() -> BigUint {
    r().modpow(&(p() - 2u32), &p())
}

fn mont_mul(a: &BigUint, b: &BigUint) -> BigUint {
    (a * b % p()) * r_inv() % p()
}

fn mont_form(a: &BigUint) -> BigUint {
    a * r() % p()
}

fn to_limbs(value: &BigUint) -> [u32; LIMBS] {
    let mut out = [0u32; LIMBS];
    let mut v = value.clone();
    let mask = BigUint::from(0xffffu32);
    for slot in out.iter_mut() {
        *slot = (&v & &mask).try_into().unwrap();
        v >>= 16;
    }
    out
}

fn from_limbs(limbs: &[u32]) -> BigUint {
    let mut out = BigUint::zero();
    for (i, limb) in limbs.iter().enumerate() {
        out += BigUint::from(*limb) << (16 * i);
    }
    out
}

fn affine_coords(point: &AffinePoint) -> (BigUint, BigUint) {
    let encoded = point.to_encoded_point(false);
    let bytes = encoded.as_bytes();
    assert_eq!(bytes.len(), 65);
    (
        BigUint::from_bytes_be(&bytes[1..33]),
        BigUint::from_bytes_be(&bytes[33..65]),
    )
}

fn mul_g_u64(k: u64) -> (BigUint, BigUint) {
    let point = ProjectivePoint::GENERATOR * Scalar::from(k);
    affine_coords(&AffinePoint::from(point))
}

fn mul_g_biguint(k: &BigUint) -> Option<(BigUint, BigUint)> {
    let bytes = k.to_bytes_be();
    if bytes.len() > 32 {
        return None;
    }
    let mut padded = [0u8; 32];
    padded[32 - bytes.len()..].copy_from_slice(&bytes);
    let scalar = Option::<Scalar>::from(Scalar::from_repr(FieldBytes::from(padded)))?;
    let point = ProjectivePoint::GENERATOR * scalar;
    Some(affine_coords(&AffinePoint::from(point)))
}

fn jacobian_to_affine(x: &BigUint, y: &BigUint, z: &BigUint) -> Option<(BigUint, BigUint)> {
    if z.is_zero() {
        return None;
    }
    let z_inv = z.modpow(&(p() - 2u32), &p());
    let z_inv2 = &z_inv * &z_inv % p();
    Some((x * &z_inv2 % p(), y * &z_inv2 * &z_inv % p()))
}

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    params: wgpu::Buffer,
    table: wgpu::Buffer,
    out: wgpu::Buffer,
    bench_in: wgpu::Buffer,
    bench_out: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    mul_pipeline: wgpu::ComputePipeline,
    bench_pipeline: wgpu::ComputePipeline,
}

impl Gpu {
    fn new(out_words: usize) -> Self {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .expect("no compatible GPU adapter");
        let info = adapter.get_info();
        println!(
            "ADAPTER      : {} | backend {:?} | driver {} ({})",
            info.name, info.backend, info.driver, info.driver_info
        );
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("secp-spike"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            ..Default::default()
        }))
        .expect("cannot create wgpu device");

        let storage = wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC;
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("params"),
            size: 20 * 4,
            usage: storage,
            mapped_at_creation: false,
        });
        let table = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("table"),
            size: (TABLE_WORDS * 4) as u64,
            usage: storage,
            mapped_at_creation: false,
        });
        let out = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("out"),
            size: (out_words * 4) as u64,
            usage: storage,
            mapped_at_creation: false,
        });
        let bench_in = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("bench_in"),
            size: 32 * 4,
            usage: storage,
            mapped_at_creation: false,
        });
        let bench_out = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("bench_out"),
            size: 16 * 4,
            usage: storage,
            mapped_at_creation: false,
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("secp"),
            source: wgpu::ShaderSource::Wgsl(include_str!("secp.wgsl").into()),
        });

        let entry = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("secp-bgl"),
            entries: &[
                entry(0, true),
                entry(1, true),
                entry(2, false),
                entry(3, true),
                entry(4, false),
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("secp-layout"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let mul_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("mul"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("mul_main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bench_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("field"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("field_bench"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("secp-bind"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: table.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: out.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: bench_in.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: bench_out.as_entire_binding(),
                },
            ],
        });

        Self {
            device,
            queue,
            params,
            table,
            out,
            bench_in,
            bench_out,
            bind_group,
            mul_pipeline,
            bench_pipeline,
        }
    }

    fn upload_table(&self) {
        let mut words = vec![0u32; TABLE_WORDS];
        for j in 1..16u64 {
            let (x, y) = mul_g_u64(j);
            let xl = to_limbs(&x);
            let yl = to_limbs(&y);
            let base = j as usize * 32;
            words[base..base + 16].copy_from_slice(&xl);
            words[base + 16..base + 32].copy_from_slice(&yl);
        }
        self.queue
            .write_buffer(&self.table, 0, bytemuck::cast_slice(&words));
    }

    fn set_params(&self, base: &[u32; LIMBS], capture: u32) {
        let mut words = vec![0u32; 20];
        words[..16].copy_from_slice(base);
        words[16] = capture;
        self.queue
            .write_buffer(&self.params, 0, bytemuck::cast_slice(&words));
    }

    fn dispatch(&self, pipeline: &wgpu::ComputePipeline, threads: u32) {
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.dispatch_workgroups(threads.div_ceil(64), 1, 1);
        }
        self.queue.submit([encoder.finish()]);
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("device poll");
    }

    fn read(&self, buffer: &wgpu::Buffer, size: u64) -> Vec<u8> {
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, size);
        self.queue.submit([encoder.finish()]);
        let slice = staging.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("device poll");
        let data = {
            let view = slice.get_mapped_range().expect("map readback");
            view.to_vec()
        };
        staging.unmap();
        data
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--spv" {
        run_spv(&args[2]);
        return;
    }
    let gpu = Gpu::new(64 * POINT_WORDS);
    gpu.upload_table();
    println!("FIELD        : secp256k1 p, 16x u16 Montgomery limbs, R = 2^256");

    // --- k*G correctness: keys 1..17 with base 0.
    gpu.set_params(&[0u32; LIMBS], 1);
    gpu.dispatch(&gpu.mul_pipeline, 17);
    let raw = gpu.read(&gpu.out, (64 * POINT_WORDS * 4) as u64);
    let words: &[u32] = bytemuck::cast_slice(&raw);
    let mut checked = 0;
    for gid in 1..17u64 {
        let (ex, ey) = mul_g_u64(gid);
        check_point(words, gid as usize, &ex, &ey, &mut checked);
    }
    println!("K*G CHECK    : {checked}/16 keys matched k256 (base 0, keys 1..16)");

    // --- k*G correctness at a random-ish 256-bit base.
    let base = (BigUint::one() << 128) + BigUint::from(0xdeadbeefu64);
    let base_limbs = to_limbs(&base);
    gpu.set_params(&base_limbs, 1);
    gpu.dispatch(&gpu.mul_pipeline, 64);
    let raw = gpu.read(&gpu.out, (64 * POINT_WORDS * 4) as u64);
    let words: &[u32] = bytemuck::cast_slice(&raw);
    let mut random_checked = 0;
    for gid in 0..64u64 {
        let scalar = &base + BigUint::from(gid);
        let expected = mul_g_biguint(&scalar).expect("scalar below n");
        check_point(
            words,
            gid as usize,
            &expected.0,
            &expected.1,
            &mut random_checked,
        );
    }
    println!("K*G CHECK    : {random_checked}/64 keys matched k256 (base 2^128+0xdeadbeef)");

    // --- field multiplication correctness: 512 dependent multiplications.
    let a = mont_form(&BigUint::from(0x123456789u64));
    let b = mont_form(&BigUint::from(0x987654321u64));
    let mut bench_in = vec![0u32; 32];
    bench_in[..16].copy_from_slice(&to_limbs(&a));
    bench_in[16..].copy_from_slice(&to_limbs(&b));
    gpu.queue
        .write_buffer(&gpu.bench_in, 0, bytemuck::cast_slice(&bench_in));
    gpu.dispatch(&gpu.bench_pipeline, 64);
    let raw = gpu.read(&gpu.bench_out, 16 * 4);
    let got = from_limbs(bytemuck::cast_slice::<u8, u32>(&raw));
    let mut expected = a.clone();
    for _ in 0..ITER {
        expected = mont_mul(&expected, &b);
    }
    assert_eq!(got, expected, "field_bench output mismatch");
    println!("FIELD CHECK  : {ITER} dependent Montgomery multiplications matched host bigint");

    // --- throughput.
    let mul_threads = 64 * 1024u32;
    let mul_rounds = 128usize;
    gpu.set_params(&[0u32; LIMBS], 0);
    for _ in 0..3 {
        gpu.dispatch(&gpu.mul_pipeline, mul_threads);
    }
    let start = Instant::now();
    for _ in 0..mul_rounds {
        gpu.dispatch(&gpu.mul_pipeline, mul_threads);
    }
    let mul_elapsed = start.elapsed();
    let keys = u64::from(mul_threads) * mul_rounds as u64;
    let keys_per_s = keys as f64 / mul_elapsed.as_secs_f64();

    let field_threads = 256 * 1024u32;
    let field_rounds = 64usize;
    for _ in 0..2 {
        gpu.dispatch(&gpu.bench_pipeline, field_threads);
    }
    let start = Instant::now();
    for _ in 0..field_rounds {
        gpu.dispatch(&gpu.bench_pipeline, field_threads);
    }
    let field_elapsed = start.elapsed();
    let muls = u64::from(field_threads) * ITER as u64 * field_rounds as u64;
    let muls_per_s = muls as f64 / field_elapsed.as_secs_f64();

    println!(
        "K*G RATE     : {:.3} Mkeys/s ({} keys in {:.3} s, 4-bit window)",
        keys_per_s / 1e6,
        keys,
        mul_elapsed.as_secs_f64()
    );
    println!(
        "MODMUL RATE  : {:.3} Gmodmul/s ({} modmuls in {:.3} s)",
        muls_per_s / 1e9,
        muls,
        field_elapsed.as_secs_f64()
    );
    println!(
        "EST. STEPPED : {:.3} Gkeys/s upper bound for a 3-modmul/key CUDA-style loop, hash excluded",
        muls_per_s / 3.0 / 1e9
    );
}

fn run_spv(path: &str) {
    let bytes = std::fs::read(path).expect("read SPIR-V file");
    assert_eq!(bytes.len() % 4, 0, "SPIR-V must be a sequence of u32 words");
    let words: Vec<u32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| u32::from_le_bytes(*chunk))
        .collect();

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .expect("no compatible GPU adapter");
    let info = adapter.get_info();
    println!(
        "SPV ADAPTER  : {} | backend {:?} | driver {}",
        info.name, info.backend, info.driver
    );
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("spv-spike"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    }))
    .expect("cannot create wgpu device");

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("rust-gpu"),
        source: wgpu::ShaderSource::SpirV(std::borrow::Cow::Owned(words)),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("rust-gpu-main"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });

    let threads = 64u32;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("spv-out"),
        size: u64::from(threads) * 4,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    });

    let mut encoder =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    queue.submit([encoder.finish()]);

    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("spv-read"),
        size: u64::from(threads) * 4,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder =
        device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    encoder.copy_buffer_to_buffer(&buffer, 0, &staging, 0, u64::from(threads) * 4);
    queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("device poll");
    let data = {
        let view = slice.get_mapped_range().expect("map spv readback");
        view.to_vec()
    };
    staging.unmap();
    let got: Vec<u32> = data
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| u32::from_le_bytes(*chunk))
        .collect();
    for (i, value) in got.iter().enumerate() {
        assert_eq!(
            *value,
            (i as u32).wrapping_mul(3).wrapping_add(1),
            "thread {i}"
        );
    }
    println!(
        "SPV CHECK    : {} threads ran rust-gpu SPIR-V and matched the expected pattern",
        threads
    );
}

fn check_point(
    words: &[u32],
    index: usize,
    expected_x: &BigUint,
    expected_y: &BigUint,
    checked: &mut usize,
) {
    let base = index * POINT_WORDS;
    let x = from_limbs(&words[base..base + 16]);
    let y = from_limbs(&words[base + 16..base + 32]);
    let z = from_limbs(&words[base + 32..base + 48]);
    let Some((ax, ay)) = jacobian_to_affine(&x, &y, &z) else {
        panic!("key {index} produced infinity");
    };
    assert_eq!(&ax, expected_x, "x mismatch for key {index}");
    assert_eq!(&ay, expected_y, "y mismatch for key {index}");
    assert_eq!(&ay * &ay % p(), (&ax * &ax % p()) * &ax % p() + 7u32 % p());
    *checked += 1;
}
