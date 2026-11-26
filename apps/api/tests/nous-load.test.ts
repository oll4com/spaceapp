// Nous's Load tab (operator 31/10 13:58 BKK, plan clipboard:f4SH36t3fJ6c): the share of the server and token capacity in use, its
// minute rows and the hour and day sums its averages come from, answered from memory.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { GatewayAccount } from "@space/contracts";
import { InMemoryNousRepository } from "@space/db";
import type { HealthCollectorSample } from "../src/system-health-collector.js";
import { nousPoolUtilization } from "../src/nous/tokens.js";
import { createNousLoad, goalPieces, localDay, nousUtilization, parsePsi, registerNousLoadRoute, registryOpen, renderNousUtilization, renderUtilizationLow, upgradeQueueOpen, upgradeQueueOpenLines, utilizationPushOn, type NousOwnerParts, type NousUtilizationInput } from "../src/nous/utilization.js";

const GiB = 1024 ** 3;
const owner = "user:operator";
const server = (extra: Partial<NousUtilizationInput> = {}): NousUtilizationInput => ({ cpuPercent: 40, load5: 4, cores: 16, memTotalBytes: 64 * GiB, memAvailableBytes: 32 * GiB,
  swapPercent: 10, psi: { cpu: 2, memory: 0, io: 4 }, tokens: { claude: 60, codex: 40, noRoom: null }, panes: { working: 3, open: 6 }, helpers: { live: 1, max: 5 }, ...extra });

