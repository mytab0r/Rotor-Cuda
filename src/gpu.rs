//! Safe wrapper over the `gpu` C ABI (`Rotor-Cuda/bsgs/BsgsGpuAbi.cu`).
//!
//! Only compiled with `--features gpu`. The ABI takes caller-allocated buffers,
//! so nothing heap-allocated crosses the boundary and a failed launch always
//! reports a NUL-terminated message instead of a panic.

use std::ffi::{CStr, c_char, c_int, c_uint, c_void};

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

    fn rotor_addr_gpu_create(
        device_index: c_int,
        thread_groups: c_int,
        threads_per_group: c_int,
        max_found: u32,
        search_mode: c_int,
        comp_mode: c_int,
        coin_type: c_int,
        bloom_data: *const u8,
        bloom_size: u64,
        bloom_bits: u64,
        bloom_hashes: u8,
        single_target: *const u32,
        gen_x: *const u64,
        gen_y: *const u64,
        two_gn: *const u64,
        out_engine: *mut *mut c_void,
        out_nb_thread: *mut u32,
        err: *mut c_char,
        err_len: c_uint,
    ) -> c_int;
    fn rotor_addr_gpu_set_keys(
        engine: *mut c_void,
        xy: *const u64,
        err: *mut c_char,
        err_len: c_uint,
    ) -> c_int;
    fn rotor_addr_gpu_launch(
        engine: *mut c_void,
        out_tid: *mut u32,
        out_incr: *mut u32,
        out_mode: *mut u8,
        out_hash: *mut u8,
        out_total: *mut u32,
        out_stored: *mut u32,
        err: *mut c_char,
        err_len: c_uint,
    ) -> c_int;
    fn rotor_addr_gpu_destroy(engine: *mut c_void);
    fn rotor_addr_gpu_name(engine: *mut c_void, buf: *mut c_char, buf_len: c_uint) -> c_int;
    fn rotor_addr_gpu_step_size() -> c_int;
    fn rotor_addr_gpu_group_size() -> c_int;
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

// ---------------------------------------------------------------------------
// Address / xpoint search engine (`Rotor-Cuda/GPU/GpuAddressAbi.cu`)

/// One batch of bloom/target candidates. `hash` uses a 32-byte stride; hash
/// modes fill the first 20 bytes.
pub struct AddrHits<'a> {
    pub tid: &'a [u32],
    pub incr: &'a [u32],
    pub mode: &'a [u8],
    pub hash: &'a [u8],
    /// True emitted count before clamping (exceeding the buffer is an error).
    pub total: u64,
}

/// Owns one CUDA address-search engine and its reusable output buffers.
pub struct AddrEngine {
    handle: *mut c_void,
    nb_thread: u32,
    name: String,
    capacity: usize,
    tid: Vec<u32>,
    incr: Vec<u32>,
    mode: Vec<u8>,
    hash: Vec<u8>,
}

