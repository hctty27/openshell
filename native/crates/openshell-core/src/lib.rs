//! Native OpenShell core: transport, ANSI emulation and local metadata.
//! UI thread must not block on SSH, SFTP or SQLite operations.

pub mod session;
pub mod ssh;
pub mod store;
pub mod terminal;

pub use session::{Session, SessionError};
pub use store::SessionStore;
pub use ssh::{SshConnection, SshError, SshTerminal};
pub use terminal::{TerminalEngine, TerminalSize};
