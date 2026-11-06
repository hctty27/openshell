/**
 * Work around stale native IME caret coordinates after a WebView2 host resize.
 * A real focus transition must include a short gap for the TSF layout to reset.
 */
export function attachImeFocusRecovery(
  textarea: HTMLTextAreaElement | undefined,
  isActive: () => boolean,
  focusTerminal: () => void,
) {
  let disposed = false;
  let composing = false;
  let restoring = false;
  let pending = false;
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

  const schedule = () => {
    if (disposed || !textarea) return;
    pending = true;
    clearLayoutTimer();
    if (!composing && !restoring) layoutTimer = window.setTimeout(recover, 160);
  };

  const resume = () => {
    if (pending && !disposed && !composing && !restoring) schedule();
  };

  // Alt+Tab can invalidate WebView2's native IME caret even when the DOM
  // layout did not change. A fresh window activation must arm recovery.
  const onWindowActivated = () => {
    if (!disposed && !restoring && isActive()) schedule();
  };

  function recover() {
    layoutTimer = undefined;
    if (disposed || composing || restoring || !pending) return;
    // Keep the pending repair while the window, tab, or textarea lacks focus.
    // It will run when the user returns instead of stealing another control's focus.
    if (!textarea || !isActive() || !document.hasFocus() || document.activeElement !== textarea) return;
    pending = false;

    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;
    restoring = true;
    textarea.blur();
    focusTimer = window.setTimeout(() => {
      focusTimer = undefined;
      restoring = false;
      if (!disposed && !composing && isActive() && document.hasFocus() &&
          (document.activeElement === document.body ||
           document.activeElement === document.documentElement)) {
        focusTerminal();
        if (document.activeElement === textarea) {
          textarea.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
          textarea.scrollTop = scrollTop;
          textarea.scrollLeft = scrollLeft;
        }
      }
      if (!disposed && !document.hasFocus()) pending = true;
      resume();
    }, 60);
  }

  const onCompositionStart = () => {
    composing = true;
    clearLayoutTimer();
  };
  const onCompositionEnd = () => {
    composing = false;
    if (pending) schedule();
  };
  const onKeyDown = () => {
    if (pending && !composing && !restoring) schedule();
  };
  const onBlur = () => {
    if (restoring) return;
    // A legitimate blur (search, tab/window switching) must not discard a
    // layout change; restore only after the terminal receives focus again.
    clearLayoutTimer();
    clearFocusTimer();
  };
  const onFocus = () => resume();

  textarea?.addEventListener("compositionstart", onCompositionStart, true);
  textarea?.addEventListener("compositionend", onCompositionEnd, true);
  textarea?.addEventListener("keydown", onKeyDown, true);
  textarea?.addEventListener("blur", onBlur);
  textarea?.addEventListener("focus", onFocus);
  window.addEventListener("focus", onWindowActivated);

  return {
    schedule,
    resume,
    onWindowActivated,
    dispose: () => {
      disposed = true;
      clearLayoutTimer();
      clearFocusTimer();
      textarea?.removeEventListener("compositionstart", onCompositionStart, true);
      textarea?.removeEventListener("compositionend", onCompositionEnd, true);
      textarea?.removeEventListener("keydown", onKeyDown, true);
      textarea?.removeEventListener("blur", onBlur);
      textarea?.removeEventListener("focus", onFocus);
      window.removeEventListener("focus", onWindowActivated);
    },
  };
}
