package sshclient

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"testing"
	"time"
)

// The matrix reuses one loopback-only Docker SSH fixture. All protocol
// sessions are real interactive PTYs; the experiment is never enabled in CI
// by default and does not modify the normal OpenShell transfer behavior.
func TestNativeZmodemBatchMatrixInteractivePTY(t *testing.T) {
	if os.Getenv("OPENSHELL_ZMODEM_BATCH_MATRIX") != "1" {
		t.Skip("opt-in native ZMODEM write-batch matrix")
	}
	if runtime.GOOS != "windows" || os.Getenv("OPENSHELL_ZMODEM_CROSS_OS_PTY") != "1" {
		t.Fatal("batch matrix requires Windows and the isolated Linux Docker SSH fixture")
	}
	host, _, err := net.SplitHostPort(os.Getenv("OPENSHELL_ZMODEM_LIVE_SSH_ADDR"))
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		t.Fatal("batch matrix requires an IP loopback-only SSH target")
	}

	rounds := 5
	if raw := os.Getenv("OPENSHELL_ZMODEM_MATRIX_ROUNDS"); raw != "" {
		rounds, err = strconv.Atoi(raw)
		if err != nil || rounds < 1 || rounds > 10 {
			t.Fatalf("invalid OPENSHELL_ZMODEM_MATRIX_ROUNDS %q", raw)
		}
	}
	matrix := nativeBatchMatrixReport{Version: 1, StartedAt: time.Now().UTC(), ClientOS: runtime.GOOS, Rounds: rounds}
	t.Cleanup(func() {
		matrix.Summaries = summarizeNativeBatchMatrix(matrix.Cases)
		destination := os.Getenv("OPENSHELL_ZMODEM_MATRIX_REPORT")
		if destination == "" {
			t.Error("missing OPENSHELL_ZMODEM_MATRIX_REPORT")
			return
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			t.Errorf("create batch matrix report directory: %v", err)
			return
		}
		data, err := json.MarshalIndent(matrix, "", "  ")
		if err == nil {
			err = os.WriteFile(destination, append(data, '\n'), 0600)
		}
		if err != nil {
			t.Errorf("save batch matrix JSON: %v", err)
		} else {
			t.Logf("native ZMODEM batch matrix JSON: %s", destination)
		}
	})

	manager := NewManager(keys{}, nil)
	t.Cleanup(manager.Close)

	delays := []int{0, 1, 3, 5}
	batches := []int{0, 4, 8, 16, 32}
	index := 0
	for delayIndex, delayMS := range delays {
		peer := openNativeStressPeer(t, manager, fmt.Sprintf("matrix-%dms", delayMS), time.Duration(delayMS)*time.Millisecond)
		for round := 0; round < rounds; round++ {
			order := nativeBatchMatrixOrder(batches, round+delayIndex)
			for _, batchKiB := range order {
				t.Setenv("OPENSHELL_ZMODEM_WIRE_BATCH_BYTES", strconv.Itoa(batchKiB*1024))
				individual := &nativeStressReport{}
				err := runNativeStressPair(peer, individual, "matrix", 1024*1024, index, true)
				result := nativeBatchMatrixCase{
					LatencyMS: delayMS,
					WireBatchKiB: batchKiB,
					Round: round,
					Results: append([]nativeStressRecord(nil), individual.Results...),
				}
				if err != nil {
					result.Error = err.Error()
				}
				matrix.Cases = append(matrix.Cases, result)
				if err != nil {
					t.Fatalf("batch matrix round=%d latency=%dms batch=%dKiB: %v", round, delayMS, batchKiB, err)
				}
				if len(result.Results) != 4 {
					t.Fatalf("expected four checked transfers, got %d", len(result.Results))
				}
				index++
			}
		}
	}
}

type nativeBatchMatrixCase struct {
	LatencyMS int `json:"latencyMs"`
	WireBatchKiB int `json:"wireBatchKiB"`
	Round int `json:"round"`
	Results []nativeStressRecord `json:"results"`
	Error string `json:"error,omitempty"`
}

