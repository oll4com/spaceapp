// The Monitoring Copilot pane (plan clipboard:xkCJ9CeYZq4D): the watch pass over the collector's Alertmanager (critical alerts to
// Nous as ATTENTION, warnings INFO, repeats silent, resolved alerts resolve their card, a new episode alerts again), the collector-down
// card, the guardian relay's messages (grouped, classified, repeats folded into one card, recoveries resolving), bounded and cached
// queries that never return log lines, the agent's work order, and the operator and agent routes.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryMonitoringCopilotRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { defaultMonitoringCopilotPaneMetadata, monitoringCollectorDefaults, type AlertmanagerAlert, type MonitoringPromQuery, type NotificationRaiseInput } from "@space/contracts";
import { createMonitoringCollector, seriesOf, type GuardianLine, type MonitoringCollector } from "../src/monitoring-copilot/collector.js";
import { MONITORING_CHARTS, MONITORING_QUERIES_PER_HOUR, createMonitoringCopilotService, guardianMessages } from "../src/monitoring-copilot/service.js";
import type { CopilotReopenDeps } from "../src/copilot-pane-reopen.js";
import { createApp } from "../src/app.js";
import { signSessionWithTtl } from "../src/auth.js";
import { assertMonitoringPerson } from "../src/monitoring-copilot/routes.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";

vi.setConfig({ testTimeout: 30_000 });
const alert = (fingerprint: string, alertname: string, severity: string, extra: Record<string, string> = {}): AlertmanagerAlert => ({
  fingerprint, labels: { alertname, severity, instance: "192.0.2.1:9100", job: "proxmox_host", ...extra },
  annotations: { summary: `${alertname} summary`, description: `${alertname} description` }, startsAt: "2026-10-25T10:00:00.000Z", status: { state: "active" }
});

function fakeCollector() {
  const state = { alerts: [] as AlertmanagerAlert[], down: false, guardian: [] as GuardianLine[], guardianCalls: [] as string[], promCalls: 0, promQueries: [] as MonitoringPromQuery[], urls: [] as string[] };
  const collector: MonitoringCollector = {
    alerts: async (url) => { state.urls.push(url); if (state.down) throw new Error("connect ECONNREFUSED 192.0.2.210:9093"); return state.alerts; },
    guardian: async (_url, afterNs) => { state.guardianCalls.push(afterNs); const out = state.guardian.filter((line) => BigInt(line.ns) > BigInt(afterNs)); return out; },
    promQuery: async (_url, query) => { state.promCalls += 1; state.promQueries.push(query); if (query.query.includes("histogram_quantile") && state.down) throw new Error("The collector answered HTTP 503."); return { resultType: "vector", series: [{ labels: { job: "proxmox_host" }, points: [[1, "1"]] }], truncated: false }; },
    lokiQuery: async () => ({ resultType: "vector", series: [], truncated: false }),
    targets: async () => [{ job: "proxmox_host", instance: "192.0.2.1:9100", health: "up", lastError: "", lastScrape: null, scrapeSeconds: 0.01 },
      { job: "static_blackbox_tcp", instance: "192.0.2.20:3389", health: "down", lastError: "context deadline exceeded", lastScrape: null, scrapeSeconds: 5 }]
  };
  return { collector, state };
}

/** A neutral private network standing in for an installation's own (MON-001: the public export leaves it as written). */
const COLLECTOR = { network: "10.20.30.0/24", defaults: monitoringCollectorDefaults("10.20.30.210") };

function serviceFixture(reopen?: CopilotReopenDeps, askOwnHosts = true, unresolved: () => unknown[] = () => [], collectorConfig: typeof COLLECTOR | { network: null; defaults: null } = COLLECTOR) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Monitoring", initialPaneCount: 0 });
  const ownerUserId = "user:operator";
  (room as { ownerUserId?: string }).ownerUserId = ownerUserId;
  const pane = store.createPane({ roomId: room.id, title: "Monitoring Copilot", mode: "MONITORING_COPILOT", terminalRuntimeId: "cli:claude" });
  let clock = Date.parse("2026-10-25T10:00:00Z");
  const repository = new InMemoryMonitoringCopilotRepository(() => new Date(clock).toISOString());
  const raised: NotificationRaiseInput[] = [];
  const resolved: string[] = [];
  const kickoffs: string[] = [];
  const { collector, state } = fakeCollector();
  const service = createMonitoringCopilotService({
    repository, collector, collectorConfig,
    store: { updateMonitoringCopilotMetadata: (paneId, metadata) => store.updateMonitoringCopilotMetadata(paneId, metadata), listRooms: () => [room], listPanes: (roomId, includeClosed) => store.listPanes(roomId, includeClosed) },
    notifications: { raise: async (input) => { raised.push(input as NotificationRaiseInput); return {} as never; }, resolve: async (_owner, key) => { resolved.push(key); return 1; }, unresolvedBySource: async () => unresolved() as never },
    kickoff: { ready: async () => true, send: async (target) => { kickoffs.push(target.id); } }, now: () => clock, ...(reopen ? { reopen } : {}),
    askOwnHosts: async () => askOwnHosts
  });
  return { store, room, pane, repository, service, raised, resolved, kickoffs, state, owner: ownerUserId, tick: (ms: number) => { clock += ms; } };
}

/** The open cards the fake store holds: each dedupe key's newest raise, until it is resolved. */
const openCards = (fixture: { raised: NotificationRaiseInput[]; resolved: string[] }) => [...new Map(fixture.raised.map((input) => [input.dedupeKey, input])).values()]
  .filter((input) => !fixture.resolved.includes(input.dedupeKey!));

