use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rotor::checkpoint::{
    command_line, ctime_now, read_continue, write_continue, write_continue_with_chunks, write_start,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// Unique temp file that removes itself and its `.tmp` sibling on drop.
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    fn new(tag: &str) -> Self {
        let unique = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "rotor-checkpoint-{}-{unique}-{tag}.bat",
            std::process::id()
        ));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn write(&self, contents: &str) {
        fs::write(&self.path, contents).expect("write fixture");
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let mut tmp_name = OsString::from(self.path.as_os_str());
        tmp_name.push(".tmp");
        let _ = fs::remove_file(PathBuf::from(tmp_name));
    }
}

/// Build a continuation file with an explicit created stamp and count line.
fn continue_contents(command_line: &str, created: &str, count_line: &str) -> String {
    format!(
        ":loop \n{command_line}\ngoto :loop \ncreated: {created}\n{count_line}\n\
         To continue correctly, DO NOT change the parameters in this file! \n\
         If you no longer need the continuation, DELETE this file! \n"
    )
}

fn tmp_sibling(path: &Path) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(".tmp");
    PathBuf::from(name)
}

#[test]
fn continue_roundtrip() {
    let file = TempFile::new("roundtrip");
    let before = ctime_now();
    write_continue(file.path(), "rotor.exe -r 1:FFFF -n 10", 12_345).expect("write");
    let after = ctime_now();
    let checkpoint = read_continue(file.path()).expect("read");

    assert_eq!(checkpoint.command_line, "rotor.exe -r 1:FFFF -n 10");
    assert_eq!(checkpoint.count, 12_345);
    assert!(
        checkpoint.created == before || checkpoint.created == after,
        "created {:?} outside [{before:?}, {after:?}]",
        checkpoint.created
    );
    assert!(!tmp_sibling(file.path()).exists(), "temp file left behind");

    // Byte-for-byte layout, including trailing spaces.
    let text = fs::read_to_string(file.path()).expect("read file");
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(lines.len(), 8);
    assert_eq!(lines[0], ":loop ");
    assert_eq!(lines[1], "rotor.exe -r 1:FFFF -n 10");
    assert_eq!(lines[2], "goto :loop ");
    assert_eq!(
        lines[3],
        format!("created: {}", checkpoint.created).as_str()
    );
    assert_eq!(lines[4], "12345");
    assert_eq!(
        lines[5],
        "To continue correctly, DO NOT change the parameters in this file! "
    );
    assert_eq!(
        lines[6],
        "If you no longer need the continuation, DELETE this file! "
    );
    assert_eq!(lines[7], "");
}

#[test]
fn continue_overwrites_existing_file() {
    let file = TempFile::new("overwrite");
    file.write(&continue_contents("stale", "stale stamp", "1"));
    write_continue(file.path(), "rotor.exe -b", 2).expect("write over existing file");
    let checkpoint = read_continue(file.path()).expect("read");
    assert_eq!(checkpoint.command_line, "rotor.exe -b");
    assert_eq!(checkpoint.count, 2);
}

#[test]
fn missing_file_is_none() {
    let file = TempFile::new("missing");
    assert!(read_continue(file.path()).is_none());
}

#[test]
fn unparsable_count_is_none() {
    let file = TempFile::new("bad-count");
    file.write(&continue_contents(
        "rotor.exe",
        "Sun Nov 15 19:42:03 2026",
        "nope",
    ));
    assert!(read_continue(file.path()).is_none());
}

#[test]
fn short_file_is_none() {
    let file = TempFile::new("short");
    file.write(":loop \nrotor.exe\ngoto :loop \n");
    assert!(read_continue(file.path()).is_none());
}

#[test]
fn explicit_fields_parse() {
    let file = TempFile::new("explicit");
    file.write(&continue_contents(
        "Rotor-Cuda.exe -r 1:400000000000000000 -n 5",
        "Sun Nov 15 19:42:03 2026",
        "7",
    ));
    let checkpoint = read_continue(file.path()).expect("read");
    assert_eq!(
        checkpoint.command_line,
        "Rotor-Cuda.exe -r 1:400000000000000000 -n 5"
    );
    assert_eq!(checkpoint.created, "Sun Nov 15 19:42:03 2026");
    assert_eq!(checkpoint.count, 7);
}

#[test]
fn crlf_input_parses() {
    let file = TempFile::new("crlf");
    let contents = continue_contents("rotor.exe -r 1:FF", "Sun Nov 15 19:42:03 2026", "99")
        .replace('\n', "\r\n");
    file.write(&contents);
    let checkpoint = read_continue(file.path()).expect("read");
    assert_eq!(checkpoint.command_line, "rotor.exe -r 1:FF");
    assert_eq!(checkpoint.created, "Sun Nov 15 19:42:03 2026");
    assert_eq!(checkpoint.count, 99);
}

#[test]
fn start_file_layout() {
    let file = TempFile::new("start");
    let command = "rotor.exe -r 1:FF -u 1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";
    write_start(file.path(), command).expect("write");

    let text = fs::read_to_string(file.path()).expect("read file");
    let expected = format!(":loop \n{command} \ngoto :loop \n\n");
    assert_eq!(text, expected);

    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0], ":loop ");
    assert_eq!(lines[1], format!("{command} ").as_str());
    assert_eq!(lines[2], "goto :loop ");
    assert_eq!(lines[3], "");
    assert!(!tmp_sibling(file.path()).exists(), "temp file left behind");
}

#[test]
fn command_line_starts_with_binary_name() {
    let argv0 = std::env::args_os().next().expect("argv[0]");
    let argv0 = argv0.to_string_lossy().into_owned();
    let line = command_line();
    assert!(
        line.starts_with(&argv0),
        "{line:?} should start with {argv0:?}"
    );
}

#[test]
fn extension_roundtrip() {
    let file = TempFile::new("extension");
    write_continue_with_chunks(file.path(), "rotor.exe -t 2", 42, &[10, 20, 12])
        .expect("write checkpoint");

    let checkpoint = read_continue(file.path()).expect("read");
    assert_eq!(checkpoint.count, 42);
    assert_eq!(checkpoint.threads, Some(3));
    assert_eq!(checkpoint.chunks, Some(vec![10, 20, 12]));

    let text = fs::read_to_string(file.path()).expect("read file");
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(lines.len(), 10);
    assert_eq!(lines[7], "threads: 3");
    assert_eq!(lines[8], "chunks: 10,20,12");
    assert_eq!(lines[9], "");
}

#[test]
fn old_format_has_no_extension() {
    let file = TempFile::new("no_extension");
    write_continue(file.path(), "rotor.exe", 3).expect("write checkpoint");

    let checkpoint = read_continue(file.path()).expect("read");
    assert_eq!(checkpoint.count, 3);
    assert_eq!(checkpoint.threads, None);
    assert_eq!(checkpoint.chunks, None);
}
