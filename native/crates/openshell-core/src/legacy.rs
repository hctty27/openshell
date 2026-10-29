//! Read-only preview of the legacy Wails SQLite session data.
//! Import into native storage must be an explicit later user action.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySession {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub group_id: String,
    #[serde(default)]
    pub auth_type: String,
    #[serde(default)]
    pub private_key_path: String,
    #[serde(default)]
    pub credential_ref: String,
    #[serde(default)]
    pub proxy_jump: String,
}

#[derive(Debug, thiserror::Error)]
pub enum LegacyError {
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Never creates or modifies a legacy database. The calling layer must make a
/// consistent backup if the old application can be writing concurrently.
pub fn preview_legacy_sessions(path: impl AsRef<Path>) -> Result<Vec<LegacySession>, LegacyError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut statement = connection.prepare("SELECT data FROM sessions ORDER BY id")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(serde_json::from_str(&row?)?);
    }
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_legacy_records_without_mutation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("legacy.db");
        {
            let connection = Connection::open(&path).expect("create");
            connection.execute_batch(
                "CREATE TABLE sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL)"
            ).expect("schema");
            connection.execute(
                "INSERT INTO sessions VALUES (?1, ?2)",
                rusqlite::params![
                    "one",
                    r#"{"id":"one","name":"Remote","host":"10.0.0.1","port":22,"username":"root","authType":"key","credentialRef":"secret-ref"}"#
                ],
            ).expect("insert");
        }
        let sessions = preview_legacy_sessions(&path).expect("preview");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].auth_type, "key");
        assert_eq!(sessions[0].credential_ref, "secret-ref");
        assert_eq!(sessions[0].port, 22);
    }

    #[test]
    fn never_creates_missing_database() {
        let directory = tempfile::tempdir().expect("temp");
        let missing = directory.path().join("missing.db");
        assert!(preview_legacy_sessions(&missing).is_err());
        assert!(!missing.exists());
    }
}
