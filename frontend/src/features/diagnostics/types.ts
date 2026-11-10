export interface DiagnosticEvent {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  module: string;
  operation: string;
  status: "ok" | "slow" | "error";
  code?: string;
  durationMs?: number;
  count?: number;
  ime?: IMEDiagnosticGeometry;
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

export interface IMEDiagnosticGeometry {
  target: "xterm" | "input" | "textarea" | "contenteditable" | "other" | "none";
  hasFocus: boolean;
  composing: boolean;
  rectX: number;
  rectY: number;
  rectWidth: number;
  rectHeight: number;
  screenX: number;
  screenY: number;
  dpr: number;
}
