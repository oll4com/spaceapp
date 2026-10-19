/**
 * Rooms Nous muted for a while (operator-approved 2026-10-17): their FINISHED and WAITING monitor events do not wake Nous,
 * so an operator's test room does not spend its turns. Notifications, STUCK, ERROR, OVERLAP and the operator still wake it.
 * shortcut: mutes live in memory, so an API restart unmutes every room (fail-open); persist them if restarts become frequent.
 */
export interface NousMute { reason: string; until: string }

export const NOUS_MUTE_MAX_HOURS = 24;
const QUIET_KINDS = new Set(["FINISHED", "WAITING"]);

export function createNousMutes(now: () => number = Date.now) {
  const byOwner = new Map<string, Map<string, NousMute>>();
  const live = (owner: string) => {
    const rooms = byOwner.get(owner) ?? new Map<string, NousMute>();
    for (const [roomId, mute] of rooms) if (Date.parse(mute.until) <= now()) rooms.delete(roomId);
    byOwner.set(owner, rooms);
    return rooms;
  };
  return {
    mute(owner: string, roomId: string, reason: string, hours: number): NousMute {
      const mute = { reason, until: new Date(now() + Math.min(hours, NOUS_MUTE_MAX_HOURS) * 3_600_000).toISOString() };
      live(owner).set(roomId, mute);
      return mute;
    },
    unmute(owner: string, roomId: string): boolean {
      return live(owner).delete(roomId);
    },
    list(owner: string): Array<[string, NousMute]> {
      return [...live(owner)];
    },
    /** Whether a monitor event of this kind in this room stays out of Nous's inbox. */
    silences(owner: string, roomId: string, kind: string): boolean {
      return QUIET_KINDS.has(kind) && live(owner).has(roomId);
    }
  };
}

export type NousMutes = ReturnType<typeof createNousMutes>;
