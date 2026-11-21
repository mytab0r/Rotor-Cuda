//! In-process HTTP helpers shared by the monitor tests.
//!
//! The mocks answer Bot API requests over a real loopback socket. Two
//! Windows-specific hazards make a naive accept loop flaky under load.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

/// Largest request buffered before giving up.
const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// Put an accepted socket into blocking mode with a bounded read.
///
/// Windows gives the accepted socket the listener's non-blocking mode, so a
/// `read` can return `WouldBlock` before the request arrives. Treating that
/// as EOF records an empty body and answers before the request was sent.
pub(crate) fn prepare(stream: &mut TcpStream) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
}

/// Read one request body, sized by its `Content-Length` header.
///
/// Returns `None` when no complete request arrived (closed or timed out
/// before the headers/body); callers must not record those as a delivery.
pub(crate) fn read_http_body(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).unwrap_or(0);
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some((head, body_start)) = split_headers(&buffer) {
            let length = String::from_utf8_lossy(head)
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if buffer.len() >= body_start + length {
                return Some(
                    String::from_utf8_lossy(&buffer[body_start..body_start + length]).into_owned(),
                );
            }
        }
        if buffer.len() > MAX_REQUEST_BYTES {
            return None;
        }
    }
}

fn split_headers(buffer: &[u8]) -> Option<(&[u8], usize)> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| (&buffer[..position], position + 4))
}

/// Answer with the fixed `{"ok":true}` Bot API response and close cleanly.
///
/// Dropping the socket right after the write can abort the connection with
/// an RST on Windows before the client reads the response; the client then
/// reports a transport error and `send_message` retries, which records a
/// second body. Flush and half-close the write side instead.
pub(crate) fn respond_ok(stream: &mut TcpStream) {
    let response = "HTTP/1.1 200 OK\r\n\
        Content-Type: application/json\r\n\
        Content-Length: 11\r\n\
        Connection: close\r\n\r\n{\"ok\":true}";
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Write);
}
