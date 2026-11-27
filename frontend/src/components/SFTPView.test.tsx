import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SFTPView from "./SFTPView";
import { DialogProvider } from "./DialogProvider";
import { initializeI18n, t } from "../i18n";
import { Clipboard } from "@wailsio/runtime";
import { BASH_CWD_REPORT_COMMAND } from "../terminalCwd";
import { api } from "../bridge";
import type { Ref, SFTPEntry, SFTPTask, SFTPDocument } from "../types";

const transferEvents = vi.hoisted(() => ({
  callbacks: [] as Array<(task: unknown) => void>,
}));

vi.mock("../bridge", () => ({
  api: {
    SFTPHome: vi.fn(async () => ({ local: "C:/temp", remote: "/root" })),
    SFTPTransfers: vi.fn(async () => []),
    SFTPStartBatch: vi.fn(async () => []),
    SaveTransferLocalDir: vi.fn(async () => {}),
    SFTPReadRemoteText: vi.fn(),
    SFTPReadRemoteTextRequest: vi.fn(),
    SFTPCancelReadRemoteText: vi.fn(async () => {}),
    SFTPSaveRemoteText: vi.fn(),
    SFTPList: vi.fn(async () => []),
    SFTPOperate: vi.fn(async () => {}),
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

vi.mock("./editor/SFTPFileEditor", () => ({
  default: ({path,initialContent,dirty,onChange,onSave,onClose,active}: {
    path: string;
    initialContent: string;
    dirty: boolean;
    onChange(content: string): void;
    onSave(content: string): void;
    onClose(): void;
    active: boolean;
  }) => (
    <div data-editor-path={path} hidden={!active}>
      <textarea data-testid="sftp-edit-draft" defaultValue={initialContent} onChange={event=>onChange(event.target.value)}/>
      <span data-testid="sftp-edit-dirty">{dirty ? "dirty" : "clean"}</span>
      <button type="button" onClick={()=>onSave(document.querySelector<HTMLTextAreaElement>(`[data-editor-path="${path}"] [data-testid="sftp-edit-draft"]`)?.value ?? "")}>save mock</button>
      <button type="button" onClick={onClose}>close mock</button>
    </div>
  ),
}));

const ref: Ref = { tabId: "tab-1", sessionId: "server-1", generation: 1 };
beforeEach(async () => {
  await initializeI18n("zh-CN");
  vi.clearAllMocks();
  vi.mocked(api.SFTPList).mockResolvedValue([]);
  transferEvents.callbacks.length = 0;
});
afterEach(cleanup);

test("local and remote SFTP headers share the compact workspace layout", () => {
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  for (const side of ["local", "remote"]) {
    const header = document.querySelector(`.sftp-${side} .sftp-panel-header`);
    expect(header?.classList.contains("workspace-panel-header")).toBe(true);
    expect(header?.querySelector(".panel-header-title .workspace-panel-dot")).toBeTruthy();
    expect(header?.querySelector(".panel-header-actions")).toBeTruthy();
  }
});

test("SFTP sync actions use compact labels while keeping full accessible names", () => {
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  const controls = document.querySelector<HTMLElement>(".sftp-sync-controls")!;
  expect(controls.querySelector(".sftp-sync-label")?.textContent).toBe("目录");
  expect(within(controls).getByRole("button", { name: "同步本地 → 远程" }).textContent).toBe("本地 → 远程");
  expect(within(controls).getByRole("button", { name: "同步远程 → 本地" }).textContent).toBe("远程 → 本地");
});

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

const remotePathInput = () =>
  within(pane("remote")).getByRole("textbox", { name: "目录" }) as HTMLInputElement;

test("SFTP jumps only on click and uses the latest reported terminal directory", async () => {
  const onRemoteDirectoryChange = vi.fn();
  const view = (directory: string) => (
    <DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}
      cwdReported terminalDirectory={directory}
      onRemoteDirectoryChange={onRemoteDirectoryChange}/></DialogProvider>
  );
  const { rerender } = render(view("/opt/first"));
  await waitFor(() => expect(api.SFTPList).toHaveBeenCalledWith(ref, "remote", "/root"));

  rerender(view("/opt/latest"));
  expect(remotePathInput().value).toBe("/root");
  expect(api.SFTPList).not.toHaveBeenCalledWith(ref, "remote", "/opt/latest");

  fireEvent.click(within(pane("remote")).getByRole("button", { name: "跳转到当前终端目录" }));
  await waitFor(() => expect(remotePathInput().value).toBe("/opt/latest"));
  expect(api.SFTPList).toHaveBeenCalledWith(ref, "remote", "/opt/latest");
  await waitFor(() => expect(onRemoteDirectoryChange).toHaveBeenCalledWith("/opt/latest"));
  expect(vi.mocked(api.SFTPList).mock.calls.filter(([, side, path]) => side === "remote" && path === "/opt/latest")).toHaveLength(1);
});

test("SFTP terminal jump is disabled without a reported valid directory", async () => {
  const { rerender } = render(
    <DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}
      cwdReported={false} terminalDirectory="/opt/project"/></DialogProvider>);
  const button = within(pane("remote")).getByRole("button", { name: "跳转到当前终端目录" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  rerender(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}
    cwdReported terminalDirectory="relative/path"/></DialogProvider>);
  expect(button.disabled).toBe(true);
  await waitFor(() => expect(remotePathInput().value).toBe("/root"));
});

test("failed SFTP terminal jump retains the prior directory and reports the error", async () => {
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side, directory) => {
    if (side === "remote" && directory === "/restricted") throw new Error("permission denied");
    return [];
  });
  const onNotice = vi.fn();
  const onRemoteDirectoryChange = vi.fn();
  render(<DialogProvider><SFTPView refID={ref} onNotice={onNotice}
    cwdReported terminalDirectory="/restricted" onRemoteDirectoryChange={onRemoteDirectoryChange}/></DialogProvider>);
  await waitFor(() => expect(remotePathInput().value).toBe("/root"));

  fireEvent.click(within(pane("remote")).getByRole("button", { name: "跳转到当前终端目录" }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.any(Error)));
  expect(remotePathInput().value).toBe("/root");
  expect(onRemoteDirectoryChange).not.toHaveBeenCalledWith("/restricted");
});

test("manual SFTP navigation wins over an in-flight terminal directory jump", async () => {
  let resolveJump: ((entries: SFTPEntry[]) => void) | undefined;
  const jumpListing = new Promise<SFTPEntry[]>(resolve => { resolveJump = resolve; });
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side, directory) => {
    if (side === "remote" && directory === "/opt/slow") return jumpListing;
    return [];
  });
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}
    cwdReported terminalDirectory="/opt/slow"/></DialogProvider>);
  await waitFor(() => expect(remotePathInput().value).toBe("/root"));

  fireEvent.click(within(pane("remote")).getByRole("button", { name: "跳转到当前终端目录" }));
  fireEvent.change(remotePathInput(), { target: { value: "/manual" } });
  fireEvent.submit(remotePathInput().closest("form")!);
  await waitFor(() => expect(remotePathInput().value).toBe("/manual"));
  await act(async () => { resolveJump?.([]); });
  expect(remotePathInput().value).toBe("/manual");
});

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

