import { describe, expect, it, vi } from "vitest";
import type { SystemHealthHistory } from "@space/contracts";
import { classifyLoad, createServerLoad, paneRootsFrom, parsePs, renderServerLoad, topProcesses } from "../src/nous/server-load.js";

const GiB = 1024 ** 3;
const NOW = Date.parse("2026-10-17T10:30:00Z");
const calm = { cpuPercent: 40, load5: 8, cores: 20, memAvailableBytes: 20 * GiB, swapPercent: 10 };

/** Ten-second points over the last `minutes`, oldest first. */
function series(id: string, values: number[]) {
  return { id, label: id, unit: "PERCENT" as const, points: values.map((value, index) =>
    ({ at: new Date(NOW - (values.length - index) * 10_000).toISOString(), min: value, avg: value, max: value })) };
}
describe("Nous's server load", () => {
  it("is OVERLOADED, BUSY or CALM by the plan's thresholds", () => {
    expect(classifyLoad(calm)).toEqual({ level: "CALM", reasons: [] });
    // The operator's numbers when they asked: CPU 78%, swap 36.7%, 17 of 40 GiB available.
    expect(classifyLoad({ ...calm, cpuPercent: 78, swapPercent: 36.7, memAvailableBytes: 17 * GiB })).toEqual({ level: "BUSY", reasons: ["CPU 78%"] });
    // Stable 2026-10-17 (Nous held its work for an hour): swap 41-43% with CPU 25-36% and 17-20 GiB available is calm.
    expect(classifyLoad({ ...calm, cpuPercent: 25, swapPercent: 41 })).toEqual({ level: "CALM", reasons: [] });
    expect(classifyLoad({ ...calm, cpuPercent: 36, swapPercent: 43, memAvailableBytes: 17 * GiB }).level).toBe("CALM");
    expect(classifyLoad({ ...calm, memAvailableBytes: 7.9 * GiB }).level).toBe("BUSY");
    expect(classifyLoad({ ...calm, cpuPercent: 90 }).level).toBe("OVERLOADED");
    expect(classifyLoad({ ...calm, load5: 30 })).toEqual({ level: "OVERLOADED", reasons: ["load 30.0 on 20 cores"] });
    expect(classifyLoad({ ...calm, memAvailableBytes: 3 * GiB }).level).toBe("OVERLOADED");
    expect(classifyLoad({ ...calm, swapPercent: 60, cpuPercent: 80 })).toEqual({ level: "OVERLOADED", reasons: ["swap 60%"] });
    expect(classifyLoad({ ...calm, cpuPercent: null, swapPercent: null, memAvailableBytes: null }).level).toBe("CALM");
  });

  it("averages the last five minutes, so one busy sample does not decide and older samples do not count", async () => {
    // 40 points: the oldest ten (over five minutes ago) at 100%, then 50% with one 99% spike.
    const cpu = [...Array(10).fill(100), ...Array(29).fill(50), 99];
    const history: SystemHealthHistory = { range: "10m", sampledAt: new Date(NOW).toISOString(),
      series: [series("cpu", cpu), series("swap", Array(40).fill(20)), { ...series("memory-available", Array(40).fill(16 * GiB)), unit: "BYTES" }] };
    const load = createServerLoad({ health: { history: async () => history },
      paneRoots: async () => new Map(), ps: async () => "", loadavg: () => [12, 10, 9], cores: 20, memTotalBytes: 40 * GiB, now: () => NOW });
    const state = await load.read();
    expect(state).toMatchObject({ level: "CALM", samples: 30, load1: 12, load5: 10, cores: 20, swapPercent: 20, memAvailableBytes: 16 * GiB, memTotalBytes: 40 * GiB });
    expect(state.cpuPercent).toBeCloseTo((29 * 50 + 99) / 30);
  });

  it("decides by the load average alone before any sample is retained, and reads at most every 30 seconds", async () => {
    let now = NOW;
    const history = vi.fn(async (): Promise<SystemHealthHistory> => { throw new Error("no history"); });
    const load = createServerLoad({ health: { history }, paneRoots: async () => new Map(), ps: async () => "", loadavg: () => [31, 30, 20],
      cores: 20, memTotalBytes: 40 * GiB, now: () => now });
    expect(await load.read()).toMatchObject({ level: "OVERLOADED", samples: 0, cpuPercent: null, swapPercent: null, memAvailableBytes: null });
    now += 29_000;
    await load.read();
    expect(history).toHaveBeenCalledTimes(1);
    now += 2_000;
    await load.read();
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("leaves out the sampling ps's own row (stable 2026-10-19: Nous read it as ps at 400% CPU)", async () => {
    const ps = [`  9 ${process.pid} 412.0 3000 ps`, "  10 1 380.5 4000000 qemu-system-x86", "  11 7 2.0 1000 ps"].join("\n");
    const load = createServerLoad({ health: { history: async () => { throw new Error("no history"); } }, paneRoots: async () => new Map(),
      ps: async () => ps, loadavg: () => [1, 1, 1], cores: 20, memTotalBytes: 40 * GiB, now: () => NOW });
    expect((await load.read()).topCpu.map((row) => row.pid)).toEqual([10, 11]);
  });

  it("names the heaviest processes with the pane whose CLI runs them", () => {
    const rows = parsePs([
      "    1     0  0.1   9000 systemd",
      "  100     1  2.0 400000 codex-pane-host",
      "  200   100  5.0 800000 claude",
      "  300   200 97.5 2500000 node",
      "  400     1 60.0 3000000 postgres",
      "garbage line"
    ].join("\n"));
    expect(rows).toHaveLength(5);
    const top = topProcesses(rows, new Map([[200, "Dino/Finn"]]), 2);
    expect(top.topCpu).toEqual([
      { pid: 300, command: "node", cpuPercent: 97.5, rssBytes: 2_500_000 * 1024, pane: "Dino/Finn" },
      { pid: 400, command: "postgres", cpuPercent: 60, rssBytes: 3_000_000 * 1024, pane: null }
    ]);
    expect(top.topMemory.map((process) => process.pid)).toEqual([400, 300]);
  });

  it("maps each running CLI session's root process to its room and pane", async () => {
    const store = {
      listRooms: async () => [{ id: "room:dino", name: "Dino", archivedAt: null }, { id: "room:old", name: "Old", archivedAt: "2026-10-01T00:00:00Z" }],
      listPanes: async (roomId: string) => roomId === "room:dino" ? [{ id: "pane:finn", paneName: "Finn", title: "x", isClosed: false },
        { id: "pane:max", paneName: "Max", title: "y", isClosed: false }, { id: "pane:gone", paneName: "Gone", title: "z", isClosed: true }] : [{ id: "pane:old", paneName: "Old", title: "o", isClosed: false }],
      getActivePaneCliSession: async (paneId: string) => paneId === "pane:max" ? null : { sessionId: `s-${paneId}`, isActive: true }
    };
    const sessionPids = vi.fn(async () => new Map([["s-pane:finn", 200]]));
    expect(await paneRootsFrom(store as never, sessionPids)()).toEqual(new Map([[200, "Dino/Finn"]]));
    expect(sessionPids).toHaveBeenCalledWith([{ sessionId: "s-pane:finn", isActive: true }]);
  });

  it("renders one line with the level, the numbers and what to do, then the heavy processes", () => {
    const line = renderServerLoad({ level: "BUSY", reasons: ["CPU 78%"], cpuPercent: 78.4, load1: 15.3, load5: 17.4, cores: 20, memAvailableBytes: 17 * GiB,
      memTotalBytes: 40 * GiB, swapPercent: 36.7, samples: 30, sampledAt: new Date(NOW).toISOString(),
      topCpu: [{ pid: 300, command: "node", cpuPercent: 97.5, rssBytes: GiB, pane: "Dino/Finn" }], topMemory: [] });
    expect(line.split("\n")).toEqual([
      "Server: BUSY (CPU 78%) · CPU 78% · load 15.3/17.4 on 20 cores · RAM available 17 of 40 GiB · swap 37% (5 min average)."
        + " BUSY: start no new work in panes now: open no new panes and send new work with when \"calm\" (it goes once the server allows); answers, stops and closes go at once.",
      "Top CPU: node (Dino/Finn) 98%."
    ]);
  });
});
