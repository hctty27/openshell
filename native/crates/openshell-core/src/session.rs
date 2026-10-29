use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Never persist passwords or private-key passphrases inside a Session.
/// Secrets belong to the operating-system credential store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("session ID is required")]
    MissingId,
    #[error("session name is required")]
    MissingName,
    #[error("SSH host is required")]
    MissingHost,
    #[error("SSH username is required")]
    MissingUsername,
    #[error("SSH port must not be zero")]
    InvalidPort,
}

impl Session {
    pub fn validate(&self) -> Result<(), SessionError> {
        if self.id.trim().is_empty() { return Err(SessionError::MissingId); }
        if self.name.trim().is_empty() { return Err(SessionError::MissingName); }
        if self.host.trim().is_empty() { return Err(SessionError::MissingHost); }
        if self.username.trim().is_empty() { return Err(SessionError::MissingUsername); }
        if self.port == 0 { return Err(SessionError::InvalidPort); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Session {
        Session {
            id: "s1".into(),
            name: "Example".into(),
            host: "example.org".into(),
            port: 22,
            username: "root".into(),
        }
    }

    #[test]
    fn rejects_invalid_session() {
        let mut s = valid();
        assert!(s.validate().is_ok());
        s.host = "   ".into();
        assert_eq!(s.validate(), Err(SessionError::MissingHost));
    }

    #[test]
    fn serialization_does_not_contain_credentials() {
        let value = serde_json::to_value(valid()).expect("serialize");
        assert!(value.get("password").is_none());
        assert!(value.get("privateKey").is_none());
    }
}
