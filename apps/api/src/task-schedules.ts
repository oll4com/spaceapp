import type { FastifyInstance } from "fastify";
import { describeDotScheduleRecurrence, DOT_SCHEDULE_GRACE_MS, nextDotScheduleRun, type Pane, type TaskItem } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { isCliPane } from "./pane-guards.js";
import { atEmptyPrompt } from "./room-agent-autopilot.js";
import type { RoomPaneObservation } from "./room-pane-control.js";

/**
 * Scheduled tasks (operator request 2026-10-15): when a task in the Tasks dock falls due, Space types it into its
 * CLI pane (a terminal, or the CLI of a copilot, Design or App Studio pane), only at an empty prompt so a draft is
 * never sent. A busy pane, or one whose CLI is not running, waits up to the task's interval (twelve hours at most),
 * then the occurrence is skipped. A task without a pane is a reminder: its time only advances.
 * An occurrence is typed, then advanced with a compare-and-set on its due time (one API process runs the job).
 */
export interface TaskScheduleRunnerDeps {
  store: Pick<SpaceStore, "dueTaskSchedules" | "claimTaskSchedule" | "getPane" | "getRoom">;
  inspect(pane: Pane): Promise<RoomPaneObservation>;
  answer(pane: Pane, input: { expectedSessionId: string; answer: string; submit: boolean; expectedPromptFingerprint: string }): Promise<unknown>;
  now?: () => number;
}

// cli_command answers are single-line text of at most 2000 characters.
const MAX_PROMPT_CHARS = 2000;

export function scheduledTaskPrompt(task: TaskItem): string {
  const when = describeDotScheduleRecurrence(task.schedule!.recurrence, task.schedule!.timeZone);
  const text = `Scheduled task “${task.title}” (${when}, Space task ${task.id}): ${task.objective}`.replace(/\s+/g, " ").trim();
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS - 1)}…` : text;
}

export function createTaskScheduleRunner(deps: TaskScheduleRunnerDeps) {
  const now = () => deps.now?.() ?? Date.now();

  async function runOccurrence(task: TaskItem & { ownerUserId: string }): Promise<"RAN" | "REMINDED" | "WAITING" | "SKIPPED" | "LOST"> {
    const schedule = task.schedule!;
    const dueAt = schedule.nextRunAt!;
    const recurrence = schedule.recurrence;
    const following = () => {
      if (recurrence.kind === "ONCE") return null;
      const next = nextDotScheduleRun(recurrence, schedule.timeZone, Math.max(now(), Date.parse(dueAt)));
      return next === null ? null : new Date(next).toISOString();
    };
    const advance = (outcome: string, ran: boolean) => deps.store.claimTaskSchedule(task.id, dueAt, { nextRunAt: following(), outcome, ran });
    const at = new Date(now()).toISOString();

    const pane = task.paneId ? await Promise.resolve().then(() => deps.store.getPane(task.paneId!)).catch(() => null) : null;
    if (!pane) return await advance(`Reminder due at ${dueAt}.`, false) ? "REMINDED" : "LOST";
    if (!isCliPane(pane)) return await advance(`Skipped ${dueAt}: the task's pane is not a CLI.`, false) ? "SKIPPED" : "LOST";
    // Only the task owner's own panes are typed into, whichever path wrote the task.
    const room = await Promise.resolve().then(() => deps.store.getRoom(pane.roomId)).catch(() => null);
    if (room?.ownerUserId !== task.ownerUserId) return await advance(`Skipped ${dueAt}: the pane is not in one of your rooms.`, false) ? "SKIPPED" : "LOST";

    const graceMs = Math.min(DOT_SCHEDULE_GRACE_MS, recurrence.kind === "INTERVAL" ? recurrence.minutes * 60_000 : DOT_SCHEDULE_GRACE_MS);
    const waitOrSkip = async (reason: string) => now() - Date.parse(dueAt) < graceMs ? "WAITING" as const
      : await advance(`Skipped ${dueAt}: ${reason}.`, false) ? "SKIPPED" as const : "LOST" as const;
    const observed = await deps.inspect(pane).catch(() => null);
    if (observed && (!observed.sessionId || observed.state === "EXITED" || observed.state === "ERROR")) return waitOrSkip("the pane has no running CLI");
    if (!observed || !atEmptyPrompt(observed)) return waitOrSkip("the CLI was busy or had a draft at its prompt");
    try {
      await deps.answer(pane, { expectedSessionId: observed.sessionId, answer: scheduledTaskPrompt(task), submit: true, expectedPromptFingerprint: observed.promptFingerprint });
    } catch (error) {
      return waitOrSkip(`the task could not be typed into the CLI (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"})`);
    }
    return await advance(`Sent to the CLI at ${at}.`, true) ? "RAN" : "LOST";
  }

  // Inspecting panes can outlast the tick interval; an overlapping tick would type the same occurrence twice.
  let running = false;
  async function tick(limit = 20): Promise<Record<string, number>> {
    const counts: Record<string, number> = { RAN: 0, REMINDED: 0, WAITING: 0, SKIPPED: 0, LOST: 0 };
    if (running) return counts;
    running = true;
    try {
      for (const task of await deps.store.dueTaskSchedules(new Date(now()).toISOString(), limit)) {
        counts[await runOccurrence(task)]! += 1;
      }
    } finally {
      running = false;
    }
    return counts;
  }

  return { tick };
}

/** Runs the scheduler every 30 seconds while the API is up (instance job `task-schedules`). */
export function startTaskSchedules(app: FastifyInstance, deps: TaskScheduleRunnerDeps): void {
  const runner = createTaskScheduleRunner(deps);
  let timer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    timer = setInterval(() => void runner.tick().catch((error) => app.log.warn({ err: error }, "Task schedule tick failed.")), 30_000);
    timer.unref();
  });
  app.addHook("onClose", async () => { if (timer) clearInterval(timer); });
}
