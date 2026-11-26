// Operator 5/11 14:47 BKK: unused pane browsers close by themselves, an agent browser never refuses the operator's, and the browser limit
// follows the memory the browsers may use (browser-reaper.ts, browserSessionCap; plan clipboard:DpmApwi78Fdh step 2).
import { defaultFreelanceCopilotPaneMetadata } from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_PANE_CLOSED_ACTION, BROWSER_REAPED_ACTION, BROWSER_RELEASED_ACTION, BROWSER_TABS_CLOSED_ACTION, browserInUse, driverWorkEnded, idleRoomBrowser, operatorFirstBrowsers, startBrowserReaper, unusedBrowsers, type BrowserRow,
  type ReleaseDeps } from "../src/browser-reaper.js";
import { browserMemoryBytes, browserSessionCap } from "../src/browser-sessions.js";

const NOW = Date.parse("2026-11-05T08:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const row = (paneId: string, extra: Partial<BrowserRow> = {}): BrowserRow => ({ paneId, roomId: "room:a", title: "Browser", paneName: paneId.slice(5), mode: "BROWSER",
  paneClosed: false, profile: "pane", control: null, handoff: null, fencedTabs: 0, agent: null, updatedAt: ago(60), lastFrameAt: null, tabs: [], ...extra });

describe("unusedBrowsers", () => {
  it("closes a closed pane's browser and one unused past 30 minutes; keeps what someone uses, holds, signs in on or a scheduled task needs", () => {
    const viewed = new Set(["pane:viewed"]);
    const rows = [
      row("pane:closed", { paneClosed: true, updatedAt: ago(1) }),
      row("pane:idle"),
      row("pane:recent", { updatedAt: ago(10) }),
      row("pane:viewed"),
      row("pane:agent", { agent: { paneId: "pane:cli", title: "CLI", paneName: "Cli", roomId: "room:a", roomName: "A", drivenAt: ago(5), active: true } }),
      row("pane:handoff", { handoff: { status: "ACCEPTED", requestedAt: ago(60) } }),
      row("pane:fenced", { fencedTabs: 1 }),
      row("pane:lease", { control: { holderType: "OPERATOR", heartbeatAt: ago(60), operatorIdleSeconds: 3600 } }),
      row("pane:signin", { tabs: [{ pageId: "p", title: "Sign in", url: "https://accounts.google.com/v3/signin", isActive: true }] }),
      row("pane:task")
    ];
    const unused = unusedBrowsers(rows, { now: NOW, usedAt: (paneId) => viewed.has(paneId) ? NOW : null, scheduled: new Set(["pane:task"]) });
    expect(unused.map((browser) => [browser.paneId, browser.why])).toEqual([["pane:closed", "its pane is closed"], ["pane:idle", "no agent or operator use for 60 min"]]);
    // Nous Score Idle open panes (operator 13/11 09:48 BKK): only an agent or a lease is use; a kept browser's pane still counts idle.
    expect(rows.filter(browserInUse).map((browser) => browser.paneId)).toEqual(["pane:agent", "pane:lease"]);
  });

  it("the reaper stops each unused browser (no actor) and audits it with its owner", async () => {
    const stopPane = vi.fn(async () => undefined);
    const recordAuditEvent = vi.fn(async (input: unknown) => input);
    const reaper = startBrowserReaper({ store: { dueTaskSchedules: async () => [], getRoom: async () => ({ ownerUserId: "user:operator" }), recordAuditEvent } as never,
      census: async () => ({ sessions: [row("pane:idle"), row("pane:busy", { updatedAt: ago(2) })] }), usedAt: () => null, stopPane, warn: vi.fn(), now: () => NOW });
    await reaper.sweep();
    reaper.stop();
    expect(stopPane).toHaveBeenCalledTimes(1);
    expect(stopPane).toHaveBeenCalledWith("pane:idle", expect.stringMatching(/^trace:/));
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: BROWSER_REAPED_ACTION, targetId: "pane:idle",
      metadata: expect.objectContaining({ ownerUserId: "user:operator", why: "no agent or operator use for 60 min" }) }));
  });
});

