package sshclient

import (
	"bytes"
	"testing"
)

func TestNativeOnlyOutputGuardBlocksUnclaimedZmodemAcrossChunks(t *testing.T) {
	var visible bytes.Buffer
	notifications := 0
	guard := newNativeOnlyOutputGuard(&visible, func() { notifications++ })
	header := append([]byte("**\x18B01"), []byte("0123456789ab")...)
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
