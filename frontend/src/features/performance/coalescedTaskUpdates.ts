/** Keep only the most recent progress sample per task until the next UI flush. */
export class CoalescedTaskUpdates<T extends { id: string }> {
  private pending = new Map<string, T>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly onFlush: (updates: T[]) => void, private readonly intervalMs = 120) {}

  enqueue(update: T, immediate = false): void {
    if (this.disposed) return;
    this.pending.set(update.id, update);
    if (immediate) {
      this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed || !this.pending.size) return;
    const updates = [...this.pending.values()];
    this.pending.clear();
    this.onFlush(updates);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.disposed = true;
  }
}
