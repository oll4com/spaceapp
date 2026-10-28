import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { InMemoryNousAwayRepository, InMemoryNousRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { awayGrantCovers, createNousAway } from "../src/nous/away.js";
import { createNousService, type NousRunner } from "../src/nous/service.js";
import { createNousTools, type NousToolOutcome } from "../src/nous/tools.js";
import { registerNous } from "../src/nous/wiring.js";
import { configureQueueOperatorGrants, takePaneQueueGrant } from "../src/queue-operator-grants.js";

// Nous Away mode (operator request 2026-10-17, plan clipboard:B7eTUHTJYg3X).
const owner = "user:operator";
const sessionSecret = "nous-away-secret-with-enough-length";
const VERIFIED_PROMOTE = "npm run live:verify:dev && space-queue promote --wait";

afterEach(() => { vi.useRealTimers(); });

async function wired(options: { autonomous?: boolean } = {}) {
  const store = new InMemorySpaceStore();
  const room = await store.createRoom({ name: "Main", initialPaneCount: 0 }, "trace:t", owner);
  const andy = await store.createPane({ roomId: room.id, title: "Andy", paneName: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:claude" } as never);
  const execute = vi.fn(async () => ({ ok: true, display: "Sent", result: "{}" }));
  const raise = vi.fn(async (input: Record<string, unknown>, _options?: Record<string, unknown>) => ({ id: "notification:abcdef1", ...input }) as never);
  let queue: Array<[string, Record<string, unknown>]> = [];
  const outcomes: NousToolOutcome[] = [];
  const prompts: string[] = [];
  const app = Fastify();
  const wiring = registerNous(app, {
    config: { instance: "dev" }, apiBaseUrl: "http://127.0.0.1", autonomous: options.autonomous ?? false, auth: { sessionSecret }, store, routeOptions: {},
    parseBody: (schema, body) => schema.parse(body), parseQuery: (schema, query) => schema.parse(query), readActivity: async () => { throw new Error("No activity in this test."); },
    roomTools: { execute }, inspectPane: vi.fn() as never, answerCli: vi.fn() as never, releaseTrain: async () => "No release trains yet.",
    notifications: { raise, resolve: vi.fn(async () => {}), list: async () => [], setStatus: async () => null } as never,
    copilots: {},
    runner: async (input) => {
      prompts.push(input.prompt);
      for (const [name, args] of queue.splice(0)) outcomes.push(await wiring.service.callTool(owner, input.turnId, name, args, `toolu_${outcomes.length}`));
      return { text: "Done.", isError: false };
    }
  });
  await app.ready();
  /** One operator turn: a chat message (from a person unless said otherwise) and the tool calls the model makes in it. */
  const say = async (text: string, calls: Array<[string, Record<string, unknown>]>, person = true) => {
    queue = calls;
    outcomes.length = 0;
    await wiring.service.send(owner, text, { person });
    await wiring.service.idle(owner);
    return [...outcomes];
  };
  return { app, store, room, andy, execute, raise, wiring, say, prompts };
}

const promote = (roomId: string, paneId: string, text = VERIFIED_PROMOTE) =>
  ({ category: "RELEASE", title: `Promote: ${text}`, body: "Dev is verified.", recommendation: "Promote.", action: { type: "PANE_TEXT", roomId, paneId, text, mode: "PROMPT" } });
const start = { op: "start", reason: "Going to sleep", mandate: "Keep the plans moving", grant: ["FULL"] };

describe("Nous Away mode: start and end", () => {
  it("starts only from a person's own chat turn, never from an inbox, heartbeat or decision turn", async () => {
    const run = vi.fn(async () => "started");
    const tools = createNousTools({ away: { run } } as never);
    const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
    const operatorMessage = { id: "nous_msg:abcdef1", content: "Going to sleep, full control until morning", person: true };
    for (const reason of ["INBOX", "HEARTBEAT", "DECISION"]) {
      expect(await tools.execute("space_nous_away", start, { ...ctx, turn: { reason, operatorMessage } })).toMatchObject({ ok: false, refused: true });
    }
    expect(await tools.execute("space_nous_away", start, { ...ctx, turn: { reason: "OPERATOR", operatorMessage: { ...operatorMessage, person: false } } })).toMatchObject({ refused: true });
    expect(await tools.execute("space_nous_away", start, ctx)).toMatchObject({ refused: true });
    expect(run).not.toHaveBeenCalled();
    // Status is harmless from any turn; FULL becomes every grant category.
    expect((await tools.execute("space_nous_away", { op: "status" }, { ...ctx, turn: { reason: "INBOX", operatorMessage: null } })).ok).toBe(true);
    expect((await tools.execute("space_nous_away", start, { ...ctx, turn: { reason: "OPERATOR", operatorMessage } })).ok).toBe(true);
    expect(run).toHaveBeenLastCalledWith(owner, expect.objectContaining({ op: "start", grant: ["PROMOTE", "TEST_PANES"] }), expect.objectContaining({ reason: "OPERATOR" }));
  });

  it("records the operator's reason, mandate and grant, and ends when the operator writes again", async () => {
    const f = await wired();
    try {
      const [refused] = await f.say("Going to sleep", [["space_nous_away", start]], false);
      expect(refused).toMatchObject({ ok: false, refused: true });
      expect((await f.wiring.service.state(owner)).away).toBeNull();
      const [started, again] = await f.say("Going to sleep, I give you full control until morning", [["space_nous_away", start], ["space_nous_away", start]]);
      expect(started).toMatchObject({ ok: true, display: "Starting Away mode" });
      expect(again).toMatchObject({ ok: false, result: "Away mode is already on." });
      const away = (await f.wiring.service.state(owner)).away!;
      expect(away).toMatchObject({ reason: "Going to sleep", mandate: "Keep the plans moving", grant: ["PROMOTE", "TEST_PANES"], until: null });
      await f.say("Good morning", []);
      expect((await f.wiring.service.state(owner)).away).toBeNull();
      expect(f.prompts.at(-1)).toContain("# While the operator was away (your away log)");
      expect(f.prompts.at(-1)).toContain("They are back: start with a short briefing");
      const notes = f.store.listClipboardItems(owner, { source: "AGENT_NOTE", includeCompleted: true, page: 1, pageSize: 10 }).items;
      expect(notes.map((note) => note.text.split("\n")[0])).toEqual([expect.stringMatching(/^Nous: away log \d{4}-\d\d-\d\d$/)]);
    } finally {
      await f.app.close();
    }
  });

  it("ends at the until time with one summary of the held alerts", async () => {
    let now = Date.parse("2026-10-17T16:30:00.000Z");
    const raise = vi.fn(async () => ({}) as never);
    const saveNote = vi.fn(async () => ({}));
    const away = createNousAway({ repository: new InMemoryNousAwayRepository(), notifications: { raise }, saveNote, now: () => now });
    await away.start(owner, { until: "2026-10-18T01:00:00.000Z", reason: "Sleeping", mandate: "Keep going", grant: [], operatorMessageId: null, operatorQuote: null });
    await away.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "DECISION_RELEASE", severity: "ATTENTION", title: "Nous: publish 1.1.6?",
      body: "", link: { surface: "nous" }, dedupeKey: "nous:decision:x", payload: {}, telegram: null });
    expect(raise).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Nous: publish 1.1.6?" }), { held: true });
    expect(await away.tick()).toBe(0);
    now = Date.parse("2026-10-18T01:00:00.000Z");
    expect(await away.tick()).toBe(1);
    expect(await away.current(owner)).toBeNull();
    expect(raise).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "AWAY_SUMMARY", title: "While you were away: 1 alert waited for you", body: "- Nous: publish 1.1.6?" }));
    expect(saveNote).toHaveBeenCalledWith(owner, "Nous: away log 2026-10-17", expect.stringContaining("(UNTIL)"));
  });
});

