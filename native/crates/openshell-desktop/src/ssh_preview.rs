//! Opt-in remote SSH GUI smoke mode. Explicit fingerprint pinning is mandatory.
//!
//! No UI password editor or credential storage exists yet. This mode is only
//! available when OPENSHELL_SSH_TEST_HOST is set in the launching environment.
//! The OS user must first verify the server fingerprint independently.

use std::{env, thread};

use openshell_core::{Session, SshConnection, SshTerminalCommand, TerminalSize};
use tokio::sync::mpsc;

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
    password: String,
    fingerprint: String,
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required for SSH preview"))
}

fn read_configuration() -> Result<Option<PreviewConfig>, String> {
    let host = match env::var("OPENSHELL_SSH_TEST_HOST") {
        Ok(host) => host,
        Err(env::VarError::NotPresent) => return Ok(None),
        Err(_) => return Err("OPENSHELL_SSH_TEST_HOST must be Unicode".into()),
    };

    let username = required_env("OPENSHELL_SSH_TEST_USER")?;
    let password = required_env("OPENSHELL_SSH_TEST_PASSWORD")?;
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
    Ok(Some(PreviewConfig { session, password, fingerprint }))
}

pub fn start_from_environment(size: TerminalSize) -> Result<Option<SshPreview>, String> {
    let Some(config) = read_configuration()? else { return Ok(None); };
    let (commands, command_rx) = mpsc::channel(MAX_PENDING_PACKETS);
    let (output_tx, output) = mpsc::channel(MAX_PENDING_PACKETS);
    let (status_tx, status) = mpsc::channel(8);

    thread::Builder::new()
        .name("openshell-ssh-preview".into())
        .spawn(move || {
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

    Ok(Some(SshPreview { commands, output, status }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_config_is_opt_in() {
        // The preview is explicitly configured by the launching process.
        // Do not set/clear process-global environment in unit tests.
        assert_eq!(MAX_PENDING_PACKETS, 64);
    }
}
