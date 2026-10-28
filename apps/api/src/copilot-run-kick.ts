import type { Pane, Room } from "@space/contracts";
import { atEmptyPrompt } from "./room-agent-autopilot.js";
import type { RoomPaneObservation } from "./room-pane-control.js";

const TICK_MS = 60_000;
const REKICK_MS = 10 * 60_000;

/**
 * A copilot run stays RUNNING when its agent ends its turn without finishing the loop, and the 5-minute scheduler starts runs
 * only when none is active (27/10: two Freelance briefs stayed PENDING for hours while the CLI idled). Every minute, an
 * unpaused pane of `mode` whose run is RUNNING with work waiting (a brief first of all) and whose CLI sits at an empty prompt
 * (no draft, no usage limit) gets the run's kickoff typed again: at once for new work, else at most every 10 minutes.
 */
export function createCopilotRunKick<R extends { id: string; status: string }>(deps: {
  mode: Pane["mode"];
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string): Promise<Pane[]> | Pane[] };
  paused(pane: Pane): boolean;
  runView(owner: string, pane: Pane): Promise<{ run: R | null; backlog: number }>;
  inspect(pane: Pane): Promise<RoomPaneObservation>;
  kickoff(pane: Pane, run: R): Promise<void>;
  log: { warn(details: unknown, message: string): void };
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const last = new Map<string, { key: string; at: number }>();
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
            const { run, backlog } = await deps.runView(room.ownerUserId, pane);
            if (run?.status !== "RUNNING" || !backlog) continue;
            const key = `${run.id}:${backlog}`;
            const before = last.get(pane.id);
            if (before && now() - before.at < (before.key === key ? REKICK_MS : TICK_MS)) continue;
            if (!atEmptyPrompt(await deps.inspect(pane))) continue;
            last.set(pane.id, { key, at: now() });
            await deps.kickoff(pane, run);
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
