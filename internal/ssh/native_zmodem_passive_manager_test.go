package sshclient

import (
	"bytes"
	"errors"
	"io"
	"testing"
	"time"
)

func TestNativePassiveDetectsRemoteFrameAndOpensOnlyMatchingPicker(t *testing.T) {
	for _, kind := range []byte{0, 1} {
		t.Run(string('0'+rune(kind)), func(t *testing.T) {
			m, ref, _, events := nativeAutoTestManager(t, true, true)
			c := m.connections[ref.TabID]
			var visible bytes.Buffer
			guard := newNativeOnlyOutputGuardPassive(&visible, func() {},
				c.inputGate.blockPassiveInput, func(frame byte) {
					go m.handleNativePassiveFrame(ref, c, frame)
				})
			c.outputGuard = guard
			c.outputGate = newTerminalOutputGate(guard)
			if _, err := c.outputGate.Write(nativeZmodemHeaderFixture(kind)); err != nil { t.Fatal(err) }
			var event map[string]any
			select {
			case event = <-events:
			case <-time.After(2 * time.Second): t.Fatal("passive ZMODEM picker intent never arrived")
			}
			direction := "download"
			if kind == 1 { direction = "upload" }
			if event["direction"] != direction || event["passive"] != true {
				t.Fatalf("wrong passive direction: %v", event)
			}
			id, ok := event["selectionId"].(uint64)
			if !ok || id == 0 { t.Fatalf("missing picker ID: %v", event) }
			if found, err := m.PassiveZmodemSelection(ref, id); err != nil || found != direction {
				t.Fatalf("selected direction invalid: %s %v", found, err)
			}
			if _, err := m.PassiveZmodemSelection(ref, id+1); err == nil {
				t.Fatal("stale selection ID was accepted")
			}
			if _, err := c.inputGate.Write([]byte("manual")); !errors.Is(err, errNativeTerminalInputBusy) {
				t.Fatalf("SSH input escaped passive lock: %v", err)
			}
			if !m.ReleaseNativeZmodemSelection(ref, id) { t.Fatal("picker cancellation was rejected") }
			if _, err := c.inputGate.Write([]byte("manual")); !errors.Is(err, errNativeTerminalInputBusy) {
				t.Fatalf("passive cancellation falsely recovered PTY: %v", err)
			}
			if !c.nativeTerminalPoisoned { t.Fatal("unverified remote completion did not poison shell") }
			if _, _, pending := guard.pendingCapture(); pending {
				t.Fatal("cancelled passive picker retained protocol bytes in memory")
			}
			if visible.Len() != 0 { t.Fatalf("protocol exposed to xterm: %x", visible.Bytes()) }
		})
	}
}

func TestNativePassiveCaptureDeniedWhenSSHContextIsBusy(t *testing.T) {
	m, ref, _, events := nativeAutoTestManager(t, true, true)
	c := m.connections[ref.TabID]
	c.nativeTerminalPoisoned = true
	var visible bytes.Buffer
	guard := newNativeOnlyOutputGuardPassive(&visible, func() {},
		c.inputGate.blockPassiveInput, func(frame byte) { go m.handleNativePassiveFrame(ref, c, frame) })
	c.outputGuard = guard
	c.outputGate = newTerminalOutputGate(guard)
	if _, err := c.outputGate.Write(nativeZmodemHeaderFixture(0)); err != nil { t.Fatal(err) }
	select {
	case <-events:
		t.Fatal("poisoned SSH session opened an unauthorized picker")
	case <-time.After(80 * time.Millisecond):
	}
	if _, err := c.inputGate.Write([]byte("bad")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("terminal did not remain isolated: %v", err)
	}
	if _, _, ok := guard.pendingCapture(); ok {
		t.Fatal("rejected remote handshake still retained its protocol buffer")
	}
	guard.mu.Lock()
	quarantined := guard.quarantined
	guard.mu.Unlock()
	if !quarantined {
		t.Fatal("rejected remote ZMODEM protocol was incorrectly returned to xterm")
	}
}

var _ io.Writer = (*bytes.Buffer)(nil)


