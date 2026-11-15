//! Windows-only self-update for the Rust binary.
//!
//! A running Windows `.exe` cannot be overwritten, but it *can* be renamed. So
//! the updater downloads a new binary to `<self>.new`, verifies its SHA-256,
//! moves the live exe aside to `<self>.old`, moves the new one into place,
//! relaunches, and deletes `<self>.old` on the next start. Rollback is attempted
//! if the second rename fails.
//!
//! Network access uses WinHTTP through `windows-sys` (no TLS crate, no C
//! compiler); the parsing, hashing and swap helpers are platform-independent so
//! the tests never touch the network.

use std::cmp::Ordering;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Version stamped by the release workflow (`ROTOR_VERSION=<tag>`), or `dev`
/// for local builds. A local `dev` build compares as `0.0.0`.
pub const VERSION: &str = match option_env!("ROTOR_VERSION") {
    Some(version) => version,
    None => "dev",
};

#[cfg(not(windows))]
const NOT_SUPPORTED: &str = "self-update is not supported on this platform";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub exe_url: Option<String>,
    pub sha_url: Option<String>,
}

/// Component-wise numeric comparison of version strings.
///
/// Mirrors the C++ `rotor_update::version_cmp`: digit runs are compared
/// numerically, every non-digit is a separator, and a missing component counts
/// as zero (`v1.2 == v1.2.0`). A string without digits (`dev`) is `0.0.0`.
pub fn version_cmp(a: &str, b: &str) -> Ordering {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0usize, 0usize);
    loop {
        while i < ab.len() && !ab[i].is_ascii_digit() {
            i += 1;
        }
        while j < bb.len() && !bb[j].is_ascii_digit() {
            j += 1;
        }

        let mut va: u64 = 0;
        while i < ab.len() && ab[i].is_ascii_digit() {
            va = va
                .saturating_mul(10)
                .saturating_add(u64::from(ab[i] - b'0'));
            i += 1;
        }
        let mut vb: u64 = 0;
        while j < bb.len() && bb[j].is_ascii_digit() {
            vb = vb
                .saturating_mul(10)
                .saturating_add(u64::from(bb[j] - b'0'));
            j += 1;
        }

        if va != vb {
            return va.cmp(&vb);
        }
        if i >= ab.len() && j >= bb.len() {
            return Ordering::Equal;
        }
    }
}

/// Asset suffixes for this build: `rotor.exe` for CPU, `rotor-gpu.exe` when the
/// `gpu` feature is enabled. The C++ `Rotor-Cuda.exe` is deliberately never
/// considered — it would replace the Rust binary with a different implementation.
#[cfg(windows)]
fn asset_suffixes() -> (&'static str, &'static str) {
    if cfg!(feature = "gpu") {
        ("rotor-gpu.exe", "rotor-gpu.exe.sha256")
    } else {
        ("rotor.exe", "rotor.exe.sha256")
    }
}

/// Query GitHub for the latest release and compare it with `current`.
pub fn check_latest(repo: &str, current: &str) -> Result<UpdateInfo, String> {
    #[cfg(not(windows))]
    {
        let _ = (repo, current);
        return Err(NOT_SUPPORTED.to_string());
    }

    #[cfg(windows)]
    {
        let path = format!("/repos/{repo}/releases/latest");
        let body = https_get("api.github.com", &path)?;
        let json = String::from_utf8_lossy(&body);
        let (exe_suffix, sha_suffix) = asset_suffixes();
        parse_release_json_for(&json, current, exe_suffix, sha_suffix)
    }
}

