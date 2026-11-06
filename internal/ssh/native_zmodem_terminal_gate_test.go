package sshclient

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

func TestNativeZmodemTerminalGateKeepsBinaryBytesOutOfLegacyOutput(t *testing.T) {
	var legacy, native bytes.Buffer
	gate := newTerminalOutputGate(&legacy)

	if _, err := gate.Write([]byte("shell prompt")); err != nil {
		t.Fatal(err)
	}
	lease, err := gate.takeover(&native)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte{0x00, 0x18, 0x42, 0x00, 0xff, 0x18}
	if _, err := gate.Write(payload); err != nil {
		t.Fatal(err)
	}
	if got := legacy.String(); got != "shell prompt" {
		t.Fatalf("protocol bytes entered legacy terminal: %q", got)
	}
	if !bytes.Equal(native.Bytes(), payload) {
		t.Fatalf("native destination got %x; want %x", native.Bytes(), payload)
	}
	if err := gate.restore(lease); err != nil {
		t.Fatal(err)
	}
	if _, err := gate.Write([]byte("next prompt")); err != nil {
		t.Fatal(err)
	}
	if got := legacy.String(); got != "shell promptnext prompt" {
		t.Fatalf("legacy routing not restored: %q", got)
	}
	if !bytes.Equal(native.Bytes(), payload) {
		t.Fatalf("native destination received legacy bytes: %x", native.Bytes())
	}
}

func TestNativeZmodemTerminalGateRejectsStaleTakeoverAndRestoration(t *testing.T) {
	gate := newTerminalOutputGate(io.Discard)
	if _, err := gate.takeover(nil); err == nil {
		t.Fatal("nil native sink accepted")
	}
	first, err := gate.takeover(io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gate.takeover(io.Discard); !errors.Is(err, errTerminalStreamOwned) {
		t.Fatalf("concurrent native consumer accepted: %v", err)
	}
	if err := gate.restore(first + 1); !errors.Is(err, errTerminalStreamLease) {
		t.Fatalf("invalid lease restored routing: %v", err)
	}
	if err := gate.restore(first); err != nil {
		t.Fatal(err)
	}
	second, err := gate.takeover(io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if second == first {
		t.Fatal("lease token was reused")
	}
	if err := gate.restore(first); !errors.Is(err, errTerminalStreamLease) {
		t.Fatalf("stale transfer restored newer ownership: %v", err)
	}
	if err := gate.restore(second); err != nil {
		t.Fatal(err)
	}
}

type blockingTerminalSink struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *blockingTerminalSink) Write(p []byte) (int, error) {
	s.once.Do(func() { close(s.started) })
	<-s.release
	return len(p), nil
}

func TestNativeZmodemTerminalGateWaitsForInflightLegacyWrite(t *testing.T) {
	blocking := &blockingTerminalSink{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	gate := newTerminalOutputGate(blocking)
	writeDone := make(chan error, 1)
	go func() {
		_, err := gate.Write([]byte("first"))
		writeDone <- err
	}()
	select {
	case <-blocking.started:
	case <-time.After(time.Second):
		t.Fatal("legacy writer not started")
	}

	var native bytes.Buffer
	startTakeover := make(chan struct{})
	acquired := make(chan error, 1)
	go func() {
		close(startTakeover)
		_, err := gate.takeover(&native)
		acquired <- err
	}()
	<-startTakeover
	select {
	case err := <-acquired:
		t.Fatalf("acquired native output before inflight legacy write ended: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(blocking.release)
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("legacy write not released")
	}
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("native takeover remained blocked")
	}
	if _, err := gate.Write([]byte("native only")); err != nil {
		t.Fatal(err)
	}
	if got := native.String(); got != "native only" {
		t.Fatalf("native stream was not exclusive: %q", got)
	}
}

type failingTerminalSink struct{}

func (failingTerminalSink) Write([]byte) (int, error) {
	return 0, io.ErrUnexpectedEOF
}

func TestNativeZmodemTerminalGateDoesNotFallbackOnNativeWriteError(t *testing.T) {
	var legacy bytes.Buffer
	gate := newTerminalOutputGate(&legacy)
	lease, err := gate.takeover(failingTerminalSink{})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := gate.Write([]byte("secret binary protocol")); !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("native write unexpectedly succeeded or fell back: %v", err)
		}
	}
	if legacy.Len() != 0 {
		t.Fatalf("binary content leaked to terminal: %q", legacy.String())
	}
	if err := gate.restore(lease); err != nil {
		t.Fatal(err)
	}
}

func TestNativeZmodemTerminalGateCloseRejectsAllWrites(t *testing.T) {
	gate := newTerminalOutputGate(io.Discard)
	lease, err := gate.takeover(io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	gate.close()
	if _, err := gate.Write([]byte("no output")); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("closed terminal accepted output: %v", err)
	}
	if _, err := gate.takeover(io.Discard); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("closed terminal allowed takeover: %v", err)
	}
	if err := gate.restore(lease); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("closed terminal allowed restore: %v", err)
	}
}

// The command echo and shell chatter before the remote ZMODEM header are
// experiment-private. Normal terminal output resumes only after verified restore.
func TestNativeZmodemTerminalGateQuietPreludeAcrossChunks(t *testing.T) {
	var legacy, native bytes.Buffer
	gate := newTerminalOutputGate(&legacy)
	lease, err := gate.armOnZmodemHeaderQuiet(&native)
	if err != nil { t.Fatal(err) }
	header := nativeZmodemHeaderTestStream()
	for _, chunk := range [][]byte{
		[]byte("{ rz -q; __openshell_native_zmodem_rc=$?; printf '...\\r\\n"),
		[]byte("shell echo\\r\\n"),
		header[:6],
		header[6:],
		[]byte("native-payload"),
	} {
		if _, err := gate.Write(chunk); err != nil { t.Fatal(err) }
	}
	if legacy.Len() != 0 { t.Fatalf("experimental command echo leaked: %q", legacy.String()) }
	if got := native.Bytes(); !bytes.Equal(got, append(append([]byte(nil), header...), []byte("native-payload")...)) {
		t.Fatalf("native bytes corrupted: %x", got)
	}
	if err := gate.restoreWithReplay(lease, func() []byte { return []byte("shell restored") }); err != nil { t.Fatal(err) }
	if _, err := gate.Write([]byte(" prompt")); err != nil { t.Fatal(err) }
	if got := legacy.String(); got != "shell restored prompt" { t.Fatalf("normal output not restored: %q", got) }
}

func TestNativeZmodemTerminalGateNormalPreludeStillVisible(t *testing.T) {
	var legacy, native bytes.Buffer
	gate := newTerminalOutputGate(&legacy)
	_, err := gate.armOnZmodemHeader(&native)
	if err != nil { t.Fatal(err) }
	if _, err := gate.Write([]byte("visible shell output")); err != nil { t.Fatal(err) }
	if got := legacy.String(); got != "visible shell output" { t.Fatalf("default routing changed: %q", got) }
}
