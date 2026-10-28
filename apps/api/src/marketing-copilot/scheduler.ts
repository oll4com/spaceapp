import type { MarketingPost, Pane, Room } from "@space/contracts";
import type { MarketingCopilotService } from "./service.js";

export interface MarketingCopilotSchedulerDeps {
  service: Pick<MarketingCopilotService, "duePosts" | "settingsOf" | "proposeReleaseCampaign">;
  /** The running SpaceApp version: a version nobody announced yet proposes its release campaign. */
  version?: string;
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string): Promise<Pane[]> | Pane[] };
  /** Whether the pane's CLI agent is running (a run's kickoff is typed into it). */
  hasAgent(pane: Pane): Promise<boolean>;
  /** Whether the pane's CLI sits at an empty prompt (no draft, no usage limit); without it a running agent counts as ready. */
  ready?(pane: Pane): Promise<boolean>;
  /** Whether a run is active (RUNNING or PAUSED) in the pane. */
  hasActiveRun(pane: Pane): Promise<boolean>;
  /** Starts a run and types its kickoff into the pane's CLI. */
  startRun(owner: string, pane: Pane): Promise<void>;
  /** Tells the operator that posts are due but nothing can publish them (no CLI agent running in the pane). */
  notifyDue(owner: string, room: Room, pane: Pane, due: MarketingPost[]): Promise<void>;
  log: { warn(obj: Record<string, unknown>, message: string): void };
  intervalMs?: number;
  firstDelayMs?: number;
}

// Once a minute, like the Mail Copilot: 27/10 four Reddit replies approved in the rail at 11:53 UTC (no schedule) waited 3 hours.
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Approved posts whose time has come (an approved post without a schedule at once) get published without the operator pressing
 * Start: for every open Marketing Copilot pane that is not paused and has no active run, due posts start a run once the pane's CLI
 * is at an empty prompt (its kickoff goes there; a busy CLI waits for a later tick). A RUNNING run whose agent left its loop is
 * kicked by copilot-run-kick, which counts the same due posts. A pane without a running CLI agent raises one notification instead.
 * Single-flight: a slow tick is never overlapped.
 */
export function createMarketingCopilotScheduler(deps: MarketingCopilotSchedulerDeps) {
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  let running = false;
  async function tick(): Promise<{ started: number; notified: number }> {
    if (running) return { started: 0, notified: 0 };
    running = true;
    let started = 0;
    let notified = 0;
    try {
      for (const room of await deps.store.listRooms()) {
        if (!room.ownerUserId) continue;
        for (const pane of (await deps.store.listPanes(room.id)).filter((candidate) => candidate.mode === "MARKETING_COPILOT" && !candidate.isClosed)) {
          try {
            if (deps.version) await deps.service.proposeReleaseCampaign(room.ownerUserId, pane, deps.version);
            if (deps.service.settingsOf(pane).paused || await deps.hasActiveRun(pane)) continue;
            const due = await deps.service.duePosts(room.ownerUserId, pane);
            if (!due.length) continue;
            if (!(await deps.hasAgent(pane))) {
              await deps.notifyDue(room.ownerUserId, room, pane, due);
              notified += 1;
            } else if (!deps.ready || await deps.ready(pane)) {
              await deps.startRun(room.ownerUserId, pane);
              started += 1;
            }
          } catch (error) {
            deps.log.warn({ err: error, paneId: pane.id }, "Marketing Copilot scheduler could not handle a pane");
          }
        }
      }
    } finally {
      running = false;
    }
    return { started, notified };
  }
  return {
    tick,
    start() {
      first = setTimeout(() => void tick().catch((error) => deps.log.warn({ err: error }, "Marketing Copilot scheduler tick failed")), deps.firstDelayMs ?? 60_000);
      first.unref();
      timer = setInterval(() => void tick().catch((error) => deps.log.warn({ err: error }, "Marketing Copilot scheduler tick failed")), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
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
