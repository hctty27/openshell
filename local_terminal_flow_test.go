package main

import (
    "testing"
    "time"
)

func TestLocalOutputFlowBackpressure(t *testing.T) {
    f := newLocalOutputFlow()
    const chunk = 32 * 1024
    for n := 1; n <= localOutputWindowBytes/chunk; n++ {
        sequence, ok := f.reserve(chunk)
        if !ok || sequence != uint64(n) {
            t.Fatalf("reserve %d: sequence=%d ok=%v", n, sequence, ok)
        }
    }
    released := make(chan bool, 1)
    go func() {
        sequence, ok := f.reserve(chunk)
        released <- ok && sequence == uint64(localOutputWindowBytes/chunk+1)
    }()
    select {
    case <-released:
        t.Fatal("output exceeded the 512 KiB unacknowledged window")
    case <-time.After(25 * time.Millisecond):
    }
    f.acknowledge(1)
    select {
    case ok := <-released:
        if !ok { t.Fatal("output did not resume after acknowledging a parsed chunk") }
    case <-time.After(time.Second):
        t.Fatal("output reader remained blocked after acknowledgement")
    }
    f.mu.Lock()
    bytes := f.inflightBytes
    count := len(f.receipts)
    f.mu.Unlock()
    if bytes != localOutputWindowBytes || count != localOutputWindowBytes/chunk {
        t.Fatalf("bad inflight credits: %d bytes, %d chunks", bytes, count)
    }
}

func TestLocalOutputFlowCloseUnblocksReader(t *testing.T) {
    f := newLocalOutputFlow()
    if _, ok := f.reserve(localOutputWindowBytes); !ok { t.Fatal("initial reserve failed") }
    result := make(chan bool, 1)
    go func() { _, ok := f.reserve(1); result <- ok }()
    f.stop()
    select {
    case ok := <-result:
        if ok { t.Fatal("reader emitted output after terminal closed") }
    case <-time.After(time.Second):
        t.Fatal("closing terminal did not wake blocked reader")
    }
}

func TestLocalOutputFlowRejectsInvalidAndDuplicateAcknowledgements(t *testing.T) {
    f := newLocalOutputFlow()
    if _, ok := f.reserve(1024); !ok { t.Fatal("initial reserve failed") }
    f.acknowledge(2)
    f.acknowledge(0)
    f.mu.Lock()
    bytes := f.inflightBytes
    f.mu.Unlock()
    if bytes != 1024 { t.Fatalf("future or zero ack released credits: %d", bytes) }
    f.acknowledge(1)
    f.acknowledge(1)
    f.mu.Lock()
    bytes = f.inflightBytes
    f.mu.Unlock()
    if bytes != 0 { t.Fatalf("duplicate ack mishandled: %d", bytes) }
}

func TestLocalOutputAcknowledgementIsolatedByTerminalID(t *testing.T) {
    flow := newLocalOutputFlow()
    _, _ = flow.reserve(4096)
    app := &App{localTerminals: map[string]*localTerminalSession{
        "tab": {id: "active", output: flow},
    }}
    app.AcknowledgeLocalTerminalOutput("tab", "expired", 1)
    app.AcknowledgeLocalTerminalOutput("other", "active", 1)
    flow.mu.Lock()
    bytes := flow.inflightBytes
    flow.mu.Unlock()
    if bytes != 4096 { t.Fatalf("stale terminal acknowledged active output: %d", bytes) }
    app.AcknowledgeLocalTerminalOutput("tab", "active", 1)
    flow.mu.Lock()
    bytes = flow.inflightBytes
    flow.mu.Unlock()
    if bytes != 0 { t.Fatalf("active terminal output was not acknowledged: %d", bytes) }
}
