import type { Pane, Room } from "@space/contracts";
import { atEmptyPrompt } from "./room-agent-autopilot.js";
import { noteModelState } from "./model-unavailable.js";
import type { RoomPaneObservation } from "./room-pane-control.js";

const TICK_MS = 60_000;
const REKICK_MS = 10 * 60_000;
/** A run started for a target (runView `start`) that found nothing to take is started again at most hourly. */
const RESTART_MS = 60 * 60_000;
/** cA9, 7-12/11: a run waited 5 days behind a busy CLI and nobody heard. A kick or start that waits this long is reported once. */
export const COPILOT_KICK_WAIT_NOTICE_MS = 30 * 60_000;
/** Why a wanted kick or start was not typed into the pane. */
export type CopilotKickWait = "NO_CLI" | "MODEL_UNAVAILABLE" | "WAITS_ON_OPERATOR" | "CLI_BUSY";

/**
 * A copilot run stays RUNNING when its agent ends its turn without finishing the loop, and the 5-minute scheduler starts runs
 * only when none is active (27/10: two Freelance briefs stayed PENDING for hours while the CLI idled). Every minute, an
 * unpaused pane of `mode` whose run is RUNNING with work waiting (a brief first of all) and whose CLI sits at an empty prompt
 * (no draft, no usage limit) gets the run's kickoff typed again: at once for new work, else at most every 10 minutes.
 * A pane runView asks to `start` (Job Copilot behind its daily target, operator 13/11) gets a new run the same way, again at most hourly.
 * A pane with an open ask to the operator (`holds`) is never typed into; a wait of 30 minutes is logged and reported (`waited`) once.
 */
export function createCopilotRunKick<R extends { id: string; status: string }>(deps: {
  mode: Pane["mode"];
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string): Promise<Pane[]> | Pane[] };
  paused(pane: Pane): boolean;
  runView(owner: string, pane: Pane): Promise<{ run: R | null; backlog: number; start?: boolean }>;
  inspect(pane: Pane): Promise<RoomPaneObservation>;
  kickoff(pane: Pane, run: R): Promise<void>;
  /** Starts a run on a pane runView asked to start and types its kickoff. */
  start?(owner: string, pane: Pane): Promise<void>;
  /** The pane waits on the operator (an open needs-you of a side task): nothing is typed into it. */
  holds?(owner: string, pane: Pane): Promise<boolean>;
  /** A kick or start has waited COPILOT_KICK_WAIT_NOTICE_MS, once per wait. */
  waited?(owner: string, pane: Pane, reason: CopilotKickWait): Promise<void>;
  log: { warn(details: unknown, message: string): void };
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const last = new Map<string, { key: string; at: number }>();
  // A pane's current wait: between applications the CLI is busy for a minute or two, so only a long wait is logged and reported.
  const waits = new Map<string, { reason: CopilotKickWait; since: number; told: boolean }>();
  async function wait(owner: string, pane: Pane, reason: CopilotKickWait) {
    const entry = waits.get(pane.id) ?? { reason, since: now(), told: false };
    entry.reason = reason;
    waits.set(pane.id, entry);
    if (entry.told || now() - entry.since < COPILOT_KICK_WAIT_NOTICE_MS) return;
    entry.told = true;
    deps.log.warn({ paneId: pane.id, reason, since: new Date(entry.since).toISOString() }, "Copilot run kick has waited 30 minutes");
    await deps.waited?.(owner, pane, reason);
  }
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let kicked = 0;
    try {
      for (const room of await deps.store.listRooms()) {
        if (!room.ownerUserId) continue;
        for (const pane of (await deps.store.listPanes(room.id)).filter((candidate) => candidate.mode === deps.mode && !candidate.isClosed && !deps.paused(candidate))) {
          try {
            const { run, backlog, start } = await deps.runView(room.ownerUserId, pane);
            const starting = Boolean(start && deps.start) && run?.status !== "RUNNING";
            if (!starting && (run?.status !== "RUNNING" || !backlog)) { waits.delete(pane.id); continue; }
            const key = starting ? "start" : `${run!.id}:${backlog}`;
            const before = last.get(pane.id);
            if (before && now() - before.at < (before.key !== key ? TICK_MS : starting ? RESTART_MS : REKICK_MS)) continue;
            if (await deps.holds?.(room.ownerUserId, pane)) { await wait(room.ownerUserId, pane, "WAITS_ON_OPERATOR"); continue; }
            const observed = await deps.inspect(pane);
            // R11-5: an unavailable model holds the kick, and Nous hears it once per outage.
            const unavailable = noteModelState(room.ownerUserId, pane, observed.text) || observed.usageLimited;
            if (unavailable || !atEmptyPrompt(observed)) {
              await wait(room.ownerUserId, pane, unavailable ? "MODEL_UNAVAILABLE" : !observed.sessionId || observed.state === "EXITED" || observed.state === "ERROR" ? "NO_CLI" : "CLI_BUSY");
              continue;
            }
            waits.delete(pane.id);
            last.set(pane.id, { key, at: now() });
            if (starting) await deps.start!(room.ownerUserId, pane); else await deps.kickoff(pane, run!);
            kicked += 1;
          } catch (error) {
            deps.log.warn({ err: error, paneId: pane.id }, "Copilot run kick failed");
          }
        }
      }
    } finally {
      running = false;
    }
    return kicked;
  }
  return {
    tick,
    start() {
      timer = setInterval(() => void tick().catch((error) => deps.log.warn({ err: error }, "Copilot run kick tick failed")), TICK_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
