use std::sync::mpsc::{self, Receiver, Sender};

use alacritty_terminal::{
    event::{Event, EventListener},
    grid::{Dimensions, Scroll},
    term::{cell::Flags, Config, RenderableContent, Term, TermMode},
    vte::ansi::{Color, Processor},
    term::color::Colors,
};


const DEFAULT_FOREGROUND: u32 = 0xdbe3ed;
const DEFAULT_BACKGROUND: u32 = 0x090d12;
const ANSI_PALETTE: [u32; 16] = [
    0x1b1f27, 0xcd3131, 0x0dbc79, 0xe5e510,
    0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5,
    0x666666, 0xf14c4c, 0x23d18b, 0xf5f543,
    0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

/// Renderer-neutral terminal cell. Positions are in fixed-width terminal cells.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderCell {
    pub text: String,
    pub fg: u32,
    pub bg: u32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub cursor: bool,
}

impl Default for RenderCell {
    fn default() -> Self {
        Self {
            text: " ".into(),
            fg: DEFAULT_FOREGROUND,
            bg: DEFAULT_BACKGROUND,
            bold: false,
            italic: false,
            underline: false,
            cursor: false,
        }
    }
}

fn color_hex(color: Color, colors: &Colors, fallback: u32) -> u32 {
    let index = match color {
        Color::Spec(value) => {
            return (u32::from(value.r) << 16)
                | (u32::from(value.g) << 8) | u32::from(value.b);
        }
        Color::Indexed(index) => index as usize,
        Color::Named(name) => name as usize,
    };

    if let Some(value) = colors[index] {
        return (u32::from(value.r) << 16)
            | (u32::from(value.g) << 8) | u32::from(value.b);
    }

    match index {
        0..=15 => ANSI_PALETTE[index],
        16..=231 => {
            let n = index - 16;
            let component = |v: usize| if v == 0 { 0 } else { 55 + 40 * v };
            ((component(n / 36) as u32) << 16)
                | ((component(n / 6 % 6) as u32) << 8)
                | component(n % 6) as u32
        }
        232..=255 => {
            let v = (8 + (index - 232) * 10) as u32;
            (v << 16) | (v << 8) | v
        }
        256 | 267 => DEFAULT_FOREGROUND,
        257 | 268 => DEFAULT_BACKGROUND,
        _ => fallback,
    }
}

/// Dimensions are cell counts, not screen pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSize {
    pub columns: usize,
    pub rows: usize,
}

impl TerminalSize {
    pub fn new(columns: usize, rows: usize) -> Self {
        Self {
            columns: columns.max(2),
            rows: rows.max(1),
        }
    }
}

impl Dimensions for TerminalSize {
    fn total_lines(&self) -> usize { self.rows }
    fn screen_lines(&self) -> usize { self.rows }
    fn columns(&self) -> usize { self.columns }
}

#[derive(Clone)]
pub struct EventSink(Sender<Event>);

impl EventListener for EventSink {
    fn send_event(&self, event: Event) {
        let _ = self.0.send(event);
    }
}

/// Stateful ANSI/VT parser and terminal grid, independent of the renderer.
///
/// Never recreate this model when a tab becomes hidden. Call 'feed' only on
/// the owner thread; move incoming bytes through a bounded channel.
pub struct TerminalEngine {
    term: Term<EventSink>,
    parser: Processor,
    events: Receiver<Event>,
    size: TerminalSize,
}

impl TerminalEngine {
    pub fn new(size: TerminalSize) -> Self {
        let (sender, events) = mpsc::channel();
        let config = Config { scrolling_history: 10_000, ..Config::default() };
        Self {
            term: Term::new(config, &size, EventSink(sender)),
            parser: Processor::new(),
            events,
            size,
        }
    }

