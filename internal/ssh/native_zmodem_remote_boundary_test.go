package sshclient

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

const nativeRemoteBoundaryFixtureToken = "0123456789abcdef0123456789abcdef"

func nativeRemoteBoundaryFixtureMarker(status int) []byte {
	return []byte(fmt.Sprintf("\x1b]777;%s;%s;%d\x07",
		nativeRemoteBoundaryName, nativeRemoteBoundaryFixtureToken, status))
}

func TestNativeRemoteBoundaryCommandUsesNonceAndRecordsShellExit(t *testing.T) {
	for _, item := range []struct{ direction, remote, action, part string }{
		{"upload", "", "send", "{ rz -q;"},
		{"download", "hello's file.bin", "receive", "sz -q -- 'hello'\\''s file.bin';"},
	} {
		command, action, err := nativeInteractiveFencedCommand(
			item.direction, item.remote, nativeRemoteBoundaryFixtureToken)
		if err != nil || action != item.action || !strings.Contains(command, item.part) {
			t.Fatalf("invalid fenced command: %q %q %v", command, action, err)
		}
		if !strings.Contains(command, "printf '\\033]777;"+nativeRemoteBoundaryName) ||
			!strings.HasSuffix(command, "\r") || !strings.Contains(command, ";%d\\007'") {
			t.Fatalf("remote marker missing or not shell-escaped: %q", command)
		}
		// Shell echo contains printable backslashes, never an ESC control
		// byte; only the shell's printf can emit the matching OSC sequence.
		if bytes.Contains([]byte(command), []byte{0x1b}) {
			t.Fatal("shell command embeds a literal ESC that could spoof completion on echo")
		}
	}
	for _, token := range []string{"", "not-hex", "0123", "0123456789ABCDEF0123456789ABCDEF"} {
		if _, _, err := nativeInteractiveFencedCommand("upload", "", token); err == nil {
			t.Fatalf("invalid token accepted: %q", token)
		}
	}
	for range 3 {
		token, err := newNativeRemoteBoundaryToken()
		if err != nil || len(token) != 32 { t.Fatalf("nonce generation failed: %q, %v", token, err) }
	}
}

func TestNativeRemoteBoundaryAllSplitPositionsAreLossless(t *testing.T) {
	marker := nativeRemoteBoundaryFixtureMarker(0)
	protocol := append([]byte{0, 0x18, 0xff, 0, '*'}, bytes.Repeat([]byte("ZDATA"), 23)...)
	tail := []byte("shell-prompt\r\n")
	stream := bytes.Join([][]byte{protocol, marker, tail}, nil)

	for pos := 0; pos <= len(stream); pos++ {
		var remote, legacy bytes.Buffer
		sink := newNativeRemoteBoundarySink(&remote, nativeRemoteBoundaryFixtureToken)
		gate := newTerminalOutputGate(&legacy)
		lease, err := gate.takeover(sink)
		if err != nil { t.Fatal(err) }
		for _, part := range [][]byte{stream[:pos], stream[pos:]} {
			n, err := gate.Write(part)
			if err != nil || n != len(part) {
				t.Fatalf("split %d: Write = %d, %v", pos, n, err)
			}
		}
		select {
		case done := <-sink.completion:
			if done.err != nil || done.code != 0 { t.Fatalf("split %d: %+v", pos, done) }
		default:
			t.Fatalf("split %d: no completion", pos)
		}
		if !bytes.Equal(remote.Bytes(), protocol) {
			t.Fatalf("split %d: protocol corruption: got %x want %x", pos, remote.Bytes(), protocol)
		}
		if legacy.Len() != 0 { t.Fatalf("split %d: pre-recovery output leaked", pos) }
		if err := gate.restoreWithReplay(lease, sink.replayTrailing); err != nil { t.Fatal(err) }
		if !bytes.Equal(legacy.Bytes(), tail) {
			t.Fatalf("split %d: trailing output lost: %x", pos, legacy.Bytes())
		}
		if _, err := gate.Write([]byte("next")); err != nil { t.Fatal(err) }
		if legacy.String() != string(tail)+"next" { t.Fatal("output order changed after recovery") }
	}
}

