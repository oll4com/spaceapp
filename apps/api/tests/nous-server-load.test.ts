import { describe, expect, it, vi } from "vitest";
import type { SystemHealthHistory } from "@space/contracts";
import { InMemoryControlRepository } from "@space/db";
import { createHeldDispatch } from "../src/nous/held-dispatch.js";
import { classifyLoad, createHostSwap, createServerLoad, hostSwapOf, hostSwapQuery, paneRootsFrom, parsePs, renderServerLoad, topProcesses, type HostSwap, type HostSwapReader } from "../src/nous/server-load.js";

const GiB = 1024 ** 3;
const NOW = Date.parse("2026-10-17T10:30:00Z");
const calmHost = { read: async (): Promise<HostSwap> => ({ percent: 10, host: "pve", at: null, error: null }) };

/** Ten-second points over the last `minutes`, oldest first. */
function series(id: string, values: number[]) {
  return { id, label: id, unit: "PERCENT" as const, points: values.map((value, index) =>
    ({ at: new Date(NOW - (values.length - index) * 10_000).toISOString(), min: value, avg: value, max: value })) };
}
describe("Nous's server load", () => {
  it("is OVERLOADED only past 90% of the physical host's swap, whatever this VM's CPU, RAM or load (operator 3/11)", () => {
    expect(classifyLoad({ swapPercent: 44.2, host: "pve" })).toEqual({ level: "CALM", reasons: [] });
    expect(classifyLoad({ swapPercent: 90 })).toEqual({ level: "CALM", reasons: [] });
    expect(classifyLoad({ swapPercent: 89.99 }).level).toBe("CALM");
    // Full precision (review E4uKRGTwQBkg 1): 90.004 is past 90 even though it shows as 90.00.
    expect(classifyLoad({ swapPercent: 90.004, host: "pve" })).toEqual({ level: "OVERLOADED", reasons: ["pve swap 90.00%"] });
    expect(classifyLoad({ swapPercent: 90.01, host: "pve" })).toEqual({ level: "OVERLOADED", reasons: ["pve swap 90.01%"] });
    expect(classifyLoad({ swapPercent: 100, host: "pve" }).level).toBe("OVERLOADED");
    expect(classifyLoad({ swapPercent: null }).level).toBe("CALM");
  });

  const pve = (percent: number | null, at = NOW - 12_000): HostSwap => ({ percent, host: "pve", at: percent === null ? null : new Date(at).toISOString(), error: percent === null ? "no sample" : null });
  const reader = (host: HostSwap) => ({ read: async () => host });
  /** public-host as on 3/11: its zram swap full, CPU 95%, 2 GiB available, load 40 on 24 cores. */
  const vm207 = (): SystemHealthHistory => ({ range: "10m", sampledAt: new Date(NOW).toISOString(),
    series: [series("cpu", Array(30).fill(95)), series("swap", Array(30).fill(100)), { ...series("memory-available", Array(30).fill(2 * GiB)), unit: "BYTES" }] });
  const loadOf = (host: HostSwapReader, history = vm207()) => createServerLoad({ health: { history: async () => history }, hostSwap: host,
    paneRoots: async () => new Map(), ps: async () => "", loadavg: () => [40, 40, 40], cores: 24, memTotalBytes: 47 * GiB, now: () => NOW });

  it("holds nothing at pve 44% while public-host reads swap 100%, CPU 95% and load 40, and says the VM numbers are diagnostics", async () => {
    const state = await loadOf(reader(pve(44.2))).read();
    expect(state).toMatchObject({ level: "CALM", reasons: [], swapPercent: 100, cpuPercent: 95, host: { percent: 44.2, host: "pve" } });
    expect(renderServerLoad(state)).toMatch(/^Server: CALM · pve swap 44\.20% \(12 s old\), OVERLOADED only past 90% · this VM \(diagnostics, holds nothing\): CPU 95% · load 40\.0\/40\.0 on 24 cores .* swap 100% \(5 min average\)\.$/);
  });

  it("is OVERLOADED past 90% of pve's swap, not at exactly 90, and a missing reading is unknown, never 100", async () => {
    expect(await loadOf(reader(pve(91.5))).read()).toMatchObject({ level: "OVERLOADED", reasons: ["pve swap 91.50%"] });
    expect((await loadOf(reader(pve(90))).read()).level).toBe("CALM");
    const missing = await loadOf(reader(pve(null))).read();
    expect(missing).toMatchObject({ level: "CALM", host: { percent: null } });
    expect(renderServerLoad(missing)).toContain("pve swap unknown (no sample; holds nothing)");
    // A reader that throws is no reading either.
    expect((await loadOf({ read: async () => { throw new Error("down"); } }).read()).level).toBe("CALM");
  });

  const labels = (name: string, instance = "192.0.2.1:9100", node = "pve") => ({ __name__: name, job: "proxmox_host", instance, node_name: node });
  const sample = (name: string, value: number | string, at = NOW / 1000 - 10, instance?: string, node?: string) =>
    ({ labels: labels(name, instance, node), points: [[at - 15, String(value)], [at, String(value)]] as Array<[number, string]> });
  // 3/11 16:53 BKK: SwapTotal 42940223488, SwapFree 24000131072 (44.11%).
  const TOTAL = 42940223488, FREE = 24000131072;
  const fresh = () => [sample("node_memory_SwapTotal_bytes", TOTAL), sample("node_memory_SwapFree_bytes", FREE)];

  it("takes one host's paired, valid and fresh SwapTotal and SwapFree at full precision, and refuses everything else (review E4uKRGTwQBkg 2-3)", () => {
    expect(hostSwapOf(fresh(), NOW)).toEqual({ percent: (100 * (TOTAL - FREE)) / TOTAL, host: "pve", at: new Date(NOW - 10_000).toISOString(), error: null });
    // 90.005% stays past 90, not 90.0.
    expect(hostSwapOf([sample("node_memory_SwapTotal_bytes", 100_000), sample("node_memory_SwapFree_bytes", 9_995)], NOW).percent).toBeCloseTo(90.005, 9);
    const refused = (series: ReturnType<typeof fresh>) => hostSwapOf(series, NOW);
    expect(refused([])).toMatchObject({ percent: null, error: "the collector has no host swap sample from the last 2 minutes" });
    expect(refused([fresh()[0]!])).toMatchObject({ percent: null, error: "the collector has only SwapTotal for pve" });
    expect(refused([fresh()[1]!])).toMatchObject({ percent: null, error: "the collector has only SwapFree for pve" });
    // Two hosts under one selector are never summed into one server.
    expect(refused([...fresh(), sample("node_memory_SwapTotal_bytes", TOTAL, undefined, "192.0.2.9:9100", "pve2"), sample("node_memory_SwapFree_bytes", 0, undefined, "192.0.2.9:9100", "pve2")]))
      .toMatchObject({ percent: null, error: "SPACE_LOAD_HOST_SELECTOR matches 2 hosts; it must name one" });
    // Halves of different hosts do not make a pair.
    expect(refused([fresh()[0]!, sample("node_memory_SwapFree_bytes", FREE, undefined, "192.0.2.9:9100", "pve2")])).toMatchObject({ percent: null, error: expect.stringMatching(/matches 2 hosts/) });
    expect(refused([...fresh(), { ...fresh()[0]!, labels: { ...labels("node_memory_SwapCached_bytes") } }])).toMatchObject({ percent: null, error: "the collector answered an unexpected series node_memory_SwapCached_bytes" });
    expect(refused([fresh()[0]!, fresh()[0]!, fresh()[1]!])).toMatchObject({ percent: null, error: "two node_memory_SwapTotal_bytes series for one host" });
    expect(refused([fresh()[0]!, sample("node_memory_SwapFree_bytes", "NaN")])).toMatchObject({ percent: null, error: "node_memory_SwapFree_bytes has no valid sample" });
    expect(refused([fresh()[0]!, sample("node_memory_SwapFree_bytes", -1)])).toMatchObject({ percent: null });
    expect(refused([fresh()[0]!, sample("node_memory_SwapFree_bytes", TOTAL + 1)])).toMatchObject({ percent: null, error: "pve's SwapFree exceeds its SwapTotal" });
    expect(refused([fresh()[0]!, { ...fresh()[1]!, points: [] }])).toMatchObject({ percent: null });
    // Stale (over 2 minutes before now) or from the future (over a minute after): unknown.
    const at = (seconds: number) => [sample("node_memory_SwapTotal_bytes", TOTAL, seconds), sample("node_memory_SwapFree_bytes", FREE, seconds)];
    expect(refused(at(NOW / 1000 - 121))).toMatchObject({ percent: null, error: "pve's swap sample is from 10:27:59 UTC, not within 2 minutes of now" });
    expect(refused(at(NOW / 1000 + 61)).percent).toBeNull();
    expect(refused(at(NOW / 1000 - 119)).percent).not.toBeNull();
  });

  it("reads the configured host from the collector, unknown when stale or down, this machine's only without a selector", async () => {
    const collectorConfig = { network: "192.0.2.0/24", defaults: { prometheusUrl: "http://192.0.2.210:9090", alertmanagerUrl: "http://192.0.2.210:9093", lokiUrl: "http://192.0.2.210:3100" } };
    const hostSelector = 'job="proxmox_host",instance="192.0.2.1:9100"';
    const promQuery = vi.fn(async () => ({ resultType: "matrix", series: fresh(), truncated: false }));
    const meminfo = vi.fn(async () => "SwapTotal: 16777212 kB\nSwapFree: 0 kB\n");
    let now = NOW;
    const host = createHostSwap({ collectorConfig, hostSelector, collector: { promQuery }, meminfo, now: () => now });
    expect(await host.read()).toMatchObject({ host: "pve", error: null, at: new Date(NOW - 10_000).toISOString() });
    expect(promQuery).toHaveBeenCalledWith("http://192.0.2.210:9090",
      { query: '{__name__=~"node_memory_Swap(Total|Free)_bytes",job="proxmox_host",instance="192.0.2.1:9100"}[2m]' });
    expect(hostSwapQuery(hostSelector)).toBe(promQuery.mock.calls[0]![1].query);
    await host.read();
    expect(promQuery).toHaveBeenCalledTimes(1);
    // 3 minutes on, the same samples are stale; then the collector is down. public-host's 100% never stands in.
    now += 180_000;
    expect(await host.read()).toMatchObject({ percent: null, error: expect.stringMatching(/not within 2 minutes of now/) });
    promQuery.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    now += 30_000;
    expect(await host.read()).toMatchObject({ percent: null, error: "the collector did not answer (connect ECONNREFUSED)" });
    expect(meminfo).not.toHaveBeenCalled();
    // A selector without a collector is a misconfiguration, not this machine.
    expect(await createHostSwap({ collectorConfig: { network: null, defaults: null }, hostSelector, meminfo, now: () => NOW }).read())
      .toMatchObject({ percent: null, error: expect.stringMatching(/without a collector/) });
    // No selector (an install without a hypervisor): this machine's swap, even when a collector is configured.
    expect(await createHostSwap({ collectorConfig, hostSelector: null, collector: { promQuery }, meminfo, now: () => NOW }).read())
      .toEqual({ percent: 100, host: "this machine", at: new Date(NOW).toISOString(), error: null });
  });

  it("drains the texts held under the false OVERLOADED once pve reads 44%, one per pane per tick, never twice", async () => {
    const swap = { value: pve(95) };
    let clock = NOW;
    const live = createServerLoad({ health: { history: async () => vm207() }, hostSwap: { read: async () => swap.value }, paneRoots: async () => new Map(), ps: async () => "",
      loadavg: () => [40, 40, 40], cores: 24, memTotalBytes: 47 * GiB, now: () => clock });
    expect((await live.read()).level).toBe("OVERLOADED");
    const sent: string[] = [];
    const held = createHeldDispatch({ repository: new InMemoryControlRepository(), level: async () => (await live.read()).level,
      deliver: async (item) => { sent.push(`${item.paneName}: ${item.text}`); return { ok: true, result: "sent" }; }, notice: async () => undefined });
    const andy = { roomId: "room:dino0001", roomName: "Dino", paneId: "pane:andy0001", paneName: "Andy" };
    await held.hold("user:operator", andy, "Step 2.");
    await held.hold("user:operator", andy, "Step 3.");
    expect(await held.tick()).toEqual({ delivered: 0, failed: 0 });
    swap.value = pve(44.2);
    clock += 30_000;
    expect(await held.tick()).toEqual({ delivered: 1, failed: 0 });
    expect(await held.tick()).toEqual({ delivered: 1, failed: 0 });
    expect(await held.tick()).toEqual({ delivered: 0, failed: 0 });
    expect(sent).toEqual(["Andy: Step 2.", "Andy: Step 3."]);
  });

  it("averages the last five minutes, so one busy sample does not decide and older samples do not count", async () => {
    // 40 points: the oldest ten (over five minutes ago) at 100%, then 50% with one 99% spike.
    const cpu = [...Array(10).fill(100), ...Array(29).fill(50), 99];
    const history: SystemHealthHistory = { range: "10m", sampledAt: new Date(NOW).toISOString(),
      series: [series("cpu", cpu), series("swap", Array(40).fill(20)), { ...series("memory-available", Array(40).fill(16 * GiB)), unit: "BYTES" }] };
    const load = createServerLoad({ health: { history: async () => history }, hostSwap: calmHost,
      paneRoots: async () => new Map(), ps: async () => "", loadavg: () => [12, 10, 9], cores: 20, memTotalBytes: 40 * GiB, now: () => NOW });
    const state = await load.read();
    expect(state).toMatchObject({ level: "CALM", samples: 30, load1: 12, load5: 10, cores: 20, swapPercent: 20, memAvailableBytes: 16 * GiB, memTotalBytes: 40 * GiB });
    expect(state.cpuPercent).toBeCloseTo((29 * 50 + 99) / 30);
  });

  it("is CALM before any sample is retained, whatever the load average (operator 31/10 22:31 BKK), and reads at most every 30 seconds", async () => {
    let now = NOW;
    const history = vi.fn(async (): Promise<SystemHealthHistory> => { throw new Error("no history"); });
    const load = createServerLoad({ health: { history }, hostSwap: calmHost, paneRoots: async () => new Map(), ps: async () => "", loadavg: () => [31, 30, 20],
      cores: 20, memTotalBytes: 40 * GiB, now: () => now });
    expect(await load.read()).toMatchObject({ level: "CALM", samples: 0, cpuPercent: null, swapPercent: null, memAvailableBytes: null });
    now += 29_000;
    await load.read();
    expect(history).toHaveBeenCalledTimes(1);
    now += 2_000;
    await load.read();
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("leaves out the sampling ps's own row (stable 2026-10-19: Nous read it as ps at 400% CPU)", async () => {
    const ps = [`  9 ${process.pid} 412.0 3000 ps`, "  10 1 380.5 4000000 qemu-system-x86", "  11 7 2.0 1000 ps"].join("\n");
    const load = createServerLoad({ health: { history: async () => { throw new Error("no history"); } }, hostSwap: calmHost, paneRoots: async () => new Map(),
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
    const line = renderServerLoad({ level: "OVERLOADED", reasons: ["pve swap 92.00%"], cpuPercent: 78.4, load1: 15.3, load5: 17.4, cores: 20, memAvailableBytes: 17 * GiB,
      memTotalBytes: 40 * GiB, swapPercent: 36.7, host: pve(92), samples: 30, sampledAt: new Date(NOW).toISOString(),
      topCpu: [{ pid: 300, command: "node", cpuPercent: 97.5, rssBytes: GiB, pane: "Dino/Finn" }], topMemory: [] });
    expect(line.split("\n")).toEqual([
      "Server: OVERLOADED (pve swap 92.00%) · pve swap 92.00% (12 s old), OVERLOADED only past 90% · this VM (diagnostics, holds nothing): CPU 78% · load 15.3/17.4 on 20 cores · RAM available 17 of 40 GiB · swap 37% (5 min average)."
        + " OVERLOADED: start no new work in panes now: open no new panes, send work only with when \"calm\" (urgent only for what cannot wait) and start nothing heavy; answers, stops and closes go at once.",
      "Top CPU: node (Dino/Finn) 98%."
    ]);
  });
});
