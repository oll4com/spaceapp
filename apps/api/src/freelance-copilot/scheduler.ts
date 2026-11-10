import type { Pane, Room } from "@space/contracts";
import { createCopilotPaneReopen, type CopilotReopenDeps } from "../copilot-pane-reopen.js";
import type { FreelanceCopilotService } from "./service.js";

export interface FreelanceCopilotSchedulerDeps {
  service: Pick<FreelanceCopilotService, "settingsOf" | "pollMail" | "weeklyDigest" | "runView" | "followUpsDue" | "approvedDue">;
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string, includeClosed?: boolean): Promise<Pane[]> | Pane[] };
  /** Whether the pane's CLI agent is running (a run's kickoff is typed into it). */
  hasAgent(pane: Pane): Promise<boolean>;
  /** Whether a run is active (RUNNING or PAUSED) in the pane. */
  hasActiveRun(pane: Pane): Promise<boolean>;
  /** Starts a run and types its kickoff into the pane's CLI. */
  startRun(owner: string, pane: Pane): Promise<void>;
  /** Tells the operator that work is waiting but nothing can do it (no CLI agent running in the pane). */
  notifyBacklog(owner: string, room: Room, pane: Pane, backlog: number): Promise<void>;
  /** Reopens the owner's closed pane when follow-ups or approved messages are due and none is open (queue item 44). */
  reopen?: CopilotReopenDeps;
  log: { warn(obj: Record<string, unknown>, message: string): void };
  intervalMs?: number;
  firstDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Keeps the copilot working without the operator pressing Start: for every open Freelance Copilot pane that is not
 * paused, new mail in work@example.invalid becomes work items, the weekly digest is written, and when work is waiting
 * (briefs, mails, approved messages, due follow-ups) and no run is active a run starts in the pane's CLI. A pane
 * without a running CLI agent raises one notification instead. Single-flight: a slow tick is never overlapped.
 */
export function createFreelanceCopilotScheduler(deps: FreelanceCopilotSchedulerDeps) {
  const reopener = createCopilotPaneReopen(deps.reopen);
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  let running = false;
  async function tick(): Promise<{ started: number; notified: number; mails: number }> {
    if (running) return { started: 0, notified: 0, mails: 0 };
    running = true;
    let started = 0;
    let notified = 0;
    let mails = 0;
    try {
      const panes = reopener.collect();
      for (const room of await deps.store.listRooms()) {
        const owner = room.ownerUserId;
        if (!owner) continue;
        // Closed panes too: the store lists open ones by default, and item 44 reopens a closed one (28/10: Cleo/Bob was never seen).
        const freelance = (await deps.store.listPanes(room.id, true)).filter((candidate) => candidate.mode === "FREELANCE_COPILOT");
        for (const pane of freelance) panes.add(owner, room, pane);
        for (const pane of freelance.filter((candidate) => !candidate.isClosed)) {
          try {
            if (deps.service.settingsOf(pane).paused) continue;
            mails += await deps.service.pollMail(owner, pane).catch((error: unknown) => {
              deps.log.warn({ err: error, paneId: pane.id }, "Freelance Copilot could not read the mailbox");
              return 0;
            });
            await deps.service.weeklyDigest(owner, pane);
            if (await deps.hasActiveRun(pane)) continue;
            const { backlog } = await deps.service.runView(owner, pane);
            if (!backlog) continue;
            if (await deps.hasAgent(pane)) {
              await deps.startRun(owner, pane);
              started += 1;
            } else {
              await deps.notifyBacklog(owner, room, pane, backlog);
              notified += 1;
            }
          } catch (error) {
            deps.log.warn({ err: error, paneId: pane.id }, "Freelance Copilot scheduler could not handle a pane");
          }
        }
      }
      // Queue item 44: follow-ups or approved messages due and no open Freelance pane: the owner's newest closed one reopens.
      if (deps.reopen) for (const { owner, room, pane } of panes.candidates()) {
        try {
          if (deps.service.settingsOf(pane).paused) continue;
          const due = (await deps.service.followUpsDue(owner, pane)).length + (await deps.service.approvedDue(owner, pane)).length;
          if (!due) continue;
          const reopened = await reopener.reopen(owner, room, pane, `${due} follow-up${due === 1 ? " or approved message is" : "s or approved messages are"} due`);
          if (reopened === "FAILED") { await deps.notifyBacklog(owner, room, pane, due); notified += 1; }
        } catch (error) {
          deps.log.warn({ err: error, paneId: pane.id }, "Freelance Copilot scheduler could not reopen a pane");
        }
      }
    } finally {
      running = false;
    }
    return { started, notified, mails };
  }
  return {
    tick,
    start() {
      first = setTimeout(() => void tick().catch((error) => deps.log.warn({ err: error }, "Freelance Copilot scheduler tick failed")), deps.firstDelayMs ?? 60_000);
      first.unref();
      timer = setInterval(() => void tick().catch((error) => deps.log.warn({ err: error }, "Freelance Copilot scheduler tick failed")), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
    }
  };
}
