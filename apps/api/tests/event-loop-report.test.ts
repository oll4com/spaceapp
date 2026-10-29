import { describe, expect, it, vi } from "vitest";
import { reportEventLoopLoad, summarizeCpuProfile, type CpuProfile } from "../src/event-loop-report.js";

function blockTheLoopFor300ms() {
  const until = Date.now() + 300;
  let spins = 0;
  while (Date.now() < until) spins += 1;
  return spins;
}

describe("event loop report", () => {
  it("logs utilization and delay percentiles once per interval and stops", async () => {
    const log = { info: vi.fn() };
    const stop = reportEventLoopLoad(log, 50);
    const loads = () => log.info.mock.calls.filter(([, message]) => message === "Event loop load");
    await vi.waitFor(() => expect(loads().length).toBeGreaterThan(0), { timeout: 2_000 });
    stop();
    const calls = loads().length;
    const [fields] = loads()[0]!;
    expect(fields).toMatchObject({ event: "event_loop.load" });
    for (const key of ["utilization", "delayP50Ms", "delayP99Ms", "delayMaxMs"]) expect(fields[key]).toBeGreaterThanOrEqual(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loads()).toHaveLength(calls);
  });

  it("profiles the first interval and names the code that blocked the loop", async () => {
    const log = { info: vi.fn() };
    const stop = reportEventLoopLoad(log, 600, { profileEveryMs: 3_600_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    blockTheLoopFor300ms();
    const profiles = () => log.info.mock.calls.filter(([, message]) => message === "Event loop profile");
    await vi.waitFor(() => expect(profiles()).toHaveLength(1), { timeout: 3_000 });
    stop();
    const [fields] = profiles()[0]!;
    expect(fields.event).toBe("event_loop.profile");
    expect(fields.longestBlockMs).toBeGreaterThanOrEqual(200);
    expect(fields.blockStack.join("\n")).toContain("blockTheLoopFor300ms");
    expect(fields.topSelf[0].frame).toContain("blockTheLoopFor300ms");
  });
});

describe("event loop profiling after the first interval", () => {
  it("profiles again only after an interval that blocked the loop", async () => {
    const log = { info: vi.fn() };
    const profiles = () => log.info.mock.calls.filter(([, message]) => message === "Event loop profile");
    const stop = reportEventLoopLoad(log, 250, { profileEveryMs: 0, profileAfterBlockMs: 150 });
    await vi.waitFor(() => expect(profiles()).toHaveLength(1), { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(profiles()).toHaveLength(1);
    blockTheLoopFor300ms();
    await vi.waitFor(() => expect(profiles()).toHaveLength(2), { timeout: 3_000 });
    stop();
  });
});

describe("summarizeCpuProfile", () => {
  it("splits blocks at idle samples and counts GC as busy", () => {
    const frame = (functionName: string, url = "", lineNumber = 0) => ({ functionName, url, lineNumber });
    const checkout = new URL("../../../", import.meta.url).href;
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame("(root)"), children: [2, 3, 4, 5] },
        { id: 2, callFrame: frame("(idle)") },
        { id: 3, callFrame: frame("handler", `${checkout}apps/api/dist/app.js`, 9), children: [6] },
        { id: 4, callFrame: frame("(garbage collector)") },
        { id: 5, callFrame: frame("(program)") },
        { id: 6, callFrame: frame("parse", `${checkout}apps/api/dist/store.js`, 41) }
      ],
      samples: [2, 3, 6, 6, 4, 2, 3, 5, 3],
      timeDeltas: [0, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]
    };
    expect(summarizeCpuProfile(profile)).toEqual({
      busyMs: 60,
      gcMs: 10,
      longestBlockMs: 40,
      blockStack: ["parse apps/api/dist/store.js:42", "handler apps/api/dist/app.js:10"],
      topSelf: [
        { frame: "handler apps/api/dist/app.js:10", ms: 30 },
        { frame: "parse apps/api/dist/store.js:42", ms: 20 },
        { frame: "(garbage collector)", ms: 10 }
      ]
    });
  });
});
