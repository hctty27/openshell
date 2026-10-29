mod ssh_preview;

use gpui::prelude::*;
use gpui::{
    div, px, rgb, size, App, Application, Bounds, Context, FocusHandle, Focusable,
    IntoElement, KeyDownEvent, Keystroke, Render, Task, Window, WindowBounds,
    WindowOptions, HighlightStyle, StyledText, FontWeight, Subscription, ScrollWheelEvent,
};
use openshell_core::{LocalShell, LocalTerminal, Session, SessionStore, SshTerminalCommand, TerminalEngine, TerminalSize};
use openshell_core::native_paths::native_database_path;
use ssh_preview::{PreviewStatus, start_from_environment};
use tokio::sync::mpsc;
use openshell_core::terminal::RenderCell;


/// Diagnostic text styling; the production terminal will paint cells directly.
fn styled_terminal_line(cells: &[RenderCell]) -> StyledText {
    let mut text = String::with_capacity(cells.len() * 2);
    let mut highlights = Vec::new();
    let mut last_style: Option<(u32, u32, bool)> = None;
    let mut start = 0;

    for cell in cells {
        let (fg, bg) = if cell.cursor { (cell.bg, cell.fg) } else { (cell.fg, cell.bg) };
        let style = (fg, bg, cell.bold);
        if last_style.is_some_and(|previous| previous != style) {
            let previous = last_style.expect("previous style");
            if start != text.len() {
                highlights.push((start..text.len(), HighlightStyle {
                    color: Some(rgb(previous.0).into()),
                    background_color: Some(rgb(previous.1).into()),
                    font_weight: previous.2.then_some(FontWeight::BOLD),
                    ..Default::default()
                }));
            }
            start = text.len();
        }
        last_style = Some(style);
        text.push_str(&cell.text);
    }

    if let Some(style) = last_style {
        if start != text.len() {
            highlights.push((start..text.len(), HighlightStyle {
                color: Some(rgb(style.0).into()),
                background_color: Some(rgb(style.1).into()),
                font_weight: style.2.then_some(FontWeight::BOLD),
                ..Default::default()
            }));
        }
    }
    StyledText::new(text).with_highlights(highlights)
}


// Temporary viewport metrics for the diagnostic text renderer.
// The final renderer must derive cell dimensions from shaped glyph metrics.
const SIDEBAR_WIDTH: f32 = 244.0;
const TITLEBAR_HEIGHT: f32 = 46.0;
const TOOLBAR_HEIGHT: f32 = 40.0;
const CONTENT_PADDING: f32 = 32.0;
const CELL_WIDTH: f32 = 8.5;
const CELL_HEIGHT: f32 = 19.0;
const MAX_COLUMNS: usize = 500;
const MAX_ROWS: usize = 300;

fn terminal_size_for_viewport(width: f32, height: f32) -> TerminalSize {
    // On window minimization and invalid geometry, do not create huge grids.
    let width = if width.is_finite() { width.max(0.0) } else { 0.0 };
    let height = if height.is_finite() { height.max(0.0) } else { 0.0 };
    let columns = ((width - SIDEBAR_WIDTH - CONTENT_PADDING) / CELL_WIDTH)
        .floor()
        .max(2.0)
        .min(MAX_COLUMNS as f32) as usize;
    let rows = ((height - TITLEBAR_HEIGHT - TOOLBAR_HEIGHT - CONTENT_PADDING)
        / CELL_HEIGHT)
        .floor()
        .max(1.0)
        .min(MAX_ROWS as f32) as usize;
    TerminalSize::new(columns, rows)
}

