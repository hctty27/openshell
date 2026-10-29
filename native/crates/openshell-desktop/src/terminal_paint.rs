use gpui::{rgb, FontWeight, HighlightStyle, StyledText};
use openshell_core::{TerminalSize, terminal::RenderCell};

/// Diagnostic text styling; the production terminal will paint cells directly.
pub(super) fn styled_terminal_line(cells: &[RenderCell]) -> StyledText {
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
pub(super) const SIDEBAR_WIDTH: f32 = 244.0;
pub(super) const TITLEBAR_HEIGHT: f32 = 46.0;
pub(super) const TABBAR_HEIGHT: f32 = 36.0;
pub(super) const TOOLBAR_HEIGHT: f32 = 40.0;
pub(super) const CONTENT_PADDING: f32 = 32.0;
pub(super) const CELL_WIDTH: f32 = 8.5;
pub(super) const CELL_HEIGHT: f32 = 19.0;
pub(super) const MAX_COLUMNS: usize = 500;
pub(super) const MAX_ROWS: usize = 300;

pub(super) fn terminal_size_for_viewport(width: f32, height: f32) -> TerminalSize {
    // On window minimization and invalid geometry, do not create huge grids.
    let width = if width.is_finite() { width.max(0.0) } else { 0.0 };
    let height = if height.is_finite() { height.max(0.0) } else { 0.0 };
    let columns = ((width - SIDEBAR_WIDTH - CONTENT_PADDING) / CELL_WIDTH)
        .floor()
        .max(2.0)
        .min(MAX_COLUMNS as f32) as usize;
    let rows = ((height - TITLEBAR_HEIGHT - TABBAR_HEIGHT - TOOLBAR_HEIGHT - CONTENT_PADDING)
        / CELL_HEIGHT)
        .floor()
        .max(1.0)
        .min(MAX_ROWS as f32) as usize;
    TerminalSize::new(columns, rows)
}