impl AddrEngine {
    /// Creates an engine for `search_mode` on `device`. Multi-target modes need
    /// the bloom filter; single modes need the 20/32-byte target.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        device: i32,
        thread_groups: i32,
        threads_per_group: i32,
        max_found: u32,
        search_mode: i32,
        comp_mode: i32,
        coin_type: i32,
        bloom: Option<(&[u8], u64, u8)>,
        single_target: Option<&[u32]>,
        gen_x: &[u64],
        gen_y: &[u64],
        two_gn: &[u64; 8],
    ) -> Result<Self, String> {
        if gen_x.len() != 1024 * 4 || gen_y.len() != 1024 * 4 {
            return Err(format!(
                "generator table must hold 4096 limbs per coordinate, got {} / {}",
                gen_x.len(),
                gen_y.len()
            ));
        }
        let (bloom_ptr, bloom_size, bloom_bits, bloom_hashes) = match bloom {
            Some((data, bits, hashes)) => (data.as_ptr(), data.len() as u64, bits, hashes),
            None => (std::ptr::null(), 0, 0, 0),
        };
        let target_ptr = single_target.map_or(std::ptr::null(), |target| target.as_ptr());

        let mut handle = std::ptr::null_mut();
        let mut nb_thread = 0u32;
        let mut err = error_buffer();
        // SAFETY: every pointer refers to a live slice or a local scalar, and
        // the C side copies the inputs before returning.
        let status = unsafe {
            rotor_addr_gpu_create(
                device,
                thread_groups,
                threads_per_group,
                max_found,
                search_mode,
                comp_mode,
                coin_type,
                bloom_ptr,
                bloom_size,
                bloom_bits,
                bloom_hashes,
                target_ptr,
                gen_x.as_ptr(),
                gen_y.as_ptr(),
                two_gn.as_ptr(),
                &mut handle,
                &mut nb_thread,
                err.as_mut_ptr(),
                ERROR_BUFFER_LEN as c_uint,
            )
        };
        if status != 0 {
            return Err(error_message(&err));
        }
        if handle.is_null() {
            return Err("GPU engine returned a null handle".to_string());
        }

        let capacity = max_found as usize;
        let mut engine = Self {
            handle,
            nb_thread,
            name: String::new(),
            capacity,
            tid: vec![0u32; capacity],
            incr: vec![0u32; capacity],
            mode: vec![0u8; capacity],
            hash: vec![0u8; capacity * 32],
        };
        engine.name = engine.query_name();
        Ok(engine)
    }

    fn query_name(&self) -> String {
        let mut buf = error_buffer();
        // SAFETY: `buf` is a valid buffer of the announced length.
        let status = unsafe {
            rotor_addr_gpu_name(self.handle, buf.as_mut_ptr(), ERROR_BUFFER_LEN as c_uint)
        };
        if status != 0 {
            return "CUDA device".to_string();
        }
        // SAFETY: on success the C side NUL-terminates the name.
        unsafe { CStr::from_ptr(buf.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }

    pub fn nb_thread(&self) -> u32 {
        self.nb_thread
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Uploads `nb_thread` starting points (`x[4] || y[4]` little-endian limbs)
    /// and launches the first batch.
    pub fn set_keys(&mut self, xy: &[u64]) -> Result<(), String> {
        let expected = self.nb_thread as usize * 8;
        if xy.len() != expected {
            return Err(format!(
                "starting keys hold {} limbs, expected {expected} (8 per thread)",
                xy.len()
            ));
        }
        let mut err = error_buffer();
        // SAFETY: `xy` holds exactly the announced number of limbs.
        let status = unsafe {
            rotor_addr_gpu_set_keys(
                self.handle,
                xy.as_ptr(),
                err.as_mut_ptr(),
                ERROR_BUFFER_LEN as c_uint,
            )
        };
        if status != 0 {
            return Err(error_message(&err));
        }
        Ok(())
    }

    /// Reads the previous batch and starts the next one.
    pub fn launch(&mut self) -> Result<AddrHits<'_>, String> {
        let mut total = 0u32;
        let mut stored = 0u32;
        let mut err = error_buffer();
        // SAFETY: all output buffers are sized from `capacity`.
        let status = unsafe {
            rotor_addr_gpu_launch(
                self.handle,
                self.tid.as_mut_ptr(),
                self.incr.as_mut_ptr(),
                self.mode.as_mut_ptr(),
                self.hash.as_mut_ptr(),
                &mut total,
                &mut stored,
                err.as_mut_ptr(),
                ERROR_BUFFER_LEN as c_uint,
            )
        };
        if status != 0 {
            return Err(error_message(&err));
        }
        if total as usize > self.capacity {
            return Err(format!(
                "GPU output buffer overflowed: {total} hits, capacity {}",
                self.capacity
            ));
        }
        let stored = (stored as usize).min(self.capacity);
        Ok(AddrHits {
            tid: &self.tid[..stored],
            incr: &self.incr[..stored],
            mode: &self.mode[..stored],
            hash: &self.hash[..stored * 32],
            total: u64::from(total),
        })
    }
}

impl Drop for AddrEngine {
    fn drop(&mut self) {
        // SAFETY: the handle comes from `rotor_addr_gpu_create` and is destroyed once.
        unsafe { rotor_addr_gpu_destroy(self.handle) };
    }
}

/// Keys advanced per kernel batch (`STEP_SIZE`).
pub fn step_size() -> u32 {
    // SAFETY: pure constant accessor.
    unsafe { rotor_addr_gpu_step_size() as u32 }
}

/// Keys per thread group (`GRP_SIZE`).
pub fn group_size() -> u32 {
    // SAFETY: pure constant accessor.
    unsafe { rotor_addr_gpu_group_size() as u32 }
}
