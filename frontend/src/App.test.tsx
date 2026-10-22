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
vi.mock("./components/TerminalPane", () => ({
  default: (props: {
    tab: { id: string };
    active: boolean;
    visible?: boolean;
    onActivate?: () => void;
  }) => (
    <div
      data-testid="terminal-pane-stub"
      data-tab-id={props.tab.id}
      data-active={props.active}
      data-visible={props.visible}
      onMouseDown={props.onActivate}
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
  desktop: false,
  api: {
    SavePreference: vi.fn(async () => {}),
    SFTPTransfers: vi.fn(async () => []),
    Connect: vi.fn(async (tabId: string, sessionId: string) => ({
      ref: { tabId, sessionId, generation: 1 },
      home: "/root",
    })),
    SaveSession: vi.fn(async (req: { session: Session }) => req.session),
    State: vi.fn(async () => ({
      sessions: [],
      groups: [],
      profiles: [],
      fontSize: "14",
      language: "zh-CN",
      activeProfile: "",
      version: "0.1.17",
    })),
  },
  listen: () => () => {},
}));
afterEach(cleanup);
test("shows workspace and collapsible AI sidebar", async () => {
  await act(async () => {
    render(<App />);
  });
  expect(screen.getAllByText("会话管理")[0]).toBeTruthy();
  expect(screen.getAllByText("SSH 终端")[0]).toBeTruthy();
  expect(screen.getByText("AI 助手")).toBeTruthy();
  fireEvent.click(screen.getByTitle("收起 AI"));
  expect(screen.queryByText("AI 助手")).toBeNull();
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
test("settings navigation separates general, terminal, AI and automatic options", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  expect(screen.getByRole("navigation", { name: "设置分类" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "通用" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "终端" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "AI 配置" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "自动执行" })).toBeTruthy();
  expect(screen.queryByText("OpenShell · 中文终端预览")).toBeNull();
  expect(screen.queryByText(/systemctl status redis/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "终端" }));
  expect(screen.getByLabelText("字体大小")).toBeTruthy();
  expect(screen.getByLabelText("快速命令栏布局")).toBeTruthy();
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
test("API settings expose custom endpoint key and model fields", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  fireEvent.click(screen.getByRole("button", { name: "AI 配置" }));
  const name = screen.getByLabelText("配置名称") as HTMLInputElement;
  const baseUrl = screen.getByLabelText("Base URL") as HTMLInputElement;
  expect(name.value).toBe("");
  expect(name.placeholder).toBe("自定义 API");
  expect(baseUrl.value).toBe("");
  expect(baseUrl.placeholder).toBe("https://api.example.com/v1");
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  expect(screen.getByRole("alert").textContent).toBe("请输入配置名称");
  fireEvent.change(name, { target: { value: "示例 API" } });
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  expect(screen.getByRole("alert").textContent).toBe("请输入 API 地址");
  expect(screen.getByLabelText("API Key")).toBeTruthy();
  expect(screen.getByLabelText("模型名称")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("OpenAI 兼容接口")).toBeTruthy());
});

test("shows the OpenShell product name", async () => {
  await act(async () => {
    render(<App />);
  });
  expect(screen.getAllByText("OpenShell").length).toBeGreaterThan(0);
  expect(screen.queryByText("轻量 SSH")).toBeNull();
});

test("renders application version on the left and SSH connection status on the right", async () => {
  await act(async () => {
    render(<App />);
  });
  const footer = document.querySelector(".workspace-status");
  expect(
    footer?.firstElementChild?.classList.contains("workspace-version"),
  ).toBe(true);
  expect(
    footer?.lastElementChild?.classList.contains("workspace-connection"),
  ).toBe(true);
  expect(footer?.textContent).toMatch(/OpenShell\s+v\d+\.\d+\.\d+/);
  expect(footer?.textContent).toContain("未连接");
});

test("terminal mouse settings are opt-in and saved independently", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  fireEvent.click(screen.getByRole("button", { name: "终端" }));
  const copy = screen.getByLabelText("选中自动复制") as HTMLInputElement;
  const paste = screen.getByLabelText("鼠标右键粘贴") as HTMLInputElement;
  const middle = screen.getByLabelText("鼠标中键粘贴") as HTMLInputElement;
  const highlight = screen.getByLabelText("持续高亮日志级别") as HTMLInputElement;
  expect(copy.checked).toBe(false);
  expect(paste.checked).toBe(false);
  expect(middle.checked).toBe(false);
  expect(highlight.checked).toBe(false);
  fireEvent.click(middle);
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
    expect(api.SavePreference).toHaveBeenCalledWith("middleClickPaste", "true");
    expect(api.SavePreference).toHaveBeenCalledWith("logHighlights", "true");
    expect(api.SavePreference).toHaveBeenCalledWith(
      "confirmMultilinePaste",
      "false",
    );
  });
});

