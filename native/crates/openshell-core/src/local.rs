use std::{
    io::{Read, Write},
    sync::mpsc::{self, SyncSender, TrySendError},
    thread,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc as async_mpsc;

use crate::terminal::TerminalSize;

const OUTPUT_QUEUE_CHUNKS: usize = 64;
const INPUT_QUEUE_CHUNKS: usize = 64;
const READ_CHUNK_SIZE: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalShell {
    PowerShell,
    CommandPrompt,
    PowerShell7,
}

impl LocalShell {
    pub fn executable(self) -> &'static str {
        match self {
            Self::PowerShell => "powershell.exe",
            Self::CommandPrompt => "cmd.exe",
            Self::PowerShell7 => "pwsh.exe",
        }
    }
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows.clamp(1, u16::MAX as usize) as u16,
        cols: size.columns.clamp(2, u16::MAX as usize) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Owned Windows ConPTY session. Reader and writer run off the UI thread.
///
/// Output capacity: 64 * 32 KiB. A full queue blocks the reader rather than
/// dropping bytes, and propagates backpressure toward the pseudoterminal.
pub struct LocalTerminal {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
    input: SyncSender<Vec<u8>>,
    output: Option<async_mpsc::Receiver<Vec<u8>>>,
}

impl LocalTerminal {
    pub fn spawn(shell: LocalShell, size: TerminalSize) -> anyhow::Result<Self> {
        let pair = native_pty_system().openpty(pty_size(size))?;
        let child = pair.slave.spawn_command(CommandBuilder::new(shell.executable()))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (output_tx, output_rx) = async_mpsc::channel(OUTPUT_QUEUE_CHUNKS);
        let (input_tx, input_rx) = mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE_CHUNKS);

        thread::Builder::new()
            .name("openshell-conpty-reader".into())
            .spawn(move || {
                let mut buffer = [0_u8; READ_CHUNK_SIZE];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(len) => {
                            if output_tx.blocking_send(buffer[..len].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })?;

        thread::Builder::new()
            .name("openshell-conpty-writer".into())
            .spawn(move || {
                while let Ok(data) = input_rx.recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                }
            })?;

        Ok(Self {
            master: pair.master,
            child,
            input: input_tx,
            output: Some(output_rx),
        })
    }

    pub fn take_output(&mut self) -> Option<async_mpsc::Receiver<Vec<u8>>> {
        self.output.take()
    }

    /// Nonblocking input queue: callers must surface Full/Disconnected errors.
    pub fn try_write(&self, bytes: Vec<u8>) -> Result<(), TrySendError<Vec<u8>>> {
        self.input.try_send(bytes)
    }

    pub fn resize(&self, size: TerminalSize) -> anyhow::Result<()> {
        self.master.resize(pty_size(size))
    }
}

impl Drop for LocalTerminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_names_are_fixed_and_not_user_commands() {
        assert_eq!(LocalShell::PowerShell.executable(), "powershell.exe");
        assert_eq!(LocalShell::CommandPrompt.executable(), "cmd.exe");
        assert_eq!(LocalShell::PowerShell7.executable(), "pwsh.exe");
    }

    #[test]
    fn pty_size_clamps_to_system_limits() {
        let s = pty_size(TerminalSize::new(usize::MAX, usize::MAX));
        assert_eq!(s.rows, u16::MAX);
        assert_eq!(s.cols, u16::MAX);
    }
}
