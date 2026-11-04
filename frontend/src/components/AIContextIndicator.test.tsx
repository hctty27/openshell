import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import AIContextIndicator from "./AIContextIndicator";

const stats = {
  window: 32768,
  estimatedTokens: 3013,
  lastPromptTokens: 3266,
  compactionCount: 2,
  isEstimate: true,
};

beforeEach(async () => { await initializeI18n("zh-CN"); });
afterEach(() => { cleanup(); });

test("context control shows the percentage beside the ring and detailed progress", () => {
  const onCompact = vi.fn();
  render(<AIContextIndicator stats={stats} compacting={false} disabled={false} onCompact={onCompact} />);

  const trigger = screen.getByRole("button", { name: "上下文使用情况" });
  expect(trigger.textContent).toBe("9%");
  expect(trigger.querySelector("svg text")).toBeNull();
  fireEvent.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "上下文使用情况" });
  expect(dialog.textContent).toContain("3,013 / 32,768 Tokens");
  expect(dialog.textContent).toContain("3,266");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("9");
  fireEvent.click(screen.getByRole("button", { name: "手动压缩上下文" }));
  expect(onCompact).toHaveBeenCalledOnce();
});

test("context popup closes on Escape and restores the header trigger focus", () => {
  render(<AIContextIndicator stats={stats} compacting={false} disabled={false} onCompact={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "上下文使用情况" });
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "上下文使用情况" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("context popup closes when history opens and never compacts without a conversation", () => {
  const onCompact = vi.fn();
  const view = render(<AIContextIndicator stats={stats} compacting={false} disabled onCompact={onCompact} />);
  fireEvent.click(screen.getByRole("button", { name: "上下文使用情况" }));
  expect(screen.getByRole("button", { name: "手动压缩上下文" }).hasAttribute("disabled")).toBe(true);
  view.rerender(<AIContextIndicator stats={stats} compacting={false} disabled onCompact={onCompact} historyOpen />);
  expect(screen.queryByRole("dialog", { name: "上下文使用情况" })).toBeNull();
  expect(onCompact).not.toHaveBeenCalled();
});
