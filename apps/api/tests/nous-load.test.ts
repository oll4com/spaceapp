// Nous's Load tab (operator 31/10 13:58 BKK, plan clipboard:f4SH36t3fJ6c): the share of the server and token capacity in use, its
// minute rows and the hour and day sums its averages come from, answered from memory.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { GatewayAccount } from "@space/contracts";
import { InMemoryNousRepository } from "@space/db";
import type { HealthCollectorSample } from "../src/system-health-collector.js";
import { nousPoolUtilization } from "../src/nous/tokens.js";
import { createNousLoad, localDay, nousUtilization, parsePsi, registerNousLoadRoute, renderNousUtilization, renderUtilizationLow, utilizationPushOn, type NousOwnerParts, type NousUtilizationInput } from "../src/nous/utilization.js";

const GiB = 1024 ** 3;
const owner = "user:operator";
const server = (extra: Partial<NousUtilizationInput> = {}): NousUtilizationInput => ({ cpuPercent: 40, load5: 4, cores: 16, memTotalBytes: 64 * GiB, memAvailableBytes: 32 * GiB,
  swapPercent: 10, psi: { cpu: 2, memory: 0, io: 4 }, tokens: { claude: 60, codex: 40, noRoom: null }, panes: { working: 3, open: 6 }, helpers: { live: 1, max: 5 }, ...extra });

