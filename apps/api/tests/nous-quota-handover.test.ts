import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { claudeMaxHasNoRoom, createQuotaHandover, handoverTarget, quotaPool, runtimeOfType, withRoomText, type QuotaHandoverRecord } from "../src/nous/quota-handover.js";
import type { NousProviderRoom } from "../src/nous/tokens.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

/** Operator 14/11 19:56 BKK (nous_msg:f0d48b42f0594abea09e2bca): work on a pool with no room goes to a provider with room, never onto it. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
const felix = { id: "room:felix001", name: "Felix", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const pane = (id: string, paneName: string, runtime = "cli:codex", extra: Partial<Pane> = {}) => ({ id, roomId: felix.id, paneName, title: paneName, mode: "TERMINAL",
  terminalRuntimeId: runtime, isClosed: false, ...extra } as unknown as Pane);
const room = (key: string, name: string, nowLeft: number | null, extra: Partial<NousProviderRoom> = {}): NousProviderRoom =>
  ({ key, name, provider: null, accounts: 2, nowLeft, atReset: null, pace: null, points: null, ...extra } as NousProviderRoom);
const codexOut = [room("codex", "Codex", 0), room("claude", "Claude Max", 60), room("gemini", "Gemini (Antigravity)", 80)];
const since = "2026-11-14T12:20:00.000Z";

function tools(overrides: Partial<NousToolDeps> = {}) {
  const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const deps: NousToolDeps = {
    world: async () => "world",
    rooms: async () => [felix],
    listPanes: async () => [pane("pane:bob00001", "Bob"), pane("pane:andy0001", "Andy", "cli:claude")],
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
    providerRooms: async () => codexOut,
    ...overrides
  };
  return { tools: createNousTools(deps), roomTool };
}

describe("no-room guard", () => {
  it("maps runtimes and pane types onto their quota pools", () => {
    expect([quotaPool("cli:codex"), quotaPool("cli:claude"), quotaPool("cli:gemini"), quotaPool("cli:gemini", "claude-opus-4-6"), quotaPool("cli:opencode")])
      .toEqual(["codex", "claude", "gemini", "antigravity-claude", null]);
    // nous_msg:35d3e36f: a space-gateway-claude model outside Claude Code bills the Claude API key's pool.
    expect([quotaPool("cli:opencode", "space-gateway-claude/claude-opus-5-5"), quotaPool("cli:claude", "space-gateway-claude/claude-opus-5-5")]).toEqual(["anthropic", "claude"]);
    expect([runtimeOfType("codex"), runtimeOfType("codex-light"), runtimeOfType("Claude"), runtimeOfType("agy")]).toEqual(["cli:codex", "cli:codex", "cli:claude", "cli:gemini"]);
  });

  it("refuses a prompt, a standing dispatch, a model and a new pane onto Codex with no room, and names where the work goes", async () => {
    const f = tools();
    const calls: Array<[string, Record<string, unknown>, typeof ctx]> = [
      ["space_send_to_pane", { room: "Felix", panes: ["Bob"], text: "continue" }, ctx],
      ["space_send_to_pane", { room: "Felix", panes: ["Bob"], text: "continue", when: "after_turn" }, { ...ctx, turnId: "standing-dispatch" }],
      ["space_open_panes", { room: "Felix", panes: [{ type: "codex", count: 1 }] }, ctx],
      ["space_set_pane_model", { room: "Felix", pane: "Bob", modelId: "gpt-6-astra" }, ctx],
      ["space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "prompt", target: { paneIds: ["pane:bob00001"] }, text: "go" }] }, ctx]
    ];
    for (const [name, args, context] of calls) {
      expect(await f.tools.execute(name, args, context)).toMatchObject({ ok: false, refused: true,
        result: expect.stringMatching(/Codex "avoid \(no room now\)".*code → Claude Opus 5\.5 \(pane type claude, model claude-opus-5-5\); other work → Gemini/) });
    }
    expect(f.roomTool).not.toHaveBeenCalled();
  });

  it("slice 24 (Dino/Oscar 15/11 09:17Z): an agy pane's pool follows the model it runs now, so Gemini passes while Claude · GPT on Antigravity is empty", async () => {
    const agyOut = [room("antigravity-claude", "Claude · GPT on Antigravity", 0), room("gemini", "Gemini (Antigravity)", 99), room("claude", "Claude Max", 60)];
    const oscar = pane("pane:oscar001", "Oscar", "cli:gemini", { modelId: "claude-opus-4-6" });
    const run = (live: string | null) => tools({ providerRooms: async () => agyOut, listPanes: async () => [oscar],
      inspectPane: async () => ({ text: "", state: "IDLE", modelId: live, tasks: [] } as never),
      paneLastWorkReport: async () => ({ status: "DONE", at: since, summary: "done" }) });
    const save = { room: "Felix", panes: ["Oscar"], text: "save to memory" };
    const gemini = run("gemini-3.8-flash-high");
    expect(await gemini.tools.execute("space_send_to_pane", save, ctx)).not.toMatchObject({ refused: true });
    expect(await gemini.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "prompt", target: { paneIds: [oscar.id] }, text: "save to memory" }] }, ctx)).not.toMatchObject({ refused: true });
    for (const live of ["claude-opus-4-6", null]) // a live Claude model, or none (stored claude-opus-4-6), is still refused
      expect(await run(live).tools.execute("space_send_to_pane", save, ctx)).toMatchObject({ refused: true, result: expect.stringContaining("Claude · GPT on Antigravity") });
  });

  it("lets work onto a pool with room, and onto one holding reset credits (only the operator spends them)", async () => {
    expect(await tools().tools.execute("space_send_to_pane", { room: "Felix", panes: ["Andy"], text: "continue" }, ctx)).not.toMatchObject({ refused: true });
    const credits = tools({ providerRooms: async () => [room("codex", "Codex", 0, { resetCredits: { available: 1 } as never }), ...codexOut.slice(1)] });
    expect(await credits.tools.execute("space_open_panes", { room: "Felix", panes: [{ type: "codex", count: 1 }] }, ctx)).not.toMatchObject({ refused: true });
  });

  it("a week ahead of its pace is no refusal (operator 21/11 20:00 BKK, nous_msg:eedece6d; was the daily token check of 15/11)", async () => {
    const runsOut = [room("codex", "Codex", 18, { atReset: { percent: 0, resetAt: "2026-11-21T01:45:40.000Z" } }), room("claude", "Claude Max", 50, { atReset: { percent: 20, resetAt: "2026-11-19T21:00:00.000Z" } })];
    const idle = tools({ providerRooms: async () => runsOut, paneLastWorkReport: async () => ({ status: "DONE", at: since, summary: "done" }) });
    for (const [name, args] of [["space_open_panes", { room: "Felix", panes: [{ type: "codex", count: 1 }] }], ["space_send_to_pane", { room: "Felix", panes: ["Bob"], text: "next step" }],
      ["space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "prompt", target: { paneIds: ["pane:bob00001"] }, text: "go" }] }]] as const) {
      expect(await idle.tools.execute(name, args, ctx)).not.toMatchObject({ refused: true });
    }
  });

  it("lets a quota-waiting pane close once Space handed its task over", async () => {
    const waits = (handedOver: boolean) => async () => [{ paneId: "pane:bob00001", label: "Bob", since, resetsAt: null, handedOver }];
    expect(await tools({ quotaWaits: waits(false) }).tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ refused: true });
    expect(await tools({ quotaWaits: waits(true) }).tools.execute("space_close_pane", { room: "Felix", panes: ["Bob"] }, ctx)).toMatchObject({ ok: true });
  });
});

describe("Claude API key for code panes (nous_msg:a0e6a7a4da2944d0af75ce09, nous_msg:35d3e36f8d414784bde8e43f)", () => {
  const ops = (nowLeft: number, extra: Partial<NousProviderRoom> = {}) => [room("claude", "Claude Max", nowLeft, { bestAccount: "ops", ...extra }),
    room("codex", "Codex", 0), room("anthropic", "Claude API key", null, { accounts: 1, api: { balance: "$109.71", percent: 14, exhausted: false } })];
  const finn = pane("pane:finn0001", "Finn", "cli:opencode", { modelId: "space-gateway-claude/claude-opus-5-5" });
  const nik = pane("pane:nik00001", "Nik", "cli:opencode");
  const andy = pane("pane:andy0001", "Andy", "cli:claude");
  const run = (rooms: NousProviderRoom[], extra: Partial<NousToolDeps> = {}) => tools({ providerRooms: async () => rooms, listPanes: async () => [andy, finn, nik],
    paneLastWorkReport: async () => ({ status: "DONE", at: since, summary: "done" }), ...extra });
  const keyModel = { room: "Felix", pane: "Nik", modelId: "space-gateway-claude/claude-opus-5-5" };
  const prompt = (name: string) => ({ room: "Felix", panes: [name], text: "next step" });

  it("both guards share one room test: ops at 5% opens the key and closes Max, crew at 30% the other way round, never both closed", async () => {
    expect([claudeMaxHasNoRoom(ops(5)), claudeMaxHasNoRoom(ops(30)), claudeMaxHasNoRoom([]), claudeMaxHasNoRoom(ops(5, { resetCredits: { available: 1 } as never }))]).toEqual([true, false, true, false]);
    const out = run(ops(5));
    expect(await out.tools.execute("space_set_pane_model", keyModel, ctx)).not.toMatchObject({ refused: true });
    expect(out.roomTool).toHaveBeenCalledTimes(1);
    expect(await out.tools.execute("space_send_to_pane", prompt("Finn"), ctx)).not.toMatchObject({ refused: true });
    expect(await out.tools.execute("space_send_to_pane", prompt("Andy"), ctx)).toMatchObject({ refused: true, display: "Claude Max: no room now" });
    const crew = run(ops(30, { bestAccount: "crew" }));
    expect(await crew.tools.execute("space_set_pane_model", keyModel, ctx)).toMatchObject({ refused: true, display: "Claude Max has room" });
    expect(await crew.tools.execute("space_send_to_pane", prompt("Andy"), ctx)).not.toMatchObject({ refused: true });
    expect(crew.roomTool).not.toHaveBeenCalledWith("configure_pane", expect.anything(), expect.anything());
  });

  it("stops a key pane once the Claude API key has no balance left", async () => {
    const broke = ops(5);
    broke[2] = { ...broke[2]!, api: { balance: null, percent: 0, exhausted: true } };
    const f = run(broke);
    expect(await f.tools.execute("space_send_to_pane", prompt("Finn"), ctx)).toMatchObject({ refused: true, display: "Claude API key: no balance left" });
    expect(await f.tools.execute("space_set_pane_model", keyModel, ctx)).toMatchObject({ refused: true, display: "Claude API key: no balance left" });
  });

  it("lets work whose panes are all under an active pace-cap emergency past no room, but never onto a pool at 0% or rate limited", async () => {
    const emergency = (entry: { all?: boolean; panes?: string[] } | null) => ({ paceCapEmergency: { sends: false, on: vi.fn() as never, off: vi.fn() as never,
      active: async () => entry && { all: entry.all ?? false, panes: entry.panes ?? [], reason: "operator order", setAt: since, until: "2999-01-01T00:00:00.000Z" } } });
    const andyGo = prompt("Andy");
    expect(await run(ops(5), emergency({ panes: [andy.id] })).tools.execute("space_send_to_pane", andyGo, ctx)).not.toMatchObject({ refused: true });
    expect(await run(ops(5), emergency({ panes: [andy.id] })).tools.execute("space_execute", { room: "Felix",
      actions: [{ kind: "pane", operation: "prompt", target: { paneIds: [andy.id] }, text: "go" }] }, ctx)).not.toMatchObject({ refused: true });
    // Not every target named, a new pane under a pane list, no emergency: refused as before.
    expect(await run(ops(5), emergency({ panes: ["pane:other001"] })).tools.execute("space_send_to_pane", andyGo, ctx)).toMatchObject({ refused: true });
    expect(await run(ops(5), emergency({ panes: [andy.id] })).tools.execute("space_open_panes", { room: "Felix", panes: [{ type: "claude", count: 1 }] }, ctx)).toMatchObject({ refused: true });
    expect(await run(ops(5), emergency(null)).tools.execute("space_send_to_pane", andyGo, ctx)).toMatchObject({ refused: true });
    // An emergency for all work covers a new pane too.
    expect(await run(ops(5), emergency({ all: true })).tools.execute("space_open_panes", { room: "Felix", panes: [{ type: "claude", count: 1 }] }, ctx)).not.toMatchObject({ refused: true });
    // A pool at 0% or a rate-limited best account stays refused.
    expect(await run(ops(0), emergency({ all: true })).tools.execute("space_send_to_pane", andyGo, ctx)).toMatchObject({ refused: true, display: "Claude Max: no room now" });
    expect(await run(ops(5, { bestStatus: "RATE_LIMITED" }), emergency({ all: true })).tools.execute("space_send_to_pane", andyGo, ctx)).toMatchObject({ refused: true });
    // Runs out before its reset is no refusal at all (operator 21/11 20:00 BKK).
    const runsOut = [room("claude", "Claude Max", 40, { atReset: { percent: 0, resetAt: "2026-11-20T00:00:00.000Z" } }), room("codex", "Codex", 50)];
    expect(await run(runsOut, emergency(null)).tools.execute("space_send_to_pane", andyGo, ctx)).not.toMatchObject({ refused: true });
  });
});

describe("quota handover", () => {
  it("routes code to Claude Opus 5.5, else Antigravity Gemini 4 Neon when Claude has no room, else GPT-6 Astra while Codex has room; other work to Gemini", () => {
    expect(handoverTarget(codexOut, true)).toMatchObject({ pool: "claude", modelId: "claude-opus-5-5" });
    const claudeOutGeminiReady = [room("claude", "Claude Max", 2), room("gemini", "Gemini (Antigravity)", 70), room("codex", "Codex", 40)];
    expect(handoverTarget(claudeOutGeminiReady, true)).toMatchObject({ pool: "gemini", type: "gemini", modelId: "gemini-4-neon", name: "Gemini 4 Neon", runtimeId: "cli:gemini" });
    expect(withRoomText(claudeOutGeminiReady)).toContain("code → Gemini 4 Neon (pane type gemini, model gemini-4-neon)");
    expect(withRoomText(claudeOutGeminiReady)).toContain("never Sol");
    expect(handoverTarget([room("claude", "Claude Max", 2), room("gemini", "Gemini (Antigravity)", 5), room("codex", "Codex", 40)], true)).toMatchObject({ pool: "codex", modelId: "gpt-6-astra" });
    expect(handoverTarget([room("claude", "Claude Max", 2), room("codex", "Codex", 40)], true)).toMatchObject({ pool: "codex", modelId: "gpt-6-astra" });
    expect(handoverTarget(codexOut, false)).toMatchObject({ pool: "gemini" });
    expect(handoverTarget([room("claude", "Claude Max", 2), room("codex", "Codex", 3)], true)).toBeNull();
  });

  it("allows opening a Gemini pane and setting gemini-4-neon when Claude pools have no room and Gemini has room", async () => {
    const claudeOut = [room("claude", "Claude Max", 0), room("antigravity-claude", "Claude · GPT on Antigravity", 0), room("gemini", "Gemini (Antigravity)", 80)];
    const oscar = pane("pane:oscar001", "Oscar", "cli:gemini");
    const f = tools({ providerRooms: async () => claudeOut, listPanes: async () => [oscar] });
    expect(await f.tools.execute("space_open_panes", { room: "Felix", panes: [{ type: "gemini", count: 1 }] }, ctx)).toMatchObject({ ok: true });
    expect(await f.tools.execute("space_set_pane_model", { room: "Felix", pane: "Oscar", modelId: "gemini-4-neon" }, ctx)).toMatchObject({ ok: true });
  });

  function harness(opts: { rooms?: NousProviderRoom[]; code?: boolean; idle?: boolean; cap?: number; resetsAt?: string } = {}) {
    const bob = pane("pane:bob00001", "Bob", "cli:codex", { cwd: "/opt/spaceapp/var/worktrees/space/wt-x", taskMetadata: { description: "Fix the parser", steps: ["read", "fix"], planId: "clipboard:plan1" } } as never);
    const andy = pane("pane:andy0001", "Andy", "cli:claude");
    const panes: Pane[] = [bob, ...(opts.idle ? [andy] : [])];
    const details: Record<string, unknown> = { [bob.id]: { status: "waiting", reason: "Usage limit", since, modelId: "gpt-6-sol", resetsAt: opts.resetsAt ?? null }, [andy.id]: { status: "idle" } };
    const records = new Map<string, { version: number; value: QuotaHandoverRecord }>();
    const closedUnder: Array<string | undefined> = [];
    const execute = vi.fn(async (_owner: string, tool: string) => {
      if (tool === "space_open_panes" && opts.cap && panes.filter((entry) => !entry.isClosed).length >= opts.cap) {
        return { ok: false, result: `Room ${felix.id} is capped at ${opts.cap} active panes.\nNot enough finished panes with a verified save to close (0 of 1).` };
      }
      if (tool === "space_open_panes") panes.push(pane("pane:new00001", "Cleo", "cli:claude"));
      // The close guard (wiring quotaWaits) passes a quota-waiting pane only under its HANDED_OVER record.
      if (tool === "space_close_pane") { closedUnder.push(records.get(bob.id)?.value.status); bob.isClosed = true; }
      return { ok: true, result: `ran ${tool}` };
    });
    const notice = vi.fn(async () => {});
    const handover = createQuotaHandover({
      owners: async () => [owner], rooms: async () => [felix], providerRooms: async () => opts.rooms ?? codexOut,
      readActivity: async () => ({ data: panes.filter((entry) => !entry.isClosed), activity: {}, details, sampledAt: since } as never),
      listPanes: async () => [...panes], execute, reports: async () => "Bob reported: parser half done", notice,
      record: { get: async (id) => records.get(id) ?? null,
        write: async (_pane, value, expected) => { if ((records.get(_pane.id)?.version ?? 0) !== expected) return false; records.set(_pane.id, { version: expected + 1, value }); return true; } },
      isCode: () => opts.code ?? true
    });
    return { handover, execute, notice, records, bob, closedUnder };
  }

  it("opens a Claude pane, sets Opus, sends the task with its plan, cwd and report, closes the exhausted pane, once", async () => {
    const h = harness();
    await h.handover.tick();
    expect(h.execute.mock.calls.map((call) => call[1])).toEqual(["space_open_panes", "space_set_pane_model", "space_send_to_pane", "space_close_pane"]);
    expect(h.execute.mock.calls[0]![2]).toMatchObject({ room: felix.id, panes: [{ type: "claude", count: 1 }] });
    expect(h.execute.mock.calls[1]![2]).toMatchObject({ pane: "pane:new00001", modelId: "claude-opus-5-5", when: "after_turn" });
    const text = String((h.execute.mock.calls[2]![2] as { text: string }).text);
    for (const part of ["Fix the parser", "1. read 2. fix", "clipboard:plan1", "git -C /opt/spaceapp/var/worktrees/space/wt-x diff", "parser half done"]) expect(text).toContain(part);
    expect(h.execute.mock.calls[3]![2]).toMatchObject({ panes: ["pane:bob00001"] });
    expect(h.records.get("pane:bob00001")?.value).toMatchObject({ status: "HANDED_OVER", since, to: "pane:new00001" });
    expect(h.notice).toHaveBeenCalledWith(owner, "quota-handover:pane:bob00001", expect.stringContaining("closed Bob (reopenable"));
    h.bob.isClosed = false;
    await h.handover.tick();
    expect(h.execute).toHaveBeenCalledTimes(4);
  });

  it("in a room at its pane cap, closes the exhausted pane first and gives its slot to the Claude pane (Cleo 14/11: Dana, Finn on Codex 0%)", async () => {
    const h = harness({ cap: 1 });
    await h.handover.tick();
    expect(h.execute.mock.calls.map((call) => call[1])).toEqual(["space_open_panes", "space_close_pane", "space_open_panes", "space_set_pane_model", "space_send_to_pane"]);
    expect(h.closedUnder).toEqual(["HANDED_OVER"]);
    expect(h.execute.mock.calls[4]![2]).toMatchObject({ panes: ["pane:new00001"] });
    expect(h.records.get("pane:bob00001")?.value).toMatchObject({ status: "HANDED_OVER", since, to: "pane:new00001" });
    expect(h.notice).toHaveBeenCalledWith(owner, "quota-handover:pane:bob00001", expect.stringContaining("closed Bob first to make room"));
  });

  it("reuses an idle pane of the target CLI instead of opening one", async () => {
    const h = harness({ idle: true });
    await h.handover.tick();
    expect(h.execute.mock.calls.map((call) => call[1])).toEqual(["space_set_pane_model", "space_send_to_pane", "space_close_pane"]);
    expect(h.execute.mock.calls[1]![2]).toMatchObject({ panes: ["pane:andy0001"] });
  });

  it("gives non-code work to Gemini with no model set", async () => {
    const h = harness({ code: false });
    await h.handover.tick();
    expect(h.execute.mock.calls.map((call) => call[1])).toEqual(["space_open_panes", "space_send_to_pane", "space_close_pane"]);
    expect(h.execute.mock.calls[0]![2]).toMatchObject({ panes: [{ type: "gemini", count: 1 }] });
  });

  it("leaves the pane waiting and says so once when no provider has room", async () => {
    const h = harness({ rooms: [room("codex", "Codex", 0), room("claude", "Claude Max", 3)] });
    await h.handover.tick();
    await h.handover.tick();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.notice).toHaveBeenCalledTimes(1);
    expect(h.records.get("pane:bob00001")?.value.status).toBe("NO_ROOM");
  });

  it("does nothing while the pane's own pool still has room", async () => {
    const h = harness({ rooms: [room("codex", "Codex", 40), ...codexOut.slice(1)] });
    await h.handover.tick();
    expect(h.execute).not.toHaveBeenCalled();
  });

  // 22/11: ~25 Antigravity panes stopped on "Individual quota reached, resets in 64-70h" while their pool read room; their work waited for days.
  it("hands over a pane whose own reset is days away even while its pool reads room, and none an hour or less away", async () => {
    const rooms = [room("codex", "Codex", 40), ...codexOut.slice(1)];
    const soon = harness({ rooms, resetsAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    await soon.handover.tick();
    expect(soon.execute).not.toHaveBeenCalled();
    const days = harness({ rooms, resetsAt: new Date(Date.now() + 66 * 3_600_000).toISOString() });
    await days.handover.tick();
    expect(days.execute.mock.calls.map((call) => call[1])).toEqual(["space_open_panes", "space_set_pane_model", "space_send_to_pane", "space_close_pane"]);
    expect(days.records.get("pane:bob00001")?.value).toMatchObject({ status: "HANDED_OVER", to: "pane:new00001" });
  });
});
