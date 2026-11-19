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


test("ZMODEM uses selected local file sizes and stops the indeterminate bar on completion", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  const total = 100 * 1024 * 1024;
  emit("ssh:transfer-details", {
    ref: refA, transferId: "upload-1", direction: "upload", protocol: "zmodem",
    files: [{ name: "archive.bin", total }],
  });
  emit("ssh:transfer-progress", {
    ref: refA, transferId: "upload-1", transferred: "100 MB",
    speed: "11.2 MB/s", processed: total,
  });
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "upload-1", status: "completed",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));

  expect(screen.getByText("archive.bin")).toBeTruthy();
  expect(screen.getByText("100.0 MB / 100.0 MB")).toBeTruthy();
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
  expect(container.querySelector(".transfer-center-bar.indeterminate")).toBeNull();
  expect(container.querySelector(".transfer-center-bar > div")?.getAttribute("style")).toContain("width: 100%");
});

test("different transfer ids on one SSH tab do not share completion state", () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", {
    ref: refA, transferId: "transfer-a", direction: "upload", protocol: "zmodem",
    files: [{ name: "first.bin", total: 100 }],
  });
  emit("ssh:transfer-details", {
    ref: refA, transferId: "transfer-b", direction: "upload", protocol: "zmodem",
    files: [{ name: "second.bin", total: 200 }],
  });
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "transfer-a", status: "completed",
  });
  emit("ssh:transfer-progress", {
    ref: refA, transferId: "transfer-b", transferred: "50 B",
    speed: "10 B/s", processed: 50,
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));

  expect(screen.getByText("first.bin")).toBeTruthy();
  expect(screen.getByText("second.bin")).toBeTruthy();
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
  expect(screen.getByText("25%")).toBeTruthy();
});

test("remote ZMODEM file metadata is added and completed independently", () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", {
    ref: refA, transferId: "download-1", direction: "download", protocol: "zmodem",
  });
  emit("ssh:transfer-file", {
    ref: refA, transferId: "download-1", kind: "start",
    name: "remote-backup.tar", total: 200,
  });
  emit("ssh:transfer-file", {
    ref: refA, transferId: "download-1", kind: "completed",
    name: "remote-backup.tar", total: 200, processed: 200,
  });
  emit("ssh:transfer-progress", {
    ref: refA, transferId: "download-1", transferred: "200 B",
    speed: "20 B/s", processed: 200,
  });
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "download-1", status: "completed",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));

  expect(screen.getByText("remote-backup.tar")).toBeTruthy();
  expect(screen.getByText("200 B / 200 B")).toBeTruthy();
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
});

test("failed ZMODEM process is not displayed as a successful transfer", () => {
  render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", {
    ref: refA, transferId: "failed-1", direction: "download", protocol: "zmodem",
  });
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "failed-1", status: "failed",
    error: "本地 ZMODEM 进程退出，代码 1",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));

  expect(screen.getByText("失败")).toBeTruthy();
  expect(screen.getByText("本地 ZMODEM 进程退出，代码 1")).toBeTruthy();
});


test("legacy ZMODEM lifecycle events merge into the identified transfer", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  const total = 100 * 1024 * 1024;

  emit("ssh:transfer-state", { ref: refA, active: true });
  emit("ssh:transfer-progress", {
    ref: refA, transferred: "100 MB", speed: "42.9 MB/s", processed: total,
  });
  emit("ssh:transfer-details", {
    ref: refA, transferId: "zmodem-legacy-1", direction: "download", protocol: "zmodem",
    files: [{ name: "archive.bin", total }],
  });
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "zmodem-legacy-1", status: "completed",
  });

  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelectorAll(".transfer-center-job")).toHaveLength(1);
  expect(screen.getByText("archive.bin")).toBeTruthy();
  expect(screen.getByText("100.0 MB / 100.0 MB")).toBeTruthy();
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
});

