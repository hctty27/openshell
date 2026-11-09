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
    SubmitZmodemSelection: vi.fn(async () => {}),
    StartNativeZmodemInteractiveBatchTransfer: vi.fn(async () => {}),
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

beforeEach(async () => {
  events.callbacks.clear();
  vi.clearAllMocks();
  await initializeI18n("zh-CN");
});
afterEach(cleanup);

test("rz uses the embedded picker and sends selected paths without a native dialog", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 1, direction: "upload" });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByText("hello.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));
  await waitFor(() => expect(api.SubmitZmodemSelection).toHaveBeenCalledWith(ref, 1, ["/home/user/hello.txt"]));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("native rz intent uses the embedded picker and starts the Rust transfer without a second dialog", async () => {
  let finish!: () => void;
  vi.mocked(api.StartNativeZmodemInteractiveBatchTransfer).mockImplementationOnce(
    () => new Promise<void>(resolve => { finish = resolve; }),
  );
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-auto-intent", {
    ref, sessionName: "Linux", direction: "upload", remotePath: "",
  });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByText("hello.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));

  await waitFor(() => expect(api.StartNativeZmodemInteractiveBatchTransfer)
    .toHaveBeenCalledWith(ref, "upload", ["/home/user/hello.txt"], []));
  expect(api.SubmitZmodemSelection).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await act(async () => { finish(); });
});

test("native sz intent uses the embedded picker destination and preserves remote paths", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-auto-intent", {
    ref, direction: "download", remotePath: "/var/log/a.log\n/var/log/b.log",
  });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存到此处" }));

  await waitFor(() => expect(api.StartNativeZmodemInteractiveBatchTransfer)
    .toHaveBeenCalledWith(ref, "download", ["/home/user"], ["/var/log/a.log", "/var/log/b.log"]));
  expect(api.SubmitZmodemSelection).not.toHaveBeenCalled();
});

test("cancelling a native picker does not submit a legacy ZMODEM selection", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-auto-intent", { ref, direction: "upload", remotePath: "" });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.StartNativeZmodemInteractiveBatchTransfer).not.toHaveBeenCalled();
  expect(api.SubmitZmodemSelection).not.toHaveBeenCalled();
});

test("sz chooses the current local destination directory", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 2, direction: "download" });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存到此处" }));
  await waitFor(() => expect(api.SubmitZmodemSelection).toHaveBeenCalledWith(ref, 2, ["/home/user"]));
});

test("cancel does not start an upload", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 3, direction: "upload" });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(api.SubmitZmodemSelection).toHaveBeenCalledWith(ref, 3, []));
});

test("a picker for another SSH tab does not cover the active tab", () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", {
    ref: { tabId: "tab-2", sessionId: "session-2", generation: 1 },
    id: 4, direction: "upload",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("trz -d selects a local directory using the embedded picker", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", {
    ref, id: 5, direction: "upload", protocol: "trzsz", allowDirectories: true,
  });
  expect(await screen.findByText("folder")).toBeTruthy();
  fireEvent.click(screen.getByText("folder"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));
  await waitFor(() => expect(api.SubmitZmodemSelection)
    .toHaveBeenCalledWith(ref, 5, ["/home/user/folder"]));
});


test("submission is single-flight and closes the picker after backend acknowledgement", async () => {
  let acknowledge!: () => void;
  vi.mocked(api.SubmitZmodemSelection).mockImplementationOnce(
    () => new Promise<void>(resolve => { acknowledge = resolve; }),
  );
  const onClosed = vi.fn();
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} onClosed={onClosed} />);
  emit("ssh:zmodem-pick", { ref, id: 6, direction: "upload" });
  fireEvent.click(await screen.findByText("hello.txt"));
  const send = screen.getByRole("button", { name: "上传选中文件" });
  fireEvent.click(send);
  fireEvent.click(send);
  expect(api.SubmitZmodemSelection).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog")).toBeTruthy();

  await act(async () => { acknowledge(); });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onClosed).toHaveBeenCalledWith(ref);
});

test("submission errors keep the picker open and allow retry", async () => {
  vi.mocked(api.SubmitZmodemSelection).mockRejectedValueOnce(new Error("file not found"));
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 7, direction: "upload" });
  fireEvent.click(await screen.findByText("hello.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Error: file not found");
  expect(screen.getByRole("dialog")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));
  await waitFor(() => expect(api.SubmitZmodemSelection).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a delayed acknowledgement cannot close the next picker request", async () => {
  let acknowledge!: () => void;
  vi.mocked(api.SubmitZmodemSelection).mockImplementationOnce(
    () => new Promise<void>(resolve => { acknowledge = resolve; }),
  );
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 8, direction: "upload" });
  fireEvent.click(await screen.findByText("hello.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传选中文件" }));

  emit("ssh:zmodem-pick-ended", { ref, id: 8 });
  emit("ssh:zmodem-pick", { ref, id: 9, direction: "upload" });
  expect(await screen.findByText("hello.txt")).toBeTruthy();
  await act(async () => { acknowledge(); });
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("rz/sz picker opens the saved directory for its SSH session", async () => {
  vi.mocked(api.GetTransferLocalDir).mockResolvedValueOnce("/home/user/folder");
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 100, direction: "download" });
  await waitFor(() => expect(api.SFTPList).toHaveBeenCalledWith(ref, "local", "/home/user/folder"));
  expect(api.SaveTransferLocalDir).not.toHaveBeenCalled();
});

test("rz/sz picker remembers a successfully opened folder", async () => {
  render(<ZmodemFilePicker activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:zmodem-pick", { ref, id: 101, direction: "upload" });
  fireEvent.doubleClick((await screen.findByText("folder")).closest('[role="listitem"]')!);
  await waitFor(() => expect(api.SaveTransferLocalDir)
    .toHaveBeenCalledWith(ref.sessionId, "/home/user/folder"));
});
