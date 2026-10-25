import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { MemoryGraphRecord } from "@space/memory-graph";
import { memoryEntrySchema, type ListMemoryQuery, type MemoryEntry } from "@space/contracts";
import type { CanonicalSpaceMemoryPaths } from "./shared-state.js";
import { MEMORY_REFERENCE_FILE_PATTERN, MONTHLY_MEMORY_FILE_PATTERN } from "./space-memory-files.js";
import { redactMemoryText } from "./store.js";

const maxFileBytes = 16 * 1024 * 1024;
const monthlyPattern = MONTHLY_MEMORY_FILE_PATTERN;
const referencePattern = MEMORY_REFERENCE_FILE_PATTERN;

const persistentCacheFormat = 1;

// Parsing a monthly file took the API's event loop for up to 15 s on stable (3.5 MB, the slow markdown
// parser under load, 2026-10-24), so it runs in a worker thread; records come back as plain clones. The worker
// also normalizes each record's search text: the first search after a save did it for every record (5.3 s).
// One worker serves the process (2026-10-25): a fresh worker per source cold-imported the parser each time, about a
// second per source idle and past any bound under load. A parse error fails that parse only; a crash or exit fails the
// parses in flight and the next parse starts a new worker. Idle, it does not keep the process alive.
const parseWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.moduleUrl).then(({ parseMemorySourceRecords, normalizeMemoryQuery }) => {
  parentPort.on("message", ({ id, source, modifiedAt }) => {
    try {
      const records = parseMemorySourceRecords(source, modifiedAt);
      parentPort.postMessage({ id, records, searchText: records.map((r) => [normalizeMemoryQuery(r.title.slice(0, 160)), normalizeMemoryQuery(r.body)]) });
    } catch (error) {
      parentPort.postMessage({ id, error: String(error?.message ?? error) });
    }
  });
});`;

type ParseResult = { records: MemoryGraphRecord[]; searchText: NonNullable<SearchText>[] };
let parser: { worker: Worker; pending: Map<number, { resolve: (result: ParseResult) => void; reject: (error: Error) => void }> } | null = null;
let nextParseId = 0;

function parseWorker() {
  if (parser) return parser;
  const worker = new Worker(parseWorkerSource, { eval: true, workerData: { moduleUrl: import.meta.resolve("@space/memory-graph") } });
  worker.unref();
  const state = { worker, pending: new Map<number, { resolve: (result: ParseResult) => void; reject: (error: Error) => void }>() };
  const fail = (error: Error) => {
    if (parser === state) parser = null;
    for (const waiting of state.pending.values()) waiting.reject(error);
    state.pending.clear();
  };
  worker.on("message", (message: { id: number; error?: string } & Partial<ParseResult>) => {
    const waiting = state.pending.get(message.id);
    if (!waiting) return;
    state.pending.delete(message.id);
    if (state.pending.size === 0) worker.unref();
    if (message.error !== undefined) waiting.reject(new Error(`Canonical memory parser failed: ${message.error}`));
    else waiting.resolve({ records: message.records!, searchText: message.searchText! });
  });
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`Canonical memory parser exited with code ${code}.`)));
  parser = state;
  return state;
}

function parseRecordsOffThread(source: { path: string; kind: "MONTHLY" | "INDEX"; content: string }, modifiedAt: string): Promise<ParseResult> {
  const state = parseWorker();
  return new Promise((resolve, reject) => {
    const id = ++nextParseId;
    state.pending.set(id, { resolve, reject });
    state.worker.ref();
    state.worker.postMessage({ id, source, modifiedAt });
  });
}

function fingerprint(s: Awaited<ReturnType<typeof lstat>>): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}

export interface CanonicalMemoryReaderOptions {
  /** Private directory that keeps parsed sources across processes (recall CLI only). */
  persistentCacheDir?: string;
}

type SearchText = [title: string, body: string] | null;
interface ParsedSource { fingerprint: string; records: MemoryGraphRecord[]; searchText?: SearchText[] }

function createPersistentSourceCache(directory: string) {
  // Entries are keyed by the loaded @space/memory-graph code, so a parser or normalization
  // change invalidates them without a manual version bump.
  async function version(): Promise<string | null> {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return null;
      const moduleDirectory = dirname(fileURLToPath(import.meta.resolve("@space/memory-graph")));
      const hash = createHash("sha256").update(`format=${persistentCacheFormat}\n`);
      for (const name of (await readdir(moduleDirectory)).filter(name => name.endsWith(".js")).sort()) {
        hash.update(`${name}\n`).update(await readFile(join(moduleDirectory, name)));
      }
      return hash.digest("hex");
    } catch { return null; }
  }
  let ready: Promise<string | null> | null = null;
  const file = (path: string) => join(directory, `${createHash("sha256").update(path).digest("hex").slice(0, 32)}.json`);
  return {
    async read(path: string, expected: string): Promise<ParsedSource | null> {
      const key = await (ready ??= version());
      if (!key) return null;
      try {
        const cached = JSON.parse(await readFile(file(path), "utf8")) as ParsedSource & { version?: string; path?: string };
        return cached.version === key && cached.path === path && cached.fingerprint === expected &&
          Array.isArray(cached.records) && Array.isArray(cached.searchText) && cached.searchText.length === cached.records.length
          ? { fingerprint: expected, records: cached.records, searchText: cached.searchText } : null;
      } catch { return null; }
    },
    async write(path: string, parsed: ParsedSource): Promise<void> {
      const key = await (ready ??= version());
      if (!key) return;
      const target = file(path);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: key, path, ...parsed }), { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
      } catch { await rm(temporary, { force: true }).catch(() => undefined); }
    }
  };
}

export function createCanonicalMemoryReader(paths: CanonicalSpaceMemoryPaths, options: CanonicalMemoryReaderOptions = {}) {
  const cache = new Map<string, ParsedSource>();
  const persistent = options.persistentCacheDir ? createPersistentSourceCache(options.persistentCacheDir) : null;
  const searchTexts = new WeakMap<MemoryGraphRecord, NonNullable<SearchText>>();
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
      if (cached?.fingerprint !== fingerprint(info)) cached = await persistent?.read(path, fingerprint(info)) ?? undefined;
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
        const parsed = await parseRecordsOffThread({ path, kind, content }, info.mtime.toISOString());
        // Search uses a normalized text only where redaction leaves the record unchanged (list() checks it).
        cached = { fingerprint: fingerprint(info), records: parsed.records, searchText: parsed.searchText };
        if (persistent) {
          // Only those texts are kept on disk.
          await persistent.write(path, { ...cached, searchText: parsed.records.map((r, n) =>
            redactMemoryText(r.title).slice(0, 160) === r.title.slice(0, 160) && redactMemoryText(r.body) === r.body ? parsed.searchText[n]! : null) });
        }
      }
      if (cache.get(path) !== cached) {
        cache.set(path, cached);
        cached.searchText?.forEach((text, n) => { if (text) searchTexts.set(cached.records[n]!, text); });
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
      .map(r => {
        const title = redactMemoryText(r.title).slice(0, 160), body = redactMemoryText(r.body);
        const text = searchTexts.get(r);
        return {
          id: r.id, scope: r.scope, roomId: r.roomId, title, body,
          provenance: redactMemoryText(r.sourcePath).slice(0, 500),
          createdAt: /\bcreated_at=(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(r.body)?.[1] ?? r.createdAt,
          ...(text && title === r.title.slice(0, 160) && body === r.body
            ? { searchText: { source: [title, body] as [string, string], title: text[0], body: text[1] } } : {})
        };
      });
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
