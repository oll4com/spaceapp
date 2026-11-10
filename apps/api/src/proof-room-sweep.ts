import type { Pane, Room } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { DashboardActivityDetail } from "./agents-dashboard.js";

export const PROOF_ROOM_SWEEP_MS = 10 * 60_000;
export const PROOF_ROOM_EMPTY_IDLE_MS = 30 * 60_000;
export const PROOF_ROOM_PANES_IDLE_MS = 6 * 3_600_000;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * Agent Proof rooms nobody uses any more (operator 2/11 10:04 BKK): no open pane and no change for 30 minutes, or open
 * panes none of which worked or moved for 6 hours. Only AGENT_PROOF rooms; every other kind is never looked at.
 */
export async function idleProofRooms(deps: {
  store: Pick<SpaceStore, "listRooms" | "listPanes">;
  readDetails: (roomId: string) => Promise<Record<string, DashboardActivityDetail>>;
  now?: number;
}): Promise<Room[]> {
  const now = deps.now ?? Date.now();
  const idle: Room[] = [];
  for (const room of await deps.store.listRooms()) {
    if (room.kind !== "AGENT_PROOF") continue;
    const panes: Pane[] = await deps.store.listPanes(room.id, true);
    const open = panes.filter((pane) => !pane.isClosed);
    const changed = Math.max(ms(room.updatedAt), ...panes.map((pane) => ms(pane.updatedAt)));
    if (open.length === 0) {
      if (now - changed >= PROOF_ROOM_EMPTY_IDLE_MS) idle.push(room);
      continue;
    }
    const details = await deps.readDetails(room.id);
    if (open.some((pane) => details[pane.id]?.status === "working")) continue;
    const moved = Math.max(changed, ...open.map((pane) => ms(details[pane.id]?.since)));
    if (now - moved >= PROOF_ROOM_PANES_IDLE_MS) idle.push(room);
  }
  return idle;
}
