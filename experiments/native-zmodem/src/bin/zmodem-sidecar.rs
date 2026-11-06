//! OpenShell native ZMODEM protocol sidecar: binary stdin/stdout only.
//! stdout is exclusively binary protocol bytes; diagnostics go to stderr.
//! The Go SSH coordinator owns terminal takeovers, filesystem policy and packaging.

use std::collections::VecDeque;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver as ChannelReceiver};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use zmodem2::{Action, Event, FileInfo, Position, Receiver, Sender};

// Keep old/32-bit lrzsz interoperability by staying below 2 GiB.
const MAX_SIZE: u64 = (2 * 1024 * 1024 * 1024) - 1;
const MAX_FILES_PER_SESSION: usize = 100;
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(90);

fn checked_file_size(size: u64) -> io::Result<()> {
    if size > MAX_SIZE {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "ZMODEM file exceeds the 2 GiB compatibility limit"));
    }
    Ok(())
}

// Time out only when the protocol stops exchanging meaningful bytes. A large
// transfer is not limited by elapsed wall-clock duration.
struct ActivityClock {
    last: Instant,
}

impl ActivityClock {
    fn new() -> Self { Self { last: Instant::now() } }
    fn touch(&mut self) { self.last = Instant::now(); }
    fn expired(&self) -> bool { self.last.elapsed() >= INACTIVITY_TIMEOUT }
}
const READ_TIMEOUT: Duration = Duration::from_millis(150);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const MAX_EXPERIMENT_BATCH: usize = 32 * 1024;
const DEFAULT_EXPERIMENT_BATCH: usize = 16 * 1024;

// The native sidecar remains explicitly experimental. The batching strategy
// defaults to 16 KiB only when this sidecar is invoked; it never enables native
// rz/sz takeover in the application. An explicit zero restores per-frame flush.
fn parse_wire_batch_bytes(raw: Option<&str>) -> io::Result<usize> {
    let Some(raw) = raw else { return Ok(DEFAULT_EXPERIMENT_BATCH) };
    let bytes = raw.parse::<usize>().map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "invalid wire batch size")
    })?;
    if bytes != 0 && (bytes < 1024 || bytes > MAX_EXPERIMENT_BATCH) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "wire batch size must be 0 or 1024..32768 bytes"));
    }
    Ok(bytes)
}

fn experimental_wire_batch_bytes() -> io::Result<usize> {
    match env::var("OPENSHELL_ZMODEM_WIRE_BATCH_BYTES") {
        Err(env::VarError::NotPresent) => parse_wire_batch_bytes(None),
        Err(err) => Err(io::Error::new(io::ErrorKind::InvalidInput, err)),
        Ok(raw) => parse_wire_batch_bytes(Some(&raw)),
    }
}

// This writer never mutates or parses protocol frames. When enabled, it
// coalesces small consecutive writes, but always drains before an Idle wait.
// The disabled path retains the original per-frame flush semantics.
struct ExperimentalWireWriter<W: Write> {
    writer: W,
    pending: Vec<u8>,
    limit: usize,
}

impl<W: Write> ExperimentalWireWriter<W> {
    fn new(writer: W, limit: usize) -> Self {
        Self { writer, pending: Vec::with_capacity(limit), limit }
    }

    fn write_wire(&mut self, frame: &[u8]) -> io::Result<()> {
        if self.limit == 0 {
            self.writer.write_all(frame)?;
            return self.writer.flush();
        }
        if frame.len() >= self.limit {
            self.flush_pending()?;
            self.writer.write_all(frame)?;
            return self.writer.flush();
        }
        if self.pending.len() + frame.len() > self.limit {
            self.flush_pending()?;
        }
        self.pending.extend_from_slice(frame);
        if self.pending.len() == self.limit {
            self.flush_pending()?;
        }
        Ok(())
    }

    fn flush_pending(&mut self) -> io::Result<()> {
        if !self.pending.is_empty() {
            self.writer.write_all(&self.pending)?;
            self.pending.clear();
            self.writer.flush()?;
        }
        Ok(())
    }
}

