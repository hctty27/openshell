package sshclient

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// Real Windows-to-Linux 128 MiB benchmark, explicitly opted in. Each case
// gets a subtest so temporary local/remote files do not accumulate across runs.
func TestNativeZmodemLargeABInteractivePTY(t *testing.T) {
	if os.Getenv("OPENSHELL_ZMODEM_LARGE_AB") != "1" {
		t.Skip("opt-in 128 MiB native ZMODEM large-file A/B test")
	}
	if runtime.GOOS != "windows" || os.Getenv("OPENSHELL_ZMODEM_CROSS_OS_PTY") != "1" {
		t.Fatal("large A/B requires native Windows and isolated Linux Docker SSH")
	}
	host, _, err := net.SplitHostPort(os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_ADDR"))
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		t.Fatal("large A/B requires an IP loopback-only SSH target")
	}
	rounds := 5
	if raw := os.Getenv("OPENSHELL_ZMODEM_LARGE_AB_ROUNDS"); raw != "" {
		rounds, err = strconv.Atoi(raw)
		if err != nil || rounds < 1 || rounds > 10 {
			t.Fatalf("invalid OPENSHELL_ZMODEM_LARGE_AB_ROUNDS: %q", raw)
		}
	}

	const sizeMiB = 128
	matrix := nativeLargeABReport{
		Version: 1, StartedAt: time.Now().UTC(), ClientOS: runtime.GOOS,
		Rounds: rounds, SizeMiB: sizeMiB, BatchesKiB: []int{0, 16, 32},
	}
	t.Cleanup(func() {
		matrix.Summaries = summarizeNativeBatchMatrix(matrix.Cases)
		filename := os.Getenv("OPENSHELL_ZMODEM_LARGE_AB_REPORT")
		if filename == "" {
			t.Error("missing OPENSHELL_ZMODEM_LARGE_AB_REPORT")
			return
		}
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			t.Errorf("create large A/B directory: %v", err)
			return
		}
		data, err := json.MarshalIndent(matrix, "", "  ")
		if err == nil {
			err = os.WriteFile(filename, append(data, '\n'), 0600)
		}
		if err != nil {
			t.Errorf("save large A/B JSON: %v", err)
		} else {
			t.Logf("128 MiB A/B report: %s", filename)
		}
	})

	manager := NewManager(keys{}, nil)
	t.Cleanup(manager.Close)
	for round := 0; round < rounds; round++ {
		for _, batch := range nativeBatchMatrixOrder(matrix.BatchesKiB, round) {
			name := fmt.Sprintf("round-%d-batch-%d", round, batch)
			ok := t.Run(name, func(t *testing.T) {
				t.Setenv("OPENSHELL_ZMODEM_WIRE_BATCH_BYTES", strconv.Itoa(batch*1024))
				t.Setenv("OPENSHELL_ZMODEM_RX_DIAG", "1")
				peer := openNativeStressPeer(t, manager, name, 0)
				individual := &nativeStressReport{}
				err := runNativeStressPair(peer, individual, "largeAB", sizeMiB*1024*1024, round, true)
				sample := nativeBatchMatrixCase{
					LatencyMS: 0, WireBatchKiB: batch, Round: round,
					Results: append([]nativeStressRecord(nil), individual.Results...),
				}
				if err != nil {
					sample.Error = err.Error()
				}
				matrix.Cases = append(matrix.Cases, sample)
				if err != nil {
					t.Fatal(err)
				}
				if len(sample.Results) != 4 {
					t.Fatalf("expected four verified transfers, got %d", len(sample.Results))
				}
				for _, result := range sample.Results {
					if !result.ChecksumOK || result.Error != "" {
						t.Fatalf("missing checksum verification: %+v", result)
					}
				}
				if sample.Results[1].IO == nil || sample.Results[1].IO.RustRX == nil ||
					!sample.Results[1].IO.RustRX.Completed ||
					sample.Results[1].IO.RustRX.FileBytes != sizeMiB*1024*1024 {
					t.Fatal("missing completed Rust receiver diagnostics")
				}
			})
			if !ok {
				t.Fatalf("large A/B stopped at %s; partial JSON will be saved", name)
			}
		}
	}
}

type nativeLargeABReport struct {
	Version int `json:"version"`
	StartedAt time.Time `json:"startedAt"`
	ClientOS string `json:"clientOS"`
	Rounds int `json:"rounds"`
	SizeMiB int `json:"sizeMiB"`
	BatchesKiB []int `json:"batchesKiB"`
	Cases []nativeBatchMatrixCase `json:"cases"`
	Summaries []nativeBatchMatrixSummary `json:"summaries"`
}

func TestNativeZmodemLargeABReportStatistics(t *testing.T) {
	report := nativeLargeABReport{Version: 1, Rounds: 5, SizeMiB: 128, BatchesKiB: []int{0, 16, 32}}
	for i, d := range []int64{100, 120, 110, 140, 130} {
		report.Cases = append(report.Cases, nativeBatchMatrixCase{
			WireBatchKiB: 16, Round: i, Results: []nativeStressRecord{{
				Protocol: "native", Direction: "download", DurationMS: d,
				MiBPerSecond: 128000 / float64(d), ChecksumOK: true,
			}},
		})
	}
	report.Summaries = summarizeNativeBatchMatrix(report.Cases)
	if len(report.Summaries) != 1 || report.Summaries[0].Count != 5 ||
		report.Summaries[0].P95DurationMS != 140 || !report.Summaries[0].AllChecksumsOK {
		t.Fatalf("invalid large A/B statistics: %+v", report.Summaries)
	}
}
