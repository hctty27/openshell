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

  function recover() {
    layoutTimer = undefined;
    if (disposed || composing || restoring || !pending) return;
    pending = false;
    if (!textarea || !isActive() || !document.hasFocus() || document.activeElement !== textarea) return;

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
      if (pending && !disposed) schedule();
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
    pending = false;
    clearLayoutTimer();
    clearFocusTimer();
  };

  textarea?.addEventListener("compositionstart", onCompositionStart, true);
  textarea?.addEventListener("compositionend", onCompositionEnd, true);
  textarea?.addEventListener("keydown", onKeyDown, true);
  textarea?.addEventListener("blur", onBlur);

  return {
    schedule,
    dispose: () => {
      disposed = true;
      clearLayoutTimer();
      clearFocusTimer();
      textarea?.removeEventListener("compositionstart", onCompositionStart, true);
      textarea?.removeEventListener("compositionend", onCompositionEnd, true);
      textarea?.removeEventListener("keydown", onKeyDown, true);
      textarea?.removeEventListener("blur", onBlur);
    },
  };
}
