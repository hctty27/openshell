//! GPUI native IME bridge. Composition is kept out of the PTY until committed.
//! All ranges exposed to GPUI use UTF-16 code units, not UTF-8 byte offsets.

use std::ops::Range;
use gpui::{
    point, px, size, Bounds, Context, EntityInputHandler, Pixels, Point, UTF16Selection, Window,
};
use crate::{Workspace, terminal_paint::{CELL_HEIGHT, CELL_WIDTH, CONTENT_PADDING}};

/// Match the 14px Consolas used by the provisional diagnostic renderer.
pub(super) fn terminal_cell_advance(cx: &gpui::App) -> f32 {
    let font_id = cx.text_system().resolve_font(&gpui::font("Consolas"));
    cx.text_system()
        .ch_advance(font_id, px(14.0))
        .ok()
        .map(f32::from)
        .filter(|width| width.is_finite() && *width > 0.0)
        .unwrap_or(CELL_WIDTH)
}

#[derive(Default)]
pub(super) struct TerminalImeState {
    pub(super) text: String,
    pub(super) selected: Range<usize>,
    pub(super) tab_id: Option<u64>,
    pub(super) editor_field: Option<usize>,
    // A stale platform commit can arrive after focus switches tabs.
    reject_stale_commit: bool,
}

impl TerminalImeState {
    pub(super) fn is_composing(&self) -> bool {
        !self.text.is_empty()
    }

    pub(super) fn reset(&mut self) {
        self.text.clear();
        self.selected = 0..0;
        self.tab_id = None;
        self.editor_field = None;
        self.reject_stale_commit = false;
    }

    /// Reject a delayed IME confirmation from a tab or editor that lost focus.
    pub(super) fn invalidate_target(&mut self) {
        let was_composing = self.is_composing();
        self.reset();
        self.reject_stale_commit = was_composing;
    }

    fn consume_stale_commit(&mut self) -> bool {
        if !self.reject_stale_commit { return false; }
        self.reset();
        true
    }

    fn set_marked(&mut self, text: &str, selection: Option<Range<usize>>, tab_id: u64, editor_field: Option<usize>) {
        self.text.clear();
        self.text.push_str(text);
        self.reject_stale_commit = false;
        let length = self.text.encode_utf16().count();
        self.selected = selection
            .filter(|r| r.start <= r.end && r.end <= length)
            .unwrap_or(length..length);
        self.tab_id = Some(tab_id);
        self.editor_field = editor_field;
    }
}

fn byte_offset_for_utf16(text: &str, wanted: usize) -> Option<usize> {
    let mut count = 0;
    for (byte, ch) in text.char_indices() {
        if count == wanted { return Some(byte); }
        count += ch.len_utf16();
    }
    (count == wanted).then_some(text.len())
}

impl EntityInputHandler for Workspace {
    fn text_for_range(
        &mut self, range: Range<usize>, adjusted: &mut Option<Range<usize>>,
        _window: &mut Window, _cx: &mut Context<Self>,
    ) -> Option<String> {
        let start = byte_offset_for_utf16(&self.ime.text, range.start)?;
        let end = byte_offset_for_utf16(&self.ime.text, range.end)?;
        if start > end { return None; }
        *adjusted = Some(range);
        Some(self.ime.text[start..end].to_owned())
    }

