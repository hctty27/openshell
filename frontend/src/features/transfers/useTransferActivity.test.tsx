import { act, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useTransferActivity } from "./useTransferActivity";
import type { Ref, SFTPTask } from "../../types";

const events = vi.hoisted(() => ({ listeners: new Map<string, Set<(payload: any) => void>>() }));
vi.mock("../../bridge", () => ({
  listen: (name: string, callback: (payload: any) => void) => {
    const callbacks = events.listeners.get(name) ?? new Set();
    callbacks.add(callback);
    events.listeners.set(name, callbacks);
    return () => { callbacks.delete(callback); };
  },
}));
const ref: Ref = { tabId: "tab-1", sessionId: "server-1", generation: 1 };
const nextRef: Ref = { ...ref, generation: 2 };

function emit(name: string, payload: unknown) {
  act(() => {
    for (const callback of events.listeners.get(name) ?? []) callback(payload);
  });
}
let activity: ReturnType<typeof useTransferActivity>;
function Probe() {
  activity = useTransferActivity();
  return <span data-testid="activity">ready</span>;
}
beforeEach(() => events.listeners.clear());
afterEach(cleanup);

test("active SFTP tasks are scoped by the full connection reference", () => {
  render(<Probe />);
  expect(screen.getByTestId("activity")).toBeTruthy();
  const task = { id: "upload-1", ref, status: "queued" } as SFTPTask;
  emit("sftp:transfer", task);
  expect(activity.hasActiveTransfers(ref)).toBe(true);
  expect(activity.hasActiveTransfers(nextRef)).toBe(false);
  emit("sftp:transfer", { ...task, status: "completed" });
  expect(activity.hasActiveTransfers(ref)).toBe(false);
});

test("ZMODEM completion ignores late start events and accepts the next handshake", () => {
  render(<Probe />);
  emit("ssh:transfer-state", { ref, active: true });
  expect(activity.hasActiveTransfers(ref)).toBe(true);
  emit("ssh:transfer-finished", { ref });
  emit("ssh:transfer-state", { ref, active: true });
  expect(activity.hasActiveTransfers(ref)).toBe(false);
  emit("ssh:transfer-details", { ref, direction: "upload" });
  emit("ssh:transfer-state", { ref, active: true });
  expect(activity.hasActiveTransfers(ref)).toBe(true);
  emit("ssh:disconnected", ref);
  expect(activity.hasActiveTransfers(ref)).toBe(false);
  expect(activity.hasActiveTransfers(nextRef)).toBe(false);
});

test("listeners are unregistered on unmount", () => {
  const { unmount } = render(<Probe />);
  unmount();
  for (const callbacks of events.listeners.values()) expect(callbacks.size).toBe(0);
});
