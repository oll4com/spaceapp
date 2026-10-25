import { describe, expect, it, vi } from "vitest";
import { createStaleWhileRevalidateCache } from "../src/stale-while-revalidate.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("stale-while-revalidate cache", () => {
  it("shares one in-flight load between concurrent callers and serves it while fresh", async () => {
    let nowMs = 0;
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 1_000, now: () => nowMs });
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);

    const first = cache.get("a", load);
    const second = cache.get("a", load);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    pending.resolve("one");
    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("one");

    nowMs = 999;
    await expect(cache.get("a", load)).resolves.toBe("one");
    expect(load).toHaveBeenCalledOnce();
  });

  it("returns the stale value immediately and refreshes once in the background", async () => {
    let nowMs = 0;
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 1_000, now: () => nowMs });
    await cache.get("a", async () => "old");

    nowMs = 1_500;
    const refresh = deferred<string>();
    const load = vi.fn(() => refresh.promise);
    await expect(cache.get("a", load)).resolves.toBe("old");
    await expect(cache.get("a", load)).resolves.toBe("old");
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();

    refresh.resolve("new");
    await refresh.promise;
    await Promise.resolve();
    await expect(cache.get("a", load)).resolves.toBe("new");
    expect(load).toHaveBeenCalledOnce();
  });

  it("blocks on a reload once a value is older than maxAgeMs", async () => {
    let nowMs = 0;
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 1_000, maxAgeMs: 5_000, now: () => nowMs });
    await cache.get("a", async () => "old");
    nowMs = 5_000;
    await expect(cache.get("a", async () => "new")).resolves.toBe("new");
  });

  it("acts as a plain TTL cache when maxAgeMs equals freshMs", async () => {
    let nowMs = 0;
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 1_000, maxAgeMs: 1_000, now: () => nowMs });
    await cache.get("a", async () => "old");
    nowMs = 1_000;
    await expect(cache.get("a", async () => "new")).resolves.toBe("new");
  });

  it("never stores failures by default and retries on the next read", async () => {
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 60_000 });
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    await expect(cache.get("a", load)).rejects.toThrow("boom");
    expect(cache.size).toBe(0);
    await expect(cache.get("a", load)).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("replays a blocking failure only for errorTtlMs", async () => {
    let nowMs = 0;
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 60_000, errorTtlMs: 100, now: () => nowMs });
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    await expect(cache.get("a", load)).rejects.toThrow("boom");
    nowMs = 99;
    await expect(cache.get("a", load)).rejects.toThrow("boom");
    expect(load).toHaveBeenCalledOnce();
    nowMs = 100;
    await expect(cache.get("a", load)).resolves.toBe("ok");
  });

  it("keeps serving the stale value after a failed background refresh and backs off", async () => {
    let nowMs = 0;
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 1_000, errorTtlMs: 500, now: () => nowMs });
    await cache.get("a", async () => "good");
    nowMs = 2_000;
    const failing = vi.fn(async () => { throw new Error("refresh failed"); });
    await expect(cache.get("a", failing)).resolves.toBe("good");
    await vi.waitFor(() => expect(failing).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    nowMs = 2_400;
    await expect(cache.get("a", failing)).resolves.toBe("good");
    await Promise.resolve();
    expect(failing).toHaveBeenCalledOnce();

    nowMs = 2_600;
    const recovered = vi.fn(async () => "fresh");
    await expect(cache.get("a", recovered)).resolves.toBe("good");
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    await expect(cache.get("a", recovered)).resolves.toBe("fresh");
  });

  it("does not let a load that started before invalidation repopulate the cache", async () => {
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 60_000 });
    const beforeMutation = deferred<string>();
    const early = cache.get("a", () => beforeMutation.promise);
    cache.invalidate("a");
    const afterMutation = cache.get("a", async () => "after");
    beforeMutation.resolve("before");
    await expect(early).resolves.toBe("before");
    await expect(afterMutation).resolves.toBe("after");
    await expect(cache.get("a", async () => "unexpected")).resolves.toBe("after");
  });

  it("invalidates one key or every key", async () => {
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 60_000 });
    await cache.get("a", async () => "a1");
    await cache.get("b", async () => "b1");
    cache.invalidate("a");
    await expect(cache.get("a", async () => "a2")).resolves.toBe("a2");
    await expect(cache.get("b", async () => "b2")).resolves.toBe("b1");
    cache.invalidate();
    await expect(cache.get("b", async () => "b3")).resolves.toBe("b3");
  });

  it("bypasses fresh values on force", async () => {
    const cache = createStaleWhileRevalidateCache<string>({ freshMs: 60_000 });
    await cache.get("a", async () => "cached");
    await expect(cache.get("a", async () => "forced", { force: true })).resolves.toBe("forced");
    await expect(cache.get("a", async () => "unexpected")).resolves.toBe("forced");
  });

  it("supports per-value freshness and bounds the number of keys", async () => {
    let nowMs = 0;
    const cache = createStaleWhileRevalidateCache<string | null>({
      freshMs: (value) => (value === null ? 10 : 1_000),
      maxAgeMs: 0,
      maxEntries: 2,
      now: () => nowMs
    });
    await cache.get("missing", async () => null);
    await cache.get("ready", async () => "READY");
    nowMs = 10;
    await expect(cache.get("missing", async () => "READY")).resolves.toBe("READY");
    await expect(cache.get("ready", async () => "unexpected")).resolves.toBe("READY");
    await cache.get("third", async () => "x");
    expect(cache.size).toBe(2);
  });
});
