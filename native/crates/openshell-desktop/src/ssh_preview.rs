//! Native SSH preview transport.
//! - OPENSHELL_SSH_SESSION_ID: native saved session, approved host key and
//!   Windows credential manager password. No secret in the environment.
//! - OPENSHELL_SSH_TEST_HOST: legacy one-off development-only environment
//!   configuration. Must not be used for everyday or production credentials.
//!
//! SSH I/O, SQLite and credential manager access happen off the GUI thread.

use std::{env, thread, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}};

use openshell_core::{
    CredentialVault, HostIdentity, HostTrustStore, Session, SessionStore, SessionKeyStore,
    SshConnection, SshTerminalCommand, TerminalSize, NativeSftp, SftpEntry,
    native_paths::native_database_path,
};
use tokio::sync::{mpsc, oneshot, watch};
use zeroize::Zeroizing;

const MAX_PENDING_PACKETS: usize = 64;

#[derive(Debug)]
pub enum PreviewStatus {
    Connected,
    Finished(Option<u32>),
    Failed(String),
}

pub struct SshPreview {
    pub commands: mpsc::Sender<SshTerminalCommand>,
    pub output: mpsc::Receiver<Vec<u8>>,
    pub status: mpsc::Receiver<PreviewStatus>,
    pub cancel: watch::Sender<bool>,
}

impl Drop for SshPreview {
    fn drop(&mut self) {
        // GPUI tasks are cancelled by dropping their handles; also interrupt
        // the worker's SSH handshake rather than leaving its OS thread alive.
        let _ = self.cancel.send(true);
    }
}

async fn wait_for_cancel(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() { return; }
    while cancel.changed().await.is_ok() {
        if *cancel.borrow_and_update() { return; }
    }
}

enum PreviewAuth {
    Password(Zeroizing<String>),
    PrivateKey(PathBuf),
}

struct PreviewConfig {
    session: Session,
    auth: PreviewAuth,
    fingerprint: String,
}

enum PreviewSource {
    StoredSession(String),
    Development(PreviewConfig),
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required for SSH preview"))
}

fn read_source() -> Result<Option<PreviewSource>, String> {
    let stored_id = env::var("OPENSHELL_SSH_SESSION_ID").ok();
    let dev_host = env::var("OPENSHELL_SSH_TEST_HOST").ok();
    if stored_id.is_some() && dev_host.is_some() {
        return Err(
            "configure either OPENSHELL_SSH_SESSION_ID or OPENSHELL_SSH_TEST_HOST, not both"
                .into(),
        );
    }
    if let Some(id) = stored_id {
        if id.trim().is_empty() {
            return Err("OPENSHELL_SSH_SESSION_ID cannot be empty".into());
        }
        return Ok(Some(PreviewSource::StoredSession(id)));
    }

    let host = match dev_host {
        Some(host) => host,
        None => return Ok(None),
    };
    let username = required_env("OPENSHELL_SSH_TEST_USER")?;
    let password = Zeroizing::new(required_env("OPENSHELL_SSH_TEST_PASSWORD")?);
    let fingerprint = required_env("OPENSHELL_SSH_TEST_FINGERPRINT")?;
    if !fingerprint.starts_with("SHA256:") {
        return Err("OPENSHELL_SSH_TEST_FINGERPRINT must be a verified SHA256 fingerprint".into());
    }
    let port = env::var("OPENSHELL_SSH_TEST_PORT")
        .unwrap_or_else(|_| "22".into())
        .parse::<u16>()
        .map_err(|_| "OPENSHELL_SSH_TEST_PORT must be 1..65535".to_owned())?;
    let session = Session {
        id: "manual-ssh-preview".into(),
        name: "SSH test session".into(),
        host,
        port,
        username,
    };
    session.validate().map_err(|err| err.to_string())?;
    Ok(Some(PreviewSource::Development(PreviewConfig {
        session,
        auth: PreviewAuth::Password(password),
        fingerprint,
    })))
}

/// Read saved session metadata and credentials only on the SSH worker thread.
/// A missing or changed host trust record prevents connection.
fn resolve_stored_session(id: &str) -> Result<PreviewConfig, String> {
    let database_path = native_database_path().map_err(|err| err.to_string())?;
    let sessions = SessionStore::open(&database_path).map_err(|err| err.to_string())?;
    let session = sessions.list().map_err(|err| err.to_string())?
        .into_iter()
        .find(|session| session.id == id)
        .ok_or_else(|| "saved SSH session does not exist".to_owned())?;
    let identity = HostIdentity::new(&session.host, session.port)
        .map_err(|err| err.to_string())?;
    let trusted = HostTrustStore::open(&database_path).map_err(|err| err.to_string())?;
    let fingerprint = trusted.trusted_fingerprint(&identity)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "SSH host key has not been explicitly approved".to_owned())?;
    let keys = SessionKeyStore::open(&database_path).map_err(|err| err.to_string())?;
    let auth = match keys.get(&session.id).map_err(|err| err.to_string())? {
        Some(path) => PreviewAuth::PrivateKey(path),
        None => PreviewAuth::Password(
            CredentialVault::get(&session.id)
                .map_err(|err| err.to_string())?
                .ok_or_else(|| "SSH password is missing from Windows Credential Manager".to_owned())?
        ),
    };

    Ok(PreviewConfig {
        session,
        auth,
        fingerprint,
    })
}