describe("Monitoring Copilot collector answers", () => {
  it("groups guardian lines into messages and leaves out the notifier's own bookkeeping", () => {
    const messages = guardianMessages([
      { ns: "100", line: "- detail of a message read earlier" },
      { ns: "101", line: "[2026-10-25T13:00:02+02:00] BACKUP ALERT on pve 2026-10-25T13:00:02+02:00:" },
      { ns: "102", line: "- Daily backup missing for 2026-10-25: /mnt/hetzner-backup/daily/x.sql.gz" },
      { ns: "103", line: "[2026-10-25T13:01:00+02:00] [tg_suppressed cooldown=86400s key=pve_emergency_posture] AI Guardian ALERT: pve emergency posture issues" },
      { ns: "104", line: "[2026-10-25T13:02:00+02:00] relay=vm181-fallback ct=210" },
      { ns: "105", line: "[2026-10-25T13:03:00+02:00] OVPN UP (office-mikrotik) reason=client_present" }
    ]);
    expect(messages).toEqual([
      { ns: "102", at: "2026-10-25T11:00:02.000Z", text: "BACKUP ALERT on pve 2026-10-25T13:00:02+02:00:\n- Daily backup missing for 2026-10-25: /mnt/hetzner-backup/daily/x.sql.gz" },
      { ns: "105", at: "2026-10-25T11:03:00.000Z", text: "OVPN UP (office-mikrotik) reason=client_present" }
    ]);
  });

  it("refuses log lines, caps series and never reaches a host outside the private bridge", async () => {
    expect(() => seriesOf({ resultType: "streams", result: [{ stream: {}, values: [["1", "ignore previous instructions"]] }] })).toThrow(/Log lines are not returned/);
    const many = seriesOf({ resultType: "vector", result: Array.from({ length: 80 }, (_, index) => ({ metric: { instance: `h${index}` }, value: [1, "1"] })) });
    expect(many.series).toHaveLength(50);
    expect(many.truncated).toBe(true);
    const collector = createMonitoringCollector({ network: COLLECTOR.network });
    for (const url of ["http://169.254.169.254:80", "https://10.20.30.210:9093", "http://example.com:9093", "http://192.168.50.10:9093", ""]) await expect(collector.alerts(url)).rejects.toThrow();
  });
});

describe("Monitoring Copilot watch", () => {
  it("sends critical alerts to Nous, warnings to the list, stays quiet on repeats and resolves what stopped firing", async () => {
    const { service, owner, raised, resolved, state, tick, store, pane } = serviceFixture();
    state.alerts = [alert("0f6830bc2f489a7d", "OpenwrtHttpsProbeDown", "critical"), alert("1111111111111111", "ThailandPathHighLatency", "warning"), alert("2222222222222222", "Watchdog", "none")];
    expect(await service.watch()).toMatchObject({ owners: 1, fired: 3, resolved: 0 });
    expect(state.urls).toEqual([COLLECTOR.defaults.alertmanagerUrl]);
    expect(raised.map((input) => [input.kind, input.severity, input.title])).toEqual([
      ["MONITORING_ALERT", "ATTENTION", "OpenwrtHttpsProbeDown on 192.0.2.1:9100"], ["MONITORING_ALERT", "INFO", "ThailandPathHighLatency on 192.0.2.1:9100"]
    ]);
    expect(raised[0]).toMatchObject({ source: "MONITORING_COPILOT", paneId: pane.id, telegram: null });
    tick(60_000);
    expect(await service.watch()).toMatchObject({ fired: 0, resolved: 0 });
    expect(raised).toHaveLength(2);
    state.alerts = [alert("1111111111111111", "ThailandPathHighLatency", "warning")];
    tick(60_000);
    expect(await service.watch()).toMatchObject({ resolved: 2 });
    expect(resolved).toContain(raised[0]!.dedupeKey);
    // The same fingerprint firing again is a new episode: a new card.
    state.alerts.push(alert("0f6830bc2f489a7d", "OpenwrtHttpsProbeDown", "critical"));
    tick(60_000);
    await service.watch();
    expect(raised).toHaveLength(3);
    expect(raised[2]!.dedupeKey).not.toBe(raised[0]!.dedupeKey);
    const events = await service.events(owner, pane);
    expect(events.filter((event) => event.type === "ALERT").map((event) => event.message)).toEqual([
      "Firing: OpenwrtHttpsProbeDown on 192.0.2.1:9100: OpenwrtHttpsProbeDown summary", "Resolved: OpenwrtHttpsProbeDown on 192.0.2.1:9100",
      "Firing: OpenwrtHttpsProbeDown on 192.0.2.1:9100: OpenwrtHttpsProbeDown summary"].reverse());
    // The pane's switches: warnings off, the critical card stays.
    const metadata = defaultMonitoringCopilotPaneMetadata();
    metadata.settings.notifications.warning = false;
    store.updateMonitoringCopilotMetadata(pane.id, metadata);
    state.alerts.push(alert("3333333333333333", "SwapUsageHigh", "warning"));
    tick(60_000);
    await service.watch();
    expect(raised).toHaveLength(3);
  });

  it("raises one card when the collector stays unreachable five minutes and resolves it when it answers again", async () => {
    const { service, raised, resolved, state, tick, owner } = serviceFixture();
    state.down = true;
    for (let minute = 0; minute < 7; minute += 1) { await service.watch(); tick(60_000); }
    expect(raised.filter((input) => input.kind === "COLLECTOR_UNREACHABLE")).toHaveLength(1);
    expect(service.collectorStatus(owner)).toMatchObject({ reachable: false, lastError: expect.stringContaining("ECONNREFUSED") });
    state.down = false;
    await service.watch();
    expect(resolved).toContain(`monitoring:collector:${owner}`);
    expect(service.collectorStatus(owner)).toMatchObject({ reachable: true, downSince: null });
  });

  it("turns guardian messages into a timeline, one card per kind of alert, and lets a recovery close it", async () => {
    const fixture: ReturnType<typeof serviceFixture> = serviceFixture(undefined, true, () => openCards(fixture));
    const { service, raised, resolved, state, tick, owner, pane } = fixture;
    state.guardian = [
      { ns: "1792926002804053041", line: "[2026-10-25T13:00:02+02:00] OVPN DOWN (office-mikrotik) reason=degraded_session" },
      { ns: "1792926002804053042", line: "[2026-10-25T13:00:03+02:00] AI Guardian REPORT: host post-boot summary host=pve" }
    ];
    await service.watch();
    expect(raised.map((input) => [input.kind, input.severity, input.dedupeKey])).toEqual([["MONITORING_GUARDIAN", "ATTENTION", "monitoring:guardian:ovpn down office-mikrotik reason degraded_session"]]);
    state.guardian.push({ ns: "1792926062804053041", line: "[2026-10-25T13:01:02+02:00] OVPN DOWN (office-mikrotik) reason=degraded_session" });
    tick(60_000);
    await service.watch();
    // The repeat refreshes the same card (same dedupe key); the cursor moved past what was read.
    expect(raised.map((input) => input.dedupeKey)).toEqual(["monitoring:guardian:ovpn down office-mikrotik reason degraded_session", "monitoring:guardian:ovpn down office-mikrotik reason degraded_session"]);
    expect(state.guardianCalls.at(-1)).toBe("1792926002804053042");
    state.guardian.push({ ns: "1792926122804053041", line: "[2026-10-25T13:02:02+02:00] OVPN UP (office-mikrotik) reason=degraded_session" });
    tick(60_000);
    await service.watch();
    expect(resolved).toContain("monitoring:guardian:ovpn down office-mikrotik reason degraded_session");
    expect((await service.events(owner, pane)).filter((event) => event.type === "GUARDIAN")).toHaveLength(4);
  });

  it("closes a card on a recovery worded unlike its alert, and a card whose check stopped repeating a day later (operator 2/11)", async () => {
    const fixture: ReturnType<typeof serviceFixture> = serviceFixture(undefined, true, () => openCards(fixture));
    const { service, resolved, state, tick } = fixture;
    const lag = "monitoring:guardian:ai guardian alert: dcn lag recurrence detected mode office_path_spike cam_a tun-";
    const plesk = "monitoring:guardian:ai guardian alert: public-host plesk license expired expiry n-n-n";
    state.guardian = [
      { ns: "1792926002804053041", line: "[2026-10-25T12:00:00+02:00] AI Guardian ALERT: dc01 lag recurrence detected. mode=office_path_spike cam_a=tun-cam" },
      { ns: "1792926002804053042", line: "[2026-10-25T12:00:01+02:00] AI Guardian ALERT: public-host Plesk license EXPIRED (expiry=2026-10-20)" }
    ];
    await service.watch();
    expect(openCards(fixture).map((card) => card.dedupeKey)).toEqual([lag, plesk]);
    // The relay's recovery for dc01 says "monitor healthy again", not the alert's words.
    state.guardian.push({ ns: "1792926062804053041", line: "[2026-10-25T12:01:00+02:00] [tg_log_only] AI Guardian RECOVERY: dc01 lag monitor healthy again. prev=office_path_spike" });
    tick(60_000);
    await service.watch();
    expect(resolved).toEqual([lag]);
    // Plesk has no recovery line: a repeat 23 hours later keeps its card, a day without one closes it.
    tick(23 * 3_600_000);
    state.guardian.push({ ns: "1793008862804053041", line: "[2026-10-26T11:01:00+02:00] AI Guardian ALERT: public-host Plesk license EXPIRED (expiry=2026-10-20)" });
    await service.watch();
    tick(23 * 3_600_000);
    await service.watch();
    expect(resolved).toEqual([lag]);
    tick(2 * 3_600_000);
    await service.watch();
    expect(resolved).toEqual([lag, plesk]);
  });
});

