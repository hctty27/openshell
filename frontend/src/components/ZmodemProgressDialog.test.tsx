import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import type { Ref } from "../types";
import ZmodemProgressDialog from "./ZmodemProgressDialog";

const events = vi.hoisted(() => ({ callbacks: new Map<string, (payload: any) => void>() }));
vi.mock("../bridge", () => ({
  api: { CancelZmodem: vi.fn(async () => {}) },
  listen: (name: string, callback: (payload: any) => void) => {
    events.callbacks.set(name, callback);
    return () => events.callbacks.delete(name);
  },
}));

const ref: Ref = { tabId: "tab-1", sessionId: "session-1", generation: 1 };
const other: Ref = { tabId: "tab-2", sessionId: "session-2", generation: 1 };
const emit = (name: string, payload: unknown) =>
  act(() => { events.callbacks.get(name)?.(payload); });

beforeEach(async () => {
  events.callbacks.clear();
  vi.clearAllMocks();
  await initializeI18n("zh-CN");
});
afterEach(cleanup);

test("native file picker is not obscured before real transfer progress", () => {
  render(<ZmodemProgressDialog activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:transfer-details", { ref, direction: "upload" });
  emit("ssh:transfer-state", { ref, active: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  emit("ssh:transfer-progress", { ref, transferred: "2 MB", speed: "1 MB/s" });
  expect(screen.getByRole("dialog", { name: "ZMODEM 发送" })).toBeTruthy();
  expect(screen.getByText("2 MB")).toBeTruthy();
  expect(screen.getByText("1 MB/s")).toBeTruthy();
  expect(screen.getAllByText("ZMODEM 暂未提供")).toHaveLength(2);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
});

test("window can be hidden and reopened without cancelling the transfer", () => {
  render(<ZmodemProgressDialog activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:transfer-state", { ref, active: true });
  emit("ssh:transfer-progress", { ref, transferred: "3 MB", speed: "1 MB/s" });
  fireEvent.click(screen.getByRole("button", { name: "隐藏进度窗口" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "显示 ZMODEM 传输进度" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(api.CancelZmodem).not.toHaveBeenCalled();
});

test("cancel is scoped to current connection", async () => {
  render(<ZmodemProgressDialog activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:transfer-state", { ref, active: true });
  emit("ssh:transfer-progress", { ref, transferred: "3 MB", speed: "1 MB/s" });
  fireEvent.click(screen.getByRole("button", { name: "取消传输" }));
  await waitFor(() => expect(api.CancelZmodem).toHaveBeenCalledWith(ref));
  emit("ssh:transfer-state", { ref, active: false });
  expect(screen.getByText("传输已取消")).toBeTruthy();
});

test("default auto-close hides the dialog without asserting success", () => {
  render(<ZmodemProgressDialog activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:transfer-state", { ref, active: true });
  emit("ssh:transfer-progress", { ref, transferred: "3 MB", speed: "1 MB/s" });
  emit("ssh:transfer-state", { ref, active: false });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("other tab events never open this tab's dialog", () => {
  render(<ZmodemProgressDialog activeRef={ref} onNotice={vi.fn()} />);
  emit("ssh:transfer-state", { ref: other, active: true });
  emit("ssh:transfer-progress", { ref: other, transferred: "1 MB", speed: "1 MB/s" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
