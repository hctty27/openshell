import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachImeFocusRecovery } from "./imeFocusRecovery";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup() {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  textarea.focus();
  let active = true;
  const focusTerminal = vi.fn(() => textarea.focus());
  const recovery = attachImeFocusRecovery(textarea, () => active, focusTerminal);
  return { textarea, focusTerminal, recovery, setActive: (value: boolean) => { active = value; } };
}

test("rebinds the focused terminal input once after layout settles", () => {
  const { textarea, focusTerminal, recovery } = setup();
  const blur = vi.spyOn(textarea, "blur");
  recovery.schedule();
  vi.advanceTimersByTime(100);
  recovery.schedule();
  vi.advanceTimersByTime(100);
  expect(focusTerminal).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60);
  expect(blur).toHaveBeenCalledOnce();
  expect(focusTerminal).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60);
  expect(focusTerminal).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(textarea);
  recovery.dispose();
});

test("postpones focus rebinding while the user keeps typing", () => {
  const { textarea, focusTerminal, recovery } = setup();
  recovery.schedule();
  vi.advanceTimersByTime(100);
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  vi.advanceTimersByTime(100);
  expect(focusTerminal).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(textarea);
  vi.advanceTimersByTime(60);
  expect(document.activeElement).toBe(document.body);
  vi.advanceTimersByTime(60);
  expect(focusTerminal).toHaveBeenCalledOnce();
  recovery.dispose();
});

test("never interrupts an in-progress IME composition", () => {
  const { textarea, focusTerminal, recovery } = setup();
  textarea.dispatchEvent(new Event("compositionstart"));
  recovery.schedule();
  vi.advanceTimersByTime(500);
  expect(focusTerminal).not.toHaveBeenCalled();
  textarea.dispatchEvent(new Event("compositionend"));
  vi.advanceTimersByTime(160);
  expect(focusTerminal).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60);
  expect(focusTerminal).toHaveBeenCalledOnce();
  recovery.dispose();
});

test("does not steal focus from search or another input", () => {
  const { focusTerminal, recovery } = setup();
  const search = document.createElement("input");
  document.body.appendChild(search);
  recovery.schedule();
  search.focus();
  vi.advanceTimersByTime(200);
  expect(focusTerminal).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(search);
  recovery.dispose();
});

test("does not re-focus an inactive session", () => {
  const { focusTerminal, recovery, setActive } = setup();
  recovery.schedule();
  setActive(false);
  vi.advanceTimersByTime(200);
  expect(focusTerminal).not.toHaveBeenCalled();
  recovery.dispose();
});

test("does not steal focus if another input is clicked during the reanchor gap", () => {
  const { focusTerminal, recovery } = setup();
  const search = document.createElement("input");
  document.body.appendChild(search);
  recovery.schedule();
  vi.advanceTimersByTime(160);
  search.focus();
  vi.advanceTimersByTime(60);
  expect(focusTerminal).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(search);
  recovery.dispose();
});

test("cancels scheduled recovery on unmount", () => {
  const { focusTerminal, recovery } = setup();
  recovery.schedule();
  recovery.dispose();
  vi.advanceTimersByTime(200);
  expect(focusTerminal).not.toHaveBeenCalled();
});

test("defers a pending layout repair while the user focuses another input", () => {
  const { textarea, focusTerminal, recovery } = setup();
  const search = document.createElement("input");
  document.body.appendChild(search);
  recovery.schedule();
  search.focus();
  vi.advanceTimersByTime(500);
  expect(focusTerminal).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(search);

  textarea.focus();
  vi.advanceTimersByTime(160);
  expect(document.activeElement).toBe(document.body);
  vi.advanceTimersByTime(60);
  expect(focusTerminal).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(textarea);
  recovery.dispose();
});

test("keeps pending repair while inactive and resumes when activated", () => {
  const { focusTerminal, recovery, setActive } = setup();
  recovery.schedule();
  setActive(false);
  vi.advanceTimersByTime(200);
  expect(focusTerminal).not.toHaveBeenCalled();
  setActive(true);
  recovery.resume();
  vi.advanceTimersByTime(220);
  expect(focusTerminal).toHaveBeenCalledOnce();
  recovery.dispose();
});

test("restores focus after returning to an unfocused window", () => {
  const { focusTerminal, recovery } = setup();
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  recovery.schedule();
  vi.advanceTimersByTime(200);
  expect(focusTerminal).not.toHaveBeenCalled();
  hasFocus.mockReturnValue(true);
  window.dispatchEvent(new FocusEvent("focus"));
  vi.advanceTimersByTime(220);
  expect(focusTerminal).toHaveBeenCalledOnce();
  recovery.dispose();
});

test("repairs the caret after Alt+Tab even if no resize or move occurred", () => {
  const { textarea, focusTerminal, recovery } = setup();
  const blur = vi.spyOn(textarea, "blur");
  window.dispatchEvent(new FocusEvent("focus"));
  vi.advanceTimersByTime(160);
  expect(blur).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(60);
  expect(focusTerminal).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(textarea);
  recovery.dispose();
});

test("deduplicates the native and DOM activation notifications", () => {
  const { textarea, focusTerminal, recovery } = setup();
  const blur = vi.spyOn(textarea, "blur");
  recovery.onWindowActivated();
  vi.advanceTimersByTime(50);
  window.dispatchEvent(new FocusEvent("focus"));
  vi.advanceTimersByTime(220);
  expect(blur).toHaveBeenCalledOnce();
  expect(focusTerminal).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(500);
  expect(blur).toHaveBeenCalledOnce();
  recovery.dispose();
});

test("does not steal focus from another input after Alt+Tab", () => {
  const { textarea, focusTerminal, recovery } = setup();
  const search = document.createElement("input");
  document.body.appendChild(search);
  search.focus();
  recovery.onWindowActivated();
  vi.advanceTimersByTime(400);
  expect(document.activeElement).toBe(search);
  expect(focusTerminal).not.toHaveBeenCalled();
  textarea.focus();
  vi.advanceTimersByTime(220);
  expect(focusTerminal).toHaveBeenCalledOnce();
  recovery.dispose();
});

test("postpones Alt+Tab recovery until composition is complete", () => {
  const { textarea, focusTerminal, recovery } = setup();
  textarea.dispatchEvent(new Event("compositionstart"));
  recovery.onWindowActivated();
  vi.advanceTimersByTime(500);
  expect(document.activeElement).toBe(textarea);
  expect(focusTerminal).not.toHaveBeenCalled();
  textarea.dispatchEvent(new Event("compositionend"));
  vi.advanceTimersByTime(220);
  expect(focusTerminal).toHaveBeenCalledOnce();
  recovery.dispose();
});

test("does not initiate Alt+Tab recovery for an inactive pane", () => {
  const { focusTerminal, recovery, setActive } = setup();
  setActive(false);
  window.dispatchEvent(new FocusEvent("focus"));
  recovery.onWindowActivated();
  vi.advanceTimersByTime(400);
  expect(focusTerminal).not.toHaveBeenCalled();
  recovery.dispose();
});
