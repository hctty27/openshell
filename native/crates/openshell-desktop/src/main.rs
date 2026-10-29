use gpui::prelude::*;
use gpui::{
    div, px, rgb, size, App, Application, Bounds, Context, IntoElement,
    Render, Window, WindowBounds, WindowOptions,
};
use openshell_core::{TerminalEngine, TerminalSize};

struct Workspace {
    terminal: TerminalEngine,
    sample_count: usize,
}

impl Workspace {
    fn new() -> Self {
        let mut terminal = TerminalEngine::new(TerminalSize::new(80, 26));
        terminal.feed(b"OpenShell Native 2.0 - ANSI parser preview\r\n");
        terminal.feed(b"\x1b[32mRust + GPUI + Alacritty Terminal\x1b[0m\r\n");
        terminal.feed(b"Terminal model runs without JavaScript or WebView2.\r\n\r\n");
        terminal.feed(b"Click 'Replay ANSI output' to test incremental output.\r\n");
        Self { terminal, sample_count: 0 }
    }
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lines = self.terminal.visible_lines();

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
                    .child("OpenShell Native  |  Terminal prototype"),
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
                            .child("Sessions (coming later)"),
                    )
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .bg(rgb(0x090d12))
                            .child(
                                div()
                                    .h(px(40.0))
                                    .px_4()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .bg(rgb(0x161c25))
                                    .child("Terminal grid preview (read-only)")
                                    .child(
                                        div()
                                            .id("replay-ansi")
                                            .px_3()
                                            .py_1()
                                            .rounded_md()
                                            .bg(rgb(0x29435d))
                                            .cursor_pointer()
                                            .child("Replay ANSI output")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.sample_count += 1;
                                                let line = format!(
                                                    "\r\n\x1b[36m[{count:03}] Output from ANSI emulator\x1b[0m",
                                                    count = this.sample_count,
                                                );
                                                this.terminal.feed(line.as_bytes());
                                                cx.notify();
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
                                    .children(lines.into_iter().map(|line| {
                                        div()
                                            .h(px(19.0))
                                            .child(if line.is_empty() { " ".to_string() } else { line })
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
        cx.open_window(options, |_window, cx| cx.new(|_| Workspace::new()))
            .expect("failed to open OpenShell native window");
        cx.activate(true);
    });
}
