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


func TestNativeOnlyOutputGuardRequiresValidCRCBeforeQuarantine(t *testing.T) {
	var visible bytes.Buffer
	notifications := 0
	guard := newNativeOnlyOutputGuard(&visible, func() { notifications++ })
	fake := []byte("**\x18B0100000000aa50")
	if _, err := guard.Write([]byte("prompt:")); err != nil { t.Fatal(err) }
	for _, chunk := range [][]byte{fake[:4], fake[4:9], fake[9:]} {
		if _, err := guard.Write(chunk); err != nil { t.Fatal(err) }
	}
	if _, err := guard.Write([]byte(" normal output\r\n")); err != nil { t.Fatal(err) }
	if notifications != 0 {
		t.Fatalf("invalid header unexpectedly quarantined the SSH terminal: %d", notifications)
	}
	want := append([]byte("prompt:"), fake...)
	want = append(want, []byte(" normal output\r\n")...)
	if !bytes.Equal(visible.Bytes(), want) {
		t.Fatalf("invalid header lost terminal output: got %q want %q", visible.Bytes(), want)
	}

	header := nativeZmodemHeaderFixture(0)
	for _, chunk := range [][]byte{header[:7], header[7:]} {
		if _, err := guard.Write(chunk); err != nil { t.Fatal(err) }
	}
	if notifications != 1 { t.Fatalf("valid ZRQINIT failed to quarantine: %d", notifications) }
	if !bytes.Equal(visible.Bytes(), want) {
		t.Fatalf("real ZMODEM frame reached xterm: %x", visible.Bytes()[len(want):])
	}
}
