import { ownerWorkingTimeZone } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

/**
 * The owner's working time zone (Settings → Date & time) and their local time now, as one line for an agent's turn
 * context (plan clipboard:ubQLgcTtQWA_): agents write times to the operator in their zone, never in UTC or Athens time.
 */
export async function ownerClockLine(store: Pick<SpaceStore, "getUserSettings">, owner: string, now = new Date()): Promise<string> {
  const timeZone = ownerWorkingTimeZone(await store.getUserSettings(owner));
  const local = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(now);
  return `The operator's working time zone is ${timeZone}; their local time now is ${local}. Write every time to them in this zone.`;
}
