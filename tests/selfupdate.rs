//! Offline tests for the self-update helpers (no network access).

use std::cmp::Ordering;
use std::path::PathBuf;

use rotor::selfupdate::{
    cleanup_old_for, install_new_exe, parse_release_json_for, sha256_file, verify_sha_and_install,
    version_cmp,
};

// ---------------------------------------------------------------------------
// version_cmp — every case from Rotor-Cuda/bsgs/selfupdate_selftest.cpp
// ---------------------------------------------------------------------------

#[test]
fn version_cmp_matches_cpp_selftest() {
    assert_eq!(version_cmp("v1.2.3", "v1.2.3"), Ordering::Equal);
    // 'v' is just a separator.
    assert_eq!(version_cmp("1.2.3", "v1.2.3"), Ordering::Equal);
    // 10 > 3 numerically.
    assert_eq!(version_cmp("v1.2.3", "v1.2.10"), Ordering::Less);
    assert_eq!(version_cmp("v1.2.10", "v1.2.3"), Ordering::Greater);
    // Missing component == 0.
    assert_eq!(version_cmp("v1.2", "v1.2.0"), Ordering::Equal);
    assert_eq!(version_cmp("v1.2.0", "v1.2"), Ordering::Equal);
    assert_eq!(version_cmp("v2.0.0", "v1.9.9"), Ordering::Greater);
    assert_eq!(version_cmp("v0.0.0", "v1.0.0"), Ordering::Less);
    assert_eq!(version_cmp("v1.10.0", "v1.9.0"), Ordering::Greater);
    // No digits -> 0.0.0, so any release is newer.
    assert_eq!(version_cmp("dev", "v1.0.0"), Ordering::Less);
}

// ---------------------------------------------------------------------------
// Release JSON parsing
// ---------------------------------------------------------------------------

const CPU_RELEASE: &str = r#"{
  "url": "https://api.github.com/repos/mytab0r/Rotor-Cuda/releases/42",
  "tag_name": "v2.1.0",
  "name": "v2.1.0",
  "assets": [
    {
      "name": "Rotor-Cuda.exe",
      "browser_download_url": "https://github.com/mytab0r/Rotor-Cuda/releases/download/v2.1.0/Rotor-Cuda.exe"
    },
    {
      "name": "Rotor-Cuda-windows-x64-v2.1.0.zip",
      "browser_download_url": "https://github.com/mytab0r/Rotor-Cuda/releases/download/v2.1.0/Rotor-Cuda-windows-x64-v2.1.0.zip"
    },
    {
      "name": "rotor.exe",
      "browser_download_url": "https://github.com/mytab0r/Rotor-Cuda/releases/download/v2.1.0/rotor.exe"
    },
    {
      "name": "rotor.exe.sha256",
      "browser_download_url": "https://github.com/mytab0r/Rotor-Cuda/releases/download/v2.1.0/rotor.exe.sha256"
    }
  ]
}"#;

const GPU_RELEASE: &str = r#"{
  "tag_name": "v2.1.0",
  "assets": [
    {
      "name": "rotor.exe",
      "browser_download_url": "https://example.invalid/rotor.exe"
    },
    {
      "name": "rotor.exe.sha256",
      "browser_download_url": "https://example.invalid/rotor.exe.sha256"
    },
    {
      "name": "rotor-gpu.exe",
      "browser_download_url": "https://example.invalid/rotor-gpu.exe"
    },
    {
      "name": "rotor-gpu.exe.sha256",
      "browser_download_url": "https://example.invalid/rotor-gpu.exe.sha256"
    }
  ]
}"#;

