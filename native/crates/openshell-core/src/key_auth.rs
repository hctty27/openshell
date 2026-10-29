//! Optional unencrypted private-key file per SSH session.
//! This database stores only the canonical file path; never key material.
//! Key-file ownership and secure permissions are managed by the operating system.
use std::path::{Path, PathBuf};
use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SessionKeyError {
    #[error("invalid session ID")]
    InvalidId,
    #[error("SSH private key must be an existing regular local file")]
    InvalidFile,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 &&
        id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
}

pub struct SessionKeyStore {
    db: Connection,
}

impl SessionKeyStore {
    pub fn open(database: impl AsRef<Path>) -> Result<Self, SessionKeyError> {
        let db = Connection::open(database)?;
        db.execute_batch(
            "PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS native_session_keys (
               session_id TEXT PRIMARY KEY NOT NULL,
               private_key_path TEXT NOT NULL
             );"
        )?;
        Ok(Self { db })
    }

    /// Replaces this session's authentication preference. Never reads key bytes.
    pub fn set(&self, id: &str, path: impl AsRef<Path>) -> Result<PathBuf, SessionKeyError> {
        if !valid_session_id(id) { return Err(SessionKeyError::InvalidId); }
        let canonical = path.as_ref().canonicalize().map_err(|_| SessionKeyError::InvalidFile)?;
        if !canonical.is_file() { return Err(SessionKeyError::InvalidFile); }
        let value = canonical.to_str().ok_or(SessionKeyError::InvalidFile)?;
        self.db.execute(
            "INSERT INTO native_session_keys(session_id,private_key_path)
             VALUES (?1,?2)
             ON CONFLICT(session_id) DO UPDATE SET private_key_path=excluded.private_key_path",
            params![id, value],
        )?;
        Ok(canonical)
    }

    pub fn get(&self, id: &str) -> Result<Option<PathBuf>, SessionKeyError> {
        if !valid_session_id(id) { return Err(SessionKeyError::InvalidId); }
        let stored: Option<String> = self.db.query_row(
            "SELECT private_key_path FROM native_session_keys WHERE session_id=?1",
            params![id], |row| row.get(0),
        ).optional()?;
        Ok(stored.map(PathBuf::from))
    }

    /// Removing a key preference restores password authentication for the
    /// next connection. Existing terminal channels are unaffected.
    pub fn clear(&self, id: &str) -> Result<(), SessionKeyError> {
        if !valid_session_id(id) { return Err(SessionKeyError::InvalidId); }
        self.db.execute(
            "DELETE FROM native_session_keys WHERE session_id=?1", params![id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_only_file_location_and_can_disable_key_auth() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("test_ed25519");
        std::fs::write(&file, b"not-real-secret-key-data").unwrap();
        let store = SessionKeyStore::open(":memory:").unwrap();
        assert!(store.get("server").unwrap().is_none());
        let canonical = store.set("server", &file).unwrap();
        assert_eq!(store.get("server").unwrap(), Some(canonical));
        store.clear("server").unwrap();
        assert!(store.get("server").unwrap().is_none());
        assert!(store.set("bad/id", &file).is_err());
        assert!(store.set("server", temp.path().join("missing")).is_err());
    }
}
