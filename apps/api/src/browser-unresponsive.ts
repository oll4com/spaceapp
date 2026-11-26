import type { Pane, Room } from "@space/contracts";
import { makeSpaceId, type SpaceStore } from "@space/runtime";
import { browserProfileLabel } from "./browser-census-routes.js";
import { vaultFencedTargets } from "./vault/fence-hooks.js";

type Store = Pick<SpaceStore, "getPane" | "getRoom" | "getActiveBrowserHandoffRequest">;
type Note = (room: Room, pane: Pane, status: "NEEDS_DECISION", summary: string) => Promise<unknown>;
interface Details { paneId?: unknown; sessionId?: unknown; profilePath?: unknown; otherPanes?: unknown; why?: unknown }
type Relaunch = (paneIds: string[]) => Promise<unknown>;

/** The relaunch app.ts wires: the panes still open go through their room owner's route stop+start (PaneBrowserAccountControl.relaunch); a failure is logged. */
export function paneBrowserRelaunch(deps: {
  store: Pick<SpaceStore, "getPane">; roomOwner(roomId: string): Promise<string | null>; log(details: object, message: string): void;
  accounts: { current: { relaunch(userId: string, panes: Pane[], traceId: string, actor: null): Promise<number> } | null };
}): Relaunch {
  return async (paneIds) => {
    try {
      const panes = (await Promise.all(paneIds.map((id) => Promise.resolve(deps.store.getPane(id)).catch(() => null)))).filter((pane): pane is Pane => Boolean(pane && !pane.isClosed));
      const owner = panes[0] && await deps.roomOwner(panes[0].roomId);
      if (!owner || !deps.accounts.current) return;
      const restarted = await deps.accounts.current.relaunch(owner, panes, makeSpaceId("trace"), null);
      deps.log({ event: "browser.unresponsive.relaunched", paneIds: panes.map((pane) => pane.id), restarted }, "relaunched an unresponsive pane Chrome");
    } catch (error) {
      deps.log({ err: error, paneIds }, "unresponsive pane Chrome relaunch failed");
    }
  };
}

/** The pane's Chrome answers getActive (the host's probe, browser-sessions.ts `answering`), or it and its other panes are relaunched; true when relaunched. */
export async function relaunchIfUnresponsive(manager: { getActive(pane: Pane): Promise<unknown> }, pane: Pane, relaunch: Relaunch): Promise<boolean> {
  try {
    await manager.getActive(pane);
    return false;
  } catch (error) {
    const failed = error as { errorCode?: unknown; code?: unknown; details?: Details } | null;
    if ((failed?.errorCode ?? failed?.code) !== "BROWSER_UNRESPONSIVE") return false;
    await relaunch([pane.id, ...(Array.isArray(failed?.details?.otherPanes) ? failed.details.otherPanes.map(String) : [])]);
    return true;
  }
}