test("automatic execution settings save bounded limit and scope", async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByTitle("设置"));
  fireEvent.click(screen.getByRole("button", { name: "自动执行" }));
  expect(
    (screen.getByLabelText("每轮命令上限") as HTMLInputElement).value,
  ).toBe("10");
  fireEvent.change(screen.getByLabelText("每轮命令上限"), {
    target: { value: "3" },
  });
  fireEvent.change(screen.getByLabelText("自动执行范围"), {
    target: { value: "all" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存自动执行设置" }));
  await waitFor(() => {
    expect(api.SavePreference).toHaveBeenCalledWith("autoCommandLimit", "3");
    expect(api.SavePreference).toHaveBeenCalledWith("autoAllowChanges", "true");
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
    profiles: [],
    fontSize: "14",
    language: "zh-CN",
    activeProfile: "",
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
    profiles: [],
    fontSize: "14",
    language: "zh-CN" as const,
    activeProfile: "",
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
    profiles: [],
    fontSize: "14",
    language: "zh-CN",
    activeProfile: "",
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
    groups: [], profiles: [], fontSize: "14", language: "zh-CN",
    activeProfile: "", version: "0.1.33",
  });
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 us" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 eu" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));
  const selector = screen.getByRole("combobox", { name: "分屏选择…" }) as HTMLSelectElement;
  const partner = Array.from(selector.options).find((item) => item.value);
  expect(partner).toBeTruthy();
  fireEvent.change(selector, { target: { value: partner!.value } });
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
    groups: [], profiles: [], fontSize: "14", language: "zh-CN",
    activeProfile: "", splitRatio: 60, version: "0.1.34",
  });
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 us" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByTitle("打开会话列表"));
  fireEvent.doubleClick(screen.getByRole("button", { name: "选择会话 eu" }));
  await waitFor(() => expect(api.Connect).toHaveBeenCalledTimes(2));
  const selector = screen.getByRole("combobox", { name: "分屏选择…" }) as HTMLSelectElement;
  fireEvent.change(selector, { target: { value: selector.options[1].value } });
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
    groups: [], profiles: [], fontSize: "14", language: "zh-CN",
    activeProfile: "", version: "0.1.39",
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
  expect(document.querySelector(".workspace-file-panel .transfer-dock")).toBeTruthy();
  expect(document.querySelector(".workspace-workarea > .transfer-dock")).toBeNull();
  expect(document.querySelector(".workspace-file-panel .transfer-dock-heading")).toBeTruthy();
  expect(screen.getByTestId("sftp-panel-stub").getAttribute("data-cwd-reported")).toBe("false");
  const terminal = document.querySelector(".terminal-container") as HTMLElement;
  expect(terminal.style.display).not.toBe("none");
  expect(screen.getAllByTestId("terminal-pane-stub")).toHaveLength(1);
  fireEvent.click(screen.getByTitle("关闭文件侧栏"));
  expect(document.querySelector(".workspace-file-panel")).toBeNull();
  expect(document.querySelector(".workspace-status-transfer")).toBeNull();
  expect(document.querySelector(".workspace-status .transfer-dock")).toBeNull();
  expect(document.querySelector(".terminal-container")).toBe(terminal);
  expect(api.Connect).toHaveBeenCalledTimes(1);
});
