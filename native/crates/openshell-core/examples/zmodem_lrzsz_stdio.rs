//! Unix-only real-lrzsz interoperability adapter.
//! stdin/stdout are protocol wire bytes; diagnostics only to stderr.
//! This is a test helper, not a production file-transfer command.

#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("ZMODEM interop adapter: {error}");
        std::process::exit(1);
    }
}

#[cfg(unix)]
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    use openshell_core::zmodem_engine::{
        safe_filename, ZmodemAction, ZmodemEngine, ZmodemEngineError, ZmodemEvent, ZmodemRole,
    };
    use std::{
        fs::{File, OpenOptions},
        io::Write,
        path::PathBuf,
        time::{Duration, Instant},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || !matches!(args[1].as_str(), "send" | "receive") {
        return Err("usage: zmodem_lrzsz_stdio send <file> | receive <directory>".into());
    }
    let send = args[1] == "send";
    let path = PathBuf::from(&args[2]);
    let mut payload = Vec::new();
    let mut name = String::new();
    if send {
        payload = std::fs::read(&path)?;
        if payload.is_empty() || payload.len() > 1024 * 1024 {
            return Err("interop fixtures must be 1 byte to 1 MiB".into());
        }
        let basename = path.file_name().ok_or("source file has no name")?;
        name = safe_filename(basename.to_string_lossy().as_bytes())?;
    } else if !path.is_dir() {
        return Err("download destination must be an existing directory".into());
    }

    let mut protocol = ZmodemEngine::new(if send {
        ZmodemRole::Send
    } else {
        ZmodemRole::Receive
    })?;
    let mut offered = false;
    let mut should_finish = false;
    let mut completed = false;
    let mut current: Option<(String, File, Option<u64>, u64)> = None;
    let mut pending = Vec::<u8>::new();
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    let mut buffer = [0_u8; 8192];
    let deadline = Instant::now() + Duration::from_secs(35);

    while Instant::now() < deadline {
        for _ in 0..256 {
            if !pending.is_empty() {
                let used = protocol.submit_wire(&pending)?;
                if used > pending.len() { return Err("invalid protocol consume count".into()); }
                pending.drain(..used);
            }
            if send && !offered {
                match protocol.start_file(&name, payload.len() as u64) {
                    Ok(()) => offered = true,
                    Err(ZmodemEngineError::Protocol(zmodem2::Error::Backpressure)) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            if should_finish {
                match protocol.finish() {
                    Ok(()) => should_finish = false,
                    Err(ZmodemEngineError::Protocol(zmodem2::Error::Backpressure)) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            match protocol.next_action()? {
                ZmodemAction::Wire(bytes) => {
                    output.write_all(&bytes).await?;
                    output.flush().await?;
                    protocol.wire_written(bytes.len());
                }
                ZmodemAction::ReadFile { offset, max_len } if send => {
                    let start = offset as usize;
                    if start >= payload.len() { return Err("source was read past EOF".into()); }
                    let end = start.saturating_add(max_len).min(payload.len());
                    protocol.submit_file(&payload[start..end])?;
                }
                ZmodemAction::Event(ZmodemEvent::OfferedFile { name, size }) if !send => {
                    let basename = safe_filename(name.as_bytes())?;
                    eprintln!("ZFILE offer: {basename} size {size:?}");
                    if let Some((current_name, _, current_size, written)) = &current {
                        if current_name != &basename || *current_size != size.map(u64::from) {
                            return Err("different file header before previous ZEOF".into());
                        }
                        eprintln!("Retry ZFILE for same file at offset {written}");
                        protocol.accept_received_file_at(*written as u32)?;
                    } else {
                        match OpenOptions::new().write(true).create_new(true)
                            .open(path.join(&basename))
                        {
                            Ok(file) => {
                                current = Some((basename, file, size.map(u64::from), 0));
                                protocol.accept_received_file()?;
                            }
                            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists =>
                                protocol.skip_received_file()?,
                            Err(err) => return Err(err.into()),
                        }
                    }
                }
                ZmodemAction::WriteFile(bytes) if !send => {
                    let Some((_, file, size, written)) = current.as_mut() else {
                        return Err("received bytes without file offer".into());
                    };
                    let total = *written + bytes.len() as u64;
                    if size.is_some_and(|expected| total > expected) {
                        return Err("ZMODEM file exceeded declared size".into());
                    }
                    file.write_all(&bytes)?;
                    *written = total;
                    protocol.file_written(bytes.len())?;
                }
                ZmodemAction::Event(ZmodemEvent::FileCompleted) if send => {
                    eprintln!("PROTO sender FileCompleted");
                    should_finish = true;
                }
                ZmodemAction::Event(ZmodemEvent::FileCompleted) => {
                    eprintln!("PROTO receiver FileCompleted");
                    if let Some((_, file, expected, written)) = current.take() {
                        if expected.is_some_and(|n| n != written) {
                            return Err("file shorter than declared ZFILE length".into());
                        }
                        file.sync_all()?;
                    }
                }
                ZmodemAction::Event(ZmodemEvent::SessionCompleted) => {
                    eprintln!("PROTO SessionCompleted; flushing queued final wire frames");
                    if current.is_some() { return Err("incomplete file at session end".into()); }
                    completed = true;
                    // Keep polling until Idle: zmodem2 can queue the final
                    // ZFIN reply after emitting SessionCompleted.
                }
                ZmodemAction::Event(ZmodemEvent::Aborted) =>
                    return Err("peer aborted ZMODEM session".into()),
                ZmodemAction::Idle => break,
                ZmodemAction::ReadFile { .. } | ZmodemAction::WriteFile(_) =>
                    return Err("ZMODEM protocol requested I/O for wrong role".into()),
                _ => {}
            }
        }
        if completed { break; }
        match tokio::time::timeout(Duration::from_millis(100), input.read(&mut buffer)).await {
            Ok(Ok(0)) => return Err("wire closed before protocol completion".into()),
            Ok(Ok(count)) => {
                if pending.len().saturating_add(count) > 256 * 1024 {
                    return Err("protocol input backlog exceeded 256 KiB".into());
                }
                pending.extend_from_slice(&buffer[..count]);
            }
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => {}
        }
    }
    if !completed { return Err("interop ZMODEM session timed out".into()); }
    Ok(())
}
