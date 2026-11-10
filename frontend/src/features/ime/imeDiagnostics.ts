import { Events } from "@wailsio/runtime";
import { recordImeDiagnostic } from "../diagnostics/collector";
import type { IMEDiagnosticGeometry } from "../diagnostics/types";

let installed = false;
let composing = false;

function targetType(active: Element | null): IMEDiagnosticGeometry["target"] {
  if (!active || active === document.body || active === document.documentElement) return "none";
  if (active instanceof HTMLTextAreaElement) {
    return active.closest(".xterm") ? "xterm" : "textarea";
  }
  if (active instanceof HTMLInputElement) return "input";
  if (active instanceof HTMLElement && active.isContentEditable) return "contenteditable";
  return "other";
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

// These are DOM-element bounds, not the native TSF caret or candidate-window bounds.
// No value, placeholder, selection text, file path, or user content is sampled.
export function readImeGeometry(): IMEDiagnosticGeometry {
  const active = document.activeElement;
  let rect = active instanceof Element ? active.getBoundingClientRect() : null;

  if (active instanceof HTMLElement && active.isContentEditable) {
    const selection = document.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (active.contains(range.commonAncestorContainer)) {
        const caretRect = range.getBoundingClientRect();
        if (caretRect.height > 0) rect = caretRect;
      }
    }
  }

  return {
    target: targetType(active),
    hasFocus: document.hasFocus(),
    composing,
    rectX: finite(rect?.x ?? 0),
    rectY: finite(rect?.y ?? 0),
    rectWidth: finite(rect?.width ?? 0),
    rectHeight: finite(rect?.height ?? 0),
    screenX: finite(window.screenX),
    screenY: finite(window.screenY),
    dpr: finite(window.devicePixelRatio),
  };
}

function capture(operation: string): void {
  recordImeDiagnostic(operation, readImeGeometry());
}

// Diagnostic branch only: this listener never changes focus or moves the caret.
export function installImeDiagnostics(): void {
  const native = typeof (window as Window & {
    chrome?: { webview?: { postMessage?: unknown } }
  }).chrome?.webview?.postMessage === "function";
  if (installed || !native || !navigator.userAgent.includes("Windows")) return;
  installed = true;

  const windowsEvents = [
    ["windows:WindowActive", "window_active"],
    ["windows:WindowInactive", "window_inactive"],
    ["windows:WindowSetFocus", "window_set_focus"],
    ["windows:WindowKillFocus", "window_kill_focus"],
  ] as const;

  for (const [name, operation] of windowsEvents) {
    Events.On(name, () => {
      capture(operation);
      if (operation === "window_active") {
        requestAnimationFrame(() => capture("after_activation"));
      }
    });
  }

  window.addEventListener("focus", () => capture("dom_focus"));
  window.addEventListener("blur", () => capture("dom_blur"));
  document.addEventListener("focusin", () => capture("focus_change"), true);
  document.addEventListener("compositionstart", () => {
    composing = true;
    capture("composition_start");
  }, true);
  document.addEventListener("compositionend", () => {
    composing = false;
    capture("composition_end");
  }, true);
}
