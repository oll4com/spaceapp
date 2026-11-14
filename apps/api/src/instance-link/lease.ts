// Space Link's lease (ADR-014, plan clipboard:aGnuHjfZS8-o Λ5): one linked SpaceApp's Nous acts on this SpaceApp at a time, while this
// SpaceApp's own Nous holds its autonomous turns back; this SpaceApp's person takes it back at any moment. In memory: a restart ends every
// lease, the safe default.
// shortcut: a restart also gives back what the person took back; revoking the link (Settings > Account > Devices) stops it for good. Persist
// "taken back" when a person needs it to survive a restart.

import { resolvePaneByName } from "@space/contracts";

/** Technical: a link that has not acted for this long stops holding this SpaceApp's own Nous back; its next act takes the lease again. */
export const LINK_LEASE_IDLE_MS = 15 * 60_000;

export type LinkLease = { deviceId: string; name: string; since: string; at: number };
type State = { leases: Map<string, LinkLease>; takenBack: Map<string, string> };
const states = new WeakMap<object, State>();

/** The lease of the store's owners (Nous's wiring, the channel and the device routes share it through the store, as instanceLinksFor). */
export function linkLease(store: object, now: () => number = Date.now) {
  let state = states.get(store);
  if (!state) states.set(store, state = { leases: new Map(), takenBack: new Map() });
  const { leases, takenBack } = state;
  const holder = (owner: string): LinkLease | null => {
    const lease = leases.get(owner);
    if (lease && now() - lease.at >= LINK_LEASE_IDLE_MS) leases.delete(owner);
    return leases.get(owner) ?? null;
  };
  return {
    holder,
    takenBackAt: (owner: string) => takenBack.get(owner) ?? null,
    /** A link's act: null when it may go on (it holds the lease or takes it now), else why not. */
    claim(owner: string, deviceId: string, name: string): { code: string; message: string } | null {
      if (takenBack.has(owner)) return { code: "LINK_TAKEN_BACK", message: "This SpaceApp's person took management back: the link only reads until they give it back." };
      const held = holder(owner);
      if (held && held.deviceId !== deviceId) return { code: "LINK_LEASE_HELD", message: `${held.name} manages this SpaceApp now: reading still works.` };
      leases.set(owner, { deviceId, name, since: held?.since ?? new Date(now()).toISOString(), at: now() });
      return null;
    },
    release(owner: string, deviceId: string) { if (leases.get(owner)?.deviceId === deviceId) leases.delete(owner); },
    takeBack(owner: string) { leases.delete(owner); takenBack.set(owner, new Date(now()).toISOString()); },
    giveBack(owner: string) { takenBack.delete(owner); }
  };
}

type HeldPane = { id: string; roomId: string; paneName?: string | null; isClosed?: boolean };
/**
 * Per-pane "human wins" (Λ5): the pane, of those the operator in person is at, that a link's Space Control body reaches, or null. A body
 * reaches a pane that it names by id anywhere (targets, resource inputs, placements) or by name in a target, or whose room it targets by
 * runtime or state alone.
 */
export function heldPaneReached(body: unknown, held: readonly HeldPane[]): HeldPane | null {
  if (!held.length || !body || typeof body !== "object") return null;
  const { roomId, actions } = body as { roomId?: unknown; actions?: unknown };
  const targets = (Array.isArray(actions) ? actions : []).map((action) => (action as { target?: unknown } | null)?.target)
    .filter((target): target is { paneIds?: unknown; paneNames?: unknown } => !!target && typeof target === "object");
  const text = JSON.stringify(body);
  return held.find((pane) => text.includes(pane.id) || (pane.roomId === roomId && targets.some(({ paneIds, paneNames }) => Array.isArray(paneNames)
    ? paneNames.some((name) => typeof name === "string" && resolvePaneByName([pane], name) !== null) : !Array.isArray(paneIds)))) ?? null;
}
