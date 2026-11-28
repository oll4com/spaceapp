import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import type { NousProviderRoom } from "../src/nous/tokens.js";
import { dashboardScreenState } from "../src/agents-dashboard.js";

/** Operator 14/11 19:31 BKK (nous_msg:5d3c312e25ad4039b145b3bd): a pane waiting on its provider's quota is never closed as finished. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
const felix = { id: "room:felix001", name: "Felix", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const pane = (id: string, paneName: string) => ({ id, roomId: felix.id, paneName, title: paneName, mode: "TERMINAL", terminalRuntimeId: "cli:codex", isClosed: false } as unknown as Pane);
const since = "2026-11-14T12:20:00.000Z";

function tools(overrides: Partial<NousToolDeps> = {}) {
  const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const deps: NousToolDeps = {
    world: async () => "world",
    rooms: async () => [felix],
    listPanes: async () => [pane("pane:bob00001", "Bob"), pane("pane:andy0001", "Andy")],
    inspectPane: async () => ({ text: "", state: "IDLE", sessionId: "session:1", tasks: [] } as never),
    roomTool,
    plans: { list: async () => [], get: async () => null, update: vi.fn() as never },
    tasks: { list: async () => [], add: vi.fn() as never, update: vi.fn() as never, rebind: vi.fn() as never },
    clipboard: { list: async () => [], save: vi.fn() as never, complete: vi.fn() as never, remove: vi.fn(async () => {}) },
    memory: null,
    notifications: { list: async () => [], resolve: async () => true },
    releaseTrain: vi.fn(async () => ""),
    setNote: vi.fn(async () => {}),
    ask: vi.fn() as never,
    withdraw: vi.fn(async () => false),
    allowances: async () => ({ promote: false, warm: false }),
    answerPrompt: vi.fn(async () => ({})),
    paneNotices: {} as never,
    quotaWaits: async () => [{ paneId: "pane:bob00001", label: "Bob", since, resetsAt: null }],
    ...overrides
  };
  return { tools: createNousTools(deps), roomTool };
}

describe("WAITING_QUOTA close guard", () => {
  it("refuses to close a pane stopped on its provider's quota, force or not, and names its reset", async () => {
    const f = tools({ quotaWaits: async () => [{ paneId: "pane:bob00001", label: "Bob", since, resetsAt: "2026-11-14T14:00:00.000Z" }] });
    for (const force of [false, true]) {
      expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"], force }, ctx)).toMatchObject({ ok: false, refused: true,
        result: expect.stringMatching(/^Bob waits for its provider's reset at 2026-11-14 14:00 UTC: .*not finished.*continue/) });
    }
    expect(f.roomTool).not.toHaveBeenCalled();
    // Another pane of the room closes as before.
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ ok: true });
  });

  it("refuses the same close through Space Control, and says when the CLI named no reset", async () => {
    const f = tools();
    const outcome = await f.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:bob00001"] }, force: true }] }, ctx);
    expect(outcome).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Bob waits for its provider's reset at a time its CLI did not name") });
    expect(f.roomTool).not.toHaveBeenCalled();
  });

  it("closes a pane whose reset is days away (22/11: Opus panes on Antigravity dead for 64-70 h)", async () => {
    const f = tools({ quotaWaits: async () => [{ paneId: "pane:bob00001", label: "Bob", since, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }] });
    expect(await f.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:bob00001"] }, force: true }] }, ctx))
      .not.toMatchObject({ refused: true });
    expect(f.roomTool).toHaveBeenCalled();
  });

  it("closes it once it reported done or failed after it stopped", async () => {
    const paneDoneSince = vi.fn(async () => true);
    const f = tools({ paneDoneSince });
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ ok: true });
    expect(paneDoneSince).toHaveBeenCalledWith(owner, "pane:bob00001", Date.parse(since));
  });
});

/** Daily Nous errors 11-14/11: a pane whose turn still runs gets no close and no "save to memory" (force passes the close). */
describe("working pane close guard", () => {
  const running = { inspectPane: async (p: Pane) => ({ text: "", state: p.id === "pane:andy0001" ? "RUNNING" : "IDLE", sessionId: "session:1", tasks: [] } as never), quotaWaits: async () => [] };

  it("holds a close and a save request of a working pane, and lets an idle one through", async () => {
    const f = tools(running);
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Andy: the CLI turn still runs") });
    expect(await f.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:andy0001"] } }] }, ctx)).toMatchObject({ refused: true });
    expect(await f.tools.execute("space_send_to_pane", { room: "Felix", panes: ["Andy"], text: "save to memory" }, ctx)).toMatchObject({ refused: true, result: expect.stringContaining('No "save to memory" while it works') });
    expect(f.roomTool).not.toHaveBeenCalled();
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ ok: true });
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"], force: true }, ctx)).toMatchObject({ ok: true });
  });
});

