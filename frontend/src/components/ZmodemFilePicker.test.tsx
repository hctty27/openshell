import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import type { Ref } from "../types";
import ZmodemFilePicker from "./ZmodemFilePicker";

const events = vi.hoisted(() => ({ callbacks: new Map<string, (payload: any) => void>() }));
vi.mock("../bridge", () => ({
  api: {
    ZmodemLocalPlaces: vi.fn(async () => ({ home: "/home/user", roots: ["/"] })),
    GetTransferLocalDir: vi.fn(async () => "/home/user"),
    SaveTransferLocalDir: vi.fn(async () => {}),
    SFTPList: vi.fn(async () => [
      { name: "folder", path: "/home/user/folder", isDir: true, isSymlink: false, size: 0, modified: 0, mode: "0755" },
      { name: "hello.txt", path: "/home/user/hello.txt", isDir: false, isSymlink: false, size: 512, modified: 0, mode: "0644" },
    ]),
    StartNativeZmodemInteractiveTransfer: vi.fn(async () => {}),
    StartNativeZmodemPassiveTransfer: vi.fn(async () => {}),
    CancelNativeZmodemSelection: vi.fn(async () => {}),
  },
  listen: (name: string, callback: (payload: any) => void) => {
    events.callbacks.set(name, callback);
    return () => events.callbacks.delete(name);
  },
  errorText: (error: unknown) => String(error),
}));

const ref: Ref = { tabId: "tab-1", sessionId: "session-1", generation: 1 };
const emit = (name: string, payload: unknown) =>
  act(() => { events.callbacks.get(name)?.(payload); });
const intent = (direction: "upload" | "upload-overwrite" | "download" = "upload", remotePath = "") =>
  emit("ssh:native-zmodem-auto-intent", { ref, direction, remotePath, selectionId: 1 });

beforeEach(async () => {
  events.callbacks.clear();
  vi.clearAllMocks();
  await initializeI18n("zh-CN");
});
afterEach(cleanup);

test("native rz uploads exactly one selected file and closes before transfer resolves", async () => {
  let finish!: () => void;
  vi.mocked(api.StartNativeZmodemInteractiveTransfer).mockImplementationOnce(
    () => new Promise<void>(resolve => { finish = resolve; }),
  );
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  intent();
  fireEvent.click(await screen.findByText("hello.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));
  await waitFor(() => expect(api.StartNativeZmodemInteractiveTransfer)
    .toHaveBeenCalledWith(ref, "upload", "/home/user/hello.txt", ""));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => { finish(); });
});

test("native sz downloads exactly one file into remembered directory", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  intent("download", "/var/log/a.log");
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存到此处" }));
  await waitFor(() => expect(api.StartNativeZmodemInteractiveTransfer)
    .toHaveBeenCalledWith(ref, "download", "/home/user", "/var/log/a.log"));
});

test("native picker cancellation never starts a transfer", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  intent();
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.StartNativeZmodemInteractiveTransfer).not.toHaveBeenCalled();
  await waitFor(() => expect(api.CancelNativeZmodemSelection).toHaveBeenCalledWith(ref, 1));
});

test("native single-file picker rejects a multi-line remote path", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  intent("download", "/tmp/one.bin\n/tmp/two.bin");
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存到此处" }));
  expect((await screen.findByRole("alert")).textContent).toContain("ZMODEM 每次只能下载一个远程文件");
  expect(api.StartNativeZmodemInteractiveTransfer).not.toHaveBeenCalled();
});

