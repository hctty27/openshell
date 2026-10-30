//! Native SFTP transport, separate from the interactive terminal channel.
//! Streaming I/O avoids buffering entire files in the GPUI process.

use std::path::Path;

use russh_sftp::{
    client::{SftpSession, error::Error as ProtocolError},
    protocol::OpenFlags,
};
use thiserror::Error;
use tokio::io::AsyncWriteExt;

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

    /// Does not overwrite an existing local file. On failed/aborted copies
    /// remove only the file we created in this invocation.
    pub async fn download(
        &self,
        remote_path: &str,
        local_path: impl AsRef<Path>,
    ) -> Result<u64, NativeSftpError> {
        let source = checked_remote_path(remote_path)?;
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

        let result = tokio::io::copy(&mut remote, &mut local).await;
        let flush = local.flush().await;
        drop(local);
        match (result, flush) {
            (Ok(count), Ok(())) => Ok(count),
            (Err(error), _) | (_, Err(error)) => {
                let _ = tokio::fs::remove_file(local_path).await;
                Err(error.into())
            }
        }
    }

    /// Fails if the remote target already exists (SFTP EXCL). The caller must
    /// explicitly choose a remote destination; no silent overwrite.
    pub async fn upload(
        &self,
        local_path: impl AsRef<Path>,
        remote_path: &str,
    ) -> Result<u64, NativeSftpError> {
        let destination = checked_remote_path(remote_path)?;
        let mut local = tokio::fs::File::open(local_path).await?;
        let mut remote = self.session.open_with_flags(
            destination, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        ).await?;
        let copied = tokio::io::copy(&mut local, &mut remote).await?;
        remote.close().await?;
        Ok(copied)
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
    #[test]
    fn rejects_empty_remote_paths() {
        assert!(checked_remote_path("").is_err());
        assert!(checked_remote_path("  ").is_err());
        assert_eq!(checked_remote_path("/var/tmp/a").unwrap(), "/var/tmp/a");
    }
}