const setupBatchFiles = () => {
  const local = [file("local.txt", "C:/temp/local.txt")];
  const remote = [
    file("one.txt", "/root/one.txt"),
    file("two.txt", "/root/two.txt"),
    file("three.txt", "/root/three.txt"),
  ];
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "local" ? local : remote);
  return { local, remote };
};

const row = (side: "local" | "remote", name: string) =>
  within(pane(side)).getByText(name).closest<HTMLButtonElement>(".sftp-file-row")!;

test("SFTP selection supports Shift ranges, Ctrl+A and Escape within the focused pane", async () => {
  setupBatchFiles();
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  await screen.findByText("three.txt");

  fireEvent.click(row("remote", "one.txt"));
  fireEvent.click(row("remote", "three.txt"), { shiftKey: true });
  expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(3);

  const table=within(pane("remote")).getByRole("list");
  fireEvent.keyDown(table, { key: "Escape" });
  expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(0);
  fireEvent.keyDown(table, { key: "a", ctrlKey: true });
  expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(3);
  expect(pane("local").querySelectorAll(".sftp-file-row.selected")).toHaveLength(0);
});

test("large directory metadata is cached across transfers and selection changes", async () => {
  const entries = Array.from({ length: 180 }, (_, index) =>
    file(`log-${index}.txt`, `/root/log-${index}.txt`));
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) =>
    side === "remote" ? entries : []);
  const format = vi.spyOn(Date.prototype, "toLocaleDateString");
  try {
    render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
    await screen.findByText("log-179.txt");
    expect(pane("remote").querySelectorAll(".sftp-file-row")).toHaveLength(180);
    format.mockClear();

    fireEvent.click(row("remote", "log-0.txt"));
    expect(row("remote", "log-0.txt").classList.contains("selected")).toBe(true);
    const table = within(pane("remote")).getByRole("list");
    fireEvent.keyDown(table, { key: "a", ctrlKey: true });
    expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(180);

    const task: SFTPTask = {
      id: "progress-1", ref, direction: "upload",
      source: "C:/temp/log-0.txt", destination: "/root/log-0.txt",
      name: "log-0.txt", bytes: 0, total: 100,
      status: "queued", overwrite: false, resume: false, error: "", created: 1,
    };
    act(() => {
      for (const callback of transferEvents.callbacks) callback(task);
    });

    expect(format).not.toHaveBeenCalled();
    expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(180);
    expect(row("remote", "log-0.txt").classList.contains("selected")).toBe(true);
  } finally {
    format.mockRestore();
  }
});