test("id-less lifecycle events resolve to the only active identified transfer", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", {
    ref: refA, transferId: "zmodem-identified-1", direction: "download", protocol: "zmodem",
    files: [{ name: "backup.bin", total: 200 }],
  });
  emit("ssh:transfer-state", { ref: refA, active: true });
  emit("ssh:transfer-progress", {
    ref: refA, transferred: "200 B", speed: "20 B/s", processed: 200,
  });
  emit("ssh:transfer-state", { ref: refA, active: false, status: "completed" });

  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelectorAll(".transfer-center-job")).toHaveLength(1);
  expect(screen.getByText("backup.bin")).toBeTruthy();
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
});


test("identified lifecycle events preserve transfer direction before details arrive", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-state", {
    ref: refA, transferId: "zmodem-state-1", active: true,
    protocol: "zmodem", direction: "download",
  });

  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(screen.getByText("ZMODEM")).toBeTruthy();
  expect(container.querySelector(".transfer-center-job .lucide-arrow-down-to-line")).not.toBeNull();
});

test("new rz/sz on one SSH PTY retires prior task when its finish event was lost", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  for (const [id, size] of [["old-upload", "1.0 MB"], ["new-upload", "70 B"], ["latest", "161 KB"]] as const) {
    emit("ssh:transfer-details", {
      ref: refA, transferId: id, direction: "upload", protocol: "zmodem",
    });
    emit("ssh:transfer-progress", {
      ref: refA, transferId: id, transferred: size, speed: "10 KB/s",
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  // A terminal session runs at most one ZMODEM task at a time.
  expect(container.querySelector(".transfer-center-count")?.textContent).toBe("1");
  expect(screen.getAllByText("失败")).toHaveLength(2);
  expect(screen.getAllByText("上一笔 ZMODEM 已被新传输取代，但未收到可靠的结束确认")).toHaveLength(2);

  emit("ssh:transfer-finished", {
    ref: refA, transferId: "latest", status: "completed",
  });
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("已完成")).toBeTruthy();
});

test("explicit ZMODEM client exit status clears the active count even without a filter callback", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", {
    ref: refA, transferId: "legacy-finish", direction: "download", protocol: "zmodem",
  });
  emit("ssh:transfer-progress", {
    ref: refA, transferId: "legacy-finish", transferred: "1.0 MB", speed: "550 KB/s",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelector(".transfer-center-count")?.textContent).toBe("1");
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "legacy-finish", status: "failed", error: "本地 ZMODEM 进程退出，代码 1",
  });
  emit("ssh:transfer-state", {
    ref: refA, transferId: "legacy-finish", active: false, status: "failed",
  });
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("失败")).toBeTruthy();
});

test("a fast ZMODEM finish arriving before details cannot be reopened by late metadata", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "fast-success", status: "completed",
  });
  emit("ssh:transfer-details", {
    ref: refA, transferId: "fast-success", direction: "upload", protocol: "zmodem",
    files: [{ name: "tiny.txt", total: 70 }],
  });
  emit("ssh:transfer-progress", {
    ref: refA, transferId: "fast-success", transferred: "70 B", speed: "99 B/s",
  });
  emit("ssh:transfer-state", {
    ref: refA, transferId: "fast-success", active: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
  expect(screen.getByText("tiny.txt")).toBeTruthy();
});

test("a failed exit arriving before ZMODEM details stays failed instead of running", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-state", {
    ref: refA, transferId: "fast-failure", active: false, status: "failed",
    error: "本地 ZMODEM 进程退出，代码 1",
  });
  emit("ssh:transfer-details", {
    ref: refA, transferId: "fast-failure", direction: "upload", protocol: "zmodem",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("失败")).toBeTruthy();
  expect(screen.getByText("本地 ZMODEM 进程退出，代码 1")).toBeTruthy();
});

