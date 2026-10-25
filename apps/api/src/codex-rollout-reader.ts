import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

const readBytes = 64 * 1024;
const cacheEntries = 64;
const cacheIdleMs = 15 * 60_000;

export interface RolloutReducer<T> {
  accept(line: string): void;
  result(): T;
  checkpoint(): unknown;
  restore(checkpoint: unknown): void;
}

interface Scan<T> {
  reducer: RolloutReducer<T>;
  offset: number;
  inode: number;
  device: number;
  mtimeMs: number;
  decoder: StringDecoder;
  partial: string[];
  matched: boolean;
  matchTail: string;
  usedAt: number;
  tail: Buffer;
  prefix: Buffer;
  value?: T;
}

/** One serialized reader per query; completed JSONL records are reduced once.
 * Only a possibly incomplete last record and reducer state are retained, never
 * the complete transcript. The file is opened/checked on every poll. */
export class IncrementalRolloutReader {
  private readonly scans = new Map<string, Scan<unknown>>();
  private readonly flights = new Map<string, Promise<unknown>>();
  readonly metrics = { bytesRead: 0, recordsRead: 0, resets: 0 };

  async read<T>(input: {
    home: string;
    path: string;
    key: string;
    contains?: string;
    create: () => RolloutReducer<T>;
  }): Promise<{ value: T; mtimeMs: number; matched: boolean }> {
    const key = createHash("sha256").update(JSON.stringify([input.home, input.path, input.key, input.contains])).digest("hex");
    const active = this.flights.get(key);
    if (active) return active as Promise<{ value: T; mtimeMs: number; matched: boolean }>;
    const request = this.scan(key, input);
    this.flights.set(key, request);
    try { return await request; }
    finally { if (this.flights.get(key) === request) this.flights.delete(key); }
  }

  private async scan<T>(key: string, input: {
    home: string; path: string; contains?: string; create: () => RolloutReducer<T>;
  }): Promise<{ value: T; mtimeMs: number; matched: boolean }> {
    const home = await realpath(input.home);
    const path = await realpath(input.path);
    if (!path.startsWith(`${resolve(home)}${sep}`)) throw new Error("Rollout is outside the Codex home.");
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Rollout is not a regular file.");
      let scan = this.scans.get(key) as Scan<T> | undefined;
      let replaced = scan && (scan.inode !== info.ino || scan.device !== info.dev ||
        info.size < scan.offset || (info.size === scan.offset && info.mtimeMs !== scan.mtimeMs));
      // Detect a rewrite followed by growth, rather than treating it as append.
      if (scan && !replaced && info.size > scan.offset && scan.tail.length) {
        const tail = Buffer.alloc(scan.tail.length);
        const read = await handle.read(tail, 0, tail.length, scan.offset - tail.length);
        this.metrics.bytesRead += read.bytesRead;
        replaced = read.bytesRead !== tail.length || !tail.equals(scan.tail);
        const prefix = Buffer.alloc(scan.prefix.length);
        const first = await handle.read(prefix, 0, prefix.length, 0);
        this.metrics.bytesRead += first.bytesRead;
        replaced ||= first.bytesRead !== prefix.length || !prefix.equals(scan.prefix);
      }
      if (!scan || replaced) {
        if (scan) this.metrics.resets += 1;
        scan = {
          reducer: input.create(), offset: 0, inode: info.ino, device: info.dev,
          mtimeMs: info.mtimeMs, decoder: new StringDecoder("utf8"), partial: [],
          matched: !input.contains, matchTail: "", usedAt: Date.now(), tail: Buffer.alloc(0), prefix: Buffer.alloc(0)
        };
      }
      this.scans.delete(key);
      scan.usedAt = Date.now();
      const buffer = Buffer.alloc(readBytes);
      while (scan.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - scan.offset), scan.offset);
        if (!bytesRead) throw new Error("Rollout changed while being read.");
        this.metrics.bytesRead += bytesRead;
        scan.offset += bytesRead;
        if (scan.prefix.length === 0) scan.prefix = Buffer.from(buffer.subarray(0, Math.min(128, bytesRead)));
        scan.tail = Buffer.from(buffer.subarray(Math.max(0, bytesRead - 128), bytesRead));
        const text = scan.decoder.write(buffer.subarray(0, bytesRead));
        if (!scan.matched && input.contains) {
          const candidate = scan.matchTail + text;
          scan.matched = candidate.includes(input.contains);
          scan.matchTail = scan.matched || input.contains.length === 1 ? "" : candidate.slice(-(input.contains.length - 1));
        }
        const lines = text.split("\n");
        for (let index = 0; index < lines.length - 1; index += 1) {
          scan.partial.push(lines[index]!);
          scan.reducer.accept(scan.partial.join(""));
          scan.partial = [];
          this.metrics.recordsRead += 1;
        }
        if (lines.at(-1)) scan.partial.push(lines.at(-1)!);
        // Yield even with hot filesystem cache and long bursts of small records.
        await new Promise<void>((done) => setImmediate(done));
      }
      scan.mtimeMs = info.mtimeMs;
      // Existing native writers/tests may leave a complete JSON object at EOF
      // without LF. Preview it without committing; a split/extended record must
      // be processed exactly once when its newline eventually arrives.
      const checkpoint = scan.reducer.checkpoint();
      const partial = scan.partial.join("");
      try {
        if (partial) scan.reducer.accept(partial);
        scan.value = scan.reducer.result();
      } finally { scan.reducer.restore(checkpoint); }
      // A pathological partial record must not remain resident between polls.
      if (Buffer.byteLength(partial) <= readBytes) this.scans.set(key, scan as Scan<unknown>);
      for (const [oldKey, old] of this.scans) {
        if (this.scans.size <= cacheEntries && Date.now() - old.usedAt <= cacheIdleMs) break;
        this.scans.delete(oldKey);
      }
      return { value: scan.value as T, mtimeMs: info.mtimeMs, matched: scan.matched };
    } catch (error) {
      this.scans.delete(key);
      throw error;
    } finally { await handle.close(); }
  }
}
