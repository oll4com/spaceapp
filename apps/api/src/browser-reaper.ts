import { resolveFreelanceCopilotPaneMetadata, type Pane } from "@space/contracts";
import type { BrowserHostActorContext } from "@space/browser-host";
import { makeSpaceId, type SpaceStore } from "@space/runtime";
import { browserProfileLabel, type browserCensus } from "./browser-census-routes.js";

/**
 * Operator 5/11 14:47 BKK («κλείσε όσους browser δεν χρησιμοποιούνται»): a live pane browser with no agent or operator use for this long, and
 * nothing that keeps it, is closed by the reaper (its tabs stay in the pane's last session and come back on its next start) and costs Nous Score.
 */
export const BROWSER_IDLE_MS = 30 * 60_000;
export const BROWSER_REAP_MS = 5 * 60_000;
export const BROWSER_REAPED_ACTION = "browser.reaped";
/** A tab on a sign-in, SSO or verification page: someone may be signing in there. */
const SIGN_IN_PAGE = /\/(?:sign[-_]?in|log[-_]?in|login|oauth2?|sso|challenge|2fa|mfa|verify)\b|accounts\.google\.com/i;
/** Panes the operator browses in himself; every other pane browser (copilots) is an agent's. */
const OPERATOR_MODES = new Set(["BROWSER", "YOUTUBE"]);

type CensusRow = Awaited<ReturnType<typeof browserCensus>>["sessions"][number];
export type BrowserRow = Pick<CensusRow, "paneId" | "roomId" | "title" | "paneName" | "mode" | "paneClosed" | "profile" | "control" | "handoff" | "fencedTabs"
  | "agent" | "updatedAt" | "lastFrameAt" | "tabs">;
export interface UnusedBrowser { paneId: string; roomId: string; title: string; idleSince: string; why: string }
/** The operator's last input to or view of a pane browser (browser-control-activity's usedAt). */
type UsedAt = (paneId: string) => number | null;

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);
const nameOf = (row: BrowserRow) => row.paneName ? `${row.paneName} (${row.title ?? row.mode ?? "browser"})` : row.title ?? row.paneId;

/** When a live pane browser was last used: a page change, a frame, an agent's drive, or the operator's input or view. */
export function browserLastUse(row: BrowserRow, usedAt: UsedAt): number {
  return Math.max(at(row.updatedAt), at(row.lastFrameAt), at(row.agent?.drivenAt), usedAt(row.paneId) ?? 0);
}

/** What keeps a live browser open whatever its idle time, or null. */
export function browserKeptFor(row: BrowserRow, scheduled: Set<string>): string | null {
  if (row.control) return "a control lease";
  if (row.handoff) return "a handoff";
  if (row.fencedTabs > 0) return "a Vault fence";
  if (row.agent?.active) return "an agent driving it";
  if (scheduled.has(row.paneId)) return "a scheduled task";
  if (row.tabs.some((tab) => "url" in tab && tab.url && SIGN_IN_PAGE.test(tab.url))) return "a sign-in page";
  return null;
}

/** The live browsers nobody needs: a closed or missing pane, or BROWSER_IDLE_MS without use and nothing that keeps it. */
export function unusedBrowsers(rows: BrowserRow[], input: { now: number; usedAt: UsedAt; scheduled: Set<string> }): UnusedBrowser[] {
  return rows.flatMap((row): UnusedBrowser[] => {
    const base = { paneId: row.paneId, roomId: row.roomId, title: nameOf(row) };
    if (row.paneClosed !== false) return [{ ...base, idleSince: row.updatedAt, why: "its pane is closed" }];
    if (browserKeptFor(row, input.scheduled)) return [];
    const last = browserLastUse(row, input.usedAt);
    const idle = input.now - last;
    return idle >= BROWSER_IDLE_MS ? [{ ...base, idleSince: new Date(last).toISOString(), why: `no agent or operator use for ${Math.floor(idle / 60_000)} min` }] : [];
  });
}

/** Pane ids an OPEN scheduled task types into: their browsers are kept. */
export async function scheduledPanes(store: Pick<SpaceStore, "dueTaskSchedules">): Promise<Set<string>> {
  const tasks = await store.dueTaskSchedules("9999-12-31T00:00:00.000Z");
  return new Set(tasks.filter((task) => task.status === "OPEN" && task.paneId).map((task) => task.paneId!));
}

type ReaperStore = Pick<SpaceStore, "dueTaskSchedules" | "getRoom" | "recordAuditEvent">;

/** Every BROWSER_REAP_MS: closes the unused browsers (stopPane keeps their tabs for the next start) and audits each as BROWSER_REAPED_ACTION. */
export function startBrowserReaper(deps: { store: ReaperStore; census(): Promise<{ sessions: BrowserRow[] }>; usedAt: UsedAt;
  stopPane(paneId: string, traceId: string): Promise<void>; warn(error: unknown, paneId?: string): void; now?: () => number }) {
  const sweep = async () => {
    const unused = unusedBrowsers((await deps.census()).sessions, { now: (deps.now ?? Date.now)(), usedAt: deps.usedAt, scheduled: await scheduledPanes(deps.store) });
    for (const browser of unused) {
      const traceId = makeSpaceId("trace");
      // No actor: like closing the pane, the reaper outranks a stale lease (a live one keeps the browser above).
      try { await deps.stopPane(browser.paneId, traceId); } catch (error) { deps.warn(error, browser.paneId); continue; }
      const ownerUserId = await Promise.resolve(deps.store.getRoom(browser.roomId)).then((room) => room.ownerUserId ?? null).catch(() => null);
      await Promise.resolve(deps.store.recordAuditEvent({ actorUserId: null, traceId, action: BROWSER_REAPED_ACTION, targetType: "pane", targetId: browser.paneId,
        metadata: { ownerUserId, roomId: browser.roomId, title: browser.title, idleSince: browser.idleSince, why: browser.why } })).catch((error: unknown) => deps.warn(error, browser.paneId));
    }
  };
  const timer = setInterval(() => void sweep().catch((error: unknown) => deps.warn(error)), BROWSER_REAP_MS);
  timer.unref();
  return { sweep, stop: () => clearInterval(timer) };
}

