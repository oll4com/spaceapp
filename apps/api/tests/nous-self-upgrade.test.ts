import { describe, expect, it, vi } from "vitest";
import { upsertClipboardItemInputSchema, type Pane, type Room } from "@space/contracts";
import { InMemoryNousRepository } from "@space/db";
import { NOUS_DIGEST_MAX_CHARS, renderNousWorld } from "../src/nous/digest.js";
import { createNousService, NOUS_PERSONA, operatorMessagesToAnswer, type NousRunner } from "../src/nous/service.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { operatorFacts, renderOperatorFacts } from "../src/nous/operator-facts.js";
import { archiveTexts, createNotesArchive, NOUS_NOTE_ARCHIVE_PART_CHARS, notesToArchive } from "../src/nous/notes-archive.js";

/** Nous's self-review upgrades of 2026-10-20 (plan clipboard:bTm-5PGrt9po U1-U5). */

const owner = "user:operator";
const room = (id: string, name: string): Room => ({ id, name, kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room);
const pane = (id: string, paneName: string): Pane =>
  ({ id, roomId: "room:main0001", paneName, title: paneName, mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane);
const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };

function tools(overrides: Partial<NousToolDeps> = {}, state: Record<string, string> = {}) {
  const roomTool = vi.fn(async (name: string, _args: Record<string, unknown>) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const deps: NousToolDeps = {
    world: async () => "world",
    rooms: async () => [room("room:main0001", "Main")],
    listPanes: async () => [pane("pane:andy0001", "Andy"), pane("pane:bob00001", "Bob")],
    inspectPane: async (target) => ({ text: "", state: state[target.id] ?? "IDLE", sessionId: "session:1", tasks: [] } as never),
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
    ...overrides
  };
  return { tools: createNousTools(deps), roomTool, deps };
}

describe("U1: every operator message gets an answer", () => {
  it("lists the operator's messages since its last answer, oldest first in their time, and answers at once with space_reply_now", async () => {
    const repository = new InMemoryNousRepository();
    const prompts: string[] = [];
    let interim = "";
    const late: { service?: ReturnType<typeof createNousService> } = {};
    const steps: Array<NousRunner> = [
      // Two messages arrive while the first turn runs (stable 2026-10-20: the next turn answered an older one and skipped them).
      async () => { await late.service!.send(owner, "δεύτερο"); await late.service!.send(owner, "τρίτο"); return { text: "Πρώτη απάντηση.", isError: false }; },
      async (input) => { interim = await late.service!.replyNow(owner, input.turnId, "Το κοιτάζω τώρα."); return { text: "Έγινε.", isError: false }; }
    ];
    const service = late.service = createNousService({
      repository, tools: { execute: vi.fn() as never },
      runner: async (input, signal) => { prompts.push(input.prompt); return (steps.shift() ?? (async () => ({ text: "-", isError: false })))(input, signal); },
      world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }) as never, saveSettings: async (_owner, value) => value,
      notifications: { raise: vi.fn(async () => ({}) as never), resolve: vi.fn(async () => {}) } as never, executeAction: vi.fn(async () => ""),
      timeZone: async () => "Asia/Bangkok"
    });
    await service.send(owner, "πρώτο");
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await service.idle(owner);

    expect(prompts[0]).toMatch(/# Operator messages to answer \(oldest first; your final message answers each one\)\n1\. .+ GMT\+7: πρώτο\n\n---/);
    const second = prompts[1]!.slice(prompts[1]!.indexOf("# Operator messages to answer"));
    expect(second).toMatch(/^# Operator messages to answer .+\n1\. .+: δεύτερο\n2\. .+: τρίτο\n\n---\n\nAnswer every operator message listed/);
    expect(second).not.toContain("πρώτο");
    expect(interim).toBe("SENT");
    const answers = (await repository.listMessages(owner, 20)).filter((message) => message.kind === "ANSWER");
    expect(answers.map((message) => [message.content, message.meta.interim === true])).toEqual([["Πρώτη απάντηση.", false], ["Το κοιτάζω τώρα.", true], ["Έγινε.", false]]);
    // Nothing is left to answer, and an interim reply never counts as the answer.
    expect(operatorMessagesToAnswer(await repository.listMessages(owner, 20))).toEqual([]);
    expect(operatorMessagesToAnswer([...await repository.listMessages(owner, 20)].filter((message) => message.content !== "Έγινε."))
      .map((message) => message.content)).toEqual(["δεύτερο", "τρίτο"]);
    expect(await service.replyNow(owner, "nous_turn:over", "x")).toBe("NOT_RUNNING");
    expect(NOUS_PERSONA).toContain("call space_reply_now first");
  });

  it("offers space_reply_now only for the running turn", async () => {
    const replyNow = vi.fn(async () => "NOT_OPERATOR_TURN" as const);
    const f = tools({ replyNow });
    expect(await f.tools.execute("space_reply_now", { text: "On it." }, ctx)).toMatchObject({ ok: false, result: expect.stringContaining("final message") });
    expect(replyNow).toHaveBeenCalledWith(owner, "nous_turn:t1", "On it.");
  });
});

const block = (id: string, date: string, title: string, tags: string, extra = "") =>
  `<!-- space-memory:id=space_memory:${id} -->\n## ${date} - Space canonical memory: ${title}\n\n- Source: Space API memory.save; original_scope=SYSTEM; provenance=nous; trace=t.\n`
  + `- created_at=${date}T10:00:00.000Z\n- Tags: ${tags}\n- ${title} body.${extra}\n`;

describe("U2: the operator's facts and rules are pinned in the world", () => {
  it("keeps operator-rule and operator-fact entries, newest first, without superseded or archived ones", () => {
    const text = ["# Space Memory 2026-10\n",
      block("aaaaaaaa0000000000000001", "2026-10-17", "Old company framing", "company, operator-rule"),
      block("bbbbbbbb0000000000000002", "2026-10-18", "A plan's progress", "plan, nous"),
      block("cccccccc0000000000000003", "2026-10-19", "INTRATRADE is SpaceApp's company", "company, operator-fact", " supersedes=space_memory:aaaaaaaa0000000000000001"),
      block("dddddddd0000000000000004", "2026-10-19", "Archived rule", "operator-rules", " lifecycle_status=ARCHIVED"),
      block("eeeeeeee0000000000000005", "2026-10-18", "Answer first", "nous, operator-rules")].join("\n");
    const facts = operatorFacts(text);
    expect(facts.map((fact) => fact.title)).toEqual(["INTRATRADE is SpaceApp's company", "Answer first"]);
    const section = renderOperatorFacts(facts);
    expect(section).toContain("- [cccccccc] 2026-10-19 INTRATRADE is SpaceApp's company\n- [eeeeeeee] 2026-10-18 Answer first");
    const world = renderNousWorld({ rooms: [], notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: [], now: "2026-10-20T00:00:00.000Z", operatorFacts: section });
    expect(world.indexOf("## Operator facts and rules")).toBeLessThan(world.indexOf("## Rooms and panes"));
    expect(renderOperatorFacts(operatorFacts(Array.from({ length: 40 }, (_, index) => block(`f${String(index).padStart(23, "0")}`, "2026-10-19", `Rule ${index}`, "operator-rule")).join("\n")))
      .split("\n")).toHaveLength(26);
  });
});

describe("U3: rules from the operator's corrections", () => {
  it("checks a pane's conclusion against the operator's facts, never parks a third-party contact and sweeps a changed premise", () => {
    expect(NOUS_PERSONA).toContain("check it against them and Space Memory, and correct the pane first");
    expect(NOUS_PERSONA).toContain("Never leave a third-party contact");
    expect(NOUS_PERSONA).toContain("never questions our own eligibility");
    expect(NOUS_PERSONA).toContain("sweep everything it touches in the same turn");
    expect(NOUS_PERSONA).toContain("quote their own words");
  });
});

describe("U4: the top tool failures of 19/10", () => {
  it("sends to a busy pane after its turn instead of failing \"now\"", async () => {
    const f = tools({}, { "pane:andy0001": "RUNNING" });
    const sent = await f.tools.execute("space_send_to_pane", { room: "Main", panes: ["Andy", "Bob"], text: "Next step.", when: "now" }, ctx);
    expect(f.roomTool).toHaveBeenCalledWith("send_to_pane", { panes: ["pane:andy0001", "pane:bob00001"], text: "Next step.", when: "after_turn" }, expect.anything());
    expect(sent).toMatchObject({ ok: true, result: expect.stringContaining("Andy was busy: the text goes after the current turn") });
  });

  it("holds the text for a pane that is not at a prompt, and says so instead of a raw refusal", async () => {
    const refusal = JSON.stringify({ status: "FAILED", operationId: "op", results: [{ paneId: "pane:andy0001", status: "FAILED", detail: "The pane is not confirmed ready for input." }] });
    const hold = vi.fn(async () => ({ id: "nous_held:1", waiting: 1 }));
    const f = tools({ held: { level: async () => "CALM", hold } }, { "pane:andy0001": "EXITED" });
    f.roomTool.mockResolvedValueOnce({ ok: false, display: "Could not send to Andy", result: refusal });
    const sent = await f.tools.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text: "Next step." }, ctx);
    expect(hold).toHaveBeenCalledWith(owner, { roomId: "room:main0001", roomName: "Main", paneId: "pane:andy0001", paneName: "Andy" }, "Next step.", "light");
    expect(sent).toMatchObject({ ok: true, result: expect.stringContaining("Andy (state EXITED). The text is held and goes when the pane is ready") });

    const bare = tools({}, { "pane:andy0001": "EXITED" });
    bare.roomTool.mockResolvedValueOnce({ ok: false, display: "Could not send to Andy", result: refusal });
    expect(await bare.tools.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text: "Next step." }, ctx))
      .toMatchObject({ ok: false, result: expect.stringContaining("Not at a prompt: Andy (state EXITED). Read the pane (space_read_pane); if its CLI stopped, restart it (space_restart_pane)") });
  });

  it("tells Nous to ask the operator for a text Space's safety guard held, instead of the raw refusal (daily review 2026-10-20)", async () => {
    const f = tools();
    f.roomTool.mockResolvedValueOnce({ ok: false, display: "Could not send to Andy", result: JSON.stringify({ status: "FAILED", results: [{ paneId: null, status: "FAILED",
      detail: "Execution held by Jev Safety Guard: destructive operation detected (38% confidence). Operator authorization required." }] }) });
    const held = await f.tools.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text: "Run the prune check." }, ctx);
    expect(held).toMatchObject({ ok: false, result: expect.stringContaining("sending it again holds it again. Ask the operator with space_ask_operator (category DESTRUCTIVE)") });
    expect(held.result).toContain('"type":"PANE_TEXT","mode":"PROMPT","roomId":"room:main0001","paneId":"pane:andy0001","text":"Run the prune check."');
  });

  it("turns Space Control prompts NOW into a running pane into prompts after its turn", async () => {
    const f = tools({}, { "pane:andy0001": "RUNNING" });
    await f.tools.execute("space_execute", { room: "Main", actions: [
      { kind: "pane", operation: "prompt", target: { paneIds: ["pane:andy0001"], state: "OPEN" }, text: "Go on.", when: "NOW" },
      { kind: "pane", operation: "prompt", target: { paneIds: ["pane:bob00001"], state: "OPEN" }, text: "Go on.", when: "NOW" }] }, ctx);
    const actions = (f.roomTool.mock.calls[0]![1] as { arguments: { actions: Array<{ when: string }> } }).arguments.actions;
    expect(actions.map((action) => action.when)).toEqual(["AFTER_TURN", "NOW"]);
  });

  it("tells Nous not to retry a model a Claude pane cannot switch, and keeps the retry hint for a pane that was not ready", async () => {
    const f = tools();
    const failed = (detail: string) => ({ ok: false, display: "Could not set the model", result: JSON.stringify({ status: "FAILED", results: [{ paneId: "pane:andy0001", status: "FAILED", detail }] }) });
    f.roomTool.mockResolvedValueOnce(failed("This Claude Code version cannot change the model for one pane only."));
    expect((await f.tools.execute("space_set_pane_model", { room: "Main", pane: "Andy", modelId: "claude-opus-5-5" }, ctx)).result).toContain("Do not retry this pane's model");
    f.roomTool.mockResolvedValueOnce(failed("OpenCode model readback did not confirm the requested model."));
    expect((await f.tools.execute("space_set_pane_model", { room: "Main", pane: "Andy", modelId: "claude-opus-5-5" }, ctx)).result).toContain("set it again in a later turn");
    // Daily review 2026-10-20: a fresh Codex pane and an unreadable pane get the step that works instead of "set it again".
    f.roomTool.mockResolvedValueOnce(failed("The native Codex thread changed before model control."));
    expect((await f.tools.execute("space_set_pane_model", { room: "Main", pane: "Andy", modelId: "gpt-6-astra" }, ctx)).result).toContain("give it its task now and set the model after that turn");
    f.roomTool.mockResolvedValueOnce(failed("Native state is unknown."));
    expect((await f.tools.execute("space_set_pane_model", { room: "Main", pane: "Andy", modelId: "claude-opus-5-5" }, ctx)).result).toContain("restart it (space_restart_pane), then set the model once");
  });

  it("withdrawing an answered decision is ok and says how it ended; a missing clipboard record says how to find it", async () => {
    const f = tools({ decision: async () => ({ id: "nous_decision:abcdef123456", status: "APPROVED", answer: "Yes", outcome: "Sent to Andy." }) as never });
    expect(await f.tools.execute("space_withdraw_decision", { decision: "nous_decision:abcdef123456", reason: "Answered in chat." }, ctx))
      .toMatchObject({ ok: true, result: expect.stringContaining("is already approved (\"Yes\"); outcome: Sent to Andy.") });
    expect((await f.tools.execute("space_clipboard_read", { item: "clipboard:gone000001" }, ctx)).result).toContain("find the record with space_clipboard");
  });
});

