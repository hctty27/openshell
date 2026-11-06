package sshclient

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// nativeZmodemIOMeter is opt-in and scoped to a single transfer context.
// It records aggregate durations only; no payloads, paths, or credentials.
type nativeZmodemIOMeter struct {
	toRemoteCalls atomic.Uint64
	toRemoteBytes atomic.Uint64
	toRemoteWriteNS atomic.Int64
	readyWaitNS atomic.Int64
	fromRemoteCalls atomic.Uint64
	fromRemoteBytes atomic.Uint64
	toSidecarPipeNS atomic.Int64
	rustMu sync.Mutex
	rustRX *nativeZmodemRXStats
}

type nativeZmodemIOStats struct {
	ToRemoteCalls uint64 `json:"toRemoteCalls"`
	ToRemoteBytes uint64 `json:"toRemoteBytes"`
	ToRemoteWriteNS int64 `json:"toRemoteWriteNs"`
	ReadyWaitNS int64 `json:"readyWaitNs"`
	FromRemoteCalls uint64 `json:"fromRemoteCalls"`
	FromRemoteBytes uint64 `json:"fromRemoteBytes"`
	ToSidecarPipeNS int64 `json:"toSidecarPipeNs"`
	RustRX *nativeZmodemRXStats `json:"rustRx,omitempty"`
}

type nativeZmodemRXStats struct {
	Completed bool `json:"completed"`
	PollCalls uint64 `json:"pollCalls"`
	PollNS uint64 `json:"pollNs"`
	IdleCalls uint64 `json:"idleCalls"`
	WaitNS uint64 `json:"waitNs"`
	WaitMaxNS uint64 `json:"waitMaxNs"`
	FileWriteNS uint64 `json:"fileWriteNs"`
	FileSyncNS uint64 `json:"fileSyncNs"`
	WireWriteNS uint64 `json:"wireWriteNs"`
	FileBytes uint64 `json:"fileBytes"`
}

func parseNativeZmodemRXStats(stderr string) *nativeZmodemRXStats {
	for _, line := range strings.Split(stderr, "\n") {
		if !strings.HasPrefix(line, "OSZD\t") {
			continue
		}
		fields := strings.Split(strings.TrimSpace(line), "\t")
		if len(fields) != 11 {
			continue
		}
		var numbers [10]uint64
		valid := true
		for i := range numbers {
			value, err := strconv.ParseUint(fields[i+1], 10, 64)
			if err != nil {
				valid = false
				break
			}
			numbers[i] = value
		}
		if !valid || numbers[0] > 1 {
			continue
		}
		return &nativeZmodemRXStats{
			Completed: numbers[0] == 1,
			PollCalls: numbers[1], PollNS: numbers[2],
			IdleCalls: numbers[3], WaitNS: numbers[4],
			WaitMaxNS: numbers[5], FileWriteNS: numbers[6],
			FileSyncNS: numbers[7], WireWriteNS: numbers[8],
			FileBytes: numbers[9],
		}
	}
	return nil
}

func (m *nativeZmodemIOMeter) recordReceiverDiagnostics(stderr string) {
	if m == nil {
		return
	}
	stats := parseNativeZmodemRXStats(stderr)
	if stats == nil {
		return
	}
	m.rustMu.Lock()
	m.rustRX = stats
	m.rustMu.Unlock()
}

type nativeZmodemIOMeterContextKey struct{}

func withNativeZmodemIOMeter(ctx context.Context, meter *nativeZmodemIOMeter) context.Context {
	if meter == nil {
		return ctx
	}
	return context.WithValue(ctx, nativeZmodemIOMeterContextKey{}, meter)
}

func nativeZmodemIOMeterFromContext(ctx context.Context) *nativeZmodemIOMeter {
	if ctx == nil {
		return nil
	}
	meter, _ := ctx.Value(nativeZmodemIOMeterContextKey{}).(*nativeZmodemIOMeter)
	return meter
}

func (m *nativeZmodemIOMeter) recordToRemote(bytes int, elapsed time.Duration) {
	if m == nil { return }
	m.toRemoteCalls.Add(1)
	m.toRemoteBytes.Add(uint64(bytes))
	m.toRemoteWriteNS.Add(elapsed.Nanoseconds())
}

func (m *nativeZmodemIOMeter) recordReadyWait(elapsed time.Duration) {
	if m == nil { return }
	m.readyWaitNS.Add(elapsed.Nanoseconds())
}

func (m *nativeZmodemIOMeter) recordFromRemote(bytes int, elapsed time.Duration) {
	if m == nil { return }
	m.fromRemoteCalls.Add(1)
	m.fromRemoteBytes.Add(uint64(bytes))
	m.toSidecarPipeNS.Add(elapsed.Nanoseconds())
}

func (m *nativeZmodemIOMeter) snapshot() nativeZmodemIOStats {
	if m == nil { return nativeZmodemIOStats{} }
	m.rustMu.Lock()
	var rustStats *nativeZmodemRXStats
	if m.rustRX != nil {
		copied := *m.rustRX
		rustStats = &copied
	}
	m.rustMu.Unlock()
	return nativeZmodemIOStats{
		ToRemoteCalls: m.toRemoteCalls.Load(),
		ToRemoteBytes: m.toRemoteBytes.Load(),
		ToRemoteWriteNS: m.toRemoteWriteNS.Load(),
		ReadyWaitNS: m.readyWaitNS.Load(),
		FromRemoteCalls: m.fromRemoteCalls.Load(),
		FromRemoteBytes: m.fromRemoteBytes.Load(),
		ToSidecarPipeNS: m.toSidecarPipeNS.Load(),
		RustRX: rustStats,
	}
}
