import { beforeEach as beforeLanguageTest } from "vitest";
import { initializeI18n as setTestLanguage } from "./i18n";
beforeLanguageTest(() => setTestLanguage("zh-CN"));
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { expect, test, vi, afterEach } from "vitest";
import App from "./App";
import { api } from "./bridge";
import type { Session } from "./types";
const transferEvents = vi.hoisted(() => ({
  listeners: new Map<string, Set<(payload: any) => void>>(),
}));
vi.mock("./components/TerminalPane", () => ({
  default: (props: {
    tab: { id: string; ref?: { tabId: string; sessionId: string; generation: number } | null; cloneCwd?: string };
    active: boolean;
    onDirectoryChange?: (ref: { tabId: string; sessionId: string; generation: number }, directory: string) => void;
    visible?: boolean;
    onActivate?: () => void;
  }) => (
    <div
      data-testid="terminal-pane-stub"
      className={`terminal-pane ${props.visible ? "visible" : ""}`}
      data-tab-id={props.tab.id}
      data-clone-cwd={props.tab.cloneCwd ?? ""}
      data-active={props.active}
      data-visible={props.visible}
      onMouseDown={props.onActivate}
      onDoubleClick={() => { if (props.tab.ref) props.onDirectoryChange?.(props.tab.ref, "/data/my project"); }}
    />
  ),
}));
vi.mock("./components/SFTPView", () => ({
  default: (props: { initialRemoteDirectory?: string; cwdReported?: boolean }) =>
    <div data-testid="sftp-panel-stub" data-initial-directory={props.initialRemoteDirectory} data-cwd-reported={String(props.cwdReported)}>
      SFTP file view
    </div>,
}));
vi.mock("./bridge", async () => ({
  ...(await vi.importActual<typeof import("./bridge")>("./bridge")),
  desktop: true,
  api: {
    SetCloseGuardReady: vi.fn(async () => {}),
    QuitConfirmed: vi.fn(async () => {}),
    CloseTab: vi.fn(async () => {}),
    SavePreference: vi.fn(async () => {}),
    SFTPTransfers: vi.fn(async () => []),
    CancelZmodem: vi.fn(async () => {}),
    Disconnect: vi.fn(async () => {}),
    Connect: vi.fn(async (tabId: string, sessionId: string) => ({
      ref: { tabId, sessionId, generation: 1 },
      home: "/root",
    })),
    SaveSession: vi.fn(async (req: { session: Session }) => req.session),
    State: vi.fn(async () => ({
      sessions: [],
      groups: [],
            fontSize: "14",
      language: "zh-CN",
      version: "0.1.17",
    })),
  },
  listen: (name: string, callback: (payload: any) => void) => {
    if (!transferEvents.listeners.has(name)) transferEvents.listeners.set(name, new Set());
    transferEvents.listeners.get(name)!.add(callback);
    return () => transferEvents.listeners.get(name)?.delete(callback);
  },
}));
afterEach(() => {
  cleanup();
  vi.mocked(api.Connect).mockClear();
});
test("opens right AI dock from the edge rail without a titlebar icon", async () => {
  await act(async () => {
    render(<App />);
  });
  expect(screen.getAllByText("会话管理")[0]).toBeTruthy();
  expect(document.querySelector(".workspace-header")).toBeNull();
  expect(screen.queryByRole("button", { name: "打开 AI 助手" })).toBeNull();
  const aiDock = document.querySelector(".ai-dock") as HTMLElement;
  expect(aiDock.classList.contains("ai-dock--auto")).toBe(true);
  expect(screen.queryByRole("complementary", { name: "AI 助手" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开 AI 助手" }));
  expect(aiDock.classList.contains("is-open")).toBe(true);
  expect(screen.getByRole("complementary", { name: "AI 助手" })).toBeTruthy();
});
test("right AI dock mirrors session sidebar hover, pin and Escape behavior", async () => {
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [], groups: [], fontSize: "14", version: "test",
    language: "zh-CN", aiSidebarMode: "pinned",
  });
  await act(async () => { render(<App />); });
  const dock = document.querySelector(".ai-dock") as HTMLElement;
  const panel = document.getElementById("global-ai-panel") as HTMLElement;
  const pin = screen.getByRole("button", { name: "自动隐藏 AI 栏" });
  expect(pin.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(pin);
  expect(dock.classList.contains("ai-dock--auto")).toBe(true);
  expect(dock.classList.contains("is-open")).toBe(true);
  expect(screen.getByRole("button", { name: "固定 AI 栏" }).getAttribute("aria-pressed")).toBe("false");
  await waitFor(() => expect(api.SavePreference).toHaveBeenCalledWith("aiSidebarMode", "auto-hide"));
  fireEvent.mouseLeave(dock);
  await waitFor(() => expect(panel.getAttribute("aria-hidden")).toBe("true"), { timeout: 1200 });
  fireEvent.mouseEnter(dock);
  await waitFor(() => expect(panel.getAttribute("aria-hidden")).toBe("false"), { timeout: 1200 });
  const rail = screen.getByRole("button", { name: "展开 AI 助手" });
  expect(rail.getAttribute("aria-controls")).toBe("global-ai-panel");
  fireEvent.keyDown(dock, { key: "Escape" });
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  expect(document.activeElement).toBe(rail);
  fireEvent.click(rail);
  fireEvent.click(screen.getByRole("button", { name: "固定 AI 栏" }));
  expect(dock.classList.contains("ai-dock--auto")).toBe(false);
  expect(screen.getByRole("button", { name: "自动隐藏 AI 栏" }).getAttribute("aria-pressed")).toBe("true");
});

test("global AI pin survives SFTP and terminal AI panel switching", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [{ id: "server-a", groupId: "", name: "server-a", host: "example.test",
      port: 22, username: "root", authType: "key", privateKeyPath: "", credentialRef: "saved" }],
    groups: [], fontSize: "14", language: "zh-CN", version: "test", aiSidebarMode: "pinned",
  });
  await act(async () => { render(<App />); });
  fireEvent.doubleClick(screen.getByRole("button", { name: "选中会话 server-a" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  const dock = document.querySelector(".ai-dock") as HTMLElement;
  const pinned = () => !dock.classList.contains("ai-dock--auto");
  expect(pinned()).toBe(true);
  fireEvent.click(screen.getByTitle("打开 SFTP 文件管理"));
  expect(screen.getByTestId("sftp-panel-stub")).toBeTruthy();
  expect(pinned()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "自动隐藏 AI 栏" }));
  expect(pinned()).toBe(false);
  expect(screen.getByTestId("sftp-panel-stub")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "展开 AI 助手" }));
  expect(dock.classList.contains("is-open")).toBe(true);
  expect(screen.getByTestId("sftp-panel-stub")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "固定 AI 栏" }));
  expect(pinned()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "终端 AI" }));
  expect(screen.queryByTestId("sftp-panel-stub")).toBeNull();
  expect(screen.getByRole("complementary", { name: "终端 AI" })).toBeTruthy();
  expect(pinned()).toBe(true);
  fireEvent.click(screen.getByTitle("打开 SFTP 文件管理"));
  expect(screen.getByTestId("sftp-panel-stub")).toBeTruthy();
  expect(pinned()).toBe(true);
  fireEvent.click(screen.getByTitle("关闭文件侧栏"));
  expect(screen.queryByTestId("sftp-panel-stub")).toBeNull();
  expect(pinned()).toBe(true);
});