describe("release when the driver is done (score lever Idle open browsers, 14/11)", () => {
  const report = (minutes: number, status: string) => ({ at: ago(minutes), status });
  it("a turn end, done or failed after the last drive ends the work; an ask, a newer start or an older report does not", () => {
    const drivenAt = Date.parse(ago(12));
    expect(driverWorkEnded([report(5, "TURN_END"), report(6, "PROGRESS")], drivenAt)).toBe(true);
    expect(driverWorkEnded([report(5, "HEARTBEAT"), report(6, "DONE")], drivenAt)).toBe(true);
    expect(driverWorkEnded([report(5, "TURN_END"), report(6, "NEEDS_YOU")], drivenAt)).toBe(false);
    expect(driverWorkEnded([report(5, "TURN_END"), report(20, "QUESTION")], drivenAt)).toBe(false);
    expect(driverWorkEnded([report(5, "PROGRESS"), report(6, "TURN_END")], drivenAt)).toBe(false);
    expect(driverWorkEnded([report(20, "TURN_END")], drivenAt)).toBe(false);
    expect(driverWorkEnded([], drivenAt)).toBe(false);
  });

  it("the reaper releases a terminal agent's browser once its turn ended or its pane closed; keeps every browser something or someone still needs", async () => {
    const terminal = (id: string, extra: object = {}) => ({ id, roomId: "room:a", mode: "TERMINAL", title: "Claude", paneName: id.slice(5), isClosed: false, ...extra });
    const panes: Record<string, object> = { "pane:dana": terminal("pane:dana"), "pane:gone": terminal("pane:gone", { isClosed: true }),
      "pane:asker": terminal("pane:asker"), "pane:busy": terminal("pane:busy"), "pane:job": terminal("pane:job", { mode: "JOB_APPLY" }) };
    const ended = [report(5, "TURN_END"), report(6, "PROGRESS")];
    const reports: Record<string, Array<{ at: string; status: string }>> = { "pane:dana": ended, "pane:job": ended,
      "pane:asker": [report(5, "TURN_END"), report(6, "NEEDS_YOU")], "pane:busy": [report(5, "PROGRESS")] };
    const driver: Record<string, string> = { "pane:b-done": "pane:dana", "pane:b-closed": "pane:gone", "pane:b-handoff": "pane:dana", "pane:b-fenced": "pane:dana",
      "pane:b-lease": "pane:dana", "pane:b-attached": "pane:dana", "pane:b-viewed": "pane:dana", "pane:b-typed": "pane:dana", "pane:b-asks": "pane:asker",
      "pane:b-working": "pane:busy", "pane:b-copilot": "pane:job", "pane:b-idle": "pane:dana" };
    const release: ReleaseDeps = {
      agentFor: (paneId) => driver[paneId] ? { paneId: driver[paneId], at: Date.parse(ago(12)), active: paneId === "pane:b-attached" } : null,
      reports: async (pane) => reports[pane.id] ?? [],
      typedForm: async (paneId) => paneId === "pane:b-typed"
    };
    const recent = { updatedAt: ago(12) };
    const sessions = [row("pane:b-done", recent), row("pane:b-closed", recent), row("pane:b-handoff", { ...recent, handoff: { status: "ACCEPTED", requestedAt: ago(12) } }),
      row("pane:b-fenced", { ...recent, fencedTabs: 1 }), row("pane:b-lease", { ...recent, control: { holderType: "AGENT", heartbeatAt: ago(1), operatorIdleSeconds: null } }),
      row("pane:b-attached", recent), row("pane:b-viewed", recent), row("pane:b-typed", recent), row("pane:b-asks", recent), row("pane:b-working", recent),
      row("pane:b-copilot", recent), row("pane:own-copilot", { ...recent, mode: "JOB_APPLY" }), row("pane:b-idle")];
    const stopPane = vi.fn(async () => undefined);
    const recordAuditEvent = vi.fn(async (input: unknown) => input);
    const reaper = startBrowserReaper({ store: { dueTaskSchedules: async () => [], getRoom: async () => ({ ownerUserId: "user:operator" }),
      getPane: async (paneId: string) => panes[paneId], recordAuditEvent } as never, census: async () => ({ sessions }),
      usedAt: (paneId) => paneId === "pane:b-viewed" ? Date.parse(ago(3)) : null, release, stopPane, warn: vi.fn(), now: () => NOW });
    await reaper.sweep();
    reaper.stop();
    // The measure stays: a browser unused past 30 minutes is reaped (and costs score) even when its driver is done.
    expect(recordAuditEvent.mock.calls.map(([event]) => [(event as { targetId: string }).targetId, (event as { action: string }).action,
      (event as { metadata: { why: string } }).metadata.why])).toEqual([
      ["pane:b-idle", BROWSER_REAPED_ACTION, "no agent or operator use for 60 min"],
      ["pane:b-done", BROWSER_RELEASED_ACTION, "its driver dana ended its turn"],
      ["pane:b-closed", BROWSER_RELEASED_ACTION, "its driver gone closed"]
    ]);
    expect(stopPane.mock.calls.map(([paneId]) => paneId)).toEqual(["pane:b-idle", "pane:b-done", "pane:b-closed"]);
  });
});

