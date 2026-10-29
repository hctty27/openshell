mod terminal_paint;
mod terminal_tab;
mod split_view;
use terminal_paint::*;
use terminal_tab::{TerminalTab, RemotePhase, remote_button_label};
use split_view::SplitView;
use openshell_core::workspace::SplitAxis;
mod ssh_preview;

use gpui::prelude::*;
use gpui::{
    div, px, rgb, size, App, Application, Bounds, Context, FocusHandle, Focusable,
    IntoElement, KeyDownEvent, Keystroke, Render, Task, Window, WindowBounds,
    WindowOptions, HighlightStyle, StyledText, FontWeight, Subscription, ScrollWheelEvent,
};
use openshell_core::{LocalShell, LocalTerminal, Session, SessionStore, SshTerminalCommand, TerminalEngine, TerminalSize};
use openshell_core::native_paths::native_database_path;
use ssh_preview::{PreviewStatus, SshPreview, start_from_environment, start_saved_session};
use tokio::sync::{mpsc, watch};
use openshell_core::terminal::RenderCell;


/// Pure tab navigation for Ctrl+Tab, including wrap-around.
fn cycle_id(ids: &[u64], active: u64, direction: i32) -> Option<u64> {
    if ids.is_empty() { return None; }
    let current = ids.iter().position(|id| *id == active).unwrap_or(0);
    let count = ids.len() as i32;
    let next = (current as i32 + direction).rem_euclid(count) as usize;
    Some(ids[next])
}

struct Workspace {
    tabs: Vec<TerminalTab>,
    active_id: u64,
    next_tab_id: u64,
    pending_close: Option<u64>,
    split: Option<SplitView>,
    viewport_width: f32,
    viewport_height: f32,
    _resize_subscription: Subscription,
    focus_handle: FocusHandle,
    saved_sessions: Vec<Session>,
    sessions_status: String,
    _session_catalog_task: Task<()>,
}

fn terminal_key_bytes(key: &Keystroke) -> Option<Vec<u8>> {
    if key.modifiers.platform {
        return None;
    }
    // GPUI reports key_char=None for nonprintable keys. Such keys must
    // be processed before checking IME composition state.
    if key.modifiers.control {
        let character = key.key.as_bytes();
        if character.len() == 1 && character[0].is_ascii_alphabetic() {
            return Some(vec![character[0].to_ascii_uppercase() - b'A' + 1]);
        }
        return None;
    }
    let control_sequence: Option<&str> = match key.key.as_str() {
        "enter" => Some("\r"),
        "backspace" => Some("\x7f"),
        "tab" => Some("\t"),
        "escape" => Some("\x1b"),
        "up" => Some("\x1b[A"),
        "down" => Some("\x1b[B"),
        "right" => Some("\x1b[C"),
        "left" => Some("\x1b[D"),
        "home" => Some("\x1b[H"),
        "end" => Some("\x1b[F"),
        "delete" => Some("\x1b[3~"),
        "pageup" => Some("\x1b[5~"),
        "pagedown" => Some("\x1b[6~"),
        _ => None,
    };
    if let Some(sequence) = control_sequence {
        return Some(sequence.as_bytes().to_vec());
    }
    if key.is_ime_in_progress() {
        return None;
    }
    let character = key.key_char.as_ref()?;
    let bytes = character.as_bytes();
    if key.modifiers.alt {
        return Some([b"\x1b".as_slice(), bytes].concat());
    }
    Some(bytes.to_vec())
}

impl Workspace {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let viewport = window.viewport_size();
        let size = terminal_size_for_viewport(
            f32::from(viewport.width), f32::from(viewport.height),
        );
        let subscription = cx.observe_window_bounds(window, |view, window, cx| {
            let size = window.viewport_size();
            view.resize_to_viewport(f32::from(size.width), f32::from(size.height), cx);
        });
        let catalog_task = Self::spawn_catalog_load(cx);