test("session sidebar can auto-hide, hover open and pin without remounting the tree", async () => {
  vi.mocked(api.SavePreference).mockClear();
  await act(async () => { render(<App />); });
  const dock = document.querySelector(".session-sidebar-dock") as HTMLElement;
  const panel = screen.getByRole("complementary");
  expect(dock.classList.contains("session-sidebar-dock--auto")).toBe(false);
  expect(document.querySelector(".window-titlebar-sidebar")).toBeNull();
  const autoHideButton = screen.getByRole("button", { name: "自动隐藏会话栏" });
  const headingButtons = Array.from(document.querySelectorAll(".sidebar-heading button"));
  expect(headingButtons.at(-1)).toBe(autoHideButton);
  expect(autoHideButton.classList.contains("sidebar-pin-toggle")).toBe(true);
  expect(autoHideButton.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(autoHideButton);
  expect(dock.classList.contains("session-sidebar-dock--auto")).toBe(true);
  const rail = screen.getByRole("button", { name: "展开会话栏" });
  expect(rail).toBeTruthy();
  expect(rail.children).toHaveLength(0);
  await waitFor(() => expect(api.SavePreference).toHaveBeenCalledWith("sessionSidebarMode", "auto-hide"));
  fireEvent.mouseLeave(dock);
  await waitFor(() => expect(panel.getAttribute("aria-hidden")).toBe("true"), { timeout: 1200 });
  fireEvent.mouseEnter(dock);
  await waitFor(() => expect(panel.getAttribute("aria-hidden")).toBeNull(), { timeout: 1200 });
  expect(document.getElementById("session-sidebar-panel")).toBe(panel);
  const pinButton = screen.getByRole("button", { name: "固定会话栏" });
  expect(pinButton.getAttribute("aria-pressed")).toBe("false");
  expect(pinButton.classList.contains("is-pinned")).toBe(false);
  fireEvent.click(pinButton);
  expect(dock.classList.contains("session-sidebar-dock--auto")).toBe(false);
  expect(screen.getByRole("button", { name: "自动隐藏会话栏" }).classList.contains("is-pinned")).toBe(true);
  expect(document.getElementById("session-sidebar-panel")).toBe(panel);
  await waitFor(() => expect(api.SavePreference).toHaveBeenCalledWith("sessionSidebarMode", "pinned"));
});

test("restores the saved auto-hide sidebar mode and width", async () => {
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [], groups: [], fontSize: "14", version: "test",
    language: "zh-CN", sessionSidebarMode: "auto-hide", sessionSidebarWidth: 314,
  });
  await act(async () => { render(<App />); });
  const dock = document.querySelector(".session-sidebar-dock") as HTMLElement;
  expect(dock.classList.contains("session-sidebar-dock--auto")).toBe(true);
  expect((dock.closest(".app") as HTMLElement).style.getPropertyValue("--session-width")).toBe("314px");
  expect(screen.getByRole("button", { name: "展开会话栏" }).getAttribute("aria-expanded")).toBe("false");
});

