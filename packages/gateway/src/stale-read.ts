/**
 * How long a request-path read waits on Postgres before it answers with the last value it had. 23/11 07:30-07:49 UTC a
 * 1143 s checkpoint fsync stalled the database and every model request through the gateway waited on its key lookup.
 */
export const STALE_READ_WAIT_MS = 2_000;

export interface StaleRead<T> {
  get(): Promise<T>;
  /** The next get reads storage again (after a write); the old value still answers while storage is slow or failing. */
  expire(): void;
}

/**
 * A cached read for the request path. Past `ttlMs` one refresh runs, shared by every caller; while it is slower than
 * `waitMs` or fails, callers get the last value. With no value yet they wait for storage as before.
 */
export function staleRead<T>(load: () => Promise<T>, ttlMs: number, options: { waitMs?: number; now?: () => number } = {}): StaleRead<T> {
  const waitMs = options.waitMs ?? STALE_READ_WAIT_MS;
  const now = options.now ?? Date.now;
  let last: { at: number; value: T } | null = null;
  let pending: Promise<T> | null = null;
  const refresh = () => {
    if (pending) return pending;
    const current: Promise<T> = load().then((value) => {
      // A read that started before expire() must not overwrite what the write after it changed.
      if (pending === current) last = { at: now(), value };
      return value;
    }).finally(() => { if (pending === current) pending = null; });
    pending = current;
    return current;
  };
  return {
    get() {
      if (last && now() - last.at < ttlMs) return Promise.resolve(last.value);
      const fresh = refresh();
      if (!last) return fresh;
      const fallback = last.value;
      return Promise.race([fresh.catch(() => fallback), new Promise<T>((resolve) => { setTimeout(resolve, waitMs, fallback).unref(); })]);
    },
    expire() {
      pending = null;
      if (last) last = { ...last, at: Number.NEGATIVE_INFINITY };
    }
  };
}