    fn selected_text_range(
        &mut self, _ignore_disabled_input: bool, _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.ime.selected.clone(),
            reversed: false,
        })
    }

    fn marked_text_range(&self, _window: &mut Window, _cx: &mut Context<Self>) -> Option<Range<usize>> {
        self.ime.is_composing().then(|| 0..self.ime.text.encode_utf16().count())
    }

    fn replace_text_in_range(
        &mut self, _range: Option<Range<usize>>, text: &str,
        _window: &mut Window, cx: &mut Context<Self>,
    ) {
        if self.ime.consume_stale_commit() {
            cx.notify();
            return;
        }
        let target = self.ime.tab_id;
        let editor_field = self.ime.editor_field;
        self.ime.reset();
        if text.is_empty() || target.is_some_and(|id| id != self.active_id) {
            cx.notify();
            return;
        }
        if let Some(draft) = &mut self.session_editor {
            if !draft.saving && editor_field.is_none_or(|field| field == draft.selected) {
                draft.type_text(text);
            }
            cx.notify();
            return;
        }
        // IME input can also contain pasted multiline text. Never let it
        // bypass the confirmation and maximum-byte limits.
        if text.len() > crate::clipboard_paste::MAX_PASTE_BYTES {
            self.active_tab_mut().status = "IME input exceeds the 128 KiB limit".into();
            cx.notify();
        } else if crate::clipboard_paste::needs_paste_confirmation(text) {
            self.pending_paste = Some((self.active_id, text.to_owned()));
            cx.notify();
        } else {
            self.send_input(text.as_bytes().to_vec(), cx);
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self, _range: Option<Range<usize>>, new_text: &str,
        selected_range: Option<Range<usize>>, _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A password is held in Zeroizing<String>; do not duplicate a
        // composition of that secret into an ordinary long-lived buffer.
        if self.session_editor.as_ref().is_some_and(|draft| draft.selected == 5) {
            self.ime.reset();
        } else {
            self.ime.set_marked(
                new_text, selected_range, self.active_id,
                self.session_editor.as_ref().map(|draft| draft.selected),
            );
        }
        cx.notify();
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        // unmarkText ends the marked range, but is not a text-commit event.
        // Only replace_text_in_range may deliver characters to the PTY.
        // In particular, Escape must not execute unfinished Pinyin preedit.
        self.ime.reset();
        cx.notify();
    }

    fn bounds_for_range(
        &mut self, _range: Range<usize>, element_bounds: Bounds<Pixels>,
        _window: &mut Window, cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (row, column) = self.active_tab().terminal.visible_cursor_cell();
        // Use the actual Consolas advance at the same 14px size as the
        // diagnostic terminal renderer. The old fixed width drifted with
        // system font metrics; fall back only if the glyph is unavailable.
        let measured_width = terminal_cell_advance(cx);
        Some(Bounds::new(
            point(
                element_bounds.left() + px(CONTENT_PADDING / 2.0 + column as f32 * measured_width),
                element_bounds.top() + px(CONTENT_PADDING / 2.0 + row as f32 * CELL_HEIGHT),
            ),
            size(px(2.0), px(CELL_HEIGHT)),
        ))
    }

    fn character_index_for_point(
        &mut self, _point: Point<Pixels>, _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.ime.selected.end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ime_ranges_count_utf16_units_not_utf8_bytes() {
        let text = "中😊é";
        assert_eq!(byte_offset_for_utf16(text, 0), Some(0));
        assert_eq!(byte_offset_for_utf16(text, 1), Some(3));
        assert_eq!(byte_offset_for_utf16(text, 2), None);
        assert_eq!(byte_offset_for_utf16(text, 3), Some(7));
        assert_eq!(byte_offset_for_utf16(text, 5), Some(text.len()));
    }

    #[test]
    fn cancelled_preedit_disappears_without_becoming_committed_text() {
        let mut ime = TerminalImeState::default();
        ime.set_marked("rm -rf", None, 11, None);
        ime.reset();
        assert!(!ime.is_composing());
        assert!(ime.text.is_empty());
    }

    #[test]
    fn focus_change_discards_delayed_commit_but_allows_new_composition() {
        let mut ime = TerminalImeState::default();
        ime.set_marked("ni", None, 7, None);
        ime.invalidate_target();
        assert!(!ime.is_composing());
        assert!(ime.consume_stale_commit());
        assert!(!ime.consume_stale_commit());

        ime.set_marked("hao", None, 8, None);
        assert!(!ime.consume_stale_commit());
        assert_eq!(ime.tab_id, Some(8));
    }

    #[test]
    fn preedit_replaces_in_place_and_is_not_sent_on_each_update() {
        let mut ime = TerminalImeState::default();
        ime.set_marked("ni", None, 7, None);
        assert!(ime.is_composing());
        ime.set_marked("你好", Some(1..2), 7, None);
        assert_eq!(ime.text, "你好");
        assert_eq!(ime.selected, 1..2);
        assert_eq!(ime.tab_id, Some(7));
        ime.reset();
        assert!(!ime.is_composing());
    }
}