/// Download, verify and install the release described by `info`.
///
/// `args` are the arguments passed to the relaunched process (usually everything
/// after `argv[0]`). With `restart`, this function spawns the new binary and
/// exits the current process; it never returns on success in that case.
pub fn apply_update(info: &UpdateInfo, args: &[String], restart: bool) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (info, args, restart);
        return Err(NOT_SUPPORTED.to_string());
    }

    #[cfg(windows)]
    {
        let exe_url = info
            .exe_url
            .as_deref()
            .ok_or_else(|| "release missing exe asset".to_string())?;
        let sha_url = info
            .sha_url
            .as_deref()
            .ok_or_else(|| "release missing sha256 asset".to_string())?;
        let self_path =
            std::env::current_exe().map_err(|e| format!("cannot locate current exe: {e}"))?;
        let new_path = with_suffix(&self_path, ".new");

        let exe_body = download_url(exe_url)?;
        if let Err(err) = std::fs::write(&new_path, &exe_body) {
            let _ = std::fs::remove_file(&new_path);
            return Err(format!("cannot write {}: {err}", new_path.display()));
        }

        let sha_body = match download_url(sha_url) {
            Ok(body) => body,
            Err(err) => {
                let _ = std::fs::remove_file(&new_path);
                return Err(err);
            }
        };
        let sha_text = String::from_utf8_lossy(&sha_body);
        verify_sha_and_install(&self_path, &new_path, &sha_text)?;

        if restart {
            let mut command = std::process::Command::new(&self_path);
            command.args(args);
            let _ = command.spawn();
            std::process::exit(0);
        }
        Ok(())
    }
}

/// Delete a leftover `<self>.old` from a previous update. Safe no-op if absent.
pub fn cleanup_old() {
    #[cfg(windows)]
    if let Ok(self_path) = std::env::current_exe() {
        cleanup_old_for(&self_path);
    }
}

/// Delete `<self_path>.old`, ignoring a missing file (and every other error:
/// cleanup is best-effort, mirroring the C++ `DeleteFileA` call).
#[doc(hidden)]
pub fn cleanup_old_for(self_path: &Path) {
    let _ = std::fs::remove_file(with_suffix(self_path, ".old"));
}

// ---------------------------------------------------------------------------
// Release JSON parsing (platform-independent, tested offline)
// ---------------------------------------------------------------------------

/// Extract `"key":"value"` from `json` starting at the first `"key"` occurrence.
fn json_str(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{key}\"");
    let pos = json.find(&pattern)?;
    let rest = &json[pos + pattern.len()..];
    let colon = rest.find(':')?;
    let rest = &rest[colon + 1..];
    let start = rest.find('"')?;
    let rest = &rest[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Find the `browser_download_url` of the first asset whose `name` ends with
/// `suffix`, mirroring the C++ line scan (name, then nearest download URL).
fn asset_url(json: &str, suffix: &str) -> Option<String> {
    let mut pos = 0;
    while let Some(rel) = json[pos..].find("\"name\"") {
        let name_pos = pos + rel;
        let tail = &json[name_pos..];
        let name = json_str(tail, "name").unwrap_or_default();
        let url = tail
            .find("browser_download_url")
            // `tail` starts at the key word, without the leading quote that
            // `json_str` expects, so parse the value from the colon onward.
            .and_then(|up| {
                let after_key = &tail[up..];
                let colon = after_key.find(':')?;
                let after_colon = &after_key[colon + 1..];
                let start = after_colon.find('"')?;
                let value = &after_colon[start + 1..];
                let end = value.find('"')?;
                Some(value[..end].to_string())
            })
            .unwrap_or_default();
        if name.ends_with(suffix) && !url.is_empty() {
            return Some(url);
        }
        pos = name_pos + 6;
    }
    None
}

/// Parse a GitHub `releases/latest` payload.
///
/// `exe_suffix` / `sha_suffix` select the asset variant for this build. Both
/// assets must be present; a missing `tag_name` or asset is an error.
#[doc(hidden)]
pub fn parse_release_json_for(
    json: &str,
    current: &str,
    exe_suffix: &str,
    sha_suffix: &str,
) -> Result<UpdateInfo, String> {
    let latest = json_str(json, "tag_name").ok_or_else(|| match json_str(json, "message") {
        // GitHub error payloads (rate limit, auth, missing repo) carry `message`.
        Some(message) => format!("GitHub API: {message}"),
        None => "no tag_name in release JSON".to_string(),
    })?;
    let exe_url =
        asset_url(json, exe_suffix).ok_or_else(|| format!("release has no {exe_suffix} asset"))?;
    let sha_url =
        asset_url(json, sha_suffix).ok_or_else(|| format!("release has no {sha_suffix} asset"))?;
    let available = version_cmp(current, &latest) == Ordering::Less;

    Ok(UpdateInfo {
        current: current.to_string(),
        latest,
        available,
        exe_url: Some(exe_url),
        sha_url: Some(sha_url),
    })
}

// ---------------------------------------------------------------------------
// File helpers (platform-independent, tested offline)
// ---------------------------------------------------------------------------

/// Append a textual suffix to a path (`self` + `".old"`, exactly like C++).
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Lowercase hex SHA-256 of a file's contents.
#[doc(hidden)]
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let data = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(hex_lower(&crate::hashes::sha256(&data)))
}