// Diagnostics only: stdout remains exclusively binary ZMODEM protocol.
// Upload progress is bytes read from the source, not proof of remote persistence.
fn report_progress(processed: u64, total: u64, last: &mut Instant, force: bool) -> bool {
    if force || last.elapsed() >= PROGRESS_INTERVAL {
        eprintln!("OSZP\t{processed}\t{total}");
        *last = Instant::now();
        return true;
    }
    false
}

fn report_file_start(index: usize, name: &str, size: Option<u64>) {
    let hex_name = name.as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>();
    let advertised = size.map_or_else(|| "-1".to_owned(), |size| size.to_string());
    eprintln!("OSZF\tstart\t{index}\t{advertised}\t{hex_name}");
}

fn report_file_bytes(kind: &str, index: usize, processed: u64) {
    eprintln!("OSZF\t{kind}\t{index}\t{processed}");
}


// The sender only checks requests at file boundaries; stdin/stdout remain
// exclusively ZMODEM protocol streams. Indices are written by the Go app.
fn skip_requested_from_path(path: &Path, index: usize) -> bool {
    if fs::metadata(path).is_err_or(|meta| meta.len() > 4096) {
        return false;
    }
    fs::read_to_string(path).is_ok_and(|requests| {
        requests.lines().any(|line| line.parse::<usize>().ok() == Some(index))
    })
}