describe("Nous Away mode: the grant", () => {
  it("approves a verified promote by the grant, runs it and quotes the operator; the never-list stays theirs", async () => {
    const f = await wired();
    try {
      const never: Array<[string, Record<string, unknown>]> = [
        ["npm publish", { ...promote(f.room.id, f.andy.id, "npm publish --access public"), title: "Publish to npm" }],
        ["GitHub release", { ...promote(f.room.id, f.andy.id, "gh release create v1.1.6"), title: "GitHub release" }],
        ["promote without verification", { ...promote(f.room.id, f.andy.id, "space-queue promote --wait"), title: "Promote unverified" }],
        ["promote with a hotfix", { ...promote(f.room.id, f.andy.id, `${VERIFIED_PROMOTE} && space-queue submit --target stable --hotfix`), title: "Promote with hotfix" }],
        ["delete", { category: "DESTRUCTIVE", title: "Delete the old room", body: "", recommendation: "Delete.", action: { type: "SPACE_CONTROL", roomId: f.room.id, actions: [{ kind: "room", operation: "delete" }] } }],
        ["payment", { category: "EXTERNAL", title: "Pay the invoice", body: "", recommendation: "Pay.", action: { type: "PANE_TEXT", roomId: f.room.id, paneId: f.andy.id, text: "pay the invoice with the card", mode: "PROMPT" } }],
        ["third-party send", { category: "EXTERNAL", title: "Send the proposal", body: "", recommendation: "Send.", action: { type: "PANE_TEXT", roomId: f.room.id, paneId: f.andy.id, text: "send the proposal email to the client", mode: "PROMPT" } }],
        ["Warm code", { category: "DIRECTION", title: "Approve the Warm change", body: "", recommendation: "Approve.", checked: ["AGENTS.md: Warm changes need the operator's approval"], action: { type: "PANE_TEXT", roomId: f.room.id, paneId: f.andy.id, text: "approve the Warm cache change", mode: "PROMPT" } }],
        ["pane-host restart", { ...promote(f.room.id, f.andy.id, "sudo systemctl restart codex-pane-host.service"), title: "Restart the pane host" }]
      ];
      const results = await f.say("Going to sleep, I give you full control until morning",
        [["space_nous_away", start], ["space_ask_operator", promote(f.room.id, f.andy.id)], ...never.map(([, args]) => ["space_ask_operator", args] as [string, Record<string, unknown>]),
          ["space_ask_operator", { category: "DESTRUCTIVE", title: "Data loss risk on the backup", body: "", recommendation: "Stop the job.", urgent: true, checked: ["backup log: the job deletes old snapshots"] }]]);
      const [, approved, ...asked] = results;
      expect(approved).toMatchObject({ ok: true, display: expect.stringMatching(/^Approved by the away grant/) });
      expect(f.execute).toHaveBeenCalledWith("send_to_pane", { panes: [f.andy.id], text: VERIFIED_PROMOTE }, expect.anything());
      // The pane's space-queue promote finds the operator grant the server held for it (hardening step 5), once.
      configureQueueOperatorGrants("test-secret-with-enough-length");
      expect(takePaneQueueGrant(f.andy.id, "promote")).toMatch(/^[\w-]+\.[\w-]+$/);
      expect(takePaneQueueGrant(f.andy.id, "promote")).toBeNull();
      const decisions = await f.wiring.service.decisions(owner);
      const record = decisions.find((decision) => decision.title === `Promote: ${VERIFIED_PROMOTE}`)!;
      expect(record).toMatchObject({ status: "APPROVED", outcome: `Sent to Andy in Main.` });
      expect(record.answer).toMatch(/^Approved by away grant nous_away:\w+: "Going to sleep, I give you full control until morning"$/);
      expect(asked.map((outcome) => outcome.display)).toEqual([...never.map(([, args]) => `Asked the operator: ${String(args.title)}`), "Asked the operator: Data loss risk on the backup"]);
      expect(decisions.filter((decision) => decision.status === "OPEN")).toHaveLength(never.length + 1);
      expect(f.execute).toHaveBeenCalledTimes(1);
      // Their alerts wait for the return; the urgent one goes out now.
      const decisionAlerts = f.raise.mock.calls.filter(([input]) => String(input.kind).startsWith("DECISION_"));
      expect(decisionAlerts.filter(([, options]) => options?.held === true)).toHaveLength(never.length);
      expect(decisionAlerts.find(([input]) => input.severity === "URGENT")?.[1]).toEqual({});
    } finally {
      await f.app.close();
    }
  });

  it("covers only a promote that runs after live:verify:dev, and only under the PROMOTE grant", () => {
    const action = (text: string) => ({ type: "PANE_TEXT" as const, roomId: "room:a", paneId: "pane:a", text, mode: "PROMPT" as const });
    expect(awayGrantCovers(["PROMOTE"], { category: "RELEASE", action: action(VERIFIED_PROMOTE) })).toBe("PROMOTE");
    expect(awayGrantCovers(["TEST_PANES"], { category: "RELEASE", action: action(VERIFIED_PROMOTE) })).toBeNull();
    expect(awayGrantCovers(["PROMOTE"], { category: "RELEASE", action: action("space-queue promote --wait && npm run live:verify:dev") })).toBeNull();
    expect(awayGrantCovers(["PROMOTE"], { category: "RELEASE", action: action(`${VERIFIED_PROMOTE}; git push origin main`) })).toBeNull();
    expect(awayGrantCovers(["PROMOTE"], { category: "RELEASE", action: { ...action(VERIFIED_PROMOTE), mode: "ANSWER" } })).toBeNull();
    expect(awayGrantCovers(["PROMOTE"], { category: "DESTRUCTIVE", action: action(VERIFIED_PROMOTE) })).toBeNull();
  });
});

