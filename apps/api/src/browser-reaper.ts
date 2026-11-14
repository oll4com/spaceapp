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

/** In use now: an agent drives it or a control lease holds it. Kept for a task, a handoff or a sign-in is waiting, not use (Nous Score Idle open panes). */
export function browserInUse(row: BrowserRow): boolean {
  return Boolean(row.agent?.active || row.control);
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

/**
 * Score lever Idle open browsers (14/11: 33 reaped in 7 days, nearly all a terminal agent's "CLI Browser" or room browser left open after
 * its turn ended): a BROWSER pane is released as soon as the terminal pane that drove it last is done with it, not 30 minutes later.
 */
export const BROWSER_RELEASED_ACTION = "browser.released";
const WORK_ENDS = new Set(["TURN_END", "DONE", "FAILED"]);
/** A report that waits on the operator: its browser may be what he is asked to look at. */
const ASKS = new Set(["NEEDS_YOU", "NEEDS_DECISION", "BLOCKED", "WAITING", "QUESTION"]);
const UNSAID = new Set(["TURN_END", "HEARTBEAT", "TODO"]);

/** Whether a driver's reports (newest first) end its work after its last drive: a turn end, done or failed, and its last word is no ask. */
export function driverWorkEnded(reports: Array<{ at: string; status: string }>, drivenAt: number): boolean {
  const newest = reports.find((report) => report.status !== "HEARTBEAT" && report.status !== "TODO");
  return Boolean(newest && at(newest.at) > drivenAt && WORK_ENDS.has(newest.status) && !ASKS.has(reports.find((report) => !UNSAID.has(report.status))?.status ?? ""));
}

export interface ReleaseDeps {
  /** The CLI pane that drove the browser last; active while it attaches or drove it in the last 10 minutes. */
  agentFor(paneId: string): { paneId: string; at: number; active: boolean } | null;
  /** The driver pane's reports, newest first; null when they cannot be read. */
  reports(driver: Pane): Promise<Array<{ at: string; status: string }> | null>;
  /** The active tab holds text someone typed into a form; true when it cannot be told. */
  typedForm(paneId: string): Promise<boolean>;
}

/**
 * The live BROWSER panes whose driver is a terminal pane (a copilot's own browser and the browsers it drives keep their sign-ins) that closed or
 * ended its work since its last drive, with no operator use since then, nothing that keeps them (browserKeptFor) and no typed form.
 */
export async function releasableBrowsers(rows: BrowserRow[], input: { store: Pick<SpaceStore, "getPane">; usedAt: UsedAt; scheduled: Set<string>; release: ReleaseDeps }) {
  const found: Array<UnusedBrowser & { driverPaneId: string }> = [];
  for (const row of rows) {
    if (row.mode !== "BROWSER" || row.paneClosed !== false || browserKeptFor(row, input.scheduled)) continue;
    const noted = input.release.agentFor(row.paneId);
    if (!noted || noted.active || (input.usedAt(row.paneId) ?? 0) >= noted.at) continue;
    const driver = await Promise.resolve(input.store.getPane(noted.paneId)).catch(() => null);
    if (driver?.mode !== "TERMINAL") continue;
    const ended = driver.isClosed ? "closed" : driverWorkEnded(await input.release.reports(driver).catch(() => null) ?? [], noted.at) ? "ended its turn" : null;
    if (!ended || await input.release.typedForm(row.paneId).catch(() => true)) continue;
    found.push({ paneId: row.paneId, roomId: row.roomId, title: nameOf(row), idleSince: new Date(noted.at).toISOString(), driverPaneId: driver.id,
      why: `its driver ${driver.paneName ?? driver.title} ${ended}` });
  }
  return found;
}

type ReaperStore = Pick<SpaceStore, "dueTaskSchedules" | "getRoom" | "getPane" | "recordAuditEvent">;

/**
 * Every BROWSER_REAP_MS: closes the unused browsers (stopPane keeps their tabs for the next start) and audits each as BROWSER_REAPED_ACTION,
 * then the ones their terminal driver is done with (releasableBrowsers) as BROWSER_RELEASED_ACTION. One unused past 30 minutes stays reaped.
 */
export function startBrowserReaper(deps: { store: ReaperStore; census(): Promise<{ sessions: BrowserRow[] }>; usedAt: UsedAt; release?: ReleaseDeps;
  stopPane(paneId: string, traceId: string): Promise<void>; warn(error: unknown, paneId?: string): void; now?: () => number }) {
  const close = async (browser: UnusedBrowser & { driverPaneId?: string }, action: string) => {
    const traceId = makeSpaceId("trace");
    // No actor: like closing the pane, the reaper outranks a stale lease (a live one keeps the browser above).
    try { await deps.stopPane(browser.paneId, traceId); } catch (error) { deps.warn(error, browser.paneId); return; }
    const ownerUserId = await Promise.resolve(deps.store.getRoom(browser.roomId)).then((room) => room.ownerUserId ?? null).catch(() => null);
    await Promise.resolve(deps.store.recordAuditEvent({ actorUserId: null, traceId, action, targetType: "pane", targetId: browser.paneId,
      metadata: { ownerUserId, roomId: browser.roomId, title: browser.title, idleSince: browser.idleSince, why: browser.why, driverPaneId: browser.driverPaneId } })).catch((error: unknown) => deps.warn(error, browser.paneId));
  };
  const sweep = async () => {
    const rows = (await deps.census()).sessions;
    const scheduled = await scheduledPanes(deps.store);
    const unused = unusedBrowsers(rows, { now: (deps.now ?? Date.now)(), usedAt: deps.usedAt, scheduled });
    for (const browser of unused) await close(browser, BROWSER_REAPED_ACTION);
    if (!deps.release) return;
    const reaped = new Set(unused.map((browser) => browser.paneId));
    const released = await releasableBrowsers(rows.filter((row) => !reaped.has(row.paneId)), { store: deps.store, usedAt: deps.usedAt, scheduled, release: deps.release });
    for (const browser of released) await close(browser, BROWSER_RELEASED_ACTION);
  };
  const timer = setInterval(() => void sweep().catch((error: unknown) => deps.warn(error)), BROWSER_REAP_MS);
  timer.unref();
  return { sweep, stop: () => clearInterval(timer) };
}

/** Manager calls that are the operator using the pane (input, navigation, tabs, control, a start); resizes and reads are not. */
const OPERATOR_USE = new Set(["startOrRestore", "navigate", "action", "input", "createPage", "activatePage", "closePage", "acquireControl"]);
/** Calls that start or reattach the pane's Chrome, so an agent browser can refuse them. */
const OPERATOR_FIRST = new Set([...OPERATOR_USE, "listPages", "setViewport", "setStreamMode", "getActive"]);

export const refusalOf = (error: unknown): "ROUTE" | "CAPACITY" | null => {
  const text = error instanceof Error ? error.message : "";
  if (/^BROWSER_ROUTE: another pane uses this browser account/.test(text)) return "ROUTE";
  // The host's SpaceFeatureDisabledError carries errorCode: "No Xvfb display is available" was never read as capacity before 13/11.
  const code = (error as { code?: unknown; errorCode?: unknown } | null);
  return code?.code === "BROWSER_SESSION_CAPACITY" || code?.errorCode === "BROWSER_SESSION_CAPACITY" || /^Browser limit reached/.test(text) ? "CAPACITY" : null;
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