describe("a terminal pane's done or failed report releases its own CLI browser at once (plan clipboard:nLYbDf3TqBPm step 3)", () => {
  it("releases the browsers the reporter drove last even while its drive is recent or attached; keeps another driver's and what a handoff, the operator or a typed form holds", async () => {
    const panes: Record<string, object> = { "pane:kate": { id: "pane:kate", roomId: "room:a", mode: "TERMINAL", title: "Claude", paneName: "kate", isClosed: false },
      "pane:hugo": { id: "pane:hugo", roomId: "room:a", mode: "TERMINAL", title: "Claude", paneName: "hugo", isClosed: false } };
    const driver: Record<string, string> = { "pane:k-own": "pane:kate", "pane:k-handoff": "pane:kate", "pane:k-viewed": "pane:kate", "pane:k-typed": "pane:kate", "pane:h-other": "pane:hugo" };
    const drivenAt = Date.parse(ago(1));
    const release: ReleaseDeps = {
      agentFor: (paneId) => driver[paneId] ? { paneId: driver[paneId], at: drivenAt, active: true } : null,
      reports: async () => [{ at: ago(0), status: "DONE" }],
      typedForm: async (paneId) => paneId === "pane:k-typed"
    };
    const active = (paneId: string) => ({ updatedAt: ago(1), agent: { paneId: driver[paneId], title: "Claude", paneName: null, roomId: "room:a", roomName: "A", drivenAt: ago(1), active: true } });
    const sessions = [row("pane:k-own", active("pane:k-own")), row("pane:k-handoff", { ...active("pane:k-handoff"), handoff: { status: "PENDING", requestedAt: ago(1) } }),
      row("pane:k-viewed", active("pane:k-viewed")), row("pane:k-typed", active("pane:k-typed")), row("pane:h-other", active("pane:h-other"))] as BrowserRow[];
    const stopPane = vi.fn(async () => undefined);
    const closePane = vi.fn(async () => undefined);
    const recordAuditEvent = vi.fn(async (input: unknown) => input);
    const reaper = startBrowserReaper({ store: { dueTaskSchedules: async () => [], getRoom: async () => ({ ownerUserId: "user:operator" }), listRooms: async () => [],
      getPane: async (paneId: string) => panes[paneId], recordAuditEvent } as never, census: async () => ({ sessions }),
      usedAt: (paneId) => paneId === "pane:k-viewed" ? Date.parse(ago(0)) : null, release, stopPane, closePane, warn: vi.fn(), now: () => NOW });
    await reaper.releaseFor("pane:kate");
    // The sweep alone keeps them all: every drive is recent.
    await reaper.sweep();
    reaper.stop();
    expect(stopPane.mock.calls.map(([paneId]) => paneId)).toEqual(["pane:k-own"]);
    expect(closePane.mock.calls.map(([paneId]) => paneId)).toEqual(["pane:k-own"]);
    expect(recordAuditEvent.mock.calls.map(([event]) => [(event as { targetId: string }).targetId, (event as { action: string }).action])).toEqual([["pane:k-own", BROWSER_RELEASED_ACTION]]);
  });
});

