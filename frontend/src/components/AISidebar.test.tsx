import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import AISidebar from "./AISidebar";
import { api } from "../bridge";
import type { AIConversation, Tab } from "../types";

const events = vi.hoisted(() => new Map<string, (data: any) => void>());

vi.mock("../bridge", () => ({
  api: {
    AIProviders: vi.fn(async () => []),
    AIConversations: vi.fn(async () => []),
  },
  errorText: (value: unknown) => String(value),
  listen: (name: string, callback: (data: any) => void) => {
    events.set(name, callback);
    return () => { events.delete(name); };
  },
}));

afterEach(() => {
  cleanup();
  events.clear();
});

test("AI output follows new chunks near the bottom, but respects manual scrollback", async () => {
  render(<AISidebar tabs={[]} pinned={false} isOpen={true} onTogglePin={vi.fn()} onClose={vi.fn()} />);
  const node = screen.getByRole("complementary", { name: "AI 助手" })
    .querySelector<HTMLElement>(".ai-messages")!;

  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 300 },
  });

  act(() => events.get("ai:delta")?.({ taskId: "test", text: "first" }));
  expect(node.scrollTop).toBe(1200);

  node.scrollTop = 200;
  fireEvent.scroll(node);
  act(() => events.get("ai:delta")?.({ taskId: "test", text: "second" }));
  expect(node.scrollTop).toBe(200);

  node.scrollTop = 900;
  fireEvent.scroll(node);
  act(() => events.get("ai:delta")?.({ taskId: "test", text: "third" }));
  expect(node.scrollTop).toBe(1200);
});

test("AI auto-scroll resumes after reopening while remaining at the bottom", () => {
  const props = { tabs: [], pinned: false, onTogglePin: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<AISidebar {...props} isOpen={false} />);
  const node = document.querySelector<HTMLElement>(".ai-messages")!;
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 300 },
  });
  act(() => events.get("ai:delta")?.({ taskId: "test", text: "while hidden" }));
  expect(node.scrollTop).toBe(0);
  rerender(<AISidebar {...props} isOpen={true} />);
  expect(node.scrollTop).toBe(1200);
});

const connectedTab: Tab = {
  id: "new-tab",
  session: {
    id: "hk-server", groupId: "", name: "hk", host: "example.test", port: 22,
    username: "root", authType: "password", privateKeyPath: "", credentialRef: "",
  },
  ref: { tabId: "new-tab", sessionId: "hk-server", generation: 8 },
  status: "connected",
  home: "/root", cwd: "/root", error: null,
};

const oldConversation = (host = "example.test"): AIConversation => ({
  id: "history-1", title: "历史 Docker 检查",
  providerId: "provider-1", modelId: "model-1", mode: "review",
  targetNames: ["hk (root@example.test)"],
  targetSessionIds: ["hk-server"],
  targetBindings: [{ sessionId: "hk-server", name: "hk", host, port: 22, username: "root" }],
  messages: [{ role: "user", content: "检查 Docker" }],
  updatedAt: "2026-11-03T07:00:00Z",
});

test("historical session uses the current connection after reconnect", async () => {
  vi.mocked(api.AIConversations).mockResolvedValueOnce([oldConversation()]);
  await act(async () => {
    render(<AISidebar tabs={[connectedTab]} active={connectedTab} pinned={true}
      isOpen={true} onTogglePin={vi.fn()} onClose={vi.fn()} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "全局对话记录" }));
  fireEvent.click(screen.getByRole("button", { name: /历史 Docker 检查/ }));
  expect(screen.getByRole("button", { name: /会话：hk/ })).toBeTruthy();
  expect(screen.queryByText(/目标未连接/)).toBeNull();
});

test("changed host in historical conversation never silently rebinds", async () => {
  vi.mocked(api.AIConversations).mockResolvedValueOnce([oldConversation("other.test")]);
  await act(async () => {
    render(<AISidebar tabs={[connectedTab]} active={connectedTab} pinned={true}
      isOpen={true} onTogglePin={vi.fn()} onClose={vi.fn()} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "全局对话记录" }));
  fireEvent.click(screen.getByRole("button", { name: /历史 Docker 检查/ }));
  expect(screen.getByText(/服务器地址、账号已改变/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "忽略未匹配目标" }));
  expect(screen.queryByText(/服务器地址、账号已改变/)).toBeNull();
});

test("legacy conversation requires explicit target rebinding", async () => {
  const legacy = oldConversation();
  delete legacy.targetBindings;
  delete legacy.targetSessionIds;
  vi.mocked(api.AIConversations).mockResolvedValueOnce([legacy]);
  await act(async () => {
    render(<AISidebar tabs={[connectedTab]} active={connectedTab} pinned={true}
      isOpen={true} onTogglePin={vi.fn()} onClose={vi.fn()} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "全局对话记录" }));
  fireEvent.click(screen.getByRole("button", { name: /历史 Docker 检查/ }));
  expect(screen.getByText(/没有可验证的目标服务器信息/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "使用当前所选会话" }));
  expect(screen.queryByText(/没有可验证的目标服务器信息/)).toBeNull();
});
