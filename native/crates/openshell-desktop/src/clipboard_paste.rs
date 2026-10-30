//! Text-only clipboard handling for native terminal panes.
//! No remote bytes are copied unless the user explicitly requests it.

pub(super) const MAX_PASTE_BYTES: usize = 128 * 1024;

/// Multiline paste can execute several shell commands when bracketed paste
/// is not enabled. Large single-line input also needs explicit approval.
pub(super) fn needs_paste_confirmation(text: &str) -> bool {
    text.len() > 4096 || text.bytes().any(|ch| ch == b'\n' || ch == b'\r')
}

/// Encode system clipboard text for the active PTY or SSH channel.
/// Reject ESC/control characters from the clipboard to prevent a pasted
/// bracketed-paste terminator or other injected terminal control sequence.
pub(super) fn encode_paste(text: &str, bracketed: bool) -> Vec<u8> {
    let mut output = Vec::with_capacity(text.len() + 12);
    if bracketed {
        output.extend_from_slice(b"\x1b[200~");
    }
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' if !bracketed => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                output.push(b'\r');
            }
            '\n' if !bracketed => output.push(b'\r'),
            '\t' | '\r' | '\n' => output.push(ch as u8),
            value if value.is_control() => {}
            value => {
                let mut encoded = [0_u8; 4];
                output.extend_from_slice(value.encode_utf8(&mut encoded).as_bytes());
            }
        }
    }
    if bracketed {
        output.extend_from_slice(b"\x1b[201~");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paste_normalizes_newlines_for_shell_input() {
        assert_eq!(encode_paste("one\r\ntwo\nthree\rfour", false),
            b"one\rtwo\rthree\rfour");
    }

    #[test]
    fn bracketed_paste_preserves_newlines_and_wraps_once() {
        assert_eq!(encode_paste("hello\r\nworld", true),
            b"\x1b[200~hello\r\nworld\x1b[201~");
    }

    #[test]
    fn clipboard_escape_sequences_cannot_end_bracketed_paste() {
        assert_eq!(encode_paste("hello\x1b[201~world\0", true),
            b"\x1b[200~hello[201~world\x1b[201~");
    }

    #[test]
    fn unicode_is_preserved_and_potentially_executing_pastes_require_approval() {
        assert_eq!(encode_paste("中文☁", false), "中文☁".as_bytes());
        assert!(!needs_paste_confirmation("echo ok"));
        assert!(needs_paste_confirmation("echo one\necho two"));
        assert!(needs_paste_confirmation(&"x".repeat(4097)));
    }
}