/// Swap `new_path` into `self_path`: remove a stale `.old`, rename self aside,
/// then rename new into place. On failure the old binary is restored.
#[doc(hidden)]
pub fn install_new_exe(self_path: &Path, new_path: &Path) -> Result<(), String> {
    let old_path = with_suffix(self_path, ".old");

    match std::fs::remove_file(&old_path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("cannot remove stale {}: {err}", old_path.display())),
    }

    std::fs::rename(self_path, &old_path).map_err(|e| format!("cannot rename running exe: {e}"))?;

    if let Err(err) = std::fs::rename(new_path, self_path) {
        return match std::fs::rename(&old_path, self_path) {
            Ok(()) => Err(format!("cannot install new exe (rolled back): {err}")),
            Err(rollback) => Err(format!(
                "cannot install new exe: {err}; rollback failed: {rollback}"
            )),
        };
    }
    Ok(())
}

/// Verify the downloaded executable against a `.sha256` body (first token) and
/// install it. On any error the downloaded `.new` file is removed, so a failed
/// `--update` leaves the installation untouched and no temp file behind.
#[doc(hidden)]
pub fn verify_sha_and_install(
    self_path: &Path,
    new_path: &Path,
    sha_body: &str,
) -> Result<(), String> {
    let want = sha_body
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let result = match sha256_file(new_path) {
        Ok(got) if !want.is_empty() && got == want => install_new_exe(self_path, new_path),
        Ok(_) => Err("sha256 mismatch".to_string()),
        Err(err) => Err(err),
    };
    if result.is_err() {
        let _ = std::fs::remove_file(new_path);
    }
    result
}

#[cfg(windows)]
mod winhttp {
    use windows_sys::Win32::Foundation::BOOL;
    use windows_sys::Win32::Networking::WinHttp::{
        INTERNET_DEFAULT_HTTPS_PORT, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_ADDREQ_FLAG_ADD,
        WINHTTP_FLAG_SECURE, WinHttpAddRequestHeaders, WinHttpCloseHandle, WinHttpConnect,
        WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable, WinHttpReadData,
        WinHttpReceiveResponse, WinHttpSendRequest,
    };

