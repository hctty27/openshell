import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useTransferTasks } from "./useTransferTasks";
import type { Ref } from "../../types";

const events = vi.hoisted(() => ({
  listeners: new Map<string, Set<(payload: any) => void>>(),
}));
vi.mock("../../bridge", () => ({
  desktop: false,
  api: {},
  listen: (name: string, callback: (payload: any) => void) => {
    const callbacks = events.listeners.get(name) ?? new Set();
    callbacks.add(callback);
    events.listeners.set(name, callbacks);
    return () => { callbacks.delete(callback); };
  },
}));

const ref: Ref = { tabId: "tab-1", sessionId: "server-1", generation: 1 };

function emit(name: string, payload: unknown) {
  act(() => {
    for (const callback of events.listeners.get(name) ?? []) callback(payload);
  });
}

let transfer!: ReturnType<typeof useTransferTasks>;
function Probe() {
  transfer = useTransferTasks(ref);
  return <span data-testid="active">{String(transfer.zmodemActive)}</span>;
}

beforeEach(() => events.listeners.clear());
afterEach(cleanup);

test("transfer dock ignores late events from a previous ZMODEM transfer", () => {
  render(<Probe />);
  emit("ssh:transfer-details", { ref, transferId: "transfer-1", direction: "upload" });
  expect(screen.getByTestId("active").textContent).toBe("true");

  emit("ssh:transfer-finished", { ref, transferId: "transfer-1", status: "completed" });
  expect(screen.getByTestId("active").textContent).toBe("false");

  emit("ssh:transfer-details", { ref, transferId: "transfer-2", direction: "download" });
  expect(screen.getByTestId("active").textContent).toBe("true");

  emit("ssh:transfer-state", { ref, transferId: "transfer-1", active: false });
  emit("ssh:transfer-finished", { ref, transferId: "transfer-1", status: "failed" });
  expect(screen.getByTestId("active").textContent).toBe("true");

  emit("ssh:transfer-progress", {
    ref, transferId: "transfer-2", transferred: "5 MB", speed: "1 MB/s",
  });
  expect(transfer.zmodemStats).toEqual({ transferred: "5 MB", speed: "1 MB/s" });

  emit("ssh:transfer-finished", { ref, transferId: "transfer-2", status: "completed" });
  expect(screen.getByTestId("active").textContent).toBe("false");
});

test("disconnect clears the transfer dock state", () => {
  render(<Probe />);
  emit("ssh:transfer-details", { ref, transferId: "transfer-1", direction: "upload" });
  emit("ssh:disconnected", ref);
  expect(screen.getByTestId("active").textContent).toBe("false");
  expect(transfer.zmodemStats).toBeNull();
});
