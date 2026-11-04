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
    AIContext: vi.fn(async () => ({ window: 262144, estimatedTokens: 131072, lastPromptTokens: 128000, compactionCount: 1, isEstimate: true })),
    AICompactConversation: vi.fn(async () => oldConversation()),
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
  window.localStorage.removeItem("openshell.ai.execution-mode.global");
  window.localStorage.removeItem("openshell.ai.execution-mode.terminal");
  vi.mocked(api.AIStart).mockClear();
});

test("only terminal AI adopts the compact workspace header", async () => {
  const props = { tabs: [connectedTab], active: connectedTab, pinned: true, isOpen: true, onTogglePin: vi.fn() };
  const globalView = render(<AISidebar {...props} />);
  const globalHeader = screen.getByRole("complementary", { name: "AI 助手" }).querySelector(".ai-header");
  expect(globalHeader?.classList.contains("workspace-panel-header")).toBe(false);
  expect(globalHeader?.querySelector("svg")).toBeTruthy();
  globalView.unmount();

  await act(async () => render(<AISidebar {...props} terminalScopeId="hk-server" />));
  const terminalHeader = screen.getByRole("complementary", { name: "终端 AI" }).querySelector(".ai-header");
  expect(terminalHeader?.classList.contains("workspace-panel-header")).toBe(true);
  expect(terminalHeader?.querySelector(".workspace-panel-dot")).toBeTruthy();
});

async function renderRunningAI(initiallyOpen = true) {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "p1", name: "provider", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "test", name: "test" }],
  }]);
  const props = { tabs: [connectedTab], active: connectedTab, pinned: true, onTogglePin: vi.fn() };
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<AISidebar {...props} isOpen={initiallyOpen} />); });
  fireEvent.change(screen.getByPlaceholderText("描述需要 AI 执行的任务..."), { target: { value: "检查日志" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(api.AIStart).toHaveBeenCalled());
  return { ...view, props };
}

test("AI output follows only the active task and respects manual scrollback", async () => {
  await renderRunningAI();
  const node = screen.getByRole("complementary", { name: "AI 助手" })
    .querySelector<HTMLElement>(".ai-messages")!;
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 300 },
  });
  act(() => events.get("ai:delta")?.({ taskId: "another-task", text: "ignore" }));
  expect(node.textContent).not.toContain("ignore");
  act(() => events.get("ai:delta")?.({ taskId: "task-1", text: "first" }));
  expect(node.scrollTop).toBe(1200);
  node.scrollTop = 200;
  fireEvent.scroll(node);
  act(() => events.get("ai:delta")?.({ taskId: "task-1", text: "second" }));
  expect(node.scrollTop).toBe(200);
  node.scrollTop = 900;
  fireEvent.scroll(node);
  act(() => events.get("ai:delta")?.({ taskId: "task-1", text: "third" }));
  expect(node.scrollTop).toBe(1200);
});

test("AI auto-scroll resumes after reopening while at the bottom", async () => {
  const { rerender, props } = await renderRunningAI();
  const node = document.querySelector<HTMLElement>(".ai-messages")!;
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 300 },
  });
  rerender(<AISidebar {...props} isOpen={false} />);
  node.scrollTop = 0;
  act(() => events.get("ai:delta")?.({ taskId: "task-1", text: "while hidden" }));
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

test("terminal AI uses the active terminal without an execution selector", async () => {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "p1", name: "cpa", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "gpt-test", name: "gpt-test" }],
  }]);
  await act(async () => render(<AISidebar tabs={[connectedTab]} active={connectedTab}
    terminalScopeId="hk-server" pinned isOpen onTogglePin={vi.fn()} />));
  expect(screen.getByRole("complementary", { name: "终端 AI" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "AI 操作方式" })).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("描述需要 AI 执行的任务..."), {
    target: { value: "检查当前目录" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(api.AIStart).toHaveBeenCalledWith(expect.objectContaining({
    execution: "terminal", scopeId: "hk-server", targets: [connectedTab.ref],
  })));
});