describe("nousUtilization", () => {
  it("blends the parts by their weights and shows each part's share", () => {
    const result = nousUtilization(server());
    // 0.25·40 + 0.15·50 + 0.1·25 + 0.1·10 (io stalls 4% × 2.5) + 0.25·50 + 0.1·50 + 0.05·20
    expect(result.overall).toBe(39.5);
    expect(result.limit).toBeNull();
    expect(Object.fromEntries(result.parts.map((part) => [part.key, part.percent]))).toEqual({ cpu: 40, memory: 50, load: 25, pressure: 10, tokens: 50, panes: 50, helpers: 20 });
    expect(result.parts.find((part) => part.key === "panes")?.detail).toBe("3 of 6 working");
  });

  it("leaves parts without data out and shares their weight", () => {
    const result = nousUtilization(server({ swapPercent: null, psi: { cpu: null, memory: null, io: null }, tokens: null, panes: { working: 0, open: 0 }, helpers: null }));
    expect(result.overall).toBe(40); // (0.25·40 + 0.15·50 + 0.1·25) / 0.5
    expect(result.parts.filter((part) => part.percent === null).map((part) => part.key)).toEqual(["pressure", "tokens", "panes", "helpers"]);
  });

  it("reaches 100 at a hard limit: the server OVERLOADED or Nous's pool with no room", () => {
    const overloaded = nousUtilization(server({ host: { percent: 95, host: "pve", at: null, error: null } }));
    expect(overloaded).toMatchObject({ overall: 100, level: "OVERLOADED" });
    expect(overloaded.limit).toMatch(/OVERLOADED \(pve swap 95\.00%\)/);
    // Operator 3/11: this VM's CPU, RAM and swap are no limit; only pve's swap past 90% is.
    const vm207 = nousUtilization(server({ cpuPercent: 95, memAvailableBytes: 2 * GiB, swapPercent: 100, host: { percent: 44.2, host: "pve", at: null, error: null } }));
    expect(vm207).toMatchObject({ level: "CALM", limit: null });
    // The physical host has its own line; the parts stay this VM's (review E4uKRGTwQBkg 5).
    expect(vm207.parts.find((part) => part.key === "pressure")?.detail).toBe("this VM: stalls cpu 2%, memory 0%, io 4% · swap 100%");
    expect(vm207.host).toBe("pve swap 44.20%");
    expect(nousUtilization(server({ host: { percent: null, host: "host", at: null, error: "the collector did not answer" } })).host)
      .toBe("host swap unknown (the collector did not answer; holds nothing)");
    expect(nousUtilization(server({ tokens: { claude: 100, codex: 30, noRoom: "no claude account of Nous has room" } }))).toMatchObject({ overall: 100, limit: "no claude account of Nous has room" });
  });

  it("counts swap as pressure only without a PSI memory reading", () => {
    const pressure = (input: Partial<NousUtilizationInput>) => nousUtilization(server(input)).parts.find((part) => part.key === "pressure")!.percent;
    expect(pressure({ swapPercent: 35, psi: { cpu: 1.5, memory: 0.4, io: 0 } })).toBe(3.8);
    expect(pressure({ swapPercent: 40, psi: { cpu: null, memory: null, io: null } })).toBe(20);
  });

  it("reads PSI's some avg10", () => {
    expect(parsePsi("some avg10=1.25 avg60=0.40 avg300=0.10 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toBe(1.25);
    expect(parsePsi(null)).toBeNull();
  });

  it("counts a pool's accounts by the tighter of their 5-hour window and their week against its pace", () => {
    const at = Date.parse("2026-10-24T09:00:00Z");
    const account = (id: string, extra: Partial<GatewayAccount> = {}): GatewayAccount => ({ id, provider: "CLAUDE", label: id, alias: null, email: null, planType: "max",
      status: "ACTIVE", statusReason: null, priority: 0, warmupEnabled: false, resetCreditsAvailable: null, lastRefreshAt: null, lastUsedAt: null, createdAt: new Date(at).toISOString(),
      primaryWindow: { usedPercent: 10, resetAt: "2026-10-24T10:00:00.000Z", windowMinutes: 300 },
      secondaryWindow: { usedPercent: 10, resetAt: "2026-10-25T10:00:00.000Z", windowMinutes: 10080 }, ...extra });
    // The week is 85% passed: 10% used is 11.8% of its pace; an account at its quota is full.
    expect(nousPoolUtilization([account("a")], at).claude).toBeCloseTo(11.76, 1);
    expect(nousPoolUtilization([account("a"), account("b", { status: "QUOTA_EXCEEDED" })], at).claude).toBeCloseTo(55.9, 1);
    expect(nousPoolUtilization([account("a", { primaryWindow: { usedPercent: 70, resetAt: "2026-10-24T10:00:00.000Z", windowMinutes: 300 } })], at)).toEqual({ claude: 70, codex: null, gemini: null });
  });

  it("counts the Gemini pool from the Antigravity accounts' gemini quota group, without paused accounts", () => {
    const at = Date.parse("2026-10-24T09:00:00Z");
    const window = (usedPercent: number, minutes: number, resetAt: string) => ({ usedPercent, resetAt, windowMinutes: minutes });
    const antigravity = (id: string, status: GatewayAccount["status"], gemini: number): GatewayAccount => ({ id, provider: "ANTIGRAVITY", label: id, alias: null, email: null,
      planType: "google-ai-pro", status, statusReason: null, priority: 0, warmupEnabled: false, resetCreditsAvailable: null, lastRefreshAt: null, lastUsedAt: null,
      createdAt: new Date(at).toISOString(), primaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null }, secondaryWindow: { usedPercent: null, resetAt: null, windowMinutes: null },
      quotaGroups: [{ key: "claude", primaryWindow: window(90, 300, "2026-10-24T10:00:00.000Z"), secondaryWindow: window(90, 10080, "2026-10-25T10:00:00.000Z") },
        { key: "gemini", primaryWindow: window(gemini, 300, "2026-10-24T10:00:00.000Z"), secondaryWindow: window(0, 10080, "2026-10-25T10:00:00.000Z") }] });
    // The claude group (not a Nous route) and the paused account are not read: (20 + 60) / 2.
    expect(nousPoolUtilization([antigravity("a", "ACTIVE", 20), antigravity("b", "ACTIVE", 60), antigravity("c", "PAUSED", 100)], at)).toEqual({ claude: null, codex: null, gemini: 40 });
    const tokens = nousUtilization({ cpuPercent: null, load5: 0, cores: 0, memTotalBytes: null, memAvailableBytes: null, swapPercent: null, psi: { cpu: null, memory: null, io: null },
      tokens: { claude: 100, codex: 100, gemini: 40, noRoom: null }, panes: null, helpers: null }).parts.find((part) => part.key === "tokens");
    expect(tokens).toMatchObject({ percent: 80, detail: "Claude Max 100% · Codex 100% · Gemini 40%" });
  });
});

describe("the Load monitor", () => {
  const start = Date.parse("2026-10-31T06:58:00Z");
  const sample = (at: number, cpu: number): HealthCollectorSample => ({ sampledAt: new Date(at).toISOString(), coreCount: 16, uptimeSeconds: 1, metrics: [
    { id: "cpu", value: cpu }, { id: "memory-used", value: 32 * GiB, total: 64 * GiB }, { id: "memory-available", value: 32 * GiB }, { id: "swap", value: 0 }
  ] as HealthCollectorSample["metrics"] });
  const fixture = (target?: NousOwnerParts["target"]) => {
    let clock = start;
    const repository = new InMemoryNousRepository();
    const load = createNousLoad({ repository, owners: async () => [owner], zone: async () => "Asia/Bangkok", now: () => clock, loadavg: () => [0, 0, 0],
      read: async () => { throw new Error("no PSI here"); },
      ownerParts: async () => ({ target, tokens: null, panes: { working: 1, open: 2 }, helpers: { live: 0, max: 5 } }) });
    // cpu c, memory 50, load 0, pressure 0 (swap 0), panes 50, helpers 0 → (0.25c + 7.5 + 5) / 0.75
    const run = async (cpu: (minute: number) => number, minutes: number) => {
      for (let step = 0; step < minutes * 6; step += 1) { clock = start + step * 10_000; await load.tick(sample(clock, cpu(Math.floor(step / 6)))); }
    };
    return { repository, load, run, at: () => clock };
  };

  it("stores one row a minute with its points' mean, adds it to the hour and the local day, and answers from memory", async () => {
    const { repository, load, run, at } = fixture();
    await run((minute) => minute === 0 ? 40 : 80, 3);
    const view = await load.view(owner, "1h");
    const first = Math.round(((0.25 * 40 + 12.5) / 0.75) * 10) / 10, second = Math.round(((0.25 * 80 + 12.5) / 0.75) * 10) / 10;
    expect(view.overall).toBe(second);
    expect(view.series.at(-1)).toEqual({ at: new Date(at()).toISOString(), value: second });
    expect(view.series.length).toBe(18);
    const stored = await repository.listLoad(owner, { minutes: "2026-10-31", hours: "2026", days: "2026" });
    expect(stored.minutes).toEqual([{ at: "2026-10-31T06:58:00.000Z", overall: first }, { at: "2026-10-31T06:59:00.000Z", overall: second }]);
    // 06:58 UTC is 13:58 in Bangkok: both minutes fall on its 31/10 and the UTC hour 06.
    expect(stored.days).toEqual([{ bucket: "2026-10-31", total: first + second, samples: 2, peak: second }]);
    expect(stored.hours.map((bucket) => bucket.bucket)).toEqual(["2026-10-31T06"]);
    expect(view.averages.hour.value).toBe(Math.round(((first + second) / 2) * 10) / 10);
    expect(view.averages.today).toEqual({ value: Math.round(((first + second) / 2) * 10) / 10, previous: null });
    expect(view.averages.bestDay).toBeNull(); // under an hour of samples
    expect(view.parts.map((part) => part.key)).toEqual(["cpu", "memory", "load", "pressure", "tokens", "panes", "helpers"]);
  });

  it("reads the live helpers on every 10 s tick, so a helper between the minute's reads counts", async () => {
    let clock = start, live = 0;
    const load = createNousLoad({ repository: new InMemoryNousRepository(), owners: async () => [owner], zone: async () => "UTC", now: () => clock, loadavg: () => [0, 0, 0],
      read: async () => { throw new Error("no PSI here"); }, liveHelpers: () => live,
      ownerParts: async () => ({ tokens: null, panes: null, helpers: { live: 0, max: 5 } }) });
    await load.tick(sample(clock, 50));
    clock += 20_000; live = 2;
    await load.tick(sample(clock, 50));
    expect((await load.view(owner, "1h")).parts.find((part) => part.key === "helpers")).toMatchObject({ percent: 40, detail: "2 of 5 slots" });
  });

  it("keeps a minute written after the history was read in memory too, once", async () => {
    const { load, run } = fixture();
    await run(() => 40, 2);
    const before = await load.view(owner, "24h");
    await run(() => 40, 4); // re-runs minutes 0-1 (already stored) and adds 2-3
    const after = await load.view(owner, "24h");
    expect(before.averages.today.value).toBe(after.averages.today.value);
    expect(after.series.length).toBeGreaterThan(0);
  });

  it("answers GET /api/nous/load from the monitor", async () => {
    const { load, run } = fixture();
    await run(() => 40, 2);
    const app = Fastify();
    registerNousLoadRoute(app, { load, routeOptions: {}, owner: async () => owner, parseQuery: (schema, query) => schema.parse(query) });
    const response = await app.inject({ method: "GET", url: "/api/nous/load?range=7d" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ range: "7d", target: 90, level: "CALM", averages: { week: { value: expect.any(Number) } } });
    expect((await app.inject({ method: "GET", url: "/api/nous/load" })).json()).toMatchObject({ range: "1h" });
    await app.close();
  });

  it("holds the owner's Load target for its spend mode (Settings → Nous, 13/11): the summary, the view, the world line and the push follow it; 0 never pushes", async () => {
    const at = async (target: NousOwnerParts["target"]) => {
      const { load, run } = fixture(target);
      await run(() => 40, 11); // overall 30 for 11 minutes
      return { summary: (await load.summary(owner))!, view: await load.view(owner, "1h") };
    };
    const normal = await at({ percent: 40, mode: "NORMAL" });
    expect(normal.summary).toMatchObject({ target: 40, underForMs: 650_000 });
    expect(normal.view).toMatchObject({ target: 40, targetMode: "NORMAL" });
    expect(renderNousUtilization(normal.summary)).toMatch(/^Utilization 30% \(target 40%;.*headroom 10% →/);
    expect(utilizationPushOn(normal.summary, "NORMAL")).toBe(true);
    const low = await at({ percent: 25, mode: "LOW" });
    expect(low.summary).toMatchObject({ target: 25, underForMs: 0 });
    expect(low.view.targetMode).toBe("LOW");
    expect(renderNousUtilization(low.summary)).toContain(": at the target; keep the work going");
    expect(utilizationPushOn(low.summary, "LOW")).toBe(false);
    const off = await at({ percent: 0, mode: "CRITICAL" });
    expect(off.summary).toMatchObject({ target: 0, underForMs: 0 });
    expect(renderNousUtilization(off.summary)).not.toContain("Raise the average");
    // No setting read (older owners, tests): today's 90.
    const none = await at(undefined);
    expect(none.summary).toMatchObject({ target: 90, underForMs: 650_000 });
    expect(none.view).toMatchObject({ target: 90, targetMode: null });
  });

  it("names local days in the owner's zone", () => {
    expect(localDay(Date.parse("2026-10-31T18:00:00Z"), "Asia/Bangkok")).toBe("2026-11-01");
  });

  it("gives Nous one summary: how long it stayed under the target, the world line and the REVIEW's day against the day before", async () => {
    const { load, run } = fixture();
    expect(await load.summary(owner)).toBeNull();
    await run(() => 40, 3);
    const summary = (await load.summary(owner))!;
    expect(summary.underForMs).toBe(170_000);
    const line = renderNousUtilization(summary);
    expect(line).toMatch(/^Utilization 30% \(target 90%; avg today 30%, yesterday \?, 7 days 30%\): headroom 60% → start more parallel work now: idle panes, helpers \(space_subagents\), stalled plans, waiting requests\./);
    expect(line).toContain("Parts: CPU 40%, Memory 50%, Load 0%, Pressure 0%, Tokens ? (no Gateway sample), CLI panes 50% (1 of 2 working), Helpers 0% (0 of 5 slots).");
    expect(renderUtilizationLow(summary, { plans: 2, requests: 1 })).toContain("Waiting: 2 open plans, 1 operator request.");
    // No day before today in the store yet: nothing for the REVIEW.
    expect(await load.reviewLine(owner)).toBeNull();
  });

  it("names the limit, the target reached, and which part to prefer when the server and the pools differ", () => {
    const summary = (input: Partial<NousUtilizationInput>) => ({ ...nousUtilization(server(input)), at: 0, target: 90, underForMs: 0,
      averages: { hour: { value: null, previous: null }, today: { value: 50, previous: 40 }, week: { value: 45, previous: null }, month: { value: null, previous: null }, bestDay: null } });
    expect(renderNousUtilization(summary({ host: { percent: 95, host: "pve", at: null, error: null } }))).toContain(": at a limit (server OVERLOADED (pve swap 95.00%)); start nothing new until it clears.");
    expect(renderNousUtilization(summary({ cpuPercent: 10, load5: 2, tokens: { claude: 95, codex: 90, noRoom: null } })))
      .toContain("the server has room but the token pools are near their limit: prefer the pool with room (Provider advice)");
    expect(renderNousUtilization(summary({ cpuPercent: 80, tokens: { claude: 10, codex: 20, noRoom: null } }))).toContain("the token pools have room but the server is busy");
    expect(renderNousUtilization(summary({ cpuPercent: 89, memAvailableBytes: 5 * GiB, load5: 15, psi: { cpu: 40, memory: 0, io: 0 }, tokens: { claude: 99, codex: 99, noRoom: null }, panes: { working: 6, open: 6 }, helpers: { live: 5, max: 5 } })))
      .toContain(": at the target; keep the work going");
  });
});

describe("utilizationPushOn", () => {
  const summary = (input: Partial<NousUtilizationInput> = {}, underForMs = 15 * 60_000) => ({ ...nousUtilization(server(input)), at: 0, target: 90, underForMs,
    averages: { hour: { value: null, previous: null }, today: { value: 50, previous: 40 }, week: { value: 45, previous: null }, month: { value: null, previous: null }, bestDay: null } });

  it("runs in LOW while another pool has room (13/11: LOW of Nous's own pool silenced the push 13 h on 11/11 while Codex had room)", () => {
    expect(utilizationPushOn(summary({ tokens: { claude: 100, codex: 40, noRoom: null } }), "LOW")).toBe(true);
    expect(utilizationPushOn(summary(), "NORMAL")).toBe(true);
  });

  it("stays silent on CRITICAL, every pool at its pace, no account with room, an OVERLOADED server, busy panes or a short dip", () => {
    expect(utilizationPushOn(summary(), "CRITICAL")).toBe(false);
    expect(utilizationPushOn(summary({ tokens: { claude: 100, codex: 100, noRoom: null } }), "LOW")).toBe(false);
    expect(utilizationPushOn(summary({ tokens: { claude: 100, codex: 100, noRoom: "no account with room" } }), "LOW")).toBe(false);
    expect(utilizationPushOn(summary({ host: { percent: 95, host: "pve", at: null, error: null } }), "NORMAL")).toBe(false);
    expect(utilizationPushOn(summary({ panes: { working: 6, open: 6 } }), "NORMAL")).toBe(false);
    expect(utilizationPushOn(summary({}, 9 * 60_000), "NORMAL")).toBe(false);
  });
});