        let initial_id = 1;
        let initial = match start_from_environment(size) {
            Ok(Some(remote)) => {
                let mut tab = TerminalTab::remote(initial_id, "SSH test".into(), None, size);
                tab.task = Some(Self::spawn_remote(initial_id, remote, cx));
                tab
            }
            Ok(None) => {
                let mut tab = TerminalTab::local(initial_id, size);
                tab.task = Some(Self::spawn_local(initial_id, size, cx));
                tab
            }
            Err(error) => {
                let mut tab = TerminalTab::remote(initial_id, "SSH error".into(), None, size);
                tab.remote_phase = RemotePhase::Disconnected;
                tab.status = format!("SSH preview configuration error: {error}");
                tab
            }
        };
        // The worker's GPUI task is retained by the tab for its whole lifetime.
        // It remains alive while the user looks at a different tab.
        Self {
            tabs: vec![initial],
            active_id: initial_id,
            next_tab_id: initial_id + 1,
            pending_close: None,
            split: None,
            viewport_width: f32::from(viewport.width),
            viewport_height: f32::from(viewport.height),
            _resize_subscription: subscription,
            focus_handle: cx.focus_handle(),
            saved_sessions: Vec::new(),
            sessions_status: "Loading saved sessions...".into(),
            _session_catalog_task: catalog_task,
        }
    }

    fn tab_mut(&mut self, id: u64) -> Option<&mut TerminalTab> {
        self.tabs.iter_mut().find(|tab| tab.id == id)
    }

    fn active_tab(&self) -> &TerminalTab {
        self.tabs.iter().find(|tab| tab.id == self.active_id)
            .expect("workspace must always have an active tab")
    }

    fn active_tab_mut(&mut self) -> &mut TerminalTab {
        let id = self.active_id;
        self.tab_mut(id).expect("workspace must always have an active tab")
    }

    fn spawn_catalog_load(cx: &mut Context<Self>) -> Task<()> {
        let work = cx.background_spawn(async {
            let database = native_database_path().map_err(|err| err.to_string())?;
            if !database.exists() { return Ok::<Vec<Session>, String>(Vec::new()); }
            SessionStore::open(database)
                .map_err(|err| err.to_string())?
                .list()
                .map_err(|err| err.to_string())
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |view, cx| {
                match result {
                    Ok(sessions) => {
                        view.sessions_status = format!("{} saved SSH sessions", sessions.len());
                        view.saved_sessions = sessions;
                    }
                    Err(err) => view.sessions_status = format!("Session list unavailable: {err}"),
                }
                cx.notify();
            });
        })
    }

    fn refresh_sessions(&mut self, cx: &mut Context<Self>) {
        self._session_catalog_task = Self::spawn_catalog_load(cx);
        self.sessions_status = "Refreshing saved sessions...".into();
        cx.notify();
    }

    fn spawn_local(id: u64, size: TerminalSize, cx: &mut Context<Self>) -> Task<()> {
        let start = cx.background_spawn(async move {
            LocalTerminal::spawn(LocalShell::PowerShell, size)
        });
        cx.spawn(async move |this, cx| {
            match start.await {
                Ok(mut local) => {
                    let Some(mut output) = local.take_output() else { return; };
                    if this.update(cx, |view, cx| {
                        if let Some(tab) = view.tab_mut(id) {
                            let result = local.resize(tab.terminal.size());
                            tab.local = Some(local);
                            tab.status = result
                                .map(|_| "PowerShell connected".to_owned())
                                .unwrap_or_else(|err| format!("PowerShell resize failed: {err}"));
                            cx.notify();
                        }
                    }).is_err() { return; }

                    while let Some(mut bytes) = output.recv().await {
                        for _ in 0..7 {
                            match output.try_recv() {
                                Ok(part) => bytes.extend_from_slice(&part),
                                Err(_) => break,
                            }
                        }
                        if this.update(cx, |view, cx| {
                            if let Some(tab) = view.tab_mut(id) {
                                for reply in tab.terminal.feed_pty_replies(&bytes) {
                                    if let Some(local) = &tab.local {
                                        if local.try_write(reply).is_err() {
                                            tab.status = "Local input queue is closed/full".into();
                                        }
                                    }
                                }
                                if view.is_visible_tab(id) { cx.notify(); }
                            }
                        }).is_err() { break; }
                    }
                    let _ = this.update(cx, |view, cx| {
                        if let Some(tab) = view.tab_mut(id) {
                            tab.local = None;
                            tab.status = "Local terminal exited".into();
                            cx.notify();
                        }
                    });
                }
                Err(err) => {
                    let _ = this.update(cx, |view, cx| {
                        if let Some(tab) = view.tab_mut(id) {
                            tab.status = format!("Could not start PowerShell: {err}");
                            cx.notify();
                        }
                    });
                }
            }
        })
    }

    fn spawn_remote(id: u64, mut remote: SshPreview, cx: &mut Context<Self>) -> Task<()> {
        let commands = remote.commands.clone();
        let cancel = remote.cancel.clone();
        cx.spawn(async move |this, cx| {
            if this.update(cx, |view, cx| {
                if let Some(tab) = view.tab_mut(id) {
                    tab.remote_commands = Some(commands);
                    tab.remote_cancel = Some(cancel);
                    if view.is_visible_tab(id) { cx.notify(); }
                }
            }).is_err() { return; }

            let mut output_open = true;
            let mut status_open = true;
            while output_open || status_open {
                tokio::select! {
                    message = remote.output.recv(), if output_open => match message {
                        Some(mut bytes) => {
                            for _ in 0..7 {
                                match remote.output.try_recv() {
                                    Ok(chunk) => bytes.extend_from_slice(&chunk),
                                    Err(_) => break,
                                }
                            }
                            if this.update(cx, |view, cx| {
                                if let Some(tab) = view.tab_mut(id) {
                                    for reply in tab.terminal.feed_pty_replies(&bytes) {
                                        if let Some(tx) = &tab.remote_commands {
                                            let _ = tx.try_send(SshTerminalCommand::Input(reply));
                                        }
                                    }
                                    if view.is_visible_tab(id) { cx.notify(); }
                                }
                            }).is_err() { break; }
                        }
                        None => output_open = false,
                    },
                    state = remote.status.recv(), if status_open => match state {
                        Some(PreviewStatus::Connected) => {
                            let _ = this.update(cx, |view, cx| {
                                if let Some(tab) = view.tab_mut(id) {
                                    if let Some(tx) = &tab.remote_commands {
                                        let size = tab.terminal.size();
                                        let _ = tx.try_send(SshTerminalCommand::resize(
                                            size.columns, size.rows,
                                        ));
                                    }
                                    tab.status = "SSH connected · pinned host key".into();
                                    tab.remote_phase = RemotePhase::Connected;
                                    cx.notify();
                                }
                            });
                        }
                        Some(PreviewStatus::Finished(code)) => {
                            let _ = this.update(cx, |view, cx| {
                                if let Some(tab) = view.tab_mut(id) {
                                    tab.status = format!("SSH closed · exit status {code:?}");
                                    tab.remote_phase = RemotePhase::Disconnected;
                                    tab.remote_commands = None;
                                    tab.remote_cancel = None;
                                    cx.notify();
                                }
                            });
                        }
                        Some(PreviewStatus::Failed(err)) => {
                            let _ = this.update(cx, |view, cx| {
                                if let Some(tab) = view.tab_mut(id) {
                                    tab.status = format!("SSH error: {err}");
                                    tab.remote_phase = RemotePhase::Disconnected;
                                    tab.remote_commands = None;
                                    tab.remote_cancel = None;
                                    cx.notify();
                                }
                            });
                        }
                        None => status_open = false,
                    }
                }
            }
            let _ = this.update(cx, |view, cx| {
                if let Some(tab) = view.tab_mut(id) {
                    tab.remote_commands = None;
                    tab.remote_cancel = None;
                    if tab.remote_phase != RemotePhase::Disconnected {
                        tab.remote_phase = RemotePhase::Disconnected;
                        tab.status = "SSH channel ended".into();
                    }
                    cx.notify();
                }
            });
        })
    }

    fn add_local_tab(&mut self, cx: &mut Context<Self>) {
        let id = self.next_tab_id;
        self.next_tab_id += 1;
        let size = terminal_size_for_viewport(self.viewport_width, self.viewport_height);
        let mut tab = TerminalTab::local(id, size);
        tab.task = Some(Self::spawn_local(id, size, cx));
        self.tabs.push(tab);
        self.active_id = id;
        self.split = None;
        self.resize_to_viewport(self.viewport_width, self.viewport_height, cx);
        cx.notify();
    }

    fn add_ssh_tab(&mut self, session_id: String, cx: &mut Context<Self>) {
        let size = terminal_size_for_viewport(self.viewport_width, self.viewport_height);
        match start_saved_session(session_id.clone(), size) {
            Ok(remote) => {
                let id = self.next_tab_id;
                self.next_tab_id += 1;
                let title = self.saved_sessions.iter().find(|s| s.id == session_id)
                    .map(|s| s.name.clone())
                    .unwrap_or(session_id.clone());
                let mut tab = TerminalTab::remote(id, title, Some(session_id), size);
                tab.task = Some(Self::spawn_remote(id, remote, cx));
                self.tabs.push(tab);
                self.active_id = id;
                self.split = None;
                self.resize_to_viewport(self.viewport_width, self.viewport_height, cx);
            }
            Err(err) => self.active_tab_mut().status = format!("SSH start failed: {err}"),
        }
        cx.notify();
    }

    fn activate_tab(&mut self, id: u64, cx: &mut Context<Self>) {
        if self.tabs.iter().any(|tab| tab.id == id) {
            self.active_id = id;
            if self.split.is_some_and(|split| !split.contains(id)) {
                self.split = None;
            }
            self.resize_to_viewport(self.viewport_width, self.viewport_height, cx);
            cx.notify();
        }
    }

    fn cycle_active_tab(&mut self, direction: i32, cx: &mut Context<Self>) {
        let ids: Vec<_> = self.tabs.iter().map(|tab| tab.id).collect();
        if let Some(next) = cycle_id(&ids, self.active_id, direction) {
            self.activate_tab(next, cx);
        }
    }

    fn request_close_tab(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.iter().find(|tab| tab.id == id) else { return; };
        let connected = tab.local.is_some()
            || matches!(tab.remote_phase,
                RemotePhase::Connecting | RemotePhase::Connected | RemotePhase::Disconnecting);
        if connected {
            self.pending_close = Some(id);
            cx.notify();
        } else {
            self.close_tab(id, cx);
        }
    }

    fn confirm_close_tab(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.pending_close.take() {
            self.close_tab(id, cx);
        }
    }

    fn cancel_close_tab(&mut self, cx: &mut Context<Self>) {
        self.pending_close = None;
        cx.notify();
    }

    fn close_tab(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(index) = self.tabs.iter().position(|tab| tab.id == id) else { return; };
        let size = self.tabs[index].terminal.size();
        if self.pending_close == Some(id) { self.pending_close = None; }
        if self.split.is_some_and(|split| split.contains(id)) {
            self.split = None;
        }
        let removed = self.tabs.remove(index);
        drop(removed);
        if self.tabs.is_empty() {
            // add_local_tab assumes an active tab; initialize the last-tab
            // fallback directly so closing the final tab cannot panic.
            let new_id = self.next_tab_id;
            self.next_tab_id += 1;
            let mut tab = TerminalTab::local(new_id, size);
            tab.task = Some(Self::spawn_local(new_id, size, cx));
            self.tabs.push(tab);
            self.active_id = new_id;
        } else if self.active_id == id {
            self.active_id = self.tabs[index.min(self.tabs.len() - 1)].id;
        }
        self.resize_to_viewport(self.viewport_width, self.viewport_height, cx);
        cx.notify();
    }

    fn cancel_active_remote(&mut self, cx: &mut Context<Self>) {
        let tab = self.active_tab_mut();
        tab.cancel_transport();
        tab.remote_phase = RemotePhase::Disconnected;
        tab.status = "SSH operation cancelled".into();
        cx.notify();
    }

    fn remote_primary_action(&mut self, cx: &mut Context<Self>) {
        match self.active_tab().remote_phase {
            RemotePhase::Local => self.add_local_tab(cx),
            RemotePhase::Connecting | RemotePhase::Disconnecting => self.cancel_active_remote(cx),
            RemotePhase::Connected => {
                let tab = self.active_tab_mut();
                if tab.remote_commands.as_ref().is_some_and(|tx| {
                    tx.try_send(SshTerminalCommand::Close).is_ok()
                }) {
                    tab.remote_phase = RemotePhase::Disconnecting;
                    tab.status = "Disconnecting SSH...".into();
                    cx.notify();
                } else {
                    self.cancel_active_remote(cx);
                }
            }
            RemotePhase::Disconnected => {
                let saved = self.active_tab().session_id.clone();
                if let Some(saved) = saved {
                    // Reconnect in the same tab, keeping its identity.
                    let size = self.active_tab().terminal.size();
                    match start_saved_session(saved, size) {
                        Ok(remote) => {
                            let id = self.active_id;
                            let task = Self::spawn_remote(id, remote, cx);
                            let tab = self.active_tab_mut();
                            tab.cancel_transport();
                            tab.terminal = TerminalEngine::new(size);
                            tab.remote_phase = RemotePhase::Connecting;
                            tab.status = "Reconnecting SSH...".into();
                            tab.task = Some(task);
                        }
                        Err(err) => self.active_tab_mut().status = format!("Reconnect failed: {err}"),
                    }
                    cx.notify();
                } else {
                    self.add_local_tab(cx);
                }
            }
        }
    }

    fn visible_tab_ids(&self) -> Vec<u64> {
        if let Some(split) = self.split {
            split.ids().to_vec()
        } else {
            vec![self.active_id]
        }
    }

    fn is_visible_tab(&self, id: u64) -> bool {
        self.active_id == id || self.split.is_some_and(|split| split.contains(id))
    }

    fn split_with(&mut self, second_id: u64, axis: SplitAxis, cx: &mut Context<Self>) {
        if !self.tabs.iter().any(|tab| tab.id == second_id) { return; }
        if let Some(split) = SplitView::new(self.active_id, second_id, axis) {
            self.split = Some(split);
            self.resize_to_viewport(self.viewport_width, self.viewport_height, cx);
            cx.notify();
        }
    }

    fn clear_split(&mut self, cx: &mut Context<Self>) {
        if self.split.take().is_some() {
            self.resize_to_viewport(self.viewport_width, self.viewport_height, cx);
            cx.notify();
        }
    }

    fn resize_to_viewport(&mut self, width: f32, height: f32, cx: &mut Context<Self>) {
        self.viewport_width = width;
        self.viewport_height = height;
        let full_size = terminal_size_for_viewport(width, height);
        let split_size = self.split.map(|split| terminal_size_for_split(width, height, split.axis));
        let mut changed = false;
        for tab in &mut self.tabs {
            let size = match (self.split, split_size) {
                (Some(split), Some(half)) if split.contains(tab.id) => half,
                _ => full_size,
            };
            if tab.terminal.size() == size { continue; }
            tab.terminal.resize(size);
            if let Some(local) = &tab.local {
                if let Err(err) = local.resize(size) {
                    tab.status = format!("ConPTY resize failed: {err}");
                }
            }
            if let Some(tx) = &tab.remote_commands {
                if tx.try_send(SshTerminalCommand::resize(size.columns, size.rows)).is_err() {
                    tab.status = "SSH resize queue full/closed".into();
                }
            }
            changed = true;
        }
        if changed { cx.notify(); }
    }

    fn send_input(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        let tab = self.active_tab_mut();
        if tab.is_remote() {
            if tab.remote_phase != RemotePhase::Connected { return; }
            if let Some(tx) = &tab.remote_commands {
                if tx.try_send(SshTerminalCommand::Input(bytes)).is_err() {
                    tab.status = "SSH input queue full/closed".into();
                    cx.notify();
                }
            }
        } else if let Some(local) = &tab.local {
            if local.try_write(bytes).is_err() {
                tab.status = "ConPTY input queue full/closed".into();
                cx.notify();
            }
        }
    }

    fn scroll_active(&mut self, lines: i32, cx: &mut Context<Self>) {
        if lines != 0 {
            self.active_tab_mut().terminal.scroll_history(lines);
            cx.notify();
        }
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}


