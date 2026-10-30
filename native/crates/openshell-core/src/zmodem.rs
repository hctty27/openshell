//! Read-only ZMODEM startup probe for SSH PTY traffic.
//! No protocol bytes are consumed: a separate transport state machine must
//! take ownership before rz/sz file transfers can be enabled.
//!
//! Standard 16-bit HEX frame: "**", ZDLE, "B", 7 hex-encoded bytes
//! (frame type, four flags, two CRC bytes). ZRQINIT (0) means the remote
//! program is sending; ZRINIT (1) means the remote program is receiving.

const HEX_PREFIX: &[u8; 4] = b"**\x18B";
const HEX_CHARACTERS: usize = 14;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZmodemRequest {
    /// Remote sz advertises a file: OpenShell should receive it.
    Receive,
    /// Remote rz is ready: OpenShell should send a file.
    Send,
}

#[derive(Debug, Default)]
pub struct ZmodemProbe {
    prefix: usize,
    hex_count: usize,
    hex: [u8; HEX_CHARACTERS],
    detected: Option<ZmodemRequest>,
}

impl ZmodemProbe {
    pub fn feed(&mut self, bytes: &[u8]) -> Option<ZmodemRequest> {
        if self.detected.is_some() {
            return None;
        }
        for &byte in bytes {
            if self.hex_count != 0 {
                if byte.is_ascii_hexdigit() {
                    self.hex[self.hex_count] = byte;
                    self.hex_count += 1;
                    if self.hex_count == HEX_CHARACTERS {
                        let detected = parse_header(&self.hex);
                        self.hex_count = 0;
                        self.prefix = 0;
                        if let Some(request) = detected {
                            self.detected = Some(request);
                            return Some(request);
                        }
                    }
                } else {
                    self.hex_count = 0;
                    self.prefix = 0;
                    self.advance_prefix(byte);
                }
            } else if self.prefix == HEX_PREFIX.len() {
                if byte.is_ascii_hexdigit() {
                    self.hex[0] = byte;
                    self.hex_count = 1;
                    self.prefix = 0;
                } else {
                    self.prefix = 0;
                    self.advance_prefix(byte);
                }
            } else {
                self.advance_prefix(byte);
            }
        }
        None
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    fn advance_prefix(&mut self, byte: u8) {
        self.prefix = match (self.prefix, byte) {
            (0 | 1 | 2, b'*') => (self.prefix + 1).min(2),
            (2, 0x18) => 3,
            (3, b'B') => 4,
            (_, b'*') => 1,
            _ => 0,
        };
    }
}

fn parse_header(hex: &[u8; HEX_CHARACTERS]) -> Option<ZmodemRequest> {
    let mut decoded = [0_u8; 7];
    for (i, pair) in hex.chunks_exact(2).enumerate() {
        decoded[i] = (pair[0] as char).to_digit(16)? as u8 * 16
            + (pair[1] as char).to_digit(16)? as u8;
    }
    let expected = u16::from_be_bytes([decoded[5], decoded[6]]);
    let actual = crc16_zmodem(&decoded[..5]);
    if expected != actual {
        return None;
    }
    match decoded[0] {
        0 => Some(ZmodemRequest::Receive),
        1 => Some(ZmodemRequest::Send),
        _ => None,
    }
}

// ZMODEM CRC16/CCITT, finalized with two zero bytes (lrzsz updcrc16).
fn crc16_zmodem(input: &[u8]) -> u16 {
    let mut crc = 0_u16;
    for byte in input.iter().copied().chain([0_u8, 0]) {
        crc ^= u16::from(byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(frame_type: u8) -> Vec<u8> {
        let header = [frame_type, 0, 0, 0, 0];
        let crc = crc16_zmodem(&header);
        let mut data = HEX_PREFIX.to_vec();
        for byte in header.into_iter().chain(crc.to_be_bytes()) {
            data.extend_from_slice(format!("{byte:02x}").as_bytes());
        }
        data.extend_from_slice(b"\r\n\x11");
        data
    }

    #[test]
    fn recognizes_remote_sz_and_rz_after_split_ssh_packets() {
        let mut probe = ZmodemProbe::default();
        let send = frame(0);
        assert_eq!(probe.feed(b"server prompt\r\n"), None);
        assert_eq!(probe.feed(&send[..3]), None);
        assert_eq!(probe.feed(&send[3..9]), None);
        assert_eq!(probe.feed(&send[9..]), Some(ZmodemRequest::Receive));
        assert_eq!(probe.feed(&send), None);
        probe.reset();
        assert_eq!(probe.feed(&frame(1)), Some(ZmodemRequest::Send));
    }

    #[test]
    fn rejects_wrong_crc_and_unrelated_escape_sequences() {
        let mut wrong = frame(0);
        wrong[17] = if wrong[17] == b'0' { b'1' } else { b'0' };
        let mut probe = ZmodemProbe::default();
        assert_eq!(probe.feed(&wrong), None);
        assert_eq!(probe.feed(b"literal **[B00000000000000"), None);
        assert_eq!(probe.feed(&frame(4)), None);
        assert_eq!(probe.feed(&frame(0)), Some(ZmodemRequest::Receive));
    }

    #[test]
    fn prefix_resynchronizes_and_accepts_repeated_stars() {
        let mut probe = ZmodemProbe::default();
        let payload = [b"trash***".as_slice(), &frame(0)].concat();
        assert_eq!(probe.feed(&payload), Some(ZmodemRequest::Receive));
    }
}
