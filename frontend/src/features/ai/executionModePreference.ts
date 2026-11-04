export type AIExecutionMode = "review" | "auto";

const prefix = "openshell.ai.execution-mode.";

function key(terminal: boolean): string {
  return prefix + (terminal ? "terminal" : "global");
}

export function readAIExecutionMode(terminal: boolean): AIExecutionMode {
  try {
    return window.localStorage.getItem(key(terminal)) === "auto" ? "auto" : "review";
  } catch {
    return "review";
  }
}

export function saveAIExecutionMode(terminal: boolean, mode: AIExecutionMode): void {
  try {
    window.localStorage.setItem(key(terminal), mode);
  } catch {
    // Keep the mode in component state when WebView storage is unavailable.
  }
}
