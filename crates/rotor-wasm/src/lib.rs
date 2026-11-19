//! WebAssembly scan core for the browser client.
//!
//! This crate reuses the pure-Rust secp256k1 modules of the parent package via
//! `#[path]` includes. It exports a hand-written pointer/length ABI; there is
//! no wasm-bindgen, no threading and no clock. One instance is driven by one
//! worker and all calls are sequential.
//!
//! Result blob of [`scan`]: little-endian `u64 scanned`, `u32 found`; when
//! `found == 1` an `u32 key_len`, the 64-character ASCII hex private key, an
//! `u32 addr_len` and the BTC P2PKH address (empty for xpoint/ETH modes).
//!
//! Result blob of [`samples`]: little-endian `u32 count`, then per sample an
//! `u32 len` and the sample bytes.
//!
//! Result blob of [`derive_report`]: the UTF-8 JSON derivation report of one
//! private key (see [`derive`]); on error the status is nonzero and the error
//! buffer describes the problem.
//!
//! Result blob of [`evm_sign_tx`]: the `0x`-prefixed raw EIP-1559 type-2
//! signed transaction, ready for `eth_sendRawTransaction`; on error the status
//! is nonzero and the error buffer names the first invalid request field.

#![allow(dead_code)]
// the included parent modules expose more than this ABI uses
// The parent modules are reused verbatim; this style lint is not worth editing
// copies of upstream files for.
#![allow(clippy::wrong_self_convention)]

#[path = "../../../src/base58.rs"]
mod base58;
#[path = "../../../src/field.rs"]
mod field;
#[path = "../../../src/hashes.rs"]
mod hashes;
#[path = "../../../src/point.rs"]
mod point;
#[path = "../../../src/scalar.rs"]
mod scalar;
#[path = "../../../src/secp.rs"]
mod secp;

mod bech32;
mod derive;
mod evm;
mod keystore;
mod sign;

use std::alloc::{Layout, alloc as rust_alloc, dealloc as rust_dealloc};
use std::cell::UnsafeCell;
use std::cmp::Ordering;
use std::collections::HashSet;

use point::{Affine, Jacobian};
use scalar::Scalar;

/// Keys chained per batch; one field inversion per batch.
const BATCH_SIZE: usize = 2048;

/// Mode values accepted by [`set_job`].
const MODE_BTC_ADDRESS: u32 = 0;
const MODE_BTC_XPOINT: u32 = 1;
const MODE_ETH_ADDRESS: u32 = 2;

/// Returns of the ABI status codes.
const OK: u32 = 0;
const ERR_BAD_TARGET: u32 = 1;
const ERR_EMPTY_LIST: u32 = 2;
const ERR_UNSUPPORTED: u32 = 3;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Comp {
    Compressed,
    Uncompressed,
    Both,
}

impl Comp {
    /// Compression flags to try, in order.
    fn flags(self) -> &'static [bool] {
        match self {
            Comp::Compressed => &[true],
            Comp::Uncompressed => &[false],
            Comp::Both => &[true, false],
        }
    }

    /// Compression used to build a sample when `Both` is requested (the
    /// coordinator accepts either, and native samples use compressed).
    fn sample_compressed(self) -> bool {
        !matches!(self, Comp::Uncompressed)
    }
}

enum Job {
    Address {
        hashes: HashSet<[u8; 20]>,
        comp: Comp,
    },
    Eth {
        hashes: HashSet<[u8; 20]>,
    },
    XPoint {
        xs: HashSet<[u8; 32]>,
    },
}

/// What matched the point under inspection.
enum Hit {
    /// The matching hash160 and the compression flag that produced it.
    Address([u8; 20], bool),
    XPoint,
    Eth,
}

impl Job {
    fn check(&self, point: &Affine) -> Option<Hit> {
        match self {
            Job::Address { hashes, comp } => {
                for &compressed in comp.flags() {
                    let hash = secp::hash160(point, compressed);
                    if hashes.contains(&hash) {
                        return Some(Hit::Address(hash, compressed));
                    }
                }
                None
            }
            Job::Eth { hashes } => {
                let address = secp::eth_address(point);
                if hashes.contains(&address) {
                    Some(Hit::Eth)
                } else {
                    None
                }
            }
            Job::XPoint { xs } => {
                if xs.contains(&point.x.to_bytes_be()) {
                    Some(Hit::XPoint)
                } else {
                    None
                }
            }
        }
    }

    fn sample(&self, point: &Affine) -> Vec<u8> {
        match self {
            Job::XPoint { .. } => point.x.to_bytes_be().to_vec(),
            Job::Eth { .. } => secp::eth_address(point).to_vec(),
            Job::Address { comp, .. } => secp::hash160(point, comp.sample_compressed()).to_vec(),
        }
    }

    fn sample_len(&self) -> usize {
        match self {
            Job::XPoint { .. } => 32,
            _ => 20,
        }
    }
}

/// One scan session: the active job, the last result blob and the last error.
pub struct Session {
    job: Option<Job>,
    result: Vec<u8>,
    error: Vec<u8>,
}

impl Default for Session {
    fn default() -> Session {
        Session::new()
    }
}

impl Session {
    pub const fn new() -> Session {
        Session {
            job: None,
            result: Vec::new(),
            error: Vec::new(),
        }
    }

    fn set_error(&mut self, message: impl AsRef<str>) {
        self.error.clear();
        self.error.extend_from_slice(message.as_ref().as_bytes());
    }

    /// Parse the newline-separated target list and replace the active job.
    ///
    /// `mode`: 0 BTC address, 1 BTC xpoint, 2 ETH address. `comp`: 0
    /// compressed, 1 uncompressed, 2 both (address modes only).
    pub fn set_job(&mut self, mode: u32, comp: u32, targets: &str) -> u32 {
        self.result.clear();
        self.error.clear();

        let comp_mode = match mode {
            MODE_BTC_ADDRESS | MODE_ETH_ADDRESS => match comp {
                0 => Comp::Compressed,
                1 => Comp::Uncompressed,
                2 => Comp::Both,
                other => {
                    self.set_error(format!("unsupported compression mode: {other}"));
                    return ERR_UNSUPPORTED;
                }
            },
            MODE_BTC_XPOINT => Comp::Compressed, // ignored for xpoint mode
            other => {
                self.set_error(format!("unsupported mode: {other}"));
                return ERR_UNSUPPORTED;
            }
        };

        let lines: Vec<&str> = targets
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        if lines.is_empty() {
            self.set_error("target list is empty");
            return ERR_EMPTY_LIST;
        }

        match mode {
            MODE_BTC_ADDRESS => {
                let mut hashes = HashSet::with_capacity(lines.len());
                for line in &lines {
                    match parse_btc_address(line) {
                        Some(hash) => {
                            hashes.insert(hash);
                        }
                        None => {
                            self.set_error(format!("invalid BTC address target: {line}"));
                            return ERR_BAD_TARGET;
                        }
                    }
                }
                self.job = Some(Job::Address {
                    hashes,
                    comp: comp_mode,
                });
            }
            MODE_BTC_XPOINT => {
                let mut xs = HashSet::with_capacity(lines.len());
                for line in &lines {
                    match parse_xpoint(line) {
                        Some(x) => {
                            xs.insert(x);
                        }
                        None => {
                            self.set_error(format!("invalid xpoint target: {line}"));
                            return ERR_BAD_TARGET;
                        }
                    }
                }
                self.job = Some(Job::XPoint { xs });
            }
            MODE_ETH_ADDRESS => {
                let mut hashes = HashSet::with_capacity(lines.len());
                for line in &lines {
                    match parse_eth_address(line) {
                        Some(hash) => {
                            hashes.insert(hash);
                        }
                        None => {
                            self.set_error(format!("invalid ETH address target: {line}"));
                            return ERR_BAD_TARGET;
                        }
                    }
                }
                self.job = Some(Job::Eth { hashes });
            }
            _ => unreachable!("mode was validated above"),
        }
        OK
    }

