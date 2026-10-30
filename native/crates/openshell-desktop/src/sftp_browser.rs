//! Presentation-only SFTP directory model. No SSH or file I/O in render.
use openshell_core::SftpEntry;

pub(super) struct SftpBrowser {
    pub session_id: String,
    pub session_name: String,
    pub path: String,
    pub entries: Vec<SftpEntry>,
    pub status: String,
    pub loading: bool,
    pub revision: u64,
}

impl SftpBrowser {
    pub fn new(session_id: String, session_name: String) -> Self {
        Self {
            session_id, session_name, path: ".".into(),
            entries: Vec::new(), status: "Loading remote directory...".into(),
            loading: true, revision: 0,
        }
    }

    pub fn parent(&self) -> String {
        parent_path(&self.path)
    }
}

/// Remote SFTP paths always use POSIX separators, including on Windows.
pub(super) fn parent_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "." { return "/".into(); }
    if let Some((parent, _)) = trimmed.rsplit_once('/') {
        if parent.is_empty() { "/".into() } else { parent.into() }
    } else {
        ".".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parent_keeps_posix_root() {
        assert_eq!(parent_path("/var/log"), "/var");
        assert_eq!(parent_path("/var"), "/");
        assert_eq!(parent_path("/"), "/");
        assert_eq!(parent_path("relative/sub"), "relative");
        assert_eq!(parent_path("."), "/");
    }
}
