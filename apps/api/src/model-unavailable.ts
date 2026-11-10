import type { Pane } from "@space/contracts";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/**
 * R11-5 (was R10-21 b, c; 29/10 01:56 UTC: Alex/Finn's OpenCode footer read `claude-sonnet-5-5 (unavailable)`, its 07:05 BKK task never
 * typed, nothing reached the gateway and Nous learned it only by reading the pane): a CLI whose footer marks its model unavailable is not
 * ready (`atEmptyPrompt`), the pane board says so, and Nous gets ONE inbox line per outage naming the panes (gathered for 2 minutes).
 */
export const MODEL_UNAVAILABLE_GATHER_MS = 2 * 60_000;

/** The model a CLI's footer marks unavailable (OpenCode: "claude-sonnet-5-5 (unavailable)"), from the screen's last lines; null otherwise. */
export function cliModelUnavailable(text: string): string | null {
  const tail = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(-8).join("\n");
  return /([\w.:/@-]{3,80})\s+\(unavailable\)/i.exec(tail)?.[1] ?? null;
}

interface UnavailablePane { owner: string; roomId: string; paneName: string; model: string; since: number }
const panes = new Map<string, UnavailablePane>();
const outages = new Map<string, { since: number; timer: ReturnType<typeof setTimeout> | null; announced: boolean }>();
const listeners = new Set<(owner: string, line: string) => void>();

/** Nous's inbox line for an outage: the panes whose model went unavailable, and the fix. */
export function onModelUnavailable(listener: (owner: string, line: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The pane's model, when its CLI last showed it unavailable; null when it works (or Space never saw it). */
export function modelUnavailable(paneId: string): { model: string; since: number } | null {
  const entry = panes.get(paneId);
  return entry ? { model: entry.model, since: entry.since } : null;
}

const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);
function announce(owner: string) {
  const outage = outages.get(owner);
  if (!outage || outage.announced) return;
  outage.timer = null;
  const list = [...panes.values()].filter((entry) => entry.owner === owner);
  if (!list.length) { outages.delete(owner); return; }
  outage.announced = true;
  const line = `Model unavailable (gateway) since ${hhmm(outage.since)} UTC on ${list.map((entry) => `${entry.paneName} (${entry.model})`).join(", ")}: their tasks and kickoffs `
    + `wait. Check Space Gateway (space_ops_gateway); for OpenCode panes re-add the provider with node ${SPACE_INSTALL_ROOT}/scripts/space-admin-action.mjs opencode-claude-provider-enable.`;
  for (const listener of listeners) { try { listener(owner, line); } catch { /* the line is best effort */ } }
}

/** What a scheduler or kick saw on the pane's screen: an unavailable model starts (or joins) the owner's outage; a working one leaves it. */
export function noteModelState(owner: string, pane: Pick<Pane, "id" | "roomId" | "paneName" | "title">, text: string | null | undefined, now = Date.now()): string | null {
  const model = text ? cliModelUnavailable(text) : null;
  if (model && !panes.has(pane.id)) {
    panes.set(pane.id, { owner, roomId: pane.roomId, paneName: pane.paneName ?? pane.title, model, since: now });
    if (!outages.has(owner)) {
      const outage = { since: now, timer: setTimeout(() => announce(owner), MODEL_UNAVAILABLE_GATHER_MS), announced: false };
      outage.timer.unref?.();
      outages.set(owner, outage);
    }
  } else if (!model && text && panes.delete(pane.id) && ![...panes.values()].some((entry) => entry.owner === owner)) {
    const outage = outages.get(owner);
    if (outage?.timer) clearTimeout(outage.timer);
    outages.delete(owner);
  }
  return model;
}

/** Tests: forget every pane and outage. */
export function resetModelUnavailable() {
  for (const outage of outages.values()) if (outage.timer) clearTimeout(outage.timer);
  panes.clear();
  outages.clear();
}

/** Tests: announce the owner's outage now instead of after the gathering window. */
export const announceModelUnavailableNow = announce;
