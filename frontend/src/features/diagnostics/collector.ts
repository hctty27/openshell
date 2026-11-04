import { Call } from "@wailsio/runtime";

type DiagnosticEvent = {
  module: string;
  operation: string;
  status: "ok" | "slow" | "error";
  durationMs: number;
  count?: number;
  code?: string;
};

const operations: Record<string, { module: string; slowMs: number }> = {
  Connect: { module: "ssh", slowMs: 3000 },
  Reconnect: { module: "ssh", slowMs: 3000 },
  SFTPHome: { module: "sftp", slowMs: 1000 },
  SFTPList: { module: "sftp", slowMs: 1000 },
  SFTPOperate: { module: "sftp", slowMs: 1000 },
  SFTPTransfer: { module: "sftp", slowMs: 1000 },
  SFTPReadRemoteText: { module: "sftp", slowMs: 1000 },
  SFTPSaveRemoteText: { module: "sftp", slowMs: 1000 },
  SFTPPreviewSync: { module: "sftp", slowMs: 1000 },
  AIStart: { module: "ai", slowMs: 3000 },
};

const pending: DiagnosticEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let terminalCount = 0;
let terminalMaxMS = 0;
let terminalTotalMS = 0;
let terminalTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function isDesktop(): boolean {
  return typeof window !== "undefined" &&
    typeof (window as Window & { chrome?: { webview?: { postMessage?: unknown } } })
      .chrome?.webview?.postMessage === "function";
}

function flush(): void {
  flushTimer = null;
  if (!pending.length || !isDesktop()) return;
  const batch = pending.splice(0, 100);
  void Call.ByName("main.App.DiagnosticsRecordBatch", batch).catch(() => {
    // Diagnostics must never interrupt normal terminal or file operations.
  });
  if (pending.length) flushTimer = setTimeout(flush, 1000);
}

function enqueue(event: DiagnosticEvent): void {
  if (!isDesktop()) return;
  if (pending.length >= 300) return;
  pending.push(event);
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
}

export function recordBackendOperation(method: string, durationMs: number, failed: boolean): void {
  const kind = operations[method];
  if (!kind) return;
  enqueue({
    module: kind.module,
    operation: method,
    status: failed ? "error" : durationMs >= kind.slowMs ? "slow" : "ok",
    durationMs: Math.max(0, Math.round(durationMs)),
    count: 1,
    ...(failed ? { code: "backend_call_failed" } : {}),
  });
}

// One aggregated event per second; never ship terminal bytes through diagnostics.
export function recordTerminalWrite(durationMs: number): void {
  if (!isDesktop()) return;
  terminalCount++;
  terminalTotalMS += durationMs;
  terminalMaxMS = Math.max(terminalMaxMS, durationMs);
  if (terminalTimer) return;
  terminalTimer = setTimeout(() => {
    terminalTimer = null;
    if (terminalCount) {
      enqueue({
        module: "terminal",
        operation: "xterm_write_batch",
        status: terminalMaxMS >= 100 ? "slow" : "ok",
        durationMs: Math.round(terminalMaxMS),
        count: terminalCount,
      });
    }
    terminalCount = 0;
    terminalTotalMS = 0;
    terminalMaxMS = 0;
  }, 1000);
}

export function installGlobalErrorDiagnostics(): void {
  if (installed || !isDesktop()) return;
  installed = true;
  window.addEventListener("error", () => {
    enqueue({ module: "frontend", operation: "uncaught_error", status: "error", durationMs: 0, code: "uncaught_error" });
  });
  window.addEventListener("unhandledrejection", () => {
    enqueue({ module: "frontend", operation: "unhandled_rejection", status: "error", durationMs: 0, code: "unhandled_rejection" });
  });
}
