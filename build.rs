// Build script: compiles the CUDA BSGS sources with nvcc and links the resulting
// objects into the Rust binaries/tests when the `gpu` feature is enabled.
//
// Without `--features gpu` this script does nothing beyond declaring rerun
// inputs, so a machine without the CUDA Toolkit can still build and test the
// CPU side.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

// One device translation unit only: GPUMath/GPUCompute declare non-inline
// `__device__` globals, so GpuAddressAbi.cu unity-includes bsgs/BsgsGpu.cu
// (the same pattern GPUEngine.cu uses). BsgsGpuAbi.cu is host-only.
const CU_SOURCES: [&str; 2] = [
    "Rotor-Cuda/GPU/GpuAddressAbi.cu",
    "Rotor-Cuda/bsgs/BsgsGpuAbi.cu",
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rustc-env=ROTOR_BUILD_ID={}", build_id());
    for rel in [
        "Rotor-Cuda/bsgs/BsgsGpu.cu",
        "Rotor-Cuda/bsgs/BsgsGpuAbi.cu",
        "Rotor-Cuda/bsgs/BsgsGpu.h",
        "Rotor-Cuda/GPU/GpuAddressAbi.cu",
        "Rotor-Cuda/GPU/GPUMath.h",
        "Rotor-Cuda/GPU/GPUCompute.h",
        "Rotor-Cuda/GPU/GPUHash.h",
    ] {
        println!("cargo:rerun-if-changed={rel}");
    }
    for var in [
        "ROTOR_NVCC",
        "ROTOR_CUDA_ARCHS",
        "NVCC_CCBIN",
        "CUDA_PATH",
        "CUDA_HOME",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }

    if env::var_os("CARGO_FEATURE_GPU").is_none() {
        return;
    }

    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let include_dir = manifest_dir.join("Rotor-Cuda");

    let nvcc = locate_nvcc();
    let cuda_root = nvcc
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| {
            panic!(
                "cannot derive the CUDA root from nvcc path {} (expected <root>/bin/nvcc)",
                nvcc.display()
            )
        });
    let cudart_dir = if cfg!(windows) {
        cuda_root.join("lib").join("x64")
    } else {
        cuda_root.join("lib64")
    };
    if !cudart_dir.is_dir() {
        panic!(
            "CUDA runtime library directory not found: {}\n\
             expected cudart under the CUDA root {} (derived from nvcc {}).\n\
             Install the CUDA Toolkit's cudart component or set ROTOR_NVCC to a full toolkit nvcc.",
            cudart_dir.display(),
            cuda_root.display(),
            nvcc.display()
        );
    }

    let archs = parse_archs();
    let highest = *archs.iter().max().expect("archs is non-empty");
    let obj_ext = if cfg!(windows) { "obj" } else { "o" };

    let mut objects = Vec::new();
    for rel in CU_SOURCES {
        let src = manifest_dir.join(rel);
        let stem = Path::new(rel)
            .file_stem()
            .expect("CU source has a file stem")
            .to_string_lossy()
            .into_owned();
        let obj = out_dir.join(format!("{stem}.{obj_ext}"));

        let mut cmd = Command::new(&nvcc);
        cmd.arg("-c")
            .arg(&src)
            .arg("-o")
            .arg(&obj)
            .arg("-std=c++14")
            .arg("-I")
            .arg(&include_dir)
            .arg("--Wno-deprecated-gpu-targets");
        if let Some(ccbin) = env::var_os("NVCC_CCBIN")
            && !ccbin.is_empty()
        {
            cmd.arg("-ccbin").arg(ccbin);
        }
        for n in &archs {
            cmd.arg("-gencode")
                .arg(format!("arch=compute_{n},code=sm_{n}"));
        }
        // PTX for the highest arch so newer GPUs (e.g. RTX 5070 / sm_120) can JIT.
        cmd.arg("-gencode")
            .arg(format!("arch=compute_{highest},code=compute_{highest}"));

        let output = cmd.output().unwrap_or_else(|e| {
            panic!(
                "failed to run nvcc at {}: {e}\ncommand: {}",
                nvcc.display(),
                command_line(&cmd)
            )
        });
        if !output.status.success() {
            panic!(
                "nvcc failed for {} (exit code {:?})\ncommand: {}\nstdout:\n{}\nstderr:\n{}",
                src.display(),
                output.status.code(),
                command_line(&cmd),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }

        match fs::metadata(&obj) {
            Ok(meta) if meta.len() > 0 => {}
            Ok(_) => panic!(
                "nvcc reported success but produced an empty object file: {}",
                obj.display()
            ),
            Err(e) => panic!(
                "nvcc reported success but the object file {} is missing: {e}",
                obj.display()
            ),
        }
        objects.push(obj);
    }

    for obj in &objects {
        println!("cargo:rustc-link-arg-bins={}", obj.display());
        println!("cargo:rustc-link-arg-tests={}", obj.display());
    }
    println!("cargo:rustc-link-search=native={}", cudart_dir.display());
    // Static CUDA runtime: the release exe must run with only the NVIDIA driver
    // installed, without the CUDA Toolkit's cudart DLL being on PATH.
    println!("cargo:rustc-link-lib=static=cudart_static");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        // Host-side dependencies of libcudart_static that rustc does not add.
        for lib in ["pthread", "dl", "rt"] {
            println!("cargo:rustc-link-lib=dylib={lib}");
        }
    }
    // nvcc compiles the host side with g++, so the objects need the C++ runtime
    // that rustc does not link by default. MSVC objects carry the default-lib
    // directives themselves.
    match env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") => println!("cargo:rustc-link-lib=dylib=stdc++"),
        Ok("macos") => println!("cargo:rustc-link-lib=dylib=c++"),
        _ => {}
    }
}