test("large-directory rows keep live selection handlers after memoized updates", async () => {
  const entries = Array.from({ length: 240 }, (_, index) =>
    file(`log-${index}.txt`, `/root/log-${index}.txt`));
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) =>
    side === "remote" ? entries : []);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  await screen.findByText("log-239.txt");

  fireEvent.click(row("remote", "log-1.txt"));
  fireEvent.click(row("remote", "log-3.txt"), { ctrlKey: true });
  expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(2);

  // Previously unchanged rows are memoized, but their handlers must read
  // the latest selection anchor instead of capturing the initial props.
  fireEvent.click(row("remote", "log-6.txt"), { shiftKey: true });
  expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(4);
  expect(row("remote", "log-1.txt").classList.contains("selected")).toBe(false);
  expect(row("remote", "log-3.txt").classList.contains("selected")).toBe(true);
  expect(row("remote", "log-6.txt").classList.contains("selected")).toBe(true);

  fireEvent.keyDown(within(pane("remote")).getByRole("list"), { key: "Escape" });
  expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(0);
  fireEvent.click(row("remote", "log-239.txt"));
  expect(row("remote", "log-239.txt").classList.contains("selected")).toBe(true);
});

test("right-clicking a selected SFTP item keeps the multi-selection and deletes both after one confirmation", async () => {
  setupBatchFiles();
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  await screen.findByText("three.txt");

  fireEvent.click(row("remote", "one.txt"));
  fireEvent.click(row("remote", "two.txt"), { ctrlKey: true });
  fireEvent.contextMenu(row("remote", "two.txt"));
  expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(2);

  fireEvent.click(await screen.findByRole("menuitem", { name: "删除选中的 2 项" }));
  const dialog=await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/2 个文件和 0 个文件夹/)).toBeTruthy();
  expect(api.SFTPOperate).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

  await waitFor(() => expect(api.SFTPOperate).toHaveBeenCalledTimes(2));
  expect(api.SFTPOperate).toHaveBeenNthCalledWith(1, ref, "remote", "delete", "/root/one.txt", "");
  expect(api.SFTPOperate).toHaveBeenNthCalledWith(2, ref, "remote", "delete", "/root/two.txt", "");
});