test("sidebar details are collapsed by default and saved when expanded", async () => {
  vi.mocked(api.SavePreference).mockClear();
  await act(async () => { render(<App />); });
  const panel = screen.getByTestId("session-details");
  const toggle = screen.getByRole("button", { name: "详细信息" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.classList.contains("is-collapsed")).toBe(true);
  expect(screen.queryByRole("separator", { name: "调整会话详情高度" })).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(panel.classList.contains("is-collapsed")).toBe(false);
  expect(screen.getByRole("separator", { name: "调整会话详情高度" })).toBeTruthy();
  await waitFor(() => expect(api.SavePreference).toHaveBeenCalledWith("sessionDetailsExpanded", "true"));
  fireEvent.click(toggle);
  await waitFor(() => expect(api.SavePreference).toHaveBeenCalledWith("sessionDetailsExpanded", "false"));
});

test("restores expanded session details and exposes infrequent actions via menu", async () => {
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [], groups: [], fontSize: "14", version: "test",
    language: "zh-CN", sessionDetailsExpanded: true,
  });
  await act(async () => { render(<App />); });
  expect(screen.getByRole("button", { name: "详细信息" }).getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".sidebar-heading-tools")?.querySelectorAll("button")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(screen.getByRole("menuitem", { name: "导入 Xshell 会话" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "新建分组" })).toBeTruthy();
});

test("mouse-focused session search does not keep auto-hidden sidebar open forever", async () => {
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByRole("button", { name: "自动隐藏会话栏" }));
  const dock = document.querySelector(".session-sidebar-dock") as HTMLElement;
  const panel = screen.getByRole("complementary");
  fireEvent.mouseLeave(dock);
  await waitFor(() => expect(panel.getAttribute("aria-hidden")).toBe("true"), { timeout: 1200 });
  fireEvent.mouseEnter(dock);
  await waitFor(() => expect(panel.getAttribute("aria-hidden")).toBeNull(), { timeout: 1200 });
  const search = screen.getByPlaceholderText("搜索会话…");
  fireEvent.pointerDown(search);
  fireEvent.focus(search);
  fireEvent.mouseLeave(dock);
  await waitFor(() => expect(panel.getAttribute("aria-hidden")).toBe("true"), { timeout: 1200 });
});

