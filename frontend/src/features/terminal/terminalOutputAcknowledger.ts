/**
 * Batch acknowledgements only after xterm.js has completed parsing the data.
 * Timer-based flushing also works for hidden tabs where rAF can be throttled.
 */
export class TerminalOutputAcknowledger {
  private processed = 0;
  private acknowledged = 0;
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly send: (sequence: number) => void,
    private readonly delayMs = 12,
    private readonly batchChunks = 4,
  ) {}

  processedSequence(sequence: number): void {
    if (this.closed || !Number.isSafeInteger(sequence) || sequence <= this.processed) return;
    this.processed = sequence;
    this.pending++;
    if (this.pending >= this.batchChunks) {
      this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.processed <= this.acknowledged) return;
    this.acknowledged = this.processed;
    this.pending = 0;
    this.send(this.acknowledged);
  }

  /**
   * Disposing a terminal intentionally discards outstanding xterm output.
   * Release the latest received sequence to avoid leaving the SSH reader blocked.
   */
  release(receivedSequence: number): void {
    if (this.closed) return;
    if (Number.isSafeInteger(receivedSequence) && receivedSequence > this.processed) {
      this.processed = receivedSequence;
    }
    this.flush();
    this.closed = true;
  }
}
