import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import type { Ref, Tab } from "../types";
import TransferCenter from "./TransferCenter";

const events = vi.hoisted(() => ({ callbacks: new Map<string, (value: any) => void>() }));
vi.mock("../bridge", () => ({
  api: {
    SFTPTransfers: vi.fn(async () => []),
    SFTPCancel: vi.fn(async () => {}),
    SFTPTransfer: vi.fn(async () => {}),
    CancelZmodem: vi.fn(async () => {}),
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
