package sshclient

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestNativePassiveHandoffPreservesExactFrameOrderAcrossChunks(t *testing.T) {
	for _, frame := range []byte{0, 1} {
		t.Run(string('0'+rune(frame)), func(t *testing.T) {
			var visible, native bytes.Buffer
			input := newTerminalInputGate(io.Discard, io.Discard)
			var detected []byte
			header := nativeZmodemHeaderFixture(frame)
			guard := newNativeOnlyOutputGuardPassive(
				&visible, func() { t.Error("valid passive frame treated as unsupported") },
				input.blockPassiveInput, func(kind byte) { detected = append(detected, kind) },
			)
			gate := newTerminalOutputGate(guard)
			before := []byte("shell prompt\r\n")
			payload := append(append([]byte(nil), header...), []byte("next-frame")...)
			stream := append(append([]byte(nil), before...), payload...)
			for _, chunk := range [][]byte{
				stream[:3], stream[3:len(before)+5], stream[len(before)+5:],
			} {
				if n, err := gate.Write(chunk); err != nil || n != len(chunk) {
					t.Fatalf("gate.Write failed: %d %v", n, err)
				}
			}
			if !bytes.Equal(visible.Bytes(), before) { t.Fatalf("protocol reached xterm: %x", visible.Bytes()) }
			if !bytes.Equal(detected, []byte{frame}) { t.Fatalf("invalid start notification: %v", detected) }
			if kind, count, ok := guard.pendingCapture(); !ok || kind != frame || count != len(payload) {
				t.Fatalf("pending capture missing: frame=%d bytes=%d available=%v", kind, count, ok)
			}
			if n, err := input.Write([]byte("manual")); !errors.Is(err, errNativeTerminalInputBusy) || n != 0 {
				t.Fatalf("typing not blocked at protocol detection: %d %v", n, err)
			}
			lease, err := gate.takeoverCaptured(&native, guard)
			if err != nil || lease == 0 { t.Fatalf("capture takeover failed: %d %v", lease, err) }
			if _, err := gate.Write([]byte("trailing")); err != nil { t.Fatal(err) }
			want := append(append([]byte(nil), payload...), []byte("trailing")...)
			if !bytes.Equal(native.Bytes(), want) {
				t.Fatalf("captured handshake out of order: %x vs %x", native.Bytes(), want)
			}
			if _, err := gate.takeoverCaptured(io.Discard, guard); !errors.Is(err, errTerminalStreamOwned) {
				t.Fatalf("second consumer acquired protocol stream: %v", err)
			}
			if visible.String() != string(before) {
				t.Fatalf("binary leaked to terminal after takeover: %x", visible.Bytes())
			}
		})
	}
}

func TestNativePassiveUnclaimedCorruptionFailsClosed(t *testing.T) {
	var visible bytes.Buffer
	input := newTerminalInputGate(io.Discard, io.Discard)
	fallback, started := 0, 0
	guard := newNativeOnlyOutputGuardPassive(&visible,
		func() { fallback++ }, input.blockPassiveInput, func(byte) { started++ },
	)
	gate := newTerminalOutputGate(guard)
	if _, err := gate.Write([]byte("before")); err != nil { t.Fatal(err) }
	if _, err := gate.Write([]byte("**\x18B0100000000aa50")); err != nil { t.Fatal(err) }
	if started != 0 || fallback != 1 {
		t.Fatalf("invalid CRC started passive transfer: started=%d fallback=%d", started, fallback)
	}
	if visible.String() != "before" { t.Fatalf("damaged frame reached xterm: %q", visible.String()) }
	if _, err := gate.takeoverCaptured(io.Discard, guard); !errors.Is(err, errNativePassiveNoHeader) {
		t.Fatalf("invalid CRC had a consumable native handshake: %v", err)
	}
}

func TestNativePassiveBufferOverflowNeverFallsBackToTerminal(t *testing.T) {
	var visible bytes.Buffer
	fallback, started := 0, 0
	guard := newNativeOnlyOutputGuardPassive(&visible,
		func() { fallback++ }, func() {}, func(byte) { started++ },
	)
	gate := newTerminalOutputGate(guard)
	if _, err := gate.Write(nativeZmodemHeaderFixture(0)); err != nil { t.Fatal(err) }
	if started != 1 { t.Fatal("did not detect initial handshake") }
	if _, err := gate.Write(bytes.Repeat([]byte("x"), nativePassiveHandshakeBufferLimit)); err != nil { t.Fatal(err) }
	if fallback != 1 { t.Fatalf("overflow not reported: %d", fallback) }
	if _, _, ok := guard.pendingCapture(); ok { t.Fatal("overflowed prebuffer was still claimed") }
	if _, err := gate.takeoverCaptured(io.Discard, guard); !errors.Is(err, errNativePassiveNoHeader) {
		t.Fatalf("overflowed handshake was handed to Rust: %v", err)
	}
	if _, err := gate.Write([]byte("do-not-show")); err != nil { t.Fatal(err) }
	if visible.Len() != 0 { t.Fatalf("overflow leaked protocol data to xterm: %x", visible.Bytes()) }
}