test("Delete shortcut deletes only the focused pane selection", async () => {
  setupBatchFiles();
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  await screen.findByText("three.txt");

  fireEvent.click(row("local", "local.txt"));
  fireEvent.click(row("remote", "three.txt"));
  fireEvent.keyDown(within(pane("remote")).getByRole("list"), { key: "Delete" });
  const dialog=await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

  await waitFor(() => expect(api.SFTPOperate).toHaveBeenCalledTimes(1));
  expect(api.SFTPOperate).toHaveBeenCalledWith(ref, "remote", "delete", "/root/three.txt", "");
});

test("batch deletion continues on individual failures and retains failed items for retry", async () => {
  setupBatchFiles();
  vi.mocked(api.SFTPOperate).mockRejectedValueOnce(new Error("access denied"));
  const onNotice=vi.fn();
  render(<DialogProvider><SFTPView refID={ref} onNotice={onNotice}/></DialogProvider>);
  await screen.findByText("three.txt");

  fireEvent.click(row("remote", "one.txt"));
  fireEvent.click(row("remote", "two.txt"), { ctrlKey: true });
  fireEvent.click(within(pane("remote")).getByRole("button", { name: "删除" }));
  const dialog=await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

  await waitFor(() => expect(api.SFTPOperate).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("access denied")));
  expect(row("remote", "one.txt").classList.contains("selected")).toBe(true);
  expect(row("remote", "two.txt").classList.contains("selected")).toBe(false);
});

test("SFTP saves a successfully visited local folder for the saved SSH session", async () => {
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side, directory) =>
    side === "local" && directory === "C:/temp"
      ? [{...file("projects", "C:/temp/projects"), isDir: true}]
      : []);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  const folder = await screen.findByText("projects");
  expect(api.SaveTransferLocalDir).not.toHaveBeenCalled();
  fireEvent.doubleClick(folder.closest('[role="listitem"]')!);
  await waitFor(() => expect(api.SaveTransferLocalDir)
    .toHaveBeenCalledWith(ref.sessionId, "C:/temp/projects"));
});

test("SFTP does not persist a local folder that fails to load", async () => {
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side, directory) => {
    if (side === "local" && directory === "C:/temp") {
      return [{...file("missing", "C:/temp/missing"), isDir: true}];
    }
    if (side === "local" && directory === "C:/temp/missing") throw new Error("missing");
    return [];
  });
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  fireEvent.doubleClick((await screen.findByText("missing")).closest('[role="listitem"]')!);
  expect(await screen.findByText("Error: missing")).toBeTruthy();
  expect(api.SaveTransferLocalDir).not.toHaveBeenCalled();
});

test("saving a remote file does not discard edits made during the upload", async () => {
  const original: SFTPDocument = {
    path: "/root/config.yaml", content: "original", revision: "initial", size: 8,
  };
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) =>
    side === "remote" ? [file("config.yaml", original.path)] : []);
  vi.mocked(api.SFTPReadRemoteTextRequest).mockResolvedValue(original);
  let finishSave: (document: SFTPDocument) => void = () => {};
  vi.mocked(api.SFTPSaveRemoteText).mockImplementation(() =>
    new Promise(resolve => { finishSave = resolve; }));
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  const row = (await screen.findByText("config.yaml")).closest('[role="listitem"]')!;
  fireEvent.doubleClick(row);
  const draft = await screen.findByTestId("sftp-edit-draft") as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: "first change" } });
  fireEvent.click(screen.getByRole("button", { name: "save mock" }));
  await waitFor(() => expect(api.SFTPSaveRemoteText).toHaveBeenCalledWith(ref, original.path, original.revision, "first change"));
  fireEvent.change(draft, { target: { value: "second change" } });
  await act(async () => finishSave({ ...original, content: "first change", revision: "next", size: 12 }));
  expect(draft.value).toBe("second change");
  expect(screen.getByTestId("sftp-edit-dirty").textContent).toBe("dirty");
});

