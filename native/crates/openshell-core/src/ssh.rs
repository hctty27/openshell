use std::{sync::Arc, time::Duration, path::{Path, PathBuf}, io::SeekFrom};

use russh::{
    client, ChannelMsg,
    keys::{HashAlg, PublicKeyOrCertificate, load_secret_key, key::PrivateKeyWithHashAlg},
};
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, AsyncSeekExt},
    sync::mpsc,
    time::timeout,
};

use crate::{session::Session, zmodem_engine::{ZmodemEngine, ZmodemAction, ZmodemEvent, ZmodemRole, ZmodemEngineError, MAX_FILE_IO_CHUNK, safe_filename}};

#[derive(Debug, Error)]
pub enum SshError {
    #[error("SSH server fingerprint must be an explicitly trusted SHA256 fingerprint")]
    FingerprintRequired,
    #[error("SSH connection timed out")]
    Timeout,
    #[error("SSH authentication failed")]
    AuthenticationFailed,
    #[error("Private key cannot be loaded (file missing, malformed, or passphrase protected)")]
    PrivateKeyUnavailable,
    #[error(transparent)]
    Protocol(#[from] russh::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Zmodem(#[from] ZmodemEngineError),
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

    /// Authenticate with a local unencrypted OpenSSH key. The key bytes are
    /// never persisted to SQLite or passed to GPUI. Host fingerprint pinning
    /// is identical to password login; unknown and changed hosts are rejected.
    pub async fn connect_private_key(
        session: &Session,
        key_path: &Path,
        expected_fingerprint: &str,
    ) -> Result<Self, SshError> {
        if !expected_fingerprint.starts_with("SHA256:") {
            return Err(SshError::FingerprintRequired);
        }
        session.validate().map_err(|_| SshError::AuthenticationFailed)?;
        let private_key = load_secret_key(key_path, None)
            .map_err(|_| SshError::PrivateKeyUnavailable)?;
        let config = Arc::new(client::Config::default());
        let verifier = HostVerifier {
            expected_fingerprint: expected_fingerprint.to_owned(),
        };
        let mut handle = timeout(
            Duration::from_secs(12),
            client::connect(config, (session.host.as_str(), session.port), verifier),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        let hash_algorithm = handle.best_supported_rsa_hash().await?.flatten();
        let auth = timeout(
            Duration::from_secs(20),
            handle.authenticate_publickey(
                &session.username,
                PrivateKeyWithHashAlg::new(Arc::new(private_key), hash_algorithm),
            ),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        if !auth.success() { return Err(SshError::AuthenticationFailed); }
        Ok(Self { handle })
    }

    /// Open a separate SSH session channel for the SFTP subsystem.
    /// The PTY channel is not modified or replaced.
    pub async fn open_sftp_channel(&self) -> Result<russh::Channel<client::Msg>, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(channel)
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
    ZmodemUpload(PathBuf),
    ZmodemDownload(PathBuf),
    CancelZmodem,
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


/// One ZMODEM sender bound to the *existing* PTY channel. The terminal and
/// SFTP are never allowed to read this channel while it owns the binary flow.
struct ZmodemUpload {
    protocol: ZmodemEngine,
    file: tokio::fs::File,
    file_name: String,
    file_size: u64,
    file_started: bool,
    finish_requested: bool,
    pending: Vec<u8>,
    timeouts: u8,
}

impl ZmodemUpload {
    async fn open(path: PathBuf) -> Result<Self, SshError> {
        let file = tokio::fs::File::open(&path).await?;
        let stat = file.metadata().await?;
        if !stat.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput, "ZMODEM source must be a regular file",
            ).into());
        }
        if stat.len() > u32::MAX as u64 {
            return Err(ZmodemEngineError::FileTooLarge.into());
        }
        let name = path.file_name().and_then(|name| name.to_str())
            .ok_or(ZmodemEngineError::UnsafeName)?;
        let name = safe_filename(name.as_bytes())?;
        Ok(Self {
            protocol: ZmodemEngine::new(ZmodemRole::Send)?,
            file, file_name: name, file_size: stat.len(),
            file_started: false, finish_requested: false,
            pending: Vec::new(), timeouts: 0,
        })
    }
}



async fn create_received_target(
    directory: &Path,
    basename: &str,
) -> Result<(PathBuf, tokio::fs::File), std::io::Error> {
    let path = directory.join(basename);
    let file = tokio::fs::OpenOptions::new()
        .write(true).create_new(true).open(&path).await?;
    Ok((path, file))
}

struct ZmodemReceivedFile {
    path: PathBuf,
    file: tokio::fs::File,
    expected: Option<u32>,
    written: u64,
    name: String,
}

/// One receiver on a dedicated, user-selected destination directory.
/// Paths advertised by remote sz are validated as basenames; a collision
/// is skipped, never overwritten or truncated.
struct ZmodemDownload {
    protocol: ZmodemEngine,
    directory: PathBuf,
    current: Option<ZmodemReceivedFile>,
    pending: Vec<u8>,
    timeouts: u8,
    completed: usize,
}

impl ZmodemDownload {
    async fn open(directory: PathBuf) -> Result<Self, SshError> {
        let directory = tokio::fs::canonicalize(directory).await?;
        if !tokio::fs::metadata(&directory).await?.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ZMODEM download destination must be a directory",
            ).into());
        }
        Ok(Self {
            protocol: ZmodemEngine::new(ZmodemRole::Receive)?,
            directory, current: None, pending: Vec::new(),
            timeouts: 0, completed: 0,
        })
    }

    async fn offer(&mut self, name: String, size: Option<u32>) -> Result<bool, SshError> {
        // No paths, alternate data streams, device names or control chars.
        let basename = safe_filename(name.as_bytes())?;
        if self.current.is_some() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData, "received nested ZFILE",
            ).into());
        }
        // Atomic no-overwrite prevents a pre-existing file being corrupted.
        match create_received_target(&self.directory, &basename).await {
            Ok((path, file)) => {
                self.current = Some(ZmodemReceivedFile {
                    path, file, expected: size, written: 0, name: basename,
                });
                self.protocol.accept_received_file()?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.protocol.skip_received_file()?;
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<u64, SshError> {
        let file = self.current.as_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "ZMODEM data without ZFILE")
        })?;
        let length = file.written + bytes.len() as u64;
        if length > u32::MAX as u64 || file.expected.is_some_and(|size| length > u64::from(size)) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData, "ZMODEM download exceeded declared file size",
            ).into());
        }
        file.file.write_all(bytes).await?;
        file.written = length;
        self.protocol.file_written(bytes.len())?;
        Ok(length)
    }

    async fn finish_file(&mut self) -> Result<Option<(String, u64)>, SshError> {
        let Some(mut file) = self.current.take() else { return Ok(None) };
        let complete = file.expected.is_none_or(|n| u64::from(n) == file.written);
        if !complete {
            drop(file.file);
            let _ = tokio::fs::remove_file(&file.path).await;
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof, "incomplete ZMODEM file",
            ).into());
        }
        if let Err(error) = file.file.sync_all().await {
            drop(file.file);
            let _ = tokio::fs::remove_file(&file.path).await;
            return Err(error.into());
        }
        drop(file.file);
        self.completed += 1;
        Ok(Some((file.name, file.written)))
    }

    async fn clean_partial(&mut self) {
        if let Some(file) = self.current.take() {
            let path = file.path.clone();
            drop(file.file);
            let _ = tokio::fs::remove_file(path).await;
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
        let mut upload: Option<ZmodemUpload> = None;
        let mut download: Option<ZmodemDownload> = None;

        loop {
            // Drain engine actions before reading more SSH packets. This
            // prevents concurrent terminal rendering from stealing binary
            // ZMODEM bytes and bounds pending data during backpressure.
            let mut completed = false;
            let mut failed: Option<String> = None;
            if let Some(active) = upload.as_mut() {
                for _ in 0..128 {
                    if !active.pending.is_empty() {
                        match active.protocol.submit_wire(&active.pending) {
                            Ok(consumed) if consumed > 0 => {
                                active.pending.drain(..consumed);
                                active.timeouts = 0;
                            }
                            Ok(_) => {}
                            Err(error) => {
                                failed = Some(error.to_string());
                                break;
                            }
                        }
                    }
                    if !active.file_started {
                        match active.protocol.start_file(&active.file_name, active.file_size) {
                            Ok(()) => active.file_started = true,
                            Err(ZmodemEngineError::Protocol(zmodem2::Error::Backpressure)) => {}
                            Err(error) => {
                                failed = Some(error.to_string());
                                break;
                            }
                        }
                    }
                    if active.finish_requested {
                        match active.protocol.finish() {
                            Ok(()) => active.finish_requested = false,
                            Err(ZmodemEngineError::Protocol(zmodem2::Error::Backpressure)) => {}
                            Err(error) => {
                                failed = Some(error.to_string());
                                break;
                            }
                        }
                    }

                    let action = match active.protocol.next_action() {
                        Ok(action) => action,
                        Err(error) => {
                            failed = Some(error.to_string());
                            break;
                        }
                    };
                    let result: Result<(), SshError> = async { match action {
                        ZmodemAction::Wire(bytes) => {
                            let count = bytes.len();
                            writer.data_bytes(bytes).await?;
                            active.protocol.wire_written(count);
                            Ok(())
                        }
                        ZmodemAction::ReadFile { offset, max_len } => {
                            let mut data = vec![0_u8; max_len.min(MAX_FILE_IO_CHUNK)];
                            active.file.seek(SeekFrom::Start(u64::from(offset))).await?;
                            let count = active.file.read(&mut data).await?;
                            if count == 0 {
                                Err(std::io::Error::new(
                                    std::io::ErrorKind::UnexpectedEof,
                                    "ZMODEM source file changed during transfer",
                                ).into())
                            } else {
                                active.protocol.submit_file(&data[..count])?;
                                Ok(())
                            }
                        }
                        ZmodemAction::Event(ZmodemEvent::FileCompleted) => {
                            active.finish_requested = true;
                            Ok(())
                        }
                        ZmodemAction::Event(ZmodemEvent::SessionCompleted) => {
                            completed = true;
                            Ok(())
                        }
                        ZmodemAction::Event(ZmodemEvent::Aborted) => {
                            failed = Some("remote cancelled the transfer".into());
                            Ok(())
                        }
                        ZmodemAction::Event(_) => Ok(()),
                        ZmodemAction::WriteFile(_) => {
                            Err(ZmodemEngineError::WrongRole.into())
                        }
                        ZmodemAction::Idle => break,
                    } }.await;
                    if let Err(error) = result {
                        failed = Some(error.to_string());
                        break;
                    }
                    if completed || failed.is_some() { break; }
                }
            }
            if completed {
                upload = None;
                let _ = output.send(b"\r\n[OpenShell] ZMODEM upload complete\r\n".to_vec()).await;
            } else if let Some(error) = failed {
                if let Some(mut transfer) = upload.take() {
                    let _ = transfer.protocol.abort();
                    for _ in 0..4 {
                        let Ok(ZmodemAction::Wire(bytes)) = transfer.protocol.next_action() else {
                            break;
                        };
                        let count = bytes.len();
                        writer.data_bytes(bytes).await?;
                        transfer.protocol.wire_written(count);
                    }
                }
                let message = format!("\r\n[OpenShell] ZMODEM upload failed: {error}\r\n");
                let _ = output.send(message.into_bytes()).await;
            }


            // ZMODEM receiver is the sole consumer of remote bytes during
            // an active sz download. Never forward protocol frames to the
            // terminal renderer.
            let mut receiver_completed = false;
            let mut receiver_error: Option<String> = None;
            if let Some(active) = download.as_mut() {
                for _ in 0..128 {
                    if !active.pending.is_empty() {
                        match active.protocol.submit_wire(&active.pending) {
                            Ok(count) if count > 0 => {
                                active.pending.drain(..count);
                                active.timeouts = 0;
                            }
                            Ok(_) => {}
                            Err(error) => {
                                receiver_error = Some(error.to_string());
                                break;
                            }
                        }
                    }
                    let action = match active.protocol.next_action() {
                        Ok(action) => action,
                        Err(error) => {
                            receiver_error = Some(error.to_string());
                            break;
                        }
                    };
                    let outcome: Result<(), SshError> = async { match action {
                        ZmodemAction::Wire(bytes) => {
                            let count = bytes.len();
                            writer.data_bytes(bytes).await?;
                            active.protocol.wire_written(count);
                            Ok(())
                        }
                        ZmodemAction::Event(ZmodemEvent::OfferedFile { name, size }) => {
                            let accepted = active.offer(name, size).await?;
                            if !accepted {
                                let _ = output.try_send(
                                    b"\r\n[OpenShell] Skipped existing ZMODEM file\r\n".to_vec(),
                                );
                            }
                            Ok(())
                        }
                        ZmodemAction::WriteFile(bytes) => {
                            let previous = active.current.as_ref().map_or(0, |file| file.written);
                            let written = active.write(&bytes).await?;
                            if written / (1024 * 1024) > previous / (1024 * 1024) {
                                let _ = output.try_send(format!(
                                    "\r\n[OpenShell] ZMODEM received {} MiB\r\n",
                                    written / (1024 * 1024),
                                ).into_bytes());
                            }
                            Ok(())
                        }
                        ZmodemAction::Event(ZmodemEvent::FileCompleted) => {
                            if let Some((name, size)) = active.finish_file().await? {
                                let _ = output.try_send(format!(
                                    "\r\n[OpenShell] Downloaded {name} ({size} bytes)\r\n"
                                ).into_bytes());
                            }
                            Ok(())
                        }
                        ZmodemAction::Event(ZmodemEvent::SessionCompleted) => {
                            if active.current.is_some() {
                                receiver_error = Some(
                                    "ZMODEM session ended with a partial file".into(),
                                );
                            } else {
                                receiver_completed = true;
                            }
                            Ok(())
                        }
                        ZmodemAction::Event(ZmodemEvent::Aborted) => {
                            receiver_error = Some("remote aborted ZMODEM download".into());
                            Ok(())
                        }
                        ZmodemAction::Event(_) => Ok(()),
                        ZmodemAction::ReadFile { .. } => {
                            Err(ZmodemEngineError::WrongRole.into())
                        }
                        ZmodemAction::Idle => break,
                    } }.await;
                    if let Err(error) = outcome {
                        receiver_error = Some(error.to_string());
                        break;
                    }
                    if receiver_completed || receiver_error.is_some() { break; }
                }
            }
            if receiver_completed {
                if let Some(active) = download.take() {
                    let _ = output.send(format!(
                        "\r\n[OpenShell] ZMODEM download complete ({} file(s))\r\n",
                        active.completed,
                    ).into_bytes()).await;
                }
            } else if let Some(error) = receiver_error {
                if let Some(mut active) = download.take() {
                    let _ = active.protocol.abort();
                    active.clean_partial().await;
                    for _ in 0..4 {
                        let Ok(ZmodemAction::Wire(bytes)) = active.protocol.next_action() else {
                            break;
                        };
                        let len = bytes.len();
                        writer.data_bytes(bytes).await?;
                        active.protocol.wire_written(len);
                    }
                }
                let _ = output.send(format!(
                    "\r\n[OpenShell] ZMODEM download failed: {error}\r\n"
                ).into_bytes()).await;
            }

            tokio::select! {
                message = reader.wait() => match message {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if let Some(active) = download.as_mut() {
                            if !data.is_empty() { active.timeouts = 0; }
                            if active.pending.len().saturating_add(data.len()) > 256 * 1024 {
                                active.clean_partial().await;
                                let _ = active.protocol.abort();
                                download = None;
                                let _ = output.send(
                                    b"\r\n[OpenShell] ZMODEM receive buffer limit exceeded\r\n".to_vec()
                                ).await;
                            } else {
                                active.pending.extend_from_slice(&data);
                            }
                        } else if let Some(active) = upload.as_mut() {
                            if active.pending.len().saturating_add(data.len()) > 256 * 1024 {
                                let _ = active.protocol.abort();
                                upload = None;
                                let _ = output.send(
                                    b"\r\n[OpenShell] ZMODEM buffer limit exceeded; transfer cancelled\r\n".to_vec(),
                                ).await;
                            } else {
                                active.pending.extend_from_slice(&data);
                            }
                        } else if !data.is_empty() && output.send(data.to_vec()).await.is_err() {
                            writer.close().await?;
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        outcome.exit_status = Some(exit_status);
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(ChannelMsg::Eof) => {}
                    _ => {}
                },
                command = commands.recv() => match command {
                    Some(SshTerminalCommand::Input(bytes)) if upload.is_none() && download.is_none() => {
                        if !bytes.is_empty() {
                            writer.data_bytes(bytes).await?;
                        }
                    }
                    Some(SshTerminalCommand::Input(_)) => {
                        // Do not inject keyboard/paste bytes into active ZMODEM.
                    }
                    Some(SshTerminalCommand::Resize { columns, rows }) => {
                        writer.window_change(columns.max(2), rows.max(1), 0, 0).await?;
                    }
                    Some(SshTerminalCommand::ZmodemUpload(path)) if upload.is_none() && download.is_none() => {
                        match ZmodemUpload::open(path).await {
                            Ok(active) => {
                                upload = Some(active);
                                let _ = output.send(
                                    b"\r\n[OpenShell] Starting ZMODEM upload...\r\n".to_vec(),
                                ).await;
                            }
                            Err(error) => {
                                let _ = output.send(format!(
                                    "\r\n[OpenShell] Cannot start ZMODEM: {error}\r\n"
                                ).into_bytes()).await;
                            }
                        }
                    }
                    Some(SshTerminalCommand::ZmodemUpload(_)) => {}
                    Some(SshTerminalCommand::ZmodemDownload(directory)) if upload.is_none() && download.is_none() => {
                        match ZmodemDownload::open(directory).await {
                            Ok(active) => {
                                download = Some(active);
                                let _ = output.send(
                                    b"\r\n[OpenShell] Receiving ZMODEM into selected directory...\r\n".to_vec(),
                                ).await;
                            }
                            Err(error) => {
                                let _ = output.send(format!(
                                    "\r\n[OpenShell] Cannot start ZMODEM download: {error}\r\n"
                                ).into_bytes()).await;
                            }
                        }
                    }
                    Some(SshTerminalCommand::ZmodemDownload(_)) => {}
                    Some(SshTerminalCommand::CancelZmodem) => {
                        if let Some(mut active) = download.take() {
                            let _ = active.protocol.abort();
                            active.clean_partial().await;
                            for _ in 0..4 {
                                let Ok(ZmodemAction::Wire(bytes)) = active.protocol.next_action() else { break };
                                let len = bytes.len();
                                writer.data_bytes(bytes).await?;
                                active.protocol.wire_written(len);
                            }
                            let _ = output.send(
                                b"\r\n[OpenShell] ZMODEM download cancelled\r\n".to_vec(),
                            ).await;
                        }
                        if let Some(mut active) = upload.take() {
                            let _ = active.protocol.abort();
                            for _ in 0..4 {
                                let Ok(ZmodemAction::Wire(bytes)) = active.protocol.next_action() else { break; };
                                let count = bytes.len();
                                writer.data_bytes(bytes).await?;
                                active.protocol.wire_written(count);
                            }
                            let _ = output.send(
                                b"\r\n[OpenShell] ZMODEM upload cancelled\r\n".to_vec(),
                            ).await;
                        }
                    }
                    Some(SshTerminalCommand::Close) | None => {
                        if let Some(mut active) = download.take() {
                            let _ = active.protocol.abort();
                            active.clean_partial().await;
                        }
                        if let Some(mut active) = upload.take() {
                            let _ = active.protocol.abort();
                        }
                        writer.close().await?;
                        break;
                    }
                },
                _ = tokio::time::sleep(Duration::from_secs(12)), if download.is_some() => {
                    if let Some(active) = download.as_mut() {
                        active.timeouts = active.timeouts.saturating_add(1);
                        if active.timeouts > 5 {
                            let _ = active.protocol.abort();
                            active.clean_partial().await;
                            download = None;
                            let _ = output.send(
                                b"\r\n[OpenShell] ZMODEM receive timed out\r\n".to_vec(),
                            ).await;
                        } else if let Err(error) = active.protocol.timeout() {
                            active.clean_partial().await;
                            download = None;
                            let _ = output.send(format!(
                                "\r\n[OpenShell] ZMODEM receive timeout: {error}\r\n"
                            ).into_bytes()).await;
                        }
                    }
                },
                _ = tokio::time::sleep(Duration::from_secs(12)), if upload.is_some() => {
                    if let Some(active) = upload.as_mut() {
                        active.timeouts += 1;
                        if active.timeouts > 5 {
                            upload = None;
                            let _ = output.send(
                                b"\r\n[OpenShell] ZMODEM upload timed out\r\n".to_vec(),
                            ).await;
                        } else if let Err(error) = active.protocol.timeout() {
                            upload = None;
                            let _ = output.send(format!(
                                "\r\n[OpenShell] ZMODEM timeout error: {error}\r\n",
                            ).into_bytes()).await;
                        }
                    }
                }
            }
        }
        if let Some(mut active) = download.take() {
            active.clean_partial().await;
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

    #[tokio::test]
    async fn download_target_creation_never_overwrites_existing_content() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("日志.txt");
        tokio::fs::write(&output, b"existing user data").await.unwrap();
        let error = create_received_target(temp.path(), "日志.txt")
            .await.err().unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"existing user data");

        let (path, mut file) = create_received_target(temp.path(), "new.txt")
            .await.unwrap();
        file.write_all(b"partial").await.unwrap();
        drop(file);
        tokio::fs::remove_file(&path).await.unwrap();
        assert!(!path.exists());
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"existing user data");
    }

    #[tokio::test]
    async fn receiver_removes_only_its_partial_file_on_abort() {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().join("existing.txt");
        tokio::fs::write(&existing, b"important").await.unwrap();
        let mut receiving = ZmodemDownload::open(temp.path().to_path_buf()).await.unwrap();
        let (path, mut file) = create_received_target(temp.path(), "incomplete.bin")
            .await.unwrap();
        file.write_all(b"partial transfer").await.unwrap();
        receiving.current = Some(ZmodemReceivedFile {
            path: path.clone(), file, expected: Some(1000),
            written: 16, name: "incomplete.bin".into(),
        });
        receiving.clean_partial().await;
        assert!(!path.exists());
        assert_eq!(tokio::fs::read(&existing).await.unwrap(), b"important");
    }

    #[tokio::test]
    async fn mismatched_zmodem_size_discards_incomplete_file() {
        let temp = tempfile::tempdir().unwrap();
        let mut receiving = ZmodemDownload::open(temp.path().to_path_buf()).await.unwrap();
        let (path, file) = create_received_target(temp.path(), "truncated.bin")
            .await.unwrap();
        receiving.current = Some(ZmodemReceivedFile {
            path: path.clone(), file, expected: Some(100),
            written: 0, name: "truncated.bin".into(),
        });
        assert!(receiving.finish_file().await.is_err());
        assert!(!path.exists());
    }

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
    async fn private_key_auth_rejects_unknown_host_before_reading_file() {
        let session = Session {
            id: "private-key".into(), name: "Key".into(),
            host: "invalid.example".into(), port: 22, username: "deploy".into(),
        };
        let err = SshConnection::connect_private_key(
            &session, Path::new("/missing/key"), "",
        ).await.err().unwrap();
        assert!(matches!(err, SshError::FingerprintRequired));
    }

    #[tokio::test]
    async fn private_key_auth_fails_closed_when_file_missing() {
        let session = Session {
            id: "private-key".into(), name: "Key".into(),
            host: "invalid.example".into(), port: 22, username: "deploy".into(),
        };
        let err = SshConnection::connect_private_key(
            &session, Path::new("/missing/key"), "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ).await.err().unwrap();
        assert!(matches!(err, SshError::PrivateKeyUnavailable));
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
