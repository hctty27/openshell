import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor, cleanup } from "@testing-library/react";
import TransferDock from "./TransferDock";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import type { Ref, SFTPTask } from "../types";

const events = vi.hoisted(() => ({ callbacks: new Map<string, (data: any) => void>() }));
vi.mock("../bridge", () => ({
  api: {
    SFTPTransfers: vi.fn(async () => []),
    SFTPCancel: vi.fn(async () => {}),
    SFTPTransfer: vi.fn(async () => {}),
    CancelZmodem: vi.fn(async () => {}),
  },
  listen: (name: string, handler: (payload: any) => void) => {
    events.callbacks.set(name, handler);
    return () => events.callbacks.delete(name);
  },
  errorText: (reason: unknown) => String(reason),
}));
const ref: Ref = { tabId: "tab-a", sessionId: "server-a", generation: 1 };
const task: SFTPTask = {
  id: "upload-1", ref, direction: "upload", source: "C:\\logs\\app.log",
  destination: "/home/root/app.log", name: "app.log", status: "running",
  bytes: 512, total: 1024, overwrite: false, resume: false,
  error: "", created: 5,
};
beforeEach(async () => {
  await initializeI18n("zh-CN");
  events.callbacks.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

test("SFTP tasks remain in the shared dock and cancellation retains session scope", async () => {
  render(<TransferDock refID={ref} onNotice={vi.fn()} />);
  act(() => events.callbacks.get("sftp:transfer")?.(task));
  expect(screen.getByText("app.log")).toBeTruthy();
  expect(screen.getByText(/50%/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(api.SFTPCancel).toHaveBeenCalledWith("upload-1"));
  act(() => events.callbacks.get("sftp:transfer")?.({ ...task, status: "completed", bytes: 1024 }));
  expect(screen.getByText("已完成")).toBeTruthy();
});

test("ZMODEM closing without an active transfer does not create false completion", () => {
  render(<TransferDock refID={ref} onNotice={vi.fn()} />);
  act(() => events.callbacks.get("ssh:transfer-state")?.({ ref, active: false }));
  expect(screen.queryByText("传输流程已退出")).toBeNull();
});

test("ZMODEM progress and cancellation do not claim unverified success", async () => {
  render(<TransferDock refID={ref} onNotice={vi.fn()} />);
  act(() => events.callbacks.get("ssh:transfer-state")?.({ ref, active: true }));
  act(() => events.callbacks.get("ssh:transfer-progress")?.({
    ref, transferred: "2.3 MB", speed: "1.2 MB/s",
  }));
  expect(screen.getByText("2.3 MB · 1.2 MB/s")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(api.CancelZmodem).toHaveBeenCalledWith(ref));
  act(() => events.callbacks.get("ssh:transfer-state")?.({ ref, active: false }));
  expect(screen.getByText("传输流程已退出")).toBeTruthy();
  expect(screen.getByText("请查看终端确认结果")).toBeTruthy();
});

test("empty SFTP sidebar reserves only the collapsed transfer footer", () => {
  render(<TransferDock refID={ref} onNotice={vi.fn()} alwaysVisible />);
  const heading = screen.getByRole("button", { name: /传输任务/ });
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(heading);
  expect(screen.getByText("暂无传输任务")).toBeTruthy();
});


test("ZMODEM status stops on local child exit without waiting for a remote callback", () => {
  render(<TransferDock refID={ref} onNotice={vi.fn()} />);
  act(() => events.callbacks.get("ssh:transfer-state")?.({ ref, active: true }));
  act(() => events.callbacks.get("ssh:transfer-progress")?.({
    ref, transferred: "21.8 MB", speed: "11.4 MB/s",
  }));
  expect(screen.getByText("21.8 MB · 11.4 MB/s")).toBeTruthy();
  act(() => events.callbacks.get("ssh:transfer-finished")?.({ ref }));
  expect(screen.queryByText("21.8 MB · 11.4 MB/s")).toBeNull();
  expect(screen.getByText("传输流程已退出")).toBeTruthy();
});
