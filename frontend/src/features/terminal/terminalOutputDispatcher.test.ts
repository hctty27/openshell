import { describe, expect, it, vi } from "vitest";
import type { Ref } from "../../types";
import { TerminalOutputDispatcher } from "./terminalOutputDispatcher";

function eventBus() {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  const subscribe = vi.fn((name: string, handler: (payload: any) => void) => {
    const handlers = listeners.get(name) ?? new Set<(payload: any) => void>();
    handlers.add(handler);
    listeners.set(name, handlers);
    return () => {
      handlers.delete(handler);
      if (!handlers.size) listeners.delete(name);
    };
  });
  const emit = (name: string, payload: unknown) => {
    for (const callback of listeners.get(name) ?? []) callback(payload);
  };
  return { listeners, subscribe, emit };
}

const ref = (tabId: string, generation = 1): Ref => ({
  tabId, sessionId: "session-1", generation,
});

describe("TerminalOutputDispatcher", () => {
  it("routes SSH output directly to one generation without multiplying Wails listeners", () => {
    const bus = eventBus();
    const dispatcher = new TerminalOutputDispatcher(bus.subscribe);
    const outputA = vi.fn();
    const outputB = vi.fn();
    const outputReconnected = vi.fn();

    const offA = dispatcher.onSSH(ref("a"), outputA);
    const offB = dispatcher.onSSH(ref("b"), outputB);
    const offReconnected = dispatcher.onSSH(ref("a", 2), outputReconnected);

    expect(bus.subscribe).toHaveBeenCalledTimes(1);
    bus.emit("ssh:output", { ref: ref("a"), data: "first", sequence: 1 });
    bus.emit("ssh:output", { ref: ref("a", 2), data: "second", sequence: 2 });

    expect(outputA).toHaveBeenCalledTimes(1);
    expect(outputB).not.toHaveBeenCalled();
    expect(outputReconnected).toHaveBeenCalledTimes(1);
    expect(outputReconnected).toHaveBeenCalledWith({
      ref: ref("a", 2), data: "second", sequence: 2,
    });

    offA();
    offB();
    offReconnected();
    expect(bus.listeners.has("ssh:output")).toBe(false);
  });

  it("isolates local PTYs and removes their shared listener after final disposal", () => {
    const bus = eventBus();
    const dispatcher = new TerminalOutputDispatcher(bus.subscribe);
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = dispatcher.onLocal("a", "pty-1", first);
    const offSecond = dispatcher.onLocal("a", "pty-2", second);

    expect(bus.subscribe).toHaveBeenCalledTimes(1);
    bus.emit("local:output", { tabId: "a", terminalId: "pty-1", data: "one" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    offFirst();
    bus.emit("local:output", { tabId: "a", terminalId: "pty-1", data: "ignored" });
    bus.emit("local:output", { tabId: "a", terminalId: "pty-2", data: "two" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    offSecond();
    expect(bus.listeners.has("local:output")).toBe(false);
  });

  it("re-subscribes cleanly after all terminals close", () => {
    const bus = eventBus();
    const dispatcher = new TerminalOutputDispatcher(bus.subscribe);
    dispatcher.onSSH(ref("a"), vi.fn())();
    const output = vi.fn();
    const off = dispatcher.onSSH(ref("a"), output);

    expect(bus.subscribe).toHaveBeenCalledTimes(2);
    bus.emit("ssh:output", { ref: ref("a"), data: "new" });
    expect(output).toHaveBeenCalledTimes(1);
    off();
  });
});