/// Short git commit of the checkout being built, or `dev` outside a repository.
fn build_id() -> String {
    Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "dev".to_string())
}

fn nvcc_file_name() -> &'static str {
    if cfg!(windows) { "nvcc.exe" } else { "nvcc" }
}

/// Resolves the nvcc executable: `ROTOR_NVCC`, then `CUDA_PATH`/`CUDA_HOME`
/// (plus `CUDA_PATH_V*` on Windows, highest version first), then PATH.
fn locate_nvcc() -> PathBuf {
    if let Some(raw) = env::var_os("ROTOR_NVCC") {
        let candidate = PathBuf::from(&raw);
        if candidate.is_file() {
            return candidate;
        }
        if let Some(found) = search_path(&candidate) {
            return found;
        }
        panic!(
            "ROTOR_NVCC is set to {} but no such executable exists (and it is not on PATH)",
            candidate.display()
        );
    }

    for root in cuda_root_candidates() {
        let candidate = root.join("bin").join(nvcc_file_name());
        if candidate.is_file() {
            return candidate;
        }
    }

    if let Some(found) = search_path(Path::new(nvcc_file_name())) {
        return found;
    }

    panic!(
        "the `gpu` feature requires the NVIDIA CUDA Toolkit, but nvcc was not found.\n\
         Set CUDA_PATH (or CUDA_HOME) to the toolkit root, or ROTOR_NVCC to the full path of nvcc."
    );
}

/// Toolkit roots from the environment, best first.
fn cuda_root_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["CUDA_PATH", "CUDA_HOME"] {
        if let Some(value) = env::var_os(var)
            && !value.is_empty()
        {
            roots.push(PathBuf::from(value));
        }
    }

    if cfg!(windows) {
        let mut versioned: Vec<(Vec<u64>, PathBuf)> = env::vars_os()
            .filter_map(|(key, value)| {
                let key = key.to_string_lossy().into_owned();
                let suffix = key.strip_prefix("CUDA_PATH_V")?;
                if value.is_empty() {
                    return None;
                }
                Some((version_key(suffix), PathBuf::from(value)))
            })
            .collect();
        versioned.sort_by(|a, b| b.0.cmp(&a.0));
        roots.extend(versioned.into_iter().map(|(_, path)| path));
    }

    roots
}

/// `V12_5` -> [12, 5] so versioned env vars sort numerically, highest first.
fn version_key(suffix: &str) -> Vec<u64> {
    suffix
        .split(['_', '.'])
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

fn search_path(program: &Path) -> Option<PathBuf> {
    if program.components().count() > 1 {
        return None;
    }
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

fn parse_archs() -> Vec<u32> {
    let raw = match env::var("ROTOR_CUDA_ARCHS") {
        Ok(raw) => raw,
        Err(_) => return vec![75],
    };
    let mut archs = Vec::new();
    for token in raw.split(',') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        match token.parse::<u32>() {
            Ok(n) if n > 0 => archs.push(n),
            _ => panic!(
                "ROTOR_CUDA_ARCHS entry {token:?} is not a compute capability number \
                 (expected comma-separated numbers, e.g. 75,89)"
            ),
        }
    }
    if archs.is_empty() {
        panic!(
            "ROTOR_CUDA_ARCHS is set but lists no architectures \
             (expected comma-separated numbers, e.g. 75,89)"
        );
    }
    archs
}

fn command_line(cmd: &Command) -> String {
    let mut line = cmd.get_program().to_string_lossy().into_owned();
    for arg in cmd.get_args() {
        line.push(' ');
        push_arg(&mut line, &arg.to_string_lossy());
    }
    line
}

fn push_arg(line: &mut String, arg: &str) {
    if arg.contains(' ') || arg.contains('\t') {
        line.push('"');
        line.push_str(arg);
        line.push('"');
    } else {
        line.push_str(arg);
    }
}
