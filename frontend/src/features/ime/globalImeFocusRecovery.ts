type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

type TextSelectionSnapshot = {
  kind: "text";
  start: number;
  end: number;
  direction: "forward" | "backward" | "none" | null;
};

type RangeSelectionSnapshot = {
  kind: "range";
  range: Range;
};

type FocusSnapshot = {
  selection: TextSelectionSnapshot | RangeSelectionSnapshot | null;
  scrollTop: number;
  scrollLeft: number;
};

const LAYOUT_SETTLE_DELAY_MS = 160;
const FOCUS_RESTORE_DELAY_MS = 60;
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password"]);

function isEditableTarget(target: Element | null): target is EditableTarget {
  if (!(target instanceof HTMLElement) || !target.isConnected) return false;
  if (target.closest(".xterm, .xterm-helper-textarea, [hidden], [inert]")) return false;

  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) && !target.disabled && !target.readOnly;
  }
  if (target instanceof HTMLTextAreaElement) {
    return !target.disabled && !target.readOnly;
  }
  return target.isContentEditable ||
    ["true", "plaintext-only", ""].includes(target.getAttribute("contenteditable") ?? "false");
}

function isInside(target: EventTarget | null, container: HTMLElement): boolean {
  return target instanceof Node && (target === container || container.contains(target));
}

function captureFocusSnapshot(target: EditableTarget): FocusSnapshot {
  let selection: FocusSnapshot["selection"] = null;

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (target.selectionStart !== null && target.selectionEnd !== null) {
      selection = {
        kind: "text",
        start: target.selectionStart,
        end: target.selectionEnd,
        direction: target.selectionDirection,
      };
    }
  } else {
    const current = document.getSelection();
    if (current?.rangeCount) {
      const range = current.getRangeAt(0);
      if (target.contains(range.commonAncestorContainer)) {
        selection = { kind: "range", range: range.cloneRange() };
      }
    }
  }

  return {
    selection,
    scrollTop: target.scrollTop,
    scrollLeft: target.scrollLeft,
  };
}

function restoreFocusSnapshot(target: EditableTarget, snapshot: FocusSnapshot): void {
  target.scrollTop = snapshot.scrollTop;
  target.scrollLeft = snapshot.scrollLeft;

  if (snapshot.selection?.kind === "text" &&
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    try {
      target.setSelectionRange(
        snapshot.selection.start,
        snapshot.selection.end,
        snapshot.selection.direction ?? "none",
      );
    } catch {
      // Some browser input types do not expose a selectable text range.
    }
    return;
  }

  if (snapshot.selection?.kind === "range" && target.contains(snapshot.selection.range.commonAncestorContainer)) {
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(snapshot.selection.range);
  }
}

/**
 * Restores the active WebView2 text control after native window activation or
 * geometry changes. xterm owns its hidden textarea and is intentionally
 * excluded; TerminalPane keeps its dedicated recovery path.
 */
export function attachGlobalImeFocusRecovery() {
  let disposed = false;
  let composing = false;
  let restoring = false;
  let blurredForRecovery = false;
  let pendingTarget: EditableTarget | null = null;
  let snapshot: FocusSnapshot | null = null;
  let layoutTimer: number | undefined;
  let focusTimer: number | undefined;

  const clearLayoutTimer = () => {
    if (layoutTimer !== undefined) {
      window.clearTimeout(layoutTimer);
      layoutTimer = undefined;
    }
  };

  const clearFocusTimer = () => {
    if (focusTimer !== undefined) {
      window.clearTimeout(focusTimer);
      focusTimer = undefined;
    }
  };

  const clearPending = () => {
    clearLayoutTimer();
    clearFocusTimer();
    pendingTarget = null;
    snapshot = null;
    blurredForRecovery = false;
    restoring = false;
  };

  const finishRestore = () => {
    focusTimer = undefined;
    const target = pendingTarget;
    if (disposed || !target || !snapshot || !isEditableTarget(target)) {
      clearPending();
      return;
    }

    if (!document.hasFocus() || composing) {
      restoring = false;
      return;
    }

    const active = document.activeElement;
    if (active !== target && active !== document.body && active !== document.documentElement) {
      clearPending();
      return;
    }

    restoring = false;
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }

    if (document.activeElement === target) {
      restoreFocusSnapshot(target, snapshot);
      clearPending();
    } else {
      clearPending();
    }
  };

  const recover = () => {
    layoutTimer = undefined;
    const target = pendingTarget;
    if (disposed || !target || composing || restoring) return;
    if (!isEditableTarget(target)) {
      clearPending();
      return;
    }
    if (!document.hasFocus()) return;

    const active = document.activeElement;
    if (active === target) {
      snapshot = captureFocusSnapshot(target);
      restoring = true;
      blurredForRecovery = true;
      target.blur();
    } else if (!(blurredForRecovery &&
        (active === document.body || active === document.documentElement))) {
      clearPending();
      return;
    }

    restoring = true;
    focusTimer = window.setTimeout(finishRestore, FOCUS_RESTORE_DELAY_MS);
  };

  const schedulePending = () => {
    if (disposed || !pendingTarget || composing || restoring) return;
    clearLayoutTimer();
    layoutTimer = window.setTimeout(recover, LAYOUT_SETTLE_DELAY_MS);
  };

  const queueActiveTarget = () => {
    if (disposed || restoring) return;
    const active = document.activeElement;

    if (isEditableTarget(active)) {
      if (pendingTarget !== active) clearPending();
      pendingTarget = active;
      schedulePending();
      return;
    }

    if (active !== document.body && active !== document.documentElement) {
      clearPending();
      return;
    }

    // A previous recovery may have blurred the target just before the native
    // window lost focus. Keep that target only for this interrupted cycle.
    if (blurredForRecovery && pendingTarget) schedulePending();
  };

  const onWindowActivated = () => queueActiveTarget();
  const onWindowGeometryChanged = () => queueActiveTarget();

  const onFocusIn = (event: FocusEvent) => {
    if (disposed || restoring || !pendingTarget) return;
    if (!isInside(event.target, pendingTarget)) clearPending();
  };

  const onCompositionStart = () => {
    composing = true;
    clearLayoutTimer();
  };

  const onCompositionEnd = () => {
    composing = false;
    if (pendingTarget && !restoring) schedulePending();
  };

  const onUserInput = (event: Event) => {
    if (!pendingTarget || !isInside(event.target, pendingTarget)) return;
    schedulePending();
  };

  window.addEventListener("focus", onWindowActivated);
  window.addEventListener("resize", onWindowGeometryChanged);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);
  document.addEventListener("keydown", onUserInput, true);
  document.addEventListener("input", onUserInput, true);

  return {
    onWindowActivated,
    onWindowGeometryChanged,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearPending();
      window.removeEventListener("focus", onWindowActivated);
      window.removeEventListener("resize", onWindowGeometryChanged);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("compositionstart", onCompositionStart, true);
      document.removeEventListener("compositionend", onCompositionEnd, true);
      document.removeEventListener("keydown", onUserInput, true);
      document.removeEventListener("input", onUserInput, true);
    },
  };
}
