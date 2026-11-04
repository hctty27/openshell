export interface DiagnosticEvent {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  module: string;
  operation: string;
  status: "ok" | "slow" | "error";
  code?: string;
  durationMs?: number;
  count?: number;
}

export interface DiagnosticOperation {
  module: string;
  operation: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface DiagnosticsSnapshot {
  startedAt: string;
  heapBytes: number;
  goroutines: number;
  recorded: number;
  dropped: number;
  diskEnabled: boolean;
  events: DiagnosticEvent[];
  operations: DiagnosticOperation[];
}
