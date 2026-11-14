import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { InMemorySpaceStore, SpaceNotFoundError } from "@space/runtime";
import { claudeClearHintTokens, createTaskScheduleRunner, scheduledTaskPrompt, TASK_OCCURRENCE_TIMEOUT_MS, TASK_RETRY_MS } from "../src/task-schedules.js";
import { rememberSpaceTyped } from "../src/cli-prompt-submit.js";
import { MODEL_UNAVAILABLE_GATHER_MS, modelUnavailable, noteModelState, onModelUnavailable, resetModelUnavailable } from "../src/model-unavailable.js";

const owner = "user:owner";
const start = Date.parse("2026-10-15T08:00:00.000Z");
const cliPane = { id: "pane:cli", roomId: "room:mine", mode: "TERMINAL", title: "Claude" } as Pane;
const emptyPrompt = { state: "IDLE", sessionId: "cli_session:1", promptFingerprint: "a".repeat(16), text: "done.\n\n❯ \n" };

function fixture(screen: Record<string, unknown> = emptyPrompt, options: { reopen?: boolean; openPane?: boolean; notice?: (owner: string, key: string, line: string) => Promise<void>;
  brief?: (pane: Pane, owner: string, text: string) => Promise<unknown>; caps?: Record<string, number> } = {}) {
  const store = new InMemorySpaceStore();
  const answer = vi.fn(async () => ({}));
  const inspect = vi.fn(async () => screen as never);
  const panes: Record<string, Pane> = { [cliPane.id]: cliPane, "pane:chat": { ...cliPane, id: "pane:chat", mode: "CHAT" } as Pane,
    "pane:foreign": { ...cliPane, id: "pane:foreign", roomId: "room:theirs" } as Pane,
    "pane:job": { ...cliPane, id: "pane:job", mode: "JOB_APPLY", title: "Job Copilot 1" } as Pane,
    "pane:closed": { ...cliPane, id: "pane:closed", isClosed: true } as Pane,
    "pane:marketing": { ...cliPane, id: "pane:marketing", mode: "MARKETING_COPILOT", title: "Marketing Copilot" } as Pane,
    "pane:freelance": { ...cliPane, id: "pane:freelance", mode: "FREELANCE_COPILOT", title: "Freelance Copilot", isClosed: true } as Pane,
    "pane:security": { ...cliPane, id: "pane:security", mode: "SECURITY_COPILOT", title: "Security Copilot" } as Pane };
  const reopen = vi.fn(async (pane: Pane, _owner: string) => { panes[pane.id] = { ...pane, isClosed: false }; });
  const openPane = vi.fn<(roomId: string, owner: string) => Promise<Pane>>(async (roomId) => (panes["pane:new"] = { ...cliPane, id: "pane:new", roomId, title: "Claude 2" } as Pane));
  const db = { down: false };
  const caps = options.caps ?? {};
  const room = (id: string) => ({ id, name: id, kind: "WORKSPACE", archivedAt: null, ownerUserId: id === "room:theirs" ? "user:other" : owner, ...(id in caps ? { paneCap: caps[id] } : {}) }) as never;
  const runner = createTaskScheduleRunner({
    store: {
      dueTaskSchedules: (now, limit) => store.dueTaskSchedules(now, limit),
      claimTaskSchedule: (id, expected, update) => store.claimTaskSchedule(id, expected, update),
      getPane: async (id) => { if (db.down) throw new Error("timeout exceeded when trying to connect"); if (!panes[id]) throw new SpaceNotFoundError(`Pane ${id} was not found`); return panes[id]!; },
      getRoom: async (id) => room(id),
      bindTaskItem: (owner, id, binding) => store.bindTaskItem(owner, id, binding), listTaskRuns: (id, query) => store.listTaskRuns(id, query),
      listPanes: async (roomId) => Object.values(panes).filter((pane) => pane.roomId === roomId && !pane.isClosed),
      listRooms: async () => Object.keys(caps).map(room)
    },
    inspect, answer, now: () => Date.now(), ...(options.reopen ? { reopen } : {}), ...(options.openPane ? { openPane } : {}), ...(options.notice ? { notice: options.notice } : {}),
    ...(options.brief ? { brief: options.brief } : {})
  });
  const add = (objective: string, schedule: Parameters<InMemorySpaceStore["upsertTaskItem"]>[0]["schedule"], paneId: string | null = cliPane.id) =>
    store.upsertTaskItem({ ownerUserId: owner, title: "Hetzner watch", objective, status: "OPEN", source: "AGENT", paneId, schedule });
  return { store, runner, answer, inspect, reopen, openPane, add, db, get: (id: string) => store.getTaskItem(owner, id)! };
}
const every2h = { recurrence: { kind: "INTERVAL" as const, minutes: 120 }, timeZone: "Europe/Athens" };

