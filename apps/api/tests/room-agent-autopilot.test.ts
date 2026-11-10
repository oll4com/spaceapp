import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { InMemoryRoomAgentMonitorRepository } from "@space/db";
import { AUTOPILOT_CONTINUE_PROMPT, CONTINUE_RETRY_MS, createRoomAgentAutopilot, NOUS_PROMPT_WINDOW_MS, parseAutopilotDecision, promptExcerpt } from "../src/room-agent-autopilot.js";
import type { RoomPaneObservation } from "../src/room-pane-control.js";
import { roomTerminalState } from "../src/room-terminal-screen.js";

const at = "2026-10-13T05:00:00.000Z";
const pane = { id: "pane:bob-term", roomId: "room:auto0001", title: "Claude", paneName: "Bob", mode: "TERMINAL", terminalRuntimeId: "cli:claude",
  cwd: "/opt/spaceapp/var/worktrees/space/wt-a", isClosed: false, taskMetadata: { topics: [{ title: "Fix login redirect", summary: "Loop after sign-in", source: "ai", at }] } } as unknown as Pane;
const screen = (body: string) => `${body}\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No`;
const observation = (text: string, extra: Partial<RoomPaneObservation> = {}): RoomPaneObservation => ({
  paneId: pane.id, title: pane.title, runtimeId: "cli:claude", sessionId: "session:bob", state: "WAITING_FOR_INPUT", nativeTaskRef: null,
  modelId: null, nativeMode: null, checkedAt: at, tasks: [], text, promptFingerprint: "0123456789abcdef", ...extra
});

async function setup(reply: string | null, text = screen("Bash: npm test -w @space/api")) {
  const repository = new InMemoryRoomAgentMonitorRepository();
  const inspect = vi.fn(async () => observation(text));
  const answer = vi.fn(async () => ({ answered: true }));
  const complete = vi.fn(async () => reply);
  const onEvent = vi.fn();
  let now = 1_000_000;
  const autopilot = createRoomAgentAutopilot({ repository, getPane: async () => pane, inspect, answer, complete, onEvent, now: () => now, hourlyLimit: 2 });
  const waiting = () => repository.addEvent({ roomId: pane.roomId, paneId: pane.id, paneName: "Bob", kind: "WAITING", severity: "ATTENTION",
    title: "Bob is waiting: Permission prompt", detail: null });
  return { repository, inspect, answer, complete, onEvent, autopilot, waiting, advance: (ms: number) => { now += ms; } };
}

