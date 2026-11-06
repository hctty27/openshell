package sshclient

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

func TestNativeZmodemIOMeterContextAndConcurrentCounters(t *testing.T) {
	if nativeZmodemIOMeterFromContext(context.Background()) != nil {
		t.Fatal("IO metrics unexpectedly enabled by default")
	}
	meter := &nativeZmodemIOMeter{}
	ctx := withNativeZmodemIOMeter(context.Background(), meter)
	if nativeZmodemIOMeterFromContext(ctx) != meter {
		t.Fatal("transfer context did not preserve the meter")
	}
	var group sync.WaitGroup
	for i := 0; i < 20; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			meter.recordToRemote(256, 2*time.Millisecond)
			meter.recordFromRemote(128, time.Millisecond)
			meter.recordReadyWait(3*time.Millisecond)
		}()
	}
	group.Wait()
	got := meter.snapshot()
	if got.ToRemoteCalls != 20 || got.ToRemoteBytes != 5120 ||
		got.FromRemoteCalls != 20 || got.FromRemoteBytes != 2560 ||
		got.ToRemoteWriteNS != (40*time.Millisecond).Nanoseconds() ||
		got.ToSidecarPipeNS != (20*time.Millisecond).Nanoseconds() ||
		got.ReadyWaitNS != (60*time.Millisecond).Nanoseconds() {
		t.Fatalf("incorrect concurrent IO snapshot: %+v", got)
	}
}

func TestNativeZmodemInboundPipeMeterPreservesPayload(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	meter := &nativeZmodemIOMeter{}
	sink := &nativeTerminalInboundSink{pipe: writer, activated: true, meter: meter}
	payload := []byte{0x00, 0xff, 0x18, 0x42, 0x00, 0x7f}
	got := make([]byte, len(payload))
	done := make(chan error, 1)
	go func() {
		_, err := io.ReadFull(reader, got)
		done <- err
	}()
	n, err := sink.Write(payload)
	if err != nil || n != len(payload) { t.Fatalf("pipe write: %d, %v", n, err) }
	select {
	case err := <-done:
		if err != nil { t.Fatal(err) }
	case <-time.After(time.Second):
		t.Fatal("inbound pipe stalled")
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("inbound bytes changed: %x != %x", got, payload)
	}
	snapshot := meter.snapshot()
	if snapshot.FromRemoteCalls != 1 || snapshot.FromRemoteBytes != uint64(len(payload)) {
		t.Fatalf("inbound IO count incorrect: %+v", snapshot)
	}
}

func TestNativeZmodemIOStatsIncludedOnlyWhenRequested(t *testing.T) {
	report := &nativeStressReport{}
	meter := &nativeZmodemIOMeter{}
	meter.recordToRemote(64, 2*time.Millisecond)
	stats := meter.snapshot()
	report.add("latency", "native", "upload", 0, 1024, time.Second, nil,
		nativeStressSample{StagesMS: map[string]int64{"protocol": 1000}, IO: &stats})
	report.add("latency", "sftp", "upload", 0, 1024, time.Second, nil)
	stats.ToRemoteBytes = 12345
	encoded, err := json.Marshal(report.Results)
	if err != nil { t.Fatal(err) }
	var values []struct {
		IO *nativeZmodemIOStats `json:"io"`
	}
	if err := json.Unmarshal(encoded, &values); err != nil { t.Fatal(err) }
	if len(values) != 2 || values[0].IO == nil || values[0].IO.ToRemoteBytes != 64 ||
		values[1].IO != nil {
		t.Fatalf("invalid IO stats in JSON: %s", encoded)
	}
}

func TestNativeZmodemReceiverDiagnosticsStrictParsing(t *testing.T) {
	diag := parseNativeZmodemRXStats("OSZP\t1\t128\nOSZD\t1\t100\t200\t30\t400\t50\t60\t70\t80\t1048576\n")
	if diag == nil || !diag.Completed || diag.PollCalls != 100 || diag.WaitNS != 400 ||
		diag.FileSyncNS != 70 || diag.FileBytes != 1048576 {
		t.Fatalf("unexpected receiver diagnostic: %+v", diag)
	}
	if got := parseNativeZmodemRXStats("OSZD\t2\t100\t200\t30\t400\t50\t60\t70\t80\t1048576\n"); got != nil {
		t.Fatalf("accepted invalid completion status: %+v", got)
	}
	if got := parseNativeZmodemRXStats("OSZD\t1\tbad\t200\t30\t400\t50\t60\t70\t80\t1048576\n"); got != nil {
		t.Fatalf("accepted invalid counter: %+v", got)
	}
	meter := &nativeZmodemIOMeter{}
	meter.recordReceiverDiagnostics("OSZD\t1\t100\t200\t30\t400\t50\t60\t70\t80\t1048576\n")
	before := meter.snapshot()
	if before.RustRX == nil || before.RustRX.FileBytes != 1048576 {
		t.Fatalf("receiver stats not captured: %+v", before)
	}
	before.RustRX.FileBytes = 0
	if meter.snapshot().RustRX.FileBytes != 1048576 {
		t.Fatal("snapshot must not share mutable receiver diagnostic state")
	}
}