func TestNativeRemoteBoundaryOneByteChunksAndNonzeroExit(t *testing.T) {
	var remote bytes.Buffer
	sink := newNativeRemoteBoundarySink(&remote, nativeRemoteBoundaryFixtureToken)
	marker := nativeRemoteBoundaryFixtureMarker(17)
	wire := append([]byte{0, 0xff, 0x18}, marker...)
	for _, b := range wire {
		if n, err := sink.Write([]byte{b}); n != 1 || err != nil { t.Fatalf("Write = %d, %v", n, err) }
	}
	if !bytes.Equal(remote.Bytes(), []byte{0, 0xff, 0x18}) { t.Fatal("binary protocol changed") }
	select {
	case result := <-sink.completion:
		if result.code != 17 { t.Fatalf("lost exit status: %+v", result) }
	default:
		t.Fatal("missing remote exit code")
	}
}

func TestNativeRemoteBoundaryIgnoresWrongNonceAndIncompleteMarker(t *testing.T) {
	var remote bytes.Buffer
	sink := newNativeRemoteBoundarySink(&remote, nativeRemoteBoundaryFixtureToken)
	impostor := []byte("\x1b]777;" + nativeRemoteBoundaryName + ";ffffffffffffffffffffffffffffffff;0\x07")
	if _, err := sink.Write(impostor); err != nil { t.Fatal(err) }
	select {
	case <-sink.completion: t.Fatal("incorrect nonce accepted")
	default:
	}
	// A possible prefix must be held until the caller cancels rather than
	// being mistakenly treated as a verified successful remote completion.
	if _, err := sink.Write([]byte("\x1b]777;" + nativeRemoteBoundaryName + ";")); err != nil { t.Fatal(err) }
	select {
	case <-sink.completion: t.Fatal("incomplete marker accepted")
	default:
	}
	if !bytes.Equal(remote.Bytes(), append(impostor, []byte("\x1b]777;"+nativeRemoteBoundaryName+";")...)) {
		// All bytes not representing a possible prefix are forwarded.
		// A trailing unmatched prefix may be withheld by design.
		if !bytes.Equal(remote.Bytes(), impostor) { t.Fatal("incorrect nonce bytes were corrupted") }
	}
}

func TestNativeRemoteBoundaryRejectsMalformedStatusAndLargePrompt(t *testing.T) {
	for _, value := range []string{"-1", "999", "abcd", "1234", ""} {
		sink := newNativeRemoteBoundarySink(io.Discard, nativeRemoteBoundaryFixtureToken)
		malformed := []byte("\x1b]777;" + nativeRemoteBoundaryName + ";" + nativeRemoteBoundaryFixtureToken + ";" + value + "\x07")
		if _, err := sink.Write(malformed); err == nil {
			t.Fatalf("malformed exit status was accepted: %q", value)
		}
	}
	sink := newNativeRemoteBoundarySink(io.Discard, nativeRemoteBoundaryFixtureToken)
	if _, err := sink.Write(nativeRemoteBoundaryFixtureMarker(0)); err != nil { t.Fatal(err) }
	if _, err := sink.Write(bytes.Repeat([]byte("p"), nativeRemoteBoundaryPostLimit+1)); err == nil {
		t.Fatal("unbounded terminal output retained after completion")
	}
}

func TestNativeRemoteBoundaryRecoveryFailsClosedOnLegacyReplayFailure(t *testing.T) {
	sink := newNativeRemoteBoundarySink(io.Discard, nativeRemoteBoundaryFixtureToken)
	gate := newTerminalOutputGate(failingTerminalSink{})
	lease, err := gate.takeover(sink)
	if err != nil { t.Fatal(err) }
	_, err = gate.Write(append(nativeRemoteBoundaryFixtureMarker(0), []byte("prompt")...))
	if err != nil { t.Fatal(err) }
	if err := gate.restoreWithReplay(lease, sink.replayTrailing); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected terminal replay error, got %v", err)
	}
	if _, err := gate.takeover(io.Discard); !errors.Is(err, errTerminalStreamOwned) {
		t.Fatalf("failed replay unconditionally restored terminal: %v", err)
	}
}