func TestNativePassiveSelectionExpiryIsFailClosedAndGenerationScoped(t *testing.T) {
	m, ref, _, intents := nativeAutoTestManager(t, true, true)
	c := m.connections[ref.TabID]
	var visible bytes.Buffer
	var sequence []string
	originalEmit := m.emit
	m.emit = func(name string, payload any) {
		if name == "ssh:native-zmodem-unsupported" || name == "ssh:native-zmodem-selection" {
			sequence = append(sequence, name)
		}
		originalEmit(name, payload)
	}
	guard := newNativeOnlyOutputGuardPassive(&visible, func() {},
		c.inputGate.blockPassiveInput, func(frame byte) { go m.handleNativePassiveFrame(ref, c, frame) })
	c.outputGuard = guard
	c.outputGate = newTerminalOutputGate(guard)
	if _, err := c.outputGate.Write(nativeZmodemHeaderFixture(0)); err != nil { t.Fatal(err) }
	var intent map[string]any
	select {
	case intent = <-intents:
	case <-time.After(2 * time.Second):
		t.Fatal("passive handshake not accepted")
	}
	id := intent["selectionId"].(uint64)
	if m.expireNativePassiveSelection(ref, c, id+1) {
		t.Fatal("expired a different picker generation")
	}
	staleRef := ref
	staleRef.Generation++
	if m.expireNativePassiveSelection(staleRef, c, id) {
		t.Fatal("expired a stale SSH connection generation")
	}
	if !m.expireNativePassiveSelection(ref, c, id) {
		t.Fatal("active passive picker was not expired")
	}
	if len(sequence) != 2 ||
		sequence[0] != "ssh:native-zmodem-unsupported" ||
		sequence[1] != "ssh:native-zmodem-selection" {
		t.Fatalf("unsafe UI release order: %v", sequence)
	}
	if !c.nativeTerminalPoisoned || c.nativeZmodemSelection || c.nativeZmodemSelectionPassive {
		t.Fatal("expired picker retained ownership or incorrectly restored the terminal")
	}
	if _, _, pending := guard.pendingCapture(); pending {
		t.Fatal("expired picker still buffers remote protocol bytes")
	}
	if _, err := c.inputGate.Write([]byte("ls\r")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("terminal typing was allowed after expiry: %v", err)
	}
	if m.expireNativePassiveSelection(ref, c, id) {
		t.Fatal("duplicate timeout changed a completed picker")
	}
	if !bytes.Equal(visible.Bytes(), nil) {
		t.Fatal("expired protocol bytes appeared in xterm")
	}
}

func TestNativePassiveSelectionExpiryDoesNotCancelAdmittedTransfer(t *testing.T) {
	m, ref, _, intents := nativeAutoTestManager(t, true, true)
	c := m.connections[ref.TabID]
	guard := newNativeOnlyOutputGuardPassive(io.Discard, func() {},
		c.inputGate.blockPassiveInput, func(frame byte) { go m.handleNativePassiveFrame(ref, c, frame) })
	c.outputGuard = guard
	c.outputGate = newTerminalOutputGate(guard)
	if _, err := c.outputGate.Write(nativeZmodemHeaderFixture(1)); err != nil { t.Fatal(err) }
	var intent map[string]any
	select {
	case intent = <-intents:
	case <-time.After(2 * time.Second): t.Fatal("passive handshake not accepted")
	}
	id := intent["selectionId"].(uint64)
	m.mu.Lock()
	c.nativeZmodemSelection = false
	c.nativeZmodemSelectionPassive = false
	c.nativeTerminalTransfer = &nativeTerminalTransferTask{ref:ref, cancel:func(){}}
	m.mu.Unlock()
	if m.expireNativePassiveSelection(ref, c, id) {
		t.Fatal("expired an already-running native transfer")
	}
	if _, err := m.PassiveZmodemSelection(ref, id); err == nil {
		t.Fatal("completed picker remained available to a stale UI")
	}
}


func TestNativePassivePrebufferOverflowRevokesPickerImmediately(t *testing.T) {
	m, ref, _, intents := nativeAutoTestManager(t, true, true)
	c := m.connections[ref.TabID]
	notices := make(chan string, 2)
	releases := make(chan uint64, 2)
	originalEmit := m.emit
	m.emit = func(name string, payload any) {
		if p, ok := payload.(map[string]any); ok {
			switch name {
			case "ssh:native-zmodem-unsupported":
				notices <- p["error"].(string)
			case "ssh:native-zmodem-selection":
				releases <- p["selectionId"].(uint64)
			}
		}
		originalEmit(name, payload)
	}
	guard := newNativeOnlyOutputGuardPassive(io.Discard,
		func() { m.failNativePassiveGuard(ref, c) },
		c.inputGate.blockPassiveInput,
		func(frame byte) { go m.handleNativePassiveFrame(ref, c, frame) },
	)
	c.outputGuard = guard
	c.outputGate = newTerminalOutputGate(guard)
	if _, err := c.outputGate.Write(nativeZmodemHeaderFixture(0)); err != nil {
		t.Fatal(err)
	}
	var intent map[string]any
	select {
	case intent = <-intents:
	case <-time.After(2 * time.Second): t.Fatal("valid remote ZHEX did not open the picker")
	}
	id := intent["selectionId"].(uint64)
	if _, err := c.outputGate.Write(bytes.Repeat([]byte{'x'}, nativePassiveHandshakeBufferLimit)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-notices:
	default: t.Fatal("overflow did not immediately warn the user")
	}
	select {
	case released := <-releases:
		if released != id { t.Fatalf("overflow closed wrong picker: %d != %d", released, id) }
	default:
		t.Fatal("overflow left picker active until delayed timeout")
	}
	m.mu.Lock()
	poisoned := c.nativeTerminalPoisoned
	pendingPicker := c.nativeZmodemSelection
	m.mu.Unlock()
	if !poisoned || pendingPicker {
		t.Fatal("overflow incorrectly retained the selection or restored SSH")
	}
	if _, _, ok := guard.pendingCapture(); ok {
		t.Fatal("overflow retained a claimable handshake")
	}
	if m.ReleaseNativeZmodemSelection(ref, id) {
		t.Fatal("stale frontend cancellation succeeded after overflow")
	}
	if _, err := c.inputGate.Write([]byte("pwd\r")); !errors.Is(err, errNativeTerminalInputBusy) {
		t.Fatalf("SSH input escaped after overflow: %v", err)
	}
}