describe("Monitoring Copilot stale guardian replays (plan clipboard:ctqx7SPqkWR2 step 3)", () => {
  it("records a guardian message older than a day without a card or a recovery, and resolves the open cards such a message raised", async () => {
    const cards: unknown[] = [];
    const { service, raised, resolved, state, owner, pane, repository } = serviceFixture(undefined, true, () => cards);
    // 1/11 02:34 UTC: promtail re-shipped the whole log; its September alert and an old recovery arrive with fresh Loki times.
    state.guardian = [
      { ns: "1792926002804053041", line: "[2026-09-12T10:22:33+03:00] MIKROTIK WAN DOWN: sep/12 10:22:33 script,warning MainWAN_Down 8.8.8.8 is Down" },
      { ns: "1792926002804053042", line: "[2026-10-09T05:03:09+03:00] OVPN UP (office-mikrotik) reason=client_present" },
      { ns: "1792926002804053043", line: "[2026-10-25T12:30:00+02:00] OVPN DOWN (office-mikrotik) reason=degraded_session" }
    ];
    // A card the old code raised for a stale message stays open until the sweep; a fresh one stays.
    const event = (at: string) => repository.createEvent({ ownerUserId: owner, paneId: pane.id, type: "GUARDIAN", status: null, message: "BACKUP ALERT", payload: { at } });
    const card = (key: string, eventId: string) => ({ ownerUserId: owner, kind: "MONITORING_GUARDIAN", dedupeKey: key, link: { target: `event:${eventId}` }, createdAt: "2026-10-25T09:58:00.000Z" });
    cards.push(card("monitoring:guardian:old", (await event("2026-10-09T12:05:04.000Z")).id), card("monitoring:guardian:new", (await event("2026-10-25T09:55:00.000Z")).id));
    await service.watch();
    expect(raised.map((input) => input.dedupeKey)).toEqual(["monitoring:guardian:ovpn down office-mikrotik reason degraded_session"]);
    expect(resolved).toEqual(["monitoring:guardian:old"]);
    expect((await service.events(owner, pane)).filter((event) => event.type === "GUARDIAN").map((event) => event.message)).toEqual(expect.arrayContaining([expect.stringContaining("MIKROTIK WAN DOWN"), expect.stringContaining("OVPN UP")]));
    // A closed card is out of the store's open list; the fresh one stays.
    cards.shift();
    await service.watch();
    expect(resolved).toEqual(["monitoring:guardian:old"]);
  });
});