/** 2026-11-15 REVIEW (operator corrections: panes closed with work left): a pane whose newest own report is not done or failed keeps its work. */
describe("open work close guard", () => {
  const reports: Record<string, { status: string; at: string; summary: string }> = {
    "pane:andy0001": { status: "PROGRESS", at: "2026-11-14T20:00:00.000Z", summary: "Step 2 of 4 deployed" },
    "pane:bob00001": { status: "DONE", at: "2026-11-14T20:05:00.000Z", summary: "All green" }
  };
  const base = { quotaWaits: async () => [], paneLastWorkReport: async (_owner: string, paneId: string) => reports[paneId] ?? null };

  it("holds the close of a pane whose last report is progress, through both tools; done, force and a handed-over pane pass", async () => {
    const f = tools(base);
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ ok: false, refused: true,
      result: expect.stringContaining('Andy last reported progress at 2026-11-14 20:00 UTC ("Step 2 of 4 deployed")') });
    expect(await f.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:andy0001"] } }] }, ctx)).toMatchObject({ refused: true });
    expect(f.roomTool).not.toHaveBeenCalled();
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ ok: true });
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"], force: true }, ctx)).toMatchObject({ ok: true });
    const moved = tools({ ...base, quotaWaits: async () => [{ paneId: "pane:andy0001", label: "Andy", since, resetsAt: null, handedOver: true }] });
    expect(await moved.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ ok: true });
  });

  it("lets an idle pane's progress through once Space's turn end followed it 30 min ago (28/11: Work/Max, Jack); needs_decision and a fresh turn end still hold", async () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const work: Record<string, { status: string; at: string; summary: string }> = {
      "pane:andy0001": { status: "PROGRESS", at: ago(120), summary: "Mail signals: read 0" },
      "pane:bob00001": { status: "PROGRESS", at: ago(10), summary: "Step 2 of 4" }
    };
    const newest: Record<string, { status: string; source: string; at: string; summary: string }> = {
      "pane:andy0001": { status: "TURN_END", source: "AUTO", at: ago(119), summary: "ran clean" },
      "pane:bob00001": { status: "TURN_END", source: "AUTO", at: ago(9), summary: "step 2 done" }
    };
    const f = tools({ quotaWaits: async () => [], paneLastWorkReport: async (_o: string, id: string) => work[id] ?? null, paneLastReport: async (_o: string, id: string) => newest[id] ?? null });
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ ok: true });
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ refused: true, result: expect.stringContaining("Bob last reported progress") });
    work["pane:andy0001"] = { status: "NEEDS_DECISION", at: ago(120), summary: "pick one" };
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ refused: true, result: expect.stringContaining("Andy last reported needs_decision") });
  });
});

