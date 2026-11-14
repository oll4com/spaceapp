import { noteModelState } from "./model-unavailable.js";
import type { FastifyInstance } from "fastify";
import { describeDotScheduleRecurrence, DOT_SCHEDULE_GRACE_MS, nextDotScheduleRun, type Pane, type TaskItem } from "@space/contracts";
import { makeSpaceId, SpaceNotFoundError, type SpaceStore, type TaskScheduleClaim } from "@space/runtime";
import { isCliPane } from "./pane-guards.js";
import { atEmptyPrompt } from "./room-agent-autopilot.js";
import { spaceTypedDraft } from "./cli-prompt-submit.js";
import { roomComposerHolds } from "./room-terminal-screen.js";
import type { RoomPaneObservation } from "./room-pane-control.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/**
 * Scheduled tasks (operator request 2026-10-15): when a task in the Tasks dock falls due, Space types it into its
 * CLI pane (a terminal, or the CLI of a copilot, Design or App Studio pane), only at an empty prompt so a draft is
 * never sent. A busy pane, or one whose CLI is not running, waits up to the task's interval (twelve hours at most),
 * then the occurrence is skipped and Nous hears it. A task without a pane is a reminder: its time only advances.
 * An occurrence is typed, then advanced with a compare-and-set on its due time (one API process runs the job).
 */
export interface TaskScheduleRunnerDeps {
  store: Pick<SpaceStore, "dueTaskSchedules" | "claimTaskSchedule" | "getPane" | "getRoom"> & Partial<Pick<SpaceStore, "settleTaskRuns" | "pruneTaskRuns" | "bindTaskItem" | "listTaskRuns" | "listPanes" | "listRooms">>;
  inspect(pane: Pane): Promise<RoomPaneObservation>;
  /** requestId (OBS-006): the id the typing is traced and logged under; a task's own is kept on its run. */
  answer(pane: Pane, input: { expectedSessionId: string; answer: string; submit: boolean; expectedPromptFingerprint: string }, requestId?: string): Promise<unknown>;
  /** Reopens the task's closed CLI pane, or starts the CLI of an open one that has none, as its owner (Space Control: a terminal resumes its conversation, a copilot-style pane starts its CLI). */
  reopen?(pane: Pane, ownerUserId: string): Promise<unknown>;
  /** R44-3: opens a new CLI pane in the owner's room for a recurring agent task that has no pane there (Space Control panes.open). */
  openPane?(roomId: string, ownerUserId: string): Promise<Pane>;
  /** Marketing and Freelance Copilots take their work as briefs (as Nous's sends to them): a due task reaches them as one. */
  brief?(pane: Pane, ownerUserId: string, text: string): Promise<unknown>;
  /** One line to Nous's inbox when an occurrence stays untyped on an idle pane (TASK_RETRY_MS), with the cause. */
  notice?(ownerUserId: string, key: string, line: string): Promise<void>;
  now?: () => number;
}

// Technical: a cli_command answer holds at most 2000 characters (the contract the pane hosts loaded at start).
const MAX_PROMPT_CHARS = 2000;

/** The prompt typed for a due task; a longer objective is never lost: the prompt names the command that prints it whole. */
export function scheduledTaskPrompt(task: TaskItem): string {
  const when = describeDotScheduleRecurrence(task.schedule!.recurrence, task.schedule!.timeZone);
  const text = `Scheduled task “${task.title}” (${when}, Space task ${task.id}): ${task.objective}`.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_PROMPT_CHARS) return text;
  const rest = ` … (the whole task: node ${SPACE_INSTALL_ROOT}/scripts/space-task.mjs show ${task.id})`;
  return `${text.slice(0, MAX_PROMPT_CHARS - rest.length)}${rest}`;
}

/**
 * The tokens Claude Code's own idle hint names on its empty prompt ("new task? /clear to save 312.4k tokens": shown after 75 idle
 * minutes with 100k or more in context), else null.
 */