describe("Monitoring Copilot with no pane open (Nous 2026-10-28)", () => {
  it("keeps watching on the closed pane's settings: alerts still reach Nous and resolve, nothing is typed", async () => {
    const { service, store, pane, raised, resolved, state, tick, kickoffs } = serviceFixture();
    const metadata = defaultMonitoringCopilotPaneMetadata();
    metadata.settings.collector.alertmanagerUrl = "http://10.20.30.211:9093";
    store.updateMonitoringCopilotMetadata(pane.id, metadata);
    store.updatePane(pane.id, { isClosed: true });
    state.alerts = [alert("0f6830bc2f489a7d", "OpenwrtHttpsProbeDown", "critical")];
    expect(await service.watch()).toMatchObject({ owners: 1, fired: 1, kicked: 0, reopened: 0 });
    expect(state.urls).toEqual(["http://10.20.30.211:9093"]);
    expect(raised).toEqual([expect.objectContaining({ kind: "MONITORING_ALERT", severity: "ATTENTION", paneId: pane.id })]);
    state.alerts = [];
    tick(60_000);
    expect(await service.watch()).toMatchObject({ resolved: 1 });
    expect(resolved).toContain(raised[0]!.dedupeKey);
    expect(kickoffs).toEqual([]);
  });

  it("reopens the newest closed pane when a playbook brief waits, at most once per 10 minutes, never a paused one", async () => {
    const reopened: string[] = [];
    const notices: string[] = [];
    const fixture = serviceFixture({ reopen: async (_owner, target) => { reopened.push(target.id); }, notice: (_owner, key) => { notices.push(key); } });
    const { service, store, pane, owner, state, tick, kickoffs } = fixture;
    await service.remember(owner, { kind: "PLAYBOOK", key: "LiteSpeedServiceDown", text: "systemctl restart lshttpd", tags: [], pinned: false }, "AGENT");
    const older = store.createPane({ roomId: fixture.room.id, title: "Old Monitoring", mode: "MONITORING_COPILOT", terminalRuntimeId: "cli:claude" });
    store.updatePane(older.id, { isClosed: true });
    tick(60_000);
    store.updatePane(pane.id, { isClosed: true });
    state.alerts = [alert("1111111111111111", "LiteSpeedServiceDown", "critical")];
    expect(await service.watch()).toMatchObject({ fired: 1, kicked: 0, reopened: 1 });
    expect(reopened).toEqual([pane.id]);
    expect(notices).toEqual([`copilot-reopen:${pane.id}`]);
    expect((await service.events(owner, store.getPane(pane.id))).filter((event) => event.type === "BRIEF")).toEqual([expect.objectContaining({ status: "PENDING" })]);
    tick(5 * 60_000);
    expect(await service.watch()).toMatchObject({ reopened: 0 });
    // Paused before it closed: it stays closed.
    const paused = defaultMonitoringCopilotPaneMetadata();
    paused.settings.paused = true;
    store.updatePane(pane.id, { isClosed: false });
    store.updateMonitoringCopilotMetadata(pane.id, paused);
    store.updatePane(pane.id, { isClosed: true });
    tick(10 * 60_000);
    expect(await service.watch()).toMatchObject({ reopened: 0 });
    expect(reopened).toHaveLength(1);
    // Reopened and unpaused: the next pass types the kickoff at its prompt.
    store.updatePane(pane.id, { isClosed: false });
    store.updateMonitoringCopilotMetadata(pane.id, defaultMonitoringCopilotPaneMetadata());
    expect(await service.watch()).toMatchObject({ kicked: 1, reopened: 0 });
    expect(kickoffs).toEqual([pane.id]);
  });
});

describe("Monitoring Copilot brief kick (queue item 33)", () => {
  it("the minute watch types a PENDING brief although the agent's last next was a minute ago, again every 10 minutes while it waits", async () => {
    const { service, pane, owner, kickoffs, tick } = serviceFixture();
    await service.next(owner, pane);
    tick(60_000);
    await service.addBrief(owner, pane, "Explain the disk alert on vm100", { kind: "NOUS", label: "Nous" } as never);
    kickoffs.length = 0;
    expect((await service.watch()).kicked).toBe(1);
    expect(kickoffs).toEqual([pane.id]);
    tick(60_000);
    expect((await service.watch()).kicked).toBe(0);
    tick(9 * 60_000);
    expect((await service.watch()).kicked).toBe(1);
  });
});

