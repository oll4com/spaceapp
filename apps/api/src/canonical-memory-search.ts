import { createHash } from "node:crypto";
import type { CanonicalMemoryBridge } from "@space/runtime";
import type { ListMemoryQuery, MemoryEntry } from "@space/contracts";
import type { CanonicalMemoryEmbeddings } from "@space/db";

const allQuery: ListMemoryQuery = { page: 1, pageSize: 100, sortOrder: "desc", searchMode: "keyword" };
export function canonicalEmbeddingHash(entry: MemoryEntry): string {
  return createHash("sha256").update(JSON.stringify([entry.title, entry.body, entry.provenance, entry.scope, entry.roomId])).digest("hex");
}

export class CanonicalMemorySearch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<{ total: number; updated: number }> | null = null;
  private stopped = false;
  private error: string | null = null;
  constructor(private readonly options: {
    canonical: CanonicalMemoryBridge;
    repository: Pick<CanonicalMemoryEmbeddings, "list" | "upsert" | "search" | "close">;
    provider: string;
    model: string;
    ready: () => Promise<boolean>;
    embed: (texts: string[]) => Promise<number[][]>;
  }) {}

  async coverage() {
    const [entries, indexed] = await Promise.all([this.options.canonical.list(allQuery), this.options.repository.list(this.options.provider, this.options.model)]);
    const hashes = new Map(indexed.map(row => [row.id, row.inputHash]));
    return { total: entries.length, indexed: entries.filter(e => hashes.get(e.id) === canonicalEmbeddingHash(e)).length, error: this.error };
  }

  sync(): Promise<{ total: number; updated: number }> {
    this.pending ??= this.runSync().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async runSync() {
    if (!await this.options.ready()) return { total: 0, updated: 0 };
    const entries = await this.options.canonical.list(allQuery);
    const indexed = new Map((await this.options.repository.list(this.options.provider, this.options.model)).map(row => [row.id, row.inputHash]));
    const missing = entries.filter(e => indexed.get(e.id) !== canonicalEmbeddingHash(e));
    const deadline = Date.now() + 120_000;
    let updated = 0;
    try {
      for (let start = 0; start < missing.length && Date.now() < deadline && !this.stopped; start += 16) {
        const batch = missing.slice(start, start + 16);
        // Only redacted canonical text reaches the configured, dedicated provider.
        const vectors = await this.options.embed(batch.map(e => `${e.title}\n${e.body}`.slice(0, 10000)));
        if (vectors.length !== batch.length) throw new Error("Embedding batch was incomplete.");
        for (let n = 0; n < batch.length; n++) {
          const entry = batch[n]!;
          await this.options.repository.upsert({ id: entry.id, hash: canonicalEmbeddingHash(entry), provider: this.options.provider, model: this.options.model, embedding: vectors[n]! });
          updated++;
        }
      }
      this.error = null;
      return { total: entries.length, updated };
    } catch {
      this.error = "Canonical embedding synchronization failed; keyword search remains available.";
      throw new Error(this.error);
    }
  }

  async search(query: ListMemoryQuery, embedding: number[]): Promise<MemoryEntry[]> {
    const all = await this.options.canonical.list({ ...query, q: undefined, searchMode: "keyword" });
    const hits = await this.options.repository.search(embedding, this.options.provider, this.options.model, all.map(e => e.id));
    // Recheck scope, existence and the current content hash. Removed, archived and
    // changed entries cannot leak through old vectors, even during index rebuilds.
    const current = new Map(all.map(e => [e.id, e]));
    const semantic = hits.flatMap(hit => {
      const entry = current.get(hit.id);
      return entry && hit.similarity >= 0.4 && canonicalEmbeddingHash(entry) === hit.inputHash ? [entry] : [];
    });
    // The canonical reader ranks full source bodies before selecting a bounded
    // evidence window. Searching the list projection would miss late evidence.
    const lexical = query.q ? (await this.options.canonical.list({ ...query, searchMode: "keyword" })).slice(0, 100) : [];
    const merged = new Map(lexical.map(e => [e.id, e]));
    for (const entry of semantic) if (!merged.has(entry.id)) merged.set(entry.id, entry);
    return [...merged.values()];
  }

  start() {
    const tick = async () => {
      try { await this.sync(); } catch { /* Coverage exposes the sanitized failure. */ }
      if (!this.stopped) { this.timer = setTimeout(tick, 60_000); this.timer.unref(); }
    };
    this.timer = setTimeout(tick, 5000); this.timer.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pending?.catch(() => {});
    await this.options.repository.close();
  }
}
