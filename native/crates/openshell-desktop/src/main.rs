use gpui::prelude::*;
use gpui::{
    div, px, rgb, size, App, Application, Bounds, Context, IntoElement,
    Render, Window, WindowBounds, WindowOptions,
};

struct Workspace;

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
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
                    .child("OpenShell Native  |  Rust + GPUI"),
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
                            .child("Sessions"),
                    )
                    .child(
                        div()
                            .flex_1()
                            .p_4()
                            .flex()
                            .flex_col()
                            .gap_3()
                            .child("Terminal workspace")
                            .child("Native terminal engine and SSH integration in progress."),
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
        cx.open_window(options, |_window, cx| cx.new(|_| Workspace))
            .expect("failed to open OpenShell native window");
        cx.activate(true);
    });
}