describe("Nous Away mode: quiet chat and rounds", () => {
  it("writes inbox replies to the away log instead of the chat, and briefs from it on return", async () => {
    const repository = new InMemoryNousRepository();
    const raise = vi.fn(async () => ({}) as never);
    const away = createNousAway({ repository: new InMemoryNousAwayRepository(), notifications: { raise }, saveNote: async () => ({}) });
    const prompts: string[] = [];
    const runner: NousRunner = async (input) => { prompts.push(input.prompt); return { text: prompts.length === 1 ? "Unblocked Andy." : "Briefing.", isError: false }; };
    const service = createNousService({ repository, runner, tools: { execute: vi.fn() } as never, world: async () => ({ text: "# The world now", overview: {} as never }),
      settings: async () => ({ enabled: true, maxTurnsPerHour: 20, mayPromote: false, mayApproveWarm: false }), saveSettings: async (_owner, value) => value,
      notifications: { raise: away.raise, resolve: vi.fn(async () => {}) }, executeAction: vi.fn(), away, limits: { inboxDebounceMs: 10 } });
    await away.start(owner, { reason: "Sleeping", mandate: "Keep going", grant: [], operatorMessageId: null, operatorQuote: null });
    await service.notice(owner, "monitor:pane:andy", "Room \"Main\" pane Andy: FINISHED — step 2 done");
    await vi.waitFor(async () => expect(prompts).toHaveLength(1));
    await service.idle(owner);
    expect(prompts[0]).toContain("# Away mode (since");
    expect((await repository.listMessages(owner, 50)).filter((message) => message.kind === "ANSWER")).toEqual([]);
    const session = (await away.current(owner))!;
    expect(await away.listLog(session)).toEqual([expect.objectContaining({ source: "INBOX", what: "Room \"Main\" pane Andy: FINISHED — step 2 done", result: "Unblocked Andy." })]);
    await service.send(owner, "Good morning", { person: true });
    await service.idle(owner);
    expect(prompts[1]).toContain("INBOX: Room \"Main\" pane Andy: FINISHED — step 2 done → Unblocked Andy.");
    expect((await repository.listMessages(owner, 50)).filter((message) => message.kind === "ANSWER").map((message) => message.content)).toEqual(["Briefing."]);
  });

  it("runs the Away round as a standing turn of its own while Away, even without plans or inbox (standing orders 2026-10-21)", async () => {
    const f = await wired({ autonomous: true });
    try {
      // The daily self-review (2026-10-24) is its own standing turn: off here, so the tick brings only the Away round.
      f.store.updateUserSettings(owner, { nous: { enabled: true, standingOrders: { dailyReview: false } } });
      const standing = vi.spyOn(f.wiring.service, "standing");
      // No plan, nothing finished and nobody away: the tick has nothing to bring.
      expect(await f.wiring.standingOrders.tickOwner(owner)).toEqual({ paneLines: 0, stalledPlans: 0, turn: null });
      expect(standing).not.toHaveBeenCalled();
      await f.say("Going to sleep", [["space_nous_away", { ...start, grant: [] }]]);
      await f.wiring.standingOrders.tickOwner(owner);
      await vi.waitFor(() => expect(standing).toHaveBeenCalledWith(owner, "HEARTBEAT", expect.stringMatching(/^Away round: 0 open plans/)));
      await f.wiring.service.idle(owner);
      // The round ran as its own turn with the Away prompt; its reply went to the away log, not the chat (the one answer is the operator turn's).
      expect(f.prompts.at(-1)).toContain("Away round: look over the plans and the panes");
      const messages = await f.wiring.service.messages(owner);
      expect(messages.filter((message) => message.kind === "ANSWER")).toHaveLength(1);
      expect(messages.find((message) => message.kind === "INBOX" && message.meta.standing === "HEARTBEAT")?.content).toMatch(/^Away round: Away round: 0 open plans/);
    } finally {
      await f.app.close();
    }
  });
});
