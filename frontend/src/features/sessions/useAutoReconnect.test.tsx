import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../../bridge";
import type { Tab } from "../../types";
import { useAutoReconnect } from "./useAutoReconnect";

vi.mock("../../bridge", () => ({
  api: { Reconnect: vi.fn(), Disconnect: vi.fn() },
}));

const ref = { tabId: "tab-1", sessionId: "server-1", generation: 1 };

function reconnectingTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: ref.tabId,
    session: {
      id: ref.sessionId, groupId: "", name: "Test SSH", host: "127.0.0.1",
      port: 22, username: "root", authType: "key", privateKeyPath: "",
      credentialRef: "",
    },
    ref, status: "reconnecting", home: "/root", cwd: "/root",
    messages: [], proposal: null, chatBusy: false, executing: false, error: "",
    ...overrides,
  };
}

function setup(tab = reconnectingTab(), options: { enabled?: boolean; maxRetries?: number } = {}) {
  const tabs = [tab];
  const tabsRef = { current: tabs };
  const update = vi.fn((id: string, change: (tab: Tab) => Tab) => {
    tabsRef.current = tabsRef.current.map(item => item.id === id ? change(item) : item);
  });
  const onChallenge = vi.fn();
  const restoreConversation = vi.fn(async () => {});
  const props = {
    tabs, tabsRef, update, enabled: options.enabled ?? true,
    maxReconnectAttempts: options.maxRetries ?? 10,
    onChallenge, restoreConversation,
  };
  const hook = renderHook(() => useAutoReconnect(props));
  return { ...hook, tabsRef, update, onChallenge, restoreConversation };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(api.Disconnect).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("reconnect restores the latest session and conversation", async () => {
  vi.mocked(api.Reconnect).mockResolvedValue({
    ref: { ...ref, generation: 2 }, home: "/home/root", conversationId: "chat-1",
  });
  const { tabsRef, restoreConversation } = setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(api.Reconnect).toHaveBeenCalledWith(ref.tabId, ref.sessionId);
  expect(tabsRef.current[0]).toMatchObject({
    status: "connected", retryCount: 0, cwd: "/home/root",
    ref: { generation: 2 },
  });
  expect(restoreConversation).toHaveBeenCalledWith(
    { ...ref, generation: 2 }, "chat-1",
  );
});

test("manual stop cancels pending reconnect timer", async () => {
  const { result } = setup();
  act(() => result.current.stopRetryTimer(ref.tabId));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(api.Reconnect).not.toHaveBeenCalled();
});

test("disabled automatic reconnection stops without a connection attempt", async () => {
  const { tabsRef } = setup(reconnectingTab(), { enabled: false });
  expect(tabsRef.current[0].status).toBe("disconnected");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(api.Reconnect).not.toHaveBeenCalled();
});

test("retry limit is enforced before scheduling new attempts", async () => {
  const { tabsRef } = setup(reconnectingTab({ retryCount: 2 }), { maxRetries: 2 });
  expect(tabsRef.current[0].status).toBe("disconnected");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(api.Reconnect).not.toHaveBeenCalled();
});

test("authentication failures stop retrying while network failures remain retryable", async () => {
  vi.mocked(api.Reconnect).mockRejectedValueOnce(new Error("authentication failed"));
  const auth = setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(auth.tabsRef.current[0]).toMatchObject({
    status: "disconnected", retryCount: 1,
  });
  auth.unmount();
  vi.mocked(api.Reconnect).mockRejectedValueOnce(new Error("network unreachable"));
  const network = setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(network.tabsRef.current[0]).toMatchObject({
    status: "reconnecting", retryCount: 1,
  });
});