    /// Scan the half-open scalar range `[start, end)`, stopping at the first
    /// match.
    pub fn scan(&mut self, start: &Scalar, end: &Scalar) -> u32 {
        self.result.clear();
        self.error.clear();

        let Some(job) = self.job.as_ref() else {
            self.set_error("set_job must be called before scan");
            return ERR_BAD_TARGET;
        };

        match start.cmp(end) {
            Ordering::Greater => {
                self.set_error("start must not be greater than end");
                return ERR_BAD_TARGET;
            }
            Ordering::Equal => {
                self.write_scan_result(0, None);
                return OK;
            }
            Ordering::Less => {}
        }

        let (scanned, found) = scan_range(job, start, end);
        self.write_scan_result(scanned, found);
        OK
    }

    /// Build one sample per offset, starting at `start`. Offsets are little
    /// endian `u32` values, as written by a JS `Uint32Array` on wasm.
    pub fn samples(&mut self, start: &Scalar, offsets: &[u32]) -> u32 {
        self.result.clear();
        self.error.clear();

        let Some(job) = self.job.as_ref() else {
            self.set_error("set_job must be called before samples");
            return ERR_BAD_TARGET;
        };

        // No pre-reservation: the count is caller-controlled and a huge value
        // must not overflow the capacity arithmetic.
        let mut out = Vec::new();
        out.extend_from_slice(&(offsets.len() as u32).to_le_bytes());
        for &offset in offsets {
            let key = start.add_u64(u64::from(offset));
            let sample = if key.is_zero() {
                vec![0u8; job.sample_len()]
            } else {
                job.sample(&secp::mul_g(&key))
            };
            out.extend_from_slice(&(sample.len() as u32).to_le_bytes());
            out.extend_from_slice(&sample);
        }
        self.result = out;
        OK
    }

    /// Derive the full key/address report as UTF-8 JSON.
    ///
    /// `curve`: 0 secp256k1, 1 ed25519. On success the report is in `result`;
    /// on failure `error` explains why and the status is nonzero.
    pub fn derive_report(&mut self, key: &[u8; 32], curve: u32) -> u32 {
        self.result.clear();
        self.error.clear();

        match derive::report(key, curve) {
            Ok(json) => {
                self.result = json.into_bytes();
                OK
            }
            Err(message) => {
                self.set_error(message);
                if curve > 1 {
                    ERR_UNSUPPORTED
                } else {
                    ERR_BAD_TARGET
                }
            }
        }
    }

    /// Public-key report: addresses only, no private material.
    pub fn pubkey_report(&mut self, text: &str) -> u32 {
        self.result.clear();
        self.error.clear();

        match derive::pubkey_report(text) {
            Ok(json) => {
                self.result = json.into_bytes();
                OK
            }
            Err(message) => {
                self.set_error(message);
                ERR_BAD_TARGET
            }
        }
    }

    /// Add two secp256k1 public keys and report the compressed/uncompressed sum.
    pub fn pubkey_add(&mut self, first: &str, second: &str) -> u32 {
        self.result.clear();
        self.error.clear();

        match derive::pubkey_add_report(first, second) {
            Ok(json) => {
                self.result = json.into_bytes();
                OK
            }
            Err(message) => {
                self.set_error(message);
                ERR_BAD_TARGET
            }
        }
    }

    /// Decrypt a V3 keystore; the result is the 64-character hex private key.
    pub fn keystore_decrypt(&mut self, request: &keystore::Request<'_>) -> u32 {
        self.result.clear();
        self.error.clear();

        match keystore::decrypt(request) {
            Ok(key) => {
                self.result = derive::hex(&key).into_bytes();
                OK
            }
            Err(message) => {
                self.set_error(message);
                ERR_BAD_TARGET
            }
        }
    }

    /// Parse, sign and serialize an EIP-1559 type-2 transaction.
    ///
    /// The request is a flat JSON object; the result is the `0x`-prefixed raw
    /// signed transaction. The private key is wiped from the parsed request
    /// before this returns.
    pub fn evm_sign_tx(&mut self, request: &str) -> u32 {
        self.result.clear();
        self.error.clear();

        match evm::sign_request(request) {
            Ok(raw) => {
                self.result = evm::hex_prefixed(&raw).into_bytes();
                OK
            }
            Err(message) => {
                self.set_error(message);
                ERR_BAD_TARGET
            }
        }
    }

    /// Zero and drop the last result blob. The keystore page calls this after
    /// reading a decrypted private key so it does not linger in wasm memory.
    pub fn clear_result(&mut self) {
        self.result.fill(0);
        self.result.clear();
    }

    fn write_scan_result(&mut self, scanned: u64, found: Option<(Scalar, String)>) {
        let mut out = Vec::with_capacity(128);
        out.extend_from_slice(&scanned.to_le_bytes());
        match found {
            None => out.extend_from_slice(&0u32.to_le_bytes()),
            Some((key, address)) => {
                out.extend_from_slice(&1u32.to_le_bytes());
                let key_hex = key.to_hex();
                out.extend_from_slice(&(key_hex.len() as u32).to_le_bytes());
                out.extend_from_slice(key_hex.as_bytes());
                out.extend_from_slice(&(address.len() as u32).to_le_bytes());
                out.extend_from_slice(address.as_bytes());
            }
        }
        self.result = out;
    }
}

/// Walk `[start, end)` and return how many keys were checked plus the found
/// key/address pair.
fn scan_range(job: &Job, start: &Scalar, end: &Scalar) -> (u64, Option<(Scalar, String)>) {
    let generator = secp::g();
    let mut key = *start;
    let mut remaining = end.sub(start);
    let mut current = if start.is_zero() {
        Jacobian::infinity()
    } else {
        Jacobian::from_affine(&secp::mul_g(start))
    };
    let mut scanned: u64 = 0;

    loop {
        let batch = if remaining < Scalar::from_u64(BATCH_SIZE as u64) {
            scalar_to_u64(&remaining)
        } else {
            BATCH_SIZE as u64
        };

        let mut points = Vec::with_capacity(batch as usize);
        let mut cursor = current;
        for _ in 0..batch {
            points.push(cursor);
            cursor = cursor.add_affine(&generator);
        }
        current = cursor;

        let affine = point::batch_to_affine(&points);
        for (index, maybe_point) in affine.iter().enumerate() {
            let Some(point) = maybe_point else {
                continue; // the point at infinity (key 0) — counted, not checked
            };
            if let Some(hit) = job.check(point) {
                let found_key = key.add_u64(index as u64);
                let address = match hit {
                    Hit::Address(hash, compressed) => {
                        base58::address_from_hash160(&hash, compressed)
                    }
                    Hit::XPoint | Hit::Eth => String::new(),
                };
                let checked = scanned.wrapping_add(index as u64).wrapping_add(1);
                return (checked, Some((found_key, address)));
            }
        }

        scanned = scanned.wrapping_add(batch);
        key = key.add_u64(batch);
        remaining = remaining.sub(&Scalar::from_u64(batch));
        if remaining.is_zero() {
            return (scanned, None);
        }
    }
}

