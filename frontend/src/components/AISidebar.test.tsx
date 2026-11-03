import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import AISidebar from "./AISidebar";
import { api } from "../bridge";
import type { AIConversation, Tab } from "../types";

const events = vi.hoisted(() => new Map<string, (data: any) => void>());

vi.mock("../bridge", () => ({
  api: {
    AIProviders: vi.fn(async () => []),
    AIConversations: vi.fn(async () => []),
    AIStart: vi.fn(async () => ({ taskId: "task-1", conversationId: "conversation-1" })),
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

test("visible terminal mode uses automatic readiness detection without confirmation checkbox", async () => {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "p1", name: "cpa", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "gpt-test", name: "gpt-test" }],
  }]);
  await act(async () => {
    render(<AISidebar tabs={[connectedTab]} active={connectedTab}
      pinned isOpen onTogglePin={vi.fn()} onClose={vi.fn()} />);
  });
  fireEvent.change(screen.getByTitle("AI 操作方式"), { target: { value: "terminal" } });
  fireEvent.change(screen.getByPlaceholderText("描述需要 AI 执行的任务..."), {
    target: { value: "检查当前目录" },
  });
  const send = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
  expect(screen.getByText(/自动检测 Shell 是否空闲/)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /终端已停留在空白 Shell 提示符/ })).toBeNull();
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(api.AIStart).toHaveBeenCalledWith(expect.objectContaining({
    execution: "terminal", targets: [connectedTab.ref],
  })));
});

test("alternate terminal screen rejects visible-terminal execution", async () => {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "p1", name: "cpa", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "gpt-test", name: "gpt-test" }],
  }]);
  await act(async () => {
    render(<AISidebar tabs={[connectedTab]} active={connectedTab}
      terminalAlternate pinned isOpen onTogglePin={vi.fn()} onClose={vi.fn()} />);
  });
  fireEvent.change(screen.getByTitle("AI 操作方式"), { target: { value: "terminal" } });
  expect(screen.getByText(/正在运行全屏交互程序/)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /终端已停留/ })).toBeNull();
});

test("AI defaults to automatic SSH execution routing", async () => {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "p1", name: "provider", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "test", name: "test" }],
  }]);
  await act(async () => {
    render(<AISidebar tabs={[connectedTab]} active={connectedTab}
      pinned isOpen onTogglePin={vi.fn()} onClose={vi.fn()} />);
  });
  const select = screen.getByTitle("AI 操作方式") as HTMLSelectElement;
  expect(select.value).toBe("auto");
  expect(screen.getByText(/普通 SSH 优先独立执行/)).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("描述需要 AI 执行的任务..."), {
    target: { value: "检查服务器" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(api.AIStart).toHaveBeenCalledWith(expect.objectContaining({
    execution: "auto", targets: [connectedTab.ref],
  })));
});
