// Operator 5/11 14:47 BKK: unused pane browsers close by themselves, an agent browser never refuses the operator's, and the browser limit
// follows the memory the browsers may use (browser-reaper.ts, browserSessionCap; plan clipboard:DpmApwi78Fdh step 2).
import { defaultFreelanceCopilotPaneMetadata } from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_REAPED_ACTION, BROWSER_RELEASED_ACTION, browserInUse, driverWorkEnded, operatorFirstBrowsers, startBrowserReaper, unusedBrowsers, type BrowserRow,
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
