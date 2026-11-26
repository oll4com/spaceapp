import { describe, expect, it } from "vitest";
import { staleRead } from "../src/stale-read.js";

describe("staleRead (23/11: a 1143 s Postgres fsync held every gateway request on its reads)", () => {
  it("waits for the first value, then serves the last one while storage hangs, and the new one once it answers", async () => {
    let calls = 0;
    let release: (value: string) => void = () => undefined;
    let load = async () => "v1";
    const read = staleRead(() => { calls += 1; return load(); }, 0, { waitMs: 20 });
    expect(await read.get()).toBe("v1");
    load = () => new Promise<string>((resolve) => { release = resolve; });
    expect(await read.get()).toBe("v1");
    expect(await read.get()).toBe("v1");
    // The hung query stays the one refresh: no new query per request piles onto the stalled pool.
    expect(calls).toBe(2);
    release("v2");
    load = async () => "v3";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await read.get()).toBe("v3");
  });

  it("serves the last value when storage fails", async () => {
    let fail = false;
    const read = staleRead(() => (fail ? Promise.reject(new Error("timeout exceeded when trying to connect")) : Promise.resolve("v1")), 0, { waitMs: 20 });
    expect(await read.get()).toBe("v1");
    fail = true;
    expect(await read.get()).toBe("v1");
  });

  it("runs one refresh for all callers and none inside the ttl", async () => {
    let calls = 0;
    let clock = 0;
    const read = staleRead(async () => `v${++calls}`, 1_000, { now: () => clock });
    await Promise.all([read.get(), read.get(), read.get()]);
    expect(calls).toBe(1);
    clock = 999;
    expect(await read.get()).toBe("v1");
    clock = 1_001;
    expect(await Promise.all([read.get(), read.get()])).toEqual(["v2", "v2"]);
    expect(calls).toBe(2);
  });

  it("after expire reads storage again, and a read begun before it never overwrites the newer value", async () => {
    let release: (value: string) => void = () => undefined;
    let load = () => new Promise<string>((resolve) => { release = resolve; });
    const read = staleRead(() => load(), 60_000, { waitMs: 20 });
    const first = read.get();
    const releaseOld = release;
    releaseOld("v1");
    expect(await first).toBe("v1");
    expect(await read.get()).toBe("v1");
    read.expire();
    const before = read.get();
    const staleLoad = release;
    read.expire();
    load = async () => "after-write";
    expect(await read.get()).toBe("after-write");
    staleLoad("before-write");
    await before;
    expect(await read.get()).toBe("after-write");
  });

  it("fails like storage when it has no value yet", async () => {
    const read = staleRead(() => Promise.reject(new Error("down")), 0, { waitMs: 20 });
    await expect(read.get()).rejects.toThrow("down");
  });
});