/// Read the low 64 bits of a scalar known to be below [`BATCH_SIZE`].
fn scalar_to_u64(value: &Scalar) -> u64 {
    let bytes = value.to_bytes_be();
    let mut out = 0u64;
    for &byte in &bytes[24..] {
        out = (out << 8) | u64::from(byte);
    }
    out
}

fn hex_to_bytes<const N: usize>(text: &str) -> Option<[u8; N]> {
    let text = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    if text.len() != N * 2 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Mode `address` targets are base58 P2PKH addresses, while coordinator jobs
/// with mode `addresses` normalize `job.targets` to 40-hex hash160 strings.
/// Accept both: a line that is exactly 40 hex chars (optional `0x`) is a raw
/// hash160, everything else is decoded as Base58Check.
fn parse_btc_address(text: &str) -> Option<[u8; 20]> {
    let bare = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    if bare.len() == 40 && bare.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return hex_to_bytes(text);
    }

    let payload = base58::decode_check(text).ok()?;
    if payload.len() != 21 || payload[0] != 0x00 {
        return None;
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&payload[1..]);
    Some(hash)
}

fn parse_eth_address(text: &str) -> Option<[u8; 20]> {
    hex_to_bytes(text)
}

fn parse_xpoint(text: &str) -> Option<[u8; 32]> {
    hex_to_bytes(text)
}

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

/// Single-threaded interior mutability for the wasm instance's global state.
struct Global<T>(UnsafeCell<T>);

// SAFETY: the wasm ABI is called sequentially from one worker; this crate
// never spawns threads and is not compiled into the native multi-threaded
// binary.
unsafe impl<T> Sync for Global<T> {}

impl<T> Global<T> {
    const fn new(value: T) -> Global<T> {
        Global(UnsafeCell::new(value))
    }

    fn get(&self) -> *mut T {
        self.0.get()
    }
}

static SESSION: Global<Session> = Global::new(Session::new());

fn session() -> &'static Session {
    // SAFETY: single-threaded wasm, immutable use.
    unsafe { &*SESSION.get() }
}

fn session_mut() -> &'static mut Session {
    // SAFETY: single-threaded wasm, one borrow at a time.
    unsafe { &mut *SESSION.get() }
}

#[cfg(target_arch = "wasm32")]
fn memory_len() -> u64 {
    (core::arch::wasm32::memory_size::<0>() as u64) * 65_536
}

#[cfg(not(target_arch = "wasm32"))]
fn memory_len() -> u64 {
    // The ABI is not driven on the host; tests call `Session` directly.
    u64::from(u32::MAX)
}

fn read_bytes(pointer: u32, length: u32) -> Option<&'static [u8]> {
    if length == 0 {
        return Some(&[]);
    }
    let end = u64::from(pointer) + u64::from(length);
    if end > memory_len() {
        return None;
    }
    // SAFETY: the caller passes an allocation from `alloc`; the bounds check
    // keeps the slice inside wasm linear memory.
    Some(unsafe { std::slice::from_raw_parts(pointer as *const u8, length as usize) })
}

fn read_scalar(pointer: u32) -> Option<Scalar> {
    let bytes = read_bytes(pointer, 32)?;
    let array: &[u8; 32] = bytes.try_into().ok()?;
    Scalar::from_bytes_be(array)
}

/// Allocate `len` bytes with 8-byte alignment for the JS side to fill.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: u32) -> u32 {
    if len == 0 {
        return 8;
    }
    let Ok(layout) = Layout::from_size_align(len as usize, 8) else {
        return 0;
    };
    // SAFETY: straight global-allocator call; a null return signals failure.
    unsafe { rust_alloc(layout) as u32 }
}

/// Release a block from [`alloc`]. A no-op for zero-length or null pointers.
#[unsafe(no_mangle)]
pub extern "C" fn dealloc(pointer: u32, len: u32) {
    if pointer == 0 || len == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len as usize, 8) else {
        return;
    };
    // SAFETY: same layout `alloc` used for this block.
    unsafe { rust_dealloc(pointer as *mut u8, layout) }
}

#[unsafe(no_mangle)]
pub extern "C" fn set_job(mode: u32, comp: u32, targets_ptr: u32, targets_len: u32) -> u32 {
    let Some(bytes) = read_bytes(targets_ptr, targets_len) else {
        session_mut().set_error("invalid targets pointer/length");
        return ERR_BAD_TARGET;
    };
    let Ok(targets) = std::str::from_utf8(bytes) else {
        session_mut().set_error("targets are not valid UTF-8");
        return ERR_BAD_TARGET;
    };
    session_mut().set_job(mode, comp, targets)
}

#[unsafe(no_mangle)]
pub extern "C" fn scan(start_ptr: u32, end_ptr: u32) -> u32 {
    let (Some(start), Some(end)) = (read_scalar(start_ptr), read_scalar(end_ptr)) else {
        session_mut().set_error("start/end must be 32-byte scalars below the curve order");
        return ERR_BAD_TARGET;
    };
    session_mut().scan(&start, &end)
}

#[unsafe(no_mangle)]
pub extern "C" fn samples(start_ptr: u32, offsets_ptr: u32, count: u32) -> u32 {
    let Some(start) = read_scalar(start_ptr) else {
        session_mut().set_error("start must be a 32-byte scalar below the curve order");
        return ERR_BAD_TARGET;
    };
    let Some(byte_len) = count.checked_mul(4) else {
        session_mut().set_error("offset count overflows");
        return ERR_BAD_TARGET;
    };
    let Some(raw) = read_bytes(offsets_ptr, byte_len) else {
        session_mut().set_error("invalid offsets pointer/length");
        return ERR_BAD_TARGET;
    };
    let offsets: Vec<u32> = raw
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| u32::from_le_bytes(*chunk))
        .collect();
    session_mut().samples(&start, &offsets)
}

/// Derive the JSON key/address report for a 32-byte private key.
///
/// `curve`: 0 secp256k1, 1 ed25519. Returns 0 and stores UTF-8 JSON in the
/// result buffer, or a nonzero status with the error buffer set.
#[unsafe(no_mangle)]
pub extern "C" fn derive_report(priv_ptr: u32, curve: u32) -> u32 {
    let Some(bytes) = read_bytes(priv_ptr, 32) else {
        session_mut().set_error("invalid private key pointer/length");
        return ERR_BAD_TARGET;
    };
    let Ok(key) = <[u8; 32]>::try_from(bytes) else {
        session_mut().set_error("private key must be 32 bytes");
        return ERR_BAD_TARGET;
    };
    session_mut().derive_report(&key, curve)
}