test("native picker belongs to the originating SSH tab", () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-auto-intent", {
    ref: { tabId: "tab-2", sessionId: "session-2", generation: 1 }, direction: "upload",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("native picker opens the remembered directory and saves navigation", async () => {
  vi.mocked(api.GetTransferLocalDir).mockResolvedValueOnce("/home/user/folder");
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  intent("download", "/var/log/a.log");
  await waitFor(() => expect(api.SFTPList).toHaveBeenCalledWith(ref, "local", "/home/user/folder"));
  expect(api.SaveTransferLocalDir).not.toHaveBeenCalled();
});

test("native picker surfaces unsupported and unavailable errors", () => {
  const onNotice = vi.fn();
  render(<ZmodemFilePicker activeRef={ref} onNotice={onNotice} />);
  emit("ssh:native-zmodem-command-error", { ref, error: "rz -a 不支持" });
  emit("ssh:native-zmodem-unsupported", { ref, error: "未接管协议，需重连" });
  expect(onNotice).toHaveBeenCalledTimes(2);
});

test("rz -y requires explicit confirmation before native overwrite upload", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  intent("upload-overwrite");
  fireEvent.click(await screen.findByText("hello.txt"));
  expect(screen.getByRole("alert").textContent).toContain("取消或传输失败时");
  const send = screen.getByRole("button", { name: "确认覆盖上传" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  expect(api.StartNativeZmodemInteractiveTransfer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", {
    name: "我确认允许覆盖服务器上的同名文件",
  }));
  expect((send as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(api.StartNativeZmodemInteractiveTransfer)
    .toHaveBeenCalledWith(ref, "upload-overwrite", "/home/user/hello.txt", ""));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("rz -y confirmation resets when a file is deselected or a new picker opens", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  intent("upload-overwrite");
  const item = await screen.findByText("hello.txt");
  fireEvent.click(item);
  fireEvent.click(screen.getByRole("checkbox", {
    name: "我确认允许覆盖服务器上的同名文件",
  }));
  fireEvent.click(item);
  fireEvent.click(item);
  const send = screen.getByRole("button", { name: "确认覆盖上传" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  intent("upload-overwrite");
  fireEvent.click(await screen.findByText("hello.txt"));
  expect((screen.getByRole("button", { name: "确认覆盖上传" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.StartNativeZmodemInteractiveTransfer).not.toHaveBeenCalled();
});

test("ordinary rz does not require overwrite confirmation", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  intent("upload");
  fireEvent.click(await screen.findByText("hello.txt"));
  expect(screen.queryByRole("checkbox", {
    name: "我确认允许覆盖服务器上的同名文件",
  })).toBeNull();
  const send = screen.getByRole("button", { name: "上传选中文件" });
  expect((send as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(api.StartNativeZmodemInteractiveTransfer)
    .toHaveBeenCalledWith(ref, "upload", "/home/user/hello.txt", ""));
});


test("rejected native transfer start releases the picker reservation", async () => {
  const onNotice = vi.fn();
  vi.mocked(api.StartNativeZmodemInteractiveTransfer).mockRejectedValueOnce(
    new Error("SSH terminal busy"),
  );
  render(<ZmodemFilePicker activeRef={ref} onNotice={onNotice} />);
  intent();
  fireEvent.click(await screen.findByText("hello.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));
  await waitFor(() => expect(api.CancelNativeZmodemSelection).toHaveBeenCalledWith(ref, 1));
  expect(onNotice).toHaveBeenCalled();
});


test("passive remote sz sends captured handshake to sidecar without requiring filename", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-auto-intent", {
    ref, direction: "download", remotePath: "", selectionId: 41, passive: true,
  });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存到此处" }));
  await waitFor(() => expect(api.StartNativeZmodemPassiveTransfer)
    .toHaveBeenCalledWith(ref, 41, "download", "/home/user"));
  expect(api.StartNativeZmodemInteractiveTransfer).not.toHaveBeenCalled();
});

test("passive remote rz uploads one selected file without re-running shell rz", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-auto-intent", {
    ref, direction: "upload", remotePath: "", selectionId: 42, passive: true,
  });
  fireEvent.click(await screen.findByText("hello.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));
  await waitFor(() => expect(api.StartNativeZmodemPassiveTransfer)
    .toHaveBeenCalledWith(ref, 42, "upload", "/home/user/hello.txt"));
  expect(api.StartNativeZmodemInteractiveTransfer).not.toHaveBeenCalled();
});

test("cancel passive picker leaves terminal quarantined through backend cancellation", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-auto-intent", {
    ref, direction: "upload", selectionId: 43, passive: true,
  });
  await screen.findByText("hello.txt");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(api.CancelNativeZmodemSelection).toHaveBeenCalledWith(ref, 43));
  expect(api.StartNativeZmodemPassiveTransfer).not.toHaveBeenCalled();
});

test("unsolicited buffer overrun closes its matching passive picker", async () => {
  const onNotice = vi.fn();
  render(<ZmodemFilePicker activeRef={ref} onNotice={onNotice} />);
  emit("ssh:native-zmodem-auto-intent", {
    ref, direction: "download", selectionId: 44, passive: true,
  });
  await screen.findByText("hello.txt");
  emit("ssh:native-zmodem-unsupported", { ref, error: "ZMODEM prebuffer overflow" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onNotice).toHaveBeenCalledWith("ZMODEM prebuffer overflow");
});
