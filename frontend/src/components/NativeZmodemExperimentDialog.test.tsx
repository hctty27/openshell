import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import NativeZmodemExperimentDialog from "./NativeZmodemExperimentDialog";

const actions = vi.hoisted(() => ({
  readiness: vi.fn(async () => ({ ready: true, code: "ready", message: "ok" })),
  uploadFile: vi.fn(async () => "C:\\test\\example.bin"),
  downloadFolder: vi.fn(async () => "C:\\downloads"),
  start: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  progressCallback: null as ((event: unknown) => void) | null,
}));
vi.mock("../bridge", () => ({
  api: {
    NativeZmodemInteractiveReadiness: actions.readiness,
    NativeZmodemChooseUploadFile: actions.uploadFile,
    SFTPChooseDirectory: actions.downloadFolder,
    StartNativeZmodemInteractiveTransfer: actions.start,
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