type nativeBatchMatrixSummary struct {
	LatencyMS int `json:"latencyMs"`
	WireBatchKiB int `json:"wireBatchKiB"`
	Protocol string `json:"protocol"`
	Direction string `json:"direction"`
	Count int `json:"count"`
	MedianMiBPerSecond float64 `json:"medianMiBPerSecond"`
	P95DurationMS int64 `json:"p95DurationMs"`
	AllChecksumsOK bool `json:"allChecksumsOK"`
}

type nativeBatchMatrixReport struct {
	Version int `json:"version"`
	StartedAt time.Time `json:"startedAt"`
	ClientOS string `json:"clientOS"`
	Rounds int `json:"rounds"`
	Cases []nativeBatchMatrixCase `json:"cases"`
	Summaries []nativeBatchMatrixSummary `json:"summaries"`
}

func nativeBatchMatrixOrder(batches []int, round int) []int {
	order := append([]int(nil), batches...)
	if round%2 == 1 {
		for i, j := 0, len(order)-1; i < j; i, j = i+1, j-1 {
			order[i], order[j] = order[j], order[i]
		}
	}
	return order
}

func summarizeNativeBatchMatrix(cases []nativeBatchMatrixCase) []nativeBatchMatrixSummary {
	type key struct {
		latency, batch int
		protocol, direction string
	}
	groups := make(map[key][]nativeStressRecord)
	for _, testCase := range cases {
		for _, result := range testCase.Results {
			k := key{testCase.LatencyMS, testCase.WireBatchKiB, result.Protocol, result.Direction}
			groups[k] = append(groups[k], result)
		}
	}
	summaries := make([]nativeBatchMatrixSummary, 0, len(groups))
	for k, samples := range groups {
		speeds := make([]float64, 0, len(samples))
		durations := make([]int64, 0, len(samples))
		allValid := true
		for _, sample := range samples {
			speeds = append(speeds, sample.MiBPerSecond)
			durations = append(durations, sample.DurationMS)
			allValid = allValid && sample.ChecksumOK && sample.Error == ""
		}
		sort.Float64s(speeds)
		sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
		mid := len(speeds) / 2
		median := speeds[mid]
		if len(speeds)%2 == 0 {
			median = (speeds[mid-1] + speeds[mid]) / 2
		}
		p95Index := int(math.Ceil(0.95*float64(len(durations)))) - 1
		summaries = append(summaries, nativeBatchMatrixSummary{
			LatencyMS: k.latency, WireBatchKiB: k.batch,
			Protocol: k.protocol, Direction: k.direction,
			Count: len(samples), MedianMiBPerSecond: median,
			P95DurationMS: durations[p95Index], AllChecksumsOK: allValid,
		})
	}
	sort.Slice(summaries, func(i, j int) bool {
		a, b := summaries[i], summaries[j]
		if a.LatencyMS != b.LatencyMS { return a.LatencyMS < b.LatencyMS }
		if a.WireBatchKiB != b.WireBatchKiB { return a.WireBatchKiB < b.WireBatchKiB }
		if a.Protocol != b.Protocol { return a.Protocol < b.Protocol }
		return a.Direction < b.Direction
	})
	return summaries
}

func TestNativeZmodemBatchMatrixStatistics(t *testing.T) {
	if got := nativeBatchMatrixOrder([]int{0, 4, 8}, 1); fmt.Sprint(got) != "[8 4 0]" {
		t.Fatalf("unexpected alternating order: %v", got)
	}
	cases := []nativeBatchMatrixCase{}
	for i, duration := range []int64{50, 10, 40, 20, 30} {
		cases = append(cases, nativeBatchMatrixCase{
			LatencyMS: 3, WireBatchKiB: 16, Round: i,
			Results: []nativeStressRecord{{Protocol: "native", Direction: "upload",
				MiBPerSecond: float64(i+1), DurationMS: duration, ChecksumOK: true}},
		})
	}
	summaries := summarizeNativeBatchMatrix(cases)
	if len(summaries) != 1 || summaries[0].Count != 5 ||
		summaries[0].MedianMiBPerSecond != 3 ||
		summaries[0].P95DurationMS != 50 || !summaries[0].AllChecksumsOK {
		t.Fatalf("incorrect matrix statistics: %+v", summaries)
	}
	cases[2].Results[0].ChecksumOK = false
	if summarizeNativeBatchMatrix(cases)[0].AllChecksumsOK {
		t.Fatal("checksum failure must not be reported as a passing matrix")
	}
}