export function claudeClearHintTokens(screen: string): number | null {
  const hint = [...screen.matchAll(/new task\? \/clear to save ([\d.]+)([kM]?) tokens/g)].at(-1);
  return hint ? Math.round(Number(hint[1]) * (hint[2] === "M" ? 1e6 : hint[2] === "k" ? 1e3 : 1)) : null;
}
/** A scheduled task is new work: an idle Claude pane re-reading this much of an older task gets /clear first (plan clipboard:ctqx7SPqkWR2 step 1). */
export const TASK_CLEAR_CONTEXT_TOKENS = 150_000;
/** Tasks due together (the 09:00 burst) are typed this far apart, so each new conversation lands where Space Gateway sees room (plan clipboard:ctqx7SPqkWR2 step 4). */
export const TASK_STAGGER_MS = 60_000;
/** Goal 35813e48 ("never leave for tomorrow what can be done now"): each 10 minutes a task stays untyped past due on an idle pane is a miss; Nous hears the second. */
export const TASK_RETRY_MS = 10 * 60_000;
/** R58 (goal 35813e48): every copilot that takes briefs (Nous's own list, tools.ts) gets its task as one: its CLI sits in its run loop, never at an empty prompt. */
const BRIEF_MODES = new Set<Pane["mode"]>(["MARKETING_COPILOT", "FREELANCE_COPILOT", "DESIGN", "APP_STUDIO", "VIDEO", "SECURITY_COPILOT", "MONITORING_COPILOT"]);
/** 11-12/11 (Score daily tasks): one pane call that did not answer held every later due task of the tick; each occurrence gets this long, then the tick goes on. */
export const TASK_OCCURRENCE_TIMEOUT_MS = 60_000;