test("Escape closes auto-hidden sidebar and focuses the edge trigger", async () => {
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByRole("button", { name: "自动隐藏会话栏" }));
  const dock = document.querySelector(".session-sidebar-dock") as HTMLElement;
  const panel = document.getElementById("session-sidebar-panel") as HTMLElement;
  fireEvent.mouseLeave(dock);
  await waitFor(() => expect(panel.getAttribute("aria-hidden")).toBe("true"), { timeout: 1200 });
  const rail = screen.getByRole("button", { name: "展开会话栏" });
  fireEvent.click(rail);
  const search = screen.getByPlaceholderText("搜索会话…");
  fireEvent.focus(search);
  fireEvent.keyDown(search, { key: "Escape" });
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  expect(document.activeElement).toBe(rail);
});
test("theme previews immediately and is saved in general settings", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  fireEvent.click(screen.getByRole("button", { name: "浅色" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() =>
    expect(api.SavePreference).toHaveBeenCalledWith("theme", "light"),
  );
  fireEvent.click(screen.getByRole("button", { name: "深色" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
});
test("settings navigation includes an About section", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  expect(screen.getByRole("navigation", { name: "设置分类" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "通用" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "终端" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "关于" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "AI 配置" })).toBeNull();
  expect(screen.queryByRole("button", { name: "自动执行" })).toBeNull();
  expect(screen.queryByText("OpenShell · 中文终端预览")).toBeNull();
  expect(screen.queryByText(/systemctl status redis/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "终端" }));
  expect(screen.getByLabelText("字体大小")).toBeTruthy();
  expect(screen.queryByLabelText("快速命令栏布局")).toBeNull();
  expect(screen.queryByText("界面语言")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "通用" }));
  expect(screen.getByLabelText("界面语言")).toBeTruthy();
});

test("opens session editor without connecting and rejects missing host", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getAllByTitle("新建会话")[0]);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("主机地址")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存会话" }));
  expect(screen.getByText("请填写主机地址和用户名")).toBeTruthy();
});
test("moves Settings to the top toolbar and product info to About", async () => {
  await act(async () => {
    render(<App />);
  });
  expect(document.querySelector(".brand")).toBeNull();
  expect(document.querySelector(".sidebar-footer")).toBeNull();
  expect(document.querySelector(".workspace-status")).toBeNull();
  const settingsButton = screen.getByRole("button", { name: "设置" });
  expect(settingsButton.closest(".window-titlebar")).toBeTruthy();
  fireEvent.click(settingsButton);
  fireEvent.click(screen.getByRole("button", { name: "关于" }));
  expect(screen.getAllByText("OpenShell").length).toBeGreaterThan(0);
  expect(screen.getByText(/版本 v\d+\.\d+\.\d+/)).toBeTruthy();
});

test("terminal mouse settings are opt-in and saved independently", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  fireEvent.click(screen.getByRole("button", { name: "终端" }));
  const copy = screen.getByLabelText("选中自动复制") as HTMLInputElement;
  const paste = screen.getByLabelText("鼠标右键粘贴") as HTMLInputElement;
  const highlight = screen.getByLabelText("持续高亮日志级别") as HTMLInputElement;
  expect(copy.checked).toBe(false);
  expect(paste.checked).toBe(false);
  expect(screen.queryByLabelText("鼠标中键粘贴")).toBeNull();
  expect(highlight.checked).toBe(false);
  fireEvent.click(highlight);
  fireEvent.click(copy);
  fireEvent.click(paste);
  const confirm = screen.getByLabelText("多行粘贴前确认") as HTMLInputElement;
  expect(confirm.checked).toBe(true);
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => {
    expect(api.SavePreference).toHaveBeenCalledWith(
      "autoCopySelection",
      "true",
    );
    expect(api.SavePreference).toHaveBeenCalledWith("rightClickPaste", "true");
    expect(api.SavePreference).toHaveBeenCalledWith("logHighlights", "true");
    expect(api.SavePreference).toHaveBeenCalledWith(
      "confirmMultilinePaste",
      "false",
    );
  });
});

