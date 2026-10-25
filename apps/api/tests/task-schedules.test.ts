import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createTaskScheduleRunner, scheduledTaskPrompt } from "../src/task-schedules.js";

const owner = "user:owner";
const start = Date.parse("2026-10-15T08:00:00.000Z");
const cliPane = { id: "pane:cli", roomId: "room:mine", mode: "TERMINAL", title: "Claude" } as Pane;
const emptyPrompt = { state: "IDLE", sessionId: "cli_session:1", promptFingerprint: "a".repeat(16), text: "done.\n\n❯ \n" };

function fixture(screen: Record<string, unknown> = emptyPrompt) {
  const store = new InMemorySpaceStore();
  const answer = vi.fn(async () => ({}));
  const inspect = vi.fn(async () => screen as never);
  const panes: Record<string, Pane> = { [cliPane.id]: cliPane, "pane:chat": { ...cliPane, id: "pane:chat", mode: "CHAT" } as Pane,
    "pane:foreign": { ...cliPane, id: "pane:foreign", roomId: "room:theirs" } as Pane,
    "pane:job": { ...cliPane, id: "pane:job", mode: "JOB_APPLY", title: "Job Copilot 1" } as Pane };
  const runner = createTaskScheduleRunner({
    store: {
      dueTaskSchedules: (now, limit) => store.dueTaskSchedules(now, limit),
      claimTaskSchedule: (id, expected, update) => store.claimTaskSchedule(id, expected, update),
      getPane: async (id) => { if (!panes[id]) throw new Error("gone"); return panes[id]!; },
      getRoom: async (id) => ({ id, ownerUserId: id === "room:mine" ? owner : "user:other" }) as never
    },
    inspect, answer, now: () => Date.now()
  });
  const add = (objective: string, schedule: Parameters<InMemorySpaceStore["upsertTaskItem"]>[0]["schedule"], paneId: string | null = cliPane.id) =>
    store.upsertTaskItem({ ownerUserId: owner, title: "Hetzner watch", objective, status: "OPEN", source: "AGENT", paneId, schedule });
  return { store, runner, answer, inspect, add, get: (id: string) => store.getTaskItem(owner, id)! };
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
      submit: true, expectedPromptFingerprint: "a".repeat(16) });
    const after = get(task.id).schedule!;
    expect(after).toMatchObject({ nextRunAt: "2026-10-15T12:00:10.000Z", lastRunAt: "2026-10-15T10:00:10.000Z" });
    expect(after.lastOutcome).toMatch(/^Sent to the CLI/);
    expect(await runner.tick()).toMatchObject({ RAN: 0 });
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
    expect(get(task.id).schedule!.lastOutcome).toMatch(/busy or had a draft/);
  });

  it("retries a task the CLI refused within its grace period", async () => {
    const { runner, answer, add } = fixture();
    add("Check the ticket.", every2h);
    answer.mockRejectedValueOnce(new Error("prompt changed"));
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await runner.tick()).toMatchObject({ WAITING: 1 });
    expect(await runner.tick()).toMatchObject({ RAN: 1 });
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

  // Copilot tasks were skipped as "not a CLI" although the copilot's CLI runs (2026-10-19).
  it("types a due task into a copilot pane's CLI, and skips one whose CLI is not running", async () => {
    const running = fixture();
    running.add("Archive job emails.", every2h, "pane:job");
    vi.setSystemTime(Date.parse("2026-10-15T10:00:10.000Z"));
    expect(await running.runner.tick()).toMatchObject({ RAN: 1 });
    expect(running.answer).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:job", mode: "JOB_APPLY" }), expect.objectContaining({ submit: true }));

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
  });
});
