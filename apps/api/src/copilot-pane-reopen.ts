import type { Pane, Room } from "@space/contracts";

/**
 * Queue item 44 (operator rule 264b98c3: idle panes close and reopen when their work continues; 28/10 Cleo/Kate closed at 10:48 BKK
 * with an approved Reddit post due at 15:10 and nothing to reopen her): when an owner has work due for a copilot and no open pane of
 * its mode, the scheduler reopens the owner's newest closed pane of that mode through the task-schedules path (Space Control start:
 * the pane opens, its CLI starts; the next tick types the kickoff at its empty prompt). At most once per 10 minutes per pane; panes of
 * an archived room never; a pane the operator deleted is no longer listed. A refused reopen leaves the scheduler's own "due" card.
 */
export const COPILOT_REOPEN_GAP_MS = 10 * 60_000;

export interface CopilotReopenDeps {
  reopen(owner: string, pane: Pane): Promise<unknown>;
  /** One line to Nous's inbox, so it sees the reopen. */
  notice?(owner: string, key: string, line: string): Promise<unknown> | unknown;
  now?: () => number;
}

/** Collects one mode's panes per owner while a scheduler walks the rooms, then names the owners' closed pane to reopen. */
export function createCopilotPaneReopen(deps: CopilotReopenDeps | undefined) {
  const last = new Map<string, number>();
  const now = deps?.now ?? Date.now;
  return {
    /** Per owner: whether a pane of the mode is open, and the newest closed one of a live room. */
    collect() {
      const owners = new Map<string, { open: boolean; closed: { room: Room; pane: Pane } | null }>();
      return {
        add(owner: string, room: Room, pane: Pane) {
          const entry = owners.get(owner) ?? { open: false, closed: null };
          if (!pane.isClosed) entry.open = true;
          else if (!room.archivedAt && (!entry.closed || pane.updatedAt > entry.closed.pane.updatedAt)) entry.closed = { room, pane };
          owners.set(owner, entry);
        },
        /** The closed panes to consider: owners with no open pane of the mode. */
        candidates: () => [...owners].flatMap(([owner, entry]) => !entry.open && entry.closed ? [{ owner, ...entry.closed }] : [])
      };
    },
    /** Reopens the pane unless it was tried in the last 10 minutes; false when there is no reopen path or it was refused. */
    async reopen(owner: string, room: Room, pane: Pane, what: string): Promise<"REOPENED" | "WAIT" | "FAILED"> {
      if (!deps) return "FAILED";
      if (now() - (last.get(pane.id) ?? 0) < COPILOT_REOPEN_GAP_MS) return "WAIT";
      last.set(pane.id, now());
      try {
        await deps.reopen(owner, pane);
      } catch {
        return "FAILED";
      }
      await Promise.resolve(deps.notice?.(owner, `copilot-reopen:${pane.id}`, `Space reopened ${pane.paneName ?? pane.title} in room ${room.name} (it was closed): ${what}. `
        + "Its run starts at the CLI's empty prompt; close it again when that work is done.")).catch(() => undefined);
      return "REOPENED";
    }
  };
}