describe("scheduled tasks", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
  afterEach(() => { vi.useRealTimers(); });

  it("types a due task into its CLI at an empty prompt and advances the interval", async () => {
    const { runner, answer, add, get } = fixture();
    const task = add("Check the Hetzner ticket.\nReport only a human reply.", every2h);
    expect(task.schedule?.nextRunAt).toBe("2026-10-15T10:00:00.000Z");
    expect(await runner.tick()).toMatchObject({ RAN: 0 });
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).toHaveBeenCalledWith(cliPane, { expectedSessionId: "cli_session:1", answer: expect.stringContaining("Check the Hetzner ticket. Report only a human reply."),
      submit: true, expectedPromptFingerprint: "a".repeat(16) }, expect.stringMatching(/^task_run:/));
    const after = get(task.id).schedule!;
    expect(after).toMatchObject({ nextRunAt: "2026-10-15T12:00:10.000Z", lastRunAt: "2026-10-15T10:00:10.000Z" });
    // OBS-006: the typed task starts no native turn; its run names the request the typing was traced and logged under.
    const requestId = (answer.mock.calls[0] as unknown[])[2] as string;
    expect(after.lastOutcome).toBe(`Sent to the CLI at 2026-10-15T10:00:10.000Z (request ${requestId}).`);
    expect(await runner.tick()).toMatchObject({ RAN: 0 });
  });

  it("skips a task whose pane is closed at once and says to rebind it (task:wY8Cs2_OPK-5, daily review 2026-10-21)", async () => {
    const { runner, answer, inspect, add, get } = fixture();
    const task = add("Run the daily self-review.", every2h, "pane:closed");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ SKIPPED: 1, WAITING: 0 });
    expect(inspect).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(get(task.id).schedule).toMatchObject({ nextRunAt: "2026-10-15T12:00:10.000Z",
      lastOutcome: "Skipped 2026-10-15T10:00:00.000Z: its pane is closed; rebind the task to an open pane." });
  });

  it("reopens a task's pane Nous closed and types the task once its CLI is at the prompt (operator order 2026-10-24)", async () => {
    const { runner, answer, reopen, add, get } = fixture(emptyPrompt, { reopen: true });
    const task = add("Run the daily self-review.", every2h, "pane:closed");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:closed" }), owner);
    expect(answer).not.toHaveBeenCalled();
    vi.setSystemTime(Date.parse("2026-10-15T10:00:40.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(get(task.id).schedule?.lastOutcome).toMatch(/^Sent to the CLI/);
  });

  it("a closed pane in a full room moves its task to an idle CLI pane there, else to a new pane in a room with space, else fails once with the cause (13/11 Felix)", async () => {
    const busy = { state: "BUSY", sessionId: "cli_session:2", promptFingerprint: "c".repeat(16), text: "⠋ Working" };
    const due = Date.parse("2026-10-15T10:00:10.000Z");
    // room:mine has 5 open panes (pane:cli the only idle CLI) and a cap of 5: pane:closed cannot reopen.
    const sameRoom = fixture(emptyPrompt, { reopen: true, notice: vi.fn(async () => undefined), caps: { "room:mine": 5 } });
    const a = sameRoom.add("Run the daily self-review.", every2h, "pane:closed");
    vi.setSystemTime(due);
    expect(await sameRoom.runner.tick()).toMatchObject({ WAITING: 1 });
    expect(sameRoom.reopen).not.toHaveBeenCalled();
    expect(sameRoom.get(a.id)).toMatchObject({ roomId: "room:mine", paneId: "pane:cli" });
    vi.setSystemTime(due + 30_000);
    expect(await sameRoom.runner.tick()).toMatchObject({ RAN: 1 });
    expect(sameRoom.answer).toHaveBeenCalledWith(cliPane, expect.objectContaining({ answer: expect.stringContaining("Run the daily self-review.") }), expect.stringMatching(/^task_run:/));

    vi.setSystemTime(start);
    const notice = vi.fn(async () => undefined);
    const otherRoom = fixture(busy, { reopen: true, openPane: true, notice, caps: { "room:mine": 5, "room:spare": 6 } });
    otherRoom.inspect.mockImplementation(async (pane: Pane) => (pane.id === "pane:new" ? emptyPrompt : busy) as never);
    const b = otherRoom.add("Run the daily self-review.", every2h, "pane:closed");
    vi.setSystemTime(due);
    expect(await otherRoom.runner.tick()).toMatchObject({ WAITING: 1 });
    expect(otherRoom.openPane).toHaveBeenCalledWith("room:spare", owner);
    expect(otherRoom.get(b.id)).toMatchObject({ roomId: "room:spare", paneId: "pane:new" });
    expect(notice).toHaveBeenCalledWith(owner, `task-moved:${b.id}`, expect.stringContaining("is full (5/5 panes); the task moved to pane Claude 2"));
    vi.setSystemTime(due + 30_000);
    expect(await otherRoom.runner.tick()).toMatchObject({ RAN: 1 });

    // Neither: one visible FAILED run with the cause and one notice, not a silent retry each tick until the next day.
    vi.setSystemTime(start);
    const told = vi.fn(async () => undefined);
    const nowhere = fixture(busy, { reopen: true, notice: told, caps: { "room:mine": 5 } });
    const c = nowhere.add("Run the daily self-review.", every2h, "pane:closed");
    vi.setSystemTime(due);
    expect(await nowhere.runner.tick()).toMatchObject({ SKIPPED: 1, WAITING: 0 });
    expect(nowhere.store.listTaskRuns(owner, { limit: 10 }).runs).toEqual([expect.objectContaining({ status: "FAILED", detail: expect.stringContaining("its room room:mine is full (5/5 panes)") })]);
    expect(nowhere.get(c.id).schedule!.nextRunAt).toBe("2026-10-15T12:00:10.000Z");
    vi.setSystemTime(due + 30_000);
    expect(await nowhere.runner.tick()).toMatchObject({ SKIPPED: 0, WAITING: 0 });
    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenCalledWith(owner, `task-missed:${c.id}`, expect.stringContaining("close a pane there or rebind the task"));
    expect(nowhere.reopen).not.toHaveBeenCalled();
  });

  it("sends /clear first when Claude Code's idle hint names 150k+ tokens, then types the task at the cleared prompt (plan clipboard:ctqx7SPqkWR2 step 1)", async () => {
    const hinted = { ...emptyPrompt, text: "● Done.\n\n❯ new task? /clear to save 312.4k tokens\n" };
    const { runner, answer, inspect, add } = fixture(hinted);
    add("Check the Hetzner ticket.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 0, WAITING: 1 });
    expect(answer).toHaveBeenLastCalledWith(cliPane, expect.objectContaining({ answer: "/clear", submit: true }));
    // A hint that stays never clears twice for the same occurrence; the task goes.
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).toHaveBeenLastCalledWith(cliPane, expect.objectContaining({ answer: expect.stringContaining("Check the Hetzner ticket.") }), expect.stringMatching(/^task_run:/));
    expect(answer).toHaveBeenCalledTimes(2);
    // Under 150k, or no hint at all: the task goes at once.
    inspect.mockResolvedValue({ ...emptyPrompt, text: "❯ new task? /clear to save 122.2k tokens\n" } as never);
    vi.setSystemTime(Date.parse("2026-10-15T12:00:20.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).toHaveBeenCalledTimes(3);
    expect(claudeClearHintTokens("❯ new task? /clear to save 1.1M tokens")).toBe(1_100_000);
    expect(claudeClearHintTokens("❯ ")).toBeNull();
  });

  it("types tasks due together a minute apart (plan clipboard:ctqx7SPqkWR2 step 4: the 09:00 burst)", async () => {
    const { runner, answer, add } = fixture();
    add("First.", every2h);
    add("Second.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1, WAITING: 1 });
    vi.setSystemTime(Date.parse("2026-10-15T10:00:40.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 0, WAITING: 1 });
    vi.setSystemTime(Date.parse("2026-10-15T10:01:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it("a task held by the stagger at its grace end still types a minute later, never skipped (12/11 post-reboot burst, Score daily tasks)", async () => {
    const { runner, answer, add, get } = fixture();
    add("First.", every2h);
    const second = add("Second.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T11:59:50.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1, WAITING: 1 });
    vi.setSystemTime(Date.parse("2026-10-15T12:00:20.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 0, SKIPPED: 0, WAITING: 1 });
    vi.setSystemTime(Date.parse("2026-10-15T12:00:55.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).toHaveBeenCalledTimes(2);
    expect(get(second.id).schedule).toMatchObject({ lastRunAt: "2026-10-15T12:00:55.000Z" });
  });

  it("types into an idle Codex whose composer shows its placeholder (R15-1: task:tC05_57xRiBO waited on Alex/Kate)", async () => {
    const { runner, answer, add } = fixture({ ...emptyPrompt, text: "• Sent.\n\n› Ask Codex to do anything\n\n  gpt-6.1-sol xhigh · /opt/spaceapp\n" });
    add("Send the kits.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).toHaveBeenCalledWith(cliPane, expect.objectContaining({ answer: expect.stringContaining("Send the kits.") }), expect.stringMatching(/^task_run:/));
  });

  it("never types into a draft: waits, then skips once the interval has passed", async () => {
    const { runner, answer, add, get } = fixture({ ...emptyPrompt, text: "❯ half-written reply" });
    const task = add("Check the ticket.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T10:30:00.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    vi.setSystemTime(Date.parse("2026-10-15T12:00:01.000Z"));
    expect(await runner.tick()).toMatchObject({ SKIPPED: 1 });
    expect(answer).not.toHaveBeenCalled();
    expect(get(task.id).schedule).toMatchObject({ nextRunAt: "2026-10-15T14:00:01.000Z", lastRunAt: null });
    expect(get(task.id).schedule!.lastOutcome).toMatch(/holding a draft Space did not type/);
  });

  it("waits while the pane's CLI shows its model unavailable, and Nous hears the outage once with the panes (R11-5)", async () => {
    // 29/10 01:56 UTC: Alex/Finn's OpenCode footer read "claude-sonnet-5-5 (unavailable)"; the 07:05 BKK task never typed and nobody knew.
    resetModelUnavailable();
    const lines: Array<[string, string]> = [];
    const stop = onModelUnavailable((who, line) => lines.push([who, line]));
    try {
      const { runner, answer, add, get } = fixture({ ...emptyPrompt, text: "done.\n\n❯ \n Build  claude-sonnet-5-5 (unavailable)  space-gateway-claude" });
      const task = add("Run the API-key engine.", every2h);
      vi.setSystemTime(Date.parse("2026-10-15T10:30:00.000Z"));
      expect(await runner.tick()).toMatchObject({ WAITING: 1 });
      expect(answer).not.toHaveBeenCalled();
      expect(modelUnavailable(cliPane.id)).toMatchObject({ model: "claude-sonnet-5-5" });
      vi.advanceTimersByTime(MODEL_UNAVAILABLE_GATHER_MS);
      expect(lines).toEqual([[owner, expect.stringMatching(/^Model unavailable \(gateway\) since 10:30 UTC on Claude \(claude-sonnet-5-5\): their tasks and kickoffs wait\./)]]);
      // A second tick in the same outage tells nothing more; the pane's working model again ends the outage.
      await runner.tick();
      vi.advanceTimersByTime(MODEL_UNAVAILABLE_GATHER_MS);
      expect(lines).toHaveLength(1);
      noteModelState(owner, cliPane, emptyPrompt.text);
      expect(modelUnavailable(cliPane.id)).toBeNull();
      expect(get(task.id).schedule!.lastOutcome ?? "").not.toMatch(/Sent/);
    } finally {
      stop();
      resetModelUnavailable();
    }
  });

  it("retries a task stuck on an idle pane each tick and tells Nous once, with the cause, at its second 10-minute miss (goal 35813e48)", async () => {
    const notice = vi.fn(async () => undefined);
    const { runner, add } = fixture({ ...emptyPrompt, text: "❯ half-written reply" }, { notice });
    const task = add("Check the ticket.", every2h);
    const due = Date.parse(task.schedule!.nextRunAt!);
    for (const minutes of [1, 9, 10, 15, 19]) {
      vi.setSystemTime(due + minutes * 60_000);
      expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    }
    expect(notice).not.toHaveBeenCalled();
    vi.setSystemTime(due + 2 * TASK_RETRY_MS);
    await runner.tick();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(owner, `task-waits:${task.id}`, expect.stringMatching(/still untyped 20 minutes later on idle pane Claude.*draft Space did not type/));
    for (const minutes of [30, 40, 60]) { vi.setSystemTime(due + minutes * 60_000); await runner.tick(); }
    expect(notice).toHaveBeenCalledTimes(1);
    // A busy pane is no miss: nothing is said.
    const busy = vi.fn(async () => undefined);
    vi.setSystemTime(start);
    const working = fixture({ ...emptyPrompt, state: "RUNNING", text: "✢ Nesting… (esc to interrupt)" }, { notice: busy });
    working.add("Check the ticket.", every2h);
    for (const minutes of [0, 10, 20, 30]) { vi.setSystemTime(due + minutes * 60_000); await working.runner.tick(); }
    expect(busy).not.toHaveBeenCalled();
  });

  it("presses Enter on a text Space typed that stayed in an idle composer, and counts its own task as sent (3/11 Bruno/Paul)", async () => {
    const draftScreen = (text: string) => ({ ...emptyPrompt, sessionId: "cli_session:draft", text: `✻ Compacted while idle\n\n${"─".repeat(40)}\n❯ ${text}\n${"─".repeat(40)}\n` });
    const { runner, answer, inspect, add, get } = fixture(draftScreen("x"));
    const temu = add("Watch Temu prices.", every2h);
    const nero = add("Watch NERO listings.", every2h);
    const temuPrompt = scheduledTaskPrompt(get(temu.id));
    // The scheduler had pasted the Temu watch; its Enter never landed. The NERO watch, due too, finds it there.
    rememberSpaceTyped("cli_session:draft", temuPrompt, start);
    vi.setSystemTime(Date.parse("2026-10-15T10:05:00.000Z"));
    inspect.mockResolvedValue(draftScreen(temuPrompt) as never);
    expect(await runner.tick()).toMatchObject({ WAITING: 2, RAN: 0 });
    expect(answer).toHaveBeenCalledWith(cliPane, { expectedSessionId: "cli_session:draft", answer: "", submit: true, expectedPromptFingerprint: "a".repeat(16) });
    // The Enter took it: the Temu watch is recorded sent, and NERO types at the next empty prompt.
    inspect.mockResolvedValue({ ...emptyPrompt, sessionId: "cli_session:draft" } as never);
    vi.setSystemTime(Date.parse("2026-10-15T10:05:30.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(get(temu.id).schedule!.lastOutcome).toMatch(/its text had stayed in the composer, and Space pressed Enter/);
    vi.setSystemTime(Date.parse("2026-10-15T10:06:40.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).toHaveBeenLastCalledWith(cliPane, expect.objectContaining({ answer: scheduledTaskPrompt(get(nero.id)) }), expect.stringMatching(/^task_run:/));
    // An operator's draft is never submitted.
    answer.mockClear();
    inspect.mockResolvedValue(draftScreen("my own half sentence about the Temu watch") as never);
    vi.setSystemTime(Date.parse("2026-10-15T12:05:00.000Z"));
    await runner.tick();
    expect(answer).not.toHaveBeenCalled();
  });

  it("gives a due task to a Marketing or Freelance Copilot as a brief and advances it, reopening a closed one first", async () => {
    const brief = vi.fn(async () => ({}));
    const { runner, answer, reopen, add, get } = fixture(emptyPrompt, { brief, reopen: true });
    const post = add("Post the weekly SpaceApp update on X.", every2h, "pane:marketing");
    const leads = add("Check Upwork for new leads.", every2h, "pane:freelance");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    // The closed copilot is reopened first and briefed on the next tick, once its CLI runs.
    expect(await runner.tick()).toMatchObject({ RAN: 1, WAITING: 1 });
    expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:freelance" }), owner);
    expect(brief).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse("2026-10-15T10:00:40.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).not.toHaveBeenCalled();
    expect(brief).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:marketing" }), owner, scheduledTaskPrompt(get(post.id)));
    expect(brief).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:freelance" }), owner, expect.stringContaining("Check Upwork for new leads."));
    expect(get(post.id).schedule).toMatchObject({ nextRunAt: "2026-10-15T12:00:10.000Z", lastOutcome: expect.stringMatching(/^Briefed its copilot/) });
    expect(get(leads.id).schedule).toMatchObject({ nextRunAt: "2026-10-15T12:00:40.000Z", lastOutcome: expect.stringMatching(/^Briefed its copilot/) });
    // A brief that fails waits and is tried again.
    brief.mockRejectedValueOnce(new Error("store down"));
    vi.setSystemTime(Date.parse("2026-10-15T12:00:50.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1, RAN: 1 });
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
  });

  it("R58: a copilot busy in its run loop at due time gets the task as a brief, and the task advances only once delivered", async () => {
    const brief = vi.fn(async () => ({}));
    const busy = { state: "BUSY", sessionId: "cli_session:1", promptFingerprint: "b".repeat(16), text: "⠋ space_security_next (waiting for work)" };
    const { runner, answer, add, get } = fixture(busy, { brief });
    const scan = add("Scan the fleet for new KEV entries.", every2h, "pane:security");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    brief.mockRejectedValueOnce(new Error("store down"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1, RAN: 0 });
    expect(get(scan.id).schedule!.nextRunAt).toBe("2026-10-15T10:00:00.000Z");
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).not.toHaveBeenCalled();
    expect(brief).toHaveBeenLastCalledWith(expect.objectContaining({ id: "pane:security" }), owner, scheduledTaskPrompt(get(scan.id)));
    expect(get(scan.id).schedule).toMatchObject({ nextRunAt: "2026-10-15T12:00:10.000Z", lastOutcome: expect.stringMatching(/^Briefed its copilot/) });
  });

  it("R58: tasks waiting on a busy pane never hold back a later due task (the tick read only the oldest 20)", async () => {
    const busy = { state: "BUSY", sessionId: "cli_session:2", promptFingerprint: "c".repeat(16), text: "⠋ Working" };
    const { runner, answer, inspect, add, get } = fixture();
    inspect.mockImplementation(async (pane: Pane) => (pane.id === "pane:job" ? busy : emptyPrompt) as never);
    for (let index = 0; index < 20; index += 1) add(`Busy pane's job ${index}.`, every2h, "pane:job");
    vi.setSystemTime(Date.parse("2026-10-15T10:30:00.000Z"));
    const later = add("Check the ticket.", { recurrence: { kind: "INTERVAL", minutes: 15 }, timeZone: "Europe/Athens" });
    vi.setSystemTime(Date.parse("2026-10-15T10:45:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 20, RAN: 1 });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(get(later.id).schedule!.lastOutcome).toMatch(/^Sent to the CLI/);
  });

  it("retries a task the CLI refused within its grace period, a minute later", async () => {
    const { runner, answer, add } = fixture();
    add("Check the ticket.", every2h);
    answer.mockRejectedValueOnce(new Error("prompt changed"));
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(answer).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse("2026-10-15T10:01:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
  });

  // 7/11 Bruno/Kate: a reopened OpenCode pane failed the typing on every 30 s tick (25 room watchdog alerts in 15 minutes).
  it("backs off a typing that keeps failing: 1, 2, 4 ... minutes apart, at most TASK_RETRY_MS", async () => {
    const { runner, answer, add } = fixture();
    add("Check the ticket.", every2h);
    answer.mockRejectedValue(new Error("The command timed out"));
    const start = Date.parse("2026-10-15T10:00:00.000Z");
    for (let second = 0; second <= 30 * 60; second += 30) {
      vi.setSystemTime(start + second * 1000);
      expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    }
    // Tries at 0, 1, 3, 7, 15 and 25 minutes, not 61 ticks' worth.
    expect(answer).toHaveBeenCalledTimes(6);
  });

  it("runs a one-time task once, and a done task never", async () => {
    const { store, runner, answer, add, get } = fixture();
    const once = add("Pay the invoice.", { recurrence: { kind: "ONCE", at: "2026-10-15T09:00:00.000Z" }, timeZone: "Europe/Athens" });
    const done = add("Daily check.", { recurrence: { kind: "DAILY", time: "12:00" }, timeZone: "Europe/Athens" });
    store.updateTaskItem(owner, done.id, { status: "DONE" });
    expect(get(done.id).schedule?.nextRunAt).toBeNull();
    vi.setSystemTime(Date.parse("2026-10-16T10:00:00.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(await runner.tick()).toMatchObject({ RAN: 0 });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(get(once.id).schedule).toMatchObject({ nextRunAt: null });
    // Reopening resumes the daily schedule at its next occurrence (12:00 Athens = 09:00 UTC).
    expect(store.updateTaskItem(owner, done.id, { status: "OPEN" }).schedule?.nextRunAt).toBe("2026-10-17T09:00:00.000Z");
  });

  it("advances a reminder without a pane and skips a pane that is not a CLI or not the owner's", async () => {
    const { runner, inspect, add, get } = fixture();
    const reminder = add("Call the accountant.", every2h, null);
    const chat = add("Ask the chat.", every2h, "pane:chat");
    const foreign = add("Type into someone else's CLI.", every2h, "pane:foreign");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:00.000Z"));
    expect(await runner.tick()).toMatchObject({ REMINDED: 1, SKIPPED: 2 });
    expect(inspect).not.toHaveBeenCalled();
    expect(get(reminder.id).schedule).toMatchObject({ nextRunAt: "2026-10-15T12:00:00.000Z", lastOutcome: "Reminder due at 2026-10-15T10:00:00.000Z." });
    expect(get(chat.id).schedule!.lastOutcome).toMatch(/not a CLI/);
    expect(get(foreign.id).schedule!.lastOutcome).toMatch(/not in one of your rooms/);
  });

  it("opens a CLI pane in its room for a recurring agent task whose pane is gone, binds and types it there; with no room Nous hears it once (R44-3)", async () => {
    // 3/11: crypto Finn/QA, TOP IMPORTS watch, 5 weekly Monday tasks, the Reddit task and task:VeYqNEXNFozx had no pane, and each due run was a silent "Reminder due".
    const notice = vi.fn<(owner: string, key: string, line: string) => Promise<void>>(async () => {});
    const { store, runner, answer, openPane, get } = fixture(emptyPrompt, { openPane: true, notice });
    const save = (objective: string, source: "AGENT" | "MANUAL", roomId: string | null, paneId: string | null, schedule = every2h) =>
      store.upsertTaskItem({ ownerUserId: owner, title: objective, objective, status: "OPEN", source, roomId, paneId, schedule });
    const lost = save("Watch TOP IMPORTS.", "AGENT", "room:mine", "pane:gone");
    const roomless = save("Nous daily upgrade round.", "AGENT", null, null);
    const mine = save("Call the accountant.", "MANUAL", "room:mine", null);
    const once = save("One look at the Reddit thread.", "AGENT", "room:mine", null, { recurrence: { kind: "ONCE", at: "2026-10-15T10:00:00.000Z" }, timeZone: "Europe/Athens" } as never);
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1, REMINDED: 3, RAN: 0 });
    expect(openPane).toHaveBeenCalledTimes(1);
    expect(openPane).toHaveBeenCalledWith("room:mine", owner);
    expect(get(lost.id)).toMatchObject({ roomId: "room:mine", paneId: "pane:new", schedule: { nextRunAt: "2026-10-15T10:00:00.000Z" } });
    expect(answer).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]!.slice(0, 2)).toEqual([owner, `task-no-pane:${roomless.id}`]);
    expect(notice.mock.calls[0]![2]).toContain(`task ${roomless.id} has no pane`);
    expect(get(mine.id).schedule!.lastOutcome).toBe("Reminder due at 2026-10-15T10:00:00.000Z.");
    expect(get(once.id).schedule!.lastOutcome).toBe("Reminder due at 2026-10-15T10:00:00.000Z.");
    // The next tick types it into the new pane; the roomless task's next run tells Nous nothing more.
    vi.setSystemTime(Date.parse("2026-10-15T10:00:40.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:new" }), expect.objectContaining({ answer: expect.stringContaining("Watch TOP IMPORTS.") }), expect.stringMatching(/^task_run:/));
    vi.setSystemTime(Date.parse("2026-10-15T12:00:20.000Z"));
    await runner.tick();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(openPane).toHaveBeenCalledTimes(1);
  });

  it("moves the scheduled task itself to the new pane, never an unscheduled copy with its objective (Grants 13/11)", async () => {
    // task:GsGOdFpBUc3J kept a stale content hash; the rebind saved its objective again and bound a new unscheduled copy (task:eEcvPa9XrA0H) instead.
    const { store, runner, openPane, get } = fixture(emptyPrompt, { openPane: true });
    const objective = "Grants: re-measure usage.";
    const task = store.upsertTaskItem({ ownerUserId: owner, title: "Grants", objective, status: "OPEN", source: "AGENT", roomId: "room:mine", paneId: "pane:gone", schedule: every2h });
    (store as unknown as { taskItems: Map<string, { contentHash: string }> }).taskItems.get(task.id)!.contentHash = "stale";
    const copy = store.upsertTaskItem({ ownerUserId: owner, title: "Grants", objective, status: "OPEN", source: "AGENT", roomId: "room:mine", paneId: "pane:other" });
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(openPane).toHaveBeenCalledTimes(1);
    expect(get(task.id)).toMatchObject({ roomId: "room:mine", paneId: "pane:new", schedule: { nextRunAt: "2026-10-15T10:00:00.000Z" } });
    expect(get(copy.id)).toMatchObject({ paneId: "pane:other", schedule: null });
  });

  // Copilot tasks were skipped as "not a CLI" although the copilot's CLI runs (2026-10-19).
  it("types a due task into a copilot pane's CLI, and skips one whose CLI is not running", async () => {
    const running = fixture();
    running.add("Archive job emails.", every2h, "pane:job");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await running.runner.tick()).toMatchObject({ RAN: 1 });
    expect(running.answer).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:job", mode: "JOB_APPLY" }), expect.objectContaining({ submit: true }), expect.stringMatching(/^task_run:/));

    vi.setSystemTime(start);
    const stopped = fixture({ state: "UNKNOWN", sessionId: null });
    const task = stopped.add("Archive job emails.", every2h, "pane:job");
    vi.setSystemTime(Date.parse("2026-10-15T10:30:00.000Z"));
    expect(await stopped.runner.tick()).toMatchObject({ WAITING: 1 });
    vi.setSystemTime(Date.parse("2026-10-15T12:00:01.000Z"));
    expect(await stopped.runner.tick()).toMatchObject({ SKIPPED: 1 });
    expect(stopped.answer).not.toHaveBeenCalled();
    expect(stopped.get(task.id).schedule!.lastOutcome).toMatch(/the pane has no running CLI/);
  });

  it("starts the CLI of an open pane that has none, once each 10 minutes, and types the task once it runs (11-12/11 post-move and post-reboot misses)", async () => {
    const { runner, answer, inspect, reopen, add, get } = fixture({ state: "UNKNOWN", sessionId: null }, { reopen: true });
    const task = add("Run the daily self-review.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ id: cliPane.id }), owner);
    vi.setSystemTime(Date.parse("2026-10-15T10:05:00.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(reopen).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.parse("2026-10-15T10:10:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(reopen).toHaveBeenCalledTimes(2);
    expect(answer).not.toHaveBeenCalled();
    inspect.mockResolvedValue(emptyPrompt as never);
    vi.setSystemTime(Date.parse("2026-10-15T10:10:40.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(get(task.id).schedule?.lastOutcome).toMatch(/^Sent to the CLI/);
  });

  it("a pane whose CLI could not be started skips at its grace end as a failed run with the error, and Nous hears it", async () => {
    const notice = vi.fn(async () => undefined);
    const { runner, reopen, add, get } = fixture({ state: "EXITED", sessionId: "cli_session:1" }, { reopen: true, notice });
    reopen.mockRejectedValue(new Error("pane host unavailable"));
    const task = add("Run the daily self-review.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T11:00:00.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    vi.setSystemTime(Date.parse("2026-10-15T12:00:01.000Z"));
    expect(await runner.tick()).toMatchObject({ SKIPPED: 1 });
    const outcome = "Failed 2026-10-15T10:00:00.000Z: the pane had no running CLI and Space could not start it (pane host unavailable).";
    expect(get(task.id).schedule!.lastOutcome).toBe(outcome);
    expect(notice).toHaveBeenCalledWith(owner, `task-missed:${task.id}`, expect.stringContaining("missed 2026-10-15T10:00:00.000Z: the pane had no running CLI and Space could not start it"));
  });

  it("a run first tried past its window (Space was down all of it) starts its CLI and types, never skipped in that same tick (11-12/11 Mail 3/3, X 13:40)", async () => {
    const notice = vi.fn(async () => undefined);
    const busy = { state: "BUSY", sessionId: "cli_session:2", promptFingerprint: "c".repeat(16), text: "⠋ Working" };
    const { runner, answer, inspect, reopen, add, get } = fixture(emptyPrompt, { reopen: true, notice });
    const noCli = { state: "UNKNOWN", sessionId: null };
    let cliStarted = false;
    reopen.mockImplementation(async () => { cliStarted = true; });
    inspect.mockImplementation(async (pane: Pane) => (pane.id === "pane:job" ? busy : cliStarted ? emptyPrompt : noCli) as never);
    const mail = add("Run mail round 3/3.", every2h);
    const held = add("Archive job emails.", every2h, "pane:job");
    vi.setSystemTime(Date.parse("2026-10-15T12:30:00.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 2, SKIPPED: 0 });
    expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ id: cliPane.id }), owner);
    vi.setSystemTime(Date.parse("2026-10-15T12:30:30.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1, WAITING: 1 });
    expect(answer).toHaveBeenCalledWith(cliPane, expect.objectContaining({ answer: expect.stringContaining("Run mail round 3/3.") }), expect.stringMatching(/^task_run:/));
    expect(get(mail.id).schedule!.lastOutcome).toMatch(/^Sent to the CLI/);
    // A pane still busy TASK_RETRY_MS after the first try skips, and Nous hears that run with its cause.
    vi.setSystemTime(Date.parse("2026-10-15T12:30:00.000Z") + TASK_RETRY_MS);
    expect(await runner.tick()).toMatchObject({ SKIPPED: 1 });
    expect(notice).toHaveBeenCalledWith(owner, `task-missed:${held.id}`, expect.stringContaining("missed 2026-10-15T10:00:00.000Z: the CLI was busy or had a draft at its prompt"));
  });

  it("a daily run that missed its 12 h window still runs late until its next run is due, then hands over to it (13/11 Score Daily tasks)", async () => {
    const notice = vi.fn(async () => undefined);
    const busy = { state: "BUSY", sessionId: "cli_session:2", promptFingerprint: "c".repeat(16), text: "⠋ Working" };
    const { runner, inspect, add, get } = fixture(emptyPrompt, { notice });
    let free = false;
    inspect.mockImplementation(async (pane: Pane) => (pane.id === "pane:job" || !free ? busy : emptyPrompt) as never);
    const daily = { recurrence: { kind: "DAILY" as const, time: "12:00" }, timeZone: "Europe/Athens" }; // 09:00Z
    const late = add("Run mail round 1/3.", daily);
    const held = add("Archive job emails.", daily, "pane:job");
    vi.setSystemTime(Date.parse("2026-10-15T22:00:00.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 2, SKIPPED: 0 });
    free = true;
    vi.setSystemTime(Date.parse("2026-10-16T05:00:00.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1, WAITING: 1 });
    expect(get(late.id).schedule).toMatchObject({ nextRunAt: "2026-10-16T09:00:00.000Z", lastOutcome: expect.stringMatching(/^Sent to the CLI/) });
    // Still busy when its next run is due: the old one is skipped (Nous hears it) and the new one, already due, keeps its own window.
    vi.setSystemTime(Date.parse("2026-10-16T09:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1, SKIPPED: 1 });
    expect(get(held.id).schedule!.nextRunAt).toBe("2026-10-16T09:00:00.000Z");
    expect(notice).toHaveBeenCalledWith(owner, `task-missed:${held.id}`, expect.stringContaining("missed 2026-10-15T09:00:00.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1, SKIPPED: 0 });
  });

  it("starts an open copilot's CLI before its brief when it has none, never one that runs, and counts the run only once briefed to a running CLI (11-12/11, 13/11)", async () => {
    const brief = vi.fn<(pane: Pane, owner: string, text: string) => Promise<object>>(async () => ({}));
    const notice = vi.fn(async () => undefined);
    const { runner, inspect, reopen, add, get } = fixture(emptyPrompt, { brief, reopen: true, notice });
    let securityRuns = false;
    inspect.mockImplementation(async (pane: Pane) => (pane.id === "pane:security" && !securityRuns ? { state: "UNKNOWN", sessionId: null } : emptyPrompt) as never);
    const scan = add("Check the fleet's CVEs.", every2h, "pane:security");
    add("Post the weekly SpaceApp update on X.", every2h, "pane:marketing");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1, WAITING: 1 });
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:security" }), owner);
    // Not briefed while its CLI is not running, and started again only after TASK_RETRY_MS.
    vi.setSystemTime(Date.parse("2026-10-15T10:00:40.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(brief.mock.calls.some(([pane]) => pane.id === "pane:security")).toBe(false);
    expect(get(scan.id).schedule!.nextRunAt).toBe("2026-10-15T10:00:00.000Z");
    vi.setSystemTime(Date.parse("2026-10-15T10:10:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(reopen).toHaveBeenCalledTimes(2);
    // Once its CLI runs, the brief goes and the run counts.
    securityRuns = true;
    vi.setSystemTime(Date.parse("2026-10-15T10:10:40.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
    expect(brief).toHaveBeenLastCalledWith(expect.objectContaining({ id: "pane:security" }), owner, scheduledTaskPrompt(get(scan.id)));
    expect(get(scan.id).schedule!.lastOutcome).toMatch(/^Briefed its copilot/);
    // A copilot whose CLI never runs is a miss at its window end, never a brief counted as run.
    securityRuns = false;
    vi.setSystemTime(Date.parse("2026-10-15T12:20:40.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    vi.setSystemTime(Date.parse("2026-10-15T14:20:40.000Z"));
    expect(await runner.tick()).toMatchObject({ SKIPPED: 1 });
    expect(get(scan.id).schedule!.lastOutcome).toMatch(/^Skipped 2026-10-15T12:10:40.000Z: its copilot (has|had) no running CLI/);
    expect(notice).toHaveBeenCalledWith(owner, `task-missed:${scan.id}`, expect.stringContaining("its copilot"));
  });

  it("a pane call that never answers holds only its own task: the tick goes on and never tries it twice at once (11-12/11)", async () => {
    const { runner, inspect, add, get } = fixture();
    inspect.mockImplementation((pane: Pane) => (pane.id === "pane:job" ? new Promise(() => undefined) : Promise.resolve(emptyPrompt)) as never);
    add("Archive job emails.", { recurrence: { kind: "INTERVAL", minutes: 60 }, timeZone: "Europe/Athens" }, "pane:job");
    const task = add("Check the ticket.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    const ticking = runner.tick();
    await vi.advanceTimersByTimeAsync(TASK_OCCURRENCE_TIMEOUT_MS);
    expect(await ticking).toMatchObject({ WAITING: 1, RAN: 1 });
    expect(get(task.id).schedule!.lastOutcome).toMatch(/^Sent to the CLI/);
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("a pane read the database could not answer waits and types once it can; only a missing pane fails, and Nous hears it (12/11 Temu)", async () => {
    const notice = vi.fn(async () => undefined);
    const { runner, answer, add, get, db } = fixture(emptyPrompt, { notice });
    const task = add("Check Temu orders.", every2h);
    const gone = add("Watch the deleted pane.", every2h, "pane:deleted");
    db.down = true;
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 2, SKIPPED: 0 });
    expect(answer).not.toHaveBeenCalled();
    db.down = false;
    vi.setSystemTime(Date.parse("2026-10-15T10:01:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1, SKIPPED: 1 });
    expect(get(task.id).schedule!.lastRunAt).toBe("2026-10-15T10:01:10.000Z");
    expect(get(gone.id).schedule!.lastOutcome).toMatch(/the task's pane no longer exists/);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(owner, `task-no-pane:${gone.id}`, expect.stringContaining("its pane pane:deleted no longer exists"));
  });

  it("logs every handled occurrence as a task run, and only the pane's own report decides a typed one (plan clipboard:GA__W4qBxSPR)", async () => {
    const { store, runner, add } = fixture();
    const runs = () => store.listTaskRuns(owner, { limit: 100 }).runs.map(({ status, typed, detail, report }) => ({ status, typed, detail, report }));
    add("Check the ticket.", every2h);
    add("Stretch.", every2h, null);
    add("Watch the deleted pane.", every2h, "pane:deleted");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ RAN: 1, REMINDED: 1, SKIPPED: 1 });
    expect(runs()).toEqual(expect.arrayContaining([
      { status: "RUNNING", typed: true, detail: expect.stringMatching(/^Sent to the CLI at 2026-10-15T10:00:10\.000Z \(request task_run:[\w-]+\)\.$/), report: null },
      { status: "REMINDER", typed: false, detail: "Reminder due at 2026-10-15T10:00:00.000Z.", report: null },
      { status: "FAILED", typed: false, detail: expect.stringMatching(/^Failed 2026-10-15T10:00:00\.000Z: the task's pane no longer exists/), report: null }]));
    expect(runs()).toHaveLength(3);
    // Typed is not success: a report from before the run, or one that only says it works, decides nothing.
    const report = (at: string, status: string, summary = status) => store.noteTaskRunReport(owner, { paneId: cliPane.id, at, status, summary });
    expect(report("2026-10-15T10:00:05.000Z", "DONE")).toBe(false);
    expect(report("2026-10-15T10:05:00.000Z", "PROGRESS", "Reading the ticket")).toBe(true);
    const typedId = store.listTaskRuns(owner, { limit: 100, status: "RUNNING" }).runs[0]!.taskId;
    const typed = () => store.listTaskRuns(owner, { limit: 100, taskId: typedId }).runs[0]!;
    expect(typed()).toMatchObject({ status: "RUNNING", report: "Reading the ticket", reportAt: "2026-10-15T10:05:00.000Z" });
    expect(report("2026-10-15T10:06:00.000Z", "NEEDS_YOU", "Which account?")).toBe(true);
    expect(report("2026-10-15T10:07:00.000Z", "HEARTBEAT")).toBe(false);
    expect(typed()).toMatchObject({ status: "WAITING", report: "Which account?" });
    expect(report("2026-10-15T10:20:00.000Z", "DONE", "No human reply.")).toBe(true);
    expect(report("2026-10-15T10:30:00.000Z", "FAILED")).toBe(false);
    expect(typed()).toMatchObject({ status: "SUCCEEDED", report: "No human reply." });
    // The next run of the same task gets no report at all: 6 h later it is NO_REPORT, never success.
    vi.setSystemTime(Date.parse("2026-10-15T12:00:20.000Z"));
    await runner.tick();
    expect(store.settleTaskRuns("2026-10-15T18:00:20.000Z")).toBe(0);
    expect(store.settleTaskRuns("2026-10-15T18:00:21.000Z")).toBe(1);
    const all = store.listTaskRuns(owner, { limit: 100, taskId: typedId });
    expect(all.runs.map((run) => run.status)).toEqual(["NO_REPORT", "SUCCEEDED"]);
    expect(all.counts).toMatchObject({ NO_REPORT: 1, SUCCEEDED: 1, RUNNING: 0, REMINDER: 0 });
    // Paged by id, newest first.
    const first = store.listTaskRuns(owner, { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(store.listTaskRuns(owner, { limit: 100, before: first.runs[1]!.id }).runs.every((run) => Number(run.id) < Number(first.runs[1]!.id))).toBe(true);
  });

  it("records a typing failure past its interval as a FAILED run with the error", async () => {
    const { store, runner, answer, add } = fixture();
    answer.mockRejectedValue(new Error("socket closed"));
    add("Check the ticket.", every2h);
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(store.listTaskRuns(owner, { limit: 100 }).runs).toEqual([]);
    vi.setSystemTime(Date.parse("2026-10-15T12:00:01.000Z"));
    await runner.tick();
    expect(store.listTaskRuns(owner, { limit: 100 }).runs.map(({ status, typed, detail }) => ({ status, typed, detail }))).toEqual([
      { status: "FAILED", typed: false, detail: "Failed 2026-10-15T10:00:00.000Z: the task could not be typed into the CLI (socket closed)." }]);
  });

  it("saving a task again keeps its pending run, and the prompt fits one CLI line", () => {
    const { add } = fixture();
    const first = add("Check the ticket.", every2h);
    vi.setSystemTime(start + 30 * 60_000);
    expect(add("Check the ticket.", undefined).schedule?.nextRunAt).toBe(first.schedule?.nextRunAt);
    const long = add(`Line one\n${"x".repeat(3000)}`, every2h);
    const prompt = scheduledTaskPrompt(long);
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(prompt).not.toMatch(/\n/);
    expect(prompt).toContain(`Space task ${long.id}`);
    // The rest is never lost (31/10): the prompt ends with the command that prints the whole task.
    expect(prompt.endsWith(`… (the whole task: node /opt/spaceapp/scripts/space-task.mjs show ${long.id})`)).toBe(true);
  });
});
