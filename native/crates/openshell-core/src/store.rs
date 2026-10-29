use std::path::Path;

use rusqlite::{params, Connection, Result as DbResult};

use crate::session::Session;

/// Local metadata only. This intentionally uses a new DB rather than mutating
/// the existing Wails state.db during parallel development.
pub struct SessionStore {
    connection: Connection,
}

impl SessionStore {
    pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS native_sessions (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 host TEXT NOT NULL,
                 port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
                 username TEXT NOT NULL
             );",
        )?;
        Ok(Self { connection })
    }

    pub fn save(&self, session: &Session) -> DbResult<()> {
        session.validate().map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(e))
        })?;
        self.connection.execute(
            "INSERT INTO native_sessions (id, name, host, port, username)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name,
                 host=excluded.host,
                 port=excluded.port,
                 username=excluded.username",
            params![session.id, session.name, session.host, session.port, session.username],
        )?;
        Ok(())
    }

    /// Insert imported metadata without changing an existing native session
    /// or its credential reference. No implicit upsert during migration.
    pub fn insert_if_absent(&self, session: &Session) -> DbResult<bool> {
        session.validate().map_err(|error| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(error))
        })?;
        let changed = self.connection.execute(
            "INSERT INTO native_sessions (id, name, host, port, username)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO NOTHING",
            params![session.id, session.name, session.host, session.port, session.username],
        )?;
        Ok(changed == 1)
    }

    pub fn list(&self) -> DbResult<Vec<Session>> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, host, port, username
             FROM native_sessions ORDER BY name COLLATE NOCASE, id",
        )?;
        let records = statement.query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get(3)?,
                username: row.get(4)?,
            })
        })?;
        records.collect()
    }

    pub fn delete(&self, session_id: &str) -> DbResult<bool> {
        let affected = self.connection.execute(
            "DELETE FROM native_sessions WHERE id=?1",
            params![session_id],
        )?;
        Ok(affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_sessions_never_overwrite_existing_metadata() {
        let store = SessionStore::open(":memory:").unwrap();
        let original = Session {
            id: "same".into(), name: "Current".into(),
            host: "current.example".into(), port: 2222, username: "admin".into(),
        };
        let imported = Session {
            id: "same".into(), name: "Legacy".into(),
            host: "old.example".into(), port: 22, username: "root".into(),
        };
        store.save(&original).unwrap();
        assert!(!store.insert_if_absent(&imported).unwrap());
        assert_eq!(store.list().unwrap(), vec![original]);
    }

    #[test]
    fn saves_lists_and_deletes_sessions() {
        let store = SessionStore::open(":memory:").expect("open database");
        let session = Session {
            id: "test".into(), name: "Demo".into(),
            host: "example.org".into(), port: 22, username: "admin".into()
        };
        store.save(&session).expect("save");
        store.save(&session).expect("upsert");
        assert_eq!(store.list().expect("list"), vec![session]);
        assert!(store.delete("test").expect("delete"));
        assert!(store.list().expect("list").is_empty());
    }
}
