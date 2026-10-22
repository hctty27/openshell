import { beforeEach as beforeLanguageTest } from "vitest";
import { initializeI18n as setTestLanguage } from "../i18n";
beforeLanguageTest(() => setTestLanguage("zh-CN"));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import TerminalPane from "./TerminalPane";
import { DialogProvider } from "./DialogProvider";
import { api } from "../bridge";
import {
  ClipboardGetText,
  ClipboardSetText,
} from "../../wailsjs/runtime/runtime";
import type { Tab } from "../types";

const refs = vi.hoisted(() => ({ terms: [] as any[], webgl: [] as any[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = { fontSize: 14, theme: {} };
    modes = { mouseTrackingMode: "none" };
    cols = 80;
    rows = 24;
    selected = "";
    onDataCallback = (_data: string) => {};
    resizeHandler = (_size: { cols: number; rows: number }) => {};
    keyHandler = (_event: KeyboardEvent) => true;
    attachCustomKeyEventHandler = vi.fn((callback: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = callback;
    });
    getSelection = () => this.selected;
    open = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    paste = vi.fn((data: string) => this.onDataCallback(data));
    loadAddon = vi.fn();
    onData = vi.fn((cb: (data: string) => void) => {
      this.onDataCallback = cb;
      return { dispose: vi.fn() };
    });
    onResize = vi.fn((cb: (size: { cols: number; rows: number }) => void) => {
      this.resizeHandler = cb;
      return { dispose: vi.fn() };
    });
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    constructor() {
      refs.terms.push(this);
    }
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn(() => true);
    findPrevious = vi.fn(() => true);
    clearDecorations = vi.fn();
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class { constructor(_handler: unknown) {} },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    lossHandler = () => {};
    onContextLoss = vi.fn((callback: () => void) => {
      this.lossHandler = callback;
      return { dispose: vi.fn() };
    });
    dispose = vi.fn();
    constructor() { refs.webgl.push(this); }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("../bridge", () => ({
  api: {
    WriteTerminal: vi.fn(async () => {}),
    ResizeTerminal: vi.fn(async () => {}),
    OpenTerminal: vi.fn(async () => {}),
    Disconnect: vi.fn(async () => {}),
  },
  listen: () => () => {},
  errorText: (value: unknown) => String(value),
}));
vi.mock("../../wailsjs/runtime/runtime", () => ({
  BrowserOpenURL: vi.fn(),
  ClipboardGetText: vi.fn(async () => "echo hello"),
  ClipboardSetText: vi.fn(async () => true),
}));

const tab: Tab = {
  id: "tab-1",
  session: {
    id: "ssh-1",
    groupId: "",
    name: "test",
    host: "localhost",
    port: 22,
    username: "root",
    authType: "key",
    privateKeyPath: "",
    credentialRef: "",
  },
  ref: { tabId: "tab-1", sessionId: "ssh-1", generation: 1 },
  status: "connected",
  home: "/root",
  cwd: "/root",
  messages: [],
  proposal: null,
  chatBusy: false,
  executing: false,
  error: "",
};
const renderTerminal = (
  options: Partial<Parameters<typeof TerminalPane>[0]> = {},
) =>
  render(
    <DialogProvider>
      <TerminalPane
        tab={tab}
        active
        fontSize={14}
        theme="dark"
        autoCopySelection
        rightClickPaste
        confirmMultilinePaste
        onNotice={vi.fn()}
        onError={vi.fn()}
        onSelection={vi.fn()}
        {...options}
      />
    </DialogProvider>,
  );

beforeEach(() => {
  refs.terms.length = 0;
  refs.webgl.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("copies selected text on left mouse release, but not when disabled", async () => {
  const { container, rerender } = renderTerminal();
  const pane = container.querySelector(".terminal-pane")!;
  refs.terms[0].selected = "root@server:~";
  fireEvent.mouseDown(pane, { button: 0 });
  fireEvent.mouseUp(document, { button: 0 });
  await waitFor(() =>
    expect(ClipboardSetText).toHaveBeenCalledWith("root@server:~"),
  );
  vi.mocked(ClipboardSetText).mockClear();
  rerender(
    <DialogProvider>
      <TerminalPane
        tab={tab}
        active
        fontSize={14}
        theme="dark"
        autoCopySelection={false}
        rightClickPaste
        confirmMultilinePaste
        onNotice={vi.fn()}
        onError={vi.fn()}
        onSelection={vi.fn()}
      />
    </DialogProvider>,
  );
  fireEvent.mouseDown(pane, { button: 0 });
  fireEvent.mouseUp(document, { button: 0 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  expect(ClipboardSetText).not.toHaveBeenCalled();
});

test("right click pastes via terminal input, multi-line paste requires confirmation", async () => {
  const { container } = renderTerminal();
  const pane = container.querySelector(".terminal-pane")!;
  fireEvent.contextMenu(pane);
  await waitFor(() =>
    expect(refs.terms[0].paste).toHaveBeenCalledWith("echo hello"),
  );
  expect(api.WriteTerminal).toHaveBeenCalled();
  vi.mocked(ClipboardGetText).mockResolvedValueOnce("pwd\nrm -rf example");
  fireEvent.contextMenu(pane);
  expect(
    await screen.findByRole("dialog", { name: "确认粘贴多行命令" }),
  ).toBeTruthy();
  expect(screen.getByText(/pwd/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(refs.terms[0].paste).toHaveBeenCalledTimes(1);
});

test("mouse reporting in interactive applications is not overridden", async () => {
  const { container } = renderTerminal();
  refs.terms[0].modes.mouseTrackingMode = "vt200";
  fireEvent.contextMenu(container.querySelector(".terminal-pane")!);
  expect(ClipboardGetText).not.toHaveBeenCalled();
});

test("multiline confirmation only pastes to the original connected tab", async () => {
  vi.mocked(ClipboardGetText).mockResolvedValueOnce("pwd\nwhoami");
  const { container, rerender } = renderTerminal();
  fireEvent.contextMenu(container.querySelector(".terminal-pane")!);
  expect(
    await screen.findByRole("dialog", { name: "确认粘贴多行命令" }),
  ).toBeTruthy();
  rerender(
    <DialogProvider>
      <TerminalPane
        tab={tab}
        active={false}
        fontSize={14}
        theme="dark"
        autoCopySelection
        rightClickPaste
        confirmMultilinePaste
        onNotice={vi.fn()}
        onError={vi.fn()}
        onSelection={vi.fn()}
      />
    </DialogProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "确认粘贴" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(refs.terms[0].paste).not.toHaveBeenCalled();
});

test("search shortcut opens localized terminal search and closes with Escape", async () => {
  const { rerender } = renderTerminal({ searchFocusVersion: 0 });
  const keyEvent = {
    type: "keydown",
    key: "f",
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
  expect(refs.terms[0].keyHandler(keyEvent)).toBe(false);
  expect(keyEvent.preventDefault).toHaveBeenCalled();
  const field = await screen.findByRole("textbox", { name: "搜索终端内容" });
  fireEvent.change(field, { target: { value: "hello" } });
  fireEvent.keyDown(field, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "搜索终端内容" })).toBeNull());
  rerender(
    <DialogProvider>
      <TerminalPane
        tab={tab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        searchFocusVersion={1}
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()}
      />
    </DialogProvider>,
  );
  expect(await screen.findByRole("textbox", { name: "搜索终端内容" })).toBeTruthy();
});

test("keyboard clipboard shortcuts preserve normal Ctrl+C and ordered writes", async () => {
  renderTerminal();
  const terminal = refs.terms[0];
  const key = (letter: string, shiftKey: boolean) => ({
    type: "keydown", key: letter, ctrlKey: true, shiftKey,
    altKey: false, metaKey: false, preventDefault: vi.fn(),
  }) as unknown as KeyboardEvent;
  expect(terminal.keyHandler(key("c", false))).toBe(true);
  terminal.selected = "selected output";
  expect(terminal.keyHandler(key("c", true))).toBe(false);
  await waitFor(() => expect(ClipboardSetText).toHaveBeenCalledWith("selected output"));
  terminal.onDataCallback("first");
  terminal.onDataCallback("second");
  await waitFor(() => expect(api.WriteTerminal).toHaveBeenCalled());
  expect(api.WriteTerminal).toHaveBeenCalledWith(tab.ref, btoa("firstsecond"));
});

test("only the active tab uses a WebGL context and context loss falls back", () => {
  const { rerender } = renderTerminal();
  expect(refs.webgl).toHaveLength(1);
  const first = refs.webgl[0];
  rerender(
    <DialogProvider>
      <TerminalPane tab={tab} active={false} fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>,
  );
  expect(first.dispose).toHaveBeenCalledTimes(1);
  rerender(
    <DialogProvider>
      <TerminalPane tab={tab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>,
  );
  expect(refs.webgl).toHaveLength(2);
  const current = refs.webgl[1];
  current.lossHandler();
  expect(current.dispose).toHaveBeenCalledTimes(1);
  rerender(
    <DialogProvider>
      <TerminalPane tab={tab} active={false} fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>,
  );
  rerender(
    <DialogProvider>
      <TerminalPane tab={tab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>,
  );
  expect(refs.webgl).toHaveLength(2);
});

test("right click in terminal search does not paste into shell", async () => {
  renderTerminal();
  const keyEvent = {
    type: "keydown", key: "f", ctrlKey: true, shiftKey: true,
    altKey: false, metaKey: false, preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
  refs.terms[0].keyHandler(keyEvent);
  const field = await screen.findByRole("textbox", { name: "搜索终端内容" });
  fireEvent.contextMenu(field);
  expect(ClipboardGetText).not.toHaveBeenCalled();
});

test("repeated resize notifications do not duplicate SSH window changes", async () => {
  renderTerminal();
  const term = refs.terms[0];
  await waitFor(() => expect(api.OpenTerminal).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  vi.mocked(api.ResizeTerminal).mockClear();
  term.cols = 100;
  term.rows = 35;
  act(() => {
    term.resizeHandler({ cols: 100, rows: 35 });
    term.resizeHandler({ cols: 100, rows: 35 });
  });
  expect(api.ResizeTerminal).toHaveBeenCalledTimes(1);
  expect(api.ResizeTerminal).toHaveBeenCalledWith(tab.ref, 100, 35);
});
