import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import NativeZmodemExperimentDialog from "./NativeZmodemExperimentDialog";

const actions = vi.hoisted(() => ({
  readiness: vi.fn(async () => ({ ready: true, code: "ready", message: "ok" })),
  uploadFile: vi.fn(async () => "C:\\test\\example.bin"),
  uploadFiles: vi.fn(async () => ["C:\\test\\first.bin", "C:\\test\\中文 文件.bin"]),
  downloadFolder: vi.fn(async () => "C:\\downloads"),
  start: vi.fn(async () => {}),
  startBatch: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  progressCallback: null as ((event: unknown) => void) | null,
}));
vi.mock("../bridge", () => ({
  api: {
    NativeZmodemInteractiveReadiness: actions.readiness,
    NativeZmodemChooseUploadFile: actions.uploadFile,
    NativeZmodemChooseUploadFiles: actions.uploadFiles,
    SFTPChooseDirectory: actions.downloadFolder,
    StartNativeZmodemInteractiveTransfer: actions.start,
    StartNativeZmodemInteractiveBatchTransfer: actions.startBatch,
    CancelNativeZmodemInteractiveTransfer: actions.cancel,
  },
  errorText: (error: unknown) => String(error),
  listen: vi.fn((_name: string, callback: (event: unknown) => void) => {
    actions.progressCallback = callback;
    return () => { actions.progressCallback = null; };
  }),
}));

const ref = { tabId: "native-tab", sessionId: "session-1", generation: 3 };
beforeEach(() => {
  initializeI18n("zh-CN");
  vi.clearAllMocks();
  actions.readiness.mockResolvedValue({ ready: true, code: "ready", message: "ok" });
  actions.start.mockResolvedValue(undefined);
  actions.startBatch.mockResolvedValue(undefined);
  actions.cancel.mockResolvedValue(undefined);
  actions.progressCallback = null;
});
afterEach(cleanup);

function showDialog() {
  const onError = vi.fn();
  const dismiss = vi.fn();
  render(<NativeZmodemExperimentDialog refID={ref} sessionName="Linux"
    onError={onError} onDismiss={dismiss} />);
  return { onError, dismiss };
}

test("experiment requires file selection and explicit failure/reconnect acknowledgement", async () => {
  const { onError } = showDialog();
  const start = screen.getByRole("button", { name: "开始实验传输" }) as HTMLButtonElement;
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledWith(ref));
  expect(start.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledOnce());
  expect(start.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", {
    name: "我理解这是实验功能，出错后需要重新连接 SSH 终端",
  }));
  expect(start.disabled).toBe(false);
  fireEvent.click(start);
  await waitFor(() => expect(actions.start).toHaveBeenCalledWith(
    ref, "upload", "C:\\test\\example.bin", "",
  ));
  await waitFor(() => expect(screen.getByText("原生 ZMODEM 文件传输完成")).toBeTruthy());
  expect(onError).not.toHaveBeenCalled();
});

test("download requires remote file and local destination folder", async () => {
  showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("radio", { name: "下载文件" }));
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.downloadFolder).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  const start = screen.getByRole("button", { name: "开始实验传输" }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  fireEvent.change(screen.getByPlaceholderText("/home/user/example.bin"), {
    target: { value: "/home/test/remote.bin" },
  });
  expect(start.disabled).toBe(false);
  fireEvent.click(start);
  await waitFor(() => expect(actions.start).toHaveBeenCalledWith(
    ref, "download", "C:\\downloads", "/home/test/remote.bin",
  ));
});

test("backend not-ready status prevents interactive shell takeover", async () => {
  actions.readiness.mockResolvedValue({ ready: false, code: "needs_reconnect", message: "先重新连接" });
  showDialog();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("先重新连接"));
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  fireEvent.click(screen.getByRole("checkbox"));
  expect((screen.getByRole("button", { name: "开始实验传输" }) as HTMLButtonElement).disabled).toBe(true);
  expect(actions.start).not.toHaveBeenCalled();
});

test("active native transfer can be cancelled from the modal", async () => {
  let finish!: () => void;
  actions.start.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(actions.cancel).toHaveBeenCalledWith(ref));
  finish();
  await waitFor(() => expect(screen.getByText(/已请求取消/)).toBeTruthy());
  expect(screen.queryByText("原生 ZMODEM 文件传输完成")).toBeNull();
});

test("native progress ignores stale session generations", async () => {
  let finish!: () => void;
  actions.start.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(actions.progressCallback).not.toBeNull());
  actions.progressCallback?.({ ref: { ...ref, generation: 4 }, direction: "upload", processed: 99, total: 100 });
  expect(screen.queryByText("99%")).toBeNull();
  actions.progressCallback?.({ ref, direction: "upload", processed: 128, total: 256 });
  await waitFor(() => expect(screen.getByText("50%")).toBeTruthy());
  finish();
  await waitFor(() => expect(screen.getByRole("button", { name: "完成" })).toBeTruthy());
});

