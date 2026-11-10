import { createHash } from "node:crypto";
import { roomComposerNotReady } from "../room-terminal-screen.js";

/**
 * R35-1 (2/11 01:50-05:40 BKK: Alex/Emma's Claude Code froze on "Moonwalking… 7 1s"; its transcript said the turn had finished, so the world
 * read her idle, and Nous's two texts of 03:16 and 03:55 BKK waited 3.7 hours as after-turn prompts, held because roomComposerNotReady read the
 * frozen spinner as "its CLI is working"). A CLI pane whose screen and recorded CLI state have not changed for NOUS_STUCK_MS while it shows a
 * spinner, or while a text has waited that long for it, is stuck.
 */
export const NOUS_STUCK_MS = 30 * 60_000;
/** One screen read per CLI pane every 5 minutes, at once when its CLI state changes (a restart clears it within a minute). */
export const NOUS_STUCK_SAMPLE_MS = 5 * 60_000;

export interface StuckPane { owner: string; paneId: string; label: string; since: string; line: string }
export interface StuckSample {
  owner: string; paneId: string; label: string; screen: string;
  /** shortcut: the CLI's recorded state (status, since, session) stands in for its transcript, which only the CLI's user reads. */
  state: string;
  /** The oldest text waiting for the pane (requests-waiting.ts queuedTexts). */
  queuedAt: string | null;
  /** A question, a permission prompt or a usage limit: the pane waits on purpose, never stuck. */
  waiting?: boolean;
}

export function createStuckPanes() {
  const seen = new Map<string, { state: string; key: string; since: number; at: number; stuck: StuckPane | null }>();
  return {
    due: (paneId: string, state: string, now: number) => { const entry = seen.get(paneId); return !entry || entry.state !== state || now - entry.at >= NOUS_STUCK_SAMPLE_MS; },
    observe(input: StuckSample, now: number): StuckPane | null {
      const key = createHash("sha256").update(`${input.state}\u0000${input.screen}`).digest("hex");
      const last = seen.get(input.paneId);
      const since = last?.key === key ? last.since : now;
      const queued = input.queuedAt && now - Date.parse(input.queuedAt) >= NOUS_STUCK_MS ? input.queuedAt : null;
      const spinner = roomComposerNotReady(input.screen) === "its CLI is working";
      const stuck = !input.waiting && now - since >= NOUS_STUCK_MS && (spinner || queued) ? {
        owner: input.owner, paneId: input.paneId, label: input.label, since: new Date(since).toISOString(),
        line: `STUCK: screen and CLI state unchanged ${Math.round((now - since) / 60_000)} min (since ${new Date(since).toISOString().slice(11, 16)} UTC)`
          + `${spinner ? ", a spinner that does not move (Space holds texts for it while it shows)" : ""}${queued ? `, a text queued for it since ${queued.slice(11, 16)} UTC never typed` : ""}`
          + " → read it (space_read_pane), restart it (space_restart_pane) and send its work again",
      } : null;
      seen.set(input.paneId, { state: input.state, key, since, at: now, stuck });
      return stuck;
    },
    get: (paneId: string) => seen.get(paneId)?.stuck ?? null,
    list: (owner: string) => [...seen.values()].flatMap((entry) => entry.stuck?.owner === owner ? [entry.stuck] : []),
    /** Drops panes that closed or left the live rooms. */
    retain(paneIds: ReadonlySet<string>) { for (const paneId of seen.keys()) if (!paneIds.has(paneId)) seen.delete(paneId); },
  };
}
export type StuckPanes = ReturnType<typeof createStuckPanes>;