describe("Monitoring Copilot work and queries", () => {
  it("brings briefs and answers to the agent and types the kickoff only when they wait", async () => {
    const { service, owner, pane, kickoffs, raised } = serviceFixture();
    expect(await service.next(owner, pane)).toMatchObject({ done: true });
    const { brief, kickoffSent } = await service.addBrief(owner, pane, "Why is the Thailand path slow since 13:00?", "NOUS");
    expect(kickoffSent).toBe(false);
    expect(kickoffs).toEqual([]);
    const taken = await service.next(owner, pane);
    expect(taken).toMatchObject({ done: false, type: "BRIEF", brief: { id: brief.id, requester: "NOUS" } });
    const question = await service.ask(owner, pane, { question: "Silence the RDP probe alerts tonight?", options: ["yes", "no"] });
    expect(raised.at(-1)).toMatchObject({ kind: "MONITORING_QUESTION", severity: "ATTENTION",
      payload: { ask: { question: "Silence the RDP probe alerts tonight?", options: ["yes", "no"], answer: { kind: "COPILOT_QUESTION", copilot: "MONITORING", questionId: question.id } } } });
    await service.answer(owner, pane, question.id, "yes, until 09:00", "OPERATOR");
    expect(await service.next(owner, pane)).toMatchObject({ type: "ANSWER", answer: "yes, until 09:00" });
    await service.finishBrief(owner, pane, brief.id, { failed: false, summary: "Starlink latency, nothing on our side" });
    expect(await service.items(owner, pane)).toMatchObject({ questions: [], briefs: [] });
  });

  it("serves a waiting brief before one it parked, and the parked one again after 30 minutes untouched (31/10)", async () => {
    const { service, owner, pane, tick } = serviceFixture();
    const parked = (await service.addBrief(owner, pane, "Wait for the ISP's answer", "NOUS")).brief;
    expect(await service.next(owner, pane)).toMatchObject({ type: "BRIEF", brief: { id: parked.id } });
    tick(1_000); // the two briefs differ in time, so the oldest TAKEN one is a fact, not a tie on random ids
    const waiting = (await service.addBrief(owner, pane, "Why is public-host slow?", "NOUS")).brief;
    tick(17 * 60_000);
    expect(await service.next(owner, pane)).toMatchObject({ type: "BRIEF", brief: { id: waiting.id } });
    tick(14 * 60_000);
    expect(await service.next(owner, pane)).toMatchObject({ type: "BRIEF", brief: { id: parked.id } });
  });

  it("turns a Start with nothing queued into one brief that explains the firing alerts, typed although the agent's last next was just now (operator 2026-10-28)", async () => {
    const { service, owner, pane, kickoffs } = serviceFixture();
    expect(await service.next(owner, pane)).toMatchObject({ done: true });
    expect(await service.setRun(owner, pane, "start")).toMatchObject({ status: "RUNNING", pendingBriefs: 1, kickoffSent: true });
    expect(kickoffs).toEqual([pane.id]);
    expect(await service.next(owner, pane)).toMatchObject({ done: false, type: "BRIEF", brief: { text: expect.stringContaining("Explain the alerts firing now") } });
    await service.setRun(owner, pane, "start");
    expect((await service.items(owner, pane)).briefs).toHaveLength(1);
  });

  it("caches identical queries and caps them per owner and hour", async () => {
    const { service, owner, pane, state, tick } = serviceFixture();
    await service.promQuery(owner, pane, { query: "up == 0" });
    await service.promQuery(owner, pane, { query: "up == 0" });
    expect(state.promCalls).toBe(1);
    for (let index = 1; index < MONITORING_QUERIES_PER_HOUR; index += 1) await service.promQuery(owner, pane, { query: `up == ${index}` });
    await expect(service.promQuery(owner, pane, { query: "up == -1" })).rejects.toThrow(/collector queries an hour/);
    tick(3_600_001);
    await expect(service.promQuery(owner, pane, { query: "up == -1" })).resolves.toMatchObject({ resultType: "vector" });
    expect((await service.targets(owner, pane)).filter((target) => target.health !== "up").map((target) => target.instance)).toEqual(["192.0.2.20:3389"]);
  });

  it("draws the Charts tab from the server's own queries over fixed windows, cached a minute and outside the hourly count", async () => {
    const { service, pane, owner, state, tick } = serviceFixture();
    const answer = await service.charts(pane, "24h");
    expect(answer).toMatchObject({ window: "24h", minutes: 1440, stepSeconds: 900 });
    expect(answer.charts.map((chart) => [chart.id, chart.error])).toEqual(MONITORING_CHARTS.map((chart) => [chart.id, null]));
    // Exactly the allowlist, every rate over the window's interval (at least one step), at most 96 points a series.
    expect(state.promQueries).toEqual(MONITORING_CHARTS.map((chart) => ({ query: chart.query("15m"), range: { minutes: 1440, stepSeconds: 900 } })));
    expect(state.promQueries.filter((query) => query.query.includes("rate(")).every((query) => query.query.includes("[15m]"))).toBe(true);
    await service.charts(pane, "24h");
    expect(state.promCalls).toBe(MONITORING_CHARTS.length);
    await service.charts(pane, "1h");
    expect(state.promQueries.slice(MONITORING_CHARTS.length).map((query) => query.range)).toEqual(Array(MONITORING_CHARTS.length).fill({ minutes: 60, stepSeconds: 60 }));
    // The agents' 120 an hour stay theirs.
    for (let index = 0; index < MONITORING_QUERIES_PER_HOUR; index += 1) await service.promQuery(owner, pane, { query: `up == ${index}` });
    tick(60_001);
    state.down = true;
    const failing = await service.charts(pane, "1h");
    expect(failing.charts.find((chart) => chart.id === "latency")).toMatchObject({ error: "The collector answered HTTP 503.", series: [] });
    expect(failing.charts.filter((chart) => chart.error === null)).toHaveLength(MONITORING_CHARTS.length - 1);
  });
});

