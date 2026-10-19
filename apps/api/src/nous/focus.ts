import { z } from "zod";
import { eventSchema, nousFocusRequestPayloadSchema, type Pane, type Room } from "@space/contracts";
import { makeSpaceId, type SpaceEventBus } from "@space/runtime";
import { paneLabel } from "./digest.js";

/**
 * space_focus_pane (plan clipboard:twwygEtD4uuX): Nous brings the operator to a pane that needs them. The server only
 * publishes ids (NOUS_FOCUS_REQUESTED, never recorded or replayed); the operator's visible tab asks "Go now / Not now",
 * switches room as a click does, maximizes and focuses the pane, and takes them back when it stops waiting.
 */

export const FOCUS_PANE_MIN_INTERVAL_MS = 60_000;

export const focusPaneSchema = z.object({
  room: z.string().trim().min(1).max(200).describe("The room's name as shown in the world (or its id)."),
  pane: z.string().trim().min(1).max(160).describe("A pane's name in that room (Andy, Bob, ...)."),
  reason: z.string().trim().min(1).max(300).describe("Why the operator is needed there, in one line (for your own record; the banner names only room and pane).")
});

export const FOCUS_PANE_DESCRIPTION = "Bring the operator to a pane that needs their hands (a sign-in, CAPTCHA or browser handoff, a prompt only they "
  + "can answer): their screen offers Go now / Not now, then switches room, maximizes the pane and takes them back when it stops waiting. "
  + `At most once a minute; never for what you can answer yourself or for decisions (those go through space_ask_operator).`;

export type NousFocusEventBus = Pick<SpaceEventBus, "publish">;
/** A NousToolOutcome, declared here so focus.ts does not import tools.ts (no dependency cycle). */
export interface NousFocusOutcome { ok: boolean; display: string; result: string; refused?: boolean }

export function createNousFocus(deps: { eventBus: NousFocusEventBus; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const lastByOwner = new Map<string, number>();
  return {
    request(owner: string, room: Room, pane: Pane, reason: string): NousFocusOutcome {
      const label = paneLabel(pane);
      const last = lastByOwner.get(owner);
      if (last !== undefined && now() - last < FOCUS_PANE_MIN_INTERVAL_MS) {
        return { ok: false, refused: true, display: `Not bringing the operator to ${label} yet`,
          result: "You brought the operator to a pane less than a minute ago. Wait for them, or tell them in your answer." };
      }
      lastByOwner.set(owner, now());
      const payload = nousFocusRequestPayloadSchema.parse({ requestId: makeSpaceId("nous_focus"), ownerUserId: owner, roomId: room.id, paneId: pane.id });
      deps.eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: pane.id, turnId: null, workflowId: null,
        traceId: `nous-focus:${payload.requestId}`, type: "NOUS_FOCUS_REQUESTED", message: "Nous: a pane needs the operator", payload,
        createdAt: new Date(now()).toISOString() }));
      return { ok: true, display: `Brought the operator to ${label} in ${room.name}: ${reason.slice(0, 160)}`,
        result: `The operator's screen offers to take them to ${label} in ${room.name}. They may say Not now; do not repeat it within the minute.` };
    }
  };
}
export type NousFocus = ReturnType<typeof createNousFocus>;
