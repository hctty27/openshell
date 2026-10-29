//! Native SSH preview transport.
//! - OPENSHELL_SSH_SESSION_ID: native saved session, approved host key and
//!   Windows credential manager password. No secret in the environment.
//! - OPENSHELL_SSH_TEST_HOST: legacy one-off development-only environment
//!   configuration. Must not be used for everyday or production credentials.
//!
//! SSH I/O, SQLite and credential manager access happen off the GUI thread.

use std::{env, thread};

use openshell_core::{
    CredentialVault, HostIdentity, HostTrustStore, Session, SessionStore,
    SshConnection, SshTerminalCommand, TerminalSize,
    native_paths::native_database_path,
};
use tokio::sync::mpsc;
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
}

struct PreviewConfig {
    session: Session,
    password: Zeroizing<String>,
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
        password,
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
    let password = CredentialVault::get(&session.id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "SSH password is missing from Windows Credential Manager".to_owned())?;

    Ok(PreviewConfig {
        session,
        password,
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

    thread::Builder::new()
        .name("openshell-ssh-preview".into())
        .spawn(move || {
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

            let result = runtime.block_on(async {
                let connection = SshConnection::connect_password(
                    &config.session,
                    &config.password,
                    &config.fingerprint,
                )
                .await
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
            });

            let state = match result {
                Ok(exit_code) => PreviewStatus::Finished(exit_code),
                Err(err) => PreviewStatus::Failed(err),
            };
            let _ = status_tx.blocking_send(state);
        })
        .map_err(|err| format!("failed to start SSH worker: {err}"))?;

    Ok(SshPreview { commands, output, status })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_configuration_has_bounded_queues() {
        assert_eq!(MAX_PENDING_PACKETS, 64);
    }
}
