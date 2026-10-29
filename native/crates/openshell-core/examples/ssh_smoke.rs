//! Manual SSH transport smoke test for a trusted test server.
//! No credentials are persisted or printed; this example intentionally has no
//! interactive auth prompt or automatic host-key trust behavior.
//!
//! Windows PowerShell:
//!   $env:OPENSHELL_SSH_TEST_HOST="your-trusted-test-server"
//!   $env:OPENSHELL_SSH_TEST_USER="user"
//!   $env:OPENSHELL_SSH_TEST_PASSWORD="temporary-password"
//!   $env:OPENSHELL_SSH_TEST_FINGERPRINT="SHA256:...verified-out-of-band..."
//!   cargo run -p openshell-core --example ssh_smoke
//!   Remove-Item Env:OPENSHELL_SSH_TEST_PASSWORD

use std::{env, error::Error, time::Duration};

use openshell_core::{Session, SshConnection, SshTerminalCommand};
use tokio::{sync::mpsc, time::timeout};

fn required_env(name: &str) -> Result<String, Box<dyn Error>> {
    env::var(name)
        .map_err(|_| format!("missing required environment variable: {name}").into())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let host = required_env("OPENSHELL_SSH_TEST_HOST")?;
    let username = required_env("OPENSHELL_SSH_TEST_USER")?;
    let password = required_env("OPENSHELL_SSH_TEST_PASSWORD")?;
    let fingerprint = required_env("OPENSHELL_SSH_TEST_FINGERPRINT")?;
    let port: u16 = env::var("OPENSHELL_SSH_TEST_PORT")
        .unwrap_or_else(|_| "22".to_owned())
        .parse()?;

    let session = Session {
        id: "ssh-smoke".into(),
        name: "Manual SSH smoke test".into(),
        host,
        port,
        username,
    };

    // The fingerprint must be verified independently beforehand; never accept
    // the first server key silently.
    let connection = SshConnection::connect_password(&session, &password, &fingerprint).await?;
    drop(password);

    let terminal = connection.open_terminal(80, 24).await?;
    let (output_tx, mut output_rx) = mpsc::channel(64);
    let (command_tx, command_rx) = mpsc::channel(64);

    let task = tokio::spawn(async move {
        terminal.run_controlled(output_tx, command_rx).await
    });

    command_tx.send(SshTerminalCommand::resize(100, 30)).await?;
    command_tx.send(SshTerminalCommand::Input(
        b"printf 'OPENSHELL_NATIVE_SSH_SMOKE_OK\\n'\r\nexit\r\n".to_vec()
    )).await?;

    // Exercise the live stream, don't decode it as Base64 and don't log
    // session contents (which could contain sensitive remote shell output).
    let observed = timeout(Duration::from_secs(25), async {
        let mut received = Vec::new();
        while let Some(chunk) = output_rx.recv().await {
            if received.len() + chunk.len() > 256 * 1024 {
                return Err("smoke output exceeded 256 KiB".into());
            }
            received.extend_from_slice(&chunk);
            if received.windows(b"OPENSHELL_NATIVE_SSH_SMOKE_OK".len())
                .any(|segment| segment == b"OPENSHELL_NATIVE_SSH_SMOKE_OK")
            {
                return Ok(());
            }
        }
        Err("SSH channel closed before smoke marker".into())
    }).await;

    // Closing the command channel causes an orderly PTY channel close.
    drop(command_tx);
    if observed.is_err() {
        task.abort();
    }
    let outcome = observed.map_err(|_| "timed out waiting for remote shell output")??;
    println!("SSH connection, pinned host key, PTY input/output and resize: OK");
    let _ = outcome;
    let _ = task.await?;
    connection.disconnect().await?;
    Ok(())
}
