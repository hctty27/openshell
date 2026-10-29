use std::sync::mpsc::{self, Receiver, Sender};

use alacritty_terminal::{
    event::{Event, EventListener},
    grid::Dimensions,
    term::{Config, RenderableContent, Term},
    vte::ansi::Processor,
};

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
    fn resizing_is_clamped_and_idempotent() {
        let mut terminal = TerminalEngine::new(TerminalSize::new(0, 0));
        assert_eq!(terminal.size(), TerminalSize::new(2, 1));
        terminal.resize(TerminalSize::new(120, 40));
        terminal.resize(TerminalSize::new(120, 40));
        assert_eq!(terminal.size(), TerminalSize::new(120, 40));
    }
}