/** Operator 26/11 (nous_msg:8bd8bc39): 19 panes closed in 35 s with `force`, one with a verified save. */
describe("finished + save-verified close guard", () => {
  it("refuses a bulk close of unsaved or unfinished panes, force or not, through either tool, naming each pane", async () => {
    const closeout = (p: Pane, state: string, save: string, skip: string | null, closable: boolean) => ({ pane: p, state, since, idleMinutes: 5, save, closable, skip });
    const closeouts = { saveRequested: vi.fn(async () => {}), closed: vi.fn(async () => {}),
      roomCloseouts: async () => [closeout(pane("pane:bob00001", "Bob"), "idle", "save not asked", null, false), closeout(pane("pane:andy0001", "Andy"), "waiting", "save not asked", "busy", false)] };
    const f = tools({ quotaWaits: async () => [], closeouts });
    for (const force of [false, true]) {
      expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob", "Andy"], force }, ctx)).toMatchObject({ ok: false, refused: true,
        result: expect.stringMatching(/Bob: save not asked; Andy: kept open \(busy\)\. Nothing was closed/) });
    }
    expect(await f.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:bob00001", "pane:andy0001"] }, force: true }] }, ctx))
      .toMatchObject({ refused: true, result: expect.stringContaining("Bob: save not asked; Andy: kept open (busy)") });
    expect(f.roomTool).not.toHaveBeenCalled();
    // Plan clipboard:u78xLyqRp6kD: a board-check or fresh pane is refused for its save, never "kept open (board-check)"; keep-open says what clears it.
    const named = tools({ quotaWaits: async () => [], closeouts: { ...closeouts, roomCloseouts: async () => [closeout(pane("pane:bob00001", "Bob"), "done", "save asked 10:00 UTC, not verified", "board-check", false),
      closeout(pane("pane:andy0001", "Andy"), "done", "save not asked", "keep-open", false)] } });
    expect(await named.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob", "Andy"] }, ctx)).toMatchObject({ refused: true,
      result: expect.stringContaining("Bob: save asked 10:00 UTC, not verified; Andy: kept open (keep-open: your space_pane_checked holds it until its next check; a verified save with no prompt since, or an OK_WORKING/NEEDS_ACTION verdict, clears it)") });
    // Operator 28/11 00:52 BKK: a pane whose provider has no room cannot save, so it is not held for one; a Claude pane with room still is.
    const room = (key: string, nowLeft: number) => ({ key, name: key, provider: null, accounts: 1, nowLeft, atReset: null, pace: null }) as unknown as NousProviderRoom;
    const mixed = tools({ quotaWaits: async () => [], closeouts, providerRooms: async () => [room("codex", 0), room("claude", 60)],
      listPanes: async () => [pane("pane:bob00001", "Bob"), { ...pane("pane:andy0001", "Andy"), terminalRuntimeId: "cli:claude" } as Pane] });
    expect(await mixed.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ ok: true });
    expect(await mixed.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"], force: true }, ctx)).toMatchObject({ refused: true, result: expect.stringContaining("Andy: kept open (busy)") });
    // The operator's own close order with force passes the save and quota holds through either tool; force alone does not (above).
    const ordered = { ...ctx, turn: { reason: "OPERATOR", operatorMessage: { id: "nous_msg:1", person: true, content: "give their work to Claude and close those Antigravity panes" } } } as never;
    const orderedTools = tools({ closeouts, quotaWaits: async () => [{ paneId: "pane:bob00001", label: "Bob", since, resetsAt: "2026-11-14T14:00:00.000Z" }] });
    expect(await orderedTools.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob", "Andy"] }, ordered)).toMatchObject({ refused: true });
    expect(await orderedTools.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob", "Andy"], force: true }, ordered)).toMatchObject({ ok: true });
    expect(await orderedTools.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:bob00001", "pane:andy0001"] }, force: true }] }, ordered))
      .not.toMatchObject({ refused: true });
    // 28/11 Work/Zoe…, Alex/Kate (case 3): the operator's order from an earlier turn, named by its message id, passes too; a Nous note or a non-close message does not.
    const conversation = [{ id: "nous_msg:50ad2dd4", ownerUserId: owner, kind: "OPERATOR", meta: { person: true }, content: "Give their work to Claude and close those specific Antigravity panes!" },
      { id: "nous_msg:nousown1", ownerUserId: owner, kind: "NOUS", meta: {}, content: "close Bob" },
      { id: "nous_msg:keepthem", ownerUserId: owner, kind: "OPERATOR", meta: { person: true }, content: "do not close Bob" }];
    const later = tools({ closeouts, listConversation: async () => conversation as never });
    expect(await later.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob", "Andy"], force: true, operatorMessageId: "nous_msg:50ad2dd4" }, ctx)).toMatchObject({ ok: true });
    for (const id of ["nous_msg:nousown1", "nous_msg:keepthem"]) {
      expect(await later.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob", "Andy"], force: true, operatorMessageId: id }, ctx)).toMatchObject({ refused: true });
    }
    later.roomTool.mockClear();
    expect(await later.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:bob00001", "pane:andy0001"] }, force: true, operatorMessageId: "nous_msg:50ad2dd4" }] }, ctx))
      .not.toMatchObject({ refused: true });
    expect(JSON.stringify(later.roomTool.mock.calls)).not.toContain("operatorMessageId");
    // Operator 28/11 (Work/Emma, Nik, Copilots/Iris on Gemini with no room): with `moved` a no-room pane closes past its quota hold on its newest report, saved by Space.
    const gina = { ...pane("pane:gina0001", "Gina"), terminalRuntimeId: "cli:gemini", modelId: "gemini-3.8-flash" } as Pane;
    const save = vi.fn(async () => ({ id: "memory:1" }));
    const gemini = (left: number) => tools({ quotaWaits: async () => [{ paneId: gina.id, label: "Gina", since, resetsAt: null }], listPanes: async () => [gina],
      closeouts: { ...closeouts, roomCloseouts: async () => [closeout(gina, "waiting", "save not asked", "busy", false)] },
      providerRooms: async () => [{ key: "gemini", name: "Gemini (Antigravity)", provider: null, accounts: 1, nowLeft: left, atReset: null, pace: null, points: null } as never],
      paneLastWorkReport: async () => ({ status: "PROGRESS", at: since, summary: "Half of the fix done" }), memory: { recall: async () => [], save } as never });
    const out = gemini(0);
    expect(await out.tools.execute("space_close_pane", { room: "Felix", panes: ["Gina"] }, ctx)).toMatchObject({ refused: true });
    expect(await out.tools.execute("space_close_pane", { room: "Felix", panes: ["Gina"], moved: "Andy, plan clipboard:x" }, ctx)).toMatchObject({ ok: true });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ scope: "ROOM", roomId: felix.id, body: expect.stringMatching(/moved to: Andy, plan clipboard:x\nNewest report \(PROGRESS, .*\): Half of the fix done/) }), expect.any(String));
    expect(out.roomTool).toHaveBeenCalledWith("close_pane", { panes: [gina.id] }, expect.anything());
    // With room in its pool `moved` passes nothing: it runs its own save.
    const roomy = gemini(80);
    expect(await roomy.tools.execute("space_close_pane", { room: "Felix", panes: ["Gina"], moved: "Andy" }, ctx)).toMatchObject({ refused: true });
    expect(roomy.roomTool).not.toHaveBeenCalled();
    // The Gateway's 503 for an Antigravity pool with no account is a usage-limit stop the quota guard holds.
    expect(dashboardScreenState("⚠ UNAVAILABLE (code 503): No Antigravity account in Space Gateway can serve this model right now. Error ID: x\n> ").reason).toBe("Usage limit");
  });
});