test("remote SFTP editor is docked inside the SFTP panel and confirms before discarding changes", async () => {
  const source: SFTPDocument = { path: "/root/config.yaml", content: "original", revision: "initial", size: 8 };
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote" ? [file("config.yaml", source.path)] : []);
  vi.mocked(api.SFTPReadRemoteTextRequest).mockResolvedValue(source);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  fireEvent.doubleClick((await screen.findByText("config.yaml")).closest('[role="listitem"]')!);
  const draft = await screen.findByTestId("sftp-edit-draft") as HTMLTextAreaElement;
  const dock = screen.getByRole("region", { name: t("sftp:editText") });
  expect(dock.classList.contains("sftp-editor-docked")).toBe(true);
  expect(dock.parentElement?.classList.contains("sftp-view")).toBe(true);
  expect(document.querySelector(".sftp-editor-dialog")).toBeNull();
  fireEvent.change(draft, { target: { value: "unsaved" } });
  fireEvent.click(within(dock).getByRole("button", { name: "close mock" }));
  let confirmation = await screen.findByRole("dialog", { name: t("sftp:discardEditorTitle") });
  fireEvent.click(within(confirmation).getByRole("button", { name: t("common:cancel") }));
  expect(dock.isConnected).toBe(true);
  expect(draft.value).toBe("unsaved");
  fireEvent.click(within(dock).getByRole("button", { name: "close mock" }));
  confirmation = await screen.findByRole("dialog", { name: t("sftp:discardEditorTitle") });
  fireEvent.click(within(confirmation).getByRole("button", { name: t("sftp:discard") }));
  await waitFor(() => expect(document.querySelector(".sftp-editor-docked")).toBeNull());
});

test("remote editor opens immediately and ignores a cancelled read", async () => {
  const source: SFTPDocument = { path: "/root/config.yaml", content: "original", revision: "initial", size: 8 };
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote" ? [file("config.yaml", source.path)] : []);
  let finishRead: (document: SFTPDocument) => void = () => {};
  vi.mocked(api.SFTPReadRemoteTextRequest).mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  const row = (await screen.findByText("config.yaml")).closest('[role="listitem"]')!;
  fireEvent.doubleClick(row);
  fireEvent.doubleClick(row);
  expect(api.SFTPReadRemoteTextRequest).toHaveBeenCalledTimes(1);
  const dock = screen.getByRole("region", { name: t("sftp:editText") });
  expect(within(dock).getByText(t("sftp:editorReading"))).toBeTruthy();
  expect(within(dock).getByText("/root/config.yaml")).toBeTruthy();
  fireEvent.click(within(dock).getByRole("button", { name: t("common:cancel") }));
  await waitFor(() => expect(document.querySelector(".sftp-editor-docked")).toBeNull());
  expect(api.SFTPCancelReadRemoteText).toHaveBeenCalledWith(expect.stringMatching(/^sftp-read-/));
  await act(async () => finishRead(source));
  expect(document.querySelector(".sftp-editor-docked")).toBeNull();
});

test("SFTP editor loading can be dismissed by Escape without opening a late result", async () => {
  const source: SFTPDocument = { path: "/root/config.yaml", content: "original", revision: "initial", size: 8 };
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote" ? [file("config.yaml", source.path)] : []);
  let finishRead: (document: SFTPDocument) => void = () => {};
  vi.mocked(api.SFTPReadRemoteTextRequest).mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  fireEvent.doubleClick((await screen.findByText("config.yaml")).closest('[role="listitem"]')!);
  const dock = screen.getByRole("region", { name: t("sftp:editText") });
  fireEvent.keyDown(dock, { key: "Escape" });
  await waitFor(() => expect(document.querySelector(".sftp-editor-docked")).toBeNull());
  expect(api.SFTPCancelReadRemoteText).toHaveBeenCalledTimes(1);
  await act(async () => finishRead(source));
  expect(document.querySelector(".sftp-editor-docked")).toBeNull();
});

