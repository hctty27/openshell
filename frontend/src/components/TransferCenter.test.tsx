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
    CancelZmodem: vi.fn(async () => {}),
    CancelNativeZmodemInteractiveTransfer: vi.fn(async () => {}),
    SkipNativeZmodemPendingFile: vi.fn(async () => {}),
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

test("native progress belongs to A even while B is present in the workspace", async () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", { ref: refA, direction: "upload", protocol: "trzsz" });
  emit("ssh:transfer-state", { ref: refA, active: true });
  emit("ssh:transfer-progress", {
    ref: refA, protocol: "trzsz", percent: 63, transferred: "63 MB", speed: "2.3 MB/s",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("Server A")).toBeTruthy();
  expect(screen.getByText("63%")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(api.CancelZmodem).toHaveBeenCalledWith(refA));
});

test("legacy ZMODEM has an indeterminate bar, never an invented percentage", () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", { ref: refA, direction: "download", protocol: "zmodem" });
  emit("ssh:transfer-progress", { ref: refA, transferred: "1.2 MB", speed: "800 KB/s" });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("ZMODEM")).toBeTruthy();
  expect(screen.getByText("1.2 MB · 800 KB/s")).toBeTruthy();
  expect(document.querySelector(".transfer-center-bar.indeterminate")).not.toBeNull();
});

test("SFTP and terminal transfers share the same center", () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", { ref: refA, direction: "upload", protocol: "zmodem" });
  emit("sftp:transfer", {
    id: "job-b", ref: refB, direction: "download", source: "/tmp/file.zip",
    destination: "C:\\file.zip", name: "file.zip", bytes: 50, total: 100,
    status: "running", overwrite: false, resume: false, error: "", created: 10,
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("Server A")).toBeTruthy();
  expect(screen.getByText("Server B")).toBeTruthy();
  expect(screen.getByText("50%")).toBeTruthy();
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

test("native ZMODEM batch renders separate files and real byte progress", () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "batch-1", direction: "upload", active: true,
    files: [{ name: "a.bin", total: 100 }, { name: "b.bin", total: 200 }],
  });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "batch-1", kind: "start", index: 0,
    name: "a.bin", total: 100, processed: 0,
  });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "batch-1", kind: "completed", index: 0,
    processed: 100,
  });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "batch-1", kind: "start", index: 1,
    name: "b.bin", total: 200,
  });
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "batch-1", kind: "progress", index: 1,
    processed: 100,
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("a.bin")).toBeTruthy();
  expect(screen.getByText("b.bin")).toBeTruthy();
  expect(screen.getByText("ZMODEM · 2 个文件")).toBeTruthy();
  expect(screen.getByText("67%")).toBeTruthy();
});

test("skip queued rz upload file without cancelling the entire batch", async () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:native-zmodem-batch", {
    ref: refA, id: "skip-batch", direction: "upload", active: true,
    files: [{ name: "first.txt", total: 100 }, { name: "second.txt", total: 200 }],
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  fireEvent.click(screen.getByRole("button", { name: "跳过 second.txt" }));
  await waitFor(() => expect(api.SkipNativeZmodemPendingFile)
    .toHaveBeenCalledWith(refA, "skip-batch", 1));
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "skip-batch", kind: "skip-requested", index: 1,
  });
  expect(screen.getByText("正在跳过")).toBeTruthy();
  emit("ssh:native-zmodem-file", {
    ref: refA, batchId: "skip-batch", kind: "skipped", index: 1, processed: 0,
  });
  expect(screen.getByText("已跳过")).toBeTruthy();
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