describe("U5: notes housekeeping", () => {
  const now = Date.parse("2026-10-20T00:00:00.000Z");
  const note = (key: string, hoursAgo: number, text = `${key} text`) => ({ key, text, updatedAt: new Date(now - hoursAgo * 3_600_000).toISOString() });

  it("archives turn and day logs older than 48 hours, saving the archive before any note is deleted", async () => {
    const notes = [note("day-1017-log1", 60), note("after-promote-1255", 50), note("day-1019-log9", 2), note("plan-map", 90), note("lessons-1020-company", 70),
      note("decisions-answered-1", 49), note("night-1018", 72)];
    expect(notesToArchive(notes, now).map((entry) => entry.key)).toEqual(["night-1018", "day-1017-log1", "after-promote-1255", "decisions-answered-1"]);
    const calls: string[] = [];
    const archive = createNotesArchive({ now: () => now, save: async (_owner, text) => { calls.push(`save:${text.split("\n")[0]}`); }, remove: async (_owner, key) => { calls.push(`remove:${key}`); } });
    expect([...await archive.run(owner, notes)]).toEqual(["night-1018", "day-1017-log1", "after-promote-1255", "decisions-answered-1"]);
    expect(calls).toEqual(["save:Nous: notes archive 2026-10-20 (part 1/1)", "remove:night-1018", "remove:day-1017-log1", "remove:after-promote-1255", "remove:decisions-answered-1"]);

    // A failed save deletes nothing.
    const remove = vi.fn(async () => {});
    expect([...await createNotesArchive({ now: () => now, save: async () => { throw new Error("db down"); }, remove }).run(owner, notes)]).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("splits archives under the clipboard's agent note limit, keeps every note whole or in numbered pieces, and deletes only saved notes", async () => {
    // Stable 2026-10-20: one 100,000-character archive failed "Agent notes may contain at most 10000 characters" every turn.
    const accepted = (text: string) => upsertClipboardItemInputSchema.safeParse({ ownerUserId: owner, source: "AGENT_NOTE", text }).success;
    const notes = [...Array.from({ length: 30 }, (_, index) => note(`day-1018-log${String(index).padStart(2, "0")}`, 60, `${index}:`.padEnd(700, "ε"))),
      note("night-1017", 70, "Ω".repeat(25_000))];
    expect(notes.reduce((sum, entry) => sum + entry.text.length, 0)).toBeGreaterThan(10_000);
    const parts = archiveTexts(notesToArchive(notes, now), now);
    expect(parts.length).toBeGreaterThan(4);
    for (const [index, part] of parts.entries()) {
      expect(part.text.length).toBeLessThanOrEqual(NOUS_NOTE_ARCHIVE_PART_CHARS);
      expect(accepted(part.text)).toBe(true);
      expect(part.text.split("\n")[0]).toBe(`Nous: notes archive 2026-10-20 (part ${index + 1}/${parts.length})`);
    }
    // Small notes stay whole; the big one comes back exactly from its pieces.
    for (const small of notes.slice(0, 30)) expect(parts.filter((part) => part.text.includes(`### ${small.key} `)).map((part) => part.text)
      .join("")).toContain(`UTC)\n${small.text}`);
    const pieces = parts.flatMap((part) => part.text.split("\n\n").filter((entry) => entry.startsWith("### night-1017 ")));
    expect(pieces[0]).toMatch(/, piece 1\/3\)\n/);
    expect(pieces.map((entry) => entry.slice(entry.indexOf("\n") + 1)).join("")).toBe(notes[30]!.text);

    // One record fails: its notes stay for the next run, every other note goes, and only after the saves.
    const failing = parts[2]!;
    const order: string[] = [];
    const warn = vi.fn();
    const moved = await createNotesArchive({ now: () => now, warn, save: async (_owner, text) => {
      order.push("save");
      if (text === failing.text) throw new Error("db down");
    }, remove: async (_owner, key) => { order.push(`remove:${key}`); } }).run(owner, notes);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(order.lastIndexOf("save")).toBeLessThan(order.findIndex((entry) => entry.startsWith("remove:")));
    for (const key of failing.keys) expect(moved.has(key)).toBe(false);
    expect([...moved].sort()).toEqual(notes.map((entry) => entry.key).filter((key) => !failing.keys.includes(key)).sort());
  });

  it("shows the lessons first as one digest, logs after the other notes, and lists at most 20 hidden keys", () => {
    const notes = [note("operator-language", 1, "Greek"), note("lessons-1020-company", 3, "Check the operator facts first."), note("lessons", 50, "Answer first."),
      note("day-1019-log9", 0.5, "y".repeat(3_900)), note("standing-holds", 5, "Hold the promote."),
      ...Array.from({ length: 30 }, (_, index) => note(`day-1018-log${index}`, 10 + index, "z".repeat(3_900)))];
    const world = renderNousWorld({ rooms: [], notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes, now: "2026-10-20T00:00:00.000Z" });
    const section = world.slice(world.indexOf("## Your notes"));
    expect(section).toMatch(/^## Your notes\n### Lessons \(from the operator's corrections, newest first: follow them\)\n- \[lessons-1020-company\] Check the operator facts first\.\n- \[lessons\] Answer first\.\n### operator-language\nGreek\n### standing-holds\nHold the promote\.\n### day-1019-log9/);
    expect(section).toMatch(/Older notes not shown \(fold them into newer ones, or delete them\): (day-1018-log\d+, ){19}day-1018-log\d+ and \d+ more$/);
    expect(world.length).toBeLessThanOrEqual(NOUS_DIGEST_MAX_CHARS);
  });

  it("keeps the open decisions and plans in a world crowded by rooms and notes", () => {
    const decisions = [{ id: "nous_decision:abcdef123456", category: "EXTERNAL", title: "Send the CS-Cart question", createdAt: "2026-10-18T10:00:00.000Z" }] as never;
    const notifications = Array.from({ length: 40 }, (_, index) => ({ id: `notification:n${index}aaaaaa`, source: "JOB_COPILOT", kind: "QUESTION", severity: "ATTENTION",
      title: "t".repeat(120), body: "b".repeat(200), roomId: null, paneId: null })) as never;
    const notes = Array.from({ length: 690 }, (_, index) => note(`day-1018-log${index}`, 1, "n".repeat(500)));
    const world = renderNousWorld({ rooms: [], notifications, plans: [], tasks: [], trains: "", decisions, notes, now: "2026-10-20T00:00:00.000Z" });
    expect(world).toContain("## Your decisions waiting for the operator\n- [nous_decision:abcdef123456] EXTERNAL: Send the CS-Cart question");
    expect(world).toContain("## Open plans");
  });
});
