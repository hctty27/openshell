use gpui::Task;
use openshell_core::{LocalTerminal, TerminalEngine, TerminalSize, SshTerminalCommand, zmodem::{ZmodemProbe, ZmodemRequest}};
use tokio::sync::{mpsc, watch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RemotePhase {
    Local,
    Connecting,
    Connected,
    Disconnecting,
    Disconnected,
}

pub(super) fn remote_button_label(phase: RemotePhase, saved_session: bool) -> &'static str {
    match phase {
        RemotePhase::Local => "Local terminal",
        RemotePhase::Connecting => "Cancel connection",
        RemotePhase::Connected => "Disconnect SSH",
        RemotePhase::Disconnecting => "Force cancel",
        RemotePhase::Disconnected if saved_session => "Reconnect SSH",
        RemotePhase::Disconnected => "SSH disconnected",
    }
}

/// Each tab owns its Alacritty history, PTY/SSH channels and asynchronous
/// output task. Switching the active tab must not drop or restart other tabs.
pub(super) struct TerminalTab {
    pub(super) id: u64,
    pub(super) title: String,
    pub(super) session_id: Option<String>,
    pub(super) terminal: TerminalEngine,
    pub(super) local: Option<LocalTerminal>,
    pub(super) remote_commands: Option<mpsc::Sender<SshTerminalCommand>>,
    pub(super) remote_cancel: Option<watch::Sender<bool>>,
    pub(super) remote_phase: RemotePhase,
    pub(super) status: String,
    pub(super) scroll_remainder: f32,
    pub(super) zmodem_probe: ZmodemProbe,
    pub(super) zmodem_prompt: Option<ZmodemRequest>,
    pub(super) zmodem_silenced: bool,
    pub(super) task: Option<Task<()>>,
}

impl TerminalTab {
    pub(super) fn local(id: u64, size: TerminalSize) -> Self {
        Self {
            id,
            title: format!("PowerShell {id}"),
            session_id: None,
            terminal: TerminalEngine::new(size),
            local: None,
            remote_commands: None,
            remote_cancel: None,
            remote_phase: RemotePhase::Local,
            status: "Starting PowerShell...".into(),
            scroll_remainder: 0.0,
            zmodem_probe: ZmodemProbe::default(),
            zmodem_prompt: None,
            zmodem_silenced: false,
            task: None,
        }
    }

    pub(super) fn remote(id: u64, title: String, session_id: Option<String>, size: TerminalSize) -> Self {
        Self {
            id,
            title,
            session_id,
            terminal: TerminalEngine::new(size),
            local: None,
            remote_commands: None,
            remote_cancel: None,
            remote_phase: RemotePhase::Connecting,
            status: "Connecting to SSH server...".into(),
            scroll_remainder: 0.0,
            zmodem_probe: ZmodemProbe::default(),
            zmodem_prompt: None,
            zmodem_silenced: false,
            task: None,
        }
    }

    /// Observe raw SSH bytes before sending them into Alacritty. This
    /// does not consume or rewrite the transport: future ZMODEM engines must
    /// acquire exclusive binary-stream ownership before file I/O is enabled.
    pub(super) fn observe_zmodem(&mut self, data: &[u8]) -> bool {
        if self.zmodem_silenced || self.remote_phase != RemotePhase::Connected {
            return false;
        }
        if let Some(kind) = self.zmodem_probe.feed(data) {
            self.zmodem_prompt = Some(kind);
            return true;
        }
        false
    }

    pub(super) fn dismiss_zmodem(&mut self) {
        self.zmodem_prompt = None;
        self.zmodem_silenced = true;
    }

    pub(super) fn reset_zmodem(&mut self) {
        self.zmodem_probe.reset();
        self.zmodem_prompt = None;
        self.zmodem_silenced = false;
    }

    pub(super) fn is_remote(&self) -> bool {
        self.remote_phase != RemotePhase::Local
    }

    pub(super) fn cancel_transport(&mut self) {
        if let Some(cancel) = self.remote_cancel.take() {
            let _ = cancel.send(true);
        }
        // Dropping the task releases SshPreview, which also signals its
        // worker to cancel any outstanding connection or authentication.
        self.task = None;
        self.remote_commands = None;
        self.local = None;
    }
}

impl Drop for TerminalTab {
    fn drop(&mut self) {
        self.cancel_transport();
    }
}

