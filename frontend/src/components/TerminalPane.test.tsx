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
import { useState } from "react";
import TerminalPane from "./TerminalPane";
import { DialogProvider } from "./DialogProvider";
import { api } from "../bridge";
import { Browser, Clipboard } from "@wailsio/runtime";
import type { Tab } from "../types";
import { terminalThemes } from "../terminalThemes";

const refs = vi.hoisted(() => ({
  terms: [] as any[],
  webgl: [] as any[],
  searches: [] as any[],
  links: [] as Array<(event: MouseEvent, url: string) => void>,
}));
const events = vi.hoisted(() => ({ listeners: new Map<string, (payload: any) => void>() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = { fontSize: 14, theme: {} };
    modes = { mouseTrackingMode: "none" };
    cols = 80;
    rows = 24;
    element = document.createElement("div");
    dimensions = { css: { cell: { width: 9, height: 18 } } };
    parser = {
      handlers: new Map<number, (payload: string) => boolean>(),
      registerOscHandler: vi.fn((id: number, cb: (payload: string) => boolean) => {
        this.parser.handlers.set(id, cb);
        return { dispose: vi.fn(() => this.parser.handlers.delete(id)) };
      }),
    };
    bufferChangeHandler = (_buffer: {type: "normal" | "alternate"}) => {};
    buffer = {
      active: { viewportY: 4, type: "normal" as "normal" | "alternate", getLine: vi.fn(() => undefined) },
      onBufferChange: vi.fn((callback: (buffer: {type: "normal" | "alternate"}) => void) => {
        this.bufferChangeHandler = callback;
        return { dispose: vi.fn() };
      }),
    };
    scrollToLine = vi.fn();
    clearSelection = vi.fn();
    selected = "";
    onDataCallback = (_data: string) => {};
    resizeHandler = (_size: { cols: number; rows: number }) => {};
    keyHandler = (_event: KeyboardEvent) => true;
    attachCustomKeyEventHandler = vi.fn((callback: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = callback;
    });
    getSelection = () => this.selected;
    open = vi.fn((host: HTMLElement) => { this.element.className = "xterm"; host.appendChild(this.element); });
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
      this.resizeHandler({ cols, rows });
    });
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
    constructor(options: Record<string, unknown> = {}) {
      Object.assign(this.options, options);
      refs.terms.push(this);
    }
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn(() => true);
    findPrevious = vi.fn(() => true);
    clearDecorations = vi.fn();
    clearActiveDecoration = vi.fn();
    dispose = vi.fn();
    constructor() { refs.searches.push(this); }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, url: string) => void) {
      refs.links.push(handler);
    }
  },
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
vi.mock("../bridge", () => ({
  api: {
    WriteTerminal: vi.fn(async () => {}),
    AcknowledgeTerminalOutput: vi.fn(async () => {}),
    AcknowledgeLocalTerminalOutput: vi.fn(async () => {}),
    ResizeTerminal: vi.fn(async () => {}),
    OpenTerminal: vi.fn(async () => {}),
    StartLocalTerminal: vi.fn(async () => {}),
    WriteLocalTerminal: vi.fn(async () => {}),
    ResizeLocalTerminal: vi.fn(async () => {}),
    CloseLocalTerminal: vi.fn(async () => {}),
    Disconnect: vi.fn(async () => {}),
    CancelZmodem: vi.fn(async () => {}),
  },
  listen: (name: string, callback: (payload: any) => void) => {
    events.listeners.set(name, callback);
    return () => { events.listeners.delete(name); };
  },
  errorText: (value: unknown) => String(value),
}));
vi.mock("@wailsio/runtime", () => ({
  Browser: { OpenURL: vi.fn(async () => {}) },
  Clipboard: {
    Text: vi.fn(async () => "echo hello"),
    SetText: vi.fn(async () => {}),
  },
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
  
  
  
  
  error: "",
};
type TerminalPaneProps = Parameters<typeof TerminalPane>[0];
type TestTerminalPaneProps = Omit<TerminalPaneProps, "searchOpen" | "onSearchOpenChange"> &
  Partial<Pick<TerminalPaneProps, "searchOpen" | "onSearchOpenChange">>;

function TestTerminalPane(props: TestTerminalPaneProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <TerminalPane
      {...props}
      searchOpen={props.searchOpen ?? searchOpen}
      onSearchOpenChange={props.onSearchOpenChange ?? setSearchOpen}
    />
  );
}

const renderTerminal = (
  options: Partial<Parameters<typeof TerminalPane>[0]> = {},
) =>
  render(
    <DialogProvider>
      <TestTerminalPane
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
  refs.searches.length = 0;
  refs.links.length = 0;
  events.listeners.clear();
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
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
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
    expect(Clipboard.SetText).toHaveBeenCalledWith("root@server:~"),
  );
  vi.mocked(Clipboard.SetText).mockClear();
  rerender(
    <DialogProvider>
      <TestTerminalPane
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
  expect(Clipboard.SetText).not.toHaveBeenCalled();
});