/// Start a previously saved session from a GPUI click, without putting a
/// password or host-key fingerprint into the GUI's state.
pub fn start_saved_session(id: String, size: TerminalSize) -> Result<SshPreview, String> {
    if id.is_empty() {
        return Err("saved SSH session ID is required".into());
    }
    start_source(PreviewSource::StoredSession(id), size)
}

pub fn start_from_environment(size: TerminalSize) -> Result<Option<SshPreview>, String> {
    let Some(source) = read_source()? else { return Ok(None); };
    start_source(source, size).map(Some)
}

fn start_source(source: PreviewSource, size: TerminalSize) -> Result<SshPreview, String> {
    let (commands, command_rx) = mpsc::channel(MAX_PENDING_PACKETS);
    let (output_tx, output) = mpsc::channel(MAX_PENDING_PACKETS);
    let (status_tx, status) = mpsc::channel(8);
    let (cancel, mut cancel_rx) = watch::channel(false);

    thread::Builder::new()
        .name("openshell-ssh-preview".into())
        .spawn(move || {
            if *cancel_rx.borrow() { return; }
            let config = match source {
                PreviewSource::StoredSession(id) => resolve_stored_session(&id),
                PreviewSource::Development(config) => Ok(config),
            };
            let config = match config {
                Ok(config) => config,
                Err(error) => {
                    let _ = status_tx.blocking_send(PreviewStatus::Failed(error));
                    return;
                }
            };

            if *cancel_rx.borrow() { return; }
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    let _ = status_tx.blocking_send(PreviewStatus::Failed(err.to_string()));
                    return;
                }
            };

            let ssh_flow = async {
                let connection = match &config.auth {
                    PreviewAuth::Password(password) => {
                        SshConnection::connect_password(
                            &config.session, password, &config.fingerprint,
                        ).await
                    }
                    PreviewAuth::PrivateKey(path) => {
                        SshConnection::connect_private_key(
                            &config.session, path, &config.fingerprint,
                        ).await
                    }
                }
                .map_err(|err| err.to_string())?;

                let terminal = connection
                    .open_terminal(size.columns as u32, size.rows as u32)
                    .await
                    .map_err(|err| err.to_string())?;

                let _ = status_tx.send(PreviewStatus::Connected).await;
                let outcome = terminal
                    .run_controlled(output_tx, command_rx)
                    .await
                    .map_err(|err| err.to_string());

                let _ = connection.disconnect().await;
                outcome.map(|result| result.exit_status)
            };
            let result = runtime.block_on(async {
                tokio::select! {
                    biased;
                    _ = wait_for_cancel(&mut cancel_rx) => Err("SSH connection cancelled".to_owned()),
                    result = ssh_flow => result,
                }
            });

            let state = match result {
                Ok(exit_code) => PreviewStatus::Finished(exit_code),
                Err(err) => PreviewStatus::Failed(err),
            };
            let _ = status_tx.blocking_send(state);
        })
        .map_err(|err| format!("failed to start SSH worker: {err}"))?;

    Ok(SshPreview { commands, output, status, cancel })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_interrupts_a_pending_handshake() {
        let (sender, mut receiver) = watch::channel(false);
        let handshake = async {
            std::future::pending::<()>().await;
        };
        let join = tokio::spawn(async move {
            tokio::select! {
                _ = wait_for_cancel(&mut receiver) => "cancelled",
                _ = handshake => "unexpected connection",
            }
        });
        sender.send(true).unwrap();
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(1), join)
            .await.unwrap().unwrap(), "cancelled");
    }

    #[test]
    fn preview_configuration_has_bounded_queues() {
        assert_eq!(MAX_PENDING_PACKETS, 64);
    }
}


/// A bounded directory-request channel owns one long-lived SFTP connection.
/// It never borrows the interactive terminal's SSH handle or PTY.
#[derive(Clone)]
pub struct SftpBrowseWorker {
    tx: mpsc::Sender<SftpBrowseRequest>,
}

struct SftpBrowseRequest {
    directory: String,
    reply: oneshot::Sender<Result<(String, Vec<SftpEntry>), String>>,
}

impl SftpBrowseWorker {
    /// Every directory change reuses the same authenticated SSH/SFTP channel.
    /// Dropping the last worker sender closes the connection after pending
    /// requests have completed. No credential material leaves the worker thread.
    pub async fn list(&self, directory: String) -> Result<(String, Vec<SftpEntry>), String> {
        let (reply, receive) = oneshot::channel();
        self.tx.send(SftpBrowseRequest { directory, reply })
            .await.map_err(|_| "SFTP browser worker disconnected".to_owned())?;
        receive.await.map_err(|_| "SFTP directory request interrupted".to_owned())?
    }
}