test("the tab plus opens a session list and reuses an already opened SSH tab", async () => {
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [
      {
        id: "us-id",
        groupId: "",
        name: "us",
        host: "38.65.94.188",
        port: 22,
        username: "root",
        authType: "key",
        privateKeyPath: "",
        credentialRef: "saved",
      },
    ],
    groups: [],
        fontSize: "14",
    language: "zh-CN",
    version: "0.1.14",
  });
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("打开会话列表"));
  expect(screen.getByRole("dialog", { name: "会话管理" })).toBeTruthy();
  expect(screen.queryByLabelText("主机地址")).toBeNull();
  const row = screen.getByRole("button", { name: "选择会话 us" });
  fireEvent.click(row);
  expect(screen.queryByTitle("关闭 us")).toBeNull();
  fireEvent.doubleClick(row);
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  expect(screen.getAllByTitle("关闭 us")).toHaveLength(1);

  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 us" }));
  expect(screen.getAllByTitle("关闭 us")).toHaveLength(1);
  expect(api.Connect).toHaveBeenCalledTimes(1);
});

test("edits an active session without disconnecting and updates every open tab", async () => {
  vi.mocked(api.Connect).mockClear();
  const session: Session = {
    id: "us-id",
    groupId: "",
    name: "us",
    host: "old.example",
    port: 22,
    username: "root",
    authType: "key",
    privateKeyPath: "/tmp/id",
    credentialRef: "",
  };
  const changed: Session = { ...session, name: "US Updated", host: "new.example", port: 2222 };
  const state = (sessions: Session[]) => ({
    sessions,
    groups: [],
        fontSize: "14",
    language: "zh-CN" as const,
    version: "0.1.25",
  });
  vi.mocked(api.State)
    .mockResolvedValueOnce(state([session]))
    .mockResolvedValueOnce(state([changed]));
  vi.mocked(api.SaveSession).mockResolvedValueOnce(changed);

  await act(async () => {
    render(<App />);
  });
  fireEvent.doubleClick(screen.getByRole("button", { name: "选中会话 us" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  fireEvent.doubleClick(screen.getByTitle("双击复制会话"));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));

  const row = screen.getByRole("button", { name: "选中会话 us" });
  fireEvent.contextMenu(row, { clientX: 100, clientY: 90 });
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑会话" }));
  expect(screen.getByText(/此会话已连接/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("会话名称"), {
    target: { value: "US Updated" },
  });
  fireEvent.change(screen.getByLabelText("主机地址"), {
    target: { value: "new.example" },
  });
  fireEvent.change(screen.getByLabelText("端口"), {
    target: { value: "2222" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存会话" }));
  await waitFor(() => expect(api.SaveSession).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getAllByTitle("关闭 US Updated")).toHaveLength(2));
  expect(api.Connect).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/新参数将在下次连接时生效/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "选中会话 US Updated" })).toBeTruthy();
});

test("duplicate tab inherits a reported working directory for SSH and SFTP", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [{ id: "copy-id", groupId: "", name: "copy", host: "example.test",
      port: 22, username: "root", authType: "key", privateKeyPath: "", credentialRef: "saved" }],
    groups: [], fontSize: "14", language: "zh-CN", version: "test",
  });
  await act(async () => { render(<App />); });
  fireEvent.doubleClick(screen.getByRole("button", { name: "选中会话 copy" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  fireEvent.doubleClick(screen.getByTestId("terminal-pane-stub"));
  fireEvent.doubleClick(screen.getByTitle("双击复制会话"));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));
  const panes = screen.getAllByTestId("terminal-pane-stub");
  expect(panes[1].getAttribute("data-clone-cwd")).toBe("/data/my project");
  fireEvent.click(screen.getByTitle("打开 SFTP 文件管理"));
  expect(screen.getByTestId("sftp-panel-stub").getAttribute("data-initial-directory"))
    .toBe("/data/my project");
});

test("double-clicking a terminal tab opens an independent SSH session beside it with the same name", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [
      {
        id: "us-id",
        groupId: "",
        name: "us",
        host: "server.example.com",
        port: 22,
        username: "root",
        authType: "key",
        privateKeyPath: "",
        credentialRef: "saved",
      },
      {
        id: "eu-id",
        groupId: "",
        name: "eu",
        host: "another.example.com",
        port: 22,
        username: "root",
        authType: "key",
        privateKeyPath: "",
        credentialRef: "saved",
      },
    ],
    groups: [],
        fontSize: "14",
    language: "zh-CN",
    version: "0.1.18",
  });
  await act(async () => {
    render(<App />);
  });

  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 us" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 eu" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));

  const tabNames = () =>
    Array.from(
      document.querySelectorAll(".terminal-tab > button:first-child"),
    ).map((element) => element.textContent);
  expect(tabNames()).toEqual(["us", "eu"]);

  fireEvent.doubleClick(screen.getAllByTitle("双击复制会话")[0]);
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(3));

  expect(tabNames()).toEqual(["us", "us", "eu"]);
  expect(screen.getAllByTitle("关闭 us")).toHaveLength(2);
  expect(
    document.querySelectorAll(".terminal-tab")[1].classList.contains("active"),
  ).toBe(true);

  const calls = vi.mocked(api.Connect).mock.calls;
  expect(calls[2][1]).toBe("us-id");
  expect(calls[2][0]).not.toBe(calls[0][0]);
});