describe("Monitoring Copilot self-healing gate", () => {
  const begin = (alertIds: string[], extra: Record<string, unknown> = {}) => ({ target: "vm100", alertIds, kind: "SERVICE_RESTART" as const, summary: "Restart LiteSpeed",
    commands: "ssh vm100 systemctl restart lshttpd", backup: "", rollback: "If lshttpd stays down: ask the operator", ...extra });
  async function fullAutonomy(fixture: ReturnType<typeof serviceFixture>) {
    const metadata = defaultMonitoringCopilotPaneMetadata();
    metadata.settings.autonomy = "FULL";
    fixture.store.updateMonitoringCopilotMetadata(fixture.pane.id, metadata);
    return fixture.store.getPane(fixture.pane.id);
  }
  async function firing(fixture: ReturnType<typeof serviceFixture>, name = "LiteSpeedServiceDown") {
    fixture.state.alerts.push(alert(name === "LiteSpeedServiceDown" ? "1111111111111111" : "2222222222222222", name, "critical", { instance: "192.0.2.2:9100" }));
    await fixture.service.watch();
    return (await fixture.service.alerts(fixture.owner, {})).find((item) => item.alertname === name)!.id;
  }

  it("opens a brief for a critical alert one of the copilot's playbooks names", async () => {
    const fixture = serviceFixture();
    const { service, owner, pane, kickoffs } = fixture;
    await service.remember(owner, { kind: "PLAYBOOK", key: "LiteSpeedServiceDown", text: "systemctl restart lshttpd, then HTTP 200 on http://192.0.2.2", tags: [], pinned: false }, "AGENT");
    fixture.state.alerts.push(alert("4444444444444444", "LiteSpeedServiceDown", "warning"));
    await service.watch();
    expect((await service.events(owner, pane)).filter((event) => event.type === "BRIEF")).toHaveLength(0);
    const alertId = await firing(fixture);
    const briefs = (await service.events(owner, pane)).filter((event) => event.type === "BRIEF");
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ status: "PENDING", payload: { requester: "WATCH", alertId } });
    expect(briefs[0]!.message).toContain('playbook "LiteSpeedServiceDown"');
    await vi.waitFor(() => expect(kickoffs.length).toBeGreaterThan(0));
    // The same episode does not brief again; an alert no playbook names never does.
    await service.watch();
    await firing(fixture, "OpenwrtHttpsProbeDown");
    expect((await service.events(owner, pane)).filter((event) => event.type === "BRIEF")).toHaveLength(1);
  });

  it("supersedes a held restart whose alerts stopped firing: the watch closes it, its review and card, never the operator (R13-14)", async () => {
    const fixture = serviceFixture();
    const { service, owner, resolved } = fixture;
    const alertId = await firing(fixture);
    const pane = fixture.store.getPane(fixture.pane.id);
    const told: string[] = [];
    service.onSuperseded((_owner, reviewId) => { told.push(reviewId); });
    const held = await service.beginAction(owner, pane, begin([alertId]));
    if (held.gate !== "ASK") throw new Error("expected ASK");
    fixture.tick(30 * 60_000);
    const review = (await service.items(owner, pane)).reviews[0]!;
    expect(await service.heldState(owner, review)).toEqual({ minutes: 30, met: null });
    // The alert resolves (LiteSpeed came back by itself): the next watch supersedes the held restart.
    fixture.state.alerts.length = 0;
    await service.watch();
    expect((await service.actions(owner, {})).find((action) => action.id === held.actionId)).toMatchObject({ status: "SUPERSEDED", verification: expect.stringContaining("none of its alerts fires any more") });
    expect((await service.items(owner, pane)).reviews).toEqual([]);
    expect(resolved).toContain(`monitoring:review:${held.reviewId}`);
    expect(told).toEqual([held.reviewId]);
    // The agent's own SUPERSEDED needs a held change.
    await expect(service.finishAction(owner, pane, held.actionId, { status: "SUPERSEDED", evidence: "again" })).rejects.toThrow(/not held/);
  });

  it("runs a change on the operator's own hosts for a firing alert or a Nous brief at every autonomy, unless they asked to be asked (R16-7)", async () => {
    // Operator rule f360b58c 29/10 16:07 BKK; the other cases here run with "Ask me before changes on my own hosts" on.
    const fixture = serviceFixture(undefined, false);
    const { service, owner } = fixture;
    const alertId = await firing(fixture);
    const pane = fixture.store.getPane(fixture.pane.id);
    const restart = await service.beginAction(owner, pane, begin([alertId]));
    expect(restart.gate).toBe("GO");
    await service.finishAction(owner, pane, restart.actionId, { status: "VERIFIED", verification: "LiteSpeed answers" });
    expect((await service.beginAction(owner, pane, begin([alertId], { kind: "HOST_REBOOT", target: "qm:100" }))).gate).toBe("ASK");
    expect(await service.beginAction(owner, pane, begin([]))).toMatchObject({ gate: "ASK", reason: expect.stringContaining("Assist") });
    await service.addBrief(owner, pane, "Clear the LiteSpeed cache on vm100", "NOUS");
    await service.next(owner, pane);
    expect((await service.beginAction(owner, pane, begin([], { kind: "CACHE_CLEAR" }))).gate).toBe("GO");
  });

  it("holds every change on Assist until a person approves it, then lets the agent start and verify it", async () => {
    const fixture = serviceFixture();
    const { service, owner, raised, resolved } = fixture;
    const alertId = await firing(fixture);
    const pane = fixture.store.getPane(fixture.pane.id);
    const held = await service.beginAction(owner, pane, begin([alertId]));
    expect(held).toMatchObject({ gate: "ASK", reason: expect.stringContaining("Assist") });
    expect(raised.at(-1)).toMatchObject({ kind: "MONITORING_REVIEW", severity: "ATTENTION", dedupeKey: `monitoring:review:${held.gate === "ASK" ? held.reviewId : ""}` });
    if (held.gate !== "ASK") throw new Error("expected ASK");
    await expect(service.startApproved(owner, pane, held.actionId)).rejects.toThrow(/only an approved action starts/);
    await service.decideReview(owner, pane, held.reviewId, { approve: true, note: "after 23:00" });
    await expect(service.decideReview(owner, pane, held.reviewId, { approve: false })).rejects.toThrow(/already decided/);
    expect(resolved).toContain(`monitoring:review:${held.reviewId}`);
    expect(await service.next(owner, pane)).toMatchObject({ done: false, type: "REVIEW_DECIDED", actionId: held.actionId, approved: true, note: "after 23:00" });
    expect(await service.startApproved(owner, pane, held.actionId)).toMatchObject({ status: "RUNNING" });
    expect(await service.finishAction(owner, pane, held.actionId, { status: "VERIFIED", verification: "lshttpd active, http://192.0.2.2 answers 200" })).toMatchObject({ status: "VERIFIED" });
    expect(raised.at(-1)).toMatchObject({ kind: "MONITORING_FIXED", severity: "INFO" });
    // A declined change never starts.
    fixture.tick(60_000);
    const second = await service.beginAction(owner, pane, begin([alertId]));
    if (second.gate !== "ASK") throw new Error("expected ASK");
    await service.decideReview(owner, pane, second.reviewId, { approve: false });
    await expect(service.startApproved(owner, pane, second.actionId)).rejects.toThrow(/DECLINED/);
    expect((await service.actions(owner, {})).map((action) => action.status)).toEqual(["DECLINED", "VERIFIED"]);
  });

  it("runs only bounded changes on Full: a firing alert, safe kinds, a backup, one at a time, four an hour; failures alert at once", async () => {
    const fixture = serviceFixture();
    const { service, owner, raised, tick } = fixture;
    const alertId = await firing(fixture);
    const pane = await fullAutonomy(fixture);
    expect(await service.beginAction(owner, pane, begin([]))).toMatchObject({ gate: "ASK", reason: expect.stringContaining("No firing alert") });
    expect(await service.beginAction(owner, pane, begin([alertId], { kind: "HOST_REBOOT", target: "qm:100" }))).toMatchObject({ gate: "ASK", reason: expect.stringContaining("always waits") });
    await expect(service.beginAction(owner, pane, begin([alertId], { kind: "CONFIG_CHANGE" }))).rejects.toThrow(/needs a backup/);
    await expect(service.beginAction(owner, pane, begin([alertId], { rollback: "" }))).rejects.toThrow(/roll this change back/);
    const go = await service.beginAction(owner, pane, begin([alertId]));
    expect(go.gate).toBe("GO");
    await expect(service.beginAction(owner, pane, begin([alertId]))).rejects.toThrow(/One change at a time/);
    await service.finishAction(owner, pane, go.actionId, { status: "FAILED", verification: "lshttpd failed to start: port 80 in use" });
    expect(raised.at(-1)).toMatchObject({ kind: "MONITORING_ACTION_FAILED", severity: "URGENT" });
    await expect(service.finishAction(owner, pane, go.actionId, { status: "VERIFIED", verification: "again" })).rejects.toThrow(/not running/);
    for (let index = 0; index < 3; index += 1) {
      const next = await service.beginAction(owner, pane, begin([alertId]));
      expect(next.gate).toBe("GO");
      await service.finishAction(owner, pane, next.actionId, { status: "VERIFIED", verification: "lshttpd active" });
    }
    expect(await service.beginAction(owner, pane, begin([alertId]))).toMatchObject({ gate: "ASK", reason: expect.stringContaining("hourly limit of 4") });
    tick(61 * 60_000);
    // An hour later the limit is free again, but an alert that stopped firing sends the change back to a person.
    fixture.state.alerts = [];
    await service.watch();
    expect(await service.beginAction(owner, pane, begin([alertId]))).toMatchObject({ gate: "ASK", reason: expect.stringContaining("no longer fires") });
  });

  it("lets only a person approve a held change or turn on Fix on its own", () => {
    const operator = { id: "user:operator", email: "operator@space.local", role: "ADMIN" as const };
    const request = (user: Record<string, unknown> | null, sessionPrincipal?: string) => ({ user, sessionPrincipal }) as never;
    expect(() => assertMonitoringPerson(request(operator))).not.toThrow();
    for (const blocked of [request(null), request({ ...operator, proofScope: "READ_ONLY" }), request({ ...operator, automationScope: "APP_DIAGNOSTICS" }),
      request({ ...operator, brokerScope: "UI_PROOF" }), request(operator, "user:operator-proof"), request({ ...operator, id: "user:proof-runner" })]) {
      expect(() => assertMonitoringPerson(blocked)).toThrow(/Only the operator/);
    }
  });

  it("refuses changes on a paused pane", async () => {
    const fixture = serviceFixture();
    const alertId = await firing(fixture);
    const metadata = defaultMonitoringCopilotPaneMetadata();
    metadata.settings.paused = true;
    fixture.store.updateMonitoringCopilotMetadata(fixture.pane.id, metadata);
    await expect(fixture.service.beginAction(fixture.owner, fixture.store.getPane(fixture.pane.id), begin([alertId]))).rejects.toThrow(/paused/);
  });
});

