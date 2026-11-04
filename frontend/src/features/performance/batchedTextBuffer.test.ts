import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchedTextBuffer } from "./batchedTextBuffer";

describe("BatchedTextBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("joins incremental tokens into a single render update", () => {
    const publish = vi.fn();
    const buffer = new BatchedTextBuffer(publish, 40);
    buffer.append("a");
    buffer.append("b");
    buffer.append("c");
    vi.advanceTimersByTime(39);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith("abc");
    buffer.append("d");
    vi.advanceTimersByTime(40);
    expect(publish).toHaveBeenNthCalledWith(2, "d");
  });

  it("discards old conversation output without leaking a delayed callback", () => {
    const publish = vi.fn();
    const buffer = new BatchedTextBuffer(publish);
    buffer.append("old");
    buffer.clear();
    buffer.append("new");
    vi.advanceTimersByTime(40);
    expect(publish).toHaveBeenCalledExactlyOnceWith("new");
  });

  it("flushes immediately when requested and cancels work on unmount", () => {
    const publish = vi.fn();
    const buffer = new BatchedTextBuffer(publish);
    buffer.append("first");
    buffer.flush();
    expect(publish).toHaveBeenCalledExactlyOnceWith("first");
    buffer.append("second");
    buffer.dispose();
    vi.advanceTimersByTime(100);
    expect(publish).toHaveBeenCalledTimes(1);
    buffer.append("ignored");
    buffer.flush();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
