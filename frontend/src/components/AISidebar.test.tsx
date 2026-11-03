import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
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

beforeEach(async () => { await initializeI18n("zh-CN"); });
afterEach(() => {
  cleanup();
  events.clear();
});

test("AI output follows new chunks near the bottom, but respects manual scrollback", async () => {
  render(<AISidebar tabs={[]} pinned={false} isOpen={true} onTogglePin={vi.fn()} />);
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
      isOpen={true} onTogglePin={vi.fn()} />);
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
      isOpen={true} onTogglePin={vi.fn()} />);
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
      isOpen={true} onTogglePin={vi.fn()} />);
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
      pinned isOpen onTogglePin={vi.fn()} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "AI 操作方式" }));
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
      terminalAlternate pinned isOpen onTogglePin={vi.fn()} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "AI 操作方式" }));
  fireEvent.change(screen.getByTitle("AI 操作方式"), { target: { value: "terminal" } });
  expect(screen.getAllByText(/正在运行全屏交互程序/).length).toBeGreaterThan(0);
  expect(screen.queryByRole("checkbox", { name: /终端已停留/ })).toBeNull();
});

test("AI defaults to automatic SSH execution routing", async () => {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "p1", name: "provider", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "test", name: "test" }],
  }]);
  await act(async () => {
    render(<AISidebar tabs={[connectedTab]} active={connectedTab}
      pinned isOpen onTogglePin={vi.fn()} />);
  });
  expect(screen.queryByText(/普通 SSH 优先独立执行/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "AI 操作方式" }));
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


test("AI sidebar is usable in English without leftover Chinese controls", async () => {
  await initializeI18n("en");
  render(<AISidebar tabs={[]} pinned={false} isOpen={true} onTogglePin={vi.fn()} />);
  expect(screen.getByRole("complementary", { name: "AI Assistant" })).toBeTruthy();
  expect(screen.getByText("Let AI help manage your servers")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "AI execution method" }));
  expect(screen.getByTitle("AI execution method")).toBeTruthy();
  expect(screen.getByText(/Execution capabilities are detected automatically/)).toBeTruthy();
  expect(screen.getByPlaceholderText("Describe the task for AI...")).toBeTruthy();
});

test("AI sidebar keeps execution details in an accessible compact menu", () => {
  render(<AISidebar tabs={[connectedTab]} active={connectedTab} pinned={true}
    isOpen={true} onTogglePin={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "执行模式" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "自动审查" })).toBeTruthy();
  expect(screen.queryByText(/普通 SSH 优先独立执行/)).toBeNull();
  const options = screen.getByRole("button", { name: "AI 操作方式" });
  expect(options.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(options);
  expect(options.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByTitle("AI 操作方式")).toBeTruthy();
  expect(screen.getByText(/普通 SSH 优先独立执行/)).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(options.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(/普通 SSH 优先独立执行/)).toBeNull();
});

test("multi-session summary stays compact and selection retains exact targets", async () => {
  const extraTabs: Tab[] = [
    { ...connectedTab, id: "extra-1",
      session: { ...connectedTab.session, id: "region-1", name: "一台名称很长的服务器一号" },
      ref: { tabId: "extra-1", sessionId: "region-1", generation: 1 } },
    { ...connectedTab, id: "extra-2",
      session: { ...connectedTab.session, id: "region-2", name: "另一台名称很长的服务器二号" },
      ref: { tabId: "extra-2", sessionId: "region-2", generation: 1 } },
  ];
  render(<AISidebar tabs={[connectedTab, ...extraTabs]} active={connectedTab}
    pinned isOpen onTogglePin={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "收起 AI 栏" })).toBeNull();

  const selector = screen.getByRole("button", { name: /会话：hk/ });
  fireEvent.click(selector);
  const choices = screen.getAllByRole("checkbox");
  expect(choices).toHaveLength(3);
  expect((choices[0] as HTMLInputElement).disabled).toBe(true);

  fireEvent.click(choices[1]);
  expect(selector.textContent).toContain("hk +1");
  expect(selector.getAttribute("title")).toContain("一台名称很长的服务器一号");
  expect(selector.getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(choices[2]);
  expect(selector.textContent).toContain("hk +2");
  expect(selector.getAttribute("title")).toContain("另一台名称很长的服务器二号");
  expect(selector.getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(choices[1]);
  expect(selector.textContent).toContain("hk +1");
  expect((choices[0] as HTMLInputElement).checked).toBe(true);
  expect((choices[1] as HTMLInputElement).checked).toBe(false);
  expect((choices[2] as HTMLInputElement).checked).toBe(true);
});
