//! Safe wrapper over the `gpu` C ABI (`Rotor-Cuda/bsgs/BsgsGpuAbi.cu`).
//!
//! Only compiled with `--features gpu`. The ABI takes caller-allocated buffers,
//! so nothing heap-allocated crosses the boundary and a failed launch always
//! reports a NUL-terminated message instead of a panic.

use std::ffi::{CStr, c_char, c_int, c_uint};

/// Size of every C-side error/name buffer used here.
const ERROR_BUFFER_LEN: usize = 512;

unsafe extern "C" {
    fn rotor_gpu_device_count(err: *mut c_char, err_len: c_uint) -> c_int;
    fn rotor_gpu_device_name(device_index: c_int, buf: *mut c_char, buf_len: c_uint) -> c_int;
    fn rotor_bsgs_gpu_giant_dp(
        start_xy: *const u64,
        stride_xy: *const u64,
        n_walks: u32,
        n_steps: u32,
        w: u32,
        dp_bits: u32,
        max_hits: u32,
        device_index: c_int,
        out_walk: *mut u32,
        out_step: *mut u32,
        out_x: *mut u64,
        out_parity: *mut u8,
        out_total: *mut u64,
        out_stored: *mut u32,
        err: *mut c_char,
        err_len: c_uint,
    ) -> c_int;
}

/// Distinguished-point hits emitted by one giant-walk batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GiantHits {
    pub walk: Vec<u32>,
    pub step: Vec<u32>,
    /// Canonical little-endian X limbs, four per hit.
    pub x: Vec<u64>,
    pub parity: Vec<u8>,
    /// True emitted count, which may exceed `walk.len()` when truncated.
    pub total: u64,
}

fn error_buffer() -> [c_char; ERROR_BUFFER_LEN] {
    [0 as c_char; ERROR_BUFFER_LEN]
}

/// Convert a C string buffer into a Rust string; empty becomes a generic message.
fn error_message(buffer: &[c_char; ERROR_BUFFER_LEN]) -> String {
    // SAFETY: the C side NUL-terminates `err` on failure.
    let message = unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    if message.is_empty() {
        "unknown GPU error".to_string()
    } else {
        message
    }
}

/// Number of CUDA devices visible to the runtime.
pub fn device_count() -> Result<i32, String> {
    let mut err = error_buffer();
    // SAFETY: `err` is a valid buffer of the announced length.
    let count = unsafe { rotor_gpu_device_count(err.as_mut_ptr(), ERROR_BUFFER_LEN as c_uint) };
    if count < 0 {
        Err(error_message(&err))
    } else {
        Ok(count)
    }
}

/// Human-readable name of the CUDA device at `index`.
pub fn device_name(index: i32) -> Result<String, String> {
    let mut buf = error_buffer();
    // SAFETY: `buf` is a valid buffer of the announced length.
    let status =
        unsafe { rotor_gpu_device_name(index, buf.as_mut_ptr(), ERROR_BUFFER_LEN as c_uint) };
    if status != 0 {
        return Err(error_message(&buf));
    }
    // SAFETY: on success the C side NUL-terminates the name.
    Ok(unsafe { CStr::from_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .into_owned())
}

/// Run one giant-walk batch on `device`.
///
/// `starts` holds eight little-endian limbs (x then y) per walk; `stride` is
/// `S = m*G` in the same encoding. On success the hit vectors are truncated to
/// the number of records actually stored; `GiantHits::total` keeps the true
/// count so the caller can detect truncation (`total > max_hits`).
#[allow(clippy::too_many_arguments)]
pub fn launch_giant_dp(
    starts: &[u64],
    stride: &[u64; 8],
    n_walks: u32,
    n_steps: u32,
    w: u32,
    dp_bits: u32,
    max_hits: u32,
    device: i32,
) -> Result<GiantHits, String> {
    let expected = n_walks as usize * 8;
    if starts.len() != expected {
        return Err(format!(
            "starts buffer holds {} limbs, expected {expected} (8 per walk)",
            starts.len()
        ));
    }

    let capacity = max_hits as usize;
    let mut walk = vec![0u32; capacity];
    let mut step = vec![0u32; capacity];
    let mut x = vec![0u64; capacity * 4];
    let mut parity = vec![0u8; capacity];
    let mut total = 0u64;
    let mut stored = 0u32;
    let mut err = error_buffer();

    // SAFETY: every pointer refers to a live buffer sized from `max_hits` or to
    // a local scalar; the C side writes at most `max_hits` records.
    let status = unsafe {
        rotor_bsgs_gpu_giant_dp(
            starts.as_ptr(),
            stride.as_ptr(),
            n_walks,
            n_steps,
            w,
            dp_bits,
            max_hits,
            device,
            walk.as_mut_ptr(),
            step.as_mut_ptr(),
            x.as_mut_ptr(),
            parity.as_mut_ptr(),
            &mut total,
            &mut stored,
            err.as_mut_ptr(),
            ERROR_BUFFER_LEN as c_uint,
        )
    };
    if status != 0 {
        return Err(error_message(&err));
    }

    let stored = (stored as usize).min(capacity);
    walk.truncate(stored);
    step.truncate(stored);
    x.truncate(stored * 4);
    parity.truncate(stored);

    Ok(GiantHits {
        walk,
        step,
        x,
        parity,
        total,
    })
}
