/** Coalesce frequent UI-only deltas without delaying task state transitions. */
export class BatchedTextBuffer {
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly onFlush: (text: string) => void, private readonly intervalMs = 40) {}

  append(text: string): void {
    if (this.disposed || !text) return;
    this.pending += text;
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed || !this.pending) return;
    const delta = this.pending;
    this.pending = "";
    this.onFlush(delta);
  }

  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = "";
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}