test("terminal AI blocks sending during an alternate-screen program", async () => {
  await act(async () => render(<AISidebar tabs={[connectedTab]} active={connectedTab}
    terminalScopeId="hk-server" terminalAlternate pinned isOpen onTogglePin={vi.fn()} />));
  expect(screen.getByText(/正在运行全屏交互程序/)).toBeTruthy();
});

test("global AI always uses independent execution", async () => {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "p1", name: "provider", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "test", name: "test" }],
  }]);
  await act(async () => render(<AISidebar tabs={[connectedTab]} active={connectedTab}
    pinned isOpen onTogglePin={vi.fn()} />));
  expect(screen.queryByRole("button", { name: "AI 操作方式" })).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("描述需要 AI 执行的任务..."), {
    target: { value: "检查服务器" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(api.AIStart).toHaveBeenCalledWith(expect.objectContaining({
    execution: "independent", scopeId: "", targets: [connectedTab.ref],
  })));
});

test("English controls have no obsolete execution selector", async () => {
  await initializeI18n("en");
  render(<AISidebar tabs={[]} pinned={false} isOpen={true} onTogglePin={vi.fn()} />);
  expect(screen.getByRole("complementary", { name: "AI Assistant" })).toBeTruthy();
  expect(screen.getByText("Let AI help manage your servers")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "AI execution method" })).toBeNull();
  expect(screen.getByPlaceholderText("Describe the task for AI...")).toBeTruthy();
});

test("execution mode is selected from the split send button, without sending", () => {
  render(<AISidebar tabs={[connectedTab]} active={connectedTab} pinned isOpen
    onTogglePin={vi.fn()} />);
  expect(document.querySelector(".ai-controls")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "执行模式" })).toBeNull();
  const trigger = screen.getByRole("button", { name: "执行模式：自动审查" });
  fireEvent.click(trigger);
  const automatic = screen.getByRole("menuitemradio", { name: "完全自动" });
  expect(automatic.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(automatic);
  expect(screen.getByRole("button", { name: "执行模式：完全自动" })).toBeTruthy();
  expect(window.localStorage.getItem("openshell.ai.execution-mode.global")).toBe("auto");
  expect(api.AIStart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "执行模式：完全自动" }));
  const menu = screen.getByRole("menu", { name: "执行模式" });
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "执行模式：完全自动" }));
});

test("global sessions are in the composer while terminal AI has no target toolbar", () => {
  const view = render(<AISidebar tabs={[connectedTab]} active={connectedTab} pinned isOpen
    onTogglePin={vi.fn()} />);
  const global = screen.getByRole("complementary", { name: "AI 助手" });
  const selector = screen.getByRole("button", { name: /会话：hk/ });
  expect(selector.closest(".ai-compose")).toBeTruthy();
  expect(global.querySelector(".ai-compose-config--with-target")).toBeTruthy();
  expect(global.querySelector(".ai-controls")).toBeNull();
  view.rerender(<AISidebar tabs={[connectedTab]} active={connectedTab} pinned isOpen
    terminalScopeId="hk-server" onTogglePin={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /会话：/ })).toBeNull();
  expect(document.querySelector(".ai-controls")).toBeNull();
  expect(screen.getByRole("complementary", { name: "终端 AI" }).querySelector(".ai-compose")).toBeTruthy();
  expect(screen.getByRole("button", { name: "执行模式：自动审查" })).toBeTruthy();
});

