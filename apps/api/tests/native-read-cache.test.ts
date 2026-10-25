import { describe, expect, it } from "vitest";
import { createNativeReadCache } from "../src/native-read-cache.js";

function harness() {
  let time = 1_000;
  let loads = 0;
  const cache = createNativeReadCache<{ busy: boolean; n: number }>({ busyTtlMs: 3_000, idleTtlMs: 6_000, isBusy: (value) => value.busy, now: () => time });
  return {
    cache,
    advance: (ms: number) => { time += ms; },
    load: (busy: boolean) => async () => ({ busy, n: ++loads }),
    loads: () => loads
  };
}

describe("native read cache", () => {
  it("shares one launcher read between callers polling the same pane", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.cache.read("pane", h.load(false)), h.cache.read("pane", h.load(false))]);
    expect(a).toBe(b);
    expect(h.loads()).toBe(1);
    h.advance(5_999);
    expect((await h.cache.read("pane", h.load(false)))?.n).toBe(1);
    h.advance(1);
    expect((await h.cache.read("pane", h.load(false)))?.n).toBe(2);
  });

  it("refreshes a busy session sooner than an idle one", async () => {
    const h = harness();
    await h.cache.read("pane", h.load(true));
    h.advance(3_000);
    expect((await h.cache.read("pane", h.load(true)))?.n).toBe(2);
  });

  it("fresh skips a finished result but joins a read that is already running", async () => {
    const h = harness();
    await h.cache.read("pane", h.load(false));
    expect((await h.cache.read("pane", h.load(false), { fresh: true }))?.n).toBe(2);
    const running = h.cache.read("pane-2", h.load(false));
    const joined = h.cache.read("pane-2", h.load(false), { fresh: true });
    expect(await joined).toBe(await running);
    expect(h.loads()).toBe(3);
  });

  it("retries a missing or failed read after the short interval", async () => {
    const h = harness();
    expect(await h.cache.read("pane", async () => null)).toBeNull();
    expect(await h.cache.read("pane", async () => { throw new Error("launcher failed"); }, { fresh: true })).toBeNull();
    h.advance(3_000);
    expect((await h.cache.read("pane", h.load(false)))?.n).toBe(1);
  });

  it("expire drops a pane's finished and in-flight reads only", async () => {
    const h = harness();
    await h.cache.read("pane:a|cli_session:1|10", h.load(false));
    await h.cache.read("pane:b|cli_session:2|11", h.load(false));
    const running = h.cache.read("pane:a|cli_session:3|12", h.load(false));
    h.cache.expire("pane:a|");
    expect(h.cache.size()).toBe(1);
    expect((await h.cache.read("pane:a|cli_session:1|10", h.load(false)))?.n).toBe(4);
    expect((await h.cache.read("pane:b|cli_session:2|11", h.load(false)))?.n).toBe(2);
    await running;
  });

  it("keeps different panes and sessions apart", async () => {
    const h = harness();
    await h.cache.read("pane:a|cli_session:1|10", h.load(false));
    await h.cache.read("pane:b|cli_session:2|11", h.load(false));
    expect(h.loads()).toBe(2);
    expect(h.cache.size()).toBe(2);
  });
});