test("ZMODEM details cannot reset an already finished identified transfer", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-progress", {
    ref: refA, transferId: "out-of-order", transferred: "1.0 MB", speed: "549 KB/s",
  });
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "out-of-order", status: "completed",
  });
  emit("ssh:transfer-details", {
    ref: refA, transferId: "out-of-order", direction: "upload", protocol: "zmodem",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("已完成")).toBeTruthy();
});

test("id-less completion before identified details migrates its status instead of reactivating", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-state", { ref: refA, active: true, protocol: "zmodem" });
  emit("ssh:transfer-finished", { ref: refA, status: "completed" });
  emit("ssh:transfer-details", {
    ref: refA, transferId: "identified-later", direction: "upload", protocol: "zmodem",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelectorAll(".transfer-center-job")).toHaveLength(1);
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("已完成")).toBeTruthy();
});

test("identified finish can reconcile an earlier id-less progress task", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-progress", { ref: refA, transferred: "70 B", speed: "99 B/s" });
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "known-after-progress", status: "completed",
  });
  emit("ssh:transfer-details", {
    ref: refA, transferId: "known-after-progress", direction: "upload", protocol: "zmodem",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelectorAll(".transfer-center-job")).toHaveLength(1);
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("已完成")).toBeTruthy();
});

test("identified failed state can close an unmatched id-less legacy row", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-progress", {
    ref: refA, transferred: "161 KB", speed: "36 KB/s",
  });
  emit("ssh:transfer-state", {
    ref: refA, transferId: "late-identity", active: false, status: "failed",
    error: "本地 ZMODEM 进程退出，代码 1",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelectorAll(".transfer-center-job")).toHaveLength(1);
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("失败")).toBeTruthy();
});

test("late ZMODEM progress cannot resurrect a completed task after the UI cleanup", () => {
  vi.useFakeTimers();
  try {
    const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
    emit("ssh:transfer-details", {
      ref: refA, transferId: "completed-then-late-progress",
      direction: "download", protocol: "zmodem",
    });
    emit("ssh:transfer-progress", {
      ref: refA, transferId: "completed-then-late-progress",
      transferred: "301 MB", speed: "49.6 MB/s",
    });
    emit("ssh:transfer-finished", {
      ref: refA, transferId: "completed-then-late-progress",
      status: "completed",
    });
    act(() => vi.advanceTimersByTime(25000));
    emit("ssh:transfer-progress", {
      ref: refA, transferId: "completed-then-late-progress",
      transferred: "301 MB", speed: "49.6 MB/s",
    });
    emit("ssh:transfer-state", {
      ref: refA, transferId: "completed-then-late-progress", active: true,
    });
    expect(container.querySelector(".transfer-center-count")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
    expect(container.querySelector(".transfer-center-job")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("legacy Ctrl+C stop is shown as cancelling then cancelled, not forever transferring", () => {
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", {
    ref: refA, transferId: "stopped-1", direction: "upload", protocol: "zmodem",
  });
  emit("ssh:transfer-state", {
    ref: refA, transferId: "stopped-1", active: true, status: "cancelling",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  expect(container.querySelector(".transfer-center-count")?.textContent).toBe("1");
  emit("ssh:transfer-finished", {
    ref: refA, transferId: "stopped-1", status: "cancelled",
  });
  emit("ssh:transfer-state", {
    ref: refA, transferId: "stopped-1", active: false, status: "cancelled",
  });
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText("已取消")).toBeTruthy();
});

test("a refused legacy cancellation does not restore an already stale task to running", async () => {
  vi.mocked(api.CancelZmodem).mockRejectedValueOnce(new Error("no active transfer"));
  const { container } = render(<TransferCenter tabs={tabs} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", {
    ref: refA, transferId: "stale-cancel", direction: "download", protocol: "zmodem",
  });
  fireEvent.click(screen.getByRole("button", { name: "传输任务" }));
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(screen.getByText("失败")).toBeTruthy());
  expect(container.querySelector(".transfer-center-count")).toBeNull();
  expect(screen.getByText(/取消请求未确认/)).toBeTruthy();
});
