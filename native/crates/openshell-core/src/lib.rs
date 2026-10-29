//! Native OpenShell core: transport, ANSI emulation and local metadata.
//! UI thread must not block on SSH, SFTP or SQLite operations.

pub mod session;
pub mod legacy;
pub mod local;
pub mod ssh;
pub mod store;
pub mod terminal;
pub mod workspace;

pub use session::{Session, SessionError};
pub use legacy::{LegacySession, preview_legacy_sessions};
pub use local::{LocalShell, LocalTerminal};
pub use store::SessionStore;
pub use ssh::{SshConnection, SshError, SshTerminal};
pub use terminal::{TerminalEngine, TerminalSize};

pub use workspace::{Split, SplitAxis, Tab, Workspace, WorkspaceError};