/// Address report for one secp256k1 public key (66 or 130 hex characters).
#[unsafe(no_mangle)]
pub extern "C" fn public_key_report(ptr: u32, len: u32) -> u32 {
    let Some(bytes) = read_bytes(ptr, len) else {
        session_mut().set_error("invalid public key pointer/length");
        return ERR_BAD_TARGET;
    };
    let Ok(text) = std::str::from_utf8(bytes) else {
        session_mut().set_error("public key is not valid UTF-8");
        return ERR_BAD_TARGET;
    };
    session_mut().pubkey_report(text)
}

/// Add two public keys: `P + Q`, both 66 or 130 hex characters.
#[unsafe(no_mangle)]
pub extern "C" fn public_key_add(a_ptr: u32, a_len: u32, b_ptr: u32, b_len: u32) -> u32 {
    let (Some(a_bytes), Some(b_bytes)) = (read_bytes(a_ptr, a_len), read_bytes(b_ptr, b_len))
    else {
        session_mut().set_error("invalid public key pointer/length");
        return ERR_BAD_TARGET;
    };
    let (Ok(a), Ok(b)) = (std::str::from_utf8(a_bytes), std::str::from_utf8(b_bytes)) else {
        session_mut().set_error("public keys are not valid UTF-8");
        return ERR_BAD_TARGET;
    };
    session_mut().pubkey_add(a, b)
}

/// Decrypt an Ethereum V3 keystore locally.
///
/// `kdf`: 0 scrypt, 1 PBKDF2-HMAC-SHA256. `dklen` must be 32, `iv_len` 16,
/// `ct_len` 32 and `mac_len` 16 (legacy truncated MAC) or 32 (full MAC).
/// Returns the hex private key in the result buffer on success, or a nonzero
/// status with the error buffer set.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn keystore_decrypt(
    kdf: u32,
    n: u32,
    r: u32,
    p: u32,
    c: u32,
    dklen: u32,
    salt_ptr: u32,
    salt_len: u32,
    iv_ptr: u32,
    iv_len: u32,
    ct_ptr: u32,
    ct_len: u32,
    mac_ptr: u32,
    mac_len: u32,
    pw_ptr: u32,
    pw_len: u32,
) -> u32 {
    let (Some(salt), Some(iv), Some(ciphertext), Some(mac), Some(password)) = (
        read_bytes(salt_ptr, salt_len),
        read_bytes(iv_ptr, iv_len),
        read_bytes(ct_ptr, ct_len),
        read_bytes(mac_ptr, mac_len),
        read_bytes(pw_ptr, pw_len),
    ) else {
        session_mut().set_error("invalid keystore pointer/length");
        return ERR_BAD_TARGET;
    };
    session_mut().keystore_decrypt(&keystore::Request {
        kdf,
        n,
        r,
        p,
        c,
        dklen,
        salt,
        iv,
        ciphertext,
        mac,
        password,
    })
}

/// Sign an EIP-1559 type-2 EVM transaction.
///
/// The request is a UTF-8 JSON object with the string fields `chain_id`,
/// `nonce`, `max_priority_fee`, `max_fee`, `gas_limit`, `to`, `value`, `data`
/// and `private_key`; numbers are decimal or `0x` hex, bytes are hex.
/// On success the result buffer holds the `0x`-prefixed raw signed
/// transaction, ready for `eth_sendRawTransaction`; otherwise a nonzero status
/// is returned and the error buffer explains the first invalid field.
#[unsafe(no_mangle)]
pub extern "C" fn evm_sign_tx(ptr: u32, len: u32) -> u32 {
    let Some(bytes) = read_bytes(ptr, len) else {
        session_mut().set_error("invalid signing request pointer/length");
        return ERR_BAD_TARGET;
    };
    let Ok(request) = std::str::from_utf8(bytes) else {
        session_mut().set_error("signing request is not valid UTF-8");
        return ERR_BAD_TARGET;
    };
    session_mut().evm_sign_tx(request)
}

#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> u32 {
    session().result.as_ptr() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn result_len() -> u32 {
    session().result.len() as u32
}

/// Zero and truncate the result buffer once the caller has copied it out.
#[unsafe(no_mangle)]
pub extern "C" fn clear_result() {
    session_mut().clear_result();
}

