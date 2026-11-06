//! Non-shipping proof of concept: ZMODEM protocol data over stdin/stdout.
//! stdout is exclusively binary protocol bytes; diagnostics go to stderr.
//! Not connected to OpenShell's SSH/PTy, filesystem policy or release build.

use std::collections::VecDeque;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver as ChannelReceiver};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use zmodem2::{Action, Event, FileInfo, Position, Receiver, Sender};

const MAX_SIZE: u64 = 128 * 1024 * 1024;
const SESSION_TIMEOUT: Duration = Duration::from_secs(90);
const READ_TIMEOUT: Duration = Duration::from_millis(150);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

// Diagnostics only: stdout remains exclusively binary ZMODEM protocol.
// Upload progress is bytes read from the source, not proof of remote persistence.
fn report_progress(processed: u64, total: u64, last: &mut Instant, force: bool) {
    if force || last.elapsed() >= PROGRESS_INTERVAL {
        eprintln!("OSZP\t{processed}\t{total}");
        *last = Instant::now();
    }
}


fn incoming_wire() -> ChannelReceiver<io::Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut bytes = vec![0; 4096];
            match input.read(&mut bytes) {
                Ok(0) => break,
                Ok(size) => {
                    bytes.truncate(size);
                    if tx.send(Ok(bytes)).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    let _ = tx.send(Err(error));
                    break;
                }
            }
        }
    });
    rx
}

fn receive_wire(
    rx: &ChannelReceiver<io::Result<Vec<u8>>>,
    pending: &mut VecDeque<u8>,
) -> io::Result<bool> {
    if !pending.is_empty() {
        return Ok(true);
    }
    match rx.recv_timeout(READ_TIMEOUT) {
        Ok(Ok(bytes)) => {
            pending.extend(bytes);
            Ok(true)
        }
        Ok(Err(error)) => Err(error),
        Err(mpsc::RecvTimeoutError::Timeout) => Ok(false),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "transport disconnected before ZMODEM session ended",
        )),
    }
}

fn send(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    if size > MAX_SIZE {
        return Err("prototype maximum source size is 128 MiB".into());
    }
    let name = path.file_name().and_then(|name| name.to_str())
        .ok_or("source filename must be UTF-8")?;
    if name.is_empty() {
        return Err("empty source filename".into());
    }

    let mut sender = Sender::new()?;
    sender.start_file(FileInfo::new(name.as_bytes(), Some(Position::new(size as u32))))?;
    let mut processed = 0u64;
    let mut progress_at = Instant::now() - PROGRESS_INTERVAL;
    report_progress(0, size, &mut progress_at, true);
    let rx = incoming_wire();
    let mut waiting = VecDeque::<u8>::new();
    let mut output = io::stdout().lock();
    let mut done_file = false;
    let mut finish_requested = false;
    let mut session_completed = false;
    let deadline = Instant::now() + SESSION_TIMEOUT;

    while Instant::now() < deadline {
        match sender.poll() {
            Action::WriteWire(data) => {
                output.write_all(data)?;
                output.flush()?;
                let count = data.len();
                sender.wire_written(count);
            }
            Action::ReadFile { offset, max_len } => {
                let start = u64::from(offset.get());
                if start >= size {
                    return Err("sender read outside source data".into());
                }
                file.seek(SeekFrom::Start(start))?;
                let max = usize::try_from((size - start).min(max_len as u64))?;
                let mut data = vec![0u8; max];
                file.read_exact(&mut data)?;
                sender.submit_file(&data)?;
                processed = processed.max(start + max as u64);
                report_progress(processed, size, &mut progress_at, false);
            }
            Action::Event(Event::FileCompleted) => {
                done_file = true;
                report_progress(size, size, &mut progress_at, true);
            },
            Action::Event(Event::SessionCompleted) => {
                if !done_file {
                    return Err("session ended without file completion".into());
                }
                session_completed = true;
            }
            Action::Event(Event::Aborted) => return Err("remote aborted sender".into()),
            Action::Event(_) => {}
            Action::Idle => {
                if session_completed {
                    return Ok(());
                }
                if receive_wire(&rx, &mut waiting)? {
                    let input: Vec<u8> = waiting.iter().take(2048).copied().collect();
                    let used = sender.submit_wire(&input)?;
                    waiting.drain(..used);
                }
            }
            _ => return Err("unsupported sender action".into()),
        }
        if done_file && !finish_requested && sender.finish().is_ok() {
            finish_requested = true;
        }
    }

    Err("ZMODEM sender timed out".into())
}