describe("stopped or empty browser panes close (operator 14/11 09:42 BKK, nous_msg:efbc6ddef88f4e2daebfa884)", () => {
  it("closes a BROWSER pane whose browser is stopped or has no tab, with no pane check verdict read; keeps a fresh one and one a handoff, lease, tab or other mode holds", async () => {
    const pane = (id: string, extra: object = {}) => ({ id, roomId: "room:a", mode: "BROWSER", title: "Browser", paneName: id.slice(5), isClosed: false, updatedAt: ago(60), ...extra });
    const panes = [pane("pane:stopped"), pane("pane:empty"), pane("pane:idle"), pane("pane:fresh", { updatedAt: ago(1) }), pane("pane:handoff"), pane("pane:lease"),
      pane("pane:tabs"), pane("pane:job", { mode: "JOB_APPLY" })];
    const tab = { pageId: "p", title: "Shop", url: "https://example.com/", isActive: true };
    const sessions = [row("pane:empty", { updatedAt: ago(10) }), row("pane:idle", { tabs: [tab] }), row("pane:tabs", { tabs: [tab], updatedAt: ago(5) })];
    const stopPane = vi.fn(async () => undefined);
    const closePane = vi.fn(async () => undefined);
    const recordAuditEvent = vi.fn(async (input: unknown) => input);
    const reaper = startBrowserReaper({ store: { dueTaskSchedules: async () => [], getRoom: async () => ({ ownerUserId: "user:operator" }), recordAuditEvent,
      listRooms: async () => [{ id: "room:a" }], listPanes: async () => panes,
      getLatestPaneBrowserSession: async (paneId: string) => ({ sessionId: `session:${paneId}`, paneId, isActive: false, status: "CLOSED", updatedAt: ago(10) }),
      getActiveBrowserHandoffRequest: async (sessionId: string) => sessionId.endsWith("handoff") ? { status: "REQUESTED" } : null,
      getActiveBrowserControlLease: async (sessionId: string) => sessionId.endsWith("lease") ? { leaseId: "lease" } : null } as never,
      census: async () => ({ sessions }), usedAt: () => null, stopPane, closePane, warn: vi.fn(), now: () => NOW });
    await reaper.sweep();
    reaper.stop();
    expect(recordAuditEvent.mock.calls.map(([event]) => [(event as { targetId: string }).targetId, (event as { action: string }).action,
      (event as { metadata: { why: string; paneClosed: boolean } }).metadata.why, (event as { metadata: { paneClosed: boolean } }).metadata.paneClosed])).toEqual([
      ["pane:idle", BROWSER_REAPED_ACTION, "no agent or operator use for 60 min", true],
      ["pane:stopped", BROWSER_PANE_CLOSED_ACTION, "its browser is stopped", true],
      ["pane:empty", BROWSER_PANE_CLOSED_ACTION, "its browser has no open tab", true]
    ]);
    expect(closePane.mock.calls.map(([paneId]) => paneId)).toEqual(["pane:idle", "pane:stopped", "pane:empty"]);
    expect(stopPane.mock.calls.map(([paneId]) => paneId)).toEqual(["pane:idle", "pane:empty"]);
  });
});

