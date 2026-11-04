# OpenShell local diagnostics (initial implementation)

This module provides opt-in **viewing and exporting** of automatically collected, local-only categorical performance events. It does not add a cloud service or capture terminal contents.

## Implementation

- Go: `internal/diagnostics` keeps a bounded channel (512), a bounded in-memory recent-event list (100) and up to 128 operation aggregates. Storage consists of `app.jsonl` plus up to 9 rotated backups (5 MiB each). Backups older than 7 days are pruned when the manager opens or at least hourly during writing.
- Frontend: `features/diagnostics/collector.ts` captures selected Wails RPC completion times, uncaught error **categories** and once-per-second xterm write timing aggregates. No output text, command, SSH address, path, or request argument is passed.
- UI: Settings > Diagnostics displays local Go heap bytes (not total OpenShell/WebView2 memory), goroutine count, event log, operation P95 and an export control.
- Export: an explicit user action writes a ZIP under the user cache directory, `OpenShell/diagnostics/reports/`, with `manifest.json`, `summary.json` and rotated JSONL files. All log data is local. There is no upload API.
- Security: the Go receiver strictly allows known operation/module names and coded errors. Unknown strings become `unknown` or `other`. Export does not include terminal buffers, command text, API credentials, profile or system-wide dumps.

## Current limitations

1. The memory reading reports **Go heap allocation only**, not native process memory, WebView2 private bytes or GPU usage. CPU, input-to-echo, true paint latency, transfer throughput and system-wide crash dumps are not available in this initial implementation.
2. Backend RPC timing includes Wails bridge overhead and promise resolution. xterm write callback timing is parse/ACK-adjacent, not a precise visual paint measurement. The xterm distribution covers one-second batch maxima, not all individual writes.
3. Only selected RPC operation names are instrumented. Transfer progress event rate, detailed SSH phases and streamed AI tool work need explicit instrumentation in later iterations.
4. It does not yet provide a 30-second CPU-profile capture. Additional profiling should be explicit, time-limited and reviewed for secrets before export.
5. If the filesystem is unavailable, diagnostics APIs return an error; regular SSH and SFTP functionality must continue working.

## Validation

```sh
go test -race ./internal/diagnostics ./...
go vet ./...
cd frontend
npm ci
npm test -- --run
npm run build
npm run audit:unused
npx playwright test
```

On Windows, test the built application under idle, 5/10/20 active sessions, heavy streaming, SSH reconnects, SFTP transfer, export and a read-only cache directory. Compare CPU and process-tree private bytes against the same commit with diagnostics disabled, without assuming that the library-level tests prove no regression. Ensure that exported ZIPs have no personal paths, hosts, secrets, shell commands or terminal output.