#[test]
fn parse_cpu_release_picks_rust_assets_and_ignores_cpp() {
    let info = parse_release_json_for(CPU_RELEASE, "v2.0.0", "rotor.exe", "rotor.exe.sha256")
        .expect("CPU release should parse");

    assert_eq!(info.current, "v2.0.0");
    assert_eq!(info.latest, "v2.1.0");
    assert_eq!(
        info.exe_url.as_deref(),
        Some("https://github.com/mytab0r/Rotor-Cuda/releases/download/v2.1.0/rotor.exe")
    );
    assert_eq!(
        info.sha_url.as_deref(),
        Some("https://github.com/mytab0r/Rotor-Cuda/releases/download/v2.1.0/rotor.exe.sha256")
    );
    // The C++ binary must never be selected.
    assert_ne!(
        info.exe_url.as_deref(),
        Some("https://github.com/mytab0r/Rotor-Cuda/releases/download/v2.1.0/Rotor-Cuda.exe")
    );
    assert!(info.available);
    assert_eq!(
        info.available,
        version_cmp(&info.current, &info.latest) == Ordering::Less
    );
}

#[test]
fn parse_available_flag_follows_version_cmp() {
    for current in ["v2.0.0", "v2.0", "1.2.3", "dev"] {
        let info = parse_release_json_for(CPU_RELEASE, current, "rotor.exe", "rotor.exe.sha256")
            .expect("CPU release should parse");
        assert_eq!(
            info.available,
            version_cmp(current, "v2.1.0") == Ordering::Less,
            "available mismatch for {current}"
        );
    }

    let same = parse_release_json_for(CPU_RELEASE, "v2.1.0", "rotor.exe", "rotor.exe.sha256")
        .expect("CPU release should parse");
    assert!(!same.available);

    let newer = parse_release_json_for(CPU_RELEASE, "v2.2.0", "rotor.exe", "rotor.exe.sha256")
        .expect("CPU release should parse");
    assert!(!newer.available);
}

#[test]
fn parse_gpu_release_uses_gpu_suffixes() {
    let info = parse_release_json_for(
        GPU_RELEASE,
        "v2.0.0",
        "rotor-gpu.exe",
        "rotor-gpu.exe.sha256",
    )
    .expect("GPU release should parse");
    assert_eq!(
        info.exe_url.as_deref(),
        Some("https://example.invalid/rotor-gpu.exe")
    );
    assert_eq!(
        info.sha_url.as_deref(),
        Some("https://example.invalid/rotor-gpu.exe.sha256")
    );

    let cpu = parse_release_json_for(GPU_RELEASE, "v2.0.0", "rotor.exe", "rotor.exe.sha256")
        .expect("CPU assets should still parse from the same payload");
    assert_eq!(
        cpu.exe_url.as_deref(),
        Some("https://example.invalid/rotor.exe")
    );
    assert_eq!(
        cpu.sha_url.as_deref(),
        Some("https://example.invalid/rotor.exe.sha256")
    );
}

#[test]
fn parse_rejects_missing_tag_name() {
    let json = r#"{"assets":[{"name":"rotor.exe","browser_download_url":"https://x/rotor.exe"}]}"#;
    let err = parse_release_json_for(json, "v1.0.0", "rotor.exe", "rotor.exe.sha256")
        .expect_err("missing tag_name must fail");
    assert!(err.contains("tag_name"), "unexpected error: {err}");
}

#[test]
fn parse_surfaces_github_api_error_message() {
    let json = r#"{"message":"API rate limit exceeded for 203.0.113.7.","documentation_url":"https://docs.github.com/rest"}"#;
    let err = parse_release_json_for(json, "dev", "rotor.exe", "rotor.exe.sha256")
        .expect_err("an API error payload has no tag_name");
    assert!(
        err.contains("API rate limit exceeded"),
        "API message should be surfaced: {err}"
    );
}

