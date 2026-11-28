import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";
import { CLOSEOUT_NEXT, type CloseoutSkip } from "../src/nous/save-request.js";
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
    work["pane:andy0001"] = { status: "NEEDS_DECISION", at: ago(10), summary: "pick one" };
    newest["pane:andy0001"] = { status: "NEEDS_DECISION", source: "AGENT", at: ago(10), summary: "pick one" };
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ refused: true, result: expect.stringContaining("Andy last reported needs_decision") });
    // Operator 28/11 nous_msg:57f3908d: the same report idle 30+ min with nothing open for the operator is finished.
    work["pane:andy0001"] = { status: "NEEDS_DECISION", at: ago(120), summary: "pick one" };
    newest["pane:andy0001"] = { status: "NEEDS_DECISION", source: "AGENT", at: ago(120), summary: "pick one" };
    expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ ok: true });
    // Plan clipboard:CTVaL1V3kAFM step 2: the tick's clock: the pane's state moved 10 min ago, so the old report still holds it.
    const moved = tools({ quotaWaits: async () => [], paneLastWorkReport: async (_o: string, id: string) => work[id] ?? null, paneLastReport: async (_o: string, id: string) => newest[id] ?? null,
      paneSince: async () => ago(10) });
    expect(await moved.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"] }, ctx)).toMatchObject({ refused: true, result: expect.stringContaining("Andy last reported needs_decision") });
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
        result: expect.stringMatching(/Bob: save not asked; Andy: kept open \(busy: .*\)\. Nothing was closed/) });
    }
    expect(await f.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: ["pane:bob00001", "pane:andy0001"] }, force: true }] }, ctx))
      .toMatchObject({ refused: true, result: expect.stringContaining("Bob: save not asked; Andy: kept open (busy: ") });
    expect(f.roomTool).not.toHaveBeenCalled();
    // Plan clipboard:u78xLyqRp6kD: a board-check or fresh pane is refused for its save, never "kept open (board-check)"; keep-open says what clears it.
    const named = tools({ quotaWaits: async () => [], closeouts: { ...closeouts, roomCloseouts: async () => [closeout(pane("pane:bob00001", "Bob"), "done", "save asked 10:00 UTC, not verified", "board-check", false),
      closeout(pane("pane:andy0001", "Andy"), "done", "save not asked", "keep-open", false)] } });
    expect(await named.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob", "Andy"] }, ctx)).toMatchObject({ refused: true,
      result: expect.stringContaining("Bob: save asked 10:00 UTC, not verified; Andy: kept open (keep-open: your space_pane_checked holds it until its next check; a verified save with no prompt since, or an OK_WORKING/NEEDS_ACTION verdict, clears it)") });
    // Operator 28/11 00:52 BKK: a pane whose provider has no room cannot save, so it is not held for one; a Claude pane with room still is.
    const room = (key: string, nowLeft: number) => ({ key, name: key, provider: null, accounts: 1, nowLeft, atReset: null, pace: null }) as unknown as NousProviderRoom;
    const bobSave = vi.fn(async () => ({ id: "memory:2" }));
    const mixed = tools({ quotaWaits: async () => [], closeouts, providerRooms: async () => [room("codex", 0), room("claude", 60)], memory: { recall: async () => [], save: bobSave } as never,
      listPanes: async () => [pane("pane:bob00001", "Bob"), { ...pane("pane:andy0001", "Andy"), terminalRuntimeId: "cli:claude" } as Pane] });
    expect(await mixed.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ ok: true });
    // Plan clipboard:CTVaL1V3kAFM step 4: Space saves its newest report before that close.
    expect(bobSave).toHaveBeenCalledWith(expect.objectContaining({ scope: "ROOM", roomId: felix.id, provenance: "nous:pane-close:pane:bob00001",
      body: "Bob (pane:bob00001) closed with no room on its provider; it had finished and could not save to memory itself\nIt sent no report." }), expect.any(String));
    expect(await mixed.tools.execute("space_close_pane", { room: "Felix", panes: ["Andy"], force: true }, ctx)).toMatchObject({ refused: true, result: expect.stringContaining("Andy: kept open (busy: ") });
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

  it("plan clipboard:CTVaL1V3kAFM step 4: a pane on a pool with no room passes only the save check, force or not, through either tool", async () => {
    const bob = pane("pane:bob00001", "Bob");
    const save = vi.fn(async () => ({ id: "memory:1" }));
    const noRoom = (state: string, skip: string | null, extra: Partial<NousToolDeps> = {}) => tools({ quotaWaits: async () => [], memory: { recall: async () => [], save } as never,
      providerRooms: async () => [{ key: "codex", name: "Codex", provider: null, accounts: 1, nowLeft: 0, atReset: null, pace: null } as unknown as NousProviderRoom],
      closeouts: { saveRequested: vi.fn(async () => {}), closed: vi.fn(async () => {}), roomCloseouts: async () => [{ pane: bob, state, since, idleMinutes: 5, save: "save not asked", closable: false, skip }] }, ...extra });
    const viaExecute = (dryRun?: boolean) => ({ room: "Felix", actions: [{ kind: "pane", operation: "close", target: { paneIds: [bob.id] }, force: true, ...(dryRun ? { dryRun } : {}) }] });
    // Mid-turn, with uncommitted or unmerged work in its worktree, or with open work: refused like any pane (each closed unsaved before).
    const open = { paneLastWorkReport: async () => ({ status: "PROGRESS", at: new Date(Date.now() - 300_000).toISOString(), summary: "half done" }) };
    for (const [held, text] of [[noRoom("working", "busy"), "Bob: kept open (busy: "], [noRoom("done", "pending-deliverables"), "Bob: kept open (pending-deliverables: "],
      [noRoom("idle", null, open), "Bob last reported progress"]] as const) {
      expect(await held.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"], force: true }, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining(text) });
      expect(await held.tools.execute("space_execute", viaExecute(), ctx)).toMatchObject({ refused: true, result: expect.stringContaining(text) });
      expect(held.roomTool).not.toHaveBeenCalled();
    }
    expect(save).not.toHaveBeenCalled();
    // Finished with nothing keeping it: Space Control closes it too, on its newest report saved first; a dry run saves nothing.
    const order: string[] = [];
    const done = noRoom("done", null, { paneLastWorkReport: async () => ({ status: "DONE", at: since, summary: "Fix shipped" }) });
    save.mockImplementation(async () => { order.push("save"); return { id: "memory:1" }; });
    done.roomTool.mockImplementation(async (name: string) => { order.push(name); return { ok: true, display: `ran ${name}`, result: "[]" }; });
    await done.tools.execute("space_execute", viaExecute(true), ctx);
    expect(save).not.toHaveBeenCalled();
    expect(await done.tools.execute("space_execute", viaExecute(), ctx)).not.toMatchObject({ refused: true });
    expect(order.slice(-2)).toEqual(["save", "space_control"]);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ provenance: `nous:pane-close:${bob.id}`, body: expect.stringMatching(/could not save to memory itself\nNewest report \(DONE, .*\): Fix shipped$/) }), expect.any(String));
    // Space Memory down: nothing closes unsaved.
    const down = noRoom("done", null, { memory: null });
    expect(await down.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("could not be saved") });
    expect(down.roomTool).not.toHaveBeenCalled();
    // The note of a `moved` close names the worktree the pane leaves with uncommitted or unmerged work.
    const moved = noRoom("waiting", "busy", { quotaWaits: async () => [{ paneId: bob.id, label: "Bob", since, resetsAt: null }], pendingWorktreePaths: async () => new Map([[bob.id, "/opt/spaceapp/var/worktrees/space/wt-bob"]]) });
    expect(await moved.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"], moved: "Andy" }, ctx)).toMatchObject({ ok: true });
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ body: "Bob (pane:bob00001) closed with no room on its provider; its work moved to: Andy\nIt sent no report.\nIts worktree holds uncommitted or unmerged work: /opt/spaceapp/var/worktrees/space/wt-bob" }), expect.any(String));
  });
});

