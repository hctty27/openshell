import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SFTPView from "./SFTPView";
import { DialogProvider } from "./DialogProvider";
import { initializeI18n } from "../i18n";
import { Clipboard } from "@wailsio/runtime";
import { BASH_CWD_REPORT_COMMAND } from "../terminalCwd";
import { api } from "../bridge";
import type { Ref, SFTPEntry, SFTPTask } from "../types";

const transferEvents = vi.hoisted(() => ({
  callbacks: [] as Array<(task: unknown) => void>,
}));

vi.mock("../bridge", () => ({
  api: {
    SFTPHome: vi.fn(async () => ({ local: "C:/temp", remote: "/root" })),
    SFTPTransfers: vi.fn(async () => []),
    SFTPList: vi.fn(async () => []),
  },
  listen: (_event: string, callback: (task: unknown) => void) => {
    transferEvents.callbacks.push(callback);
    return () => {
      transferEvents.callbacks = transferEvents.callbacks.filter(item => item !== callback);
    };
  },
  errorText: (value: unknown) => String(value),
}));
vi.mock("@wailsio/runtime", () => ({
  Clipboard: { SetText: vi.fn(async () => {}) },
}));

const ref: Ref = { tabId: "tab-1", sessionId: "server-1", generation: 1 };
beforeEach(async () => {
  await initializeI18n("zh-CN");
  vi.clearAllMocks();
  vi.mocked(api.SFTPList).mockResolvedValue([]);
  transferEvents.callbacks.length = 0;
});
afterEach(cleanup);

test("Bash cwd helper reports rejected clipboard writes", async () => {
  vi.mocked(Clipboard.SetText).mockRejectedValueOnce(new Error("clipboard unavailable"));
  const onNotice = vi.fn();
  render(<DialogProvider><SFTPView refID={ref} onNotice={onNotice} cwdReported={false}/></DialogProvider>);
  fireEvent.click(screen.getByRole("button", { name: "复制 Bash 目录同步命令" }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.any(Error)));
  expect((onNotice.mock.calls[0][0] as Error).message).toBe("clipboard unavailable");
});

test("Bash cwd helper reports success when Wails v3 clipboard resolves", async () => {
  const onNotice = vi.fn();
  render(<DialogProvider><SFTPView refID={ref} onNotice={onNotice} cwdReported={false}/></DialogProvider>);
  fireEvent.click(screen.getByRole("button", { name: "复制 Bash 目录同步命令" }));
  await waitFor(() => expect(Clipboard.SetText).toHaveBeenCalledWith(BASH_CWD_REPORT_COMMAND));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("已复制 Bash")));
});

test("SFTP context menu copies a file path with Wails v3 clipboard", async () => {
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote"
    ? [{ name: "test.txt", path: "/root/test.txt", isDir: false, isSymlink: false,
      size: 1, modified: 0, mode: "-rw-r--r--" }]
    : []);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);

  const row = (await screen.findByText("test.txt")).closest('[role="listitem"]')!;
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByRole("menuitem", { name: "复制路径" }));
  await waitFor(() => expect(Clipboard.SetText).toHaveBeenCalledWith("/root/test.txt"));
});

const file = (name: string, path: string): SFTPEntry => ({
  name, path, isDir: false, isSymlink: false, size: 1, modified: 0, mode: "0644",
});

const pane = (side: "local" | "remote") =>
  document.querySelector<HTMLElement>(`.sftp-${side}`)!;

test.each([
  ["local", "C:/temp"],
  ["remote", "/root"],
] as const)("refreshing the %s pane does not reload the opposite pane", async (side, directory) => {
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  await waitFor(() => expect(api.SFTPList).toHaveBeenCalledTimes(2));
  vi.mocked(api.SFTPList).mockClear();

  fireEvent.click(within(pane(side)).getByTitle(/刷新/));

  await waitFor(() => expect(api.SFTPList).toHaveBeenCalledTimes(1));
  expect(api.SFTPList).toHaveBeenCalledWith(ref, side, directory);
});

test("hidden files can be toggled independently without reloading either pane", async () => {
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) =>
    side === "local" ? [file(".local-secret", "C:/temp/.local-secret")] : [file(".remote-secret", "/root/.remote-secret")]);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  await waitFor(() => expect(api.SFTPList).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(".local-secret")).toBeNull();
  expect(screen.queryByText(".remote-secret")).toBeNull();
  vi.mocked(api.SFTPList).mockClear();

  fireEvent.click(within(pane("local")).getByTitle(/隐藏文件/));
  expect(screen.getByText(".local-secret")).toBeTruthy();
  expect(screen.queryByText(".remote-secret")).toBeNull();

  fireEvent.click(within(pane("remote")).getByTitle(/隐藏文件/));
  expect(screen.getByText(".local-secret")).toBeTruthy();
  expect(screen.getByText(".remote-secret")).toBeTruthy();
  expect(api.SFTPList).not.toHaveBeenCalled();
});

test.each([
  ["upload", "remote", "/root"],
  ["download", "local", "C:/temp"],
] as const)("completed %s refreshes only its %s destination", async (direction, side, directory) => {
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  await waitFor(() => expect(api.SFTPList).toHaveBeenCalledTimes(2));
  vi.mocked(api.SFTPList).mockClear();

  const task: SFTPTask = {
    id: "transfer-1", ref, direction, source: "/tmp/example.txt",
    destination: direction === "upload" ? "/root/example.txt" : "C:/temp/example.txt",
    name: "example.txt", bytes: 1, total: 1, status: "completed",
    overwrite: false, resume: false, error: "", created: 1,
  };
  act(() => {
    for (const callback of transferEvents.callbacks) callback(task);
  });

  await waitFor(() => expect(api.SFTPList).toHaveBeenCalledTimes(1));
  expect(api.SFTPList).toHaveBeenCalledWith(ref, side, directory);
});

test("refreshing a loaded directory keeps its previous file rows visible", async () => {
  const entry = file("visible.txt", "C:/temp/visible.txt");
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "local" ? [entry] : []);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  await screen.findByText("visible.txt");

  let finishRefresh: (entries: SFTPEntry[]) => void = () => {};
  const pending = new Promise<SFTPEntry[]>(resolve => { finishRefresh = resolve; });
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "local" ? pending : []);
  fireEvent.click(within(pane("local")).getByTitle(/刷新/));

  expect(within(pane("local")).getByText("visible.txt")).toBeTruthy();
  await act(async () => { finishRefresh([entry]); });
  expect(within(pane("local")).getByText("visible.txt")).toBeTruthy();
});
