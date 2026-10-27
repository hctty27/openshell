import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AutoEvent, AutoSnapshot, Ref, Tab } from "../../types";
import { useAutomaticEventHandlers } from "./useAutomaticEventHandlers";

const listeners = vi.hoisted(() => new Map<string, Set<(payload: any) => void>>());

vi.mock("../../bridge", () => ({
  listen: (name: string, callback: (payload: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(callback);
    return () => listeners.get(name)?.delete(callback);
  },
}));

const ref: Ref = { tabId: "tab-1", sessionId: "server-1", generation: 1 };

const snapshot = (status: AutoSnapshot["status"] = "running"): AutoSnapshot => ({
  id: "run-1", ref, status, steps: 1, roundSteps: 1,
  limit: 10, allowChanges: false, reason: "",
});

function tab(overrides: Partial<Tab> = {}): Tab {
  const run = snapshot();
  return {
    id: ref.tabId,
    session: {
      id: ref.sessionId, groupId: "", name: "SSH", host: "127.0.0.1",
      port: 22, username: "root", authType: "key",
      privateKeyPath: "", credentialRef: "",
    },
    ref, status: "connected", home: "/root", cwd: "/root",
    messages: [], proposal: null, autoRun: run, chatBusy: false,
    executing: false, error: "", ...overrides,
  };
}

function setup(initial = tab()) {
  let current = initial;
  const streamIDs = { current: {} as Record<string, string> };
  const update = vi.fn((id: string, change: (tab: Tab) => Tab) => {
    if (id === current.id) current = change(current);
  });
  const view = renderHook(() => useAutomaticEventHandlers({ streamIDs, update }));
  const emit = (name: string, payload: unknown) => {
    act(() => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    });
  };
  return { ...view, emit, get current() { return current; }, streamIDs, update };
}

beforeEach(() => listeners.clear());
afterEach(cleanup);

test("thinking, text streaming and reply update the active message", () => {
  const x = setup();
  x.emit("auto:event", { kind: "thinking", state: snapshot(), messageId: "m-1" } satisfies AutoEvent);
  expect(x.streamIDs.current[ref.tabId]).toBe("m-1");
  expect(x.current.messages).toMatchObject([{ id: "m-1", role: "assistant", text: "" }]);
  x.emit("ai:delta", { ref, text: "Hello" });
  expect(x.current.messages[0].text).toBe("Hello");
  x.emit("auto:event", {
    kind: "reply", state: snapshot(), messageId: "m-1", text: "Done",
  } satisfies AutoEvent);
  expect(x.current.messages[0].text).toBe("Done");
  expect(x.current.chatBusy).toBe(false);
});

test("stale task and old generation events cannot mutate a newer session", () => {
  const x = setup();
  x.emit("auto:event", {
    kind: "thinking", state: { ...snapshot(), id: "old-run" }, messageId: "stale",
  } satisfies AutoEvent);
  expect(x.current.messages).toEqual([]);
  x.emit("auto:event", { kind: "thinking", state: snapshot(), messageId: "m-1" } satisfies AutoEvent);
  x.emit("ai:delta", { ref: { ...ref, generation: 0 }, text: "stale" });
  expect(x.current.messages[0].text).toBe("");
});

test("terminal events clear stream tracking and keep persisted conversation messages", () => {
  const x = setup(tab({
    conversationID: "chat-1",
    messages: [{ id: "saved", role: "assistant", text: "Persisted" }],
  }));
  x.emit("auto:event", { kind: "thinking", state: snapshot(), messageId: "m-1" } satisfies AutoEvent);
  expect(x.current.messages).toEqual([{ id: "saved", role: "assistant", text: "Persisted" }]);
  x.emit("auto:event", {
    kind: "reply", state: snapshot("completed"), messageId: "m-1", text: "complete",
  } satisfies AutoEvent);
  expect(x.streamIDs.current[ref.tabId]).toBeUndefined();
  expect(x.current.messages).toEqual([{ id: "saved", role: "assistant", text: "Persisted" }]);
});

test("listeners are removed when the hook unmounts", () => {
  const x = setup();
  expect(listeners.get("auto:event")?.size).toBe(1);
  expect(listeners.get("ai:delta")?.size).toBe(1);
  x.unmount();
  expect(listeners.get("auto:event")?.size).toBe(0);
  expect(listeners.get("ai:delta")?.size).toBe(0);
});
