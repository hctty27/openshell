package sshclient

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

func TestNativeZmodemInputGateSeparatesManualAndProtocolData(t *testing.T) {
	var legacy, remote bytes.Buffer
	gate := newTerminalInputGate(&legacy, &remote)
	if _, err := gate.Write([]byte("ordinary input")); err != nil { t.Fatal(err) }
	lease, err := gate.takeover()
	if err != nil { t.Fatal(err) }

	if n, err := gate.Write([]byte("typed during transfer")); n != 0 || !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("manual input was accepted: %d %v", n, err)
	}
	payload := []byte{0x00, 0x18, 0x42, 0xff}
	if n, err := gate.writeNative(lease, payload); n != len(payload) || err != nil {
		t.Fatalf("native bytes not forwarded: %d %v", n, err)
	}
	if legacy.String() != "ordinary input" { t.Fatalf("legacy input was contaminated: %q", legacy.String()) }
	if !bytes.Equal(remote.Bytes(), payload) { t.Fatalf("remote payload mismatch: %x", remote.Bytes()) }

	if err := gate.restore(lease); err != nil { t.Fatal(err) }
	if _, err := gate.Write([]byte("post-transfer")); err != nil { t.Fatal(err) }
	if legacy.String() != "ordinary inputpost-transfer" {
		t.Fatalf("legacy input did not recover: %q", legacy.String())
	}
}

func TestNativeZmodemInputGateLeasesDoNotCrossTransfers(t *testing.T) {
	gate := newTerminalInputGate(io.Discard, io.Discard)
	first, err := gate.takeover()
	if err != nil { t.Fatal(err) }
	if _, err := gate.takeover(); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("overlapping transfer accepted: %v", err)
	}
	if _, err := gate.writeNative(first+1, []byte("wrong token")); !errors.Is(err, errNativeTerminalInputLease) {
		t.Fatalf("stale writer accepted: %v", err)
	}
	if err := gate.restore(first+1); !errors.Is(err, errNativeTerminalInputLease) {
		t.Fatalf("stale token restored input: %v", err)
	}
	if err := gate.restore(first); err != nil { t.Fatal(err) }
	second, err := gate.takeover()
	if err != nil { t.Fatal(err) }
	if second == first { t.Fatal("input token reused") }
	if _, err := gate.writeNative(first, []byte("stale")); !errors.Is(err, errNativeTerminalInputLease) {
		t.Fatalf("old protocol sender accepted: %v", err)
	}
	if err := gate.restore(second); err != nil { t.Fatal(err) }
}

func TestNativeZmodemInputGateWaitsForInflightManualWrite(t *testing.T) {
	sink := &blockingTerminalSink{started: make(chan struct{}), release: make(chan struct{})}
	gate := newTerminalInputGate(sink, io.Discard)
	written := make(chan error, 1)
	go func() { _, err := gate.Write([]byte("last manual input")); written <- err }()
	select {
	case <-sink.started:
	case <-time.After(time.Second): t.Fatal("manual write never began")
	}
	acquired := make(chan error, 1)
	go func() { _, err := gate.takeover(); acquired <- err }()
	select {
	case err := <-acquired: t.Fatalf("takeover bypassed inflight write: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(sink.release)
	select {
	case err := <-written:
		if err != nil { t.Fatal(err) }
	case <-time.After(time.Second): t.Fatal("manual writer stuck")
	}
	select {
	case err := <-acquired:
		if err != nil { t.Fatal(err) }
	case <-time.After(time.Second): t.Fatal("native takeover stuck")
	}
	if _, err := gate.Write([]byte("should be blocked")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("manual bytes crossed ownership boundary: %v", err)
	}
}

type rejectNativeInputWriter struct{}
func (rejectNativeInputWriter) Write([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestNativeZmodemInputGateNeverFallsBackAfterProtocolError(t *testing.T) {
	var legacy bytes.Buffer
	gate := newTerminalInputGate(&legacy, rejectNativeInputWriter{})
	lease, err := gate.takeover()
	if err != nil { t.Fatal(err) }
	if _, err := gate.writeNative(lease, []byte("ZMODEM DATA")); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("remote failure not propagated: %v", err)
	}
	if _, err := gate.Write([]byte("user text")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("failed native writer reenabled manual input: %v", err)
	}
	if legacy.Len() != 0 { t.Fatalf("protocol fallback leaked bytes: %q", legacy.String()) }
	if err := gate.restore(lease); err != nil { t.Fatal(err) }
}

func TestNativeZmodemInputGateCloseRevokesAllInput(t *testing.T) {
	gate := newTerminalInputGate(io.Discard, io.Discard)
	lease, err := gate.takeover()
	if err != nil { t.Fatal(err) }
	gate.close()
	if _, err := gate.Write([]byte("manual")); !errors.Is(err, io.ErrClosedPipe) { t.Fatal(err) }
	if _, err := gate.writeNative(lease, []byte("native")); !errors.Is(err, io.ErrClosedPipe) { t.Fatal(err) }
	if err := gate.restore(lease); !errors.Is(err, io.ErrClosedPipe) { t.Fatal(err) }
	if _, err := gate.takeover(); !errors.Is(err, io.ErrClosedPipe) { t.Fatal(err) }
}

func TestNativeZmodemInputGateBlocksManagerManualWrites(t *testing.T) {
	manager, ref := connected(t)
	if err := manager.OpenTerminal(ref, 80, 24); err != nil { t.Fatal(err) }
	manager.mu.Lock()
	connection := manager.connections[ref.TabID]
	gate := connection.inputGate
	manager.mu.Unlock()
	if gate == nil { t.Fatal("interactive terminal is missing its input gate") }
	lease, err := gate.takeover()
	if err != nil { t.Fatal(err) }
	defer gate.restore(lease)
	encoded := base64.StdEncoding.EncodeToString([]byte("blocked keypress"))
	if err := manager.Write(ref, encoded); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("manager accepted keypress during native lease: %v", err)
	}
}

// Include a parallel lease stress test in Go race CI.
func TestNativeZmodemInputGateSerializesConcurrentNativeWrites(t *testing.T) {
	var remote bytes.Buffer
	gate := newTerminalInputGate(io.Discard, &remote)
	lease, err := gate.takeover()
	if err != nil { t.Fatal(err) }
	const writers = 16
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := gate.writeNative(lease, []byte{0xab}); err != nil { t.Error(err) }
		}()
	}
	wg.Wait()
	if len(remote.Bytes()) != writers { t.Fatalf("lost concurrent native writes: %d", remote.Len()) }
}
