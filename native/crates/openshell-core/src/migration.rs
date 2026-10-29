//! Explicit, metadata-only migration from the legacy Go/Wails database.
//! The existing database is only opened read-only and first snapshotted using
//! SQLite VACUUM INTO (which also includes committed WAL changes).

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};
use thiserror::Error;

use crate::{
    legacy::{preview_legacy_sessions, LegacyError},
    session::Session,
    store::SessionStore,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub backup_path: PathBuf,
    pub imported: usize,
    pub existing: usize,
    pub invalid: usize,
}

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("legacy backup already exists; refusing to overwrite it")]
    BackupExists,
    #[error("legacy backup path must be valid UTF-8")]
    BackupPathEncoding,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Legacy(#[from] LegacyError),
}

/// An opt-in import. Only name, host, port, username and session ID are
/// transferred. Neither key paths nor credential references are imported.
/// Existing native IDs are preserved rather than overwritten. The Wails
/// database itself is never opened for writing.
pub fn import_legacy_sessions(
    legacy_path: impl AsRef<Path>,
    backup_path: impl AsRef<Path>,
    native: &SessionStore,
) -> Result<ImportReport, ImportError> {
    let backup_path = backup_path.as_ref();
    if backup_path.exists() {
        return Err(ImportError::BackupExists);
    }
    let backup_name = backup_path.to_str().ok_or(ImportError::BackupPathEncoding)?;
    let legacy = Connection::open_with_flags(
        legacy_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    legacy.execute("VACUUM INTO ?1", params![backup_name])?;
    drop(legacy);

    // Parse the entire backup before changing any native session. A malformed
    // legacy row aborts import while leaving both databases unchanged.
    let candidates = preview_legacy_sessions(backup_path)?;
    let mut report = ImportReport {
        backup_path: backup_path.to_owned(),
        imported: 0,
        existing: 0,
        invalid: 0,
    };
    for legacy in candidates {
        let session = Session {
            id: legacy.id,
            name: legacy.name,
            host: legacy.host,
            port: legacy.port,
            username: legacy.username,
        };
        if session.validate().is_err() {
            report.invalid += 1;
            continue;
        }
        if native.insert_if_absent(&session)? {
            report.imported += 1;
        } else {
            report.existing += 1;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_snapshots_legacy_but_never_migrates_secrets_or_overwrites_native() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy.db");
        let backup = temp.path().join("original-backup.db");
        {
            let connection = Connection::open(&legacy).unwrap();
            connection.execute_batch(
                "CREATE TABLE sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);",
            ).unwrap();
            connection.execute(
                "INSERT INTO sessions VALUES (?1, ?2)",
                params![
                    "existing",
                    r#"{"id":"existing","name":"Old","host":"old.example","port":22,"username":"root","credentialRef":"SECRET_REF"}"#,
                ],
            ).unwrap();
            connection.execute(
                "INSERT INTO sessions VALUES (?1, ?2)",
                params![
                    "new",
                    r#"{"id":"new","name":"Imported","host":"new.example","port":22,"username":"deploy","privateKeyPath":"C:\\secret.key"}"#,
                ],
            ).unwrap();
            connection.execute(
                "INSERT INTO sessions VALUES (?1, ?2)",
                params![
                    "invalid",
                    r#"{"id":"invalid/id","name":"Invalid","host":"bad","port":0,"username":"user"}"#,
                ],
            ).unwrap();
        }

        let native = SessionStore::open(":memory:").unwrap();
        native.save(&Session {
            id: "existing".into(), name: "Current".into(),
            host: "current.example".into(), port: 2222, username: "admin".into(),
        }).unwrap();
        let report = import_legacy_sessions(&legacy, &backup, &native).unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.existing, 1);
        assert_eq!(report.invalid, 1);
        assert!(backup.exists());
        let imported = native.list().unwrap();
        assert_eq!(imported.len(), 2);
        assert_eq!(imported[0].host, "current.example");
        assert_eq!(imported[1].host, "new.example");
        let serialized = serde_json::to_string(&imported).unwrap();
        assert!(!serialized.contains("SECRET_REF"));
        assert!(!serialized.contains("secret.key"));
        assert!(matches!(
            import_legacy_sessions(&legacy, &backup, &native),
            Err(ImportError::BackupExists),
        ));
    }
}
