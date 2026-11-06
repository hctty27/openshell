package sshclient

import (
	"context"
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
}

type nativeZmodemIOStats struct {
	ToRemoteCalls uint64 `json:"toRemoteCalls"`
	ToRemoteBytes uint64 `json:"toRemoteBytes"`
	ToRemoteWriteNS int64 `json:"toRemoteWriteNs"`
	ReadyWaitNS int64 `json:"readyWaitNs"`
	FromRemoteCalls uint64 `json:"fromRemoteCalls"`
	FromRemoteBytes uint64 `json:"fromRemoteBytes"`
	ToSidecarPipeNS int64 `json:"toSidecarPipeNs"`
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
	return nativeZmodemIOStats{
		ToRemoteCalls: m.toRemoteCalls.Load(),
		ToRemoteBytes: m.toRemoteBytes.Load(),
		ToRemoteWriteNS: m.toRemoteWriteNS.Load(),
		ReadyWaitNS: m.readyWaitNS.Load(),
		FromRemoteCalls: m.fromRemoteCalls.Load(),
		FromRemoteBytes: m.fromRemoteBytes.Load(),
		ToSidecarPipeNS: m.toSidecarPipeNS.Load(),
	}
}
