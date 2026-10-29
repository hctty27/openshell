use gpui::prelude::*;
use gpui::{
    div, px, rgb, size, App, Application, Bounds, Context, FocusHandle, Focusable,
    IntoElement, KeyDownEvent, Keystroke, Render, Task, Window, WindowBounds,
    WindowOptions, HighlightStyle, StyledText, FontWeight,
};
use openshell_core::{LocalShell, LocalTerminal, TerminalEngine, TerminalSize};
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

struct Workspace {
    terminal: TerminalEngine,
    local: Option<LocalTerminal>,
    _startup_task: Task<()>,
    focus_handle: FocusHandle,
    status: String,
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
    fn new(cx: &mut Context<Self>) -> Self {
        let size = TerminalSize::new(80, 26);
        let background = cx.background_spawn(async move {
            LocalTerminal::spawn(LocalShell::PowerShell, size)
        });
        let startup = cx.spawn(async move |this, cx| {
            match background.await {
                Ok(mut local) => {
                    let Some(mut rx) = local.take_output() else { return };
                    if this.update(cx, |view, cx| {
                        view.local = Some(local);
                        view.status = "PowerShell connected · experimental ConPTY".into();
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
        Self {
            terminal: TerminalEngine::new(size),
            local: None,
            _startup_task: startup,
            focus_handle: cx.focus_handle(),
            status: "Starting PowerShell...".into(),
        }
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
                    .child("OpenShell Native  |  Local Terminal"),
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
                            .child("SSH Sessions (coming later)"),
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
                                let Some(data) = terminal_key_bytes(&event.keystroke) else { return };
                                if let Some(local) = &this.local {
                                    if local.try_write(data).is_err() {
                                        this.status = "Terminal input queue full or closed".into();
                                        cx.notify();
                                    }
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
            .open_window(options, |_window, cx| cx.new(Workspace::new))
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