pub fn start_saved_sftp_browser(session_id: String) -> Result<SftpBrowseWorker, String> {
    let (tx, mut requests) = mpsc::channel::<SftpBrowseRequest>(16);
    thread::Builder::new()
        .name("openshell-sftp-browser".into())
        .spawn(move || {
            let result = (|| -> Result<(), String> {
                let config = resolve_stored_session(&session_id)?;
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all().build().map_err(|error| error.to_string())?;
                runtime.block_on(async {
                    let connection = match &config.auth {
                        PreviewAuth::Password(password) =>
                            SshConnection::connect_password(
                                &config.session, password, &config.fingerprint,
                            ).await,
                        PreviewAuth::PrivateKey(path) =>
                            SshConnection::connect_private_key(
                                &config.session, path, &config.fingerprint,
                            ).await,
                    }.map_err(|error| error.to_string())?;
                    let browser = NativeSftp::open(connection).await
                        .map_err(|error| error.to_string())?;
                    while let Some(request) = requests.recv().await {
                        let result = async {
                            let path = browser.session_path(&request.directory).await
                                .map_err(|error| error.to_string())?;
                            let entries = browser.list_entries(&path).await
                                .map_err(|error| error.to_string())?;
                            Ok((path, entries))
                        }.await;
                        let _ = request.reply.send(result);
                    }
                    browser.close().await.map_err(|error| error.to_string())?;
                    Ok(())
                })
            })();

            // Propagate startup/auth errors to any pending or subsequent request
            // instead of leaving a GUI directory picker hanging.
            if let Err(error) = result {
                while let Some(request) = requests.blocking_recv() {
                    let _ = request.reply.send(Err(error.clone()));
                }
            }
        })
        .map_err(|error| format!("cannot launch SFTP browser worker: {error}"))?;
    Ok(SftpBrowseWorker { tx })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SftpTransferDirection { Upload, Download }

#[derive(Debug)]
pub enum SftpTransferEvent {
    Total(u64),
    Progress(u64),
    Completed(Result<u64, String>),
}

/// One transfer per worker, never reusing or disconnecting an interactive PTY.
/// A bounded channel limits queued progress events if the window is obscured.
pub struct SftpTransfer {
    pub events: mpsc::Receiver<SftpTransferEvent>,
    pub cancel: Arc<AtomicBool>,
}

pub fn start_saved_sftp_transfer(
    session_id: String,
    direction: SftpTransferDirection,
    local_path: PathBuf,
    remote_path: String,
) -> Result<SftpTransfer, String> {
    let (sender, events) = mpsc::channel(24);
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = cancel.clone();
    thread::Builder::new().name("openshell-sftp-transfer".into())
        .spawn(move || {
            let result = (|| -> Result<u64, String> {
                if worker_cancel.load(Ordering::Acquire) {
                    return Err("Transfer cancelled".into());
                }
                if direction == SftpTransferDirection::Upload {
                    if let Ok(metadata) = std::fs::metadata(&local_path) {
                        let _ = sender.try_send(SftpTransferEvent::Total(metadata.len()));
                    }
                }
                let config = resolve_stored_session(&session_id)?;
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all().build().map_err(|e| e.to_string())?;
                let progress_sender = sender.clone();
                runtime.block_on(async move {
                    let connection = match &config.auth {
                        PreviewAuth::Password(password) =>
                            SshConnection::connect_password(
                                &config.session, password, &config.fingerprint,
                            ).await,
                        PreviewAuth::PrivateKey(path) =>
                            SshConnection::connect_private_key(
                                &config.session, path, &config.fingerprint,
                            ).await,
                    }.map_err(|e| e.to_string())?;
                    let client = NativeSftp::open(connection).await
                        .map_err(|e| e.to_string())?;
                    let mut last_reported = 0_u64;
                    let mut on_progress = |bytes: u64| {
                        if bytes.saturating_sub(last_reported) >= 256 * 1024 {
                            last_reported = bytes;
                            let _ = progress_sender.try_send(SftpTransferEvent::Progress(bytes));
                        }
                    };
                    let outcome = match direction {
                        SftpTransferDirection::Upload =>
                            client.upload_with_progress(
                                &local_path, &remote_path, &worker_cancel, &mut on_progress,
                            ).await,
                        SftpTransferDirection::Download =>
                            client.download_with_progress(
                                &remote_path, &local_path, &worker_cancel, &mut on_progress,
                            ).await,
                    }.map_err(|e| e.to_string());
                    let _ = client.close().await;
                    outcome
                })
            })();
            let _ = sender.blocking_send(SftpTransferEvent::Completed(result));
        })
        .map_err(|error| format!("cannot create SFTP transfer worker: {error}"))?;
    Ok(SftpTransfer { events, cancel })
}
