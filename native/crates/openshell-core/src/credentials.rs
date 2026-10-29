//! Windows Credential Manager-backed SSH secrets.
//! Store only opaque references (session IDs) in SQLite.
//! All keyring operations are synchronous; invoke from worker threads.

use thiserror::Error;
use zeroize::Zeroizing;

const SERVICE: &str = "OpenShell.Native2.SSH";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CredentialError {
    #[error("invalid session credential identifier")]
    InvalidReference,
    #[error("Windows Credential Manager is not available on this platform")]
    UnsupportedPlatform,
    #[error("Windows Credential Manager operation failed")]
    StoreFailure,
}

fn validate_reference(session_id: &str) -> Result<(), CredentialError> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
        })
    {
        return Err(CredentialError::InvalidReference);
    }
    Ok(())
}

/// Windows credentials are scoped to the OS user account. The native rewrite
/// uses a *different* service name from the old Wails app to avoid overwrites.
pub struct CredentialVault;

impl CredentialVault {
    #[cfg(windows)]
    fn entry(session_id: &str) -> Result<keyring::Entry, CredentialError> {
        validate_reference(session_id)?;
        keyring::Entry::new(SERVICE, session_id).map_err(|_| CredentialError::StoreFailure)
    }

    /// Store a password explicitly supplied by the user.
    /// Does not log, serialize, or retain it after the call.
    pub fn put(session_id: &str, password: &str) -> Result<(), CredentialError> {
        validate_reference(session_id)?;
        #[cfg(windows)]
        {
            return Self::entry(session_id)?
                .set_password(password)
                .map_err(|_| CredentialError::StoreFailure);
        }
        #[cfg(not(windows))]
        {
            let _ = password;
            Err(CredentialError::UnsupportedPlatform)
        }
    }

    /// Caller must keep the returned secret off the UI and log paths.
    /// Zeroizing<String> clears memory when dropped.
    pub fn get(session_id: &str) -> Result<Option<Zeroizing<String>>, CredentialError> {
        validate_reference(session_id)?;
        #[cfg(windows)]
        {
            return match Self::entry(session_id)?.get_password() {
                Ok(password) => Ok(Some(Zeroizing::new(password))),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(CredentialError::StoreFailure),
            };
        }
        #[cfg(not(windows))]
        {
            Err(CredentialError::UnsupportedPlatform)
        }
    }

    pub fn delete(session_id: &str) -> Result<(), CredentialError> {
        validate_reference(session_id)?;
        #[cfg(windows)]
        {
            return match Self::entry(session_id)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(CredentialError::StoreFailure),
            };
        }
        #[cfg(not(windows))]
        {
            Err(CredentialError::UnsupportedPlatform)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_credential_refs_with_path_or_control_chars() {
        for invalid in ["", "../other", "a/b", "a:b", "a\nb", " a", "x y"] {
            assert_eq!(validate_reference(invalid), Err(CredentialError::InvalidReference));
        }
        assert_eq!(validate_reference("session_01-abc"), Ok(()));
    }

    #[test]
    fn vault_never_serializes_a_password_into_session_metadata() {
        let session = crate::session::Session {
            id: "session_01".into(), name: "Host".into(),
            host: "example.org".into(), port: 22, username: "user".into(),
        };
        let json = serde_json::to_string(&session).unwrap();
        assert!(!json.contains("password"));
        assert!(!json.contains(SERVICE));
    }
}
