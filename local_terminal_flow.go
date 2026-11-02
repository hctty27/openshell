package main

import "sync"

// The renderer returns credits only after xterm.js has parsed each chunk.
const localOutputWindowBytes = 512 * 1024

type localOutputReceipt struct {
    sequence uint64
    size int
}

type localOutputFlow struct {
    mu sync.Mutex
    nextSequence uint64
    inflightBytes int
    receipts []localOutputReceipt
    changed chan struct{}
    stopped chan struct{}
    stopOnce sync.Once
}

func newLocalOutputFlow() *localOutputFlow {
    return &localOutputFlow{
        changed: make(chan struct{}, 1),
        stopped: make(chan struct{}),
    }
}

// reserve blocks the ConPTY reader at the window limit instead of queuing
// unbounded Wails events while WebView2 is busy or the tab is hidden.
func (f *localOutputFlow) reserve(size int) (uint64, bool) {
    if size <= 0 || size > localOutputWindowBytes { return 0, false }
    for {
        f.mu.Lock()
        select {
        case <-f.stopped:
            f.mu.Unlock()
            return 0, false
        default:
        }
        if f.inflightBytes + size <= localOutputWindowBytes {
            f.nextSequence++
            f.inflightBytes += size
            f.receipts = append(f.receipts, localOutputReceipt{sequence: f.nextSequence, size: size})
            sequence := f.nextSequence
            f.mu.Unlock()
            return sequence, true
        }
        f.mu.Unlock()
        select {
        case <-f.changed:
        case <-f.stopped:
            return 0, false
        }
    }
}

func (f *localOutputFlow) acknowledge(sequence uint64) {
    f.mu.Lock()
    defer f.mu.Unlock()
    if sequence == 0 || sequence > f.nextSequence { return }
    count := 0
    for count < len(f.receipts) && f.receipts[count].sequence <= sequence {
        f.inflightBytes -= f.receipts[count].size
        count++
    }
    if count == 0 { return }
    copy(f.receipts, f.receipts[count:])
    f.receipts = f.receipts[:len(f.receipts)-count]
    select {
    case f.changed <- struct{}{}:
    default:
    }
}

func (f *localOutputFlow) stop() {
    f.stopOnce.Do(func() { close(f.stopped) })
}