describe("Monitoring Copilot routes", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("serves the operator's state and the agent's bridge, and keeps the collector on the private bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-monitoring-")); roots.push(root);
    const wrapper = join(root, "codex-vscode-parity");
    await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(wrapper, 0o755);
    const config = getApiConfig({
      SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-monitoring-tests", SPACE_ARTIFACT_ROOT: root, SPACE_LOG_LEVEL: "silent",
      SPACE_MONITORING_COLLECTOR_NETWORK: COLLECTOR.network, SPACE_MONITORING_COLLECTOR_HOST: "10.20.30.210"
    });
    const store = new InMemorySpaceStore();
    const eventBus = new SpaceEventBus();
    const updates: string[] = [];
    eventBus.subscribe((event) => { if (event.type === "MONITORING_COPILOT_UPDATED") updates.push(String(event.payload.type)); });
    const { collector, state: collectorState } = fakeCollector();
    collectorState.alerts = [alert("0f6830bc2f489a7d", "OpenwrtHttpsProbeDown", "critical")];
    const app = await createApp({ store, config, eventBus, jobApplyMailTriage: false, marketingCopilotScheduler: false, securityCopilotWatch: false, monitoringCopilotWatch: false,
      monitoringCopilotCollector: collector, monitoringCopilotKickoff: async () => undefined, auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
    const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
    const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Monitoring", initialPaneCount: 0 } })).json();
    const pane = store.createPane({ roomId: room.id, title: "Monitoring Copilot", mode: "MONITORING_COPILOT", terminalRuntimeId: "cli:claude" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
    const bridge = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: session.sessionId })! };
    const url = `/api/panes/${encodeURIComponent(pane.id)}/monitoring-copilot`;

    expect((await app.inject({ method: "GET", url: `${url}/state` })).statusCode).toBe(401);
    const state = await app.inject({ method: "GET", url: `${url}/state`, headers });
    expect(state.statusCode).toBe(200);
    expect(state.json().metadata.settings.collector).toEqual(COLLECTOR.defaults);
    expect(state.json().collectorConfig).toEqual(COLLECTOR);
    // "Check now" runs one watch pass.
    expect((await app.inject({ method: "POST", url: `${url}/watch`, headers, payload: {} })).json()).toMatchObject({ owners: 1, fired: 1 });
    expect(updates).toContain("ALERT");
    const settings = defaultMonitoringCopilotPaneMetadata();
    const badSettings = structuredClone(settings) as { settings: { collector: { lokiUrl: string } } };
    badSettings.settings.collector.lokiUrl = "http://169.254.169.254:80";
    expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: badSettings })).statusCode).toBe(422);
    // A private address outside the configured network is refused; an empty field reads as the configured default.
    badSettings.settings.collector.lokiUrl = "http://192.168.50.10:3100";
    expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: badSettings })).statusCode).toBe(409);
    settings.settings.collector.lokiUrl = "http://10.20.30.202:3100";
    expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: settings })).json().metadata.settings.collector)
      .toEqual({ ...COLLECTOR.defaults, lokiUrl: "http://10.20.30.202:3100" });
    // Charts: a window name only; no PromQL and no other window from the page.
    expect((await app.inject({ method: "GET", url: `${url}/charts`, headers })).json()).toMatchObject({ window: "6h", minutes: 360, stepSeconds: 300 });
    expect((await app.inject({ method: "GET", url: `${url}/charts?window=1h`, headers })).json().charts.map((chart: { id: string }) => chart.id)).toEqual(MONITORING_CHARTS.map((chart) => chart.id));
    expect((await app.inject({ method: "GET", url: `${url}/charts?window=7d`, headers })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: `${url}/charts?window=1h&query=up`, headers })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: `${url}/charts` })).statusCode).toBe(401);

    expect((await app.inject({ method: "POST", url: "/api/cli/monitoring-copilot/next", payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "POST", url: "/api/cli/monitoring-copilot/next", headers: bridge, payload: {} })).json()).toMatchObject({ done: true });
    expect((await app.inject({ method: "GET", url: "/api/cli/monitoring-copilot/alerts", headers: bridge })).json().alerts.map((item: { alertname: string }) => item.alertname)).toEqual(["OpenwrtHttpsProbeDown"]);
    expect((await app.inject({ method: "GET", url: "/api/cli/monitoring-copilot/targets?down=true", headers: bridge })).json().targets).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/cli/monitoring-copilot/logs", headers: bridge, payload: { query: '{job="vm100_web"}' } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/api/cli/monitoring-copilot/query", headers: bridge, payload: { query: "up == 0" } })).json()).toMatchObject({ resultType: "vector" });
    const memory = await app.inject({ method: "POST", url: "/api/cli/monitoring-copilot/memory", headers: bridge, payload: { kind: "PLAYBOOK", key: "vm100 down", text: "qm start 100, then check http://192.0.2.2 twice", target: "vm100" } });
    expect(memory.json().memory.source).toBe("AGENT");
    expect((await app.inject({ method: "GET", url: `${url}/memory`, headers })).json().memories).toHaveLength(1);
    // The gate over the bridge: a held change (OTHER always asks); a proof session cannot approve it or turn on Fix on its own; the operator can.
    const alertId = (await app.inject({ method: "GET", url: "/api/cli/monitoring-copilot/alerts", headers: bridge })).json().alerts[0].id as string;
    const held = (await app.inject({ method: "POST", url: "/api/cli/monitoring-copilot/actions/begin", headers: bridge,
      payload: { target: "openwrt-th", alertIds: [alertId], kind: "OTHER", summary: "Restart uhttpd", commands: "ssh openwrt-th /etc/init.d/uhttpd restart", rollback: "ask the operator" } })).json();
    expect(held).toMatchObject({ gate: "ASK", reviewId: expect.stringMatching(/^monevt:/) });
    const proof = { cookie: `space_session=${signSessionWithTtl({ id: "user:operator-proof", email: "proof@space.local", role: "ADMIN" }, "test-secret-with-enough-length", 600)}` };
    const proofCsrf = { ...proof, "x-space-csrf-token": (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: proof })).json().csrfToken as string };
    const proofApprove = await app.inject({ method: "POST", url: `${url}/reviews/${encodeURIComponent(held.reviewId)}/decide`, headers: proofCsrf, payload: { approve: true } });
    expect(proofApprove.statusCode).toBe(403);
    const full = defaultMonitoringCopilotPaneMetadata();
    full.settings.autonomy = "FULL";
    expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers: proofCsrf, payload: full })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${url}/reviews/${encodeURIComponent(held.reviewId)}/decide`, headers, payload: { approve: true } })).json().review.status).toBe("APPROVED");
    expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: full })).json().metadata.settings.autonomy).toBe("FULL");
    expect((await app.inject({ method: "POST", url: `/api/cli/monitoring-copilot/actions/${encodeURIComponent(held.actionId)}/start`, headers: bridge, payload: {} })).json().action.status).toBe("RUNNING");
    // A Security Copilot pane's bridge token does not open these tools.
    const other = store.createPane({ roomId: room.id, title: "Security", mode: "SECURITY_COPILOT", terminalRuntimeId: "cli:claude" });
    const otherSession = store.createPaneCliSession({ paneId: other.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
    const otherBridge = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: other.id, cliSessionId: otherSession.sessionId })! };
    expect((await app.inject({ method: "POST", url: "/api/cli/monitoring-copilot/next", headers: otherBridge, payload: {} })).statusCode).toBe(409);
    await app.close();
  });
});

describe("Monitoring Copilot on an installation with no collector configured (MON-001)", () => {
  it("reads nothing and raises no card until Setup names a collector, then watches it on the installation's own private network", async () => {
    const { service, owner, pane, raised, state, tick } = serviceFixture(undefined, true, () => [], { network: null, defaults: null });
    state.alerts = [alert("0f6830bc2f489a7d", "OpenwrtHttpsProbeDown", "critical")];
    expect(await service.watch()).toMatchObject({ fired: 0 });
    tick(10 * 60_000);
    expect(await service.watch()).toMatchObject({ fired: 0 });
    expect(state.urls).toEqual([]);
    expect(raised).toEqual([]);
    expect(service.metadata(pane).settings.collector).toEqual({ prometheusUrl: "", alertmanagerUrl: "", lokiUrl: "" });
    const metadata = defaultMonitoringCopilotPaneMetadata();
    metadata.settings.collector = monitoringCollectorDefaults("192.168.50.10");
    expect((await service.updateSettings(owner, pane, metadata)).settings.collector.alertmanagerUrl).toBe("http://192.168.50.10:9093");
    expect(await service.watch()).toMatchObject({ fired: 1 });
    expect(state.urls).toEqual(["http://192.168.50.10:9093"]);
  });
});
