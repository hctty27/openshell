//! Incremental OSC 7 current-directory tracking, with OSC 0/2 title fallback.
//! A shell controls these sequences; they are never used as shell commands.
//! Trust a complete, syntactically valid absolute path only.

const MAX_OSC_BYTES: usize = 4096;

#[derive(Debug, Default)]
pub struct CwdTracker {
    state: State,
    payload: Vec<u8>,
    saw_osc7: bool,
    path: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
    Discard,
}

impl CwdTracker {
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// Feed arbitrary transport chunks. Returns true if the effective path
    /// changed. Handles BEL/ST terminators, split chunks and oversize OSCs.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        let mut changed = false;
        for &byte in bytes {
            match self.state {
                State::Ground => {
                    if byte == 0x1b {
                        self.state = State::Escape;
                    }
                }
                State::Escape => {
                    self.state = match byte {
                        b']' => {
                            self.payload.clear();
                            State::Osc
                        }
                        0x1b => State::Escape,
                        _ => State::Ground,
                    };
                }
                State::Osc => match byte {
                    0x07 => {
                        changed |= self.complete();
                        self.state = State::Ground;
                    }
                    0x1b => self.state = State::OscEscape,
                    0x00..=0x1f => {
                        self.payload.clear();
                        self.state = State::Ground;
                    }
                    _ => self.append(byte),
                },
                State::OscEscape => {
                    if byte == b'\\' {
                        changed |= self.complete();
                        self.state = State::Ground;
                    } else if byte == b']' {
                        self.payload.clear();
                        self.state = State::Osc;
                    } else {
                        self.payload.clear();
                        self.state = if byte == 0x1b { State::Escape } else { State::Ground };
                    }
                }
                State::Discard => {
                    // After overflow, drain the sequence and do not treat
                    // its contents as new commands.
                    if byte == 0x07 {
                        self.state = State::Ground;
                    } else if byte == 0x1b {
                        self.state = State::OscEscape;
                    }
                }
            }
        }
        changed
    }

    fn append(&mut self, byte: u8) {
        if self.payload.len() >= MAX_OSC_BYTES {
            self.payload.clear();
            self.state = State::Discard;
        } else {
            self.payload.push(byte);
        }
    }

    fn complete(&mut self) -> bool {
        let parsed = std::str::from_utf8(&self.payload).ok().and_then(|value| {
            let (command, value) = value.split_once(';')?;
            match command {
                "7" => parse_osc7(value).map(|path| (true, path)),
                "0" | "2" if !self.saw_osc7 =>
                    parse_title_directory(value).map(|path| (false, path)),
                _ => None,
            }
        });
        self.payload.clear();
        if let Some((explicit, path)) = parsed {
            if explicit { self.saw_osc7 = true; }
            let changed = self.path.as_deref() != Some(path.as_str());
            self.path = Some(path);
            changed
        } else {
            false
        }
    }
}

fn valid_absolute(path: &str) -> bool {
    path.starts_with('/') && path.len() <= MAX_OSC_BYTES
        && !path.chars().any(|c| c.is_control())
}

fn parse_osc7(value: &str) -> Option<String> {
    let resource = value.strip_prefix("file://")?;
    let (authority, tail) = resource.split_once('/')?;
    if authority.contains('@') || authority.contains('?') || authority.contains('#')
        || authority.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let path = percent_decode(&format!("/{tail}"))?;
    valid_absolute(&path).then_some(path)
}

fn percent_decode(value: &str) -> Option<String> {
    let data = value.as_bytes();
    let mut decoded = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'%' {
            if i + 2 >= data.len() { return None; }
            let high = (data[i + 1] as char).to_digit(16)?;
            let low = (data[i + 2] as char).to_digit(16)?;
            decoded.push((high * 16 + low) as u8);
            i += 3;
        } else {
            decoded.push(data[i]);
            i += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// Shell titles are only a fallback. Accept an entire "user@host:/absolute"
/// or "host:/absolute" title, never random text containing a slash.
fn parse_title_directory(value: &str) -> Option<String> {
    let (identity, path) = value.split_once(":/")?;
    if identity.is_empty() || !identity.is_ascii()
        || !identity.bytes().all(|b| b.is_ascii_alphanumeric()
            || matches!(b, b'@' | b'.' | b'_' | b'-'))
        || identity.matches('@').count() > 1
        || identity.starts_with('@') || identity.ends_with('@')
    {
        return None;
    }
    let path = format!("/{path}");
    valid_absolute(&path).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc7_split_and_percent_decoded_unicode() {
        let mut tracker = CwdTracker::default();
        assert!(!tracker.feed(b"\x1b]7;file://server/home/%E4%B8"));
        assert!(tracker.feed(b"%AD%E6%96%87%20files\x1b\\"));
        assert_eq!(tracker.path(), Some("/home/中文 files"));
        assert!(!tracker.feed(b"\x1b]7;file://server/home/%E4%B8%AD%E6%96%87%20files\x07"));
    }

    #[test]
    fn title_fallback_and_osc7_precedence() {
        let mut tracker = CwdTracker::default();
        assert!(tracker.feed(b"\x1b]0;root@server:/data/logs\x07"));
        assert_eq!(tracker.path(), Some("/data/logs"));
        assert!(tracker.feed(b"\x1b]7;file://server/opt/app\x07"));
        assert_eq!(tracker.path(), Some("/opt/app"));
        assert!(!tracker.feed(b"\x1b]2;root@server:/wrong\x07"));
        assert_eq!(tracker.path(), Some("/opt/app"));
    }

    #[test]
    fn rejects_malformed_osc_and_untrusted_titles() {
        let mut tracker = CwdTracker::default();
        for value in [
            "\x1b]7;https://server/data\x07",
            "\x1b]7;file://root@server/data\x07",
            "\x1b]7;file://server/%00tmp\x07",
            "\x1b]7;file://server/%G0tmp\x07",
            "\x1b]0;My app - /var/log\x07",
            "\x1b]0;server:relative\x07",
        ] {
            assert!(!tracker.feed(value.as_bytes()));
            assert_eq!(tracker.path(), None);
        }
    }

    #[test]
    fn huge_payload_does_not_modify_cwd() {
        let mut tracker = CwdTracker::default();
        let mut payload = b"\x1b]7;file://server/".to_vec();
        payload.extend(std::iter::repeat_n(b'a', MAX_OSC_BYTES + 500));
        payload.push(0x07);
        assert!(!tracker.feed(&payload));
        assert_eq!(tracker.path(), None);
        assert!(tracker.feed(b"\x1b]7;file://server/ok\x07"));
        assert_eq!(tracker.path(), Some("/ok"));
    }
}
