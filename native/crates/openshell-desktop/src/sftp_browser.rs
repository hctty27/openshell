//! Presentation state for the native SFTP browser. No SSH I/O runs in render.
use std::{collections::VecDeque, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use crate::ssh_preview::SftpTransferDirection;
use openshell_core::SftpEntry;

pub(super) const MAX_PENDING_TRANSFERS: usize = 12;
const MAX_RECENT_TRANSFERS: usize = 6;

pub(super) struct QueuedSftpTransfer {
    pub direction: SftpTransferDirection,
    pub local: PathBuf,
    pub remote: String,
    pub total: Option<u64>,
}

pub(super) struct SftpTransferView {
    pub cancel: Arc<AtomicBool>,
    pub status: String,
    pub bytes: u64,
    pub total: Option<u64>,
    pub running: bool,
}

impl SftpTransferView {
    pub fn progress_label(&self) -> String {
        match self.total {
            Some(total) if total > 0 => {
                let percent = self.bytes.saturating_mul(100).checked_div(total).unwrap_or(0).min(100);
                format!("{}: {} / {} bytes ({}%)", self.status, self.bytes, total, percent)
            }
            _ => format!("{}: {} bytes", self.status, self.bytes),
        }
    }
}

pub(super) struct SftpBrowser {
    pub session_id: String,
    pub session_name: String,
    pub path: String,
    pub entries: Vec<SftpEntry>,
    pub status: String,
    pub loading: bool,
    pub revision: u64,
    pub generation: u64,
    pub picker_open: bool,
    pub transfer: Option<SftpTransferView>,
    pub pending: VecDeque<QueuedSftpTransfer>,
    pub recent: VecDeque<String>,
}

impl SftpBrowser {
    pub fn new(session_id: String, session_name: String, generation: u64) -> Self {
        Self {
            session_id, session_name, path: ".".into(),
            entries: Vec::new(), status: "Loading remote directory...".into(),
            loading: true, revision: 0, generation,
            picker_open: false, transfer: None,
            pending: VecDeque::new(), recent: VecDeque::new(),
        }
    }

    pub fn parent(&self) -> String {
        parent_path(&self.path)
    }

    pub fn transfer_running(&self) -> bool {
        self.transfer.as_ref().is_some_and(|transfer| transfer.running)
    }

    pub fn enqueue(&mut self, transfer: QueuedSftpTransfer) -> Result<usize, ()> {
        if self.pending.len() >= MAX_PENDING_TRANSFERS {
            return Err(());
        }
        self.pending.push_back(transfer);
        Ok(self.pending.len())
    }

    pub fn finish(&mut self, description: String) -> Option<QueuedSftpTransfer> {
        self.recent.push_front(description);
        self.recent.truncate(MAX_RECENT_TRANSFERS);
        self.pending.pop_front()
    }

    pub fn clear_pending(&mut self) {
        self.pending.clear();
    }

    pub fn cancel_transfer(&mut self) {
        if let Some(transfer) = self.transfer.as_mut() {
            if transfer.running {
                transfer.cancel.store(true, Ordering::Release);
                transfer.status = "Cancelling transfer".into();
            }
        }
    }
}

impl Drop for SftpBrowser {
    fn drop(&mut self) {
        self.cancel_transfer();
    }
}

/// SFTP remote paths are POSIX paths even when the client runs on Windows.
pub(super) fn remote_destination(directory: &str, filename: &str) -> Option<String> {
    if directory.trim().is_empty() || filename.is_empty()
        || matches!(filename, "." | "..")
        || filename.chars().any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return None;
    }
    let base = directory.trim_end_matches('/');
    Some(if base.is_empty() {
        format!("/{filename}")
    } else {
        format!("{base}/{filename}")
    })
}

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
        assert_eq!(parent_path("relative/sub"), "relative");
        assert_eq!(parent_path("."), "/");
    }

    #[test]
    fn upload_paths_reject_nested_filenames() {
        assert_eq!(remote_destination("/data/", "file.txt"), Some("/data/file.txt".into()));
        assert_eq!(remote_destination("/", "日志.txt"), Some("/日志.txt".into()));
        for invalid in ["", "..", "../evil", "a/b", "a\\b", "a\n"] {
            assert!(remote_destination("/data", invalid).is_none());
        }
    }

    #[test]
    fn queue_is_bounded_and_tracks_recent_results() {
        let mut browser = SftpBrowser::new("id".into(), "SSH".into(), 1);
        for i in 0..MAX_PENDING_TRANSFERS {
            let queued = QueuedSftpTransfer {
                direction: SftpTransferDirection::Upload,
                local: PathBuf::from(format!("test-{i}")),
                remote: format!("/tmp/test-{i}"), total: None,
            };
            assert_eq!(browser.enqueue(queued).unwrap(), i + 1);
        }
        assert!(browser.enqueue(QueuedSftpTransfer {
            direction: SftpTransferDirection::Download,
            local: PathBuf::from("overflow"), remote: "/tmp/o".into(), total: None,
        }).is_err());
        for i in 0..10 {
            assert!(browser.finish(format!("complete-{i}")).is_some());
        }
        assert_eq!(browser.recent.len(), MAX_RECENT_TRANSFERS);
        assert_eq!(browser.recent.front().unwrap(), "complete-9");
        browser.clear_pending();
        assert!(browser.pending.is_empty());
    }

    #[test]
    fn cancellation_is_visible_in_transfer_state() {
        let mut browser = SftpBrowser::new("id".into(), "SSH".into(), 7);
        let cancel = Arc::new(AtomicBool::new(false));
        browser.transfer = Some(SftpTransferView {
            cancel: cancel.clone(), status: "Uploading".into(),
            bytes: 0, total: None, running: true,
        });
        browser.cancel_transfer();
        assert!(cancel.load(Ordering::Acquire));
        assert!(browser.transfer.as_ref().unwrap().status.starts_with("Cancelling"));
    }
}
