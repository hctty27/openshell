import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import type { Ref, Tab } from "../types";
import TransferCenter from "./TransferCenter";

const events = vi.hoisted(() => ({ callbacks: new Map<string, (value: any) => void>() }));
vi.mock("../bridge", () => ({
  desktop: true,
  api: {
    SFTPTransfers: vi.fn(async () => []),
    SFTPConcurrency: vi.fn(async () => 3),
    SetSFTPConcurrency: vi.fn(async () => {}),
    SFTPCancelBatch: vi.fn(async () => {}),
    SFTPCancel: vi.fn(async () => {}),
    SFTPTransfer: vi.fn(async () => {}),
    CancelNativeZmodemInteractiveTransfer: vi.fn(async () => {}),
  },
  listen: (name: string, callback: (value: any) => void) => {
    events.callbacks.set(name, callback);
    return () => events.callbacks.delete(name);
  },
  errorText: (error: unknown) => String(error),
}));

const refA: Ref = { tabId: "tab-a", sessionId: "server-a", generation: 1 };
const refB: Ref = { tabId: "tab-b", sessionId: "server-b", generation: 1 };
const tabs = [
  { id: "tab-a", ref: refA, session: { name: "Server A" } },
  { id: "tab-b", ref: refB, session: { name: "Server B" } },
] as Tab[];
const emit = (name: string, value: unknown) =>
  act(() => { events.callbacks.get(name)?.(value); });

beforeEach(async () => {
  events.callbacks.clear();
  vi.clearAllMocks();
  await initializeI18n("zh-CN");
});
afterEach(cleanup);

test("only native ZMODEM events create terminal transfer tasks", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-state", { ref: refA, active: true, protocol: "trzsz" });
  emit("ssh:transfer-details", { ref: refA, direction: "upload", protocol: "zmodem" });
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "one", direction: "upload", active: true,
    files: [{ name: "native.bin", total: 4096 }],
  });
  emit("ssh:native-zmodem-batch", {
    ref: refB, id: "two", direction: "download", active: true,
    files: [{ name: "other.bin", total: 8192 }],
  });
  expect(container.querySelector(".transfer-center-count")?.textContent).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("native.bin")).toBeTruthy();
  expect(screen.getByText("other.bin")).toBeTruthy();
});

test("badge counts only active jobs while failed transfers remain visible", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  const toggle = screen.getByRole("button", { name: "传输任务" });
  const badge = () => container.querySelector(".transfer-center-count");

  expect(badge()).toBeNull();
  const task = {
    id: "badge-job", ref: refA, direction: "upload", source: "C:\\file.zip",
    destination: "/tmp/file.zip", name: "file.zip", bytes: 0, total: 100,
    status: "queued", overwrite: false, resume: false, error: "", created: 11,
  };
  emit("sftp:transfer", task);
  expect(badge()?.textContent).toBe("1");

  emit("sftp:transfer", { ...task, status: "running", bytes: 50 });
  expect(badge()?.textContent).toBe("1");

  emit("sftp:transfer", { ...task, status: "failed", error: "connection lost" });
  expect(badge()).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText("file.zip")).toBeTruthy();
  expect(container.querySelector(".transfer-center-line button")).not.toBeNull();
});

test("native ZMODEM renders one file and does not report completion before remote confirmation", () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "transfer-1", direction: "upload", active: true,
    files: [{ name: "a.bin", total: 100 }],
  });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "transfer-1", kind: "start", index: 0,
    name: "a.bin", total: 100, processed: 0,
  });
  emit("ssh:native-zmodem-progress", {
    ref: refA, batchId: "transfer-1", processed: 100, total: 100,
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("a.bin")).toBeTruthy();
  expect(screen.getByText("等待远端确认")).toBeTruthy();
  expect(screen.queryByText("100%")).toBeNull();
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "transfer-1", direction: "upload", active: false,
  });
  expect(screen.getByText("已完成")).toBeTruthy();
});

test("native ZMODEM confirmed cancellation is distinct from failed transfers", async () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "transfer-cancel", direction: "upload", active: true,
    files: [{ name: "single.txt", total: 100 }],
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(api.CancelNativeZmodemInteractiveTransfer).toHaveBeenCalledWith(refA));
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "transfer-cancel", direction: "upload", active: false,
    cancelled: true, terminalSafe: true, error: "原生 ZMODEM 已中止，终端已安全恢复",
  });
  expect(screen.getByText("已取消")).toBeTruthy();
  expect(screen.queryByText("100%")).toBeNull();
});

test("native timeout must not masquerade as a user cancellation", async () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "transfer-timeout", direction: "upload", active: true,
    files: [{ name: "timeout.bin", total: 1024 }],
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "transfer-timeout", direction: "upload", active: false,
    cancelled: false, terminalSafe: false, error: "原生传输超时，终端需要重新连接",
  });
  expect(screen.getByText("失败")).toBeTruthy();
});

