//! SSH PTY + real lrzsz end-to-end acceptance against an ephemeral localhost
//! sshd. Requires explicit host-key fingerprint and temporary test credentials.
//! No credentials or ZMODEM file contents are printed.

use std::{env, error::Error, path::PathBuf, time::Duration};
use openshell_core::{
    Session, SshConnection, SshTerminalCommand,
    ssh::ZmodemTransferStatus,
    zmodem::{ZmodemProbe, ZmodemRequest},
};
use tokio::{sync::mpsc, time::timeout};

fn required(name: &str) -> Result<String, Box<dyn Error>> {
    Ok(env::var(name).map_err(|_| format!("missing test setting {name}"))?)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mode = required("OPENSHELL_E2E_MODE")?;
    if !matches!(mode.as_str(), "send" | "receive" | "cancel-receive") {
        return Err("OPENSHELL_E2E_MODE must be send, receive or cancel-receive".into());
    }
    let session = Session {
        id: "ssh-zmodem-e2e".into(),
        name: "Ephemeral localhost CI test".into(),
        host: required("OPENSHELL_SSH_TEST_HOST")?,
        port: required("OPENSHELL_SSH_TEST_PORT")?.parse()?,
        username: required("OPENSHELL_SSH_TEST_USER")?,
    };
    let password = required("OPENSHELL_SSH_TEST_PASSWORD")?;
    let fingerprint = required("OPENSHELL_SSH_TEST_FINGERPRINT")?;
    let input_path = PathBuf::from(required("OPENSHELL_E2E_PATH")?);
    let connection = SshConnection::connect_password(&session, &password, &fingerprint).await?;
    drop(password);
    let terminal = connection.open_terminal(100, 30).await?;

    let (commands, command_rx) = mpsc::channel(64);
    let (output_tx, mut output_rx) = mpsc::channel(64);
    let (progress_tx, mut progress_rx) = mpsc::channel(64);
    let worker = tokio::spawn(async move {
        terminal.run_controlled(output_tx, command_rx, progress_tx).await
    });

    // stty -echo prevents the shell's echoed input from forging a successful
    // post-transfer marker. The commands execute in a real authenticated PTY.
    let remote_command: &[u8] = if mode == "send" {
        b"stty -echo; rz -q\r"
    } else if mode == "cancel-receive" {
        b"stty -echo; sz -q large-from-sz.bin\r"
    } else {
        b"stty -echo; sz -q from-sz.bin\r"
    };
    commands.send(SshTerminalCommand::Input(remote_command.to_vec())).await?;

    let expected_request = if mode == "send" {
        ZmodemRequest::Send
    } else {
        ZmodemRequest::Receive
    };
    let mut probe = ZmodemProbe::default();
    let mut started = false;
    let mut completed = false;
    let marker = b"OPENSHELL_ZMODEM_SSH_POST_TRANSFER_OK";
    let mut recent_output = Vec::new();
    let mut initial_output = Vec::new();
    let mut progress_events = 0_usize;
    let mut cancel_sent = false;

    let test_result = timeout(Duration::from_secs(45), async {
        loop {
            tokio::select! {
                data = output_rx.recv() => {
                    let bytes = data.ok_or("SSH output closed before completion")?;
                    if !started {
                        if initial_output.len() < 192 {
                            initial_output.extend_from_slice(
                                &bytes[..bytes.len().min(192 - initial_output.len())]
                            );
                        }
                    }
                    if !started && probe.feed(&bytes) == Some(expected_request) {
                        eprintln!("SSH test observed a validated remote ZMODEM startup header");
                        let request = if mode == "send" {
                            SshTerminalCommand::ZmodemUpload(input_path.clone())
                        } else {
                            SshTerminalCommand::ZmodemDownload(input_path.clone())
                        };
                        commands.send(request).await?;
                        started = true;
                    }
                    if completed {
                        recent_output.extend_from_slice(&bytes);
                        if recent_output.windows(marker.len()).any(|window| window == marker) {
                            return Ok::<(), Box<dyn Error>>(());
                        }
                        if recent_output.len() > 16384 {
                            let tail = recent_output.split_off(recent_output.len() - 512);
                            recent_output = tail;
                        }
                    }
                }
                state = progress_rx.recv() => {
                    progress_events += 1;
                    match state.ok_or("SSH ZMODEM event channel closed")? {
                        ZmodemTransferStatus::Started { uploading } =>
                            eprintln!("SSH test transfer started: uploading={uploading}"),
                        ZmodemTransferStatus::Progress { bytes, .. } if mode == "cancel-receive" && !cancel_sent && bytes >= 256 * 1024 => {
                            cancel_sent = true;
                            commands.send(SshTerminalCommand::CancelZmodem).await?;
                            eprintln!("SSH test requested cancellation after {bytes} bytes");
                        }
                        ZmodemTransferStatus::Progress { .. } => {}
                        ZmodemTransferStatus::Skipped { name } =>
                            return Err(format!("file was skipped unexpectedly: {name}").into()),
                        ZmodemTransferStatus::Completed { files } => {
                            if mode == "cancel-receive" {
                                return Err("ZMODEM completed instead of cancelling".into());
                            }
                            if files == 0 { return Err("ZMODEM finished without files".into()); }
                            completed = true;
                            eprintln!("SSH test ZMODEM protocol completed: files={files}");
                            // Completion is emitted after queued ZFIN/OO wire bytes
                            // are written, but the remote sz/rz process may not
                            // have exited yet. Avoid racing its final read()
                            // with the next shell command.
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            commands.send(SshTerminalCommand::Input(
                                b"printf 'OPENSHELL_ZMODEM_SSH_POST_TRANSFER_OK\\n'\r".to_vec()
                            )).await?;
                        }
                        ZmodemTransferStatus::Failed(error) =>
                            return Err(format!("ZMODEM failed: {error}").into()),
                        ZmodemTransferStatus::Cancelled if mode == "cancel-receive" && cancel_sent => {
                            completed = true;
                            eprintln!("SSH test ZMODEM cancellation acknowledged");
                            tokio::time::sleep(Duration::from_millis(1000)).await;
                            commands.send(SshTerminalCommand::Input(
                                b"printf 'OPENSHELL_ZMODEM_SSH_POST_TRANSFER_OK\\n'\r".to_vec()
                            )).await?;
                        }
                        ZmodemTransferStatus::Cancelled =>
                            return Err("ZMODEM was cancelled unexpectedly".into()),
                    }
                }
            }
        }
    }).await;

    // Always attempt to close the PTY on failure as well as success.
    if test_result.is_err() {
        eprintln!(
            "SSH test timeout diagnostics: mode={mode}, detected={started},              completed={completed}, events={progress_events}, first_pty_bytes={}",
            initial_output.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
    }
    let _ = commands.send(SshTerminalCommand::Close).await;
    drop(commands);
    let joined = timeout(Duration::from_secs(5), worker).await;
    connection.disconnect().await.ok();
    test_result.map_err(|_| "SSH ZMODEM test timed out")??;
    joined.map_err(|_| "SSH worker failed to stop")???;
    if mode == "cancel-receive" && input_path.join("large-from-sz.bin").exists() {
        return Err("cancelled ZMODEM download left a partial file behind".into());
    }

    println!(
        "PASS real SSH PTY: {} via lrzsz, framed transfer and shell recovery",
        match mode.as_str() {
            "send" => "rz upload",
            "cancel-receive" => "sz download cancellation and shell recovery",
            _ => "sz download",
        }
    );
    Ok(())
}
