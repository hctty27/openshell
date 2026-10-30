//! Native OpenShell core: transport, ANSI emulation and local metadata.
//! UI thread must not block on SSH, SFTP or SQLite operations.

pub mod session;
pub mod legacy;
pub mod migration;
pub mod local;
pub mod ssh;
pub mod sftp;
pub mod host_trust;
pub mod native_paths;
pub mod credentials;
pub mod store;
pub mod key_auth;
pub mod terminal;
pub mod cwd;
pub mod zmodem;
pub mod zmodem_engine;
pub mod workspace;

pub use session::{Session, SessionError};
pub use legacy::{LegacySession, preview_legacy_sessions};
pub use migration::{import_legacy_sessions, ImportReport, ImportError};
pub use local::{LocalShell, LocalTerminal};
pub use store::SessionStore;
pub use key_auth::{SessionKeyStore, SessionKeyError};
pub use credentials::{CredentialVault, CredentialError};
pub use host_trust::{HostIdentity, HostTrustStore, TrustDecision, HostTrustError};
pub use ssh::{SshConnection, SshError, SshTerminal, SshTerminalCommand, SshTerminalOutcome};
pub use terminal::{TerminalEngine, TerminalSize};

pub use workspace::{Split, SplitAxis, Tab, Workspace, WorkspaceError};

pub use sftp::{NativeSftp, NativeSftpError, SftpEntry};