async function dragFirstTabOntoActiveTerminal() {
  const tab = document.querySelector<HTMLElement>(".terminal-tab button")!;
  const target = document.querySelector<HTMLElement>(".terminal-pane.visible[data-active='true']")!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    left: 100, top: 100, width: 800, height: 500, right: 900, bottom: 600,
    x: 100, y: 100, toJSON: () => ({}),
  });
  fireEvent.pointerDown(tab, { button: 0, pointerId: 7, clientX: 140, clientY: 15 });
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 850, clientY: 350 });
  fireEvent.pointerUp(window, { pointerId: 7, clientX: 850, clientY: 350 });
  await waitFor(() =>
    expect(document.querySelector(".terminal-container")?.classList.contains("terminal-split")).toBe(true));
}

test("two connected sessions can split, rotate, focus and close without extra SSH connections", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [
      {
        id: "us-id", groupId: "", name: "us", host: "us.example.com", port: 22,
        username: "root", authType: "key", privateKeyPath: "", credentialRef: "saved",
      },
      {
        id: "eu-id", groupId: "", name: "eu", host: "eu.example.com", port: 22,
        username: "root", authType: "key", privateKeyPath: "", credentialRef: "saved",
      },
    ],
    groups: [], fontSize: "14", language: "zh-CN", version: "0.1.33",
  });
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 us" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 eu" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("combobox", { name: "分屏选择…" })).toBeNull();
  await dragFirstTabOntoActiveTerminal();
  expect(document.querySelector(".terminal-container")?.classList.contains("terminal-split-columns")).toBe(true);
  const panes = screen.getAllByTestId("terminal-pane-stub");
  expect(panes.filter((pane) => pane.getAttribute("data-visible") === "true")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "切换分屏方向" }));
  expect(document.querySelector(".terminal-container")?.classList.contains("terminal-split-rows")).toBe(true);
  const previous = panes.find((pane) => pane.getAttribute("data-active") === "false");
  expect(previous).toBeTruthy();
  fireEvent.mouseDown(previous!);
  expect(previous?.getAttribute("data-active")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "关闭分屏" }));
  expect(document.querySelector(".terminal-container")?.classList.contains("terminal-split")).toBe(false);
  expect(api.Connect).toHaveBeenCalledTimes(2);
});

test("split gutter accepts keyboard, drag, and reset with persistent bounds", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [
      { id: "us-id", groupId: "", name: "us", host: "us.example.com", port: 22,
        username: "root", authType: "key", privateKeyPath: "", credentialRef: "saved" },
      { id: "eu-id", groupId: "", name: "eu", host: "eu.example.com", port: 22,
        username: "root", authType: "key", privateKeyPath: "", credentialRef: "saved" },
    ],
    groups: [], fontSize: "14", language: "zh-CN", splitRatio: 60, version: "0.1.34",
  });
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 us" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 eu" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));
  await dragFirstTabOntoActiveTerminal();
  const separator = screen.getByRole("separator", { name: "调整终端分屏比例" });
  expect(separator.getAttribute("aria-valuenow")).toBe("60");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator.getAttribute("aria-valuenow")).toBe("65");
  await waitFor(() => expect(api.SavePreference).toHaveBeenCalledWith("splitRatio", "65"));
  const container = document.querySelector(".terminal-container") as HTMLElement;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600,
    x: 0, y: 0, toJSON: () => ({}),
  });
  fireEvent.pointerDown(separator, { button: 0, pointerId: 7 });
  fireEvent.pointerMove(document, { pointerId: 7, clientX: 560, clientY: 100 });
  fireEvent.pointerUp(document, { pointerId: 7 });
  expect(separator.getAttribute("aria-valuenow")).toBe("70");
  await waitFor(() => expect(api.SavePreference).toHaveBeenCalledWith("splitRatio", "70"));
  fireEvent.doubleClick(separator);
  expect(separator.getAttribute("aria-valuenow")).toBe("50");
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator.getAttribute("aria-valuenow")).toBe("20");
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator.getAttribute("aria-valuenow")).toBe("80");
  expect(api.Connect).toHaveBeenCalledTimes(2);
});

