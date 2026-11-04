import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalOutputAcknowledger } from "./terminalOutputAcknowledger";

describe("TerminalOutputAcknowledger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not acknowledge until the xterm write callback reports completion", () => {
    const send = vi.fn();
    const ack = new TerminalOutputAcknowledger(send);
    vi.advanceTimersByTime(200);
    expect(send).not.toHaveBeenCalled();

    ack.processedSequence(1);
    vi.advanceTimersByTime(11);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("batches contiguous completions and flushes immediately at four chunks", () => {
    const send = vi.fn();
    const ack = new TerminalOutputAcknowledger(send);
    ack.processedSequence(1);
    ack.processedSequence(2);
    ack.processedSequence(3);
    expect(send).not.toHaveBeenCalled();
    ack.processedSequence(4);
    expect(send).toHaveBeenCalledExactlyOnceWith(4);
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
    ack.processedSequence(5);
    vi.advanceTimersByTime(12);
    expect(send).toHaveBeenNthCalledWith(2, 5);
  });

  it("ignores repeated or stale sequences", () => {
    const send = vi.fn();
    const ack = new TerminalOutputAcknowledger(send);
    ack.processedSequence(1);
    ack.processedSequence(1);
    ack.processedSequence(0);
    ack.processedSequence(-1);
    vi.advanceTimersByTime(12);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(1);
  });

  it("releases received but unparsed output only when the terminal is disposed", () => {
    const send = vi.fn();
    const ack = new TerminalOutputAcknowledger(send);
    ack.processedSequence(1);
    ack.release(9);
    expect(send).toHaveBeenCalledExactlyOnceWith(9);
    vi.advanceTimersByTime(100);
    ack.processedSequence(10);
    ack.release(11);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("maintains independent confirmation state per terminal", () => {
    const one = vi.fn();
    const two = vi.fn();
    const a = new TerminalOutputAcknowledger(one);
    const b = new TerminalOutputAcknowledger(two);
    a.processedSequence(1);
    b.processedSequence(1);
    a.release(2);
    expect(one).toHaveBeenCalledExactlyOnceWith(2);
    expect(two).not.toHaveBeenCalled();
    vi.advanceTimersByTime(12);
    expect(two).toHaveBeenCalledExactlyOnceWith(1);
  });
});