describe("nousUtilization", () => {
  it("reads the overall as the CLI panes working and shows each part's share", () => {
    const result = nousUtilization(server());
    // 21/11: the server and tokens are shown, not blended (v1 read ~58 % with every pane working on a 20-core VM).
    expect(result.overall).toBe(50);
    expect(nousUtilization(server({ cpuPercent: 30, panes: { working: 9, open: 10 } })).overall).toBe(90);
    expect(result.limit).toBeNull();
    expect(Object.fromEntries(result.parts.map((part) => [part.key, part.percent]))).toEqual({ cpu: 40, memory: 50, load: 25, pressure: 10, tokens: 50, panes: 50, helpers: 20 });
    expect(result.parts.find((part) => part.key === "panes")?.detail).toBe("3 of 6 working");
  });

  it("leaves parts without data out: no CLI pane open reads 0, whatever the server does", () => {
    const result = nousUtilization(server({ swapPercent: null, psi: { cpu: null, memory: null, io: null }, tokens: null, panes: { working: 0, open: 0 }, helpers: null }));
    expect(result.overall).toBe(0);
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
    // Operator 21/11 (nous_msg:694ff0a9): no room is pace, not a limit: the overall stays the panes' share and the Tokens part names it.
    const noRoom = nousUtilization(server({ tokens: { claude: 100, codex: 30, noRoom: "no claude account of Nous has room" } }));
    expect(noRoom).toMatchObject({ overall: 50, limit: null });
    expect(noRoom.parts.find((part) => part.key === "tokens")?.detail).toContain("no claude account of Nous has room");
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

  it("counts a pool's accounts by the tighter of their 5-hour window and their week used, not the week's pace", () => {
    const at = Date.parse("2026-10-24T09:00:00Z");
    const account = (id: string, extra: Partial<GatewayAccount> = {}): GatewayAccount => ({ id, provider: "CLAUDE", label: id, alias: null, email: null, planType: "max",
      status: "ACTIVE", statusReason: null, priority: 0, warmupEnabled: false, resetCreditsAvailable: null, lastRefreshAt: null, lastUsedAt: null, createdAt: new Date(at).toISOString(),
      primaryWindow: { usedPercent: 10, resetAt: "2026-10-24T10:00:00.000Z", windowMinutes: 300 },
      secondaryWindow: { usedPercent: 10, resetAt: "2026-10-25T10:00:00.000Z", windowMinutes: 10080 }, ...extra });
    // 10% of 5 hours and 10% of the week in use; an account at its quota is full.
    expect(nousPoolUtilization([account("a")], at).claude).toBe(10);
    expect(nousPoolUtilization([account("a"), account("b", { status: "QUOTA_EXCEEDED" })], at).claude).toBe(55);
    expect(nousPoolUtilization([account("a", { primaryWindow: { usedPercent: 70, resetAt: "2026-10-24T10:00:00.000Z", windowMinutes: 300 } })], at)).toEqual({ claude: 70, codex: null, gemini: null });
    // 2026-11-23 REVIEW (22/11 20:00Z): crew 2% into a week reset an hour ago with 14% of its 5 hours read 100 as pace; dev 89% of its week is room in use.
    const crew = account("crew", { primaryWindow: { usedPercent: 14, resetAt: "2026-10-24T13:00:00.000Z", windowMinutes: 300 },
      secondaryWindow: { usedPercent: 2, resetAt: "2026-10-31T08:00:00.000Z", windowMinutes: 10080 } });
    const dev = account("dev", { primaryWindow: { usedPercent: 5, resetAt: "2026-10-24T13:00:00.000Z", windowMinutes: 300 },
      secondaryWindow: { usedPercent: 89, resetAt: "2026-10-28T12:00:00.000Z", windowMinutes: 10080 } });
    expect(nousPoolUtilization([crew], at).claude).toBe(14);
    expect(nousPoolUtilization([crew, dev], at).claude).toBe(51.5);
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

  it("closes an OPEN queue line when a later DONE line cites it with 'was OPEN'", () => {
    const queue = [
      "- DONE 2026-11-22 (earlier) was OPEN 2026-11-23 REVIEW: reopened later",
      "- OPEN 2026-11-23 REVIEW: panes.move fails; evidence: 3 of 18; fix: check state",
      "- OPEN 2026-11-23 REVIEW: still open; evidence: 1 of 4; fix: spread panes",
      "- OPEN 2026-11-23 REVIEW: reopened later; evidence: 2 of 5; fix: retry",
      "- OPEN (not taken): inline done. [DONE 2026-11-22]",
      "- DONE 2026-11-24 (shipped) was OPEN 2026-11-23 REVIEW: panes.move fails"
    ].join("\n");
    expect(upgradeQueueOpenLines(queue)).toEqual([
      "- OPEN 2026-11-23 REVIEW: still open; evidence: 1 of 4; fix: spread panes",
      "- OPEN 2026-11-23 REVIEW: reopened later; evidence: 2 of 5; fix: retry"
    ]);
    expect(upgradeQueueOpen(queue)).toEqual(["2026-11-23 REVIEW: still open", "2026-11-23 REVIEW: reopened later"]);
  });
});

describe("the Load monitor", () => {
  const start = Date.parse("2026-10-31T06:58:00Z");
  const sample = (at: number, cpu: number): HealthCollectorSample => ({ sampledAt: new Date(at).toISOString(), coreCount: 16, uptimeSeconds: 1, metrics: [
    { id: "cpu", value: cpu }, { id: "memory-used", value: 32 * GiB, total: 64 * GiB }, { id: "memory-available", value: 32 * GiB }, { id: "swap", value: 0 }
  ] as HealthCollectorSample["metrics"] });
  const fixture = (target?: NousOwnerParts["target"]) => {
    let clock = start;
    let working = 0;
    const repository = new InMemoryNousRepository();
    const load = createNousLoad({ repository, owners: async () => [owner], zone: async () => "Asia/Bangkok", now: () => clock, loadavg: () => [0, 0, 0],
      read: async () => { throw new Error("no PSI here"); },
      ownerParts: async () => ({ target, tokens: null, panes: { working, open: 10 }, helpers: { live: 0, max: 5 } }) });
    // The overall is the CLI panes working of 10; the owner's parts are read on each minute's first tick.
    const run = async (percent: (minute: number) => number, minutes: number) => {
      for (let step = 0; step < minutes * 6; step += 1) { clock = start + step * 10_000; working = percent(Math.floor(step / 6)) / 10; await load.tick(sample(clock, 40)); }
    };
    return { repository, load, run, at: () => clock };
  };

  it("stores one row a minute with its points' mean, adds it to the hour and the local day, and answers from memory", async () => {
    const { repository, load, run, at } = fixture();
    await run((minute) => minute === 0 ? 40 : 80, 3);
    const view = await load.view(owner, "1h");
    const first = 40, second = 80;
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
      await run(() => 30, 11); // overall 30 for 11 minutes
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

  it("counts the time under the target by the mean of the newest points, so one 10 s spike over it does not restart the count (13/11 02:32-14:07 UTC: no push at 81-89%)", async () => {
    let clock = start;
    let swap = 0;
    const load = createNousLoad({ repository: new InMemoryNousRepository(), owners: async () => [owner], zone: async () => "UTC", now: () => clock, loadavg: () => [0, 0, 0],
      read: async () => { throw new Error("no PSI here"); }, hostSwap: { read: async () => ({ percent: swap, host: "pve", at: new Date(clock).toISOString(), error: null }) },
      ownerParts: async () => ({ target: { percent: 40, mode: "NORMAL" }, tokens: null, panes: { working: 1, open: 20 }, helpers: { live: 0, max: 5 } }) });
    // A point is 100 only while the host is OVERLOADED, the only 10 s spike left: overall 5 with one point a minute at 100, over the target 40.
    const spike = async (overloaded: boolean) => { swap = overloaded ? 95 : 0; await load.tick(sample(clock, 40)); };
    for (let step = 0; step < 66; step += 1) { clock = start + step * 10_000; await spike(step % 6 === 3); }
    const summary = (await load.summary(owner))!;
    expect(summary.underForMs).toBe(650_000);
    expect(utilizationPushOn(summary, "NORMAL")).toBe(true);
    // Over the target now: nothing under it.
    clock += 10_000; await spike(true);
    expect((await load.summary(owner))!.underForMs).toBe(0);
    // A minute at 5 after 4 minutes at 100: the rolling minute reaches 40 at the third 100 back.
    for (let step = 0; step < 24; step += 1) { clock += 10_000; await spike(true); }
    for (let step = 0; step < 6; step += 1) { clock += 10_000; await spike(false); }
    expect((await load.summary(owner))!.underForMs).toBe(70_000);
  });

  it("names local days in the owner's zone", () => {
    expect(localDay(Date.parse("2026-10-31T18:00:00Z"), "Asia/Bangkok")).toBe("2026-11-01");
  });

  it("gives Nous one summary: how long it stayed under the target, the world line and the REVIEW's day against the day before", async () => {
    const { load, run } = fixture();
    expect(await load.summary(owner)).toBeNull();
    await run(() => 30, 3);
    const summary = (await load.summary(owner))!;
    expect(summary.underForMs).toBe(170_000);
    const line = renderNousUtilization(summary);
    expect(line).toMatch(/^Utilization 30% \(target 90%; avg today 30%, yesterday \?, 7 days 30%\): headroom 60% → start more parallel work now: idle panes, helpers \(space_subagents\), stalled plans, waiting requests\./);
    expect(line).toContain("Parts: CPU 40%, Memory 50%, Load 0%, Pressure 0%, Tokens ? (no Gateway sample), CLI panes 30% (3 of 10 working), Helpers 0% (0 of 5 slots).");
    expect(renderUtilizationLow(summary, { plans: 2, requests: 1 })).toContain("Runnable: 2 plans with a step to run, 1 operator request, 0 daily-improvement fixes, 0 quality-registry findings.");
    // 21/11: the daily review's OPEN fixes are runnable work, each to its cause.
    const improvements = upgradeQueueOpen("## 2026-11-20 REVIEW\n- OPEN 2026-11-20 REVIEW: X fails; evidence: 5 of 9; fix: retry\n- DONE 2026-11-19 REVIEW: Y\n- OPEN (not taken): Z (1)");
    expect(improvements).toEqual(["2026-11-20 REVIEW: X fails", "(not taken): Z (1)"]);
    // 22/11 REVIEW: a line marked DONE in place is no runnable work, so the free-pane hand-out never sends it again.
    expect(upgradeQueueOpen("- OPEN (not taken): W (5). [DONE 2026-11-22, no new code (Jack): q-20261121-164019-639a]")).toEqual([]);
    expect(renderUtilizationLow(summary, { plans: 0, requests: 0, improvements })).toContain("0 operator requests, 2 daily-improvement fixes, 0 quality-registry findings.");
    // 22/11 (operator «load 90%», every plan parked, queue empty): the registry's confirmed findings not yet fixed are runnable work; fixed,
    // product-decision and Warm-owned ones are not.
    const findings = registryOpen(JSON.stringify({ findings: [
      { id: "API-007", status: "confirmed", resolution: "partial", severity: "P2", owner: "Codex" }, { id: "FS-001", status: "confirmed", resolution: "open", severity: "P1" },
      { id: "CORE-002", status: "confirmed", resolution: "fixed", severity: "P0" }, { id: "UI-009", status: "product-decision", resolution: "open", severity: "P2" },
      { id: "PERF-002", status: "confirmed", resolution: "partial", severity: "P3", owner: "Warm owners (hidden-pane polling is part of the user-protected Warm baseline, item 4)" },
      { id: "SEC-001", status: "already-fixed", resolution: "fixed", severity: "P0" },
      { id: "SEC-014", status: "confirmed", resolution: "partial", severity: "P2", waitsOn: "release: the next public export" }] }));
    expect(findings.map((f) => f.id)).toEqual(["FS-001", "API-007"]);
    expect(registryOpen("not json")).toEqual([]);
    const withRegistry = renderUtilizationLow(summary, { plans: 0, requests: 0, findings });
    expect(withRegistry).toContain("0 daily-improvement fixes, 2 quality-registry findings.");
    expect(withRegistry).toMatch(/docs\/quality\/review-findings\.json.*: FS-001 \(P1\), API-007 \(P2\)$/);
    // 22/11 (nous_msg:0e499daa): ACTIVE goals are runnable work for free panes, any model, in priority order; paused ones are not.
    expect(renderUtilizationLow(summary, { plans: 0, requests: 0, goals: 2 })).toContain("0 quality-registry findings, 2 active goals.");
    const goal = (id: string, priority: number, status: string, extra: object = {}) => ({ id, priority, status, text: `Goal ${id}`, planIds: [], waitsOn: null, ...extra }) as never;
    const pieces = goalPieces([goal("nous_goal:b", 2, "ACTIVE", { waitsOn: { kind: "THIRD_PARTY", what: "Linkwise approval", until: null }, planIds: ["clipboard:p1"] }),
      goal("nous_goal:a", 1, "ACTIVE"), goal("nous_goal:c", 3, "PAUSED")]);
    expect(pieces.map((piece) => [piece.key, piece.strong])).toEqual([["goal:nous_goal:a", false], ["goal:nous_goal:b", false]]);
    expect(pieces[1]!.text).toContain("«Goal nous_goal:b» (its plans: clipboard:p1). It waits on THIRD_PARTY: Linkwise approval; that wait stays with Nous.");
    // No day before today in the store yet: nothing for the REVIEW.
    expect(await load.reviewLine(owner)).toBeNull();
  });

  it("names the limit, the target reached, and which part to prefer when the server and the pools differ", () => {
    const summary = (input: Partial<NousUtilizationInput>) => ({ ...nousUtilization(server(input)), at: 0, target: 90, underForMs: 0,
      averages: { hour: { value: null, previous: null }, today: { value: 50, previous: 40 }, week: { value: 45, previous: null }, month: { value: null, previous: null }, bestDay: null } });
    expect(renderNousUtilization(summary({ host: { percent: 95, host: "pve", at: null, error: null } }))).toContain(": at a limit (server OVERLOADED (pve swap 95.00%)); start nothing new until it clears.");
    expect(renderNousUtilization(summary({ cpuPercent: 10, load5: 2, tokens: { claude: 95, codex: 90, noRoom: null } })))
      .toContain("Tokens is the room in use, not a stop: every account not RATE_LIMITED or spent still runs");
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

  it("runs with the tokens part at 100 while a pool has room and panes idle (13/11 20:05 BKK: pace 100 silenced it 12:00-12:51 UTC)", () => {
    const paced = summary({ tokens: { claude: 100, codex: 100, noRoom: null }, panes: { working: 1, open: 6 } });
    expect(paced.parts.find((part) => part.key === "tokens")?.percent).toBe(100);
    expect(utilizationPushOn(paced, "LOW")).toBe(true);
    expect(utilizationPushOn(paced, "CRITICAL")).toBe(false);
  });

  it("runs while Nous's own pool has no room (21/11 nous_msg:694ff0a9: pace, not a limit; CRITICAL still stops it)", () => {
    const noRoom = summary({ tokens: { claude: 100, codex: 100, noRoom: "no account with room" } });
    expect(noRoom.limit).toBeNull();
    expect(utilizationPushOn(noRoom, "LOW")).toBe(true);
    expect(utilizationPushOn(noRoom, "CRITICAL")).toBe(false);
  });

  it("stays silent on CRITICAL, an OVERLOADED server, busy panes or a short dip", () => {
    expect(utilizationPushOn(summary(), "CRITICAL")).toBe(false);
    expect(utilizationPushOn(summary({ host: { percent: 95, host: "pve", at: null, error: null } }), "NORMAL")).toBe(false);
    expect(utilizationPushOn(summary({ panes: { working: 6, open: 6 } }), "NORMAL")).toBe(false);
    expect(utilizationPushOn(summary({}, 9 * 60_000), "NORMAL")).toBe(false);
  });

  it("runs at once for a pane that just finished while utilization is under the target (13/11 23:03 BKK), never above it", () => {
    expect(utilizationPushOn(summary({}, 0), "NORMAL", true)).toBe(true);
    expect(utilizationPushOn({ ...summary({}, 0), target: 10 }, "NORMAL", true)).toBe(false);
    expect(utilizationPushOn(summary({}, 0), "CRITICAL", true)).toBe(false);
  });
});