test("terminal history is filtered to the selected session", async () => {
  vi.mocked(api.AIConversations).mockResolvedValueOnce([
    { ...oldConversation(), id: "global", scope: "global", title: "全局历史" },
    { ...oldConversation(), id: "terminal-hk", scope: "terminal", scopeId: "hk-server", title: "当前终端历史" },
    { ...oldConversation(), id: "terminal-us", scope: "terminal", scopeId: "us-server", title: "其他终端历史" },
  ]);
  await act(async () => render(<AISidebar tabs={[connectedTab]} active={connectedTab}
    terminalScopeId="hk-server" pinned isOpen onTogglePin={vi.fn()} />));
  fireEvent.click(screen.getByRole("button", { name: "当前会话记录" }));
  expect(screen.getByText("当前终端历史")).toBeTruthy();
  expect(screen.queryByText("全局历史")).toBeNull();
  expect(screen.queryByText("其他终端历史")).toBeNull();
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
  expect(choices[0].closest("label")?.textContent).toBe("hk");
  expect(screen.getByRole("checkbox", { name: "hk" })).toBeTruthy();

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

test("new conversation stays a draft until its first message is submitted", async () => {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "provider-1", name: "provider", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "model-1", name: "model" }],
  }]);
  vi.mocked(api.AIConversations).mockResolvedValueOnce([oldConversation()]);
  await act(async () => render(<AISidebar tabs={[connectedTab]} active={connectedTab}
    pinned isOpen onTogglePin={vi.fn()} />));

  fireEvent.click(screen.getByRole("button", { name: "全局对话记录" }));
  fireEvent.click(screen.getByRole("button", { name: /历史 Docker 检查/ }));
  fireEvent.click(screen.getByRole("button", { name: "新对话" }));

  expect(api.AIStart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "全局对话记录" }));
  expect(document.querySelectorAll(".ai-history-entry")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "全局对话记录" }));

  fireEvent.change(screen.getByPlaceholderText("描述需要 AI 执行的任务..."), {
    target: { value: "检查磁盘" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(api.AIStart).toHaveBeenCalledWith(expect.objectContaining({
    conversationId: "", text: "检查磁盘",
  })));
});

test("context meter is local to the selected conversation and permits manual compaction", async () => {
  vi.mocked(api.AIProviders).mockResolvedValueOnce([{
    id: "provider-1", name: "provider", baseUrl: "https://example.test/v1", hasKey: true,
    models: [{ id: "model-1", name: "model", contextWindow: 262144 }],
  }]);
  vi.mocked(api.AIConversations).mockResolvedValueOnce([oldConversation()]);
  await act(async () => render(<AISidebar tabs={[connectedTab]} active={connectedTab}
    pinned={true} isOpen={true} onTogglePin={vi.fn()} />));
  fireEvent.click(screen.getByRole("button", { name: "全局对话记录" }));
  fireEvent.click(screen.getByRole("button", { name: /历史 Docker 检查/ }));
  await waitFor(() => expect(api.AIContext).toHaveBeenCalledWith("history-1", "provider-1", "model-1"));
  fireEvent.click(screen.getByRole("button", { name: "上下文使用情况" }));
  expect(screen.getByRole("dialog", { name: "上下文使用情况" }).textContent).toContain("131,072 / 262,144");
  fireEvent.click(screen.getByRole("button", { name: "压缩上下文" }));
  await waitFor(() => expect(api.AICompactConversation).toHaveBeenCalledWith("history-1"));
});


test("context meter is in header and dropdowns dismiss each other", async () => {
  vi.mocked(api.AIConversations).mockResolvedValueOnce([oldConversation()]);
  await act(async () => render(<AISidebar tabs={[connectedTab]} active={connectedTab}
    terminalScopeId="hk-server" pinned isOpen onTogglePin={vi.fn()} />));
  const panel = screen.getByRole("complementary", { name: "终端 AI" });
  expect(panel.querySelector(".ai-header .ai-context-control")).toBeTruthy();
  expect(panel.querySelector(".ai-compose .ai-context-control")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "上下文使用情况" }));
  expect(screen.getByRole("dialog", { name: "上下文使用情况" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "当前会话记录" }));
  expect(screen.queryByRole("dialog", { name: "上下文使用情况" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "当前会话记录" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "上下文使用情况" }));
  expect(screen.queryByRole("dialog", { name: "当前会话记录" })).toBeNull();
});
