import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../bridge";
import type { DiagnosticsSnapshot } from "../features/diagnostics/types";
import DiagnosticsSettingsPanel from "./DiagnosticsSettingsPanel";

vi.mock("../bridge", () => ({
  api: {
    DiagnosticsSnapshot: vi.fn(),
    DiagnosticsExport: vi.fn(),
  },
}));

const snapshot: DiagnosticsSnapshot = {
  startedAt: "2026-11-05T09:00:00+08:00",
  heapBytes: 1677722,
  goroutines: 43,
  recorded: 65,
  dropped: 0,
  diskEnabled: true,
  events: [
    {
      time: "2026-11-05T09:48:23+08:00",
      level: "INFO",
      module: "sftp",
      operation: "SFTPList",
      status: "ok",
      durationMs: 254,
    },
    {
      time: "2026-11-05T09:48:24+08:00",
      level: "WARN",
      module: "terminal",
      operation: "write",
      status: "slow",
      durationMs: 780,
    },
  ],
  operations: [
    { module: "sftp", operation: "SFTPList", count: 10, p50Ms: 8, p95Ms: 254, maxMs: 300 },
    { module: "terminal", operation: "write", count: 20, p50Ms: 1, p95Ms: 30, maxMs: 70 },
  ],
};

beforeEach(async () => {
  await initializeI18n("zh-CN");
  vi.mocked(api.DiagnosticsSnapshot).mockResolvedValue(snapshot);
  vi.mocked(api.DiagnosticsExport).mockResolvedValue("C:/diagnostics.zip");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("diagnostics overview renders four separate metric cards", async () => {
  const { container } = render(<DiagnosticsSettingsPanel />);

  expect(await screen.findByText("1.6 MiB")).toBeTruthy();
  expect(screen.getByText("43")).toBeTruthy();
  expect(screen.getByText("65")).toBeTruthy();
  expect(container.querySelectorAll(".settings-diagnostics-metric")).toHaveLength(4);
  expect(within(container.querySelector(".settings-diagnostics-toolbar") as HTMLElement).getAllByRole("button")).toHaveLength(2);
});

test("diagnostics logs show status and duration without mixing in the toolbar", async () => {
  const { container } = render(<DiagnosticsSettingsPanel />);
  await screen.findByText("1.6 MiB");
  fireEvent.click(screen.getByRole("tab", { name: "日志" }));

  expect(screen.getByText("sftp/SFTPList")).toBeTruthy();
  expect(screen.getByText("terminal/write")).toBeTruthy();
  expect(screen.getByText("780 ms")).toBeTruthy();
  expect(container.querySelector('[data-status="slow"]')).toBeTruthy();
  expect(container.querySelector(".settings-diagnostics-list .settings-diagnostics-toolbar")).toBeNull();
});

test("diagnostics performance shows P50, P95 and MAX", async () => {
  render(<DiagnosticsSettingsPanel />);
  await screen.findByText("1.6 MiB");
  fireEvent.click(screen.getByRole("tab", { name: "性能" }));

  expect(screen.getAllByText("P50")).toHaveLength(2);
  expect(screen.getAllByText("P95")).toHaveLength(2);
  expect(screen.getAllByText("MAX")).toHaveLength(2);
});

test("diagnostics export still calls the native ZIP API", async () => {
  render(<DiagnosticsSettingsPanel />);
  await screen.findByText("1.6 MiB");
  fireEvent.click(screen.getByRole("button", { name: "导出诊断 ZIP" }));

  await waitFor(() => expect(api.DiagnosticsExport).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/C:\/diagnostics.zip/)).toBeTruthy();
});