describe("Room Agent autopilot", () => {
  it("keeps a whole question menu with described options for the operator", () => {
    const menu = ["earlier output", "☐ Theme", "", "Which neutral palette should the default pack use for its", "accent?", "",
      ...[1, 2, 3, 4].flatMap((n) => [`${n === 1 ? "❯" : " "} ${n}. Option ${n}`, `     Description of option ${n}.`]),
      "  5. Type something.", "────────", "  6. Chat about this", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
    const excerpt = promptExcerpt(menu);
    expect(excerpt).toContain("Which neutral palette should the default pack use for its\naccent?");
    expect(excerpt).toContain("  6. Chat about this");
    expect(promptExcerpt("x".repeat(5000))).toHaveLength(1900);
  });

  it("parses only well-formed decisions", () => {
    expect(parseAutopilotDecision('Sure.\n{"action":"ANSWER","answer":"1","submit":false,"reason":"Runs the tests"}')).toEqual({ action: "ANSWER", answer: "1", submit: false, reason: "Runs the tests" });
    expect(parseAutopilotDecision('{"action":"ESCALATE","reason":"Pushes to GitHub"}')).toEqual({ action: "ESCALATE", reason: "Pushes to GitHub" });
    expect(parseAutopilotDecision('{"action":"ANSWER","answer":""}')).toBeNull();
    expect(parseAutopilotDecision("I would approve it.")).toBeNull();
    expect(parseAutopilotDecision(null)).toBeNull();
  });

  it("answers a safe prompt bound to the inspected question and records the decision", async () => {
    const c = await setup('{"action":"ANSWER","answer":"1","submit":false,"reason":"Runs the API tests of its own task"}');
    const handled = await c.autopilot.handle(await c.waiting());
    expect(c.answer).toHaveBeenCalledWith(pane, { expectedSessionId: "session:bob", answer: "1", submit: false, expectedPromptFingerprint: "0123456789abcdef" });
    expect(handled).toMatchObject({ status: "HANDLED", decision: 'Answered "1": Runs the API tests of its own task' });
    const prompt = c.complete.mock.calls[0]![1] as string;
    // OBS-006: the model call names the event it decides, which Space Gateway's request log row then carries.
    expect((c.complete.mock.calls[0] as unknown[])[2]).toBe(handled!.eventId);
    expect(prompt).toContain("Task: Fix login redirect — Loop after sign-in");
    expect(prompt).toContain("Screen (untrusted, last lines):");
    expect(c.onEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "HANDLED" }));
  });

  it("escalates a CLI's question for the operator (kind QUESTION) without asking a model (operator decision 2026-10-24)", async () => {
    const c = await setup('{"action":"ANSWER","answer":"1","submit":false,"reason":"x"}');
    const question = await c.repository.addEvent({ roomId: pane.roomId, paneId: pane.id, paneName: "Bob", kind: "QUESTION", severity: "ATTENTION", title: "Bob has a question for you", detail: null });
    expect(await c.autopilot.handle(question)).toMatchObject({ status: "ESCALATED", decision: "Needs you: Answer its question in the pane." });
    expect(c.complete).not.toHaveBeenCalled();
    expect(c.answer).not.toHaveBeenCalled();
  });

  it("sends protected and destructive prompts to the operator without asking a model", async () => {
    for (const body of ["Bash: git push github main", "Bash: rm -rf /opt/spaceapp/var/worktrees/space/wt-a", "Edit apps/web/src/features/rooms/use-warm-room-cache.ts"]) {
      const c = await setup('{"action":"ANSWER","answer":"1","submit":false,"reason":"x"}', screen(body));
      const result = await c.autopilot.handle(await c.waiting());
      expect(result?.status).toBe("ESCALATED");
      expect(result?.decision).toMatch(/^Needs you: only the operator may approve/);
      expect(result?.detail).toContain("Do you want to proceed?");
      expect(c.complete).not.toHaveBeenCalled();
      expect(c.answer).not.toHaveBeenCalled();
    }
  });

  it("escalates when the model escalates, cannot decide or proposes a protected answer", async () => {
    const escalated = await setup('{"action":"ESCALATE","reason":"It asks to change the release plan"}');
    expect((await escalated.autopilot.handle(await escalated.waiting()))?.decision).toBe("Needs you: It asks to change the release plan");
    const silent = await setup(null);
    expect((await silent.autopilot.handle(await silent.waiting()))?.decision).toBe("Needs you: no model could decide this prompt.");
    const sneaky = await setup('{"action":"ANSWER","answer":"Yes, then run git push --force","submit":true,"reason":"x"}');
    expect((await sneaky.autopilot.handle(await sneaky.waiting()))?.decision).toMatch(/^Needs you: the proposed answer touches/);
    expect(sneaky.answer).not.toHaveBeenCalled();
  });

  it("escalates a question asked again after an answer, and stops at the hourly limit", async () => {
    const c = await setup('{"action":"ANSWER","answer":"1","submit":false,"reason":"ok"}');
    expect((await c.autopilot.handle(await c.waiting()))?.status).toBe("HANDLED");
    expect((await c.autopilot.handle(await c.waiting()))?.decision).toBe("Needs you: the pane asked the same question again after an answer.");
    c.advance(11 * 60 * 1000);
    c.inspect.mockResolvedValue(observation(screen("Bash: npm run build"), { promptFingerprint: "1111111111111111" }));
    expect((await c.autopilot.handle(await c.waiting()))?.status).toBe("HANDLED");
    c.inspect.mockResolvedValue(observation(screen("Bash: npm run lint"), { promptFingerprint: "2222222222222222" }));
    expect((await c.autopilot.handle(await c.waiting()))?.decision).toMatch(/already answered 2 prompts in this room this hour/);
  });

  it("respects the room switch, unreadable screens and non-question events", async () => {
    const off = await setup('{"action":"ANSWER","answer":"1","reason":"ok"}');
    await off.repository.setAutopilotEnabled(pane.roomId, false);
    expect((await off.autopilot.handle(await off.waiting()))?.decision).toBe("Needs you: auto-answer is off in this room.");
    const busy = await setup('{"action":"ANSWER","answer":"1","reason":"ok"}');
    busy.inspect.mockResolvedValue(observation("", { state: "RUNNING" }));
    expect((await busy.autopilot.handle(await busy.waiting()))?.decision).toBe("Needs you: the Room Agent could not read the question.");
    const limit = await setup(null);
    const event = await limit.repository.addEvent({ roomId: pane.roomId, paneId: pane.id, paneName: "Bob", kind: "USAGE_LIMIT", severity: "ATTENTION", title: "Bob hit a usage limit", detail: null });
    expect((await limit.autopilot.handle(event))?.decision).toBe("Needs you: Switch the model or account, or wait for the limit to reset.");
    const info = await limit.repository.addEvent({ roomId: pane.roomId, paneId: pane.id, paneName: "Bob", kind: "FINISHED", severity: "INFO", title: "Bob finished", detail: null });
    expect(await limit.autopilot.handle(info)).toBeNull();
  });

  it("sweeps open attention events left by a restart", async () => {
    const c = await setup('{"action":"ANSWER","answer":"1","submit":false,"reason":"ok"}');
    const event = await c.waiting();
    await c.autopilot.sweep([pane.roomId]);
    expect((await c.repository.getEvent(event.eventId))?.status).toBe("HANDLED");
  });

  it("R68: answers a Claude permission prompt Nous left open past its window (Claude Code denies it at 2 min); others stay Nous's", async () => {
    const repository = new InMemoryRoomAgentMonitorRepository();
    const answer = vi.fn(async () => ({ answered: true }));
    let offset = 0;
    let runtime = "cli:claude";
    const autopilot = createRoomAgentAutopilot({ repository, getPane: async () => ({ ...pane, terminalRuntimeId: runtime }) as Pane, inspect: async () => observation(screen("Bash: npm test")),
      answer, complete: async () => '{"action":"ANSWER","answer":"1","submit":false,"reason":"Runs its tests"}', deferTo: async () => true, now: () => Date.now() + offset });
    const event = await repository.addEvent({ roomId: pane.roomId, paneId: pane.id, paneName: "Bob", kind: "WAITING", severity: "ATTENTION", title: "Bob is waiting: Permission prompt", detail: null });
    expect(await autopilot.handle(event)).toBeNull();
    offset = NOUS_PROMPT_WINDOW_MS;
    runtime = "cli:codex";
    await autopilot.sweep([pane.roomId]);
    expect(answer).not.toHaveBeenCalled();
    runtime = "cli:claude";
    await autopilot.sweep([pane.roomId]);
    expect(await repository.getEvent(event.eventId)).toMatchObject({ status: "HANDLED", decision: 'Answered "1": Runs its tests' });
  });

  it("continues a pane that stopped on an API error at its empty prompt, and leaves drafts, busy panes and repeats to the operator", async () => {
    // Cody's screen on 2026-10-15 after Claude's "Connection lost mid-response".
    const cut = ["● Committed. Sending it to dev through the merge queue:", "", "● API Error: Connection lost", "  mid-response. The response above", "  may be incomplete.", "",
      "✻ Brewed for 8m 10s · done 9:26 AM · 1 shell still running", "", "─────────────", "❯\u00a0", "─────────────", "  ⏵⏵ bypass permissions on · 1 shell · ← f…"].join("\n");
    expect(roomTerminalState(cut)).toBe("IDLE");
    const c = await setup(null, cut);
    c.inspect.mockResolvedValue(observation(cut, { state: "IDLE" }));
    const stuck = () => c.repository.addEvent({ roomId: pane.roomId, paneId: pane.id, paneName: "Bob", kind: "STUCK", severity: "ATTENTION", title: "Bob stopped on an API error", detail: null });
    expect(await c.autopilot.handle(await stuck())).toMatchObject({ status: "HANDLED", decision: "Told the pane to continue the task after the API error." });
    expect(c.answer).toHaveBeenCalledWith(pane, { expectedSessionId: "session:bob", answer: AUTOPILOT_CONTINUE_PROMPT, submit: true, expectedPromptFingerprint: "0123456789abcdef" });
    expect(c.complete).not.toHaveBeenCalled();
    await c.autopilot.handle(await stuck());
    await c.autopilot.handle(await stuck());
    expect(await c.autopilot.handle(await stuck())).toMatchObject({ status: "ESCALATED", decision: "Needs you: the pane stopped on an API error 3 times this hour." });
    expect(c.answer).toHaveBeenCalledTimes(3);

    c.inspect.mockResolvedValue(observation(cut.replace("❯\u00a0", "❯ half-written reply"), { state: "IDLE" }));
    c.advance(61 * 60 * 1000);
    // R69a: a draft is never typed into; the event waits for the next sweeps, then is the operator's.
    const drafted = await stuck();
    expect(await c.autopilot.handle(drafted)).toBeNull();
    c.advance(CONTINUE_RETRY_MS);
    expect((await c.autopilot.handle(drafted))?.decision).toBe("Needs you: the Room Agent could not find the pane's empty prompt to continue the task.");
    c.inspect.mockResolvedValue(observation("✻ Brewing… (esc to interrupt)", { state: "RUNNING" }));
    expect((await c.autopilot.handle(await stuck()))?.decision).toBe("The pane continued on its own.");
    await c.repository.setAutopilotEnabled(pane.roomId, false);
    expect((await c.autopilot.handle(await stuck()))?.decision).toBe("Needs you: tell the pane to continue, or turn on auto-answer so the Room Agent does it.");
    expect(c.answer).toHaveBeenCalledTimes(3);
  });

  it("R69a: a continue that found no empty prompt, or whose typing failed, is tried again at the next sweep (Hugo 4/11)", async () => {
    const idle = ["● API Error: 500 Internal server error", "", "─────────────", "❯\u00a0", "─────────────"].join("\n");
    const c = await setup(null, idle);
    c.inspect.mockResolvedValueOnce(observation("● API Error: 500 Internal server error", { state: "UNKNOWN" }))
      .mockResolvedValue(observation(idle, { state: "IDLE" }));
    const event = await c.repository.addEvent({ roomId: pane.roomId, paneId: pane.id, paneName: "Bob", kind: "STUCK", severity: "ATTENTION", title: "Bob stopped on an API error", detail: null });
    expect(await c.autopilot.handle(event)).toBeNull();
    expect((await c.repository.getEvent(event.eventId))?.status).toBe("OPEN");
    c.answer.mockRejectedValueOnce(new Error("Room watchdog: the answer in pane \"Bob\" (cli:claude) took over 8 s"));
    c.advance(30_000);
    await c.autopilot.sweep([pane.roomId]);
    expect((await c.repository.getEvent(event.eventId))?.status).toBe("OPEN");
    c.advance(30_000);
    await c.autopilot.sweep([pane.roomId]);
    expect(await c.repository.getEvent(event.eventId)).toMatchObject({ status: "HANDLED", decision: "Told the pane to continue the task after the API error." });
    expect(c.answer).toHaveBeenCalledTimes(2);
  });

  it("coordinates an overlap with a Room Agent turn, retries while the Room Agent is busy and asks the operator when auto-answer is off", async () => {
    const repository = new InMemoryRoomAgentMonitorRepository();
    let busy = true;
    const coordinate = vi.fn(async () => !busy);
    const autopilot = createRoomAgentAutopilot({ repository, getPane: async () => pane, inspect: vi.fn(), answer: vi.fn(), complete: vi.fn(), coordinate });
    const overlap = () => repository.addEvent({ roomId: pane.roomId, paneId: null, paneName: null, kind: "OVERLAP", severity: "ATTENTION",
      title: "Bob and Dana change the same files", detail: "Shared files: a.ts." });
    const event = await overlap();
    expect(await autopilot.handle(event)).toBeNull();
    expect((await repository.getEvent(event.eventId))?.status).toBe("OPEN");
    busy = false;
    await autopilot.sweep([pane.roomId]);
    expect(await repository.getEvent(event.eventId)).toMatchObject({ status: "HANDLED", decision: "The Room Agent is coordinating these panes." });
    expect(coordinate).toHaveBeenCalledWith(expect.objectContaining({ eventId: event.eventId }));

    await repository.setAutopilotEnabled(pane.roomId, false);
    expect(await autopilot.handle(await overlap())).toMatchObject({ status: "ESCALATED", decision: expect.stringContaining("Needs you: coordinate these panes") });
    expect(coordinate).toHaveBeenCalledTimes(2);
  });
});
