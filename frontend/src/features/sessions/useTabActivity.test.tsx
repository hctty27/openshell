import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ref, Tab } from "../../types";
import { hasVisibleTerminalOutput, useTabActivity } from "./useTabActivity";

const ref: Ref = { tabId: "A", sessionId: "ssh-A", generation: 1 };
const makeTab = (id: string, status: Tab["status"] = "connected"): Tab => ({
  id,
  session: {
    id: "ssh-" + id, name: id, host: "example.test", port: 22, username: "root",
    groupId: "", authType: "key", privateKeyPath: "", credentialRef: "",
  },
  ref: { tabId: id, sessionId: "ssh-" + id, generation: 1 },
  status,
  home: "", cwd: "", error: "",
});
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("background terminal activity", () => {
  it("ignores empty and control-only output but accepts ANSI-styled text", () => {
    expect(hasVisibleTerminalOutput(bytes(""))).toBe(false);
    expect(hasVisibleTerminalOutput(bytes("\x1b[2J\x1b[H\x1b]0;title\x07"))).toBe(false);
    expect(hasVisibleTerminalOutput(bytes("\x1b[32mnew log\x1b[0m\r\n"))).toBe(true);
  });

  it("marks hidden SSH output once and clears the marker when viewed", () => {
    const tabs = [makeTab("A"), makeTab("B")];
    const { result, rerender } = renderHook(
      ({ visible }) => useTabActivity({
        tabs, visibleTabIDs: visible, hasActiveTransfers: () => false,
      }),
      { initialProps: { visible: ["A"] } },
    );
    rerender({ visible: ["B"] });
    act(() => result.current.onRemoteOutput(ref, bytes("echo from A")));
    expect(result.current.unreadTabIDs.size).toBe(0);
    act(() => vi.advanceTimersByTime(301));
    act(() => {
      result.current.onRemoteOutput(ref, bytes("new log"));
      result.current.onRemoteOutput(ref, bytes("another log"));
    });
    expect([...result.current.unreadTabIDs]).toEqual(["A"]);
    rerender({ visible: ["A"] });
    expect(result.current.unreadTabIDs.size).toBe(0);
  });

  it("ignores visible split panes, active transfers, and stale refs", () => {
    const tabs = [makeTab("A"), makeTab("B")];
    const isTransferring = vi.fn(() => true);
    const { result, rerender } = renderHook(
      ({ visible }) => useTabActivity({
        tabs, visibleTabIDs: visible, hasActiveTransfers: isTransferring,
      }),
      { initialProps: { visible: ["A", "B"] } },
    );
    act(() => result.current.onRemoteOutput(ref, bytes("split output")));
    expect(result.current.unreadTabIDs.size).toBe(0);
    rerender({ visible: ["B"] });
    act(() => vi.advanceTimersByTime(301));
    act(() => result.current.onRemoteOutput(ref, bytes("transfer output")));
    expect(result.current.unreadTabIDs.size).toBe(0);
    expect(isTransferring).toHaveBeenCalledWith(ref);
    act(() => result.current.onRemoteOutput({ ...ref, generation: 0 }, bytes("old SSH data")));
    expect(result.current.unreadTabIDs.size).toBe(0);
  });

  it("clears unread markers on disconnect, reconnect, and close", () => {
    let tabs = [makeTab("A"), makeTab("B")];
    const { result, rerender } = renderHook(
      ({ visible, currentTabs }) => useTabActivity({
        tabs: currentTabs, visibleTabIDs: visible, hasActiveTransfers: () => false,
      }),
      { initialProps: { visible: ["B"], currentTabs: tabs } },
    );
    act(() => result.current.onRemoteOutput(ref, bytes("new output")));
    expect(result.current.unreadTabIDs.has("A")).toBe(true);
    tabs = [makeTab("A", "reconnecting"), makeTab("B")];
    rerender({ visible: ["B"], currentTabs: tabs });
    expect(result.current.unreadTabIDs.size).toBe(0);
    act(() => result.current.onRemoteOutput(ref, bytes("stale while offline")));
    expect(result.current.unreadTabIDs.size).toBe(0);
    tabs = [makeTab("A"), makeTab("B")];
    rerender({ visible: ["B"], currentTabs: tabs });
    act(() => result.current.onRemoteOutput(ref, bytes("fresh connection")));
    expect(result.current.unreadTabIDs.has("A")).toBe(true);
    rerender({ visible: ["B"], currentTabs: [makeTab("B")] });
    expect(result.current.unreadTabIDs.size).toBe(0);
  });
});
