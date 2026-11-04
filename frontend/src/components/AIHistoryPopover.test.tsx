import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import type { AIConversation } from "../types";
import AIHistoryPopover from "./AIHistoryPopover";

const today = new Date().toISOString();
const older = "2024-01-01T08:00:00Z";

function conversation(id: string, title: string, updatedAt: string): AIConversation {
  return {
    id, title, updatedAt, providerId: "api", modelId: "model", mode: "review",
    targetNames: [], messages: [],
  };
}

const entries = [
  conversation("today", "查看现在有哪些进程", today),
  conversation("older", "较早的 Docker 检查", older),
];

function Harness({ onSelect = vi.fn(), onDelete = vi.fn() }: {
  onSelect?: (item: AIConversation) => void; onDelete?: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={triggerRef} onClick={() => setOpen(value => !value)}>历史记录</button>
    {open && <AIHistoryPopover items={entries.filter(item => item.title.includes(query))}
      selectedID="today" query={query} onQueryChange={setQuery} onSelect={onSelect}
      onDelete={onDelete} onClose={() => setOpen(false)}
      triggerRef={triggerRef} title="当前会话记录" searchPlaceholder="搜索当前会话对话..." />}
  </>;
}

beforeEach(async () => { await initializeI18n("zh-CN"); });
afterEach(() => { cleanup(); });

test("history popup groups items and highlights only the selected conversation", () => {
  render(<Harness />);
  const panel = screen.getByRole("dialog", { name: "当前会话记录" });
  expect(panel.textContent).toContain("今天");
  expect(panel.textContent).toContain("更早");
  const active = screen.getByRole("button", { name: /查看现在有哪些进程/ });
  const inactive = screen.getByRole("button", { name: /较早的 Docker 检查/ });
  expect(active.getAttribute("aria-current")).toBe("true");
  expect(inactive.getAttribute("aria-current")).toBeNull();
  expect(document.querySelectorAll(".ai-history-entry")).toHaveLength(2);
  expect(active.querySelector(".ai-history-entry-title")?.textContent).toBe("查看现在有哪些进程");
  expect(active.querySelector(".ai-history-entry-meta")?.textContent).toMatch(/\d{2}:\d{2}/);
  expect(active.querySelector(".ai-history-entry-heading")).toBeNull();
});

test("keyboard arrows navigate entries; Escape closes and restores trigger focus", () => {
  render(<Harness />);
  const search = screen.getByRole("searchbox");
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /查看现在有哪些进程/ }));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /较早的 Docker 检查/ }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "当前会话记录" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "历史记录" }));
});

test("search stays focused while filtering; delete does not select a conversation", () => {
  const onSelect = vi.fn();
  const onDelete = vi.fn();
  render(<Harness onSelect={onSelect} onDelete={onDelete} />);
  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "Docker" } });
  expect(document.activeElement).toBe(search);
  expect(screen.queryByRole("button", { name: /查看现在有哪些进程/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "删除对话" }));
  expect(onDelete).toHaveBeenCalledWith("older");
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});
