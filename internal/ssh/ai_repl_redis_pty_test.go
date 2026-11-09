//go:build linux

package sshclient

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/hctty27/openshell/internal/domain"
)

func TestRedisClusterPTYRoundTrip(t *testing.T) {
	address := os.Getenv("OPENSHELL_REDIS_CLUSTER_ADDR")
	if address == "" {
		t.Skip("OPENSHELL_REDIS_CLUSTER_ADDR is not set")
	}
	if _, err := exec.LookPath("redis-cli"); err != nil {
		t.Skip("redis-cli is not installed")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatalf("invalid Redis Cluster address %q: %v", address, err)
	}

	process := exec.Command("redis-cli", "-c", "-h", host, "-p", port)
	process.Env = append(os.Environ(), "TERM=xterm-256color")
	terminal, err := pty.Start(process)
	if err != nil {
		t.Fatalf("start redis-cli PTY: %v", err)
	}

	manager := NewManager(nil, nil)
	ref := domain.ConnectionRef{TabID: "redis-pty", SessionID: "redis-cluster", Generation: 1}
	conn := &connection{ref: ref, stdin: terminal}
	conn.readiness.mu.Lock()
	conn.readiness.program = "redis"
	conn.readiness.mu.Unlock()
	lease := &AITerminalLease{
		manager: manager,
		connection: conn,
		ref: ref,
		closed: make(chan struct{}),
		program: "redis",
	}
	manager.mu.Lock()
	manager.connections[ref.TabID] = conn
	conn.aiController = lease
	manager.mu.Unlock()

	var outputMu sync.Mutex
	var terminalOutput strings.Builder
	go func() {
		buffer := make([]byte, 4096)
		var queryTail []byte
		for {
			n, readErr := terminal.Read(buffer)
			if n > 0 {
				chunk := append([]byte(nil), buffer[:n]...)
				queryData := append(append([]byte(nil), queryTail...), chunk...)
				if bytes.Contains(queryData, []byte("\x1b[6n")) {
					conn.stdinMu.Lock()
					_, _ = terminal.Write([]byte("\x1b[1;1R"))
					conn.stdinMu.Unlock()
				}
				if len(queryData) > 3 {
					queryTail = append(queryTail[:0], queryData[len(queryData)-3:]...)
				} else {
					queryTail = append(queryTail[:0], queryData...)
				}
				outputMu.Lock()
				_, _ = terminalOutput.Write(chunk)
				outputMu.Unlock()
				conn.readiness.observe(chunk)
				lease.Observe(chunk)
			}
			if readErr != nil {
				return
			}
		}
	}()
	defer func() {
		lease.Release()
		_ = process.Process.Kill()
		_ = terminal.Close()
		_ = process.Wait()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	if err := lease.waitForREPLPrompt(ctx); err != nil {
		outputMu.Lock()
		rawOutput := terminalOutput.String()
		outputMu.Unlock()
		t.Fatalf("redis-cli did not reach its interactive prompt: %v; program=%q; output=%q", err, lease.connection.readiness.readyProgram(), rawOutput)
	}

	key := redisClusterKeyForRemoteMaster()
	output, err := lease.Run(ctx, "GET "+key)
	if err != nil {
		t.Fatalf("GET through Redis Cluster PTY failed: %v", err)
	}
	if !strings.Contains(output, "Redirected to slot [") || !strings.Contains(output, "(nil)") {
		t.Fatalf("expected a cluster redirect and nil result, got: %q", output)
	}

	output, err = lease.Run(ctx, "PING")
	if err != nil || !strings.Contains(output, "PONG") {
		t.Fatalf("second command after redirect failed: output=%q err=%v", output, err)
	}
}

func redisClusterKeyForRemoteMaster() string {
	for i := 0; ; i++ {
		key := fmt.Sprintf("openshell-ai-pty-%d", i)
		if slot := redisClusterHashSlot(key); slot >= 5461 && slot <= 10922 {
			return key
		}
	}
}

func redisClusterHashSlot(key string) int {
	hashKey := key
	if start := strings.IndexByte(key, '{'); start >= 0 {
		if end := strings.IndexByte(key[start+1:], '}'); end > 0 {
			hashKey = key[start+1 : start+1+end]
		}
	}
	var crc uint16
	for _, value := range []byte(hashKey) {
		crc ^= uint16(value) << 8
		for bit := 0; bit < 8; bit++ {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return int(crc % 16384)
}
