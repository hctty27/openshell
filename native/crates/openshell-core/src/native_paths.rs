//! Native2 storage is separate from the production Wails database.
//! Only metadata and public host-key fingerprints are stored here.

use std::{env, io, path::PathBuf};

pub fn native_data_directory() -> io::Result<PathBuf> {
    let local = env::var_os("LOCALAPPDATA").ok_or_else(|| io::Error::new(
        io::ErrorKind::NotFound,
        "LOCALAPPDATA is not configured; native session storage is Windows-only",
    ))?;
    Ok(PathBuf::from(local).join("OpenShellNative2"))
}

pub fn native_database_path() -> io::Result<PathBuf> {
    Ok(native_data_directory()?.join("native.db"))
}

/// Explicitly invoked by a metadata editing command, not when merely reading.
pub fn ensure_native_data_directory() -> io::Result<PathBuf> {
    let dir = native_data_directory()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_name_never_overwrites_legacy_state_db() {
        let path = native_database_path();
        if let Ok(path) = path {
            assert!(path.ends_with("OpenShellNative2/native.db"));
            assert!(!path.ends_with("OpenShell/state.db"));
        }
    }
}
