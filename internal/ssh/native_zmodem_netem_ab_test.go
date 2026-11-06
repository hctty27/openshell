package sshclient

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The netem fixture applies impairments only to the temporary Linux SSH
// container's eth0 egress. This is not a bidirectional WAN emulator.
func TestNativeZmodemNetemABInteractivePTY(t *testing.T) {
	if os.Getenv("OPENSHELL_ZMODEM_NETEM_AB") != "1" {
		t.Skip("opt-in Linux tc netem SSH PTY A/B benchmark")
	}
	if runtime.GOOS != "windows" || os.Getenv("OPENSHELL_ZMODEM_CROSS_OS_PTY") != "1" {
		t.Fatal("netem A/B requires native Windows and isolated Docker Linux SSH")
	}
	host, _, err := net.SplitHostPort(os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_ADDR"))
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		t.Fatal("netem A/B requires a loopback-only Docker SSH target")
	}
	profile := os.Getenv("OPENSHELL_ZMODEM_NETEM_PROFILE")
	switch profile {
	case "clean", "jitter", "loss":
	default:
		t.Fatalf("invalid netem profile: %q", profile)
	}
	actualQdisc := os.Getenv("OPENSHELL_ZMODEM_NETEM_QDISC")
	if actualQdisc == "" || (profile != "clean" && !strings.Contains(actualQdisc, "netem")) {
		t.Fatal("missing verified Docker container qdisc state")
	}
	rounds := 2
	if raw := os.Getenv("OPENSHELL_ZMODEM_NETEM_ROUNDS"); raw != "" {
		rounds, err = strconv.Atoi(raw)
		if err != nil || rounds < 1 || rounds > 5 {
			t.Fatalf("invalid OPENSHELL_ZMODEM_NETEM_ROUNDS: %q", raw)
		}
	}
	report := nativeNetemABReport{
		Version: 1, StartedAt: time.Now().UTC(), ClientOS: runtime.GOOS,
		Profile: profile, ActualQdisc: actualQdisc, Rounds: rounds, SizeMiB: 1,
		DirectionNote: "tc netem affects Docker Linux server eth0 egress only",
	}
	t.Cleanup(func() {
		report.Summaries = summarizeNativeBatchMatrix(report.Cases)
		destination := os.Getenv("OPENSHELL_ZMODEM_NETEM_REPORT")
		if destination == "" {
			t.Error("missing OPENSHELL_ZMODEM_NETEM_REPORT")
			return
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			t.Errorf("create netem report directory: %v", err)
			return
		}
		payload, err := json.MarshalIndent(report, "", "  ")
		if err == nil {
			err = os.WriteFile(destination, append(payload, '\n'), 0600)
		}
		if err != nil {
			t.Errorf("write netem report: %v", err)
		} else {
			t.Logf("native ZMODEM netem A/B JSON: %s", destination)
		}
	})
	manager := NewManager(keys{}, nil)
	t.Cleanup(manager.Close)
	for round := 0; round < rounds; round++ {
		for _, batchKiB := range nativeBatchMatrixOrder([]int{0, 16}, round) {
			name := fmt.Sprintf("%s-round-%d-batch-%d", profile, round, batchKiB)
			ok := t.Run(name, func(t *testing.T) {
				t.Setenv("OPENSHELL_ZMODEM_WIRE_BATCH_BYTES", strconv.Itoa(batchKiB*1024))
				peer := openNativeStressPeer(t, manager, name, 0)
				individual := &nativeStressReport{}
				err := runNativeStressPair(peer, individual, "netem", 1024*1024, round, true)
				c := nativeBatchMatrixCase{
					LatencyMS: 0, WireBatchKiB: batchKiB, Round: round,
					Results: append([]nativeStressRecord(nil), individual.Results...),
				}
				if err != nil { c.Error = err.Error() }
				report.Cases = append(report.Cases, c)
				if err != nil { t.Fatal(err) }
				if len(c.Results) != 4 {
					t.Fatalf("expected 4 transfer records, got %d", len(c.Results))
				}
				for _, result := range c.Results {
					if !result.ChecksumOK || result.Error != "" {
						t.Fatalf("invalid SHA-256 sample: %+v", result)
					}
				}
			})
			if !ok {
				t.Fatalf("netem A/B failed at %s; partial JSON will be retained", name)
			}
		}
	}
}

type nativeNetemABReport struct {
	Version int `json:"version"`
	StartedAt time.Time `json:"startedAt"`
	ClientOS string `json:"clientOS"`
	Profile string `json:"profile"`
	ActualQdisc string `json:"actualQdisc"`
	DirectionNote string `json:"directionNote"`
	Rounds int `json:"rounds"`
	SizeMiB int `json:"sizeMiB"`
	Cases []nativeBatchMatrixCase `json:"cases"`
	Summaries []nativeBatchMatrixSummary `json:"summaries"`
}
