use std::{sync::Arc, time::Duration};

use russh::{
    client, ChannelMsg,
    keys::{HashAlg, PublicKeyOrCertificate},
};
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
    time::timeout,
};

use crate::session::Session;

#[derive(Debug, Error)]
pub enum SshError {
    #[error("SSH server fingerprint must be an explicitly trusted SHA256 fingerprint")]
    FingerprintRequired,
    #[error("SSH connection timed out")]
    Timeout,
    #[error("SSH authentication failed")]
    AuthenticationFailed,
    #[error(transparent)]
    Protocol(#[from] russh::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

struct HostVerifier {
    expected_fingerprint: String,
}

impl client::Handler for HostVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Host certificates require separate CA, principal, validity, and
        // critical-options validation. Do not silently trust one as a raw key.
        if server_public_key.certificate().is_some() {
            return Ok(false);
        }
        let fingerprint = server_public_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        Ok(fingerprint == self.expected_fingerprint)
    }
}

/// Authenticated SSH connection. Each terminal uses its own session channel.
pub struct SshConnection {
    handle: client::Handle<HostVerifier>,
}

impl SshConnection {
    /// The user must verify the SHA256 fingerprint before this call. Never
    /// use accept-all host key policies even on development servers.
    pub async fn connect_password(
        session: &Session,
        password: &str,
        expected_fingerprint: &str,
    ) -> Result<Self, SshError> {
        if !expected_fingerprint.starts_with("SHA256:") {
            return Err(SshError::FingerprintRequired);
        }
        session.validate().map_err(|_| SshError::AuthenticationFailed)?;
        let config = Arc::new(client::Config::default());
        let address = (session.host.as_str(), session.port);
        let verifier = HostVerifier {
            expected_fingerprint: expected_fingerprint.to_owned(),
        };

        let mut handle = timeout(
            Duration::from_secs(12),
            client::connect(config, address, verifier),
        )
        .await
        .map_err(|_| SshError::Timeout)??;

        let authentication = timeout(
            Duration::from_secs(20),
            handle.authenticate_password(&session.username, password),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        if !authentication.success() {
            return Err(SshError::AuthenticationFailed);
        }

        Ok(Self { handle })
    }

    pub async fn open_terminal(
        &self,
        columns: u32,
        rows: u32,
    ) -> Result<SshTerminal, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_pty(true, "xterm-256color", columns.max(2), rows.max(1), 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;
        Ok(SshTerminal { channel })
    }

    pub async fn disconnect(&self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "OpenShell closed", "en")
            .await?;
        Ok(())
    }
}

/// Commands accepted by one SSH PTY channel. Resize affects the same channel
/// as its I/O, and never requires disconnecting the underlying SSH session.
#[derive(Debug, PartialEq, Eq)]
pub enum SshTerminalCommand {
    Input(Vec<u8>),
    Resize { columns: u32, rows: u32 },
    Close,
}

impl SshTerminalCommand {
    pub fn resize(columns: usize, rows: usize) -> Self {
        Self::Resize {
            columns: columns.clamp(2, u32::MAX as usize) as u32,
            rows: rows.clamp(1, u32::MAX as usize) as u32,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SshTerminalOutcome {
    pub exit_status: Option<u32>,
}

/// Independent, binary-safe channel. Terminal output is bounded by the receiver
/// capacity, so slow rendering propagates backpressure to SSH.
pub struct SshTerminal {
    channel: russh::Channel<client::Msg>,
}

impl SshTerminal {
    /// Full-duplex PTY with window-change handling and an explicit close.
    /// Output and control channels must be bounded at the call site.
    ///
    /// Extended data (stderr) is forwarded as terminal bytes. Closing a
    /// single channel does not disconnect other sessions on the SSH transport.
    pub async fn run_controlled(
        self,
        output: mpsc::Sender<Vec<u8>>,
        mut commands: mpsc::Receiver<SshTerminalCommand>,
    ) -> Result<SshTerminalOutcome, SshError> {
        let (mut reader, writer) = self.channel.split();
        let mut outcome = SshTerminalOutcome::default();

        loop {
            tokio::select! {
                message = reader.wait() => match message {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if !data.is_empty() && output.send(data.to_vec()).await.is_err() {
                            writer.close().await?;
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        outcome.exit_status = Some(exit_status);
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(ChannelMsg::Eof) => {
                        // EOF can precede the exit-status and close messages.
                    }
                    _ => {}
                },
                command = commands.recv() => match command {
                    Some(SshTerminalCommand::Input(bytes)) => {
                        if !bytes.is_empty() {
                            writer.data_bytes(bytes).await?;
                        }
                    }
                    Some(SshTerminalCommand::Resize { columns, rows }) => {
                        writer.window_change(columns.max(2), rows.max(1), 0, 0).await?;
                    }
                    Some(SshTerminalCommand::Close) | None => {
                        writer.close().await?;
                        break;
                    }
                }
            }
        }
        Ok(outcome)
    }

    pub async fn run(
        self,
        output: mpsc::Sender<Vec<u8>>,
        mut input: mpsc::Receiver<Vec<u8>>,
    ) -> Result<(), SshError> {
        let (mut reader, mut writer) = tokio::io::split(self.channel.into_stream());
        let mut buffer = [0_u8; 32 * 1024];
        let mut input_closed = false;

        loop {
            tokio::select! {
                read = reader.read(&mut buffer) => {
                    let count = read?;
                    if count == 0 { break; }
                    if output.send(buffer[..count].to_vec()).await.is_err() { break; }
                }
                packet = input.recv(), if !input_closed => {
                    match packet {
                        Some(bytes) => writer.write_all(&bytes).await?,
                        None => {
                            input_closed = true;
                            writer.shutdown().await?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_commands_are_clamped_before_network_dispatch() {
        assert_eq!(
            SshTerminalCommand::resize(0, 0),
            SshTerminalCommand::Resize { columns: 2, rows: 1 }
        );
        assert_eq!(
            SshTerminalCommand::resize(120, 40),
            SshTerminalCommand::Resize { columns: 120, rows: 40 }
        );
    }

    #[tokio::test]
    async fn rejects_missing_host_fingerprint_without_network() {
        let session = Session {
            id: "1".into(), name: "test".into(),
            host: "invalid.example".into(), port: 22, username: "user".into(),
        };
        let err = SshConnection::connect_password(&session, "secret", "")
            .await.err().expect("should reject");
        assert!(matches!(err, SshError::FingerprintRequired));
    }
}