test("SFTP editor shows a retry option when a remote read fails", async () => {
  const source: SFTPDocument = { path: "/root/config.yaml", content: "original", revision: "initial", size: 8 };
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote" ? [file("config.yaml", source.path)] : []);
  vi.mocked(api.SFTPReadRemoteTextRequest).mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValueOnce(source);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  fireEvent.doubleClick((await screen.findByText("config.yaml")).closest('[role="listitem"]')!);
  const dock = screen.getByRole("region", { name: t("sftp:editText") });
  expect(await within(dock).findByText(t("sftp:editorLoadFailed"))).toBeTruthy();
  expect(within(dock).getByText(/network unavailable/)).toBeTruthy();
  fireEvent.click(within(dock).getByRole("button", { name: t("sftp:editorRetry") }));
  expect(await screen.findByTestId("sftp-edit-draft")).toBeTruthy();
  expect(api.SFTPReadRemoteTextRequest).toHaveBeenCalledTimes(2);
});

test("docked editor shell stays mounted while loading and after content arrives", async () => {
  const source: SFTPDocument = { path: "/root/config.yaml", content: "original", revision: "initial", size: 8 };
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote" ? [file("config.yaml", source.path)] : []);
  let finishRead: (document: SFTPDocument) => void = () => {};
  vi.mocked(api.SFTPReadRemoteTextRequest).mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  fireEvent.doubleClick((await screen.findByText("config.yaml")).closest('[role="listitem"]')!);
  const dock = screen.getByRole("region", { name: t("sftp:editText") });
  const initialClassName = dock.className;
  expect(initialClassName).toBe("sftp-editor-docked");
  expect(within(dock).getByText(t("sftp:editorReading"))).toBeTruthy();
  await act(async () => finishRead(source));
  expect(await screen.findByTestId("sftp-edit-draft")).toBeTruthy();
  expect(screen.getByRole("region", { name: t("sftp:editText") })).toBe(dock);
  expect(dock.className).toBe(initialClassName);
});

test("SFTP editor tabs retain independent drafts while switching between remote files", async () => {
  const config: SFTPDocument = { path: "/root/config.yaml", content: "config original", revision: "config-r1", size: 14 };
  const nginx: SFTPDocument = { path: "/root/nginx.conf", content: "nginx original", revision: "nginx-r1", size: 14 };
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote" ? [file("config.yaml", config.path), file("nginx.conf", nginx.path)] : []);
  vi.mocked(api.SFTPReadRemoteTextRequest).mockImplementation(async (_ref, path) => path === config.path ? config : nginx);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()}/></DialogProvider>);
  fireEvent.doubleClick((await screen.findByText("config.yaml")).closest('[role="listitem"]')!);
  const configDraft = await waitFor(() => {
    const element = document.querySelector<HTMLTextAreaElement>('[data-editor-path="/root/config.yaml"] [data-testid="sftp-edit-draft"]');
    if (!element) throw new Error("config editor tab did not mount");
    return element;
  });
  fireEvent.change(configDraft!, { target: { value: "config edited" } });
  fireEvent.click(screen.getByRole("button", { name: t("sftp:fileManager") }));
  fireEvent.doubleClick((await screen.findByText("nginx.conf")).closest('[role="listitem"]')!);
  const nginxDraft = await waitFor(() => {
    const element = document.querySelector<HTMLTextAreaElement>('[data-editor-path="/root/nginx.conf"] [data-testid="sftp-edit-draft"]');
    if (!element) throw new Error("nginx editor tab did not mount");
    return element;
  });
  expect(nginxDraft!.value).toBe("nginx original");
  fireEvent.click(screen.getByRole("tab", { name: /config\.yaml/ }));
  expect(configDraft!.value).toBe("config edited");
  fireEvent.click(screen.getByRole("tab", { name: /nginx\.conf/ }));
  expect(nginxDraft!.value).toBe("nginx original");
});