test("native transfer failure reaches error channel without showing success", async () => {
  actions.start.mockRejectedValueOnce(new Error("mock transfer rejected"));
  const { onError } = showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  expect(screen.queryByText("原生 ZMODEM 文件传输完成")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("mock transfer rejected");
});

test("failed transfer cannot retry while terminal readiness is still being checked", async () => {
  let resolveReadiness!: (status: { ready: boolean; code: string; message: string }) => void;
  actions.readiness.mockResolvedValueOnce({ ready: true, code: "ready", message: "ok" });
  actions.readiness.mockImplementationOnce(() => new Promise(resolve => { resolveReadiness = resolve; }));
  actions.start.mockRejectedValueOnce(new Error("模拟断线"));

  const { onError } = showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  const start = screen.getByRole("button", { name: "开始实验传输" }) as HTMLButtonElement;
  fireEvent.click(start);
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(start.disabled).toBe(true);
  expect(actions.start).toHaveBeenCalledTimes(1);

  resolveReadiness({ ready: false, code: "needs_reconnect", message: "需要重新连接 SSH" });
  await waitFor(() => expect(screen.getByText("需要重新连接 SSH")).toBeTruthy());
  expect(start.disabled).toBe(true);
});

test("a failed readiness refresh never re-enables a second PTY takeover", async () => {
  actions.readiness.mockResolvedValueOnce({ ready: true, code: "ready", message: "ok" });
  actions.readiness.mockRejectedValueOnce(new Error("连接状态查询失败"));
  actions.start.mockRejectedValueOnce(new Error("传输失败"));
  showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  const start = screen.getByRole("button", { name: "开始实验传输" }) as HTMLButtonElement;
  fireEvent.click(start);
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledTimes(2));
  expect(start.disabled).toBe(true);
  fireEvent.click(start);
  expect(actions.start).toHaveBeenCalledTimes(1);
});

test("a rejected cancellation is not mistaken for a confirmed cancellation", async () => {
  let finish!: () => void;
  actions.start.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  actions.cancel.mockRejectedValueOnce(new Error("取消请求未送达"));
  showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(screen.getByText(/取消请求未送达/)).toBeTruthy());
  finish();
  await waitFor(() => expect(screen.getByText("原生 ZMODEM 文件传输完成")).toBeTruthy());
  expect(screen.queryByText(/已请求取消/)).toBeNull();
});

test("progress events from other terminals or directions never affect this dialog", async () => {
  let finish!: () => void;
  actions.start.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(actions.progressCallback).not.toBeNull());
  actions.progressCallback?.({ ref: { ...ref, tabId: "different" }, direction: "upload", processed: 42, total: 100 });
  actions.progressCallback?.({ ref, direction: "download", processed: 72, total: 100 });
  expect(screen.queryByText("42%")).toBeNull();
  expect(screen.queryByText("72%")).toBeNull();
  actions.progressCallback?.({ ref, direction: "upload", processed: 30, total: 100 });
  await waitFor(() => expect(screen.getByText("30%")).toBeTruthy());
  finish();
  await waitFor(() => expect(screen.getByText("原生 ZMODEM 文件传输完成")).toBeTruthy());
});

test("auto-command download preselects the remote file without starting before consent", async () => {
  const onError = vi.fn();
  render(<NativeZmodemExperimentDialog refID={ref} sessionName="Linux"
    initialDirection="download" initialRemotePath="/tmp/report.bin"
    onError={onError} onDismiss={vi.fn()} />);
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  expect((screen.getByRole("radio", { name: "下载文件" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByPlaceholderText("/home/user/example.bin") as HTMLInputElement).value)
    .toBe("/tmp/report.bin");
  expect((screen.getByRole("button", { name: "开始实验传输" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.downloadFolder).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(actions.start).toHaveBeenCalledWith(
    ref, "download", "C:\\downloads", "/tmp/report.bin",
  ));
  expect(onError).not.toHaveBeenCalled();
});

test("native upload selects several files in one authorized protocol session", async () => {
  const { onError } = showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "选择多个文件" }));
  await waitFor(() => expect(actions.uploadFiles).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(actions.startBatch).toHaveBeenCalledWith(
    ref, "upload", ["C:\\test\\first.bin", "C:\\test\\中文 文件.bin"], [],
  ));
  expect(actions.start).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

test("native download parses multiple remote paths without shell evaluation", async () => {
  showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("radio", { name: "下载文件" }));
  fireEvent.change(screen.getByPlaceholderText("/home/user/example.bin"), {
    target: { value: "/tmp/first.bin\n/tmp/中文 文件.bin" },
  });
  fireEvent.click(screen.getByRole("button", { name: "浏览本地文件或目录" }));
  await waitFor(() => expect(actions.downloadFolder).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(actions.startBatch).toHaveBeenCalledWith(
    ref, "download", ["C:\\downloads"], ["/tmp/first.bin", "/tmp/中文 文件.bin"],
  ));
});

test("batch larger than 100 is rejected before entering the PTY", async () => {
  actions.uploadFiles.mockResolvedValueOnce(
    Array.from({ length: 101 }, (_, i) => "C:\\test\\file" + i + ".bin"),
  );
  showDialog();
  await waitFor(() => expect(actions.readiness).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "选择多个文件" }));
  await waitFor(() => expect(actions.uploadFiles).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "开始实验传输" }));
  await waitFor(() => expect(screen.getByText("每次请选择 1–100 个文件或远程路径。")).toBeTruthy());
  expect(actions.start).not.toHaveBeenCalled();
  expect(actions.startBatch).not.toHaveBeenCalled();
});