describe("operatorFirstBrowsers", () => {
  const operator = { holderType: "OPERATOR" as const, holderId: "user:operator" };
  const pane = (id: string, mode = "BROWSER", extra: Record<string, unknown> = {}) => ({ id, roomId: "room:a", mode, ...extra });
  const panes: Record<string, ReturnType<typeof pane>> = {
    "pane:mine": pane("pane:mine"),
    "pane:freelance": pane("pane:freelance", "FREELANCE_COPILOT", { freelanceCopilotMetadata: (() => { const metadata = defaultFreelanceCopilotPaneMetadata();
      return { ...metadata, settings: { ...metadata.settings, browserEgress: "greece" } }; })() }),
    "pane:other": pane("pane:other"),
    "pane:job": pane("pane:job", "JOB_APPLY")
  };
  const setup = (refusal: Error, sessions: BrowserRow[]) => {
    let refused = false;
    const manager = {
      startOrRestore: vi.fn(async () => { if (!refused) { refused = true; throw refusal; } return { ok: true }; }),
      stopPane: vi.fn(async () => undefined),
      status: () => ({ enabled: true })
    };
    const noteUse = vi.fn();
    const store = { getPane: async (id: string) => panes[id], getPaneBrowserRoute: async (id: string) => id === "pane:mine" ? "direct" : null,
      getLatestPaneBrowserSession: async () => ({ profilePath: "/profiles/cli-accounts/a3140720e49d/x" }), recordAuditEvent: vi.fn(async () => ({})) };
    const wrapped = operatorFirstBrowsers(manager, { store: store as never, census: async () => ({ sessions }), usedAt: () => null, noteUse, warn: vi.fn() });
    return { manager, wrapped, noteUse, store };
  };
  const route = new SpaceConflictError("BROWSER_ROUTE: another pane uses this browser account on another network route; give both the same route, close the other pane, or use another browser account.");

  it("the 07:03-07:49 UTC refusal: the Freelance Copilot on the same account and another route yields, and the operator's start runs again", async () => {
    const { manager, wrapped, noteUse, store } = setup(route, [
      row("pane:freelance", { mode: "FREELANCE_COPILOT", profile: "cli-accounts/a3140720e49d" }),
      row("pane:other", { profile: "cli-accounts/a3140720e49d" }),
      row("pane:job", { mode: "JOB_APPLY", profile: "google-accounts/35cc85db" })
    ]);
    await expect(wrapped.startOrRestore({ pane: panes["pane:mine"] } as never, operator)).resolves.toEqual({ ok: true });
    // Only the agent browser with another route on that account: the operator's other pane and another account's Chrome stay.
    expect(manager.stopPane.mock.calls).toEqual([["pane:freelance", expect.stringMatching(/^trace:/)]]);
    expect(manager.startOrRestore).toHaveBeenCalledTimes(2);
    expect(noteUse).toHaveBeenCalledWith("pane:mine");
    expect(store.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "browser.yielded_to_operator", targetId: "pane:freelance" }));
    // Sync methods stay sync.
    expect(wrapped.status()).toEqual({ enabled: true });
  });

  it("at the browser limit the least recently used agent browser closes for the operator; an agent's call is refused as before", async () => {
    const capacity = Object.assign(new Error("Browser limit reached: 18 browsers can be open at once. Close another browser pane first."), { code: "BROWSER_SESSION_CAPACITY" });
    const sessions = [row("pane:job", { mode: "JOB_APPLY", updatedAt: ago(5) }), row("pane:freelance", { mode: "FREELANCE_COPILOT", updatedAt: ago(90) }), row("pane:other", { updatedAt: ago(500) })];
    const first = setup(capacity, sessions);
    await first.wrapped.startOrRestore({ pane: panes["pane:mine"] } as never, operator);
    expect(first.manager.stopPane.mock.calls.map((call) => call[0])).toEqual(["pane:freelance"]);
    const agent = setup(capacity, sessions);
    await expect(agent.wrapped.startOrRestore({ pane: panes["pane:mine"] } as never, { holderType: "AGENT", holderId: "cli:x" })).rejects.toBe(capacity);
    expect(agent.manager.stopPane).not.toHaveBeenCalled();
    // The host's own error (SpaceFeatureDisabledError, errorCode) when no Xvfb display is free counts as the limit too (13/11).
    const noDisplay = setup(new SpaceFeatureDisabledError("BROWSER_SESSION_CAPACITY", "No Xvfb display is available for a headed browser session."), sessions);
    await noDisplay.wrapped.startOrRestore({ pane: panes["pane:mine"] } as never, operator);
    expect(noDisplay.manager.stopPane.mock.calls.map((call) => call[0])).toEqual(["pane:freelance"]);
  });

  it("sizes the browser limit from the cgroup limit or the RAM at 512 MiB a browser, with no floor of 10", () => {
    const GiB = 1024 ** 3;
    expect(browserSessionCap(25_165_717_504)).toBe(23); // public-host 13/11 (23.4 GiB), was 10
    expect(browserSessionCap(47 * GiB)).toBe(47);
    expect(browserSessionCap(4 * GiB)).toBe(4);
    expect(browserSessionCap(2 * GiB)).toBe(2);
    expect(browserSessionCap(0.5 * GiB)).toBe(1);
    expect(browserMemoryBytes(3 * GiB, 47 * GiB)).toBe(3 * GiB); // a container or systemd MemoryMax
    expect(browserMemoryBytes(0, 23 * GiB)).toBe(23 * GiB); // no limit
    expect(browserMemoryBytes(2 ** 64, 23 * GiB)).toBe(23 * GiB); // a limit above the RAM
  });
});