test("multi-selection submits one atomic SFTP transfer batch", async () => {
  setupBatchFiles();
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  await screen.findByText("three.txt");
  fireEvent.click(row("remote", "one.txt"));
  fireEvent.click(row("remote", "three.txt"), { shiftKey: true });
  fireEvent.click(within(pane("remote")).getByRole("button", { name: "下载" }));
  await waitFor(() => expect(api.SFTPStartBatch).toHaveBeenCalledWith(ref, [
    {direction:"download",source:"/root/one.txt",destination:"C:/temp/one.txt",overwrite:false,resume:true},
    {direction:"download",source:"/root/two.txt",destination:"C:/temp/two.txt",overwrite:false,resume:true},
    {direction:"download",source:"/root/three.txt",destination:"C:/temp/three.txt",overwrite:false,resume:true},
  ]));
});

test("SFTP supports mouse marquee selection from the empty area of a file list", async () => {
  setupBatchFiles();
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  await screen.findByText("three.txt");

  const table = within(pane("remote")).getByRole("list") as HTMLDivElement;
  const rows = Array.from(pane("remote").querySelectorAll<HTMLButtonElement>(".sftp-file-row"));
  const bounds = {
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300,
    width: 400, height: 300, toJSON: () => ({}),
  } as DOMRect;
  const first = {
    x: 0, y: 25, left: 0, top: 25, right: 400, bottom: 54,
    width: 400, height: 29, toJSON: () => ({}),
  } as DOMRect;
  const last = {
    x: 0, y: 83, left: 0, top: 83, right: 400, bottom: 112,
    width: 400, height: 29, toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(table, "getBoundingClientRect").mockReturnValue(bounds);
  vi.spyOn(rows[0], "getBoundingClientRect").mockReturnValue(first);
  vi.spyOn(rows[rows.length - 1], "getBoundingClientRect").mockReturnValue(last);

  fireEvent.pointerDown(table, {
    pointerId: 1, pointerType: "mouse", button: 0, clientX: 5, clientY: 10,
  });
  fireEvent.pointerMove(table, {
    pointerId: 1, pointerType: "mouse", button: 0, clientX: 250, clientY: 90,
  });
  fireEvent.pointerUp(table, {
    pointerId: 1, pointerType: "mouse", button: 0, clientX: 250, clientY: 90,
  });

  expect(pane("remote").querySelectorAll(".sftp-file-row.selected")).toHaveLength(3);
});

test("dragging a selected SFTP row carries the entire selection", async () => {
  setupBatchFiles();
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  await screen.findByText("three.txt");

  fireEvent.click(row("remote", "one.txt"));
  fireEvent.click(row("remote", "two.txt"), { ctrlKey: true });
  const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
  fireEvent.dragStart(row("remote", "two.txt"), { dataTransfer });

  expect(dataTransfer.setData).toHaveBeenCalledWith(
    "application/x-openshell-entry",
    JSON.stringify({
      side: "remote",
      path: "/root/two.txt",
      paths: ["/root/one.txt", "/root/two.txt"],
    }),
  );
  expect(dataTransfer.effectAllowed).toBe("copy");
});

test("SFTP batch transfer supports overwriting all existing destination files", async () => {
  const local = [
    file("one.txt", "C:/temp/one.txt"),
    file("two.txt", "C:/temp/two.txt"),
  ];
  const remote = [
    file("one.txt", "/root/one.txt"),
    file("two.txt", "/root/two.txt"),
  ];
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) =>
    side === "local" ? local : remote);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  await within(pane("local")).findByText("two.txt");

  fireEvent.click(row("local", "one.txt"));
  fireEvent.click(row("local", "two.txt"), { ctrlKey: true });
  fireEvent.click(within(pane("local")).getByRole("button", { name: "上传" }));
  const dialog = await screen.findByRole("dialog", { name: t("sftp:overwriteTitle") });
  fireEvent.click(within(dialog).getByRole("button", { name: "全部覆盖" }));

  await waitFor(() => expect(api.SFTPStartBatch).toHaveBeenCalledWith(ref, [
    { direction: "upload", source: "C:/temp/one.txt", destination: "/root/one.txt", overwrite: true, resume: true },
    { direction: "upload", source: "C:/temp/two.txt", destination: "/root/two.txt", overwrite: true, resume: true },
  ]));
});

