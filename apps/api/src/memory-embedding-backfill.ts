import type { DotMemoryEmbeddings } from "@space/db";
import type { SpaceStore } from "@space/runtime";

/**
 * Re-embeds every memory whose vector is missing or was made by another model (Space Memory plan clipboard:o7SATwaOHqca):
 * memory_records and Dot memories, rows without a vector first. Each row records the model that embedded it, so the work is
 * resumable across passes and restarts. A pass is bounded in rows and time so it stays inside the provider's rate limits;
 * it waits while the embedding provider has not passed its smoke. The canonical index (canonical-memory-search.ts)
 * re-embeds itself, keyed by model. A free-tier key has low per-minute and per-day caps: a failed pass (429 or any other
 * error) backs off, doubling from 2 minutes to 6 hours, and the work resumes when the provider answers again, also days later.
 */
export interface MemoryEmbeddingBackfillOptions {
  store: Pick<SpaceStore, "listMemoryRecordsToEmbed" | "setMemoryRecordEmbedding">;
  dotMemories?: DotMemoryEmbeddings | null;
  model: string;
  ready: () => Promise<boolean>;
  embed: (texts: string[]) => Promise<number[][]>;
  /** Texts per provider call (createMemoryEmbeddings accepts at most 16). */
  batchSize?: number;
  /** Rows per pass, across both stores. */
  maxPerPass?: number;
  budgetMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export interface MemoryEmbeddingBackfillState { lastRunAt: string | null; lastEmbedded: number; totalEmbedded: number; lastError: string | null;
  /** Passes wait until then after a failure. */
  backoffUntil: string | null }

const BACKOFF_MIN_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 6 * 3600_000;

export function createMemoryEmbeddingBackfill(options: MemoryEmbeddingBackfillOptions) {
  const now = options.now ?? Date.now;
  const batchSize = Math.min(16, options.batchSize ?? 16);
  const maxPerPass = options.maxPerPass ?? 48;
  const state: MemoryEmbeddingBackfillState = { lastRunAt: null, lastEmbedded: 0, totalEmbedded: 0, lastError: null, backoffUntil: null };
  let failures = 0;
  let pending: Promise<MemoryEmbeddingBackfillState> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  type Row = { text: string; save: (embedding: number[]) => Promise<void> | void };
  async function nextRows(limit: number): Promise<Row[]> {
    const records = await options.store.listMemoryRecordsToEmbed(options.model, limit);
    const rows: Row[] = records.map((record) => ({ text: `${record.title}\n${record.body}`.slice(0, 10000),
      save: (embedding) => options.store.setMemoryRecordEmbedding(record.id, embedding, options.model) }));
    if (rows.length < limit && options.dotMemories) {
      const dots = await options.dotMemories.listToEmbed(options.model, limit - rows.length);
      rows.push(...dots.map((memory) => ({ text: memory.text.slice(0, 10000),
        save: (embedding: number[]) => options.dotMemories!.setEmbedding(memory.memoryId, embedding, options.model) })));
    }
    return rows;
  }

  async function pass(): Promise<MemoryEmbeddingBackfillState> {
    if (state.backoffUntil && now() < Date.parse(state.backoffUntil)) return { ...state };
    state.lastRunAt = new Date(now()).toISOString();
    state.lastEmbedded = 0;
    if (!await options.ready()) { state.lastError = null; return { ...state }; }
    const deadline = now() + (options.budgetMs ?? 50_000);
    try {
      // A saved row leaves the list (its model now matches), so each round takes the next rows; a failure ends the pass.
      while (!stopped && state.lastEmbedded < maxPerPass && now() < deadline) {
        const rows = await nextRows(Math.min(batchSize, maxPerPass - state.lastEmbedded));
        if (!rows.length) break;
        const vectors = await options.embed(rows.map((row) => row.text));
        if (vectors.length !== rows.length) throw new Error("The embedding batch was incomplete.");
        for (const [index, row] of rows.entries()) {
          await row.save(vectors[index]!);
          state.lastEmbedded += 1;
          state.totalEmbedded += 1;
        }
      }
      state.lastError = null;
      state.backoffUntil = null;
      failures = 0;
    } catch (error) {
      // Only the message's first line: provider answers never carry memory text back here.
      state.lastError = (error instanceof Error ? error.message : "The embedding backfill failed.").split("\n")[0]!.slice(0, 200);
      failures += 1;
      state.backoffUntil = new Date(now() + Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1))).toISOString();
    }
    return { ...state };
  }

  return {
    state: () => ({ ...state }),
    /** One bounded pass; concurrent callers share it. */
    runOnce(): Promise<MemoryEmbeddingBackfillState> {
      pending ??= pass().finally(() => { pending = null; });
      return pending;
    },
    start() {
      const tick = async () => {
        await this.runOnce().catch(() => undefined);
        if (!stopped) { timer = setTimeout(tick, options.intervalMs ?? 60_000); timer.unref(); }
      };
      timer = setTimeout(tick, 15_000);
      timer.unref();
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pending?.catch(() => undefined);
    }
  };
}

export type MemoryEmbeddingBackfill = ReturnType<typeof createMemoryEmbeddingBackfill>;