test("right click pastes via terminal input, multi-line paste requires confirmation", async () => {
  const { container } = renderTerminal();
  const pane = container.querySelector(".terminal-pane")!;
  fireEvent.contextMenu(pane);
  await waitFor(() =>
    expect(refs.terms[0].paste).toHaveBeenCalledWith("echo hello"),
  );
  expect(api.WriteTerminal).toHaveBeenCalled();
  vi.mocked(Clipboard.Text).mockResolvedValueOnce("pwd\nrm -rf example");
  fireEvent.contextMenu(pane);
  expect(
    await screen.findByRole("dialog", { name: "确认粘贴多行命令" }),
  ).toBeTruthy();
  expect(screen.getByText(/pwd/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(refs.terms[0].paste).toHaveBeenCalledTimes(1);
});

test("clipboard writes report Wails v3 failures without expecting a boolean result", async () => {
  vi.mocked(Clipboard.SetText).mockRejectedValueOnce(new Error("clipboard unavailable"));
  const onNotice = vi.fn();
  const { container } = renderTerminal({ onNotice });
  refs.terms[0].selected = "text to copy";
  const pane = container.querySelector(".terminal-pane")!;
  fireEvent.mouseDown(pane, { button: 0 });
  fireEvent.mouseUp(document, { button: 0 });

  await waitFor(() => expect(Clipboard.SetText).toHaveBeenCalledWith("text to copy"));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
    expect.objectContaining({ message: "clipboard unavailable" }),
  ));
});

test("clipboard read failures report an error and never paste", async () => {
  vi.mocked(Clipboard.Text).mockRejectedValueOnce(new Error("clipboard read failed"));
  const onNotice = vi.fn();
  const { container } = renderTerminal({ onNotice });

  fireEvent.contextMenu(container.querySelector(".terminal-pane")!);
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
    expect.objectContaining({ message: "clipboard read failed" }),
  ));
  expect(refs.terms[0].paste).not.toHaveBeenCalled();
});

