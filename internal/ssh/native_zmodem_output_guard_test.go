package sshclient

import (
	"bytes"
	"testing"
)

func TestNativeOnlyOutputGuardBlocksUnclaimedZmodemAcrossChunks(t *testing.T) {
	var visible bytes.Buffer
	notifications := 0
	guard := newNativeOnlyOutputGuard(&visible, func() { notifications++ })
	header := nativeZmodemHeaderFixture(1)
	if len(header) != nativeZmodemHeaderSize {
		t.Fatalf("invalid test header length: %d", len(header))
	}
	chunks := [][]byte{
		[]byte("visible shell\r\n"), header[:2], header[2:9],
		append(header[9:], []byte("binary-secret")...),
		[]byte("never-visible"),
	}
	for _, chunk := range chunks {
		if n, err := guard.Write(chunk); n != len(chunk) || err != nil {
			t.Fatalf("guard consumed %d of %d bytes: %v", n, len(chunk), err)
		}
	}
	if notifications != 1 { t.Fatalf("unexpected notices: %d", notifications) }
	if visible.String() != "visible shell\r\n" {
		t.Fatalf("protocol escaped output guard: %q", visible.String())
	}
}

func TestNativeOnlyOutputGuardPreservesOrdinaryTerminalOutput(t *testing.T) {
	var visible bytes.Buffer
	notifications := 0
	guard := newNativeOnlyOutputGuard(&visible, func() { notifications++ })
	for _, chunk := range [][]byte{
		[]byte("hello "), []byte("\x1b[32m中文\x1b[0m "),
		[]byte("**ordinary"), []byte(" text\r\n"),
	} {
		if _, err := guard.Write(chunk); err != nil { t.Fatal(err) }
	}
	if notifications != 0 { t.Fatalf("ordinary output looked like ZMODEM: %d", notifications) }
	if visible.String() != "hello \x1b[32m中文\x1b[0m **ordinary text\r\n" {
		t.Fatalf("ordinary terminal output changed: %q", visible.String())
	}
}


func TestNativeOnlyOutputGuardQuarantinesSuspectedCorruptedHandshake(t *testing.T) {
	var visible bytes.Buffer
	notifications := 0
	guard := newNativeOnlyOutputGuard(&visible, func() { notifications++ })
	fake := []byte("**\x18B0100000000aa50")
	if _, err := guard.Write([]byte("shell:")); err != nil { t.Fatal(err) }
	for _, chunk := range [][]byte{fake[:4], fake[4:9], fake[9:]} {
		if _, err := guard.Write(chunk); err != nil { t.Fatal(err) }
	}
	if _, err := guard.Write([]byte("more binary-like output")); err != nil { t.Fatal(err) }
	if notifications != 1 {
		t.Fatalf("corrupted unsolicited protocol was allowed to reach xterm: notices=%d", notifications)
	}
	if visible.String() != "shell:" {
		t.Fatalf("ZMODEM bytes escaped the fail-closed guard: %q", visible.String())
	}
}
