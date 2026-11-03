/**
 * WebView2 may keep an outdated TSF caret location after the host window is
 * resized. Rebinding the focused xterm textarea after layout settles restores
 * the native IME anchor without recreating the terminal or touching its input.
 */
export function attachImeFocusRecovery(
  textarea: HTMLTextAreaElement | undefined,
  isActive: () => boolean,
  focusTerminal: () => void,
) {
  let disposed = false;
  let composing = false;
  let pending = false;
  let timer: number | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };

  const recover = () => {
    timer = undefined;
    if (disposed || composing || !pending) return;
    pending = false;
    if (!textarea || !isActive() || !document.hasFocus() || document.activeElement !== textarea) return;

    // A focus transition refreshes WebView2's native IME caret coordinates.
    // Never do this during an active composition: it can drop committed text.
    textarea.blur();
    focusTerminal();
  };

  const schedule = () => {
    if (disposed || !textarea) return;
    pending = true;
    clearTimer();
    if (!composing) timer = window.setTimeout(recover, 160);
  };

  const onCompositionStart = () => {
    composing = true;
    clearTimer();
  };
  const onCompositionEnd = () => {
    composing = false;
    if (pending) schedule();
  };
  const onBlur = () => {
    pending = false;
    clearTimer();
  };

  textarea?.addEventListener("compositionstart", onCompositionStart, true);
  textarea?.addEventListener("compositionend", onCompositionEnd, true);
  textarea?.addEventListener("blur", onBlur);

  return {
    schedule,
    dispose: () => {
      disposed = true;
      clearTimer();
      textarea?.removeEventListener("compositionstart", onCompositionStart, true);
      textarea?.removeEventListener("compositionend", onCompositionEnd, true);
      textarea?.removeEventListener("blur", onBlur);
    },
  };
}
