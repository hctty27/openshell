import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import TerminalPane from "./TerminalPane";
import { api } from "../bridge";
import { ClipboardGetText, ClipboardSetText } from "../../wailsjs/runtime/runtime";
import type { Tab } from "../types";

const refs = vi.hoisted(() => ({ terms: [] as any[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = { fontSize: 14, theme: {} };
    modes = { mouseTrackingMode: "none" };
    cols = 80;
    rows = 24;
    selected = "";
    onDataCallback = (_data: string) => {};
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
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    constructor() { refs.terms.push(this); }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit = vi.fn(); dispose = vi.fn(); },
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
  ClipboardGetText: vi.fn(async () => "echo hello"),
  ClipboardSetText: vi.fn(async () => true),
}));

const tab: Tab = {
  id: "tab-1",
  session: {
    id: "ssh-1", groupId: "", name: "test", host: "localhost",
    port: 22, username: "root", authType: "key", privateKeyPath: "", credentialRef: "",
  },
  ref: { tabId: "tab-1", sessionId: "ssh-1", generation: 1 },
  status: "connected", home: "/root", cwd: "/root", messages: [],
  proposal: null, chatBusy: false, executing: false, error: "",
};
const renderTerminal = (options: Partial<Parameters<typeof TerminalPane>[0]> = {}) =>
  render(<TerminalPane tab={tab} active fontSize={14} theme="dark"
    autoCopySelection rightClickPaste confirmMultilinePaste
    onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} {...options} />);

beforeEach(() => {
  refs.terms.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
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
  await waitFor(() => expect(ClipboardSetText).toHaveBeenCalledWith("root@server:~"));
  vi.mocked(ClipboardSetText).mockClear();
  rerender(<TerminalPane tab={tab} active fontSize={14} theme="dark"
    autoCopySelection={false} rightClickPaste confirmMultilinePaste
    onNotice={vi.fn()} onError={vi.fn()} onSelection={vi.fn()} />);
  fireEvent.mouseDown(pane, { button: 0 });
  fireEvent.mouseUp(document, { button: 0 });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  expect(ClipboardSetText).not.toHaveBeenCalled();
});

test("right click pastes via terminal input, multi-line paste requires confirmation", async () => {
  const { container } = renderTerminal();
  const pane = container.querySelector(".terminal-pane")!;
  fireEvent.contextMenu(pane);
  await waitFor(() => expect(refs.terms[0].paste).toHaveBeenCalledWith("echo hello"));
  expect(api.WriteTerminal).toHaveBeenCalled();
  vi.mocked(ClipboardGetText).mockResolvedValueOnce("pwd\nrm -rf example");
  vi.stubGlobal("confirm", vi.fn(() => false));
  fireEvent.contextMenu(pane);
  await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  expect(refs.terms[0].paste).toHaveBeenCalledTimes(1);
});

test("mouse reporting in interactive applications is not overridden", async () => {
  const { container } = renderTerminal();
  refs.terms[0].modes.mouseTrackingMode = "vt200";
  fireEvent.contextMenu(container.querySelector(".terminal-pane")!);
  expect(ClipboardGetText).not.toHaveBeenCalled();
});
