// Operator 5/11 14:47 BKK: unused pane browsers close by themselves, an agent browser never refuses the operator's, and the browser limit
// follows the server's RAM (browser-reaper.ts, browserSessionCap).
import { defaultFreelanceCopilotPaneMetadata } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_REAPED_ACTION, operatorFirstBrowsers, startBrowserReaper, unusedBrowsers, type BrowserRow } from "../src/browser-reaper.js";
import { browserSessionCap } from "../src/browser-sessions.js";

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
  });

  it("sizes the browser limit from the server's RAM: 18 on public-host's 47 GiB, never below the old 10", () => {
    expect(browserSessionCap(47 * 1024 ** 3)).toBe(18);
    expect(browserSessionCap(8 * 1024 ** 3)).toBe(10);
  });
});
