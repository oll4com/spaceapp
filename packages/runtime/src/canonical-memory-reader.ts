import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MemoryGraphRecord } from "@space/memory-graph";
import { memoryEntrySchema, type ListMemoryQuery, type MemoryEntry } from "@space/contracts";
import type { CanonicalGeminiMemoryPaths } from "./shared-state.js";
import { redactMemoryText } from "./store.js";

const maxFileBytes = 16 * 1024 * 1024;
const monthlyPattern = /^gemini_history_\d{4}-\d{2}\.md$/;
const referencePattern = /^(?:gemini|gemini_core(?:_[a-z_]+)?|agent_task_policies)\.md$/;

function fingerprint(s: Awaited<ReturnType<typeof lstat>>): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}

export function createCanonicalMemoryReader(paths: CanonicalGeminiMemoryPaths) {
  const cache = new Map<string, { fingerprint: string; records: MemoryGraphRecord[] }>();
  let pending: Promise<MemoryGraphRecord[]> | null = null;
  let aggregate: { fingerprint: string; records: MemoryGraphRecord[] } | null = null;
  let projection: { records: MemoryGraphRecord[]; entries: MemoryEntry[] } | null = null;
  async function records(): Promise<MemoryGraphRecord[]> {
    const directory = dirname(paths.indexPath);
    let names: string[] = [];
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter(e => e.isFile() && (monthlyPattern.test(e.name) || referencePattern.test(e.name)))
        .map(e => join(directory, e.name));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const sources = [...new Set([paths.indexPath, paths.monthlyPath, ...names])].sort();
    if (sources.length > 512) throw new Error("Canonical memory source limit exceeded.");
    const active = new Set(sources);
    for (const key of cache.keys()) if (!active.has(key)) cache.delete(key);
    const result: MemoryGraphRecord[] = [];
    let bytes = 0;
    for (const path of sources) {
      let info;
      try { info = await lstat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        cache.delete(path); continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Canonical memory source must be a regular file.");
      bytes += info.size;
      if (info.size > maxFileBytes || bytes > 64 * 1024 * 1024) throw new Error("Canonical memory byte limit exceeded.");
      let cached = cache.get(path);
      if (cached?.fingerprint !== fingerprint(info)) {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        let content: string;
        try {
          const before = await handle.stat();
          if (!before.isFile() || fingerprint(before) !== fingerprint(info)) throw new Error("Canonical memory changed during read.");
          const buffer = Buffer.alloc(info.size + 1);
          let offset = 0;
          while (offset < buffer.length) {
            const read = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
          if (offset !== info.size || fingerprint(await handle.stat()) !== fingerprint(info)) throw new Error("Canonical memory changed during read.");
          content = buffer.subarray(0, offset).toString("utf8");
        } finally { await handle.close(); }
        const kind = path === paths.monthlyPath || monthlyPattern.test(basename(path)) ? "MONTHLY" : "INDEX";
        const { parseMemorySourceRecords } = await import("@space/memory-graph");
        cached = { fingerprint: fingerprint(info), records: parseMemorySourceRecords({ path, kind, content }, info.mtime.toISOString()) };
        cache.set(path, cached);
      }
      result.push(...cached.records);
    }
    const key = sources.map(path => `${path}:${cache.get(path)?.fingerprint ?? "missing"}`).join("\n");
    if (aggregate?.fingerprint === key) return aggregate.records;
    aggregate = { fingerprint: key, records: result };
    return result;
  }
  return async (query: ListMemoryQuery): Promise<MemoryEntry[]> => {
    pending ??= records().finally(() => { pending = null; });
    const all = await pending;
    if (projection?.records !== all) {
    const byId = new Map(all.map(record => [record.id, record]));
    const superseded = new Set(all.filter(r => r.lifecycleStatus === "ACTIVE").flatMap(r =>
      [...r.body.matchAll(/\bsupersedes=([A-Za-z0-9:_-]{3,200})\b/g)].flatMap(m => {
        const target = byId.get(m[1]!);
        return target && target.scope === r.scope && target.roomId === r.roomId ? [target.id] : [];
      })));
    const entries = all.filter(r => r.lifecycleStatus === "ACTIVE" && !superseded.has(r.id))
      .map(r => ({
        id: r.id, scope: r.scope, roomId: r.roomId,
        title: redactMemoryText(r.title).slice(0, 160), body: redactMemoryText(r.body),
        provenance: redactMemoryText(r.sourcePath).slice(0, 500),
        createdAt: /\bcreated_at=(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(r.body)?.[1] ?? r.createdAt
      }));
    projection = { records: all, entries };
    }
    const entries = projection.entries.filter(r => !query.scope || r.scope === query.scope).filter(r => !query.roomId || r.roomId === query.roomId);
    const { searchMemoryDocuments, memoryExcerpt } = await import("@space/memory-graph");
    let selected = query.q ? searchMemoryDocuments(entries, query.q) : entries;
    if (!query.q || query.sortBy) {
      const key = query.sortBy === "title" || query.sortBy === "provenance" || query.sortBy === "scope" ? query.sortBy : "createdAt";
      const direction = query.sortOrder === "asc" ? 1 : -1;
      selected = selected.sort((a, b) => direction * (a[key].localeCompare(b[key]) || a.id.localeCompare(b.id)));
    }
    const unique = new Map<string, MemoryEntry>();
    for (const entry of selected) {
      if (!unique.has(entry.id)) unique.set(entry.id, memoryEntrySchema.parse({ ...entry,
        body: query.q ? memoryExcerpt(entry.body, query.q, 10000) : entry.body.slice(0, 10000) }));
    }
    return [...unique.values()];
  };
}
