package sshclient

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func nativeZmodemHeaderTestStream() []byte {
	return []byte("**\x18B010123456789ab")
}

func TestNativeZmodemHeaderScannerEverySplitBoundary(t *testing.T) {
	header := nativeZmodemHeaderTestStream()
	if len(header) != nativeZmodemHeaderSize {
		t.Fatalf("invalid test header length: %d", len(header))
	}
	before := []byte("shell prompt\r\n")
	after := []byte{0, 255, '*', 0x18, 0x42, 0, 0x13}
	stream := append(append(append([]byte(nil), before...), header...), after...)

	for boundary := 0; boundary <= len(stream); boundary++ {
		t.Run(string(rune(boundary+65)), func(t *testing.T) {
			var legacy, native bytes.Buffer
			gate := newTerminalOutputGate(&legacy)
			lease, err := gate.armOnZmodemHeader(&native)
			if err != nil {
				t.Fatal(err)
			}
			for _, chunk := range [][]byte{stream[:boundary], stream[boundary:]} {
				n, err := gate.Write(chunk)
				if err != nil || n != len(chunk) {
					t.Fatalf("Write returned %d, %v", n, err)
				}
			}
			if !bytes.Equal(legacy.Bytes(), before) {
				t.Fatalf("legacy received %x instead of %x", legacy.Bytes(), before)
			}
			wantNative := append(append([]byte(nil), header...), after...)
			if !bytes.Equal(native.Bytes(), wantNative) {
				t.Fatalf("native received %x instead of %x", native.Bytes(), wantNative)
			}
			if err := gate.restore(lease); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNativeZmodemHeaderScannerOneByteChunks(t *testing.T) {
	var legacy, native bytes.Buffer
	gate := newTerminalOutputGate(&legacy)
	lease, err := gate.armOnZmodemHeader(&native)
	if err != nil {
		t.Fatal(err)
	}
	header := nativeZmodemHeaderTestStream()
	data := append(append([]byte("before "), header...), []byte{0, 0x18, 0xff}...)
	for _, b := range data {
		if n, err := gate.Write([]byte{b}); err != nil || n != 1 {
			t.Fatalf("single-byte Write failed: %d %v", n, err)
		}
	}
	if got := legacy.String(); got != "before " {
		t.Fatalf("legacy lost or gained bytes: %q", got)
	}
	if !bytes.Equal(native.Bytes(), data[len("before "):]) {
		t.Fatalf("native handoff lost frame bytes: %x", native.Bytes())
	}
	if err := gate.restore(lease); err != nil {
		t.Fatal(err)
	}
	if _, err := gate.Write([]byte("after transfer")); err != nil {
		t.Fatal(err)
	}
	if got := legacy.String(); got != "before after transfer" {
		t.Fatalf("legacy was not restored: %q", got)
	}
}

func TestNativeZmodemHeaderDisarmReplaysUnconfirmedPrefix(t *testing.T) {
	for _, tail := range [][]byte{
		[]byte("*"),
		[]byte("**\x18B01"),
		[]byte("**\x18B010123456789a"),
		[]byte("**\x18B02"),
		[]byte("**\x18B0z"),
		[]byte("**\x18B01ABCDEF123456"),
	} {
		var legacy, native bytes.Buffer
		gate := newTerminalOutputGate(&legacy)
		lease, err := gate.armOnZmodemHeader(&native)
		if err != nil {
			t.Fatal(err)
		}
		stream := append([]byte("normal:"), tail...)
		for _, b := range stream {
			if _, err := gate.Write([]byte{b}); err != nil {
				t.Fatal(err)
			}
		}
		if err := gate.disarm(lease); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(legacy.Bytes(), stream) {
			t.Fatalf("disarm dropped bytes: got %x want %x", legacy.Bytes(), stream)
		}
		if native.Len() != 0 {
			t.Fatalf("false frame triggered native transfer: %x", native.Bytes())
		}
	}
}

func TestNativeZmodemHeaderHandoffSkipsLegacyZmodemObserver(t *testing.T) {
	var terminal, native bytes.Buffer
	detected := false
	legacy := &zmodemDirectionWriter{
		dst: &terminal,
		onDirection: func(string) bool {
			detected = true
			return true
		},
	}
	gate := newTerminalOutputGate(legacy)
	if _, err := gate.armOnZmodemHeader(&native); err != nil {
		t.Fatal(err)
	}
	header := nativeZmodemHeaderTestStream()
	first := append([]byte("prompt"), header[:7]...)
	second := append(append([]byte(nil), header[7:]...), []byte("payload")...)
	for _, part := range [][]byte{first, second} {
		if _, err := gate.Write(part); err != nil {
			t.Fatal(err)
		}
	}
	if detected {
		t.Fatal("legacy trzsz observer consumed native protocol header")
	}
	if terminal.String() != "prompt" {
		t.Fatalf("terminal received binary protocol: %x", terminal.Bytes())
	}
	if !bytes.Equal(native.Bytes(), append(header, []byte("payload")...)) {
		t.Fatalf("native sidecar missed start header: %x", native.Bytes())
	}
}

func TestNativeZmodemHeaderLeaseAndFailureNeverFallBack(t *testing.T) {
	var legacy bytes.Buffer
	gate := newTerminalOutputGate(&legacy)
	first, err := gate.armOnZmodemHeader(failingTerminalSink{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gate.takeover(io.Discard); !errors.Is(err, errTerminalStreamOwned) {
		t.Fatalf("armed gate allowed direct takeover: %v", err)
	}
	if _, err := gate.armOnZmodemHeader(io.Discard); !errors.Is(err, errTerminalStreamOwned) {
		t.Fatalf("armed gate allowed second owner: %v", err)
	}
	if err := gate.disarm(first+1); !errors.Is(err, errTerminalStreamLease) {
		t.Fatalf("stale probe disarmed current transfer: %v", err)
	}
	if _, err := gate.Write(append([]byte("normal"), nativeZmodemHeaderTestStream()...)); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("native sink failure not propagated: %v", err)
	}
	if legacy.String() != "normal" {
		t.Fatalf("ZMODEM frame leaked to terminal: %x", legacy.Bytes())
	}
	if err := gate.disarm(first); !errors.Is(err, errTerminalStreamLease) {
		t.Fatalf("triggered native stream was incorrectly disarmed: %v", err)
	}
	if _, err := gate.Write([]byte("still protocol")); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("native error unexpectedly fell back: %v", err)
	}
	if legacy.String() != "normal" {
		t.Fatalf("native bytes leaked to legacy after failure: %x", legacy.Bytes())
	}
	if err := gate.restore(first); err != nil {
		t.Fatal(err)
	}
}

func TestNativeZmodemHeaderProbeHasBoundedBuffer(t *testing.T) {
	var scanner nativeZmodemStartScanner
	payload := bytes.Repeat([]byte("a"), 2*1024*1024)
	legacy, native, matched := scanner.feed(payload)
	if matched || len(native) != 0 || len(scanner.tail) >= nativeZmodemHeaderSize {
		t.Fatalf("unbounded or falsely matched probe: tail=%d matched=%v", len(scanner.tail), matched)
	}
	if !bytes.Equal(legacy, payload) {
		t.Fatal("ordinary payload was not forwarded verbatim")
	}
}