    /// Owned WinHTTP handle; closed exactly once, on every path.
    pub(super) struct Handle(*mut core::ffi::c_void);

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: this guard was built from a non-null WinHTTP handle and is
            // dropped exactly once, so the handle is closed exactly once.
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }

    /// NUL-terminated UTF-16 for WinHTTP's `PCWSTR` arguments.
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn ok(value: BOOL, what: &str) -> Result<(), String> {
        if value == 0 {
            Err(format!("{what} failed"))
        } else {
            Ok(())
        }
    }

    pub(super) fn open(user_agent: &str) -> Result<Handle, String> {
        let agent = wide(user_agent);
        // SAFETY: `agent` is NUL-terminated and alive for the call; null proxy
        // name/bypass arguments request the default proxy configuration.
        let raw = unsafe {
            WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                std::ptr::null(),
                std::ptr::null(),
                0,
            )
        };
        if raw.is_null() {
            return Err("WinHttpOpen failed".to_string());
        }
        Ok(Handle(raw))
    }

    pub(super) fn connect(session: &Handle, host: &str) -> Result<Handle, String> {
        let host = wide(host);
        // SAFETY: `session` is an open handle and `host` is NUL-terminated and
        // alive for the call.
        let raw =
            unsafe { WinHttpConnect(session.0, host.as_ptr(), INTERNET_DEFAULT_HTTPS_PORT, 0) };
        if raw.is_null() {
            return Err("WinHttpConnect failed".to_string());
        }
        Ok(Handle(raw))
    }

    pub(super) fn open_request(connection: &Handle, path: &str) -> Result<Handle, String> {
        let verb = wide("GET");
        let path = wide(path);
        // SAFETY: `connection` is an open handle; the verb/path are NUL-terminated
        // and alive for the call; null version/referrer/accept-types are allowed.
        let raw = unsafe {
            WinHttpOpenRequest(
                connection.0,
                verb.as_ptr(),
                path.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                WINHTTP_FLAG_SECURE,
            )
        };
        if raw.is_null() {
            return Err("WinHttpOpenRequest failed".to_string());
        }
        Ok(Handle(raw))
    }

    pub(super) fn add_headers(request: &Handle, headers: &str) -> Result<(), String> {
        let headers = wide(headers);
        // SAFETY: `request` is an open handle; `headers` is NUL-terminated and
        // alive for the call; `u32::MAX` means "length of the NUL-terminated
        // string" (-1 in the C API).
        let result = unsafe {
            WinHttpAddRequestHeaders(
                request.0,
                headers.as_ptr(),
                u32::MAX,
                WINHTTP_ADDREQ_FLAG_ADD,
            )
        };
        ok(result, "WinHttpAddRequestHeaders")
    }

    pub(super) fn send(request: &Handle) -> Result<(), String> {
        // SAFETY: `request` is an open handle; all optional-header/data pointers
        // are null with zero lengths.
        let result = unsafe {
            WinHttpSendRequest(request.0, std::ptr::null(), 0, std::ptr::null(), 0, 0, 0)
        };
        ok(result, "WinHttpSendRequest")
    }

    pub(super) fn receive(request: &Handle) -> Result<(), String> {
        // SAFETY: `request` is an open handle with a completed send; reserved is null.
        let result = unsafe { WinHttpReceiveResponse(request.0, std::ptr::null_mut()) };
        ok(result, "WinHttpReceiveResponse")
    }

    pub(super) fn read_all(request: &Handle) -> Result<Vec<u8>, String> {
        let mut body = Vec::new();
        loop {
            let mut available: u32 = 0;
            // SAFETY: `request` is an open handle; `available` points at a valid u32.
            let result = unsafe { WinHttpQueryDataAvailable(request.0, &mut available) };
            ok(result, "WinHttpQueryDataAvailable")?;
            if available == 0 {
                break;
            }

            let mut chunk = vec![0u8; available as usize];
            let mut got: u32 = 0;
            // SAFETY: `chunk` provides `available` writable bytes and `got` is a
            // valid out-pointer; the request handle stays open across the call.
            let result = unsafe {
                WinHttpReadData(request.0, chunk.as_mut_ptr().cast(), available, &mut got)
            };
            ok(result, "WinHttpReadData")?;
            chunk.truncate(got as usize);
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

#[cfg(windows)]
fn https_get(host: &str, path: &str) -> Result<Vec<u8>, String> {
    let session = winhttp::open("Rotor-Cuda-Updater")?;
    let connection = winhttp::connect(&session, host)?;
    let request = winhttp::open_request(&connection, path)?;
    // GitHub requires a User-Agent (the API rejects requests without one).
    winhttp::add_headers(
        &request,
        "User-Agent: Rotor-Cuda-Updater\r\nAccept: */*\r\n",
    )?;
    winhttp::send(&request)?;
    winhttp::receive(&request)?;
    winhttp::read_all(&request)
}

#[cfg(windows)]
fn split_url(url: &str) -> Result<(String, String), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("bad url (expected https): {url}"))?;
    let (host, path) = match rest.find('/') {
        Some(slash) => (&rest[..slash], &rest[slash..]),
        None => (rest, "/"),
    };
    if host.is_empty() {
        return Err(format!("bad url (empty host): {url}"));
    }
    Ok((host.to_string(), path.to_string()))
}

#[cfg(windows)]
fn download_url(url: &str) -> Result<Vec<u8>, String> {
    let (host, path) = split_url(url)?;
    https_get(&host, &path)
}