/** Plan clipboard:CTVaL1V3kAFM step 9: a refusal read "kept open (plan-open)" and named no way on. */
describe("every reason a pane is kept open names its next step", () => {
  const bob = pane("pane:bob00001", "Bob");
  const reasons = Object.keys(CLOSEOUT_NEXT) as CloseoutSkip[];

  it("the step is a tool Nous has, or a clear wait", () => {
    const names = new Set(nousToolDefinitions({ copilots: true }).map((tool) => tool.name));
    expect(reasons).toHaveLength(19);
    for (const reason of reasons) {
      const named = CLOSEOUT_NEXT[reason].match(/space_[a-z_]+/g) ?? [];
      for (const name of named) expect(names.has(name), `${reason}: ${name}`).toBe(true);
      if (!named.length) expect(CLOSEOUT_NEXT[reason], reason).toMatch(/wait for the (operator|turn|holder|post)|try again later/);
    }
  });

  it("the close and the save refusals print it; a reason whose step is the save lets the save through", async () => {
    for (const reason of reasons) {
      const f = tools({ quotaWaits: async () => [], closeouts: { saveRequested: vi.fn(async () => {}), closed: vi.fn(async () => {}),
        roomCloseouts: async () => [{ pane: bob, state: "done", since, idleMinutes: 40, save: "save not asked", closable: false, skip: reason }] } });
      const savePasses = reason === "fresh" || reason === "board-check";
      expect(await f.tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"], force: true }, ctx), reason).toMatchObject({ refused: true,
        result: expect.stringContaining(savePasses ? "Bob: save not asked" : `Bob: kept open (${reason}: ${CLOSEOUT_NEXT[reason]})`) });
      const save = await f.tools.execute("space_send_to_pane", { room: "Felix", panes: ["Bob"], text: "save to memory" }, ctx);
      // Nous's own keep-open mark does not hold its later save (operator 28/11).
      if (savePasses || reason === "keep-open") expect(save, reason).toMatchObject({ ok: true });
      else expect(save, reason).toMatchObject({ refused: true, result: expect.stringContaining(`Bob is kept open (${reason}: ${CLOSEOUT_NEXT[reason]})`) });
      expect(f.roomTool.mock.calls.length > 0, reason).toBe(savePasses || reason === "keep-open");
    }
  });
});
