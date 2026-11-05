//! Non-shipping, in-memory ZMODEM sender ↔ receiver integration tests.
//! This is a deterministic binary-stream loopback, not an SSH or lrzsz interop test.

use std::collections::VecDeque;

use zmodem2::{Action, Event, FileInfo, Position, Receiver, Sender};

struct TransferResult {
    received: Vec<u8>,
    filename: Vec<u8>,
    sender_done: bool,
    receiver_done: bool,
}

fn pump_transfer(filename: &[u8], source: &[u8], fragment_size: usize) -> TransferResult {
    assert!((1..=1024).contains(&fragment_size));
    let mut sender = Sender::new().expect("sender initialization");
    let mut receiver = Receiver::new().expect("receiver initialization");
    let size = u32::try_from(source.len()).expect("fixture under 4 GiB");
    let mut sender_to_receiver = VecDeque::<u8>::new();
    let mut receiver_to_sender = VecDeque::<u8>::new();

    let mut offered = false;
    let mut finished = false;
    let mut sender_done = false;
    let mut receiver_done = false;
    let mut file_complete = false;
    let mut received = Vec::new();
    let mut announced_name = Vec::new();

    for step in 0..200_000 {
        let mut progressed = false;

        // The start_file operation may be rejected until the initial handshake.
        if !offered && sender.start_file(FileInfo::new(filename, Some(Position::new(size)))).is_ok() {
            offered = true;
            progressed = true;
        }

        match sender.poll() {
            Action::WriteWire(bytes) => {
                let bytes = bytes.to_vec();
                assert!(!bytes.is_empty(), "sender must not spin on an empty write");
                sender.wire_written(bytes.len());
                sender_to_receiver.extend(bytes);
                progressed = true;
            }
            Action::ReadFile { offset, max_len } => {
                let start = usize::try_from(offset.get()).unwrap();
                assert!(start < source.len(), "unexpected sender read past EOF at step {step}");
                let end = (start + max_len).min(source.len());
                assert!(end > start, "invalid sender read length");
                sender.submit_file(&source[start..end]).expect("submit file bytes");
                progressed = true;
            }
            Action::Event(Event::FileCompleted) => {
                file_complete = true;
                progressed = true;
            }
            Action::Event(Event::SessionCompleted) => {
                sender_done = true;
                progressed = true;
            }
            Action::Event(Event::Aborted) => panic!("sender aborted at step {step}"),
            Action::Event(_) => progressed = true,
            Action::Idle => {
                if !receiver_to_sender.is_empty() {
                    let input: Vec<u8> = receiver_to_sender.iter().take(fragment_size).copied().collect();
                    let consumed = sender.submit_wire(&input).expect("sender accepts wire");
                    assert!(consumed <= input.len());
                    receiver_to_sender.drain(..consumed);
                    progressed |= consumed > 0;
                }
            }
            _ => panic!("unexpected sender action"),
        }

        match receiver.poll() {
            Action::WriteWire(bytes) => {
                let bytes = bytes.to_vec();
                assert!(!bytes.is_empty(), "receiver must not spin on an empty write");
                receiver.wire_written(bytes.len());
                receiver_to_sender.extend(bytes);
                progressed = true;
            }
            Action::WriteFile(bytes) => {
                let bytes = bytes.to_vec();
                assert!(!bytes.is_empty(), "receiver must not request empty write");
                received.extend_from_slice(&bytes);
                receiver.file_written(bytes.len()).expect("file persisted");
                progressed = true;
            }
            Action::Event(Event::FileStarted(info)) => {
                announced_name = info.name.to_vec();
                assert_eq!(info.size, Some(Position::new(size)));
                progressed = true;
            }
            Action::Event(Event::FileCompleted) => {
                progressed = true;
            }
            Action::Event(Event::SessionCompleted) => {
                receiver_done = true;
                progressed = true;
            }
            Action::Event(Event::Aborted) => panic!("receiver aborted at step {step}"),
            Action::Event(_) => progressed = true,
            Action::Idle => {
                if !sender_to_receiver.is_empty() {
                    let input: Vec<u8> = sender_to_receiver.iter().take(fragment_size).copied().collect();
                    let consumed = receiver.submit_wire(&input).expect("receiver accepts wire");
                    assert!(consumed <= input.len());
                    sender_to_receiver.drain(..consumed);
                    progressed |= consumed > 0;
                }
            }
            _ => panic!("unexpected receiver action"),
        }

        if file_complete && !finished && sender.finish().is_ok() {
            finished = true;
            progressed = true;
        }

        if sender_done && receiver_done {
            assert!(offered && finished && file_complete);
            assert!(sender_to_receiver.is_empty());
            return TransferResult {
                received,
                filename: announced_name,
                sender_done,
                receiver_done,
            };
        }

        if !progressed && sender_to_receiver.is_empty() && receiver_to_sender.is_empty() {
            sender.timeout().expect("sender timeout / retry");
            receiver.timeout().expect("receiver timeout / retry");
        }
    }

    panic!(
        "ZMODEM roundtrip exceeded iteration bound (offered={offered}, finished={finished}, \
         file_complete={file_complete}, sender_done={sender_done}, receiver_done={receiver_done}, \
         received={} bytes)",
        received.len()
    );
}

fn assert_roundtrip(name: &[u8], bytes: &[u8], fragment: usize) {
    let result = pump_transfer(name, bytes, fragment);
    assert_eq!(result.received, bytes);
    assert_eq!(result.filename, name);
    assert!(result.sender_done && result.receiver_done);
}

#[test]
fn empty_file_roundtrip() {
    assert_roundtrip(b"empty.bin", b"", 7);
}

#[test]
fn one_byte_roundtrip() {
    assert_roundtrip(b"one.bin", &[0x00], 13);
}

#[test]
fn binary_payload_roundtrip() {
    let data: Vec<u8> = (0..32_768).map(|i| (i * 73 % 256) as u8).collect();
    assert_roundtrip(b"binary.dat", &data, 41);
}

#[test]
fn utf8_filename_roundtrip() {
    assert_roundtrip("文件-数据.bin".as_bytes(), b"hello ZMODEM", 17);
}

#[test]
fn large_payload_roundtrip() {
    let data: Vec<u8> = (0..128 * 1024).map(|i| (i * 191 % 256) as u8).collect();
    assert_roundtrip(b"large.bin", &data, 512);
}