test("Ctrl+Shift+V uses Wails v3 clipboard and preserves terminal input", async () => {
  renderTerminal();
  const keyEvent = {
    type: "keydown", key: "v", ctrlKey: true, shiftKey: true,
    altKey: false, metaKey: false, preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;

  expect(refs.terms[0].keyHandler(keyEvent)).toBe(false);
  expect(keyEvent.preventDefault).toHaveBeenCalled();
  await waitFor(() => expect(Clipboard.Text).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(refs.terms[0].paste).toHaveBeenCalledWith("echo hello"));
  expect(api.WriteTerminal).toHaveBeenCalled();
});

test("external HTTP links use the Wails v3 browser runtime", async () => {
  renderTerminal();
  expect(refs.links).toHaveLength(1);
  refs.links[0](new MouseEvent("click"), "https://example.com");
  await waitFor(() => expect(Browser.OpenURL).toHaveBeenCalledWith("https://example.com"));
  refs.links[0](new MouseEvent("click"), "file:///secret");
  expect(Browser.OpenURL).toHaveBeenCalledTimes(1);
});

test("TUI mouse handling is preserved when right-click paste is disabled", () => {
  const { container } = renderTerminal({ rightClickPaste: false });
  refs.terms[0].modes.mouseTrackingMode = "vt200";
  const pane = container.querySelector(".terminal-pane")!;

  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
  expect(pane.dispatchEvent(down)).toBe(true);
  fireEvent.contextMenu(pane);
  expect(Clipboard.Text).not.toHaveBeenCalled();
});

test("xterm 6.1 selects and copies in TUIs by default, Alt enables app mouse control", async () => {
  const { container } = renderTerminal();
  const pane = container.querySelector(".terminal-pane")!;
  const term = refs.terms[0];
  expect(term.options.mouseEventsRequireAlt).toBe(true);
  expect(term.options.scrollbar).toEqual({ width: 8 });
  term.modes.mouseTrackingMode = "vt200";
  term.selected = "selected TUI output";

  fireEvent.mouseDown(pane, { button: 0, altKey: true });
  fireEvent.mouseUp(document, { button: 0 });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  expect(Clipboard.SetText).not.toHaveBeenCalled();

  fireEvent.mouseDown(pane, { button: 0 });
  fireEvent.mouseUp(document, { button: 0 });
  await waitFor(() => expect(Clipboard.SetText).toHaveBeenCalledWith("selected TUI output"));
  vi.mocked(Clipboard.SetText).mockClear();

  fireEvent.mouseDown(pane, { button: 0, shiftKey: true });
  fireEvent.mouseUp(document, { button: 0 });
  await waitFor(() => expect(Clipboard.SetText).toHaveBeenCalledWith("selected TUI output"));
});

test("right-click paste overrides TUI mouse capture when enabled", async () => {
  const { container } = renderTerminal();
  const pane = container.querySelector(".terminal-pane")!;
  refs.terms[0].modes.mouseTrackingMode = "vt200";

  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
  expect(pane.dispatchEvent(down)).toBe(false);
  const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 2 });
  expect(pane.dispatchEvent(up)).toBe(false);

  fireEvent.contextMenu(pane);
  await waitFor(() => expect(refs.terms[0].paste).toHaveBeenCalledWith("echo hello"));
  expect(api.WriteTerminal).toHaveBeenCalled();
});

test("Alt+right mouse remains available to TUIs and does not paste", () => {
  const { container } = renderTerminal();
  const pane = container.querySelector(".terminal-pane")!;
  refs.terms[0].modes.mouseTrackingMode = "vt200";

  const down = new MouseEvent("mousedown", {
    bubbles: true, cancelable: true, button: 2, altKey: true,
  });
  expect(pane.dispatchEvent(down)).toBe(true);
  const up = new MouseEvent("mouseup", {
    bubbles: true, cancelable: true, button: 2, altKey: true,
  });
  expect(pane.dispatchEvent(up)).toBe(true);
  fireEvent.contextMenu(pane, { altKey: true });
  expect(Clipboard.Text).not.toHaveBeenCalled();
});