#[test]
fn parse_rejects_missing_assets() {
    // Only the C++ asset is present: neither Rust asset can be matched.
    let json = r#"{
      "tag_name": "v2.1.0",
      "assets": [
        {"name": "Rotor-Cuda.exe", "browser_download_url": "https://x/Rotor-Cuda.exe"},
        {"name": "bundle.zip", "browser_download_url": "https://x/bundle.zip"}
      ]
    }"#;
    let err = parse_release_json_for(json, "v2.0.0", "rotor.exe", "rotor.exe.sha256")
        .expect_err("missing exe asset must fail");
    assert!(err.contains("rotor.exe"), "unexpected error: {err}");

    // Exe present, checksum missing.
    let no_sha = r#"{
      "tag_name": "v2.1.0",
      "assets": [
        {"name": "rotor.exe", "browser_download_url": "https://x/rotor.exe"}
      ]
    }"#;
    let err = parse_release_json_for(no_sha, "v2.0.0", "rotor.exe", "rotor.exe.sha256")
        .expect_err("missing sha asset must fail");
    assert!(err.contains("rotor.exe.sha256"), "unexpected error: {err}");
}

// ---------------------------------------------------------------------------
// SHA-256 and the file swap
// ---------------------------------------------------------------------------

fn temp_dir(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "rotor-selfupdate-{tag}-{}-{nanos}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn sha256_file_matches_crate_hash() {
    let dir = temp_dir("sha");
    let path = dir.join("payload.bin");
    let data = b"rotor self-update test payload";
    std::fs::write(&path, data).expect("write temp file");

    let expected = hex(&rotor::hashes::sha256(data));
    assert_eq!(sha256_file(&path).expect("hash file"), expected);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn install_new_exe_swaps_files_and_cleanup_removes_old() {
    let dir = temp_dir("swap");
    let self_path = dir.join("rotor.exe");
    let new_path = dir.join("rotor.exe.new");
    let old_path = dir.join("rotor.exe.old");

    std::fs::write(&self_path, b"old-binary").expect("write self");
    std::fs::write(&new_path, b"new-binary").expect("write new");

    install_new_exe(&self_path, &new_path).expect("swap should succeed");

    assert_eq!(std::fs::read(&self_path).expect("read self"), b"new-binary");
    assert!(!new_path.exists(), "downloaded .new should be moved away");
    assert_eq!(
        std::fs::read(&old_path).expect("read old"),
        b"old-binary",
        "previous binary should be kept as .old"
    );

    cleanup_old_for(&self_path);
    assert!(!old_path.exists(), ".old should be removed by cleanup");
    // A second cleanup on a missing file must not panic or fail.
    cleanup_old_for(&self_path);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn install_new_exe_rolls_back_when_new_is_missing() {
    let dir = temp_dir("rollback");
    let self_path = dir.join("rotor.exe");
    let missing_new = dir.join("rotor.exe.new");
    let old_path = dir.join("rotor.exe.old");

    std::fs::write(&self_path, b"old-binary").expect("write self");

    let err = install_new_exe(&self_path, &missing_new).expect_err("missing .new must fail");
    assert!(!err.is_empty());

    assert_eq!(
        std::fs::read(&self_path).expect("self must survive rollback"),
        b"old-binary"
    );
    assert!(!old_path.exists(), "rollback should move .old back to self");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn verify_sha_rejects_mismatch_without_touching_self_and_installs_on_match() {
    let dir = temp_dir("verify");
    let self_path = dir.join("rotor.exe");
    let new_path = dir.join("rotor.exe.new");
    std::fs::write(&self_path, b"old-binary").expect("write self");
    std::fs::write(&new_path, b"new-binary").expect("write new");

    let err = verify_sha_and_install(&self_path, &new_path, "deadbeef  rotor.exe")
        .expect_err("wrong checksum must fail");
    assert!(err.contains("sha256 mismatch"), "unexpected error: {err}");
    assert!(!new_path.exists(), "failed download must be removed");
    assert_eq!(
        std::fs::read(&self_path).expect("self must be untouched"),
        b"old-binary"
    );

    std::fs::write(&new_path, b"new-binary").expect("rewrite new");
    let hash = hex(&rotor::hashes::sha256(b"new-binary"));
    verify_sha_and_install(&self_path, &new_path, &format!("{hash}  rotor.exe"))
        .expect("matching checksum installs");
    assert_eq!(
        std::fs::read(&self_path).expect("read installed"),
        b"new-binary"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
