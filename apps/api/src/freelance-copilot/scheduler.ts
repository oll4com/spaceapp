import type { Pane, Room } from "@space/contracts";
import type { FreelanceCopilotService } from "./service.js";

export interface FreelanceCopilotSchedulerDeps {
  service: Pick<FreelanceCopilotService, "settingsOf" | "pollMail" | "weeklyDigest" | "runView">;
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string): Promise<Pane[]> | Pane[] };
  /** Whether the pane's CLI agent is running (a run's kickoff is typed into it). */
  hasAgent(pane: Pane): Promise<boolean>;
  /** Whether a run is active (RUNNING or PAUSED) in the pane. */
  hasActiveRun(pane: Pane): Promise<boolean>;
  /** Starts a run and types its kickoff into the pane's CLI. */
  startRun(owner: string, pane: Pane): Promise<void>;
  /** Tells the operator that work is waiting but nothing can do it (no CLI agent running in the pane). */
  notifyBacklog(owner: string, room: Room, pane: Pane, backlog: number): Promise<void>;
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
      for (const room of await deps.store.listRooms()) {
        const owner = room.ownerUserId;
        if (!owner) continue;
        for (const pane of (await deps.store.listPanes(room.id)).filter((candidate) => candidate.mode === "FREELANCE_COPILOT" && !candidate.isClosed)) {
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
