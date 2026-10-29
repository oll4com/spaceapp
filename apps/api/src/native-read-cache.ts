/**
 * Short-lived cache for native task reads that spawn a launcher process
 * (claude/gemini `native-turns` through sudo). Badges, dashboards and the task
 * registry poll the same pane within seconds of each other; they now share one
 * read. A busy session expires sooner than an idle one, concurrent callers
 * share the read in flight, and `fresh` skips a finished result (it still joins
 * a read that is already running).
 */
export interface NativeReadCacheOptions<T> {
  busyTtlMs: number;
  idleTtlMs: number;
  isBusy: (value: T) => boolean;
  now?: () => number;
  maxEntries?: number;
}

interface Entry<T> {
  value: Promise<T | null>;
  /** Infinity while the read is still running. */
  expires: number;
}

export function createNativeReadCache<T>(options: NativeReadCacheOptions<T>) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 256;
  const entries = new Map<string, Entry<T>>();

  const prune = (time: number) => {
    if (entries.size < maxEntries) return;
    for (const [key, entry] of entries) if (entry.expires <= time) entries.delete(key);
  };

  return {
    read(key: string, load: () => Promise<T | null>, { fresh = false }: { fresh?: boolean } = {}): Promise<T | null> {
      const time = now();
      const cached = entries.get(key);
      if (cached && (cached.expires === Infinity || (!fresh && cached.expires > time))) return cached.value;
      prune(time);
      const entry: Entry<T> = { expires: Infinity, value: Promise.resolve(null) };
      entry.value = load().then(
        (value) => {
          // A missing or failed read is retried soon; a busy session refreshes faster than an idle one.
          entry.expires = now() + (value !== null && !options.isBusy(value) ? options.idleTtlMs : options.busyTtlMs);
          return value;
        },
        () => {
          entry.expires = now() + options.busyTtlMs;
          return null;
        }
      );
      entries.set(key, entry);
      return entry.value;
    },
    /** Drops every entry whose key starts with `prefix`, a read in flight too (it may finish with the old state). */
    expire(prefix: string): void {
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    },
    size: () => entries.size
  };
}
