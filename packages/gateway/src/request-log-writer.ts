import type { GatewayRepository, GatewayRequestLogInsert } from "@space/db";

/** Buffers request logs and writes them in batches so logging never sits on the request path. */
export class RequestLogWriter {
  private pending: GatewayRequestLogInsert[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly repository: GatewayRepository, private readonly options: { batchSize?: number; intervalMs?: number; onError?: (error: unknown) => void } = {}) {}

  add(row: GatewayRequestLogInsert) {
    this.pending.push(row);
    if (this.pending.length >= (this.options.batchSize ?? 100)) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.options.intervalMs ?? 1000);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const batch = this.pending.splice(0);
    if (batch.length === 0) return this.flushing;
    this.flushing = this.flushing.then(() => this.repository.insertRequestLogs(batch)).catch((error: unknown) => {
      this.options.onError?.(error);
    });
    return this.flushing;
  }
}