describe("an agent's browser comes from its room before a new pane (operator 14/11 09:42 BKK, room Felix)", () => {
  it("hands over a pane-profile browser of the same room whose terminal driver ended its turn; never another room's, a signed-in profile or a busy driver's", async () => {
    const terminal = { id: "pane:dana", roomId: "room:a", mode: "TERMINAL", title: "Claude", paneName: "Dana", isClosed: false };
    const driver: Record<string, boolean> = { "pane:busy": true, "pane:other-room": false, "pane:google": false, "pane:done": false };
    const release: ReleaseDeps = { agentFor: (paneId) => paneId in driver ? { paneId: "pane:dana", at: Date.parse(ago(12)), active: driver[paneId]! } : null,
      reports: async () => [{ at: ago(5), status: "TURN_END" }], typedForm: async () => false };
    const rows = [row("pane:busy"), row("pane:other-room", { roomId: "room:b" }), row("pane:google", { profile: "google-accounts/abc" }), row("pane:done")];
    const input = { store: { getPane: async () => terminal } as never, usedAt: () => null, scheduled: new Set<string>(), release };
    expect(await idleRoomBrowser(rows, "room:a", input)).toBe("pane:done");
    expect(await idleRoomBrowser(rows.slice(0, 3), "room:a", input)).toBeNull();
  });
});