impl Workspace {
    /// Render an existing terminal tab in a pane without duplicating its
    /// SSH, ConPTY, scrollback, or async task state.
    fn render_terminal_pane(
        &self,
        pane_id: u64,
        pane_index: usize,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let tab = self.tabs.iter().find(|tab| tab.id == pane_id)
            .expect("visible pane must reference an existing tab");
        let rows = tab.terminal.render_cells();
        let status = tab.status.clone();
        let title = tab.title.clone();
        let phase = tab.remote_phase;
        let saved = tab.session_id.is_some();
        let selected = pane_id == self.active_id;

        div()
            .id(("terminal-pane", pane_index))
            .flex_1()
            .flex()
            .flex_col()
            .bg(rgb(if selected { 0x101823 } else { 0x090d12 }))
            .on_scroll_wheel(cx.listener(move |view, event: &ScrollWheelEvent, _, cx| {
                let pixels = f32::from(event.delta.pixel_delta(px(CELL_HEIGHT)).y);
                let Some(tab) = view.tab_mut(pane_id) else { return };
                tab.scroll_remainder += pixels / CELL_HEIGHT;
                let lines = tab.scroll_remainder.trunc() as i32;
                tab.scroll_remainder -= lines as f32;
                tab.terminal.scroll_history(lines);
                if lines != 0 { cx.notify(); }
            }))
            .on_click(cx.listener(move |view, _, window, cx| {
                view.activate_tab(pane_id, cx);
                window.focus(&view.focus_handle(cx));
            }))
            .child(
                div()
                    .h(px(TOOLBAR_HEIGHT))
                    .px_4()
                    .flex()
                    .items_center()
                    .justify_between()
                    .bg(rgb(if selected { 0x203248 } else { 0x161c25 }))
                    .child(format!("{title} · {status}"))
                    .child(
                        div()
                            .id(("pane-lifecycle", pane_index))
                            .px_3()
                            .py_1()
                            .rounded_md()
                            .bg(rgb(0x29435d))
                            .cursor_pointer()
                            .child(remote_button_label(phase, saved))
                            .on_click(cx.listener(move |view, _, _, cx| {
                                view.activate_tab(pane_id, cx);
                                view.remote_primary_action(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .p_4()
                    .text_size(px(14.0))
                    .font_family("Consolas")
                    .flex()
                    .flex_col()
                    .children(rows.into_iter().map(|cells| {
                        div()
                            .h(px(CELL_HEIGHT))
                            .child(styled_terminal_line(&cells))
                    })),
            )
    }
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tabs: Vec<_> = self.tabs.iter().map(|t| {
            (t.id, t.title.clone(), t.remote_phase, t.id == self.active_id)
        }).collect();
        let sessions: Vec<_> = self.saved_sessions.iter().map(|session| {
            (
                session.id.clone(),
                format!("{}\n{}@{}:{}", session.name, session.username, session.host, session.port),
            )
        }).collect();
        let sessions_status = self.sessions_status.clone();
        let close_prompt = self.pending_close.and_then(|id| {
            self.tabs.iter().find(|tab| tab.id == id)
                .map(|tab| tab.title.clone())
        });
        let split = self.split;
        let pane_nodes: Vec<_> = self.visible_tab_ids()
            .into_iter()
            .enumerate()
            .map(|(index, id)| self.render_terminal_pane(id, index, cx))
            .collect();
        let pane_layout = if split.is_some_and(|s| s.axis == SplitAxis::Horizontal) {
            div().flex().flex_1().flex_col().gap_1()
        } else {
            div().flex().flex_1().flex_row().gap_1()
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0x0d1117))
            .text_color(rgb(0xdbe3ed))
            .child(
                div()
                    .h(px(46.0))
                    .px_4()
                    .flex()
                    .items_center()
                    .bg(rgb(0x161c25))
                    .child(if let Some(label) = close_prompt {
                        div()
                            .id("pending-close-banner")
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(format!("Close connected terminal '{label}'?"))
                            .child(
                                div()
                                    .id("confirm-close-terminal")
                                    .px_3()
                                    .py_1()
                                    .rounded_md()
                                    .bg(rgb(0x7b3434))
                                    .cursor_pointer()
                                    .child("Close connection")
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.confirm_close_tab(cx);
                                    })),
                            )
                            .child(
                                div()
                                    .id("cancel-close-terminal")
                                    .px_3()
                                    .py_1()
                                    .rounded_md()
                                    .bg(rgb(0x29435d))
                                    .cursor_pointer()
                                    .child("Cancel")
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.cancel_close_tab(cx);
                                    })),
                            )
                    } else {
                        div()
                            .id("normal-window-title")
                            .child("OpenShell Native 2.0 · Split terminal prototype")
                    }),
            )
            .child(
                div()
                    .id("terminal-tab-strip")
                    .h(px(TABBAR_HEIGHT))
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .bg(rgb(0x192231))
                    .overflow_x_scroll()
                    .children(tabs.into_iter().enumerate().map(
                        |(index, (id, label, phase, active))| {
                            div()
                                .id(("terminal-tab", index))
                                .flex()
                                .items_center()
                                .gap_2()
                                .px_2()
                                .py_1()
                                .bg(rgb(if active { 0x29435d } else { 0x202a39 }))
                                .rounded_md()
                                .child(
                                    div()
                                        .id(("terminal-tab-select", index))
                                        .cursor_pointer()
                                        .text_size(px(12.0))
                                        .child(format!("{} · {}", label, match phase {
                                            RemotePhase::Local => "Local",
                                            RemotePhase::Connecting => "Connecting",
                                            RemotePhase::Connected => "SSH",
                                            RemotePhase::Disconnecting => "Closing",
                                            RemotePhase::Disconnected => "Offline",
                                        }))
                                        .on_click(cx.listener(move |view, _, window, cx| {
                                            view.activate_tab(id, cx);
                                            window.focus(&view.focus_handle(cx));
                                        })),
                                )
                                .child(
                                    div()
                                        .id(("split-right", index))
                                        .cursor_pointer()
                                        .text_size(px(11.0))
                                        .child("Split ↔")
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.split_with(id, SplitAxis::Vertical, cx);
                                        })),
                                )
                                .child(
                                    div()
                                        .id(("split-below", index))
                                        .cursor_pointer()
                                        .text_size(px(11.0))
                                        .child("Split ↕")
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.split_with(id, SplitAxis::Horizontal, cx);
                                        })),
                                )
                                .child(
                                    div()
                                        .id(("terminal-tab-close", index))
                                        .cursor_pointer()
                                        .px_1()
                                        .text_size(px(12.0))
                                        .child("×")
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.request_close_tab(id, cx);
                                        })),
                                )
                        },
                    ))
                    .child(
                        div()
                            .id("new-local-tab")
                            .cursor_pointer()
                            .px_3()
                            .child("+ Local")
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.add_local_tab(cx);
                            })),
                    )
                    .child(
                        div()
                            .id("unsplit-panes")
                            .cursor_pointer()
                            .px_3()
                            .child(if split.is_some() { "Unsplit" } else { "Single view" })
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.clear_split(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .flex()
                    .child(
                        div()
                            .w(px(SIDEBAR_WIDTH))
                            .p_4()
                            .bg(rgb(0x121822))
                            .flex()
                            .flex_col()
                            .gap_3()
                            .child("Saved SSH sessions")
                            .child(sessions_status)
                            .child(
                                div()
                                    .id("refresh-sessions")
                                    .cursor_pointer()
                                    .px_2()
                                    .py_1()
                                    .rounded_md()
                                    .bg(rgb(0x29435d))
                                    .child("Refresh list")
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.refresh_sessions(cx);
                                    })),
                            )
                            .children(sessions.into_iter().enumerate().map(
                                |(index, (id, label))| {
                                    div()
                                        .id(("saved-ssh-session", index))
                                        .p_2()
                                        .rounded_md()
                                        .cursor_pointer()
                                        .bg(rgb(0x1d2633))
                                        .text_size(px(12.0))
                                        .child(label)
                                        .on_click(cx.listener(move |view, _, window, cx| {
                                            view.add_ssh_tab(id.clone(), cx);
                                            window.focus(&view.focus_handle(cx));
                                        }))
                                },
                            )),
                    )
                    .child(
                        div()
                            .id("terminal-keyboard-region")
                            .flex_1()
                            .flex()
                            .flex_col()
                            .key_context("OpenShellTerminal")
                            .track_focus(&self.focus_handle)
                            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                if event.keystroke.modifiers.control {
                                    match event.keystroke.key.as_str() {
                                        "tab" => {
                                            let direction = if event.keystroke.modifiers.shift { -1 } else { 1 };
                                            view.cycle_active_tab(direction, cx);
                                            return;
                                        }
                                        "w" => {
                                            let id = view.active_id;
                                            view.request_close_tab(id, cx);
                                            return;
                                        }
                                        "t" => { view.add_local_tab(cx); return; }
                                        _ => {}
                                    }
                                }
                                if event.keystroke.modifiers.shift
                                    && !view.active_tab().terminal.in_alternate_screen()
                                {
                                    let page = view.active_tab().terminal.size().rows as i32;
                                    match event.keystroke.key.as_str() {
                                        "pageup" => { view.scroll_active(page, cx); return; }
                                        "pagedown" => { view.scroll_active(-page, cx); return; }
                                        _ => {}
                                    }
                                }
                                if let Some(bytes) = terminal_key_bytes(&event.keystroke) {
                                    view.send_input(bytes, cx);
                                }
                            }))
                            .child(pane_layout.children(pane_nodes)),
                    ),
            )
    }
}

