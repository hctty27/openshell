# Terminal performance verification

This checklist establishes a reproducible baseline before further changing the SSH/ConPTY output pipeline.
It does not claim any measured speedup until native Windows results are recorded.

## What changed in phase 1

- One Wails listener per output transport (`ssh:output` and `local:output`) dispatches output by SSH connection identity (`tabId + sessionId + generation`) or local PTY identity (`tabId + terminalId`).
- Each terminal's xterm.js instance continues to own its parser, scrollback, rendering, and per-output ACK.
- `TerminalPane` uses a memoized runtime while its outer wrapper keeps event callbacks current. Workspace updates unrelated to a terminal no longer require rerendering its xterm wrapper.

No backend chunk, timer, or backpressure configuration was changed in this phase.

## Run automated checks

From the repository root:

```sh
go test -race ./...
go vet ./...
cd frontend
npm ci
npm test -- --run
npm run build
npx playwright test
```

The browser tests use a mocked Wails bridge. They do not replace native Windows testing.

## Native Windows baseline and comparison

Capture the following before/after numbers using the **same machine**, Windows build, network, server workload, session geometry, and xterm scrollback setting. Include the complete process tree (`OpenShell.exe` and WebView2 child processes) when measuring CPU/memory.

| Scenario | Measurements |
| --- | --- |
| 1 SSH terminal idle | CPU%, private bytes, input-to-echo P50/P95 |
| 5/10/20 SSH terminals idle | Aggregate CPU%, private bytes, tab switch P50/P95 |
| 5 terminals streaming logs and 1 interactive terminal | Input-to-echo P95, tab switch P95, dropped output, UI long tasks |
| Active and background terminals with heavy output | Ordering, ACK progress, CPU%, private bytes |
| SFTP transfer while switching tabs | Transfer progress, input-to-echo P95, tab switch P95 |
| AI streaming while SSH emits output | Input-to-echo P95, UI long tasks |
| 20 connect/close/reconnect cycles | Remaining listeners, process CPU/memory, unexpected reconnect |

Suggested recording template:

```text
Windows version:
CPU / RAM / GPU:
OpenShell commit:
Workload + output rate:
Session count:
CPU (OpenShell + WebView2 children):
Memory (OpenShell + WebView2 children):
Terminal input-to-echo P50/P95:
Tab switch P50/P95:
UI long tasks:
Data loss / sequence disorder:
```

Use DevTools Performance and React Profiler to identify whether the bottleneck is script execution, React render work, xterm parsing, or graphics. Do not assume that `React.memo` improves frame time without profiling.

## Regression requirements

1. Output from terminal A must never appear in terminal B, including reconnected generations.
2. The local fallback terminal must continue receiving output after disconnect, and the prior SSH listener must be removed.
3. Background terminal output must remain ordered and complete; scrollback and search still work when switched back.
4. ACKs must only confirm data after xterm.js processes it. Existing backend backpressure and Ctrl+C responsiveness must remain intact.
5. Split panes, resizing, focus, IME, search, selection-to-copy, and clipboard behavior must remain unchanged.
6. Repeated opening/closing must not accumulate Wails event listeners or GPU contexts.

Record measurements from the installed/portable Windows app before claiming a quantified performance improvement.
