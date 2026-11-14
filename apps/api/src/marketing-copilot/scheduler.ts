import type { MarketingPost, Pane, Room } from "@space/contracts";
import { createCopilotPaneReopen, type CopilotReopenDeps } from "../copilot-pane-reopen.js";
import type { MarketingCopilotService } from "./service.js";

export interface MarketingCopilotSchedulerDeps {
  service: Pick<MarketingCopilotService, "duePosts" | "settingsOf" | "proposeReleaseCampaign" | "pendingBriefs" | "postsToMeasure">;
  /** The running SpaceApp version: a version nobody announced yet proposes its release campaign. */
  version?: string;
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string, includeClosed?: boolean): Promise<Pane[]> | Pane[] };
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
  /** Reopens the owner's closed pane when posts are due and none is open (queue item 44); without it a closed pane is left closed. */
  reopen?: CopilotReopenDeps;
  log: { warn(obj: Record<string, unknown>, message: string): void };
  intervalMs?: number;
  firstDelayMs?: number;
}

// Once a minute, like the Mail Copilot: 27/10 four Reddit replies approved in the rail at 11:53 UTC (no schedule) waited 3 hours.
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Approved posts whose time has come (an approved post without a schedule at once) get published without the operator pressing
 * Start: for every open Marketing Copilot pane that is not paused and has no active run, due posts start a run once the pane's CLI
 * is at an empty prompt (its kickoff goes there; a busy CLI waits for a later tick). Published posts due their 1-day or 7-day reading
 * start one run per owner when none is going (13/11: 7 posts stayed unmeasured; any run's space_marketing_next hands out every
 * owner's reading, so a second run would read the same post). A RUNNING run whose agent left its loop is
 * kicked by copilot-run-kick, which counts the same due posts. A pane without a running CLI agent raises one notification instead.
 * Single-flight: a slow tick is never overlapped.
 */
export function createMarketingCopilotScheduler(deps: MarketingCopilotSchedulerDeps) {
  const reopener = createCopilotPaneReopen(deps.reopen);
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  let running = false;
  async function tick(): Promise<{ started: number; notified: number }> {
    if (running) return { started: 0, notified: 0 };
    running = true;
    let started = 0;
    let notified = 0;
    try {
      const panes = reopener.collect();
      const listed: Array<{ room: Room; owner: string; open: Pane[] }> = [];
      for (const room of await deps.store.listRooms()) {
        if (!room.ownerUserId) continue;
        // Closed panes too: the store lists open ones by default, and item 44 reopens a closed one (28/10: Cleo/Bob was never seen).
        const marketing = (await deps.store.listPanes(room.id, true)).filter((candidate) => candidate.mode === "MARKETING_COPILOT");
        for (const pane of marketing) panes.add(room.ownerUserId, room, pane);
        listed.push({ room, owner: room.ownerUserId, open: marketing.filter((candidate) => !candidate.isClosed) });
      }
      const active = new Set<string>();
      const measuring = new Set<string>();
      for (const { owner, open } of listed) for (const pane of open) if (await deps.hasActiveRun(pane)) { active.add(pane.id); measuring.add(owner); }
      for (const { room, owner, open } of listed) {
        for (const pane of open) {
          try {
            if (deps.version) await deps.service.proposeReleaseCampaign(owner, pane, deps.version);
            if (deps.service.settingsOf(pane).paused || active.has(pane.id)) continue;
            const due = await deps.service.duePosts(owner, pane);
            const measure = !due.length && !measuring.has(owner) && (await deps.service.postsToMeasure(owner)).length > 0;
            // 31/10 (operator: idle panes with waiting briefs): a brief waiting after the agent ended its run starts one too, not only due posts.
            if (!due.length && !measure && !await deps.service.pendingBriefs(owner, pane)) continue;
            if (!(await deps.hasAgent(pane))) {
              if (!due.length) continue;
              await deps.notifyDue(owner, room, pane, due);
              notified += 1;
            } else if (!deps.ready || await deps.ready(pane)) {
              await deps.startRun(owner, pane);
              measuring.add(owner);
              started += 1;
            }
          } catch (error) {
            deps.log.warn({ err: error, paneId: pane.id }, "Marketing Copilot scheduler could not handle a pane");
          }
        }
      }
      // Queue item 44: due posts and no open Marketing pane: the owner's newest closed one reopens (its run starts on a later tick).
      if (deps.reopen) for (const { owner, room, pane } of panes.candidates()) {
        try {
          if (deps.service.settingsOf(pane).paused) continue;
          const due = await deps.service.duePosts(owner, pane);
          if (!due.length) continue;
          const reopened = await reopener.reopen(owner, room, pane, `${due.length} approved post${due.length === 1 ? " is" : "s are"} due`);
          if (reopened === "FAILED") { await deps.notifyDue(owner, room, pane, due); notified += 1; }
        } catch (error) {
          deps.log.warn({ err: error, paneId: pane.id }, "Marketing Copilot scheduler could not reopen a pane");
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
