//! Explicit host-key trust, separate from credential storage.
//! A new or changed key must be shown to the user and independently checked.
//! This module never implements trust-on-first-use without confirmation.

use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;

const MAX_FINGERPRINT_LENGTH: usize = 160;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostIdentity {
    pub host: String,
    pub port: u16,
}

impl HostIdentity {
    pub fn new(host: &str, port: u16) -> Result<Self, HostTrustError> {
        let host = host.trim().to_ascii_lowercase();
        if host.is_empty()
            || host.len() > 253
            || host.chars().any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '@')
            || port == 0
        {
            return Err(HostTrustError::InvalidHost);
        }
        Ok(Self { host, port })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustDecision {
    Unknown,
    Trusted,
    Changed { previous: String },
}

#[derive(Debug, Error)]
pub enum HostTrustError {
    #[error("invalid SSH host identity")]
    InvalidHost,
    #[error("invalid SHA256 host-key fingerprint")]
    InvalidFingerprint,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}

/// This store contains only host identifiers and public-key fingerprints.
/// Credential secrets belong in Windows Credential Manager instead.
pub struct HostTrustStore {
    connection: Connection,
}

fn valid_sha256_fingerprint(value: &str) -> bool {
    value.starts_with("SHA256:")
        && value.len() > "SHA256:".len()
        && value.len() <= MAX_FINGERPRINT_LENGTH
        && value["SHA256:".len()..]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'=')
}

impl HostTrustStore {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, HostTrustError> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS native_trusted_hosts (
                 host TEXT NOT NULL,
                 port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
                 fingerprint TEXT NOT NULL,
                 PRIMARY KEY(host,port)
             );",
        )?;
        Ok(Self { connection })
    }

    pub fn check(
        &self,
        identity: &HostIdentity,
        observed: &str,
    ) -> Result<TrustDecision, HostTrustError> {
        if !valid_sha256_fingerprint(observed) {
            return Err(HostTrustError::InvalidFingerprint);
        }
        let stored: Option<String> = self.connection.query_row(
            "SELECT fingerprint FROM native_trusted_hosts WHERE host=?1 AND port=?2",
            params![identity.host, identity.port],
            |row| row.get(0),
        ).optional()?;
        Ok(match stored {
            None => TrustDecision::Unknown,
            Some(ref value) if value == observed => TrustDecision::Trusted,
            Some(previous) => TrustDecision::Changed { previous },
        })
    }

    /// Call **only after** the user has checked the fingerprint independently
    /// and approved this exact host:port/fingerprint. No connection path calls
    /// this method automatically.
    pub fn record_user_approved(
        &self,
        identity: &HostIdentity,
        fingerprint: &str,
    ) -> Result<(), HostTrustError> {
        if !valid_sha256_fingerprint(fingerprint) {
            return Err(HostTrustError::InvalidFingerprint);
        }
        self.connection.execute(
            "INSERT INTO native_trusted_hosts(host,port,fingerprint)
             VALUES (?1,?2,?3)
             ON CONFLICT(host,port) DO UPDATE SET fingerprint=excluded.fingerprint",
            params![identity.host, identity.port, fingerprint],
        )?;
        Ok(())
    }

    pub fn forget(&self, identity: &HostIdentity) -> Result<bool, HostTrustError> {
        Ok(self.connection.execute(
            "DELETE FROM native_trusted_hosts WHERE host=?1 AND port=?2",
            params![identity.host, identity.port],
        )? > 0)
    }

    pub fn trusted_fingerprint(
        &self,
        identity: &HostIdentity,
    ) -> Result<Option<String>, HostTrustError> {
        Ok(self.connection.query_row(
            "SELECT fingerprint FROM native_trusted_hosts WHERE host=?1 AND port=?2",
            params![identity.host, identity.port],
            |row| row.get(0),
        ).optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_1: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const KEY_2: &str = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    #[test]
    fn does_not_implicitly_trust_or_replace_a_changed_host_key() {
        let db = HostTrustStore::open(":memory:").unwrap();
        let host = HostIdentity::new("Example.ORG", 22).unwrap();
        assert_eq!(host.host, "example.org");
        assert_eq!(db.check(&host, KEY_1).unwrap(), TrustDecision::Unknown);
        assert_eq!(db.trusted_fingerprint(&host).unwrap(), None);
        db.record_user_approved(&host, KEY_1).unwrap();
        assert_eq!(db.check(&host, KEY_1).unwrap(), TrustDecision::Trusted);
        assert_eq!(
            db.check(&host, KEY_2).unwrap(),
            TrustDecision::Changed { previous: KEY_1.into() },
        );
        assert_eq!(db.trusted_fingerprint(&host).unwrap().as_deref(), Some(KEY_1));
    }

    #[test]
    fn host_port_pairs_are_independent_and_unknown_hosts_are_not_saved() {
        let db = HostTrustStore::open(":memory:").unwrap();
        let a = HostIdentity::new("host.example", 22).unwrap();
        let b = HostIdentity::new("host.example", 2222).unwrap();
        db.record_user_approved(&a, KEY_1).unwrap();
        assert_eq!(db.check(&b, KEY_1).unwrap(), TrustDecision::Unknown);
        assert!(!db.forget(&b).unwrap());
        assert!(db.forget(&a).unwrap());
        assert_eq!(db.check(&a, KEY_1).unwrap(), TrustDecision::Unknown);
    }

    #[test]
    fn validates_host_and_fingerprint() {
        assert!(HostIdentity::new("user@host", 22).is_err());
        assert!(HostIdentity::new("host", 0).is_err());
        let db = HostTrustStore::open(":memory:").unwrap();
        let h = HostIdentity::new("host", 22).unwrap();
        assert!(db.record_user_approved(&h, "SHA256:").is_err());
        assert!(db.record_user_approved(&h, "MD5:hello").is_err());
        assert_eq!(db.trusted_fingerprint(&h).unwrap(), None);
    }
}