fn safe_name(raw: &[u8]) -> Result<String, Box<dyn std::error::Error>> {
    let name = std::str::from_utf8(raw)?;
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '\0'])
        || name.ends_with(['.', ' '])
        || name.chars().any(|ch| ch.is_control())
    {
        return Err("unsafe ZMODEM filename".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    ) {
        return Err("reserved Windows device filename".into());
    }
    Ok(name.to_owned())
}

fn receive(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut receiver = Receiver::with_flow_control(0, true)?;
    let rx = incoming_wire();
    let mut waiting = VecDeque::<u8>::new();
    let mut output = io::stdout().lock();
    let mut open_file: Option<(File, PathBuf, PathBuf, u64, Option<u32>)> = None;
    let mut completed = false;
    let mut session_completed = false;
    let mut progress_at = Instant::now() - PROGRESS_INTERVAL;
    let mut received_total = 0u64;
    let deadline = Instant::now() + SESSION_TIMEOUT;

    while Instant::now() < deadline {
        match receiver.poll() {
            Action::WriteWire(data) => {
                output.write_all(data)?;
                output.flush()?;
                let count = data.len();
                receiver.wire_written(count);
            }
            Action::WriteFile(data) => {
                let data = data.to_vec();
                let (file, _, _, bytes, max) = open_file.as_mut().ok_or("unexpected file data")?;
                *bytes += data.len() as u64;
                if *bytes > MAX_SIZE || max.is_some_and(|size| *bytes > u64::from(size)) {
                    return Err("received file larger than advertised/allowed".into());
                }
                file.write_all(&data)?;
                receiver.file_written(data.len())?;
                report_progress(*bytes, received_total, &mut progress_at, false);
            }
            Action::Event(Event::FileStarted(info)) => {
                if open_file.is_some() || completed {
                    return Err("prototype supports one file per session".into());
                }
                let name = safe_name(info.name)?;
                let target = dir.join(name);
                if target.exists() {
                    return Err("destination already exists (no overwrite)".into());
                }
                if info.size.is_some_and(|size| u64::from(size.get()) > MAX_SIZE) {
                    return Err("incoming file exceeds 128 MiB prototype limit".into());
                }
                let suffix = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
                let temp = dir.join(format!(".openshell-zmodem-{}-{suffix}.part", std::process::id()));
                let file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
                let advertised = info.size.map(|size| size.get());
                received_total = advertised.map_or(0, u64::from);
                report_progress(0, received_total, &mut progress_at, true);
                open_file = Some((file, temp, target, 0, advertised));
            }
            Action::Event(Event::FileCompleted) => {
                let (mut file, temp, target, size, advertised) =
                    open_file.take().ok_or("file completed without start")?;
                if advertised.is_some_and(|expected| size != u64::from(expected)) {
                    return Err("received length differs from advertised length".into());
                }
                file.flush()?;
                file.sync_all()?;
                drop(file);
                fs::rename(temp, target)?;
                report_progress(size, received_total, &mut progress_at, true);
                completed = true;
            }
            Action::Event(Event::SessionCompleted) => {
                if !completed {
                    return Err("session ended without file completion".into());
                }
                session_completed = true;
            }
            Action::Event(Event::Aborted) => return Err("remote aborted receiver".into()),
            Action::Event(_) => {}
            Action::Idle => {
                if session_completed {
                    return Ok(());
                }
                if receive_wire(&rx, &mut waiting)? {
                    let input: Vec<u8> = waiting.iter().take(2048).copied().collect();
                    let used = receiver.submit_wire(&input)?;
                    waiting.drain(..used);
                }
            }
            _ => return Err("unsupported receiver action".into()),
        }
    }
    Err("ZMODEM receiver timed out".into())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let result = match args.as_slice() {
        [_, action, path] if action == "send" => send(Path::new(path)),
        [_, action, dir] if action == "receive" => receive(Path::new(dir)),
        _ => {
            eprintln!("Usage: zmodem-sidecar send FILE | receive EXISTING_DIRECTORY");
            std::process::exit(2);
        }
    };
    if let Err(error) = result {
        eprintln!("ZMODEM experiment failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn reject_traversal_device_names_and_separators() {
        for value in ["../evil", "..", "C:evil", "foo\\bar", "CON", "con.txt", "NUL", "LPT1.log", "test.", ""] {
            assert!(safe_name(value.as_bytes()).is_err(), "{value:?} should be rejected");
        }
    }

    #[test]
    fn allow_simple_and_utf8_filenames() {
        for value in ["readme.txt", "hello-2026.bin", "中文资料.bin"] {
            assert_eq!(safe_name(value.as_bytes()).unwrap(), value);
        }
    }
}
