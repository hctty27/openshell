//! Native SFTP transport, separate from the interactive terminal channel.
//! Streaming I/O avoids buffering entire files in the GPUI process.

use std::{path::Path, sync::atomic::{AtomicBool, Ordering}};

use russh_sftp::{
    client::{SftpSession, error::Error as ProtocolError},
    protocol::OpenFlags,
};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::ssh::{SshConnection, SshError};

#[derive(Debug, Error)]
pub enum NativeSftpError {
    #[error(transparent)]
    Ssh(#[from] SshError),
    #[error(transparent)]
    Sftp(#[from] ProtocolError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("remote file path must not be blank")]
    EmptyRemotePath,
    #[error("local download destination already exists")]
    LocalFileExists,
    #[error("transfer cancelled by user")]
    Cancelled,
}

fn checked_remote_path(value: &str) -> Result<&str, NativeSftpError> {
    if value.trim().is_empty() {
        return Err(NativeSftpError::EmptyRemotePath);
    }
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub size: u64,
}

const COPY_CHUNK_BYTES: usize = 64 * 1024;

/// Copy with bounded memory and cooperative cancellation between I/O calls.
/// Reports a monotonically increasing number of bytes transferred.
async fn copy_with_progress<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(u64),
) -> Result<u64, NativeSftpError> {
    let mut buffer = [0_u8; COPY_CHUNK_BYTES];
    let mut total = 0_u64;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(NativeSftpError::Cancelled);
        }
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(NativeSftpError::Cancelled);
        }
        writer.write_all(&buffer[..count]).await?;
        total += count as u64;
        on_progress(total);
    }
    writer.flush().await?;
    Ok(total)
}

/// Owns one authenticated SSH connection and one independent SFTP subsystem.
/// Callers must create this on an asynchronous background worker, never in a
/// GPUI render callback. No credentials are retained by this type.
pub struct NativeSftp {
    connection: SshConnection,
    session: SftpSession,
}

impl NativeSftp {
    pub async fn open(connection: SshConnection) -> Result<Self, NativeSftpError> {
        let channel = connection.open_sftp_channel().await?;
        let session = SftpSession::new(channel.into_stream()).await?;
        Ok(Self { connection, session })
    }

    pub async fn session_path(&self, directory: &str) -> Result<String, NativeSftpError> {
        Ok(self.session.canonicalize(checked_remote_path(directory)?).await?)
    }

    pub async fn cwd(&self) -> Result<String, NativeSftpError> {
        self.session_path(".").await
    }

    pub async fn list(&self, directory: &str) -> Result<Vec<String>, NativeSftpError> {
        Ok(self.list_entries(directory).await?
            .into_iter().map(|entry| entry.name).collect())
    }

    pub async fn list_entries(&self, directory: &str) -> Result<Vec<SftpEntry>, NativeSftpError> {
        let mut entries = self.session.read_dir(checked_remote_path(directory)?)
            .await?.into_iter()
            .map(|entry| {
                let attributes = entry.metadata();
                SftpEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    directory: entry.file_type().is_dir(),
                    size: attributes.len(),
                }
            }).collect::<Vec<_>>();
        entries.sort_by(|a, b| {
            b.directory.cmp(&a.directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    /// Download to a newly created local file. Cancel/error removes the
    /// partial local file, without ever touching pre-existing data.
    pub async fn download(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
    ) -> Result<u64, NativeSftpError> {
        self.download_with_progress(
            remote_path, local_path, &AtomicBool::new(false), &mut |_| {},
        ).await
    }

    pub async fn download_with_progress(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
        cancelled: &AtomicBool,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<u64, NativeSftpError> {
        let source = checked_remote_path(remote_path)?;
        if cancelled.load(Ordering::Acquire) {
            return Err(NativeSftpError::Cancelled);
        }
        let local_path = local_path.as_ref();
        let mut remote = self.session.open(source).await?;
        let mut local = match tokio::fs::OpenOptions::new()
            .write(true).create_new(true).open(local_path).await
        {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists =>
                return Err(NativeSftpError::LocalFileExists),
            Err(err) => return Err(err.into()),
        };
        let result = copy_with_progress(
            &mut remote, &mut local, cancelled, on_progress,
        ).await;
        drop(local);
        if result.is_err() {
            let _ = tokio::fs::remove_file(local_path).await;
        }
        result
    }

    /// Upload uses SFTP CREATE+EXCLUDE: an existing remote file is never
    /// truncated. If a copy fails, remove only the file created by this call.
    pub async fn upload(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
    ) -> Result<u64, NativeSftpError> {
        self.upload_with_progress(
            local_path, remote_path, &AtomicBool::new(false), &mut |_| {},
        ).await
    }

    pub async fn upload_with_progress(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
        cancelled: &AtomicBool,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<u64, NativeSftpError> {
        let destination = checked_remote_path(remote_path)?;
        if cancelled.load(Ordering::Acquire) {
            return Err(NativeSftpError::Cancelled);
        }
        let mut local = tokio::fs::File::open(local_path).await?;
        let mut remote = self.session.open_with_flags(
            destination, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        ).await?;
        let copied = copy_with_progress(
            &mut local, &mut remote, cancelled, on_progress,
        ).await;
        let closed = remote.close().await;
        match (copied, closed) {
            (Ok(count), Ok(())) => Ok(count),
            (Err(error), _) => {
                let _ = self.session.remove_file(destination).await;
                Err(error)
            }
            (Ok(_), Err(error)) => {
                let _ = self.session.remove_file(destination).await;
                Err(error.into())
            }
        }
    }

    pub async fn close(self) -> Result<(), NativeSftpError> {
        self.session.close().await?;
        self.connection.disconnect().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn copy_reports_progress_and_cancel_prevents_further_writes() {
        let data = vec![42_u8; COPY_CHUNK_BYTES * 2 + 100];
        let mut reader = &data[..];
        let mut output = Vec::<u8>::new();
        let cancelled = AtomicBool::new(false);
        let mut seen = Vec::new();
        let total = copy_with_progress(
            &mut reader, &mut output, &cancelled, &mut |bytes| seen.push(bytes),
        ).await.unwrap();
        assert_eq!(total, data.len() as u64);
        assert_eq!(output, data);
        assert_eq!(seen.last().copied(), Some(total));
        assert!(seen.windows(2).all(|pair| pair[1] > pair[0]));

        let mut reader = &data[..];
        let mut output = Vec::<u8>::new();
        cancelled.store(true, Ordering::Release);
        assert!(matches!(
            copy_with_progress(&mut reader, &mut output, &cancelled, &mut |_| {}).await,
            Err(NativeSftpError::Cancelled)
        ));
        assert!(output.is_empty());
    }

    #[test]
    fn rejects_empty_remote_paths() {
        assert!(checked_remote_path("").is_err());
        assert!(checked_remote_path("  ").is_err());
        assert_eq!(checked_remote_path("/var/tmp/a").unwrap(), "/var/tmp/a");
    }
}