fn main() {
    tracing_subscriber::fmt::init();

    Application::new().run(|cx: &mut App| {
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(
                Bounds::centered(None, size(px(1200.0), px(760.0)), cx),
            )),
            ..Default::default()
        };
        let window = cx
            .open_window(options, |window, cx| cx.new(|cx| Workspace::new(window, cx)))
            .expect("failed to open OpenShell native window");
        window.update(cx, |view, window, cx| {
            window.focus(&view.focus_handle(cx));
        }).expect("failed to focus native terminal");
        cx.activate(true);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Modifiers;

    #[test]
    fn lifecycle_button_labels_match_ssh_state() {
        assert_eq!(remote_button_label(RemotePhase::Connecting, true), "Cancel connection");
        assert_eq!(remote_button_label(RemotePhase::Connected, true), "Disconnect SSH");
        assert_eq!(remote_button_label(RemotePhase::Disconnecting, true), "Force cancel");
        assert_eq!(remote_button_label(RemotePhase::Disconnected, true), "Reconnect SSH");
        assert_eq!(remote_button_label(RemotePhase::Disconnected, false), "SSH disconnected");
    }

    #[test]
    fn tabs_cycle_both_ways_without_touching_other_terminal_state() {
        assert_eq!(cycle_id(&[2, 4, 6], 4, 1), Some(6));
        assert_eq!(cycle_id(&[2, 4, 6], 6, 1), Some(2));
        assert_eq!(cycle_id(&[2, 4, 6], 2, -1), Some(6));
        assert_eq!(cycle_id(&[], 1, 1), None);
    }

    #[test]
    fn multiple_terminal_tabs_have_independent_alacritty_buffers() {
        let size = TerminalSize::new(30, 5);
        let mut first = TerminalTab::local(1, size);
        let mut second = TerminalTab::local(2, size);
        first.terminal.feed(b"FIRST");
        second.terminal.feed(b"SECOND");
        assert_eq!(first.terminal.visible_lines()[0], "FIRST");
        assert_eq!(second.terminal.visible_lines()[0], "SECOND");
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn viewport_grid_tracks_size_and_clamps() {
        let small = terminal_size_for_viewport(100.0, 100.0);
        assert_eq!(small, TerminalSize::new(2, 1));
        let large = terminal_size_for_viewport(1200.0, 760.0);
        assert!(large.columns > 80);
        assert!(large.rows > 26);
        assert_eq!(terminal_size_for_viewport(1200.0, 760.0), large);
        assert_eq!(terminal_size_for_viewport(f32::NAN, f32::INFINITY), small);
        let huge = terminal_size_for_viewport(100_000.0, 100_000.0);
        assert_eq!(huge, TerminalSize::new(MAX_COLUMNS, MAX_ROWS));
    }

    #[test]
    fn ascii_and_control_keys_encode_as_terminal_bytes() {
        let enter = Keystroke { key: "enter".into(), key_char: None, modifiers: Modifiers::none() };
        assert_eq!(terminal_key_bytes(&enter), Some(vec![b'\r']));

        let ctrl_c = Keystroke { key: "c".into(), key_char: None, modifiers: Modifiers::control() };
        assert_eq!(terminal_key_bytes(&ctrl_c), Some(vec![3]));
        let plain = Keystroke { key: "a".into(), key_char: Some("a".into()), modifiers: Modifiers::none() };
        assert_eq!(terminal_key_bytes(&plain), Some(vec![b'a']));
        let arrow = Keystroke { key: "up".into(), key_char: None, modifiers: Modifiers::none() };
        assert_eq!(terminal_key_bytes(&arrow), Some(b"\x1b[A".to_vec()));
    }
}