fn skip_requested(index: usize) -> bool {
    let Some(path) = env::var_os("OPENSHELL_ZMODEM_SKIP_FILE") else { return false };
    skip_requested_from_path(Path::new(&path), index)
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

// Reuse one source buffer across sequential ZMODEM block requests. A backward
// retransmission only seeks if the remote peer requests an earlier offset.
fn read_source_chunk(
    file: &mut File,
    offset: u64,
    len: usize,
    next_offset: &mut u64,
    scratch: &mut Vec<u8>,
) -> io::Result<()> {
    if offset != *next_offset {
        file.seek(SeekFrom::Start(offset))?;
    }
    scratch.resize(len, 0);
    file.read_exact(scratch)?;
    *next_offset = offset + len as u64;
    Ok(())
}

struct SendSource {
    file: File,
    name: String,
    size: u64,
}

// Private, NUL-delimited UTF-8 path manifest used by the Windows/Go desktop
// bridge. NUL avoids interpreting quotes, spaces or newlines as shell syntax.
fn read_send_manifest(manifest: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let contents = fs::read(manifest)?;
    if contents.is_empty() || contents.len() > 1024 * 1024 || *contents.last().unwrap() != 0 {
        return Err("invalid native ZMODEM upload manifest".into());
    }
    let records = contents[..contents.len() - 1].split(|b| *b == 0);
    let mut paths = Vec::new();
    for record in records {
        if record.is_empty() {
            return Err("native upload manifest contains an empty filename".into());
        }
        paths.push(PathBuf::from(std::str::from_utf8(record)?));
        if paths.len() > MAX_FILES_PER_SESSION {
            return Err("native ZMODEM allows at most 100 files per session".into());
        }
    }
    Ok(paths)
}

fn send(paths: &[PathBuf]) -> Result<(), Box<dyn std::error::Error>> {
    if paths.is_empty() || paths.len() > MAX_FILES_PER_SESSION {
        return Err("native ZMODEM accepts 1..100 files per session".into());
    }
    let mut files = Vec::<SendSource>::with_capacity(paths.len());
    let mut names = std::collections::HashSet::<String>::new();
    let mut total = 0u64;
    for path in paths {
        let meta = fs::symlink_metadata(path)?;
        if !meta.file_type().is_file() || meta.file_type().is_symlink() {
            return Err("native ZMODEM only accepts regular files, not links or directories".into());
        }
        let name = safe_name(path.file_name().and_then(|n| n.to_str())
            .ok_or("source filename must be UTF-8")?.as_bytes())?;
        if !names.insert(name.to_lowercase()) {
            return Err("multiple files have the same destination filename".into());
        }
        let size = meta.len();
        checked_file_size(size)?;
        total = total.checked_add(size).ok_or("batch total size overflow")?;
        files.push(SendSource { file: File::open(path)?, name, size });
    }

    let mut sender = Sender::new()?;
    sender.start_file(FileInfo::new(files[0].name.as_bytes(), Some(Position::new(files[0].size as u32))))?;
    let rx = incoming_wire();
    let mut waiting = VecDeque::<u8>::new();
    let mut wire_scratch = Vec::<u8>::with_capacity(2048);
    let mut output = ExperimentalWireWriter::new(io::stdout().lock(), experimental_wire_batch_bytes()?);
    let mut file_scratch = Vec::<u8>::new();
    let mut next_file_offset = 0u64;
    let mut active_index = 0usize;
    let mut completed_files = 0usize;
    let mut completed_bytes = 0u64;
    let mut processed_in_file = 0u64;
    let mut pending_next = false;
    let mut finish_requested = false;
    let mut session_completed = false;
    let mut progress_at = Instant::now() - PROGRESS_INTERVAL;
    let mut activity = ActivityClock::new();
    report_progress(0, total, &mut progress_at, true);
    report_file_start(0, &files[0].name, Some(files[0].size));

    while !activity.expired() {
        match sender.poll() {
            Action::WriteWire(data) => {
                output.write_wire(data)?;
                let count = data.len();
                sender.wire_written(count);
                if count > 0 { activity.touch(); }
            }
            Action::ReadFile { offset, max_len } => {
                let source = &mut files[active_index];
                let start = u64::from(offset.get());
                if start >= source.size {
                    return Err("sender read outside source data".into());
                }
                let max = usize::try_from((source.size - start).min(max_len as u64))?;
                read_source_chunk(&mut source.file, start, max, &mut next_file_offset, &mut file_scratch)?;
                sender.submit_file(&file_scratch)?;
                if max > 0 { activity.touch(); }
                processed_in_file = processed_in_file.max(start + max as u64);
                if report_progress(completed_bytes + processed_in_file, total, &mut progress_at, false) {
                    report_file_bytes("progress", active_index, processed_in_file);
                }
            }
            Action::Event(Event::FileCompleted) => {
                output.flush_pending()?;
                completed_bytes += files[active_index].size;
                report_file_bytes("completed", active_index, files[active_index].size);
                completed_files += 1;
                report_progress(completed_bytes, total, &mut progress_at, true);
                activity.touch();
                if completed_files < files.len() {
                    active_index = completed_files;
                    processed_in_file = 0;
                    next_file_offset = 0;
                    pending_next = true;
                }
            }
            Action::Event(Event::SessionCompleted) => {
                output.flush_pending()?;
                if completed_files != files.len() {
                    return Err("session ended before every file completed".into());
                }
                session_completed = true;
                activity.touch();
            }
            Action::Event(Event::Aborted) => return Err("remote aborted sender".into()),
            Action::Event(_) => {}
            Action::Idle => {
                output.flush_pending()?;
                if session_completed { return Ok(()); }
                if receive_wire(&rx, &mut waiting)? {
                    wire_scratch.clear();
                    wire_scratch.extend(waiting.iter().take(2048).copied());
                    let used = sender.submit_wire(&wire_scratch)?;
                    if used > 0 { activity.touch(); }
                    waiting.drain(..used);
                }
            }
            _ => return Err("unsupported sender action".into()),
        }
        if pending_next {
            while completed_files < files.len() && skip_requested(active_index) {
                let skipped = &files[active_index];
                total = total.saturating_sub(skipped.size);
                report_file_bytes("skipped", active_index, 0);
                completed_files += 1;
                active_index = completed_files;
                report_progress(completed_bytes, total, &mut progress_at, true);
                activity.touch();
            }
            if completed_files == files.len() {
                pending_next = false;
            } else {
                let source = &files[active_index];
                match sender.start_file(FileInfo::new(source.name.as_bytes(), Some(Position::new(source.size as u32)))) {
                    Ok(()) => {
                        report_file_start(active_index, &source.name, Some(source.size));
                        pending_next = false;
                        activity.touch();
                    }
                    Err(zmodem2::Error::Backpressure) => {}
                    Err(err) => return Err(err.into()),
                }
            }
        }
        if completed_files == files.len() && !finish_requested && sender.finish().is_ok() {
            finish_requested = true;
        }
    }
    Err("ZMODEM sender inactive for 90 seconds".into())
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

// Opt-in receiver metrics are emitted to stderr, never to binary stdout.
// No filenames, payload bytes or credentials are included.
#[derive(Default)]
struct ReceiverDiagnostics {
    enabled: bool,
    completed: bool,
    poll_calls: u64,
    poll_ns: u128,
    idle_calls: u64,
    wait_ns: u128,
    wait_max_ns: u128,
    file_write_ns: u128,
    file_sync_ns: u128,
    wire_write_ns: u128,
    file_bytes: u64,
}

impl ReceiverDiagnostics {
    fn new() -> Self {
        Self {
            enabled: env::var("OPENSHELL_ZMODEM_RX_DIAG").as_deref() == Ok("1"),
            ..Self::default()
        }
    }
}

impl Drop for ReceiverDiagnostics {
    fn drop(&mut self) {
        if self.enabled {
            eprintln!(
                "OSZD\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                u8::from(self.completed),
                self.poll_calls, self.poll_ns, self.idle_calls,
                self.wait_ns, self.wait_max_ns, self.file_write_ns,
                self.file_sync_ns, self.wire_write_ns, self.file_bytes
            );
        }
    }
}

fn receive(dir: &Path, auto_rename: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut receiver = Receiver::with_flow_control(0, true)?;
    let rx = incoming_wire();
    let mut waiting = VecDeque::<u8>::new();
    let mut wire_scratch = Vec::<u8>::with_capacity(2048);
    let mut output = ExperimentalWireWriter::new(io::stdout().lock(), experimental_wire_batch_bytes()?);
    let mut open_file: Option<(File, PathBuf, PathBuf, u64, Option<u32>)> = None;
    let mut completed_files = 0usize;
    let mut session_completed = false;
    let mut progress_at = Instant::now() - PROGRESS_INTERVAL;
    let mut received_total = 0u64;
    let mut file_write_scratch = Vec::<u8>::new();
    let mut diag = ReceiverDiagnostics::new();
    let mut activity = ActivityClock::new();

    while !activity.expired() {
        let poll_started = if diag.enabled { Some(Instant::now()) } else { None };
        let action = receiver.poll();
        if let Some(started) = poll_started {
            diag.poll_calls += 1;
            diag.poll_ns += started.elapsed().as_nanos();
        }
        match action {
            Action::WriteWire(data) => {
                let started = if diag.enabled { Some(Instant::now()) } else { None };
                output.write_wire(data)?;
                if let Some(started) = started {
                    diag.wire_write_ns += started.elapsed().as_nanos();
                }
                let count = data.len();
                receiver.wire_written(count);
                if count > 0 { activity.touch(); }
            }
            Action::WriteFile(data) => {
                // Flush any pending acknowledgement before handling more data.
                // lrzsz-win32 may stop sending until the control frame arrives.
                output.flush_pending()?;
                // poll() borrows receiver; copy into one reusable owned buffer
                // before file_written() mutably borrows receiver again.
                file_write_scratch.clear();
                file_write_scratch.extend_from_slice(data);
                let received = file_write_scratch.len();
                let (file, _, _, bytes, max) = open_file.as_mut().ok_or("unexpected file data")?;
                *bytes += received as u64;
                if *bytes > MAX_SIZE || max.is_some_and(|size| *bytes > u64::from(size)) {
                    return Err("received file larger than advertised/allowed".into());
                }
                let started = if diag.enabled { Some(Instant::now()) } else { None };
                file.write_all(&file_write_scratch)?;
                if let Some(started) = started {
                    diag.file_write_ns += started.elapsed().as_nanos();
                    diag.file_bytes += received as u64;
                }
                receiver.file_written(received)?;
                if received > 0 { activity.touch(); }
                if report_progress(*bytes, received_total, &mut progress_at, false) {
                    report_file_bytes("progress", completed_files, *bytes);
                }
            }
            Action::Event(Event::FileStarted(info)) => {
                // The sender can be waiting for an acknowledgement at this edge.
                output.flush_pending()?;
                if open_file.is_some() || completed_files >= MAX_FILES_PER_SESSION {
                    return Err("native receiver accepts at most 100 files per session".into());
                }
                let name = safe_name(info.name)?;
                let mut target = dir.join(&name);
                if target.exists() && auto_rename {
                    let original = Path::new(&name);
                    let stem = original.file_stem().and_then(|v| v.to_str()).ok_or("invalid filename stem")?;
                    let ext = original.extension().and_then(|v| v.to_str());
                    let mut free = None;
                    for number in 1..=9999 {
                        let alternative = match ext {
                            Some(ext) => format!("{stem}.{number}.{ext}"),
                            None => format!("{stem}.{number}"),
                        };
                        let candidate = dir.join(alternative);
                        if !candidate.exists() {
                            free = Some(candidate);
                            break;
                        }
                    }
                    target = free.ok_or("could not allocate a unique download filename")?;
                }
                if target.exists() {
                    return Err("destination already exists (no overwrite)".into());
                }
                if info.size.is_some_and(|size| checked_file_size(u64::from(size.get())).is_err()) {
                    return Err("incoming file exceeds the 2 GiB compatibility limit".into());
                }
                let suffix = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
                let temp = dir.join(format!(".openshell-zmodem-{}-{suffix}.part", std::process::id()));
                let file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
                let advertised = info.size.map(|size| size.get());
                received_total = advertised.map_or(0, u64::from);
                report_progress(0, received_total, &mut progress_at, true);
                report_file_start(completed_files, &name, advertised.map(u64::from));
                open_file = Some((file, temp, target, 0, advertised));
                activity.touch();
            }
            Action::Event(Event::FileCompleted) => {
                output.flush_pending()?;
                let (mut file, temp, target, size, advertised) =
                    open_file.take().ok_or("file completed without start")?;
                if advertised.is_some_and(|expected| size != u64::from(expected)) {
                    return Err("received length differs from advertised length".into());
                }
                file.flush()?;
                let started = if diag.enabled { Some(Instant::now()) } else { None };
                file.sync_all()?;
                if let Some(started) = started {
                    diag.file_sync_ns += started.elapsed().as_nanos();
                }
                drop(file);
                // Never overwrite another file created between the earlier
                // path check and the completion of the transfer.
                fs::hard_link(&temp, &target)?;
                fs::remove_file(&temp)?;
                report_progress(size, received_total, &mut progress_at, true);
                report_file_bytes("completed", completed_files, size);
                completed_files += 1;
                activity.touch();
            }
            Action::Event(Event::SessionCompleted) => {
                output.flush_pending()?;
                if completed_files == 0 || open_file.is_some() {
                    return Err("session ended without completing all files".into());
                }
                session_completed = true;
                activity.touch();
            }
            Action::Event(Event::Aborted) => return Err("remote aborted receiver".into()),
            Action::Event(_) => {}
            Action::Idle => {
                // Always send pending acknowledgements before waiting.
                output.flush_pending()?;
                if session_completed {
                    diag.completed = true;
                    return Ok(());
                }
                let started = if diag.enabled { Some(Instant::now()) } else { None };
                let have_wire = receive_wire(&rx, &mut waiting)?;
                if let Some(started) = started {
                    let elapsed = started.elapsed().as_nanos();
                    diag.idle_calls += 1;
                    diag.wait_ns += elapsed;
                    diag.wait_max_ns = diag.wait_max_ns.max(elapsed);
                }
                if have_wire {
                    wire_scratch.clear();
                    wire_scratch.extend(waiting.iter().take(2048).copied());
                    let used = receiver.submit_wire(&wire_scratch)?;
                    if used > 0 { activity.touch(); }
                    waiting.drain(..used);
                }
            }
            _ => return Err("unsupported receiver action".into()),
        }
    }
    Err("ZMODEM receiver inactive for 90 seconds".into())
}

// The pinned trzsz-go ZMODEM filter still detects remote-initiated rz/sz,
// but its local subprocess is now this Rust sidecar rather than MSYS2 lrzsz.
// Accept only flags that do not alter the protocol/file semantics.
fn parse_legacy_args(args: &[String], sending: bool) -> Result<(bool, Vec<PathBuf>), Box<dyn std::error::Error>> {
    let mut rename = false;
    let mut paths = Vec::new();
    let mut end_options = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !end_options {
            match arg.as_str() {
                "--" => { end_options = true; i += 1; continue; }
                "-v" | "-e" | "-b" | "-q" => { i += 1; continue; }
                "-E" => { rename = true; i += 1; continue; }
                "-B" => {
                    if i + 1 >= args.len() || args[i + 1].parse::<u32>().ok().filter(|n| *n > 0 && *n <= 65536).is_none() {
                        return Err("invalid legacy ZMODEM block size".into());
                    }
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        if arg.starts_with('-') && !end_options { return Err("unsupported legacy ZMODEM option".into()); }
        paths.push(PathBuf::from(arg.as_str()));
        i += 1;
    }
    if (sending && (paths.is_empty() || paths.len() > MAX_FILES_PER_SESSION)) ||
       (!sending && !paths.is_empty()) {
        return Err("invalid legacy ZMODEM file arguments".into());
    }
    Ok((rename, paths))
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() == 3 && args[2] == "--version" &&
        (args[1] == "compat-rz" || args[1] == "compat-sz") {
        println!("OpenShell native Rust ZMODEM {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let result = match args.as_slice() {
        [_, action, paths @ ..] if action == "send" && !paths.is_empty() =>
            send(&paths.iter().map(PathBuf::from).collect::<Vec<_>>()),
        [_, action, manifest] if action == "send-list" =>
            read_send_manifest(Path::new(manifest)).and_then(|paths| send(&paths)),
        [_, action, dir] if action == "receive" => receive(Path::new(dir), false),
        [_, action, args @ ..] if action == "compat-sz" =>
            parse_legacy_args(args, true).and_then(|(_, paths)| send(&paths)),
        [_, action, args @ ..] if action == "compat-rz" =>
            parse_legacy_args(args, false).and_then(|(rename, _)| receive(&env::current_dir()?, rename)),
        _ => {
            eprintln!("Usage: zmodem-sidecar send FILE [FILE ...] | send-list MANIFEST | receive DIRECTORY | compat-rz [-E -e -b -B 32768] | compat-sz [-e -b -B 32768] FILE...");
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
    use super::{checked_file_size, parse_wire_batch_bytes, read_source_chunk, safe_name, skip_requested_from_path, ActivityClock, ExperimentalWireWriter, INACTIVITY_TIMEOUT, MAX_SIZE};
    use std::fs::{self, OpenOptions};
    use std::io::{Seek, SeekFrom, Write};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn source_chunks_reuse_storage_and_support_retransmission() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("openshell-source-chunk-{}-{suffix}", std::process::id()));
        let mut file = OpenOptions::new().read(true).write(true).create_new(true).open(&path).unwrap();
        file.write_all(b"abcdefghijklmnopqrstuvwxyz").unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut buffer = Vec::with_capacity(8);
        let mut next = 0u64;
        read_source_chunk(&mut file, 0, 8, &mut next, &mut buffer).unwrap();
        assert_eq!(&buffer, b"abcdefgh");
        let pointer = buffer.as_ptr();
        read_source_chunk(&mut file, 8, 8, &mut next, &mut buffer).unwrap();
        assert_eq!(&buffer, b"ijklmnop");
        assert_eq!(pointer, buffer.as_ptr(), "sequential blocks should reuse the allocation");
        read_source_chunk(&mut file, 4, 8, &mut next, &mut buffer).unwrap();
        assert_eq!(&buffer, b"efghijkl", "remote retransmission must seek correctly");
        assert_eq!(next, 12);
        drop(file);
        fs::remove_file(path).unwrap();
    }


    #[test]
    fn skips_only_requested_file_indices() {
        let dir = std::env::temp_dir().join(format!(
            "openshell-zmodem-skip-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        fs::create_dir(&dir).unwrap();
        let control = dir.join("pending");
        fs::write(&control, b"1\n3\n").unwrap();
        assert!(!skip_requested_from_path(&control, 0));
        assert!(skip_requested_from_path(&control, 1));
        assert!(!skip_requested_from_path(&control, 2));
        assert!(skip_requested_from_path(&control, 3));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn supports_gib_files_without_overflowing_legacy_zmodem_offsets() {
        assert!(checked_file_size(128 * 1024 * 1024).is_ok());
        assert!(checked_file_size(1024 * 1024 * 1024).is_ok());
        assert!(checked_file_size(MAX_SIZE).is_ok());
        assert!(checked_file_size(MAX_SIZE + 1).is_err());
        assert!(checked_file_size(u32::MAX as u64 + 1).is_err());
    }

    #[test]
    fn inactivity_clock_renews_after_protocol_progress() {
        let mut clock = ActivityClock::new();
        clock.last -= INACTIVITY_TIMEOUT + std::time::Duration::from_secs(1);
        assert!(clock.expired(), "a stalled peer must time out");
        clock.touch();
        assert!(!clock.expired(), "fresh protocol traffic must reset the idle window");
    }

    #[test]
    fn native_experiment_defaults_to_16_kib_and_allows_zero_fallback() {
        assert_eq!(parse_wire_batch_bytes(None).unwrap(), 16 * 1024);
        assert_eq!(parse_wire_batch_bytes(Some("0")).unwrap(), 0);
        assert_eq!(parse_wire_batch_bytes(Some("16384")).unwrap(), 16 * 1024);
        assert_eq!(parse_wire_batch_bytes(Some("32768")).unwrap(), 32 * 1024);
        for invalid in ["", "-1", "1", "999", "32769", "invalid"] {
            assert!(parse_wire_batch_bytes(Some(invalid)).is_err());
        }
    }

    #[test]
    fn default_wire_writer_flushes_every_frame_without_changes() {
        let mut writer = ExperimentalWireWriter::new(std::io::Cursor::new(Vec::new()), 0);
        writer.write_wire(&[0x00, 0x18, 0xff]).unwrap();
        assert_eq!(writer.writer.get_ref().as_slice(), &[0x00, 0x18, 0xff]);
        writer.write_wire(&[0x01, 0x02]).unwrap();
        assert_eq!(writer.writer.get_ref().as_slice(), &[0x00, 0x18, 0xff, 0x01, 0x02]);
    }

    #[test]
    fn wire_batches_preserve_frame_order_and_idle_flush_boundary() {
        let mut writer = ExperimentalWireWriter::new(std::io::Cursor::new(Vec::new()), 8);
        writer.write_wire(&[0x18, 0x00, 0xff]).unwrap();
        writer.write_wire(&[0x01, 0x7f]).unwrap();
        assert!(writer.writer.get_ref().as_slice().is_empty(), "must coalesce adjacent small frames");
        writer.flush_pending().unwrap();
        assert_eq!(writer.writer.get_ref().as_slice(), &[0x18, 0x00, 0xff, 0x01, 0x7f]);
        writer.write_wire(&[3, 4, 5, 6, 7]).unwrap();
        writer.write_wire(&[8, 9, 10, 11]).unwrap();
        assert_eq!(writer.writer.get_ref().as_slice(), &[0x18, 0x00, 0xff, 0x01, 0x7f, 3, 4, 5, 6, 7]);
        writer.flush_pending().unwrap();
        assert_eq!(writer.writer.get_ref().as_slice(), &[0x18, 0x00, 0xff, 0x01, 0x7f, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }

    #[test]
    fn wire_batches_send_oversized_frames_without_buffering() {
        let mut writer = ExperimentalWireWriter::new(std::io::Cursor::new(Vec::new()), 4);
        writer.write_wire(&[0x18]).unwrap();
        writer.write_wire(&[1, 2, 3, 4, 5]).unwrap();
        assert_eq!(writer.writer.get_ref().as_slice(), &[0x18, 1, 2, 3, 4, 5]);
        assert!(writer.pending.is_empty());
    }

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
