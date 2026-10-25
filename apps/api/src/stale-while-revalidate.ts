/**
 * Keyed single-flight cache with stale-while-revalidate reads.
 *
 * - A value younger than `freshMs` is returned without any load.
 * - An older value that is still younger than `maxAgeMs` is returned
 *   immediately while exactly one background refresh runs for its key.
 * - Missing, invalidated or too-old entries make callers wait for one shared
 *   load per key; concurrent callers never start a second load.
 * - Failed loads are never stored as values. With `errorTtlMs > 0` a blocking
 *   failure is replayed for that window and a failed background refresh keeps
 *   serving the stale value for that window before retrying; with the default
 *   of 0 the next read simply retries.
 * - `invalidate()` drops entries and detaches in-flight loads, so a load that
 *   started before a mutation can never repopulate the cache afterwards.
 */
export interface StaleWhileRevalidateOptions<V> {
  /** How long a loaded value is served without starting a refresh. */
  freshMs: number | ((value: V) => number);
  /** Total age after which a value is no longer served; defaults to Infinity. */
  maxAgeMs?: number;
  /** Failure backoff before the next load for the same key; defaults to 0. */
  errorTtlMs?: number;
  /** Oldest entries are evicted beyond this many keys; defaults to 256. */
  maxEntries?: number;
  now?: () => number;
}

export interface StaleWhileRevalidateCache<V> {
  /** `force` skips cached values and joins no earlier load. */
  get(key: string, load: () => Promise<V>, options?: { force?: boolean }): Promise<V>;
  /** Drops one key, or every key when called without arguments. */
  invalidate(key?: string): void;
  readonly size: number;
}

type CacheEntry<V> =
  | { kind: "value"; value: V; refreshAtMs: number; expiresAtMs: number }
  | { kind: "error"; error: unknown; expiresAtMs: number };

interface CacheFlight<V> {
  promise: Promise<V>;
}

function nonNegative(value: number, fallback: number): number {
  return Number.isNaN(value) ? fallback : Math.max(0, value);
}

export function createStaleWhileRevalidateCache<V>(
  options: StaleWhileRevalidateOptions<V>
): StaleWhileRevalidateCache<V> {
  const now = options.now ?? Date.now;
  const maxAgeMs = nonNegative(options.maxAgeMs ?? Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const errorTtlMs = nonNegative(options.errorTtlMs ?? 0, 0);
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? 256));
  const entries = new Map<string, CacheEntry<V>>();
  const flights = new Map<string, CacheFlight<V>>();

  const freshFor = (value: V): number =>
    nonNegative(typeof options.freshMs === "function" ? options.freshMs(value) : options.freshMs, 0);

  const remember = (key: string, entry: CacheEntry<V>) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const start = (key: string, load: () => Promise<V>): Promise<V> => {
    const flight = {} as CacheFlight<V>;
    flight.promise = Promise.resolve().then(load).then(
      (value) => {
        if (flights.get(key) === flight) {
          flights.delete(key);
          const storedAtMs = now();
          const freshMs = freshFor(value);
          remember(key, {
            kind: "value",
            value,
            refreshAtMs: storedAtMs + freshMs,
            expiresAtMs: storedAtMs + Math.max(freshMs, maxAgeMs)
          });
        }
        return value;
      },
      (error: unknown) => {
        if (flights.get(key) === flight) {
          flights.delete(key);
          const failedAtMs = now();
          const current = entries.get(key);
          if (current?.kind === "value" && failedAtMs < current.expiresAtMs) {
            // A failed background refresh keeps the last good value; the next
            // refresh waits for the error backoff instead of looping per read.
            current.refreshAtMs = Math.min(failedAtMs + errorTtlMs, current.expiresAtMs);
          } else if (errorTtlMs > 0) {
            remember(key, { kind: "error", error, expiresAtMs: failedAtMs + errorTtlMs });
          } else {
            entries.delete(key);
          }
        }
        throw error;
      }
    );
    flights.set(key, flight);
    return flight.promise;
  };

  return {
    get(key, load, getOptions) {
      if (getOptions?.force) {
        entries.delete(key);
        flights.delete(key);
        return start(key, load);
      }
      const currentMs = now();
      const entry = entries.get(key);
      if (entry?.kind === "value") {
        if (currentMs < entry.refreshAtMs) return Promise.resolve(entry.value);
        if (currentMs < entry.expiresAtMs) {
          if (!flights.has(key)) void start(key, load).catch(() => undefined);
          return Promise.resolve(entry.value);
        }
      } else if (entry?.kind === "error" && currentMs < entry.expiresAtMs) {
        return Promise.reject(entry.error);
      }
      return flights.get(key)?.promise ?? start(key, load);
    },
    invalidate(key) {
      if (key === undefined) {
        entries.clear();
        flights.clear();
        return;
      }
      entries.delete(key);
      flights.delete(key);
    },
    get size() {
      return entries.size;
    }
  };
}