test("multiline confirmation restores terminal focus before and after paste", async () => {
  vi.mocked(Clipboard.Text).mockResolvedValueOnce("first\nsecond");
  const { container } = renderTerminal();
  const term = refs.terms[0];
  fireEvent.contextMenu(container.querySelector(".terminal-pane")!);
  expect(await screen.findByRole("dialog", { name: "确认粘贴多行命令" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "确认粘贴" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(term.paste).toHaveBeenCalledWith("first\nsecond"));
  expect(term.focus.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
    term.paste.mock.invocationCallOrder[0],
  );
  expect(api.WriteTerminal).toHaveBeenCalled();
});

test("multiline confirmation only pastes to the original connected tab", async () => {
  vi.mocked(Clipboard.Text).mockResolvedValueOnce("pwd\nwhoami");
  const { container, rerender } = renderTerminal();
  fireEvent.contextMenu(container.querySelector(".terminal-pane")!);
  expect(
    await screen.findByRole("dialog", { name: "确认粘贴多行命令" }),
  ).toBeTruthy();
  rerender(
    <DialogProvider>
      <TestTerminalPane
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
  const { rerender } = renderTerminal();
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
      <TestTerminalPane
        tab={tab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        searchOpen
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
  await waitFor(() => expect(Clipboard.SetText).toHaveBeenCalledWith("selected output"));
  terminal.onDataCallback("first");
  terminal.onDataCallback("second");
  await waitFor(() => expect(api.WriteTerminal).toHaveBeenCalled());
  expect(api.WriteTerminal).toHaveBeenCalledWith(tab.ref, btoa("firstsecond"));
});

test("short tab switches retain the WebGL renderer and context loss falls back", () => {
  const { rerender } = renderTerminal();
  expect(refs.webgl).toHaveLength(1);
  const first = refs.webgl[0];
  const pane = (active: boolean) => (
    <DialogProvider>
      <TestTerminalPane tab={tab} active={active} fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>
  );
  rerender(pane(false));
  expect(first.dispose).not.toHaveBeenCalled();
  rerender(pane(true));
  expect(refs.webgl).toHaveLength(1);
  first.lossHandler();
  expect(first.dispose).toHaveBeenCalledTimes(1);
  rerender(pane(false));
  rerender(pane(true));
  expect(refs.webgl).toHaveLength(1);
});

test("terminal output is never dropped and acknowledged only after parsing", async () => {
  renderTerminal();
  const terminal = refs.terms[0];
  const receive = events.listeners.get("ssh:output");
  expect(receive).toBeDefined();
  const encoded = btoa("x".repeat(32 * 1024));
  act(() => {
    for (let sequence = 1; sequence <= 70; sequence++) {
      receive!({ ref: tab.ref, sequence, data: encoded });
    }
  });
  expect(terminal.write).toHaveBeenCalledTimes(70);
  expect(api.AcknowledgeTerminalOutput).not.toHaveBeenCalled();
  await act(async () => {
    for (const [, callback] of terminal.write.mock.calls) callback?.();
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(api.AcknowledgeTerminalOutput).toHaveBeenCalledWith(tab.ref, 70),
  );
});

test("full-screen TUI colors cover remainder pixels and reset after exit", () => {
  const { container } = renderTerminal();
  const term = refs.terms[0];
  const surface = container.querySelector(".terminal-surface") as HTMLElement;
  const cell = {
    isBgDefault: () => false,
    isBgRGB: () => false,
    isBgPalette: () => true,
    getBgColorMode: () => 1,
    getBgColor: () => 4,
  };
  term.buffer.active.getLine.mockImplementation(() => ({ getCell: () => cell }));
  const receive = events.listeners.get("ssh:output")!;
  act(() => {
    receive({ ref: tab.ref, sequence: 1, data: btoa("dialog") });
    term.write.mock.lastCall?.[1]?.();
  });
  expect(surface.style.getPropertyValue("--terminal-edge-background")).toBe(terminalThemes.dark.blue);

  term.buffer.active.getLine.mockReturnValue(undefined);
  act(() => {
    receive({ ref: tab.ref, sequence: 2, data: btoa("shell") });
    term.write.mock.lastCall?.[1]?.();
  });
  expect(surface.style.getPropertyValue("--terminal-edge-background")).toBe("");
});

test("hidden terminals defer edge color updates until they become visible", () => {
  const { container, rerender } = renderTerminal({ active: false, visible: false });
  const term = refs.terms[0];
  const surface = container.querySelector(".terminal-surface") as HTMLElement;
  const cell = {
    isBgDefault: () => false,
    isBgRGB: () => false,
    isBgPalette: () => true,
    getBgColorMode: () => 1,
    getBgColor: () => 4,
  };
  term.buffer.active.getLine.mockImplementation(() => ({ getCell: () => cell }));
  const receive = events.listeners.get("ssh:output")!;

  act(() => {
    receive({ ref: tab.ref, sequence: 1, data: btoa("hidden output") });
    term.write.mock.lastCall?.[1]?.();
  });
  expect(surface.style.getPropertyValue("--terminal-edge-background")).toBe("");

  rerender(
    <DialogProvider>
      <TestTerminalPane tab={tab} active visible fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>,
  );
  expect(surface.style.getPropertyValue("--terminal-edge-background")).toBe(terminalThemes.dark.blue);
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
  expect(Clipboard.Text).not.toHaveBeenCalled();
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

test("split-visible terminal activates on mouse click without creating a second terminal", () => {
  const onActivate = vi.fn();
  const { container, rerender } = renderTerminal({
    active: false,
    visible: true,
    onActivate,
  });
  const pane = container.querySelector(".terminal-pane")!;
  expect(pane.classList.contains("visible")).toBe(true);
  expect(pane.classList.contains("active")).toBe(false);
  fireEvent.mouseDown(pane, { button: 0 });
  expect(onActivate).toHaveBeenCalledTimes(1);
  rerender(
    <DialogProvider>
      <TestTerminalPane tab={tab} active visible onActivate={onActivate}
        fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>,
  );
  expect(refs.terms).toHaveLength(1);
  expect(pane.classList.contains("active")).toBe(true);
});

test("switching focus between visible split panes keeps the renderer and terminal geometry", () => {
  const onActivate = vi.fn();
  const renderPane = (active: boolean) => (
    <DialogProvider>
      <TestTerminalPane tab={tab} active={active} visible onActivate={onActivate}
        fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>
  );
  const { rerender } = render(renderPane(false));
  expect(refs.webgl).toHaveLength(1);
  const originalRenderer = refs.webgl[0];
  refs.terms[0].resize.mockClear();

  rerender(renderPane(true));
  rerender(renderPane(false));
  rerender(renderPane(true));

  expect(refs.terms).toHaveLength(1);
  expect(refs.webgl).toHaveLength(1);
  expect(originalRenderer.dispose).not.toHaveBeenCalled();
  expect(refs.terms[0].resize).not.toHaveBeenCalled();
});

test("resize observer centers and resizes only when a visible pane changes size", () => {
  let notifyResize: ResizeObserverCallback = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { notifyResize = callback; }
    observe() {}
    disconnect() {}
  });
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  try {
    renderTerminal({ visible: true });
    const term = refs.terms[0];
    term.resize.mockClear();
    act(() => {
      notifyResize([], {} as ResizeObserver);
      notifyResize([], {} as ResizeObserver);
    });
    expect(term.resize).not.toHaveBeenCalled();

    width.mockReturnValue(640);
    act(() => { notifyResize([], {} as ResizeObserver); });
    expect(term.resize).toHaveBeenCalledTimes(1);
    expect(term.resize).toHaveBeenLastCalledWith(68, 26);
    const x = parseFloat(term.element.style.paddingLeft);
    const y = parseFloat(term.element.style.paddingTop);
    expect(x).toBeGreaterThanOrEqual(8);
    expect(y).toBeGreaterThanOrEqual(8);

    act(() => { notifyResize([], {} as ResizeObserver); });
    expect(term.resize).toHaveBeenCalledTimes(1);
  } finally {
    width.mockRestore();
    height.mockRestore();
  }
});

test("log preset highlights severity keywords through regex search decorations", async () => {
  renderTerminal();
  const keyEvent = {
    type: "keydown", key: "f", ctrlKey: true, shiftKey: true,
    altKey: false, metaKey: false, preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
  refs.terms[0].keyHandler(keyEvent);
  const logs = await screen.findByRole("button", { name: "高亮日志级别关键词" });
  fireEvent.click(logs);
  expect(screen.getByRole("textbox", { name: "搜索终端内容" })).toHaveProperty(
    "value", "ERROR|WARN(?:ING)?|FATAL|FAIL(?:ED)?",
  );
  expect(refs.searches[0].findNext).toHaveBeenCalledWith(
    "ERROR|WARN(?:ING)?|FATAL|FAIL(?:ED)?",
    expect.objectContaining({
      regex: true,
      decorations: expect.objectContaining({ matchOverviewRuler: "#d59d54" }),
    }),
  );
});


test("live severity highlighting survives closing manual search and updates independently", async () => {
  const { rerender } = renderTerminal({ logHighlights: true });
  expect(refs.searches).toHaveLength(3);
  const [manual, errors, warnings] = refs.searches;
  expect(errors.findNext).toHaveBeenCalledWith(
    expect.stringContaining("ERROR"),
    expect.objectContaining({ regex: true, caseSensitive: false }),
  );
  expect(warnings.findNext).toHaveBeenCalledWith(
    expect.stringContaining("WARN"),
    expect.objectContaining({ regex: true }),
  );
  expect(refs.terms[0].scrollToLine).toHaveBeenCalledWith(4);
  const shortcut = { type: "keydown", key: "f", ctrlKey: true, shiftKey: true,
    altKey: false, metaKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
  refs.terms[0].keyHandler(shortcut);
  fireEvent.click(await screen.findByRole("button", { name: "关闭搜索" }));
  expect(manual.clearDecorations).toHaveBeenCalled();
  expect(errors.clearDecorations).not.toHaveBeenCalled();
  expect(warnings.clearDecorations).not.toHaveBeenCalled();
  rerender(
    <DialogProvider>
      <TestTerminalPane tab={tab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste logHighlights={false}
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>,
  );
  expect(errors.dispose).toHaveBeenCalled();
  expect(warnings.dispose).toHaveBeenCalled();
  expect(refs.terms).toHaveLength(1);
});

test("middle click does not paste clipboard content", () => {
  const { container } = renderTerminal();
  const pane = container.querySelector(".terminal-pane")!;
  fireEvent.mouseDown(pane, { button: 1 });
  expect(refs.terms[0].paste).not.toHaveBeenCalled();
});



test("OSC directory reports identify current SSH connection and update cwd", () => {
  const onDirectoryChange = vi.fn();
  renderTerminal({ onDirectoryChange });
  const term = refs.terms[0];
  expect(term.parser.handlers.get(7)("file://server/data/test%20dir")).toBe(true);
  expect(onDirectoryChange).toHaveBeenCalledWith(tab.ref, "/data/test dir");
  expect(term.parser.handlers.get(1337)("CurrentDir=/root")).toBe(true);
  expect(onDirectoryChange).toHaveBeenCalledWith(tab.ref, "/root");
  expect(term.parser.handlers.get(7)("https://other/path")).toBe(false);
  expect(term.parser.handlers.get(0)("root@server:/data/hc")).toBe(false);
  expect(onDirectoryChange).toHaveBeenCalledWith(tab.ref, "/data/hc");
  expect(term.parser.handlers.get(2)("root@server:~/logs")).toBe(false);
  expect(onDirectoryChange).toHaveBeenCalledWith(tab.ref, "/root/logs");
  expect(term.parser.handlers.get(0)("vim")).toBe(false);
  expect(onDirectoryChange).toHaveBeenCalledTimes(4);
});

test("disconnected SSH session uses local ConPTY and does not route input to SSH", async () => {
  const disconnected: Tab = { ...tab, status: "disconnected", everConnected: true };
  const renderFallback = (current: Tab) => (
    <DialogProvider>
      <TestTerminalPane tab={current} active fontSize={14} theme="dark"
        disconnectBehavior="local" localShell="powershell" preserveHistory
        autoCopySelection={false} rightClickPaste={false} confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />
    </DialogProvider>
  );
  const { rerender, unmount } = render(renderFallback(tab));
  await waitFor(() => expect(api.OpenTerminal).toHaveBeenCalled());
  rerender(renderFallback(disconnected));
  await waitFor(() => expect(api.StartLocalTerminal).toHaveBeenCalledWith(
    "tab-1", expect.any(String), "powershell", 80, 24,
  ));
  vi.mocked(api.WriteTerminal).mockClear();
  refs.terms.at(-1).onDataCallback("dir\\r");
  await waitFor(() => expect(api.WriteLocalTerminal).toHaveBeenCalled());
  expect(api.WriteTerminal).not.toHaveBeenCalled();
  unmount();
  expect(api.CloseLocalTerminal).toHaveBeenCalled();
});

test("disconnected SSH session in retain mode does not start local shell", async () => {
  const disconnected: Tab = { ...tab, status: "disconnected", everConnected: true };
  renderTerminal({ tab: disconnected, disconnectBehavior: "retain" });
  expect(api.StartLocalTerminal).not.toHaveBeenCalled();
});

test("waits for completed SSH shutdown before starting local ConPTY", async () => {
  const switching: Tab = {
    ...tab, status: "disconnected", everConnected: true,
    manualDisconnected: true, localFallbackPending: true,
  };
  const props = {
    active: true, fontSize: 14, theme: "dark" as const,
    disconnectBehavior: "local" as const, localShell: "powershell" as const,
    autoCopySelection: false, rightClickPaste: false, confirmMultilinePaste: true,
    onNotice: vi.fn(), onError: vi.fn(), onSelection: vi.fn(),
  };
  const { rerender } = render(
    <DialogProvider><TestTerminalPane tab={switching} {...props} /></DialogProvider>,
  );
  expect(api.StartLocalTerminal).not.toHaveBeenCalled();
  rerender(
    <DialogProvider>
      <TestTerminalPane tab={{ ...switching, localFallbackPending: false }} {...props} />
    </DialogProvider>,
  );
  await waitFor(() => expect(api.StartLocalTerminal).toHaveBeenCalledTimes(1));
});


test("expected local PTY cancellation during reconnect is not reported as an error", async () => {
  vi.mocked(api.StartLocalTerminal).mockRejectedValueOnce(new Error("terminal connection changed"));
  const onNotice = vi.fn();
  renderTerminal({
    tab: { ...tab, status: "disconnected", everConnected: true },
    onNotice,
  });
  await waitFor(() => expect(api.StartLocalTerminal).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  expect(onNotice).not.toHaveBeenCalled();
  expect(refs.terms[0].write).toHaveBeenCalledTimes(1);
});

test("history restoration strips unused screen padding without removing blank lines between output", () => {
  const onNotice = vi.fn();
  const onError = vi.fn();
  const pane = (nextTab: Tab) => (
    <DialogProvider>
      <TestTerminalPane tab={nextTab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={onNotice} onError={onError} onSelection={vi.fn()} />
    </DialogProvider>
  );
  const { rerender } = render(pane(tab));
  const lines = ["", "", "command output", "", "last prompt", "", "", ""];
  refs.terms[0].buffer.normal = {
    length: lines.length,
    getLine: (index: number) => ({
      translateToString: () => lines[index],
    }),
  };
  rerender(pane({ ...tab, status: "reconnecting", everConnected: true }));
  rerender(pane({
    ...tab,
    ref: { ...tab.ref!, generation: 2 },
    status: "connected",
    everConnected: true,
  }));
  expect(refs.terms).toHaveLength(2);
  expect(refs.terms[1].write).toHaveBeenCalledWith(
    "command output\r\n\r\nlast prompt\r\n",
  );
});

test("late SSH open failure from a disposed pane does not break a new connection", async () => {
  let rejectOpen: (error: Error) => void = () => {};
  vi.mocked(api.OpenTerminal).mockImplementationOnce(() => new Promise<void>((_, reject) => {
    rejectOpen = reject;
  }));
  const onError = vi.fn();
  const pane = (nextTab: Tab) => (
    <DialogProvider>
      <TestTerminalPane tab={nextTab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={onError} onSelection={vi.fn()} />
    </DialogProvider>
  );
  const { rerender } = render(pane(tab));
  await waitFor(() => expect(api.OpenTerminal).toHaveBeenCalledTimes(1));
  rerender(pane({ ...tab, status: "reconnecting", everConnected: true }));
  await act(async () => {
    rejectOpen(new Error("stale connection"));
    await Promise.resolve();
  });
  expect(onError).not.toHaveBeenCalled();
});

test("local terminal returns output credits after xterm parses and ignores stale PTYs", async () => {
  renderTerminal({
    tab: { ...tab, status: "disconnected", everConnected: true },
    disconnectBehavior: "local",
    showDisconnectReason: false,
  });
  await waitFor(() => expect(api.StartLocalTerminal).toHaveBeenCalled());
  const localID = vi.mocked(api.StartLocalTerminal).mock.calls[0][1];
  const receive = events.listeners.get("local:output");
  expect(receive).toBeDefined();
  const term = refs.terms[0];

  act(() => {
    receive!({ tabId: tab.id, terminalId: "expired", sequence: 1, data: btoa("stale") });
    receive!({ tabId: tab.id, terminalId: localID, sequence: 1, data: btoa("first") });
    receive!({ tabId: tab.id, terminalId: localID, sequence: 2, data: btoa("second") });
  });
  expect(term.write).toHaveBeenCalledTimes(2);
  expect(api.AcknowledgeLocalTerminalOutput).not.toHaveBeenCalled();
  await act(async () => {
    for (const [, parsed] of term.write.mock.calls) parsed?.();
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(api.AcknowledgeLocalTerminalOutput).toHaveBeenCalledWith(tab.id, localID, 2),
  );
  expect(api.AcknowledgeTerminalOutput).not.toHaveBeenCalled();
});


test("transfer focus restoration is scoped to the active connection and respects focused controls", () => {
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const pane = (request?: { ref: NonNullable<Tab["ref"]> }, active = true) => (
    <DialogProvider>
      <TestTerminalPane tab={tab} active={active} fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} transferFocusRequest={request} />
    </DialogProvider>
  );
  const { rerender } = render(pane());
  const terminal = refs.terms[0];
  terminal.focus.mockClear();

  rerender(pane({ ref: { ...tab.ref!, generation: 2 } }));
  expect(terminal.focus).not.toHaveBeenCalled();

  rerender(pane({ ref: tab.ref! }));
  expect(terminal.focus).toHaveBeenCalledTimes(1);
  terminal.focus.mockClear();

  const external = document.createElement("button");
  document.body.append(external);
  external.focus();
  rerender(pane({ ref: tab.ref! }));
  expect(terminal.focus).not.toHaveBeenCalled();

  external.remove();
  hasFocus.mockReturnValue(false);
  rerender(pane({ ref: tab.ref! }));
  expect(terminal.focus).not.toHaveBeenCalled();

  hasFocus.mockReturnValue(true);
  rerender(pane({ ref: tab.ref! }, false));
  expect(terminal.focus).not.toHaveBeenCalled();
  hasFocus.mockRestore();
});

test("transfer completion does not focus a terminal behind a modal dialog", () => {
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const pane = (request?: { ref: NonNullable<Tab["ref"]> }) => (
    <DialogProvider>
      <TestTerminalPane tab={tab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()} transferFocusRequest={request} />
    </DialogProvider>
  );
  const { rerender } = render(pane());
  const terminal = refs.terms[0];
  terminal.focus.mockClear();

  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  rerender(pane({ ref: tab.ref! }));
  expect(terminal.focus).not.toHaveBeenCalled();

  dialog.remove();
  rerender(pane({ ref: tab.ref! }));
  expect(terminal.focus).toHaveBeenCalledTimes(1);
  hasFocus.mockRestore();
});

test("AI takeover disables manual typing until user reclaims the terminal", async () => {
  const onTakeControl = vi.fn();
  const { rerender } = renderTerminal({ aiControlled: true, onTakeControl });
  expect(screen.getByRole("status").textContent).toContain("AI 正在操作");
  refs.terms[0].onDataCallback("echo manual\\r");
  expect(api.WriteTerminal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "接管终端" }));
  expect(onTakeControl).toHaveBeenCalledOnce();
  rerender(
    <DialogProvider>
      <TestTerminalPane tab={tab} active fontSize={14} theme="dark"
        autoCopySelection rightClickPaste confirmMultilinePaste
        onNotice={vi.fn()} onError={vi.fn()}
        aiControlled={false} onTakeControl={onTakeControl} />
    </DialogProvider>,
  );
  await act(async () => {
    refs.terms[0].onDataCallback("pwd\\r");
    await Promise.resolve();
  });
  expect(api.WriteTerminal).toHaveBeenCalled();
});

test("alternate-screen transitions notify the AI target guard", () => {
  const onAlternateScreenChange = vi.fn();
  renderTerminal({ onAlternateScreenChange });
  const term = refs.terms[0];
  term.bufferChangeHandler({ type: "alternate" });
  expect(onAlternateScreenChange).toHaveBeenCalledWith(tab.ref, true);
  term.bufferChangeHandler({ type: "normal" });
  expect(onAlternateScreenChange).toHaveBeenCalledWith(tab.ref, false);
});