test("SFTP batch transfer can skip all conflicts and still transfer new files", async () => {
  const local = [
    file("one.txt", "C:/temp/one.txt"),
    file("two.txt", "C:/temp/two.txt"),
    file("new.txt", "C:/temp/new.txt"),
  ];
  const remote = [
    file("one.txt", "/root/one.txt"),
    file("two.txt", "/root/two.txt"),
  ];
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) =>
    side === "local" ? local : remote);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  await screen.findByText("new.txt");

  fireEvent.keyDown(within(pane("local")).getByRole("list"), { key: "a", ctrlKey: true });
  fireEvent.click(within(pane("local")).getByRole("button", { name: "上传" }));
  const dialog = await screen.findByRole("dialog", { name: t("sftp:overwriteTitle") });
  fireEvent.click(within(dialog).getByRole("button", { name: "全部跳过" }));

  await waitFor(() => expect(api.SFTPStartBatch).toHaveBeenCalledWith(ref, [
    { direction: "upload", source: "C:/temp/new.txt", destination: "/root/new.txt", overwrite: false, resume: true },
  ]));
});

test("SFTP batch transfer can decide each overwrite conflict independently", async () => {
  const local = [
    file("one.txt", "C:/temp/one.txt"),
    file("two.txt", "C:/temp/two.txt"),
  ];
  const remote = [
    file("one.txt", "/root/one.txt"),
    file("two.txt", "/root/two.txt"),
  ];
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) =>
    side === "local" ? local : remote);
  render(<DialogProvider><SFTPView refID={ref} onNotice={vi.fn()} /></DialogProvider>);
  await within(pane("local")).findByText("two.txt");

  fireEvent.click(row("local", "one.txt"));
  fireEvent.click(row("local", "two.txt"), { ctrlKey: true });
  fireEvent.click(within(pane("local")).getByRole("button", { name: "上传" }));

  let dialog = await screen.findByRole("dialog", { name: t("sftp:overwriteTitle") });
  fireEvent.click(within(dialog).getByRole("button", { name: "跳过当前" }));
  await waitFor(() => expect(screen.getByText(/2\/2/)).toBeTruthy());

  dialog = screen.getByRole("dialog", { name: t("sftp:overwriteTitle") });
  fireEvent.click(within(dialog).getByRole("button", { name: "覆盖当前" }));
  await waitFor(() => expect(api.SFTPStartBatch).toHaveBeenCalledWith(ref, [
    { direction: "upload", source: "C:/temp/two.txt", destination: "/root/two.txt", overwrite: true, resume: true },
  ]));
});

test("double-clicking a symbolic link the panel cannot open explains why", async () => {
  vi.mocked(api.SFTPList).mockImplementation(async (_ref, side) => side === "remote"
    ? [
      { name: "dead", path: "/root/dead", isDir: false, isSymlink: true, linkBroken: true, size: 0, modified: 0, mode: "0777" },
      { name: "conf", path: "/root/conf", isDir: false, isSymlink: true, size: 4096, modified: 0, mode: "0644" },
    ]
    : []);
  const onNotice = vi.fn();
  render(<DialogProvider><SFTPView refID={ref} onNotice={onNotice}/></DialogProvider>);
  fireEvent.doubleClick((await screen.findByText("dead")).closest('[role="listitem"]')!);
  expect(onNotice).toHaveBeenLastCalledWith(expect.objectContaining({ key: "sftp:symlinkBroken", values: { name: "dead" } }));
  fireEvent.doubleClick(screen.getByText("conf").closest('[role="listitem"]')!);
  expect(onNotice).toHaveBeenLastCalledWith(expect.objectContaining({ key: "sftp:symlinkFileNotOpenable" }));
  expect(screen.getByTitle("失效的链接")).toBeTruthy();
});