export function createTaskScheduleRunner(deps: TaskScheduleRunnerDeps) {
  const now = () => deps.now?.() ?? Date.now();
  /** Misses of each occurrence (task|due time) untyped on an idle pane, and when the last one was counted. */
  const misses = new Map<string, { count: number; at: number }>();
  /** Task prompts the scheduler sent by pressing Enter on a composer that still held them, and when: their own occurrence then counts as sent. */
  const draftsSubmitted = new Map<string, number>();
  /** Occurrences (task|due time) that already sent /clear, so a hint that stays never clears twice. */
  const cleared = new Set<string>();
  /** Occurrences whose typing threw: the next try waits TASK_STAGGER_MS, then twice as long each time, at most TASK_RETRY_MS. */
  const typingFailed = new Map<string, { count: number; at: number; reason: string }>();
  /** Occurrences whose open pane had no running CLI, and when Space last started it there (once each TASK_RETRY_MS). */
  const started = new Map<string, number>();
  let lastTypedAt = Number.NEGATIVE_INFINITY;
  /** R44-3: occurrences that opened a pane (never a second one) and tasks Nous heard have no pane (one line each). */
  const opened = new Set<string>();
  const toldNoPane = new Set<string>();
  /** When this process first tried each occurrence (task|due time). */
  const firstTried = new Map<string, number>();

  async function runOccurrence(task: TaskItem & { ownerUserId: string }): Promise<"RAN" | "REMINDED" | "WAITING" | "SKIPPED" | "LOST"> {
    const schedule = task.schedule!;
    const dueAt = schedule.nextRunAt!;
    const recurrence = schedule.recurrence;
    const following = () => {
      if (recurrence.kind === "ONCE") return null;
      const next = nextDotScheduleRun(recurrence, schedule.timeZone, Math.max(now(), Date.parse(dueAt)));
      return next === null ? null : new Date(next).toISOString();
    };
    const at = new Date(now()).toISOString();
    // Each handled occurrence is one task run (plan clipboard:GA__W4qBxSPR); RUNNING: typed, its pane's report decides it.
    const advance = (outcome: string, status: TaskScheduleClaim["status"], nextRunAt = following()) => deps.store.claimTaskSchedule(task.id, dueAt, { nextRunAt, outcome, status, at });

    const graceMs = Math.min(DOT_SCHEDULE_GRACE_MS, recurrence.kind === "INTERVAL" ? recurrence.minutes * 60_000 : DOT_SCHEDULE_GRACE_MS);
    // 13/11 (Score lever Daily tasks): a daily or weekly run that missed its 12 h window was dropped; it now still runs late, until its next occurrence is due.
    const nextDue = recurrence.kind === "DAILY" || recurrence.kind === "WEEKLY" ? nextDotScheduleRun(recurrence, schedule.timeZone, Date.parse(dueAt)) : null;
    const windowEnd = nextDue ?? Date.parse(dueAt) + graceMs;
    const occurrence = `${task.id}|${dueAt}`;
    if (!firstTried.has(occurrence)) { if (firstTried.size > 1_000) firstTried.clear(); firstTried.set(occurrence, now()); }
    // A reopen or typing that threw is a failed run; a busy, draft or stopped pane is a skipped one. 11-12/11 (Mail 3/3, X 13:40): a run first tried
    // past its window (Space was down all of it) was skipped in that same tick, right after its CLI was started; it now gets TASK_RETRY_MS of tries.
    const waitOrSkip = async (reason: string, status: "SKIPPED" | "FAILED" = "SKIPPED", atOnce = false) => {
      if (!atOnce && (now() < windowEnd || now() - firstTried.get(occurrence)! < TASK_RETRY_MS)) return "WAITING" as const;
      // The skip hands over to the latest occurrence already due (never past it), which gets its own window.
      let latest = nextDue;
      while (latest !== null) { const after = nextDotScheduleRun(recurrence, schedule.timeZone, latest); if (after === null || after > now()) break; latest = after; }
      const nextRunAt = latest !== null && latest <= now() ? new Date(latest).toISOString() : following();
      if (!await advance(`${status === "FAILED" ? "Failed" : "Skipped"} ${dueAt}: ${reason}.`, status, nextRunAt)) return "LOST" as const;
      // A missed run is never silent: Nous hears it with its cause.
      await deps.notice?.(task.ownerUserId, `task-missed:${task.id}`, `Scheduled task "${task.title}" (${task.id}) missed ${dueAt}: ${reason}.`).catch(() => undefined);
      return "SKIPPED" as const;
    };

    // 12/11 Temu (XCTF): the database timed out after the reboot and that failed read FAILED the run as "pane no longer exists" while the pane
    // was fine; only a missing row is gone, any other read error waits and retries each tick like a busy pane.
    const read = <T>(load: () => T | PromiseLike<T>) => Promise.resolve().then(load).catch((error: unknown) =>
      error instanceof SpaceNotFoundError || (error as Error | null)?.name === "SpaceNotFoundError" ? null : Promise.reject(error));
    const unread = (what: string, error: unknown) => waitOrSkip(`Space could not read its ${what} (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"})`, "FAILED");
    let pane: Pane | null;
    try { pane = task.paneId ? await read(() => deps.store.getPane(task.paneId!)) : null; } catch (error) { return unread("pane", error); }
    // R44-3 (3/11: TOP IMPORTS watch, 5 weekly Monday tasks, the Reddit task and the Nous daily upgrade round had no pane, and each run was a silent
    // reminder): a recurring agent task whose pane is gone, or that has none, gets a new CLI pane in its room (or the room it last ran in), bound to it.
    if (!pane && task.source === "AGENT" && recurrence.kind !== "ONCE" && deps.openPane && deps.store.bindTaskItem) {
      const lastRun = task.roomId ? null : await Promise.resolve().then(() => deps.store.listTaskRuns?.(task.ownerUserId, { taskId: task.id, limit: 1 })).catch(() => null);
      const roomId = task.roomId ?? lastRun?.runs[0]?.roomId ?? null;
      let room: Awaited<ReturnType<typeof deps.store.getRoom>> | null;
      try { room = roomId ? await read(() => deps.store.getRoom(roomId)) : null; } catch (error) { return unread("room", error); }
      if (room?.ownerUserId === task.ownerUserId && !opened.has(occurrence)) {
        if (opened.size > 1_000) opened.clear();
        opened.add(occurrence);
        try {
          const fresh = await deps.openPane(room.id, task.ownerUserId);
          // The task itself moves (by id, as space_task_update bind): saving its objective again hit a stale hash and bound an unscheduled copy (Grants 13/11).
          await deps.store.bindTaskItem(task.ownerUserId, task.id, { roomId: room.id, paneId: fresh.id, paneTitle: fresh.paneName ?? fresh.title });
        } catch (error) { return waitOrSkip(`its pane is gone and a new CLI pane could not be opened in its room (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"})`, "FAILED"); }
        return waitOrSkip("its pane was gone; a new CLI pane was opened in its room and its CLI did not reach its prompt");
      }
      if (!room && !toldNoPane.has(task.id) && deps.notice) {
        if (toldNoPane.size > 1_000) toldNoPane.clear();
        toldNoPane.add(task.id);
        await deps.notice(task.ownerUserId, `task-no-pane:${task.id}`, `task ${task.id} has no pane: scheduled task "${task.title}" (${describeDotScheduleRecurrence(recurrence, schedule.timeZone)}) `
          + "is an agent's work, but Space knows no pane or room for it, so each run only reminds. Bind it to a CLI pane (space_task_update bind), or bind null if it is a reminder.").catch(() => undefined);
      }
    }
    if (!pane && task.paneId) {
      // 13/11 (Score lever Daily tasks): a run on a gone pane was a silent FAILED row; Nous hears each one and can rebind it.
      await deps.notice?.(task.ownerUserId, `task-no-pane:${task.id}`, `Scheduled task "${task.title}" (${task.id}) missed ${dueAt}: its pane ${task.paneId} no longer exists `
        + "and Space opened no new one for it. Bind it to an open CLI pane (space_task_update bind).").catch(() => undefined);
      return await advance(`Failed ${dueAt}: the task's pane no longer exists; rebind the task to an open pane.`, "FAILED") ? "SKIPPED" : "LOST";
    }
    if (!pane) return await advance(`Reminder due at ${dueAt}.`, "REMINDER") ? "REMINDED" : "LOST";
    if (!isCliPane(pane)) return await advance(`Skipped ${dueAt}: the task's pane is not a CLI.`, "SKIPPED") ? "SKIPPED" : "LOST";
    // Only the task owner's own panes are typed into (or reopened), whichever path wrote the task.
    let room: Awaited<ReturnType<typeof deps.store.getRoom>> | null;
    try { room = await read(() => deps.store.getRoom(pane.roomId)); } catch (error) { return unread("room", error); }
    if (room?.ownerUserId !== task.ownerUserId) return await advance(`Skipped ${dueAt}: the pane is not in one of your rooms.`, "SKIPPED") ? "SKIPPED" : "LOST";
    const prompt = scheduledTaskPrompt(task);
    // 13/11 Felix (task:A-mtm2jQGUyE): a closed pane in a full room never reopens (Space Control answers "capped" in its receipt, nothing throws), and the
    // task retried each tick until its next day with nothing on its record. It moves to an idle CLI pane of the same runtime in that room, else to a new
    // pane in another of the owner's rooms with space; with neither, its run is FAILED at once with the cause and Nous hears it.
    if (pane.isClosed && deps.reopen && deps.store.listPanes && typeof room.paneCap === "number") {
      const listOpen = (roomId: string) => Promise.resolve(deps.store.listPanes!(roomId, false));
      let openPanes: Pane[];
      try { openPanes = await listOpen(room.id); } catch (error) { return unread("room's panes", error); }
      if (openPanes.length >= room.paneCap) {
        const full = `its pane ${pane.paneName ?? pane.title} is closed and its room ${room.name ?? room.id} is full (${openPanes.length}/${room.paneCap} panes)`;
        let to: Pane | null = null;
        if (pane.mode === "TERMINAL" && deps.store.bindTaskItem) {
          for (const other of openPanes) {
            if (other.mode !== "TERMINAL" || other.terminalRuntimeId !== pane.terminalRuntimeId) continue;
            const seen = await deps.inspect(other).catch(() => null);
            if (seen && atEmptyPrompt(seen)) { to = other; break; }
          }
          if (!to && deps.openPane && deps.store.listRooms && !opened.has(occurrence)) {
            if (opened.size > 1_000) opened.clear();
            opened.add(occurrence);
            for (const other of await Promise.resolve(deps.store.listRooms(task.ownerUserId)).catch(() => [])) {
              if (other.id === room.id || other.kind !== "WORKSPACE" || other.archivedAt || other.ownerUserId !== task.ownerUserId) continue;
              if (((await listOpen(other.id).catch(() => null))?.length ?? other.paneCap) >= other.paneCap) continue;
              to = await deps.openPane(other.id, task.ownerUserId).catch(() => null);
              if (to) break;
            }
          }
        }
        if (!to) return waitOrSkip(`${full}, and no idle ${pane.terminalRuntimeId ?? "CLI"} pane there or room with space could take it; close a pane there or rebind the task`, "FAILED", true);
        try { await deps.store.bindTaskItem!(task.ownerUserId, task.id, { roomId: to.roomId, paneId: to.id, paneTitle: to.paneName ?? to.title }); }
        catch (error) { return waitOrSkip(`${full}, and moving the task to pane ${to.id} failed (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"})`, "FAILED"); }
        const moved = `${full}; the task moved to pane ${to.paneName ?? to.title} (${to.id}) in room ${to.roomId}`;
        await deps.notice?.(task.ownerUserId, `task-moved:${task.id}`, `Scheduled task "${task.title}" (${task.id}) due ${dueAt}: ${moved}.`).catch(() => undefined);
        return waitOrSkip(moved);
      }
    }
    // 11-12/11 (Score daily tasks, ~18 of 20 missed days): after the host move and the reboot the bound panes stayed open with no CLI until someone
    // opened their room, and the tasks only waited out their grace. Space starts or resumes the pane's CLI as it reopens a closed pane, once each TASK_RETRY_MS.
    const bound = pane; // a closure loses the narrowing of `let pane`
    const startCli = async (what: string, until: string) => {
      const last = started.get(occurrence);
      if (!deps.reopen || (last !== undefined && now() - last < TASK_RETRY_MS)) return waitOrSkip(`${what} has no running CLI`);
      if (started.size > 1_000) started.clear();
      started.set(occurrence, now());
      try { await deps.reopen(bound, task.ownerUserId); }
      catch (error) { return waitOrSkip(`${what} had no running CLI and Space could not start it (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"})`, "FAILED"); }
      return waitOrSkip(`${what} had no running CLI; Space started it and it did not ${until}`);
    };
    if (BRIEF_MODES.has(pane.mode) && deps.brief) {
      // A brief counts as run only once a running CLI can take it (13/11: a brief recorded beside a stopped CLI counted as ran): a closed or
      // stopped copilot is started first (as Nous's sends do, R36-a), and briefed on a later tick once its CLI runs.
      const live = pane.isClosed ? null : await deps.inspect(pane).catch(() => null);
      if (pane.isClosed || (live && (!live.sessionId || live.state === "EXITED" || live.state === "ERROR"))) return startCli("its copilot", "run yet to take the brief");
      try { await deps.brief(pane, task.ownerUserId, prompt); }
      catch (error) { return waitOrSkip(`the brief could not be given to its copilot (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"})`, "FAILED"); }
      return await advance(`Briefed its copilot at ${at}.`, "RUNNING") ? "RAN" : "LOST";
    }

    // Nous closes finished task panes (operator order 2026-10-24): the task reopens its pane and types once the CLI is at its prompt.
    if (pane.isClosed) {
      if (!deps.reopen) return await advance(`Skipped ${dueAt}: its pane is closed; rebind the task to an open pane.`, "SKIPPED") ? "SKIPPED" : "LOST";
      try { await deps.reopen(pane, task.ownerUserId); }
      catch (error) { return waitOrSkip(`its closed pane could not be reopened (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"})`, "FAILED"); }
      return waitOrSkip("its pane was reopened and its CLI did not reach its prompt");
    }
    // The stagger only spaces typings out, it never costs an occurrence (12/11 post-reboot burst: KEQ0 skipped at its grace end, a missed day in the Score).
    if (now() - lastTypedAt < TASK_STAGGER_MS) return "WAITING" as const;
    // 7/11 Bruno/Kate: a reopened OpenCode pane failed the typing on every 30 s tick (25 room watchdog alerts in 15 minutes).
    const failed = typingFailed.get(occurrence);
    if (failed && now() - failed.at < Math.min(TASK_RETRY_MS, TASK_STAGGER_MS * 2 ** (failed.count - 1))) return waitOrSkip(failed.reason, "FAILED");
    const observed = await deps.inspect(pane).catch(() => null);
    if (observed && (!observed.sessionId || observed.state === "EXITED" || observed.state === "ERROR")) return startCli("the pane", "reach its prompt");
    // R11-5: a model the CLI's footer marks unavailable holds the task like a busy pane, and Nous hears it once per outage.
    if (observed && noteModelState(task.ownerUserId, pane, observed.text)) return waitOrSkip("the pane's model is unavailable (gateway or provider)");
    // An idle pane that still has not taken the task TASK_RETRY_MS after it fell due: one miss each TASK_RETRY_MS (each tick tries again), Nous hears the second with its cause.
    const notTyped = async (reason: string, status: "SKIPPED" | "FAILED" = "SKIPPED") => {
      const last = misses.get(occurrence);
      if (observed?.state === "IDLE" && now() - Date.parse(dueAt) >= TASK_RETRY_MS && (!last || now() - last.at >= TASK_RETRY_MS)) {
        if (misses.size > 1_000) misses.clear();
        misses.set(occurrence, { count: (last?.count ?? 0) + 1, at: now() });
        if (last?.count === 1) await deps.notice?.(task.ownerUserId, `task-waits:${task.id}`, `Scheduled task "${task.title}" (${task.id}, due ${dueAt}) is still untyped `
          + `${Math.round((now() - Date.parse(dueAt)) / 60_000)} minutes later on idle pane ${pane.paneName ?? pane.title}, retried each tick: ${reason}. Read the pane (space_read_pane); `
          + "clear a draft (space_clear_pane_draft) or restart the pane (space_restart_pane) so the task can type.").catch(() => undefined);
      }
      return waitOrSkip(reason, status);
    };
    // The prompt this occurrence left in a composer went with the Enter Space pressed there (below): the task was sent.
    const draftAt = draftsSubmitted.get(prompt);
    if (observed && draftAt !== undefined && draftAt >= Date.parse(dueAt) && !roomComposerHolds(observed.text ?? "", prompt)) {
      draftsSubmitted.delete(prompt);
      lastTypedAt = now();
      return await advance(`Sent to the CLI at ${new Date(draftAt).toISOString()}: its text had stayed in the composer, and Space pressed Enter.`, "RUNNING") ? "RAN" : "LOST";
    }
    if (!observed || !atEmptyPrompt(observed)) {
      // 3/11 Bruno/Paul: a text Space typed stayed in the idle composer (its Enter lost while Claude Code compacted) and held every later task: Enter sends it.
      const held = observed?.state === "IDLE" && observed.sessionId && observed.promptFingerprint ? spaceTypedDraft(observed.sessionId, observed.text ?? "") : null;
      if (held) {
        const pressed = await deps.answer(pane, { expectedSessionId: observed!.sessionId!, answer: "", submit: true, expectedPromptFingerprint: observed!.promptFingerprint! })
          .then(() => true, () => false);
        if (pressed) { if (draftsSubmitted.size > 1_000) draftsSubmitted.clear(); draftsSubmitted.set(held, now()); }
        return notTyped(`its composer held a text Space had typed (${held === prompt ? "this task" : "another prompt"}); Space ${pressed ? "pressed Enter on it" : "could not press Enter on it"}`);
      }
      return notTyped(observed?.state === "IDLE" ? "its prompt reads as holding a draft Space did not type (the operator's, or typed before an API restart)"
        : "the CLI was busy or had a draft at its prompt");
    }
    if ((claudeClearHintTokens(observed.text ?? "") ?? 0) >= TASK_CLEAR_CONTEXT_TOKENS && !cleared.has(occurrence)) {
      if (cleared.size > 1_000) cleared.clear();
      cleared.add(occurrence);
      // The task is typed on the next tick, at the cleared prompt; a /clear that could not be typed leaves the task to go now.
      const sent = await deps.answer(pane, { expectedSessionId: observed.sessionId, answer: "/clear", submit: true, expectedPromptFingerprint: observed.promptFingerprint }).then(() => true, () => false);
      if (sent) return "WAITING";
    }
    // OBS-006: a typed task starts no native turn to carry an id; its run names the request that typed it.
    const requestId = makeSpaceId("task_run");
    try {
      await deps.answer(pane, { expectedSessionId: observed.sessionId, answer: prompt, submit: true, expectedPromptFingerprint: observed.promptFingerprint }, requestId);
    } catch (error) {
      const reason = `the task could not be typed into the CLI (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"})`;
      if (typingFailed.size > 1_000) typingFailed.clear();
      typingFailed.set(occurrence, { count: (failed?.count ?? 0) + 1, at: now(), reason });
      return notTyped(reason, "FAILED");
    }
    typingFailed.delete(occurrence);
    lastTypedAt = now();
    return await advance(`Sent to the CLI at ${at} (request ${requestId}).`, "RUNNING") ? "RAN" : "LOST";
  }

  // Inspecting panes can outlast the tick interval; an overlapping tick would type the same occurrence twice.
  let running = false;
  let pruned = 0;
  /** Tasks whose occurrence outlasted TASK_OCCURRENCE_TIMEOUT_MS and still runs: never tried twice at once. */
  const inFlight = new Set<string>();
  async function tick(): Promise<Record<string, number>> {
    const counts: Record<string, number> = { RAN: 0, REMINDED: 0, WAITING: 0, SKIPPED: 0, LOST: 0 };
    if (running) return counts;
    running = true;
    try {
      // Every due task (R58: until 4/11 the oldest 20, and tasks waiting on busy panes kept those slots, so a later due task was never tried).
      for (const task of await deps.store.dueTaskSchedules(new Date(now()).toISOString())) {
        if (inFlight.has(task.id)) { counts.WAITING! += 1; continue; }
        inFlight.add(task.id);
        const run = runOccurrence(task).finally(() => inFlight.delete(task.id));
        run.catch(() => undefined); // an error after the timeout has no tick left to fail; one before it fails the tick as before
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<"WAITING">((resolve) => { timer = setTimeout(() => resolve("WAITING"), TASK_OCCURRENCE_TIMEOUT_MS); });
        try { counts[await Promise.race([run, late])]! += 1; } finally { clearTimeout(timer); }
      }
      await deps.store.settleTaskRuns?.(new Date(now()).toISOString());
      // Task runs keep each owner's history period only (history.periodDays); once an hour is enough.
      if (now() - pruned >= 3_600_000) { pruned = now(); await deps.store.pruneTaskRuns?.(new Date(now()).toISOString()); }
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
