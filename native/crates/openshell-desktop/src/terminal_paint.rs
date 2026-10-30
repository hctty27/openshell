use gpui::{rgb, FontWeight, HighlightStyle, StyledText};
use openshell_core::{TerminalSize, terminal::RenderCell, workspace::SplitAxis};

/// Diagnostic text styling; the production terminal will paint cells directly.
pub(super) fn styled_terminal_line(cells: &[RenderCell]) -> StyledText {
    let mut text = String::with_capacity(cells.len() * 2);
    let mut highlights = Vec::new();
    let mut last_style: Option<(u32, u32, bool)> = None;
    let mut start = 0;

    for cell in cells {
        let (fg, bg) = if cell.cursor || cell.selected {
            (cell.bg, cell.fg)
        } else {
            (cell.fg, cell.bg)
        };
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
pub(super) const SIDEBAR_WIDTH: f32 = 300.0;
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


const SPLIT_GUTTER: f32 = 6.0;

/// Prototype mapping of window X coordinates to monospaced terminal columns.
/// The final renderer must replace these estimates with measured GPUI bounds
/// and actual glyph widths before production selection can be exact.
pub(super) fn pointer_column(
    window_x: f32,
    pane_index: usize,
    axis: Option<SplitAxis>,
    window_width: f32,
    columns: usize,
) -> usize {
    if columns == 0 { return 0; }
    let half = ((window_width - SIDEBAR_WIDTH - SPLIT_GUTTER).max(0.0)) / 2.0;
    let pane_left = match axis {
        Some(SplitAxis::Vertical) if pane_index == 1 =>
            SIDEBAR_WIDTH + half + SPLIT_GUTTER,
        _ => SIDEBAR_WIDTH,
    };
    let content_left = pane_left + CONTENT_PADDING / 2.0;
    let position = ((window_x - content_left) / CELL_WIDTH).floor();
    if !position.is_finite() { return 0; }
    (position.max(0.0) as usize).min(columns - 1)
}


/// The split is only a view into existing terminal tabs; each visible PTY
/// must be resized to its actual pane instead of retaining full-width columns.
pub(super) fn terminal_size_for_split(
    width: f32,
    height: f32,
    axis: SplitAxis,
) -> TerminalSize {
    match axis {
        // Vertical divider: two panes side by side.
        SplitAxis::Vertical => {
            let usable = ((width - SIDEBAR_WIDTH - SPLIT_GUTTER).max(0.0)) / 2.0;
            terminal_size_for_viewport(usable + SIDEBAR_WIDTH, height)
        }
        // Horizontal divider: top and bottom panes.
        SplitAxis::Horizontal => {
            let usable = ((height - TITLEBAR_HEIGHT - TABBAR_HEIGHT - SPLIT_GUTTER)
                .max(0.0)) / 2.0;
            terminal_size_for_viewport(width, usable + TITLEBAR_HEIGHT + TABBAR_HEIGHT)
        }
    }
}

#[cfg(test)]
mod split_size_tests {
    use super::*;


    #[test]
    fn pointer_column_clamps_and_respects_vertical_split() {
        assert_eq!(pointer_column(-100.0, 0, None, 1200.0, 80), 0);
        assert_eq!(pointer_column(100_000.0, 0, None, 1200.0, 80), 79);
        assert_eq!(pointer_column(f32::NAN, 0, None, 1200.0, 80), 0);
        let second_left = SIDEBAR_WIDTH
            + (1200.0 - SIDEBAR_WIDTH - SPLIT_GUTTER) / 2.0
            + SPLIT_GUTTER + CONTENT_PADDING / 2.0;
        assert_eq!(pointer_column(second_left, 1, Some(SplitAxis::Vertical), 1200.0, 50), 0);
        assert_eq!(pointer_column(second_left + 2.0 * CELL_WIDTH, 1,
            Some(SplitAxis::Vertical), 1200.0, 50), 2);
    }

    #[test]
    fn split_halves_the_relevant_dimension_and_keeps_bounds() {
        let full = terminal_size_for_viewport(1200.0, 760.0);
        let side = terminal_size_for_split(1200.0, 760.0, SplitAxis::Vertical);
        assert!(side.columns < full.columns);
        assert_eq!(side.rows, full.rows);
        let stacked = terminal_size_for_split(1200.0, 760.0, SplitAxis::Horizontal);
        assert_eq!(stacked.columns, full.columns);
        assert!(stacked.rows < full.rows);
        let tiny = terminal_size_for_split(0.0, 0.0, SplitAxis::Vertical);
        assert!(tiny.columns >= 2);
        assert!(tiny.rows >= 1);
    }
}
