//! ZMODEM state-machine adapter with no SSH, GPUI, or filesystem ownership.
//!
//! The caller must grant a ZMODEM operation exclusive access to one SSH PTY
//! byte stream before feeding this module. Do not feed its wire bytes into
//! Alacritty; never reuse an SFTP transport for this protocol.

use thiserror::Error;
use zmodem2::{Action, Event, FileInfo, Position, Receiver, Sender};

/// The protocol uses 32-bit positions. Reject larger files rather than
/// silently wrapping their size or corrupting remote data.
pub const MAX_ZMODEM_FILE_SIZE: u64 = u32::MAX as u64;
pub const MAX_FILE_IO_CHUNK: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZmodemRole {
    /// Local program sends data into remote rz.
    Send,
    /// Local program receives data from remote sz.
    Receive,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ZmodemEvent {
    OfferedFile { name: String, size: Option<u32> },
    FileCompleted,
    SessionCompleted,
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ZmodemAction {
    Wire(Vec<u8>),
    ReadFile { offset: u32, max_len: usize },
    WriteFile(Vec<u8>),
    Event(ZmodemEvent),
    Idle,
}

#[derive(Debug, Error)]
pub enum ZmodemEngineError {
    #[error(transparent)]
    Protocol(#[from] zmodem2::Error),
    #[error("unsafe or unsupported file name")]
    UnsafeName,
    #[error("file size exceeds ZMODEM's 32-bit limit")]
    FileTooLarge,
    #[error("operation is incompatible with ZMODEM transfer role")]
    WrongRole,
}

enum State {
    Sending(Sender),
    Receiving(Receiver),
}

/// Drives one wire protocol at a time. It does not own files, paths or SSH.
pub struct ZmodemEngine {
    state: State,
}

impl ZmodemEngine {
    pub fn new(role: ZmodemRole) -> Result<Self, ZmodemEngineError> {
        let state = match role {
            ZmodemRole::Send => State::Sending(Sender::new()?),
            ZmodemRole::Receive => {
                // Require explicit file acceptance, so a malicious remote
                // ZFILE name cannot create files without a safe user choice.
                let mut receiver = Receiver::with_flow_control(0, true)?;
                receiver.set_manual_file_accept(true);
                State::Receiving(receiver)
            }
        };
        Ok(Self { state })
    }

    pub fn role(&self) -> ZmodemRole {
        match &self.state {
            State::Sending(_) => ZmodemRole::Send,
            State::Receiving(_) => ZmodemRole::Receive,
        }
    }

    pub fn next_action(&mut self) -> Result<ZmodemAction, ZmodemEngineError> {
        let action = match &mut self.state {
            State::Sending(sender) => sender.poll(),
            State::Receiving(receiver) => receiver.poll(),
        };
        Ok(match action {
            Action::WriteWire(bytes) => ZmodemAction::Wire(bytes.to_vec()),
            Action::ReadFile { offset, max_len } =>
                ZmodemAction::ReadFile {
                    offset: offset.get(),
                    max_len: max_len.min(MAX_FILE_IO_CHUNK),
                },
            Action::WriteFile(bytes) => ZmodemAction::WriteFile(bytes.to_vec()),
            Action::Event(event) => ZmodemAction::Event(match event {
                Event::FileStarted(file) => ZmodemEvent::OfferedFile {
                    name: safe_filename(file.name)?,
                    size: file.size.map(Position::get),
                },
                Event::FileCompleted => ZmodemEvent::FileCompleted,
                Event::SessionCompleted => ZmodemEvent::SessionCompleted,
                Event::Aborted => ZmodemEvent::Aborted,
                _ => return Ok(ZmodemAction::Idle),
            }),
            Action::Idle => ZmodemAction::Idle,
            _ => ZmodemAction::Idle,
        })
    }

    /// Returns bytes consumed; callers must retain and retry any remainder.
    pub fn submit_wire(&mut self, bytes: &[u8]) -> Result<usize, ZmodemEngineError> {
        Ok(match &mut self.state {
            State::Sending(sender) => sender.submit_wire(bytes)?,
            State::Receiving(receiver) => receiver.submit_wire(bytes)?,
        })
    }

    /// Call only after the entire returned wire chunk was actually written.
    pub fn wire_written(&mut self, bytes: usize) {
        match &mut self.state {
            State::Sending(sender) => sender.wire_written(bytes),
            State::Receiving(receiver) => receiver.wire_written(bytes),
        }
    }

    pub fn submit_file(&mut self, data: &[u8]) -> Result<(), ZmodemEngineError> {
        match &mut self.state {
            State::Sending(sender) => Ok(sender.submit_file(data)?),
            State::Receiving(_) => Err(ZmodemEngineError::WrongRole),
        }
    }

    pub fn file_written(&mut self, bytes: usize) -> Result<(), ZmodemEngineError> {
        match &mut self.state {
            State::Receiving(receiver) => Ok(receiver.file_written(bytes)?),
            State::Sending(_) => Err(ZmodemEngineError::WrongRole),
        }
    }

    /// Requires an already validated, user-selected local file.
    pub fn start_file(&mut self, name: &str, length: u64) -> Result<(), ZmodemEngineError> {
        safe_filename(name.as_bytes())?;
        let size = u32::try_from(length).map_err(|_| ZmodemEngineError::FileTooLarge)?;
        match &mut self.state {
            State::Sending(sender) =>
                Ok(sender.start_file(FileInfo::new(name.as_bytes(), Some(Position::new(size))))?),
            State::Receiving(_) => Err(ZmodemEngineError::WrongRole),
        }
    }

    /// Accept a safely named file after the client has created a new local
    /// temporary target with create_new; never overwrite existing files.
    pub fn accept_received_file(&mut self) -> Result<(), ZmodemEngineError> {
        match &mut self.state {
            State::Receiving(receiver) => Ok(receiver.accept_file_at(0)?),
            State::Sending(_) => Err(ZmodemEngineError::WrongRole),
        }
    }

    pub fn skip_received_file(&mut self) -> Result<(), ZmodemEngineError> {
        match &mut self.state {
            State::Receiving(receiver) => Ok(receiver.skip_file()?),
            State::Sending(_) => Err(ZmodemEngineError::WrongRole),
        }
    }

    pub fn finish(&mut self) -> Result<(), ZmodemEngineError> {
        match &mut self.state {
            State::Sending(sender) => Ok(sender.finish()?),
            State::Receiving(_) => Err(ZmodemEngineError::WrongRole),
        }
    }

    pub fn timeout(&mut self) -> Result<(), ZmodemEngineError> {
        match &mut self.state {
            State::Sending(sender) => Ok(sender.timeout()?),
            State::Receiving(receiver) => Ok(receiver.timeout()?),
        }
    }

    pub fn abort(&mut self) -> Result<(), ZmodemEngineError> {
        match &mut self.state {
            State::Sending(sender) => { sender.abort(); Ok(()) }
            State::Receiving(receiver) => Ok(receiver.abort()?),
        }
    }
}

/// Allow a plain basename only, not a path supplied by an untrusted server.
/// The caller must separately check for collisions and Windows reparse points.
pub fn safe_filename(raw: &[u8]) -> Result<String, ZmodemEngineError> {
    let name = std::str::from_utf8(raw).map_err(|_| ZmodemEngineError::UnsafeName)?;
    if name.is_empty() || name.len() > 255 || matches!(name, "." | "..")
        || name.starts_with('.') && name.ends_with(".zmodem-part")
        || name.ends_with(' ') || name.ends_with('.')
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err(ZmodemEngineError::UnsafeName);
    }
    let basename = name.split('.').next().unwrap_or_default().trim_end();
    let device = basename.as_bytes();
    let serial_device = device.len() == 4
        && (device[..3].eq_ignore_ascii_case(b"COM")
            || device[..3].eq_ignore_ascii_case(b"LPT"))
        && (b'1'..=b'9').contains(&device[3]);
    if ["CON", "PRN", "AUX", "NUL"].iter().any(|x| basename.eq_ignore_ascii_case(x))
        || serial_device
    {
        return Err(ZmodemEngineError::UnsafeName);
    }
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_remote_filenames_before_any_filesystem_write() {
        for invalid in [
            "", ".", "..", "../secret", "a\\b", "CON", "nul.txt",
            "COM1.log", "LPT9", "bad:name", "trailing.", "trailing ",
            "a\nb",
        ] {
            assert!(safe_filename(invalid.as_bytes()).is_err(), "{invalid}");
        }
        assert_eq!(safe_filename("中文 report.txt".as_bytes()).unwrap(), "中文 report.txt");
        assert_eq!(safe_filename("éé".as_bytes()).unwrap(), "éé");
        assert!(safe_filename(&[0xff, 0xfe]).is_err());
    }

    #[test]
    fn sender_receiver_have_separate_roles_and_emit_handshake_bytes() {
        let mut sender = ZmodemEngine::new(ZmodemRole::Send).unwrap();
        let mut receiver = ZmodemEngine::new(ZmodemRole::Receive).unwrap();
        assert_eq!(sender.role(), ZmodemRole::Send);
        assert_eq!(receiver.role(), ZmodemRole::Receive);
        assert!(matches!(sender.next_action().unwrap(), ZmodemAction::Wire(_)));
        assert!(matches!(receiver.next_action().unwrap(), ZmodemAction::Wire(_)));
        assert!(matches!(sender.accept_received_file(), Err(ZmodemEngineError::WrongRole)));
        assert!(matches!(receiver.start_file("f.txt", 0), Err(ZmodemEngineError::WrongRole)));
        assert!(matches!(sender.start_file("f.txt", u64::from(u32::MAX) + 1),
            Err(ZmodemEngineError::FileTooLarge)));
    }
}