/** Manager calls that are the operator using the pane (input, navigation, tabs, control, a start); resizes and reads are not. */
const OPERATOR_USE = new Set(["startOrRestore", "navigate", "action", "input", "createPage", "activatePage", "closePage", "acquireControl"]);
/** Calls that start or reattach the pane's Chrome, so an agent browser can refuse them. */
const OPERATOR_FIRST = new Set([...OPERATOR_USE, "listPages", "setViewport", "setStreamMode", "getActive"]);

const refusalOf = (error: unknown): "ROUTE" | "CAPACITY" | null => {
  const text = error instanceof Error ? error.message : "";
  if (/^BROWSER_ROUTE: another pane uses this browser account/.test(text)) return "ROUTE";
  return (error as { code?: unknown } | null)?.code === "BROWSER_SESSION_CAPACITY" || /^Browser limit reached/.test(text) ? "CAPACITY" : null;
};

type FirstStore = Pick<SpaceStore, "getPane" | "getPaneBrowserRoute" | "getLatestPaneBrowserSession" | "recordAuditEvent">;

/**
 * Operator 5/11 14:47 BKK (Browser pane:-YBf7fytrApP refused 07:03-07:49 UTC with BROWSER_ROUTE: Freelance Copilot 19 held its Google account's
 * Chrome on another route): the operator's own browser use is never refused by an agent browser. When a call of his is refused for another
 * pane's route on the same account, the agent browsers on that account with another route are closed; when the browser limit is reached, the
 * least recently used agent browser is. Then the call runs once more. His own other panes are never closed for it.
 */
export function operatorFirstBrowsers<M extends object>(manager: M, deps: { store: FirstStore; census(): Promise<{ sessions: BrowserRow[] }>; usedAt: UsedAt;
  noteUse(paneId: string): void; warn(error: unknown): void }): M {
  const routeOf = async (pane: Pane | null) => {
    if (!pane) return null;
    if (pane.mode === "FREELANCE_COPILOT") { const route = resolveFreelanceCopilotPaneMetadata(pane.freelanceCopilotMetadata).settings.browserEgress; return route === "direct" ? null : route; }
    return Promise.resolve(deps.store.getPaneBrowserRoute(pane.id)).catch(() => null);
  };
  const agentBrowser = (row: BrowserRow) => !OPERATOR_MODES.has(row.mode ?? "") || at(row.agent?.drivenAt) > (deps.usedAt(row.paneId) ?? 0);
  async function yieldTo(pane: Pane, refusal: "ROUTE" | "CAPACITY", traceId: string): Promise<string[]> {
    const rows = (await deps.census()).sessions.filter((row) => row.paneId !== pane.id && row.control?.holderType !== "OPERATOR" && agentBrowser(row));
    let victims: BrowserRow[];
    if (refusal === "ROUTE") {
      const latest = await Promise.resolve(deps.store.getLatestPaneBrowserSession(pane.id)).catch(() => null);
      const mine = await routeOf(pane);
      const profile = latest ? browserProfileLabel(latest.profilePath) : null;
      victims = [];
      for (const row of rows.filter((entry) => entry.profile === profile)) {
        const route = await routeOf(await Promise.resolve(deps.store.getPane(row.paneId)).catch(() => null));
        if (route !== null && route !== mine) victims.push(row);
      }
    } else victims = rows.sort((a, b) => browserLastUse(a, deps.usedAt) - browserLastUse(b, deps.usedAt)).slice(0, 1);
    for (const victim of victims) {
      await (manager as unknown as { stopPane(paneId: string, traceId?: string): Promise<void> }).stopPane(victim.paneId, traceId);
      await Promise.resolve(deps.store.recordAuditEvent({ actorUserId: null, traceId, action: "browser.yielded_to_operator", targetType: "pane", targetId: victim.paneId,
        metadata: { operatorPaneId: pane.id, refusal, title: nameOf(victim) } })).catch((error: unknown) => deps.warn(error));
    }
    return victims.map((victim) => victim.paneId);
  }
  return new Proxy(manager, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || typeof prop !== "string" || !OPERATOR_FIRST.has(prop)) return value;
      return async (...args: unknown[]) => {
        const actor = args.findLast((arg): arg is BrowserHostActorContext => !!arg && typeof arg === "object" && "holderType" in arg);
        const first = args[0] as { pane?: Pane } & Partial<Pane> | undefined;
        const pane = (prop === "startOrRestore" ? first?.pane : first?.mode ? first as Pane : undefined) ?? null;
        const operator = actor?.holderType === "OPERATOR" && String(actor.holderId).startsWith("user:") && pane !== null;
        if (operator && OPERATOR_USE.has(prop)) deps.noteUse(pane.id);
        try { return await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args); }
        catch (error) {
          const refusal = operator ? refusalOf(error) : null;
          if (!refusal || !(await yieldTo(pane!, refusal, makeSpaceId("trace")).catch((cause: unknown) => { deps.warn(cause); return []; })).length) throw error;
          return (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args);
        }
      };
    }
  });
}