#[unsafe(no_mangle)]
pub extern "C" fn error_ptr() -> u32 {
    session().error.as_ptr() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn error_len() -> u32 {
    session().error.len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scalar(value: u64) -> Scalar {
        Scalar::from_u64(value)
    }

    fn key_hex(value: u64) -> String {
        format!("{value:064x}")
    }

    fn parse_scan(blob: &[u8]) -> (u64, Option<(String, String)>) {
        let scanned = u64::from_le_bytes(blob[0..8].try_into().unwrap());
        let found = u32::from_le_bytes(blob[8..12].try_into().unwrap());
        if found == 0 {
            return (scanned, None);
        }
        let key_len = u32::from_le_bytes(blob[12..16].try_into().unwrap()) as usize;
        let key = std::str::from_utf8(&blob[16..16 + key_len])
            .unwrap()
            .to_owned();
        let address_start = 16 + key_len;
        let address_len =
            u32::from_le_bytes(blob[address_start..address_start + 4].try_into().unwrap()) as usize;
        let address =
            std::str::from_utf8(&blob[address_start + 4..address_start + 4 + address_len])
                .unwrap()
                .to_owned();
        (scanned, Some((key, address)))
    }

    fn parse_samples(blob: &[u8]) -> Vec<Vec<u8>> {
        let count = u32::from_le_bytes(blob[0..4].try_into().unwrap()) as usize;
        let mut position = 4;
        let mut samples = Vec::with_capacity(count);
        for _ in 0..count {
            let length =
                u32::from_le_bytes(blob[position..position + 4].try_into().unwrap()) as usize;
            position += 4;
            samples.push(blob[position..position + length].to_vec());
            position += length;
        }
        assert_eq!(position, blob.len());
        samples
    }

    // Fixtures verified once with the native binary, e.g.
    // `rotor -m address --range 1:2 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH`.
    const KEY1_ADDR: &str = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
    const KEY1_ADDR_UNC: &str = "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm";
    const KEY2_ADDR: &str = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";

    const H160_1_CMP: &str = "751e76e8199196d454941c45d1b3a323f1433bd6";
    const H160_2_CMP: &str = "06afd46bcdfd22ef94ac122aa11f241244a37ecc";
    const H160_1_UNC: &str = "91b24bf9f5288532960ac687abb035127b1d28a5";
    const H160_2_UNC: &str = "d6c8e828c1eca1bba065e1b83e1dc2a36e387a42";

    const X5: &str = "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4";
    const X6: &str = "fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556";

    const ETH1: &str = "7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    const ETH2: &str = "2b5ad5c4795c026514f8317c7a215e218dccd6cf";

    fn hex(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    fn address_job(targets: &str, comp: u32) -> Session {
        let mut session = Session::new();
        assert_eq!(session.set_job(MODE_BTC_ADDRESS, comp, targets), OK);
        session
    }

    #[test]
    fn set_job_validation() {
        let mut session = Session::new();
        assert_eq!(
            session.set_job(MODE_BTC_ADDRESS, 0, "  \n\n"),
            ERR_EMPTY_LIST
        );
        assert_eq!(
            session.set_job(MODE_BTC_ADDRESS, 0, "not-an-address"),
            ERR_BAD_TARGET
        );
        assert_eq!(session.set_job(9, 0, "x"), ERR_UNSUPPORTED);
        assert_eq!(session.set_job(MODE_BTC_ADDRESS, 7, "x"), ERR_UNSUPPORTED);
    }

    #[test]
    fn scan_finds_key_one() {
        let mut session = address_job(KEY1_ADDR, 0);
        assert_eq!(session.scan(&scalar(1), &scalar(2)), OK);
        let (scanned, found) = parse_scan(&session.result);
        assert_eq!(scanned, 1);
        assert_eq!(found, Some((key_hex(1), KEY1_ADDR.to_owned())));
    }

    #[test]
    fn scan_finds_uncompressed_key_one() {
        let mut session = address_job(KEY1_ADDR_UNC, 1);
        assert_eq!(session.scan(&scalar(1), &scalar(2)), OK);
        let (scanned, found) = parse_scan(&session.result);
        assert_eq!(scanned, 1);
        assert_eq!(found, Some((key_hex(1), KEY1_ADDR_UNC.to_owned())));
    }

    #[test]
    fn scan_both_compression_flags() {
        for target in [KEY1_ADDR, KEY1_ADDR_UNC] {
            let mut session = address_job(target, 2);
            assert_eq!(session.scan(&scalar(1), &scalar(2)), OK);
            assert_eq!(
                parse_scan(&session.result),
                (1, Some((key_hex(1), target.to_owned())))
            );
        }
    }

    #[test]
    fn scan_skips_key_zero_but_counts_it() {
        let mut session = address_job(KEY1_ADDR, 0);
        assert_eq!(session.scan(&scalar(0), &scalar(2)), OK);
        let (scanned, found) = parse_scan(&session.result);
        assert_eq!(scanned, 2);
        assert_eq!(found.map(|(key, _)| key), Some(key_hex(1)));
    }

    #[test]
    fn scan_end_is_exclusive_and_empty_range_is_ok() {
        let mut session = address_job(KEY1_ADDR, 0);
        assert_eq!(session.scan(&scalar(1), &scalar(1)), OK);
        assert_eq!(parse_scan(&session.result), (0, None));

        let mut session = address_job(KEY1_ADDR, 0);
        assert_eq!(session.scan(&scalar(2), &scalar(1)), ERR_BAD_TARGET);
        assert!(!session.error.is_empty());
    }

    #[test]
    fn scan_reports_a_miss() {
        let mut session = address_job(KEY1_ADDR, 0);
        assert_eq!(session.scan(&scalar(2), &scalar(5)), OK);
        assert_eq!(parse_scan(&session.result), (3, None));
    }

    #[test]
    fn scan_multi_target_stops_at_first_match() {
        let mut session = address_job(&format!("\n {KEY1_ADDR} \r\n{KEY2_ADDR}\n"), 0);
        assert_eq!(session.scan(&scalar(1), &scalar(5)), OK);
        assert_eq!(
            parse_scan(&session.result),
            (1, Some((key_hex(1), KEY1_ADDR.to_owned())))
        );

        let mut session = address_job(&format!("{KEY1_ADDR}\n{KEY2_ADDR}\n"), 0);
        assert_eq!(session.scan(&scalar(2), &scalar(5)), OK);
        assert_eq!(
            parse_scan(&session.result),
            (1, Some((key_hex(2), KEY2_ADDR.to_owned())))
        );
    }

    #[test]
    fn scan_accepts_hex_hash160_targets_for_addresses_jobs() {
        // Coordinator `addresses` jobs normalize targets to 40-hex hash160.
        for target in [H160_1_CMP.to_owned(), format!("0x{H160_1_CMP}")] {
            let mut session = address_job(&target, 0);
            assert_eq!(session.scan(&scalar(1), &scalar(2)), OK);
            assert_eq!(
                parse_scan(&session.result),
                (1, Some((key_hex(1), KEY1_ADDR.to_owned())))
            );
        }

        // A hash160 target may be mixed with base58 targets.
        let mut session = address_job(&format!("{KEY2_ADDR}\n{H160_1_CMP}\n"), 0);
        assert_eq!(session.scan(&scalar(1), &scalar(2)), OK);
        assert_eq!(
            parse_scan(&session.result),
            (1, Some((key_hex(1), KEY1_ADDR.to_owned())))
        );

        // Uncompressed jobs also match raw hash160 targets.
        let mut session = address_job(H160_1_UNC, 1);
        assert_eq!(session.scan(&scalar(1), &scalar(2)), OK);
        assert_eq!(
            parse_scan(&session.result),
            (1, Some((key_hex(1), KEY1_ADDR_UNC.to_owned())))
        );
    }

    #[test]
    fn samples_btc_matches_native_vectors() {
        let mut session = address_job(KEY1_ADDR, 0);
        assert_eq!(session.samples(&scalar(1), &[0, 1]), OK);
        let samples = parse_samples(&session.result);
        assert_eq!(
            samples,
            vec![
                hex_to_bytes::<20>(H160_1_CMP).unwrap().to_vec(),
                hex_to_bytes::<20>(H160_2_CMP).unwrap().to_vec(),
            ]
        );

        let mut session = address_job(KEY1_ADDR, 1);
        assert_eq!(session.samples(&scalar(1), &[0, 1]), OK);
        assert_eq!(
            parse_samples(&session.result),
            vec![
                hex_to_bytes::<20>(H160_1_UNC).unwrap().to_vec(),
                hex_to_bytes::<20>(H160_2_UNC).unwrap().to_vec(),
            ]
        );

        // Comp mode "both" sends the compressed sample.
        let mut session = address_job(KEY1_ADDR, 2);
        assert_eq!(session.samples(&scalar(1), &[0, 1]), OK);
        assert_eq!(
            parse_samples(&session.result),
            vec![
                hex_to_bytes::<20>(H160_1_CMP).unwrap().to_vec(),
                hex_to_bytes::<20>(H160_2_CMP).unwrap().to_vec(),
            ]
        );
    }

    #[test]
    fn samples_eth_matches_native_vectors() {
        let mut session = Session::new();
        assert_eq!(
            session.set_job(MODE_ETH_ADDRESS, 0, "0x40-hex?"),
            ERR_BAD_TARGET
        );
        assert_eq!(session.set_job(MODE_ETH_ADDRESS, 0, ETH1), OK);
        assert_eq!(session.samples(&scalar(1), &[0, 1]), OK);
        assert_eq!(
            parse_samples(&session.result),
            vec![
                hex_to_bytes::<20>(ETH1).unwrap().to_vec(),
                hex_to_bytes::<20>(ETH2).unwrap().to_vec(),
            ]
        );
    }

    #[test]
    fn samples_xpoint_key_five() {
        let mut session = Session::new();
        assert_eq!(session.set_job(MODE_BTC_XPOINT, 0, X5), OK);
        assert_eq!(session.samples(&scalar(5), &[0, 1]), OK);
        assert_eq!(
            parse_samples(&session.result),
            vec![
                hex_to_bytes::<32>(X5).unwrap().to_vec(),
                hex_to_bytes::<32>(X6).unwrap().to_vec(),
            ]
        );
    }

    #[test]
    fn xpoint_scan_finds_key_five() {
        let mut session = Session::new();
        assert_eq!(session.set_job(MODE_BTC_XPOINT, 0, &format!(" {X5}\n")), OK);
        assert_eq!(session.scan(&scalar(5), &scalar(6)), OK);
        let (scanned, found) = parse_scan(&session.result);
        assert_eq!(scanned, 1);
        assert_eq!(found, Some((key_hex(5), String::new())));
    }

    #[test]
    fn eth_scan_finds_key_one() {
        let mut session = Session::new();
        assert_eq!(
            session.set_job(MODE_ETH_ADDRESS, 0, &format!("0x{ETH1}")),
            OK
        );
        assert_eq!(session.scan(&scalar(1), &scalar(2)), OK);
        let (scanned, found) = parse_scan(&session.result);
        assert_eq!(scanned, 1);
        assert_eq!(found, Some((key_hex(1), String::new())));
    }

    #[test]
    fn samples_zero_start_does_not_panic() {
        let mut session = address_job(KEY1_ADDR, 0);
        assert_eq!(session.samples(&scalar(0), &[0, 1]), OK);
        let samples = parse_samples(&session.result);
        assert_eq!(samples.len(), 2);
        assert!(samples[0].iter().all(|&byte| byte == 0));
        assert_eq!(hex(&samples[1]), H160_1_CMP);
    }

    // -----------------------------------------------------------------------
    // derive_report
    // -----------------------------------------------------------------------

    const KEY1_BYTES: [u8; 32] = {
        let mut key = [0u8; 32];
        key[31] = 1;
        key
    };

    const CURVE_N: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36,
        0x41, 0x41,
    ];

    fn key_bytes(value: u64) -> [u8; 32] {
        let mut key = [0u8; 32];
        key[24..].copy_from_slice(&value.to_be_bytes());
        key
    }

    fn derive_value(key: &[u8; 32], curve: u32) -> serde_json::Value {
        let mut session = Session::new();
        assert_eq!(session.derive_report(key, curve), OK);
        assert!(session.error.is_empty());
        serde_json::from_slice(&session.result).expect("derive_report must emit valid JSON")
    }

    fn address<'a>(value: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
        value["addresses"]
            .as_array()
            .expect("addresses array")
            .iter()
            .find(|entry| entry["id"] == id)
            .unwrap_or_else(|| panic!("missing address entry {id}"))
    }

    const KEY1_PUB_COMPRESSED: &str =
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const KEY1_PUB_UNCOMPRESSED: &str = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

    #[test]
    fn derive_secp_key_one_matches_published_vectors() {
        let value = derive_value(&KEY1_BYTES, 0);

        assert_eq!(value["curve"], "secp256k1");
        assert_eq!(
            value["priv_hex"],
            "0000000000000000000000000000000000000000000000000000000000000001"
        );
        assert_eq!(value["priv_dec"], "1");
        assert_eq!(value["priv_bin"], format!("{}1", "0".repeat(255)));
        assert_eq!(value["pubkey_compressed"], KEY1_PUB_COMPRESSED);
        assert_eq!(value["pubkey_uncompressed"], KEY1_PUB_UNCOMPRESSED);
        assert_eq!(
            value["x"],
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
        assert_eq!(
            value["y"],
            "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
        );
        assert_eq!(value["ed_pubkey"], "");
        assert_eq!(
            value["wif_compressed"],
            "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn"
        );
        assert_eq!(
            value["wif_uncompressed"],
            "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf"
        );
        assert_eq!(value["addresses"].as_array().unwrap().len(), 15);

        let zcash = address(&value, "zcash_p2pkh");
        assert_eq!(zcash["address"], "t1UYsZVJkLPeMjxEtACvSxfWuNmddpWfxzs");
        let compressed = address(&value, "btc_p2pkh");
        assert_eq!(compressed["address"], KEY1_ADDR);
        assert_eq!(compressed["steps"]["pubkey"], KEY1_PUB_COMPRESSED);
        assert_eq!(compressed["steps"]["hash160"], H160_1_CMP);
        assert_eq!(compressed["steps"]["payload"], format!("00{H160_1_CMP}"));
        assert_eq!(compressed["steps"]["checksum"], "510d1634");
        assert_eq!(compressed["steps"]["base58"], KEY1_ADDR);

        let uncompressed = address(&value, "btc_p2pkh_uncompressed");
        assert_eq!(uncompressed["address"], KEY1_ADDR_UNC);
        assert_eq!(uncompressed["steps"]["pubkey"], KEY1_PUB_UNCOMPRESSED);
        assert_eq!(uncompressed["steps"]["hash160"], H160_1_UNC);
        assert_eq!(uncompressed["steps"]["payload"], format!("00{H160_1_UNC}"));
        assert_eq!(uncompressed["steps"]["checksum"], "0074ffe0");
        assert_eq!(uncompressed["steps"]["base58"], KEY1_ADDR_UNC);

        let p2sh = address(&value, "btc_p2sh_p2wpkh");
        assert_eq!(p2sh["address"], "3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN");
        assert_eq!(p2sh["steps"]["redeem"], format!("0014{H160_1_CMP}"));
        assert_eq!(
            p2sh["steps"]["script_hash"],
            "bcfeb728b584253d5f3f70bcb780e9ef218a68f4"
        );
        assert_eq!(
            p2sh["steps"]["payload"],
            "05bcfeb728b584253d5f3f70bcb780e9ef218a68f4"
        );
        assert_eq!(p2sh["steps"]["checksum"], "923b88af");

        let p2wpkh = address(&value, "btc_p2wpkh");
        assert_eq!(
            p2wpkh["address"],
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
        );
        assert_eq!(p2wpkh["steps"]["hrp"], "bc");
        assert_eq!(p2wpkh["steps"]["witness_version"], "0");
        assert_eq!(p2wpkh["steps"]["program"], H160_1_CMP);
        assert_eq!(p2wpkh["steps"]["checksum"], "v8f3t4");

        // Taproot key 1, independently reproduced with bitcoinjs-lib.
        let p2tr = address(&value, "btc_p2tr");
        assert_eq!(
            p2tr["address"],
            "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9"
        );
        assert_eq!(p2tr["steps"]["internal_x"], value["x"]);
        assert_eq!(
            p2tr["steps"]["tweak"],
            "3cf5216d476a5e637bf0da674e50ddf55c403270dd36494dfcca438132fa30e7"
        );
        assert_eq!(
            p2tr["steps"]["output_x"],
            "da4710964f7852695de2da025290e24af6d8c281de5a0b902b7135fd9fd74d21"
        );
        assert_eq!(p2tr["steps"]["parity"], "1");
        assert_eq!(p2tr["steps"]["program"], p2tr["steps"]["output_x"]);
        assert_eq!(p2tr["steps"]["checksum"], "pknck9");

        let evm = address(&value, "evm");
        assert_eq!(evm["address"], "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
        assert_eq!(evm["steps"]["last20"], ETH1);
        let keccak = evm["steps"]["keccak"].as_str().unwrap();
        assert_eq!(keccak.len(), 64);
        assert!(keccak.ends_with(ETH1));

        let tron = address(&value, "tron");
        assert_eq!(tron["address"], "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC");
        assert_eq!(tron["steps"]["payload"], format!("41{ETH1}"));
        assert_eq!(tron["steps"]["checksum"], "b164fb1f");
        assert_eq!(tron["steps"]["base58"], tron["address"]);

        // Litecoin, Dogecoin, Bitcoin Cash and XRP fixtures were computed with
        // an independent Python reference (hashlib + BIP173/base58 encoders).
        let ltc = address(&value, "ltc_p2pkh");
        assert_eq!(ltc["address"], "LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ");
        assert_eq!(ltc["steps"]["pubkey"], KEY1_PUB_COMPRESSED);
        assert_eq!(ltc["steps"]["hash160"], H160_1_CMP);
        assert_eq!(ltc["steps"]["payload"], format!("30{H160_1_CMP}"));
        assert_eq!(ltc["steps"]["checksum"], "e987c9bf");
        assert_eq!(ltc["steps"]["base58"], ltc["address"]);

        let ltc_p2sh = address(&value, "ltc_p2sh_p2wpkh");
        assert_eq!(ltc_p2sh["address"], "MR8UQSBr5ULwWheBHznrHk2jxyxkHQu8vB");
        assert_eq!(ltc_p2sh["steps"]["redeem"], format!("0014{H160_1_CMP}"));
        assert_eq!(
            ltc_p2sh["steps"]["script_hash"],
            "bcfeb728b584253d5f3f70bcb780e9ef218a68f4"
        );
        assert_eq!(
            ltc_p2sh["steps"]["payload"],
            "32bcfeb728b584253d5f3f70bcb780e9ef218a68f4"
        );
        assert_eq!(ltc_p2sh["steps"]["checksum"], "58f61ad8");

        let ltc_segwit = address(&value, "ltc_p2wpkh");
        assert_eq!(
            ltc_segwit["address"],
            "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9"
        );
        assert_eq!(ltc_segwit["steps"]["hrp"], "ltc");
        assert_eq!(ltc_segwit["steps"]["witness_version"], "0");
        assert_eq!(ltc_segwit["steps"]["program"], H160_1_CMP);
        assert_eq!(ltc_segwit["steps"]["checksum"], "gmn4n9");

        let doge = address(&value, "doge_p2pkh");
        assert_eq!(doge["address"], "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE");
        assert_eq!(doge["steps"]["payload"], format!("1e{H160_1_CMP}"));
        assert_eq!(doge["steps"]["checksum"], "2b0fde73");

        let bch = address(&value, "bch_legacy");
        assert_eq!(bch["address"], KEY1_ADDR);
        assert_eq!(bch["steps"]["payload"], format!("00{H160_1_CMP}"));
        assert_eq!(bch["steps"]["checksum"], "510d1634");

        let xrp = address(&value, "xrp_classic");
        assert_eq!(xrp["address"], "rBgGZ9tc4him9KBzD8fKFiQz3fSZpaSwMH");
        assert_eq!(xrp["steps"]["pubkey"], KEY1_PUB_COMPRESSED);
        assert_eq!(xrp["steps"]["hash160"], H160_1_CMP);
        assert_eq!(xrp["steps"]["payload"], format!("00{H160_1_CMP}"));
        assert_eq!(xrp["steps"]["checksum"], "510d1634");
        assert_eq!(xrp["steps"]["base58"], xrp["address"]);

        let solana = address(&value, "solana");
        assert_eq!(solana["address"], "");
        assert_eq!(solana["steps"]["pubkey"], "");
    }

    #[test]
    fn derive_new_chain_rows_key_two() {
        // Independent Python reference vectors for private key 2.
        let value = derive_value(&key_bytes(2), 0);
        assert_eq!(
            address(&value, "ltc_p2pkh")["address"],
            "LKqJxEKxN7SnCEpj3ia3Z9DuAD1HNjh1hx"
        );
        assert_eq!(
            address(&value, "ltc_p2sh_p2wpkh")["address"],
            "MMiRb7TPSoqLtRpfTjc9FGQRQcW8WLeirF"
        );
        assert_eq!(
            address(&value, "ltc_p2wpkh")["address"],
            "ltc1qq6hag67dl53wl99vzg42z8eyzfz2xlkvz9zn23"
        );
        assert_eq!(
            address(&value, "doge_p2pkh")["address"],
            "D5kTEGxmas71USKAcAaJptKjq8NJc6EK8C"
        );
        assert_eq!(
            address(&value, "xrp_classic")["address"],
            "rcM6pp3HTU5AS3Z122kH3w3AzerJRnZ1P"
        );
    }

    #[test]
    fn derive_ed25519_rfc8032_vector() {
        let seed: [u8; 32] =
            hex_to_bytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                .unwrap();
        let value = derive_value(&seed, 1);

        assert_eq!(value["curve"], "ed25519");
        assert_eq!(
            value["ed_pubkey"],
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        assert_eq!(value["pubkey_compressed"], "");
        assert_eq!(value["pubkey_uncompressed"], "");
        assert_eq!(value["x"], "");
        assert_eq!(value["y"], "");
        assert_eq!(value["wif_compressed"], "");
        assert_eq!(value["wif_uncompressed"], "");
        assert_eq!(
            value["priv_hex"],
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
        );

        let addresses = value["addresses"].as_array().unwrap();
        assert_eq!(addresses.len(), 2);
        assert_eq!(addresses[0]["id"], "solana");
        assert_eq!(addresses[0]["label"], "Solana (ed25519)");
        assert_eq!(
            addresses[0]["address"],
            "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z"
        );
        assert_eq!(
            addresses[0]["steps"]["pubkey"],
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        assert_eq!(addresses[1]["id"], "sui");
        assert_eq!(
            addresses[1]["address"],
            "0x304af458e90e97c841685b8cbbc59b909f3e2cf150df590ada4c81452c29737d"
        );
    }

    #[test]
    fn derive_taproot_lifts_odd_y_internal_keys() {
        // Keys 6 and 11 have odd-y public points, so BIP341's lift_x negates
        // them before the tweak. Expected addresses and outputs were
        // reproduced independently with bitcoinjs-lib 6.
        let key6 = derive_value(&key_bytes(6), 0);
        let p2tr = address(&key6, "btc_p2tr");
        assert_eq!(
            p2tr["address"],
            "bc1p4rsld9ryjhte00drc0r23r8ngd63xrzh5s4fvmy6q5yt70xzlsdqcuvtzv"
        );
        assert_eq!(
            p2tr["steps"]["internal_x"],
            "fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556"
        );
        assert_eq!(
            p2tr["steps"]["output_x"],
            "a8e1f6946495d797bda3c3c6a88cf34375130c57a42a966c9a0508bf3cc2fc1a"
        );
        assert_eq!(p2tr["steps"]["parity"], "1");

        let key11 = derive_value(&key_bytes(11), 0);
        let p2tr = address(&key11, "btc_p2tr");
        assert_eq!(
            p2tr["address"],
            "bc1pxy2wupspts5wl3ctseak4g7j42h6mumaqlq6zzrn6qesraqlqz7qk730p9"
        );
        assert_eq!(
            p2tr["steps"]["internal_x"],
            "774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb"
        );
        assert_eq!(
            p2tr["steps"]["output_x"],
            "3114ee06015c28efc70b867b6aa3d2aaafadf37d07c1a10873d03301f41f00bc"
        );
        assert_eq!(p2tr["steps"]["parity"], "0");
    }

    #[test]
    fn derive_priv_dec_and_bin_for_a_wide_key() {
        let key: [u8; 32] =
            hex_to_bytes("000000000000000000000000000000000123456789abcdef0123456789abcdef")
                .unwrap();
        let value = derive_value(&key, 0);
        assert_eq!(value["priv_dec"], "1512366075204170929049582354406559215");
        assert_eq!(
            value["priv_bin"],
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001001000110100010101100111100010011010101111001101111011110000000100100011010001010110011110001001101010111100110111101111"
        );
    }

    #[test]
    fn derive_report_schema_shape() {
        for (key, curve) in [(KEY1_BYTES, 0), (KEY1_BYTES, 1)] {
            let value = derive_value(&key, curve);
            let top = value.as_object().expect("top-level object");
            assert_eq!(top.len(), 12);
            for field in [
                "curve",
                "priv_hex",
                "priv_dec",
                "priv_bin",
                "pubkey_compressed",
                "pubkey_uncompressed",
                "x",
                "y",
                "ed_pubkey",
                "wif_compressed",
                "wif_uncompressed",
                "addresses",
            ] {
                assert!(top.contains_key(field), "missing top-level field {field}");
            }
            for entry in value["addresses"].as_array().unwrap() {
                let object = entry.as_object().unwrap();
                assert_eq!(object.len(), 4);
                for field in ["id", "label", "address", "steps"] {
                    assert!(object.contains_key(field), "missing address field {field}");
                }
                assert!(entry["steps"].is_object());
            }
        }
    }

    #[test]
    fn derive_rejects_invalid_secp_keys_and_curves() {
        let mut session = Session::new();

        assert_eq!(session.derive_report(&[0u8; 32], 0), ERR_BAD_TARGET);
        assert!(!session.error.is_empty());
        assert!(session.result.is_empty());

        assert_eq!(session.derive_report(&CURVE_N, 0), ERR_BAD_TARGET);
        assert!(!session.error.is_empty());
        assert!(session.result.is_empty());

        let mut n_minus_one = CURVE_N;
        n_minus_one[31] -= 1;
        assert_eq!(session.derive_report(&n_minus_one, 0), OK);
        assert!(session.error.is_empty());

        assert_eq!(session.derive_report(&KEY1_BYTES, 2), ERR_UNSUPPORTED);
        assert!(!session.error.is_empty());
        assert!(session.result.is_empty());
    }

    #[test]
    fn public_key_report_key_one_matches_the_private_report() {
        let mut session = Session::new();
        assert_eq!(session.pubkey_report(KEY1_PUB_COMPRESSED), OK);
        assert!(session.error.is_empty());
        let value: serde_json::Value =
            serde_json::from_slice(&session.result).expect("public key report JSON");

        assert_eq!(value["curve"], "secp256k1");
        assert_eq!(value["input_format"], "compressed");
        assert_eq!(value["pubkey_compressed"], KEY1_PUB_COMPRESSED);
        assert_eq!(value["pubkey_uncompressed"], KEY1_PUB_UNCOMPRESSED);
        assert_eq!(
            address(&value, "btc_p2pkh")["address"],
            "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
        );
        assert_eq!(
            address(&value, "btc_p2wpkh")["address"],
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
        );
        assert_eq!(
            address(&value, "evm")["address"],
            "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
        );
        assert_eq!(
            address(&value, "tron")["address"],
            "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC"
        );

        // The same point sent uncompressed is accepted and reported as such.
        assert_eq!(session.pubkey_report(KEY1_PUB_UNCOMPRESSED), OK);
        let uncompressed: serde_json::Value =
            serde_json::from_slice(&session.result).expect("uncompressed report JSON");
        assert_eq!(uncompressed["input_format"], "uncompressed");
        assert_eq!(uncompressed["pubkey_compressed"], KEY1_PUB_COMPRESSED);
        assert_eq!(
            address(&uncompressed, "btc_p2pkh")["address"],
            "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
        );
    }

    #[test]
    fn evm_sign_tx_abi_returns_raw_hex_and_errors() {
        let mut session = Session::new();
        let request = r#"{"chain_id":"11155111","nonce":"0","max_priority_fee":"1000000000",
            "max_fee":"2000000000","gas_limit":"21000",
            "to":"0x3535353535353535353535353535353535353535","value":"1000000000000000",
            "data":"0x","private_key":"0x0000000000000000000000000000000000000000000000000000000000000001"}"#;
        assert_eq!(session.evm_sign_tx(request), OK);
        assert!(session.error.is_empty());
        assert_eq!(
            String::from_utf8(session.result.clone()).unwrap(),
            "0x02f87483aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c080a0d02b933531d628f5d2251fbf58903a4d720f9bd6c7c51f7578f7cf301f761263a012a7d571860bb8d7e71bcb6c63d265bc6fc57b250b9381cbc18c1543c282b147"
        );

        assert_eq!(session.evm_sign_tx("{}"), ERR_BAD_TARGET);
        assert!(!session.error.is_empty());
        assert!(session.result.is_empty());
    }

    #[test]
    fn public_key_report_rejects_invalid_keys() {
        let mut session = Session::new();
        let zero_prefix = format!("00{}", "00".repeat(32));
        assert_eq!(session.pubkey_report(&zero_prefix), ERR_BAD_TARGET);
        assert!(!session.error.is_empty());
        assert!(session.result.is_empty());

        // A point with a valid prefix but an off-curve X coordinate.
        let off_curve = format!("02{}", "00".repeat(32));
        assert_eq!(session.pubkey_report(&off_curve), ERR_BAD_TARGET);

        assert_eq!(session.pubkey_report("02"), ERR_BAD_TARGET);
    }

    #[test]
    fn public_key_add_returns_the_sum_and_rejects_infinity() {
        let mut session = Session::new();
        assert_eq!(
            session.pubkey_add(KEY1_PUB_COMPRESSED, KEY1_PUB_COMPRESSED),
            OK
        );
        let doubled: serde_json::Value =
            serde_json::from_slice(&session.result).expect("pubkey add JSON");
        let expected = derive_value(&key_bytes(2), 0);
        assert_eq!(
            doubled["pubkey_compressed"], expected["pubkey_compressed"],
            "G + G must be key 2"
        );
        assert_eq!(
            doubled["pubkey_uncompressed"],
            expected["pubkey_uncompressed"]
        );
        assert_eq!(doubled["x"], expected["x"]);
        assert_eq!(doubled["y"], expected["y"]);

        // G + (-G) is the point at infinity and is not a public key.
        let negated_g = "0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        assert_eq!(
            session.pubkey_add(KEY1_PUB_COMPRESSED, negated_g),
            ERR_BAD_TARGET
        );
        assert!(String::from_utf8_lossy(&session.error).contains("infinity"));
        assert!(session.result.is_empty());

        assert_eq!(
            session.pubkey_add("not-hex", KEY1_PUB_COMPRESSED),
            ERR_BAD_TARGET
        );
    }
}