test("SFTP batch cancellation is scoped and concurrency is saved", async () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  const task = {
    id: "sftp-batch-job-1", batchId: "batch-99", ref: refA,
    direction: "upload" as const, source: "C:/a.txt", destination: "/tmp/a.txt",
    name: "a.txt", bytes: 50, total: 100, status: "running" as const,
    overwrite: false, resume: true, error: "", created: 20,
  };
  emit("sftp:transfer", task);
  emit("sftp:transfer", {
    ...task, id: "sftp-batch-job-2", source: "C:/b.txt", destination: "/tmp/b.txt",
    name: "b.txt", bytes: 0, status: "queued",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("SFTP · 2 个文件")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消整批" }));
  await waitFor(() => expect(api.SFTPCancelBatch).toHaveBeenCalledWith(refA, "batch-99"));
  const selector = screen.getByRole("combobox", { name: "SFTP 并发数" });
  fireEvent.change(selector, { target: { value: "4" } });
  await waitFor(() => expect(api.SetSFTPConcurrency).toHaveBeenCalledWith(4));
});




test("late native start cannot revive a task after its terminal outcome", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  const begin = {
    ref: refA, id: "finished-first", sequence: 101, direction: "upload",
    active: true, files: [{ name: "done.bin", total: 100 }],
  };
  // Async UI callbacks are not guaranteed to arrive in backend emit order.
  emit("ssh:native-zmodem-batch", { ...begin, active: false });
  emit("ssh:native-zmodem-batch", begin);
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.queryByText("done.bin")).toBeNull();
});

test("older native event cannot replace a newer SSH transfer", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  const oldTask = {
    ref: refA, id: "old-task", sequence: 201, direction: "upload",
    active: true, files: [{ name: "old.bin", total: 100 }],
  };
  const newTask = {
    ref: refA, id: "new-task", sequence: 202, direction: "download",
    active: true, files: [{ name: "new.bin", total: 100 }],
  };
  emit("ssh:native-zmodem-batch", oldTask);
  emit("ssh:native-zmodem-batch", { ...oldTask, active: false });
  emit("ssh:native-zmodem-batch", newTask);
  emit("ssh:native-zmodem-batch", oldTask);
  emit("ssh:native-zmodem-batch", { ...oldTask, active: false });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "old-task", kind: "completed", index: 0, processed: 100,
  });
  emit("ssh:native-zmodem-progress", {
    ref: refA, batchId: "old-task", processed: 100, total: 100,
  });
  expect(container.querySelector(".transfer-center-count")?.textContent).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("new.bin")).toBeTruthy();
  expect(screen.queryByText("old.bin")).toBeNull();
  emit("ssh:native-zmodem-batch", { ...newTask, active: false });
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  emit("ssh:native-zmodem-batch", newTask);
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("已完成")).toBeTruthy();
});

test("native cancel error from a previous task cannot fail the next transfer", async () => {
  let failCancel!: (err: Error) => void;
  vi.mocked(api.CancelNativeZmodemInteractiveTransfer).mockImplementationOnce(
    () => new Promise<void>((_resolve, reject) => { failCancel = reject; }),
  );
  const onNotice = vi.fn();
  const { container } = render(<TransferCenter tabs={tabs} onNotice={onNotice} />);
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "cancel-old", sequence: 300, direction: "upload", active: true,
    files: [{ name: "cancel-old.bin", total: 10 }],
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "cancel-old", sequence: 300, direction: "upload", active: false,
    cancelled: true, terminalSafe: true,
  });
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "next-task", sequence: 301, direction: "download", active: true,
    files: [{ name: "next.bin", total: 10 }],
  });
  await act(async () => { failCancel(new Error("previous cancellation rejected")); });
  expect(onNotice).toHaveBeenCalled();
  expect(container.querySelector(".transfer-center-count")?.textContent).toBe("1");
  expect(screen.getByText("next.bin")).toBeTruthy();
  expect(screen.queryByText(/取消请求未确认/)).toBeNull();
});


test("native progress is monotonic and stops at 99 percent before remote confirmation", () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "progress-task", sequence: 808, direction: "upload",
    active: true, files: [{ name: "large.bin", total: 100 }],
  });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "progress-task", kind: "start", index: 0,
    name: "large.bin", total: 100, processed: 0,
  });
  emit("ssh:native-zmodem-progress", {
    ref: refA, batchId: "progress-task", processed: 80, total: 100,
  });
  emit("ssh:native-zmodem-progress", {
    ref: refA, batchId: "progress-task", processed: 20, total: 100,
  });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "progress-task", kind: "completed", index: 0,
    processed: 100,
  });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "progress-task", kind: "progress", index: 0,
    processed: 20,
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("100 B / 100 B")).toBeTruthy();
  expect(screen.getByText("等待远端确认")).toBeTruthy();
  expect(screen.queryByText("100%")).toBeNull();

  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "progress-task", sequence: 808, direction: "upload", active: false,
  });
  expect(screen.getByText("已完成")).toBeTruthy();
});
