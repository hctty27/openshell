import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import AISendControl from "./AISendControl";

beforeEach(async () => { await initializeI18n("zh-CN"); });
afterEach(cleanup);

test("execution-mode arrow uses a styled tooltip rather than the native title", () => {
  render(<AISendControl mode="review" disabled={false} onModeChange={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "执行模式：自动审查" });
  expect(trigger.hasAttribute("title")).toBe(false);
  expect(trigger.getAttribute("data-tooltip")).toBe("执行模式：自动审查");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
});

test("execution-mode keyboard interaction still opens and closes the menu", () => {
  render(<AISendControl mode="review" disabled={false} onModeChange={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "执行模式：自动审查" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = screen.getByRole("menu", { name: "执行模式" });
  expect(menu).toBeTruthy();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
