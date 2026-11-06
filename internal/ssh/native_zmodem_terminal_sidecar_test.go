package sshclient

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// The test binary acts as a cross-platform sidecar child. It exits during
// init before the Go test runner begins executing unrelated test cases.
func init() {
	if os.Getenv("OPENSHELL_ZMODEM_TERMINAL_CHILD_TEST") != "1" {
		return
	}
	switch os.Getenv("OPENSHELL_ZMODEM_TERMINAL_CHILD_MODE") {
	case "echo":
		_, err := io.Copy(os.Stdout, os.Stdin)
		if err != nil { os.Exit(8) }
		os.Exit(0)
	case "fail":
		_, _ = os.Stderr.WriteString("sidecar diagnostic: simulated protocol failure")
		os.Exit(17)
	case "sleep":
		time.Sleep(20 * time.Second)
		os.Exit(0)
	default:
		os.Exit(9)
	}
}

func nativeTerminalSidecarTestEnv(t *testing.T, mode string) {
	t.Helper()
	t.Setenv("OPENSHELL_ZMODEM_TERMINAL_CHILD_TEST", "1")
	t.Setenv("OPENSHELL_ZMODEM_TERMINAL_CHILD_MODE", mode)
}

func TestNativeZmodemTerminalSidecarEchoPreservesBinaryPayload(t *testing.T) {
	nativeTerminalSidecarTestEnv(t, "echo")
	payload := append(bytes.Repeat([]byte{0, 0x18, 0x42, 0xff}, 4096), []byte("中文")...)
	input := io.NopCloser(bytes.NewReader(payload))
	var output bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runNativeZmodemTerminalSidecar(ctx, os.Args[0], "send", "unused.bin", input, &output); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, output.Bytes()) {
		t.Fatalf("native binary channel mismatch: got %d bytes; want %d", output.Len(), len(payload))
	}
}

func TestNativeZmodemTerminalSidecarReportsChildFailureWithoutWireContamination(t *testing.T) {
	nativeTerminalSidecarTestEnv(t, "fail")
	var output bytes.Buffer
	err := runNativeZmodemTerminalSidecar(
		context.Background(), os.Args[0], "receive", "unused-dir",
		io.NopCloser(bytes.NewReader(nil)), &output,
	)
	if err == nil || !strings.Contains(err.Error(), "sidecar diagnostic") {
		t.Fatalf("process failure and bounded stderr not reported: %v", err)
	}
	if output.Len() != 0 {
		t.Fatalf("stderr leaked to binary stdout channel: %q", output.String())
	}
}

func TestNativeZmodemTerminalSidecarDeadlineKillsChild(t *testing.T) {
	nativeTerminalSidecarTestEnv(t, "sleep")
	// A blocked inbound pipe must be closed when the child is cancelled.
	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := runNativeZmodemTerminalSidecar(ctx, os.Args[0], "send", "unused",
		reader, io.Discard)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline did not propagate: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("cancel failed to stop sidecar: %v", elapsed)
	}
}

func TestNativeZmodemTerminalSidecarRejectsUnsafeInputs(t *testing.T) {
	tests := []struct {
		ctx context.Context
		executable, direction, path string
		inbound io.ReadCloser
		outbound io.Writer
	}{
		{nil, "exe", "send", "file", io.NopCloser(bytes.NewReader(nil)), io.Discard},
		{context.Background(), "", "send", "file", io.NopCloser(bytes.NewReader(nil)), io.Discard},
		{context.Background(), "exe", "invalid", "file", io.NopCloser(bytes.NewReader(nil)), io.Discard},
		{context.Background(), "exe", "send", "file", nil, io.Discard},
		{context.Background(), "exe", "receive", "dir", io.NopCloser(bytes.NewReader(nil)), nil},
	}
	for i, item := range tests {
		if err := runNativeZmodemTerminalSidecar(item.ctx, item.executable, item.direction,
			item.path, item.inbound, item.outbound); err == nil {
			t.Fatalf("unsafe sidecar configuration %d was accepted", i)
		}
	}
}

func TestNativeZmodemTerminalProtocolWriterRequiresCurrentInputLease(t *testing.T) {
	var remote bytes.Buffer
	gate := newTerminalInputGate(io.Discard, &remote)
	lease, err := gate.takeover()
	if err != nil { t.Fatal(err) }
	writer := nativeTerminalProtocolWriter{gate: gate, lease: lease}
	if _, err := writer.Write([]byte{0, 0xff}); err != nil { t.Fatal(err) }
	if err := gate.restore(lease); err != nil { t.Fatal(err) }
	if _, err := writer.Write([]byte("expired")); !errors.Is(err, errNativeTerminalInputLease) {
		t.Fatalf("stale sidecar protocol writer was accepted: %v", err)
	}
	if !bytes.Equal(remote.Bytes(), []byte{0, 0xff}) {
		t.Fatalf("unleased protocol bytes reached SSH PTY: %x", remote.Bytes())
	}
}

func TestNativeZmodemProgressDiagnosticsStayIsolated(t *testing.T) {
    var values [][2]uint64
    log := &nativeZmodemLog{}
    writer := &nativeTerminalProgressLog{
        log: log,
        onProgress: func(done, total uint64) {
            values = append(values, [2]uint64{done, total})
        },
    }
    for _, part := range []string{"OSZP\t12", "8\t256\n", "failure details\n", "OSZP\t256\t256\n"} {
        if _, err := writer.Write([]byte(part)); err != nil { t.Fatal(err) }
    }
    if len(values) != 2 || values[0] != [2]uint64{128, 256} || values[1] != [2]uint64{256, 256} {
        t.Fatalf("wrong progress frames: %+v", values)
    }
    if got := log.String(); !strings.Contains(got, "failure details") || strings.Contains(got, "OSZP") {
        t.Fatalf("telemetry contaminated diagnostics: %q", got)
    }
}

func TestNativeZmodemFileEventsAreParsedWithoutPollutingWire(t *testing.T) {
    var events []NativeZmodemFileProgress
    var totals [][2]uint64
    log := &nativeZmodemLog{}
    writer := &nativeTerminalProgressLog{
        log: log,
        onProgress: func(done, total uint64) { totals = append(totals, [2]uint64{done, total}) },
        onFile: func(event NativeZmodemFileProgress) { events = append(events, event) },
    }
    input := "OSZF\tstart\t0\t1073741824\te4b8ade69687\n" +
        "OSZP\t536870912\t1073741824\n" +
        "OSZF\tprogress\t0\t536870912\n" +
        "OSZF\tcompleted\t0\t1073741824\n"
    if _, err := writer.Write([]byte(input)); err != nil { t.Fatal(err) }
    if len(totals) != 1 || totals[0][1] != 1073741824 { t.Fatalf("1 GiB progress rejected: %+v", totals) }
    if len(events) != 3 || events[0].Name != "中文" || events[0].Total == nil || *events[0].Total != 1073741824 ||
        events[1].Processed != 536870912 || events[2].Kind != "completed" {
        t.Fatalf("file event parse failed: %+v", events)
    }
    if log.String() != "" { t.Fatalf("diagnostics leaked: %s", log.String()) }
}
