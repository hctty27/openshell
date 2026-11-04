import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescedTaskUpdates } from "./coalescedTaskUpdates";

type Task = { id: string; status: "queued" | "running" | "completed"; bytes: number };

describe("CoalescedTaskUpdates", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps only the latest progress sample per task", () => {
    const publish = vi.fn();
    const queue = new CoalescedTaskUpdates<Task>(publish, 120);
    queue.enqueue({ id: "a", status: "running", bytes: 1 });
    queue.enqueue({ id: "a", status: "running", bytes: 2 });
    queue.enqueue({ id: "b", status: "running", bytes: 4 });
    vi.advanceTimersByTime(119);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith([
      { id: "a", status: "running", bytes: 2 },
      { id: "b", status: "running", bytes: 4 },
    ]);
  });

  it("publishes final task state immediately without replaying stale progress", () => {
    const publish = vi.fn();
    const queue = new CoalescedTaskUpdates<Task>(publish);
    queue.enqueue({ id: "a", status: "running", bytes: 20 });
    queue.enqueue({ id: "a", status: "completed", bytes: 100 }, true);
    expect(publish).toHaveBeenCalledExactlyOnceWith([{ id: "a", status: "completed", bytes: 100 }]);
    vi.advanceTimersByTime(200);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("drops buffered view updates when a panel closes", () => {
    const publish = vi.fn();
    const queue = new CoalescedTaskUpdates<Task>(publish);
    queue.enqueue({ id: "a", status: "running", bytes: 10 });
    queue.dispose();
    vi.advanceTimersByTime(300);
    expect(publish).not.toHaveBeenCalled();
  });
});