/** A report asking for its Chrome to be relaunched, or saying it hangs ("needs decision: relaunch Chrome", "the browser is unresponsive"). */
export const ASKS_BROWSER_RELAUNCH = /\b(?:re-?launch|restart|reopen)\w*\s+(?:(?:the|its|my|pane|copilot)\s+){0,2}(?:chrome|browser)\b|\b(?:chrome|browser)\b[^.;\n]{0,60}?(?<!(?:\bnot|n't|\bnever|\bno longer)\s+(?:\w+\s+)?)\b(?:hung|hangs|hanging|frozen|freezes|stuck|unresponsive|not (?:answering|responding)|times? out|timed out)\b/i;
/** DEV3D-026: "do not restart the browser" is no ask, even beside a hang ("Chrome hung on the form, don't relaunch the browser"). */
const CANNOT = /\b(?:can(?:no|')t|can not|could(?:n't| not)|(?:was|were|am|is|are)(?:n't| not) able to)\s+/gi;
const REFUSES_BROWSER_RELAUNCH = /(?:\bnot|n't|\bnever|\bno need to)\s+(?:\w+\s+){0,2}(?:re-?launch|restart|reopen)\w*\s+(?:(?:the|its|my|pane|copilot)\s+){0,2}(?:chrome|browser)\b/i;

/**
 * Operator 21/11 18:05 BKK (Job Copilot Andy reported "needs decision: relaunch Chrome" at 13:51 and 17:44 and nobody acted for 4 h): a
 * copilot's own needs-decision or blocked report asking for that relaunches the pane's Chrome at once, unless a handoff or a Vault fill
 * is open on it; Space's own reports (source AUTO) have their probe-timed relaunch (`withUnresponsiveReport`). True when relaunched.
 * shortcut: unsaved form data on a hung Chrome cannot be read, so it is not checked; a copilot asks for the relaunch only when its page is stuck.
 */
export async function relaunchOnReport(deps: { store: Pick<SpaceStore, "getActivePaneBrowserSession" | "getActiveBrowserHandoffRequest" | "listActivePaneBrowserSessions">; relaunch: Relaunch },
  report: { source: string; status: string; paneId: string; summary: string; needs?: string | null }): Promise<boolean> {
  if (report.source !== "AGENT" || (report.status !== "NEEDS_DECISION" && report.status !== "BLOCKED")) return false;
  const text = [report.summary, report.needs].filter(Boolean).join("\n");
  // DEV3D-043: "I can't restart Chrome" is why it asks, not a refusal.
  if (!ASKS_BROWSER_RELAUNCH.test(text) || REFUSES_BROWSER_RELAUNCH.test(text.replace(CANNOT, ""))) return false;
  const session = await deps.store.getActivePaneBrowserSession(report.paneId);
  if (!session) return false;
  // DEV3D-004: a shared Chrome closes only when its last pane leaves (browser-sessions.ts closeProfile), so every pane on its profile is relaunched.
  const sessions = [session, ...(await deps.store.listActivePaneBrowserSessions()).filter((other) => other.profilePath === session.profilePath && other.paneId !== report.paneId)];
  for (const each of sessions) {
    if (await deps.store.getActiveBrowserHandoffRequest(each.sessionId) || (await vaultFencedTargets(deps.store, each.paneId)).length > 0) return false;
  }
  await deps.relaunch(sessions.map((each) => each.paneId));
  return true;
}

/**
 * BROWSER_UNRESPONSIVE (the host's `answering` probe, browser-sessions.ts) goes to Nous as one needs-decision pane report per episode,
 * never an operator card (goal 7365014c). Operator 20/11 (nous_msg:b8e674c1, a Job Copilot's Chrome hung 1 h 40 on a careers page): a
 * Chrome still not answering `relaunchAfterMs` later is relaunched in every case, an open handoff, sign-in or Vault fill included, through
 * the route change's stop+start (`relaunch`, PaneBrowserAccountControl.relaunch). An episode ends with the pane's next call that succeeds.
 */
export function withUnresponsiveReport<T extends { getActive(pane: Pane): Promise<unknown> }>(manager: T, deps: {
  store: Store; note: () => Note | undefined; warn?: (error: unknown) => void; relaunch?: Relaunch; relaunchAfterMs?: number;
}): T {
  const reported = new Set<string>();
  const relaunching = new Set<string>();
  // About 30 s: the host's background probe had its chance to clear a Chrome that was only slow; the recheck's own probe decides.
  const recheck = (paneId: string) => setTimeout(() => {
    if (relaunching.has(paneId) || !deps.relaunch) return;
    relaunching.add(paneId);
    // A relaunched Chrome starts a new episode: if it hangs again it is reported and relaunched again.
    void Promise.resolve(deps.store.getPane(paneId)).then((pane) => relaunchIfUnresponsive(manager, pane, deps.relaunch!))
      .then((relaunched) => { if (relaunched) reported.delete(paneId); })
      .catch((error: unknown) => deps.warn?.(error)).finally(() => relaunching.delete(paneId));
  }, deps.relaunchAfterMs ?? 30_000).unref?.();
  const paneOf = (target: unknown) => typeof target === "string" ? target
    : (target as { id?: unknown; pane?: { id?: unknown } } | null)?.id ?? (target as { pane?: { id?: unknown } } | null)?.pane?.id;
  const report = async (details: Details) => {
    const paneId = String(details.paneId);
    const pane = await deps.store.getPane(paneId);
    const name = async (id: string) => { const other = await Promise.resolve(deps.store.getPane(id)).catch(() => null); return other ? `${other.paneName ?? other.title} (${id})` : id; };
    const others = await Promise.all((Array.isArray(details.otherPanes) ? details.otherPanes : []).map((id) => name(String(id))));
    const handoff = typeof details.sessionId === "string" && Boolean(await deps.store.getActiveBrowserHandoffRequest(details.sessionId));
    const fenced = (await vaultFencedTargets(deps.store, paneId)).length > 0;
    const note = deps.note();
    if (!note) return;
    await note(await deps.store.getRoom(pane.roomId), pane, "NEEDS_DECISION",
      `Chrome of pane ${pane.paneName ?? pane.title} (${paneId}) ${String(details.why ?? "is not answering")}; profile ${browserProfileLabel(String(details.profilePath ?? ""))}`
      + `; other panes on it: ${others.join(", ") || "none"}; handoff ${handoff ? "OPEN" : "none"}; Vault fence ${fenced ? "OPEN" : "none"}`
      + ". Space relaunches it and its other panes on the same page, network route and tabs if it still does not answer in about 30 s; an open handoff is asked again on the new tab.");
  };
  return new Proxy(manager, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.then((answer: unknown) => {
          const paneId = paneOf(args[0]);
          if (typeof paneId === "string") reported.delete(paneId);
          return answer;
        }, (error: unknown) => {
          const failed = error as { errorCode?: unknown; code?: unknown; details?: Details } | null;
          const details = failed?.details;
          const paneId = details?.paneId;
          if ((failed?.errorCode ?? failed?.code) === "BROWSER_UNRESPONSIVE" && details && typeof paneId === "string" && !reported.has(paneId)) {
            reported.add(paneId);
            void report(details).catch((reportError: unknown) => { reported.delete(paneId); deps.warn?.(reportError); });
            recheck(paneId);
          }
          throw error;
        });
      };
    }
  });
}