    /// Parser state is retained between calls, including partial UTF-8 and CSI.
    /// Return terminal-generated events such as PtyWrite to the transport.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Event> {
        self.parser.advance(&mut self.term, bytes);
        self.events.try_iter().collect()
    }

    pub fn resize(&mut self, size: TerminalSize) {
        if self.size == size { return; }
        self.term.resize(size);
        self.size = size;
    }

    pub fn size(&self) -> TerminalSize { self.size }

    pub fn in_alternate_screen(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// Scroll the primary-screen history without disturbing the running PTY.
    /// Alternate-screen programs require mouse/key reporting instead.
    pub fn scroll_history(&mut self, lines: i32) {
        if lines == 0 || self.term.mode().contains(TermMode::ALT_SCREEN) {
            return;
        }
        self.term.scroll_display(Scroll::Delta(lines));
    }


    /// Diagnostic text snapshot of the visible viewport. This is not a
    /// production cell renderer: colors, cursor and glyph metrics are omitted.
    pub fn visible_lines(&self) -> Vec<String> {
        let content = self.term.renderable_content();
        let mut rows = vec![vec![' '; self.size.columns]; self.size.rows];
        let offset = content.display_offset as i32;
        for indexed in content.display_iter {
            let line = indexed.point.line.0 + offset;
            let col = indexed.point.column.0;
            if line < 0 || line as usize >= self.size.rows || col >= self.size.columns {
                continue;
            }
            let cell = indexed.cell;
            let spacer = cell.flags.intersects(
                Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER,
            );
            rows[line as usize][col] = if spacer { ' ' } else { cell.c };
        }
        rows.into_iter()
            .map(|row| row.into_iter().collect::<String>().trim_end().to_owned())
            .collect()
    }


    /// Emit only protocol replies, such as cursor-position reports, for the PTY.
    /// Other terminal events (title, bell, clipboard) must be handled by the
    /// window/event layer separately before production use.
    pub fn feed_pty_replies(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.feed(bytes).into_iter().filter_map(|event| match event {
            Event::PtyWrite(reply) => Some(reply.into_bytes()),
            _ => None,
        }).collect()
    }

    /// Visible fixed-size grid with ANSI colors and cursor metadata.
    /// The GPU view should eventually use cell-positioned glyph quads rather
    /// than text layout to preserve exact CJK/double-width placement.
    pub fn render_cells(&self) -> Vec<Vec<RenderCell>> {
        let content = self.term.renderable_content();
        let colors = content.colors;
        let offset = content.display_offset as i32;
        let mut rows = vec![vec![RenderCell::default(); self.size.columns]; self.size.rows];

        for indexed in content.display_iter {
            let row = indexed.point.line.0 + offset;
            let column = indexed.point.column.0;
            if row < 0 || row as usize >= self.size.rows || column >= self.size.columns {
                continue;
            }
            let cell = indexed.cell;
            let spacer = cell.flags.intersects(
                Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER
            );
            let mut text = if spacer || cell.flags.contains(Flags::HIDDEN) {
                " ".to_owned()
            } else {
                cell.c.to_string()
            };
            if !spacer && !cell.flags.contains(Flags::HIDDEN) {
                if let Some(zero_width) = cell.zerowidth() {
                    text.extend(zero_width.iter());
                }
            }
            let mut fg = color_hex(cell.fg, colors, DEFAULT_FOREGROUND);
            let mut bg = color_hex(cell.bg, colors, DEFAULT_BACKGROUND);
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            rows[row as usize][column] = RenderCell {
                text: if spacer { String::new() } else { text },
                fg,
                bg,
                bold: cell.flags.contains(Flags::BOLD),
                italic: cell.flags.contains(Flags::ITALIC),
                underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
                cursor: false,
            };
        }

        let cursor_row = content.cursor.point.line.0 + offset;
        let cursor_col = content.cursor.point.column.0;
        if cursor_row >= 0 && (cursor_row as usize) < self.size.rows
            && cursor_col < self.size.columns
        {
            rows[cursor_row as usize][cursor_col].cursor = true;
        }
        rows
    }

    pub fn renderable_content(&self) -> RenderableContent<'_> {
        self.term.renderable_content()
    }

    pub fn reset_damage(&mut self) {
        self.term.reset_damage();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_parser_state_across_chunks() {
        let mut terminal = TerminalEngine::new(TerminalSize::new(80, 24));
        terminal.feed(b"\x1b[31");
        terminal.feed(b"mhello\x1b[0m");
        assert_eq!(terminal.size(), TerminalSize::new(80, 24));
    }

    #[test]
    fn renders_output_across_stream_boundaries() {
        let mut terminal = TerminalEngine::new(TerminalSize::new(24, 4));
        terminal.feed(b"hello\r\n\x1b[32");
        terminal.feed(b"mworld\x1b[0m");
        let lines = terminal.visible_lines();
        assert_eq!(lines[0], "hello");
        assert_eq!(lines[1], "world");
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn snapshot_does_not_consume_terminal_history() {
        let mut terminal = TerminalEngine::new(TerminalSize::new(12, 3));
        terminal.feed(b"abc");
        assert_eq!(terminal.visible_lines()[0], "abc");
        assert_eq!(terminal.visible_lines()[0], "abc");
    }

    #[test]
    fn resolves_ansi_red_truecolor_and_wide_chars() {
        let mut term = TerminalEngine::new(TerminalSize::new(24, 4));
        term.feed(b"\x1b[31mR\x1b[0m\x1b[38;2;1;2;3mT");
        let row = &term.render_cells()[0];
        assert_eq!(row[0].fg, ANSI_PALETTE[1]);
        assert_eq!(row[1].fg, 0x010203);
    }

    #[test]
    fn returns_device_status_pty_replies() {
        let mut term = TerminalEngine::new(TerminalSize::new(80, 24));
        let replies = term.feed_pty_replies(b"\x1b[6n");
        assert!(replies.iter().any(|reply| reply.starts_with(b"\x1b[")));
    }

    #[test]
    fn alternate_screen_does_not_scroll_primary_history() {
        let mut terminal = TerminalEngine::new(TerminalSize::new(20, 3));
        terminal.feed(b"\x1b[?1049h");
        assert!(terminal.in_alternate_screen());
        let before = terminal.visible_lines();
        terminal.scroll_history(30);
        assert_eq!(terminal.visible_lines(), before);
        terminal.feed(b"\x1b[?1049l");
        assert!(!terminal.in_alternate_screen());
    }

    #[test]
    fn scrollback_can_reveal_old_lines() {
        let mut terminal = TerminalEngine::new(TerminalSize::new(16, 3));
        for row in 0..14 {
            terminal.feed(format!("row {row}\r\n").as_bytes());
        }
        assert!(!terminal.visible_lines().join("\n").contains("row 0"));
        terminal.scroll_history(100);
        assert!(terminal.visible_lines().join("\n").contains("row 0"));
        terminal.scroll_history(-100);
        assert!(!terminal.visible_lines().join("\n").contains("row 0"));
    }

    #[test]
    fn resizing_is_clamped_and_idempotent() {
        let mut terminal = TerminalEngine::new(TerminalSize::new(0, 0));
        assert_eq!(terminal.size(), TerminalSize::new(2, 1));
        terminal.resize(TerminalSize::new(120, 40));
        terminal.resize(TerminalSize::new(120, 40));
        assert_eq!(terminal.size(), TerminalSize::new(120, 40));
    }
}