describe("finished runs' tabs close (operator 14/11 10:18 BKK, nous_msg:2e8a3dac6ce0495e9b414a77: Dino/Emma kept 9 tabs)", () => {
  it("closes every tab but the active one, its popups and fenced tabs once the agent is done or a handoff waits; keeps a running agent's, a lease's and the operator's own", async () => {
    const page = (pageId: string, extra: object = {}) => ({ pageId, kind: "PAGE", url: `https://example.com/${pageId}`, title: pageId, isActive: false, openerPageId: null, ...extra });
    const tabs = (paneId: string) => [page(`${paneId}/active`, { isActive: true }), page(`${paneId}/popup`, { kind: "POPUP", openerPageId: `${paneId}/active` }),
      page(`${paneId}/old`), page(`${paneId}/fenced`)];
    const censusTabs = (paneId: string) => tabs(paneId).map((tab) => tab.pageId.endsWith("fenced") ? { fenced: true as const, isActive: false }
      : { pageId: tab.pageId, title: tab.title, url: tab.url, isActive: tab.isActive });
    const panes: Record<string, object> = { "pane:emma": { id: "pane:emma", roomId: "room:a", mode: "FREELANCE_COPILOT", title: "Freelance Copilot", paneName: "Emma", isClosed: false },
      "pane:cli": { id: "pane:cli", roomId: "room:a", mode: "TERMINAL", title: "Claude", paneName: "Cody", isClosed: false },
      "pane:busy": { id: "pane:busy", roomId: "room:a", mode: "TERMINAL", title: "Claude", paneName: "Busy", isClosed: false } };
    const browsers = ["pane:emma", "pane:handoff", "pane:running", "pane:lease", "pane:mine", "pane:nodriver"];
    for (const id of browsers.slice(1)) panes[id] = { id, roomId: "room:a", mode: "BROWSER", title: "Browser", paneName: id.slice(5), isClosed: false };
    const driver: Record<string, string> = { "pane:emma": "pane:emma", "pane:handoff": "pane:busy", "pane:running": "pane:busy", "pane:lease": "pane:cli", "pane:mine": "pane:cli" };
    const reports: Record<string, Array<{ at: string; status: string }>> = { "pane:emma": [{ at: ago(1), status: "TURN_END" }], "pane:cli": [{ at: ago(1), status: "DONE" }],
      "pane:busy": [{ at: ago(1), status: "PROGRESS" }] };
    browsers.push("pane:stopped");
    panes["pane:stopped"] = { id: "pane:stopped", roomId: "room:a", mode: "BROWSER", title: "Browser", paneName: "stopped", isClosed: false };
    driver["pane:stopped"] = "pane:cli";
    const sessions = browsers.map((id) => row(id, { runtimeState: id === "pane:stopped" ? "STOPPED" : "READY", mode: (panes[id] as { mode: BrowserRow["mode"] }).mode, tabs: censusTabs(id), fencedTabs: 1,
      ...(id === "pane:handoff" ? { handoff: { status: "PENDING", requestedAt: ago(2) } } : {}),
      ...(id === "pane:lease" ? { control: { holderType: "OPERATOR", heartbeatAt: ago(0), operatorIdleSeconds: 5 } } : {}) }));
    const closeTab = vi.fn(async () => undefined);
    const recordAuditEvent = vi.fn(async (input: unknown) => input);
    const reaper = startBrowserReaper({ store: { dueTaskSchedules: async () => [], getRoom: async () => ({ ownerUserId: "user:operator" }), recordAuditEvent,
      getPane: async (paneId: string) => panes[paneId], getActivePaneBrowserSession: async (paneId: string) => ({ paneId, pages: tabs(paneId) }) } as never,
      census: async () => ({ sessions }), usedAt: (paneId) => paneId === "pane:mine" ? Date.parse(ago(1)) : null, stopPane: vi.fn(), warn: vi.fn(), closeTab, now: () => NOW,
      release: { agentFor: (paneId) => driver[paneId] ? { paneId: driver[paneId], at: Date.parse(ago(5)), active: true } : null,
        reports: async (pane) => reports[pane.id] ?? [], typedForm: async () => false } });
    await reaper.trim();
    reaper.stop();
    expect(closeTab.mock.calls.map(([pane, pageId]) => [(pane as { id: string }).id, pageId])).toEqual([["pane:emma", "pane:emma/old"], ["pane:handoff", "pane:handoff/old"]]);
    expect(recordAuditEvent.mock.calls.map(([event]) => [(event as { action: string }).action, (event as { targetId: string }).targetId,
      (event as { metadata: { why: string; closed: number } }).metadata.why])).toEqual([
      [BROWSER_TABS_CLOSED_ACTION, "pane:emma", "its driver Emma ended its turn"], [BROWSER_TABS_CLOSED_ACTION, "pane:handoff", "a handoff waits on its active tab"]]);
  });
});
