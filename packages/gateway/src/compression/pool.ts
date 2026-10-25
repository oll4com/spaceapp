import { Worker } from "node:worker_threads";
import type { BlockAction, BlockAnalysis, BlockOptions, BlockResult } from "./engine.js";
import type { TokenizerKind } from "./tokenizer.js";

export type { BlockResult };
export interface BlockRunOptions extends BlockOptions {
  tokenizer?: TokenizerKind;
  /** Receives a result that arrives after the deadline, so the next request can use it (results are deterministic). */
  onLate?: (result: BlockResult) => void;
}
export type BlockRunner = (text: string, deadline: number, options?: BlockRunOptions) => Promise<BlockResult | null>;

/** A worker gets jobs only once it reports ready (tokenizer and grammars loaded), so a new worker never inherits a deadline it cannot meet. */
interface Slot { worker: Worker; busy: boolean; ready: boolean }
interface Job {
  id: number; text: string; deadline: number; tokenizer: TokenizerKind; block: BlockOptions; settled: boolean;
  resolve: (value: BlockResult | null) => void; onLate?: (result: BlockResult) => void;
}

/**
 * Worker threads for compression, so a large tool output never blocks other streams. A job that misses its
 * deadline resolves to null (the caller sends the original text) but keeps running, and its late result goes to
 * `onLate`; a job still running at the hard limit has its worker replaced, which stops the work.
 */
export class CompressionPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  /** Compression jobs waiting for a worker. */
  queued() { return this.queue.length; }
  private running = new Map<number, { job: Job; slot: Slot; soft: NodeJS.Timeout; hard: NodeJS.Timeout }>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly workerUrl: URL, size: number, private readonly hardLimitMs = 5_000) {
    for (let index = 0; index < Math.max(1, size); index += 1) this.slots.push(this.spawn());
  }

  private settle(job: Job, value: BlockResult | null) {
    if (job.settled) return;
    job.settled = true;
    job.resolve(value);
  }

  private spawn(): Slot {
    const slot: Slot = { worker: new Worker(this.workerUrl), busy: false, ready: false };
    slot.worker.unref();
    slot.worker.on("message", (message: { id?: number; ready?: boolean; replacement?: string | null; action?: BlockAction; analysis?: BlockAnalysis; failure?: string }) => {
      if (message.ready) {
        slot.ready = true;
        this.pump();
        return;
      }
      if (message.id === undefined) return;
      const entry = this.running.get(message.id);
      if (!entry) return;
      clearTimeout(entry.soft);
      clearTimeout(entry.hard);
      this.running.delete(message.id);
      slot.busy = false;
      const result = message.action ? { replacement: message.replacement ?? null, action: message.action, ...(message.analysis ? { analysis: message.analysis } : {}) } : null;
      if (entry.job.settled) {
        if (result) entry.job.onLate?.(result);
      } else {
        this.settle(entry.job, result);
      }
      this.pump();
    });
    slot.worker.on("error", () => this.replace(slot));
    return slot;
  }

  private replace(slot: Slot) {
    for (const [id, entry] of this.running) {
      if (entry.slot !== slot) continue;
      clearTimeout(entry.soft);
      clearTimeout(entry.hard);
      this.running.delete(id);
      this.settle(entry.job, null);
    }
    void slot.worker.terminate().catch(() => undefined);
    const index = this.slots.indexOf(slot);
    if (index >= 0 && !this.closed) this.slots[index] = this.spawn();
    this.pump();
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy || !slot.ready) continue;
      let job = this.queue.shift();
      while (job && (job.settled || job.deadline <= Date.now())) { this.settle(job, null); job = this.queue.shift(); }
      if (!job) return;
      slot.busy = true;
      const current = job;
      const soft = setTimeout(() => this.settle(current, null), Math.max(1, current.deadline - Date.now()));
      const hard = setTimeout(() => this.replace(slot), Math.max(1, current.deadline - Date.now()) + this.hardLimitMs);
      soft.unref();
      hard.unref();
      this.running.set(current.id, { job: current, slot, soft, hard });
      slot.worker.postMessage({ id: current.id, text: current.text, tokenizer: current.tokenizer, ...current.block });
    }
  }

  readonly run: BlockRunner = (text, deadline, options = {}) => new Promise((resolve) => {
    if (this.closed || deadline <= Date.now()) { resolve(null); return; }
    const block: BlockOptions = { ...(options.codeText ? { codeText: options.codeText, lossy: options.lossy ?? false } : {}), ...(options.exact ? { exact: true } : {}) };
    const job: Job = { id: this.nextId++, text, deadline, tokenizer: options.tokenizer ?? "o200k", block, settled: false, resolve, onLate: options.onLate };
    this.queue.push(job);
    // A job still waiting for a free worker at its deadline gives up, so callers never wait past the budget.
    const expiry = setTimeout(() => {
      const index = this.queue.indexOf(job);
      if (index >= 0) { this.queue.splice(index, 1); this.settle(job, null); }
    }, Math.max(1, deadline - Date.now()));
    expiry.unref();
    this.pump();
  });

  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) this.settle(job, null);
    await Promise.all(this.slots.map((slot) => slot.worker.terminate().catch(() => undefined)));
  }
}
