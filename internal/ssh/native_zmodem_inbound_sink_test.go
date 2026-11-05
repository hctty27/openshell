package sshclient

import (
	"errors"
	"io"
	"testing"
	"time"
)

// A real sidecar can exit after its final protocol frame while an SSH stdout
// goroutine is still blocked writing to its dedicated pipe. Expected shutdown
// must not poison an otherwise healthy SSH session or leak binary data to UI.
func TestNativeZmodemInboundSinkConcurrentSidecarFinish(t *testing.T) {
	for i := 0; i < 64; i++ {
		reader, writer := io.Pipe()
		sink := &nativeTerminalInboundSink{
			pipe: writer,
			ready: make(chan struct{}),
			fail: make(chan error, 1),
			expected: '1',
		}
		start := nativeZmodemHeaderTestStream()
		done := make(chan struct {
			n int
			err error
		}, 1)
		go func() {
			n, err := sink.Write(start)
			done <- struct {
				n int
				err error
			}{n, err}
		}()
		select {
		case <-sink.ready:
		case <-time.After(time.Second):
			t.Fatal("header not recognized")
		}
		sink.finish(reader)
		select {
		case result := <-done:
			if result.err != nil || result.n != len(start) {
				t.Fatalf("iteration %d: sidecar completion leaked shutdown error: n=%d err=%v", i, result.n, result.err)
			}
		case <-time.After(time.Second):
			t.Fatal("in-flight remote protocol write remained blocked")
		}
		select {
		case err := <-sink.fail:
			t.Fatalf("intentional pipe shutdown incorrectly signalled transfer failure: %v", err)
		default:
		}
		if n, err := sink.Write([]byte{0x18, 0x00, 0xff}); err != nil || n != 3 {
			t.Fatalf("late native byte after finish was not isolated: n=%d err=%v", n, err)
		}
	}
}

func TestNativeZmodemInboundSinkUnexpectedPipeCloseStillFails(t *testing.T) {
	reader, writer := io.Pipe()
	sink := &nativeTerminalInboundSink{
		pipe: writer,
		ready: make(chan struct{}),
		fail: make(chan error, 1),
		expected: '1',
	}
	// This is a genuinely unexpected reader failure; finish was not called.
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	payload := nativeZmodemHeaderTestStream()
	if _, err := sink.Write(payload); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("unplanned pipe closure was swallowed: %v", err)
	}
	select {
	case err := <-sink.fail:
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("unexpected failure was misreported: %v", err)
		}
	default:
		t.Fatal("unexpected pipe error did not notify the transfer coordinator")
	}
	_ = writer.Close()
}
