import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachGlobalImeFocusRecovery } from "./globalImeFocusRecovery";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup<T extends HTMLElement>(target: T) {
  document.body.appendChild(target);
  target.focus();
  const recovery = attachGlobalImeFocusRecovery();
  return { target, recovery };
}

function activate(recovery: ReturnType<typeof attachGlobalImeFocusRecovery>) {
  recovery.onWindowActivated();
  vi.advanceTimersByTime(160);
}

test.each(["text", "search", "email"])("restores a focused input[type=%s] after window activation", type => {
  const input = document.createElement("input");
  input.type = type;
  const { target, recovery } = setup(input);
  const blur = vi.spyOn(input, "blur");

  activate(recovery);
  expect(blur).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(60);
  expect(document.activeElement).toBe(target);

  recovery.dispose();
});

test("restores a textarea and preserves its caret and scroll position", () => {
  const textarea = document.createElement("textarea");
  textarea.value = "OpenShell IME recovery";
  const { target, recovery } = setup(textarea);
  textarea.setSelectionRange(4, 9, "backward");
  textarea.scrollTop = 12;
  textarea.scrollLeft = 3;

  recovery.onWindowActivated();
  vi.advanceTimersByTime(220);

  expect(document.activeElement).toBe(target);
  expect(textarea.selectionStart).toBe(4);
  expect(textarea.selectionEnd).toBe(9);
  expect(textarea.selectionDirection).toBe("backward");
  expect(textarea.scrollTop).toBe(12);
  expect(textarea.scrollLeft).toBe(3);

  recovery.dispose();
});

test("restores a focused contenteditable editor", () => {
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.tabIndex = 0;
  const { target, recovery } = setup(editor);

  activate(recovery);
  vi.advanceTimersByTime(60);

  expect(document.activeElement).toBe(target);
  recovery.dispose();
});

test("does not touch xterm's hidden textarea", () => {
  const textarea = document.createElement("textarea");
  textarea.className = "xterm-helper-textarea";
  const { recovery } = setup(textarea);
  const blur = vi.spyOn(textarea, "blur");

  activate(recovery);
  vi.advanceTimersByTime(60);

  expect(blur).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(textarea);
  recovery.dispose();
});

test("does not steal focus after the user moves to another control", () => {
  const input = document.createElement("input");
  const other = document.createElement("input");
  document.body.append(input, other);
  input.focus();
  const recovery = attachGlobalImeFocusRecovery();

  recovery.onWindowActivated();
  other.focus();
  vi.advanceTimersByTime(300);

  expect(document.activeElement).toBe(other);
  recovery.dispose();
});

test("never interrupts an active IME composition", () => {
  const textarea = document.createElement("textarea");
  const { recovery } = setup(textarea);
  const blur = vi.spyOn(textarea, "blur");

  textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  recovery.onWindowActivated();
  vi.advanceTimersByTime(500);
  expect(blur).not.toHaveBeenCalled();

  textarea.dispatchEvent(new Event("compositionend", { bubbles: true }));
  vi.advanceTimersByTime(220);
  expect(blur).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(textarea);

  recovery.dispose();
});

test("postpones recovery while the user is typing", () => {
  const textarea = document.createElement("textarea");
  const { recovery } = setup(textarea);
  const blur = vi.spyOn(textarea, "blur");

  recovery.onWindowActivated();
  vi.advanceTimersByTime(100);
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  vi.advanceTimersByTime(100);
  expect(blur).not.toHaveBeenCalled();

  vi.advanceTimersByTime(60);
  expect(blur).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(60);
  expect(document.activeElement).toBe(textarea);
  recovery.dispose();
});

test("deduplicates DOM and native activation notifications", () => {
  const textarea = document.createElement("textarea");
  const { recovery } = setup(textarea);
  const blur = vi.spyOn(textarea, "blur");

  recovery.onWindowActivated();
  vi.advanceTimersByTime(50);
  window.dispatchEvent(new FocusEvent("focus"));
  recovery.onWindowActivated();
  vi.advanceTimersByTime(160);
  expect(blur).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(60);
  expect(document.activeElement).toBe(textarea);

  recovery.dispose();
});

test("cancels pending recovery when disposed", () => {
  const textarea = document.createElement("textarea");
  const { recovery } = setup(textarea);
  const blur = vi.spyOn(textarea, "blur");

  recovery.onWindowActivated();
  recovery.dispose();
  vi.advanceTimersByTime(300);

  expect(blur).not.toHaveBeenCalled();
});

test("keeps an interrupted blur cycle pending until the window is active again", () => {
  const textarea = document.createElement("textarea");
  const { recovery } = setup(textarea);
  const hasFocus = vi.spyOn(document, "hasFocus");

  recovery.onWindowActivated();
  vi.advanceTimersByTime(160);
  hasFocus.mockReturnValue(false);
  vi.advanceTimersByTime(60);
  expect(document.activeElement).toBe(document.body);

  hasFocus.mockReturnValue(true);
  recovery.onWindowActivated();
  vi.advanceTimersByTime(220);
  expect(document.activeElement).toBe(textarea);

  recovery.dispose();
});