test("SFTP opens beside the existing terminal and can close without reconnecting", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [{
      id: "us-id", groupId: "", name: "us", host: "us.example.com",
      port: 22, username: "root", authType: "key",
      privateKeyPath: "", credentialRef: "saved",
    }],
    groups: [], fontSize: "14", language: "zh-CN", version: "0.1.39",
  });
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 us" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  expect(screen.getAllByTestId("terminal-pane-stub")).toHaveLength(1);
  fireEvent.click(screen.getByTitle("打开 SFTP 文件管理"));
  expect(document.querySelector(".workspace-workarea")?.classList.contains("with-sftp")).toBe(true);
  expect(screen.getByTestId("sftp-panel-stub")).toBeTruthy();
  expect(screen.getByTestId("sftp-panel-stub").getAttribute("data-initial-directory")).toBe("/root");
  expect(document.querySelector(".workspace-file-panel .transfer-dock")).toBeNull();
  expect(document.querySelector(".workspace-workarea > .transfer-dock")).toBeNull();
  expect(document.querySelector(".window-titlebar .transfer-center")).toBeTruthy();
  expect(screen.getByTestId("sftp-panel-stub").getAttribute("data-cwd-reported")).toBe("false");
  const terminal = document.querySelector(".terminal-container") as HTMLElement;
  expect(terminal.style.display).not.toBe("none");
  expect(screen.getAllByTestId("terminal-pane-stub")).toHaveLength(1);
  fireEvent.click(screen.getByTitle("关闭文件侧栏"));
  const hiddenPanel = document.querySelector(".workspace-file-panel") as HTMLElement;
  expect(hiddenPanel.style.display).toBe("none");
  expect(hiddenPanel.getAttribute("aria-hidden")).toBe("true");
  expect(document.querySelector(".workspace-status-transfer")).toBeNull();
  expect(document.querySelector(".workspace-status .transfer-dock")).toBeNull();
  expect(document.querySelector(".terminal-container")).toBe(terminal);
  expect(api.Connect).toHaveBeenCalledTimes(1);

  const tabID = screen.getByTestId("terminal-pane-stub").getAttribute("data-tab-id");
  const ref = { tabId: tabID, sessionId: "us-id", generation: 1 };
  act(() => {
    for (const listener of transferEvents.listeners.get("ssh:transfer-details") ?? []) {
      listener({ ref, direction: "upload", protocol: "zmodem" });
    }
    for (const listener of transferEvents.listeners.get("ssh:transfer-state") ?? []) {
      listener({ ref, active: true });
    }
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("ZMODEM")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(api.CancelZmodem).toHaveBeenCalledWith(ref));
});

test("closing a connected tab requires confirmation and cancelling preserves it", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.CloseTab).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [{id:"live-id",groupId:"",name:"Live Server",host:"example.test",port:22,
      username:"root",authType:"key",privateKeyPath:"",credentialRef:"saved"}],
    groups: [], fontSize:"14", language:"zh-CN",
 version:"0.1.58",
  });
  await act(async () => { render(<App />); });
  fireEvent.doubleClick(screen.getByRole("button", {name:"选中会话 Live Server"}));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(document.querySelector(".connection-state-connected")).not.toBeNull());

  fireEvent.click(screen.getByTitle("关闭 Live Server"));
  expect(screen.getByText("关闭 SSH 会话？")).toBeTruthy();
  expect(screen.getAllByText(/root@example\.test:22/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", {name:"取消"}));
  expect(screen.getByTitle("关闭 Live Server")).toBeTruthy();
  expect(api.CloseTab).not.toHaveBeenCalled();
  await act(async () => { await Promise.resolve(); });

  fireEvent.click(screen.getByTitle("关闭 Live Server"));
  fireEvent.click(screen.getByRole("button", {name:"断开并关闭"}));
  await waitFor(() => expect(api.CloseTab).toHaveBeenCalledTimes(1));
  expect(screen.queryByTitle("关闭 Live Server")).toBeNull();
});

