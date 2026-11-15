//! Checkpoint files for resuming a search.
//!
//! Byte-compatible with the C++ tool: the writer is `Rotor.cpp:1597-1618`, the
//! reader is `Rotor.cpp:213-255`, and the startup file is `CmdParse.cpp:86-103`.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Checkpoint restored from `Rotor-Cuda_Continue.bat`.
pub struct Checkpoint {
    /// Line 2: executable name plus all arguments, space-separated.
    pub command_line: String,
    /// Line 4 without the `created: ` prefix, in C `ctime` layout.
    pub created: String,
    /// Line 5: number of keys scanned so far.
    pub count: u64,
    /// Optional extension line `threads: <n>`: number of per-worker counts.
    pub threads: Option<usize>,
    /// Optional extension line `chunks: <c0>,<c1>,...`: cumulative scan count
    /// of each worker.
    pub chunks: Option<Vec<u64>>,
}

/// Parse `Rotor-Cuda_Continue.bat`.
///
/// Returns `None` when the file is missing or unreadable, shorter than five
/// lines, or the count line is not a `u64`. Lines after the fifth (the
/// `threads:`/`chunks:` extension) are optional; malformed extension lines are
/// ignored.
pub fn read_continue(path: &Path) -> Option<Checkpoint> {
    let text = fs::read_to_string(path).ok()?;
    let mut lines = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));

    lines.next()?; // ":loop "
    let command_line = lines.next()?;
    lines.next()?; // "goto :loop "
    let created_line = lines.next()?;
    let count_line = lines.next()?;

    let count = count_line.trim().parse().ok()?;
    let created = created_line
        .strip_prefix("created: ")
        .unwrap_or(created_line)
        .to_string();

    let mut threads = None;
    let mut chunks = None;
    for line in lines {
        if let Some(value) = line.strip_prefix("threads: ") {
            threads = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("chunks: ") {
            chunks = parse_chunk_list(value);
        }
    }

    Some(Checkpoint {
        command_line: command_line.to_string(),
        created,
        count,
        threads,
        chunks,
    })
}

/// Parses a comma-separated list of cumulative per-worker counters.
fn parse_chunk_list(text: &str) -> Option<Vec<u64>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .split(',')
        .map(|part| part.trim().parse().ok())
        .collect()
}

/// Write `Rotor-Cuda_Continue.bat` with the current `ctime` stamp.
pub fn write_continue(path: &Path, command_line: &str, count: u64) -> io::Result<()> {
    write_continue_extended(path, command_line, count, None)
}

/// Like [`write_continue`], plus the `threads:`/`chunks:` extension where
/// `chunks[i]` is the cumulative scan count of worker `i`. The C++ reader only
/// looks at the first five lines, so the extra lines stay compatible.
pub fn write_continue_with_chunks(
    path: &Path,
    command_line: &str,
    count: u64,
    chunks: &[u64],
) -> io::Result<()> {
    write_continue_extended(path, command_line, count, Some(chunks))
}

fn write_continue_extended(
    path: &Path,
    command_line: &str,
    count: u64,
    chunks: Option<&[u64]>,
) -> io::Result<()> {
    let mut contents = format!(
        ":loop \n{command_line}\ngoto :loop \ncreated: {}\n{count}\n\
         To continue correctly, DO NOT change the parameters in this file! \n\
         If you no longer need the continuation, DELETE this file! \n",
        ctime_now()
    );
    if let Some(chunks) = chunks {
        let _ = writeln!(contents, "threads: {}", chunks.len());
        let list = chunks
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let _ = writeln!(contents, "chunks: {list}");
    }
    write_atomic(path, &contents)
}

/// Write `Rotor-Cuda_START.bat`, the file produced when no checkpoint exists.
pub fn write_start(path: &Path, command_line: &str) -> io::Result<()> {
    write_atomic(path, &format!(":loop \n{command_line} \ngoto :loop \n\n"))
}

/// Executable name followed by the process arguments, space-separated.
pub fn command_line() -> String {
    std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Current UTC time in the C `ctime` layout (`%a %b %e %H:%M:%S %Y`),
/// without the trailing newline that C `ctime` embeds.
pub fn ctime_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format_ctime(seconds)
}

/// Format Unix seconds as C `ctime` (`%a %b %e %H:%M:%S %Y`) in UTC.
fn format_ctime(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rem = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    // 1970-01-01 was a Thursday, so index 0 is Thursday.
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} {} {:2} {:02}:{:02}:{:02} {}",
        WEEKDAYS[days.rem_euclid(7) as usize],
        MONTHS[(month - 1) as usize],
        day,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        year
    )
}

/// Write via `<path>.tmp` then rename over the target, so a crash never leaves
/// a half-written checkpoint under the real name.
fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    let mut tmp_name = OsString::from(path.as_os_str());
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);

    fs::write(&tmp, contents)?;
    // On Windows `rename` fails when the target exists.
    let removed = match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    };
    let result = removed.and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::format_ctime;

    #[test]
    fn ctime_matches_c_layout() {
        assert_eq!(format_ctime(0), "Thu Jan  1 00:00:00 1970");
        assert_eq!(format_ctime(1_000_000_000), "Sun Sep  9 01:46:40 2001");
        assert_eq!(format_ctime(1_794_771_723), "Sun Nov 15 19:42:03 2026");
    }
}