struct Workspace {
    terminal: TerminalEngine,
    local: Option<LocalTerminal>,
    remote_commands: Option<mpsc::Sender<SshTerminalCommand>>,
    remote_mode: bool,
    _startup_task: Task<()>,
    _resize_subscription: Subscription,
    focus_handle: FocusHandle,
    status: String,
    scroll_remainder: f32,
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
        let size = terminal_size_for_viewport(f32::from(viewport.width), f32::from(viewport.height));
        let subscription = cx.observe_window_bounds(window, |view, window, cx| {
            let viewport = window.viewport_size();
            view.resize_to_viewport(f32::from(viewport.width), f32::from(viewport.height), cx);
        });
        let catalog_load = cx.background_spawn(async {
            let database = native_database_path().map_err(|err| err.to_string())?;
            if !database.exists() {
                return Ok::<Vec<Session>, String>(Vec::new());
            }
            let store = SessionStore::open(database).map_err(|err| err.to_string())?;
            store.list().map_err(|err| err.to_string())
        });
        let catalog_task = cx.spawn(async move |this, cx| {
            let result = catalog_load.await;
            let _ = this.update(cx, |view, cx| {
                match result {
                    Ok(sessions) => {
                        view.sessions_status = if sessions.is_empty() {
                            "No saved sessions".into()
                        } else {
                            format!("{} saved sessions", sessions.len())
                        };
                        view.saved_sessions = sessions;
                    }
                    Err(error) => {
                        view.sessions_status = format!("Session list unavailable: {error}");
                    }
                }
                cx.notify();
            });
        });
        let (startup, initial_status, remote_mode) = match start_from_environment(size) {
            Ok(Some(mut remote)) => {
                let remote_tx = remote.commands.clone();
                let startup = cx.spawn(async move |this, cx| {
                    if this.update(cx, |view, cx| {
                        view.remote_commands = Some(remote_tx);
                        cx.notify();
                    }).is_err() {
                        return;
                    }

                    let mut output_open = true;
                    let mut status_open = true;
                    while output_open || status_open {
                        tokio::select! {
                            packet = remote.output.recv(), if output_open => {
                                match packet {
                                    Some(mut bytes) => {
                                        // Use the same Alacritty parser for local and remote PTYs.
                                        for _ in 0..7 {
                                            match remote.output.try_recv() {
                                                Ok(chunk) => bytes.extend_from_slice(&chunk),
                                                Err(_) => break,
                                            }
                                        }
                                        if this.update(cx, |view, cx| {
                                            for reply in view.terminal.feed_pty_replies(&bytes) {
                                                if let Some(tx) = &view.remote_commands {
                                                    let _ = tx.try_send(SshTerminalCommand::Input(reply));
                                                }
                                            }
                                            cx.notify();
                                        }).is_err() {
                                            break;
                                        }
                                    }
                                    None => output_open = false,
                                }
                            }
                            state = remote.status.recv(), if status_open => {
                                match state {
                                    Some(PreviewStatus::Connected) => {
                                        let _ = this.update(cx, |view, cx| {
                                            // Cover a window resize that happened during connect.
                                            if let Some(tx) = &view.remote_commands {
                                                let size = view.terminal.size();
                                                let _ = tx.try_send(SshTerminalCommand::resize(size.columns, size.rows));
                                            }
                                            view.status = "SSH connected · pinned host key · debug preview".into();
                                            cx.notify();
                                        });
                                    }
                                    Some(PreviewStatus::Finished(code)) => {
                                        let _ = this.update(cx, |view, cx| {
                                            view.remote_commands = None;
                                            view.status = format!("SSH channel closed · exit status {code:?}");
                                            cx.notify();
                                        });
                                    }
                                    Some(PreviewStatus::Failed(error)) => {
                                        let _ = this.update(cx, |view, cx| {
                                            view.remote_commands = None;
                                            view.status = format!("SSH preview failed: {error}");
                                            cx.notify();
                                        });
                                    }
                                    None => status_open = false,
                                }
                            }
                        }
                    }
                    let _ = this.update(cx, |view, cx| {
                        view.remote_commands = None;
                        cx.notify();
                    });
                });
                (startup, "Connecting to pinned SSH test server...".to_owned(), true)
            }
            Ok(None) => {
            let background = cx.background_spawn(async move {
                LocalTerminal::spawn(LocalShell::PowerShell, size)
            });
            let startup = cx.spawn(async move |this, cx| {
                match background.await {
                    Ok(mut local) => {
                        let Some(mut rx) = local.take_output() else { return };
                        if this.update(cx, |view, cx| {
                            // The window may have resized while ConPTY started.
                            let resize_result = local.resize(view.terminal.size());
                            view.local = Some(local);
                            view.status = match resize_result {
                                Ok(()) => "PowerShell connected · experimental ConPTY".into(),
                                Err(err) => format!("PowerShell connected; ConPTY resize failed: {err}"),
                            };
                            cx.notify();
                        }).is_err() {
                            return;
                        }
                        while let Some(mut bytes) = rx.recv().await {
                            // Coalesce up to eight bounded PTY chunks before UI repaint.
                            for _ in 0..7 {
                                match rx.try_recv() {
                                    Ok(chunk) => bytes.extend_from_slice(&chunk),
                                    Err(_) => break,
                                }
                            }
                            if this.update(cx, |view, cx| {
                                for reply in view.terminal.feed_pty_replies(&bytes) {
                                    if let Some(local) = &view.local {
                                        if local.try_write(reply).is_err() {
                                            view.status = "Terminal reply queue full or closed".into();
                                        }
                                    }
                                }
                                cx.notify();
                            }).is_err() {
                                break;
                            }
                        }
                        let _ = this.update(cx, |view, cx| {
                            view.local = None;
                            view.status = "Local terminal exited".into();
                            cx.notify();
                        });
                    }
                    Err(err) => {
                        let _ = this.update(cx, |view, cx| {
                            view.status = format!("Could not start PowerShell: {err}");
                            cx.notify();
                        });
                    }
                }
            });
                    (startup, "Starting PowerShell...".to_owned(), false)
            }
            Err(error) => {
                let task = cx.spawn(async move |_, _| {});
                (task, format!("SSH preview configuration error: {error}"), true)
            }
        };
        Self {
            terminal: TerminalEngine::new(size),
            local: None,
            remote_commands: None,
            remote_mode,
            _startup_task: startup,
            _resize_subscription: subscription,
            focus_handle: cx.focus_handle(),
            status: initial_status,
            scroll_remainder: 0.0,
            saved_sessions: Vec::new(),
            sessions_status: "Loading saved sessions...".into(),
            _session_catalog_task: catalog_task,
        }
    }

    fn resize_to_viewport(&mut self, width: f32, height: f32, cx: &mut Context<Self>) {
        let size = terminal_size_for_viewport(width, height);
        if size == self.terminal.size() {
            return;
        }
        self.terminal.resize(size);
        if let Some(local) = &self.local {
            if let Err(err) = local.resize(size) {
                self.status = format!("ConPTY resize failed: {err}");
            }
        }
        if let Some(tx) = &self.remote_commands {
            if tx.try_send(SshTerminalCommand::resize(size.columns, size.rows)).is_err() {
                self.status = "SSH resize queue full or closed".into();
            }
        }
        cx.notify();
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.terminal.render_cells();
        let session_rows: Vec<String> = self.saved_sessions.iter().map(|session| {
            format!("{}\n{}@{}:{}", session.name, session.username, session.host, session.port)
        }).collect();
        let sessions_status = self.sessions_status.clone();

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
                    .child(if self.remote_mode { "OpenShell Native  |  SSH Test Terminal" } else { "OpenShell Native  |  Local Terminal" }),
            )
            .child(
                div()
                    .flex_1()
                    .flex()
                    .child(
                        div()
                            .w(px(244.0))
                            .p_4()
                            .bg(rgb(0x121822))
                            .flex()
                            .flex_col()
                            .gap_3()
                            .child("Saved SSH sessions · read-only")
                            .child(sessions_status)
                            .children(session_rows.into_iter().enumerate().map(|(i, label)| {
                                div()
                                    .id(("session-row", i))
                                    .p_2()
                                    .rounded_md()
                                    .bg(rgb(0x1d2633))
                                    .text_size(px(12.0))
                                    .child(label)
                            })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .bg(rgb(0x090d12))
                            .id("terminal-pane")
                            .key_context("OpenShellTerminal")
                            .track_focus(&self.focus_handle)
                            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                                if event.keystroke.modifiers.shift && !this.terminal.in_alternate_screen() {
                                    let page = this.terminal.size().rows as i32;
                                    match event.keystroke.key.as_str() {
                                        "pageup" => { this.terminal.scroll_history(page); cx.notify(); return; }
                                        "pagedown" => { this.terminal.scroll_history(-page); cx.notify(); return; }
                                        _ => {}
                                    }
                                }
                                let Some(data) = terminal_key_bytes(&event.keystroke) else { return };
                                if let Some(tx) = &this.remote_commands {
                                    if tx.try_send(SshTerminalCommand::Input(data)).is_err() {
                                        this.status = "SSH input queue full or closed".into();
                                        cx.notify();
                                    }
                                } else if let Some(local) = &this.local {
                                    if local.try_write(data).is_err() {
                                        this.status = "Terminal input queue full or closed".into();
                                        cx.notify();
                                    }
                                }
                            }))
                            .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, cx| {
                                let delta = f32::from(event.delta.pixel_delta(px(CELL_HEIGHT)).y);
                                this.scroll_remainder += delta / CELL_HEIGHT;
                                let lines = this.scroll_remainder.trunc() as i32;
                                this.scroll_remainder -= lines as f32;
                                if lines != 0 {
                                    this.terminal.scroll_history(lines);
                                    cx.notify();
                                }
                            }))
                            .on_click(cx.listener(|this, _, window, cx| {
                                window.focus(&this.focus_handle(cx));
                            }))
                            .child(
                                div()
                                    .h(px(40.0))
                                    .px_4()
                                    .flex()
                                    .items_center()
                                    .bg(rgb(0x161c25))
                                    .child(self.status.clone()),
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
                                            .h(px(19.0))
                                            .child(styled_terminal_line(&cells))
                                    })),
                            ),
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