test("closing an already disconnected tab needs no SSH confirmation", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.CloseTab).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [{id:"offline-id",groupId:"",name:"Offline",host:"example.test",port:22,
      username:"root",authType:"key",privateKeyPath:"",credentialRef:"saved"}],
    groups: [], fontSize:"14", language:"zh-CN",
 autoReconnect:false, version:"0.1.58",
  });
  await act(async () => { render(<App />); });
  fireEvent.doubleClick(screen.getByRole("button", {name:"选中会话 Offline"}));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  const id = screen.getByTestId("terminal-pane-stub").getAttribute("data-tab-id");
  act(() => {
    for (const listener of transferEvents.listeners.get("ssh:disconnected") ?? [])
      listener({tabId:id,sessionId:"offline-id",generation:1});
  });
  await waitFor(() => expect(document.querySelector(".connection-state-local")).not.toBeNull());
  fireEvent.click(screen.getByTitle("关闭 Offline"));
  await waitFor(() => expect(api.CloseTab).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("关闭 SSH 会话？")).toBeNull();
});

test("native quit request asks once for live sessions, cancellation is safe", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.QuitConfirmed).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [{id:"quit-id",groupId:"",name:"Quit Server",host:"example.test",port:22,
      username:"root",authType:"key",privateKeyPath:"",credentialRef:"saved"}],
    groups: [], fontSize:"14", language:"zh-CN",
 version:"0.1.58",
  });
  await act(async () => { render(<App />); });
  await waitFor(() => expect(api.SetCloseGuardReady).toHaveBeenCalledWith(true));
  fireEvent.doubleClick(screen.getByRole("button", {name:"选中会话 Quit Server"}));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  act(() => {
    for (const listener of transferEvents.listeners.get("app:quit-requested") ?? []) listener(null);
    for (const listener of transferEvents.listeners.get("app:quit-requested") ?? []) listener(null);
  });
  expect(screen.getAllByText("确定退出 OpenShell？")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", {name:"取消"}));
  expect(api.QuitConfirmed).not.toHaveBeenCalled();
  expect(screen.getByTitle("关闭 Quit Server")).toBeTruthy();
  await act(async () => { await Promise.resolve(); });
  act(() => {
    for (const listener of transferEvents.listeners.get("app:quit-requested") ?? []) listener(null);
  });
  fireEvent.click(screen.getByRole("button", {name:"断开所有连接并退出"}));
  await waitFor(() => expect(api.QuitConfirmed).toHaveBeenCalledTimes(1));
});

test("native quit request exits directly when there are no active SSH sessions", async () => {
  vi.mocked(api.QuitConfirmed).mockClear();
  await act(async () => { render(<App />); });
  act(() => {
    for (const listener of transferEvents.listeners.get("app:quit-requested") ?? []) listener(null);
  });
  await waitFor(() => expect(api.QuitConfirmed).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("确定退出 OpenShell？")).toBeNull();
});

test("terminal toolbar has one context-aware disconnect/reconnect control", async () => {
  vi.mocked(api.Connect).mockClear();
  vi.mocked(api.Disconnect).mockClear();
  vi.mocked(api.State).mockResolvedValueOnce({
    sessions: [{ id: "toggle-id", groupId: "", name: "Toggle", host: "example.test",
      port: 22, username: "root", authType: "key", privateKeyPath: "", credentialRef: "saved" }],
    groups: [], fontSize: "14", language: "zh-CN", version: "0.1.64",
  });
  await act(async () => { render(<App />); });
  fireEvent.doubleClick(screen.getByRole("button", { name: "选中会话 Toggle" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  expect(screen.getByTitle("断开连接")).toBeTruthy();
  expect(screen.queryByTitle("重新连接")).toBeNull();
  expect(screen.queryByTitle("重新认证连接")).toBeNull();

  fireEvent.click(screen.getByTitle("断开连接"));
  await waitFor(() => expect(api.Disconnect).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTitle("重新连接")).toBeTruthy());
  fireEvent.click(screen.getByTitle("重新连接"));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));
  expect(screen.getByTitle("断开连接")).toBeTruthy();
});
