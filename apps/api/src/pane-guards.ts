import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { Event, Pane, PaneBrowserSession, PaneCliSession } from "@space/contracts";
import type { FastifyRequest } from "fastify";
import { spaceControlInvokeHeader } from "./space-control-token.js";

/** Native agent sessions run only in open CHAT panes. */
export function assertAgentPaneCompatible(pane: Pane) {
  if (pane.mode !== "CHAT") {
    throw new SpaceConflictError(`Pane ${pane.id} is ${pane.mode}; native agent sessions require CHAT panes.`);
  }
  if (pane.isClosed) {
    throw new SpaceConflictError(`Pane ${pane.id} is closed.`);
  }
}

export async function assertPaneBelongsToRoom(store: SpaceStore, roomId: string, paneId?: string | null) {
  if (!paneId) return;
  const pane = await store.getPane(paneId);
  if (pane.roomId !== roomId) {
    throw new SpaceNotFoundError(`Pane ${paneId} was not found.`);
  }
}

export async function getPaneById(store: SpaceStore, paneId: string): Promise<Pane> {
  return store.getPane(paneId);
}

export async function getLatestRoomEvent(store: SpaceStore, roomId: string): Promise<Event | null> {
  return store.getLatestEvent(roomId);
}

export class PaneClosedConflictError extends SpaceConflictError {}
/** A pane that may not close yet: a Marketing Copilot with approved posts still scheduled (operator rule 9/11). HTTP 409 PANE_HAS_SCHEDULED_POSTS. */
export class PaneCloseRefusedError extends SpaceConflictError {
  constructor(message: string, readonly details: Record<string, unknown>, readonly code: "PANE_HAS_SCHEDULED_POSTS" | "PANE_WAITS_FOR_OPERATOR" = "PANE_HAS_SCHEDULED_POSTS") { super(message); }
}
/** `?force=true` counts only from the operator's own hands: never an agent's broker or proof session, never Space Control's in-process call. */
export const operatorForce = (request: FastifyRequest) => (request.query as { force?: unknown } | undefined)?.force === "true"
  && Boolean(request.user) && !request.user?.brokerScope && !request.sessionPrincipal && request.headers[spaceControlInvokeHeader] === undefined;

// Copilot, Design, App Studio, Video, Security and Monitoring Copilot panes own a CLI agent session (Job, Marketing and Freelance Copilot also a managed browser session).
const CLI_PANE_MODES: ReadonlyArray<Pane["mode"]> = ["TERMINAL", "JOB_APPLY", "MAIL_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "DESIGN", "APP_STUDIO", "VIDEO", "SECURITY_COPILOT", "MONITORING_COPILOT"];

export function isCliPane(pane: Pick<Pane, "mode">): boolean {
  return CLI_PANE_MODES.includes(pane.mode);
}

export function assertCliPaneCompatible(pane: Pane) {
  if (!isCliPane(pane)) {
    throw new SpaceConflictError(`Pane ${pane.id} is ${pane.mode}; CLI sessions require TERMINAL, JOB_APPLY, MAIL_COPILOT, MARKETING_COPILOT, FREELANCE_COPILOT, DESIGN, APP_STUDIO, VIDEO, SECURITY_COPILOT or MONITORING_COPILOT panes.`);
  }
  if (pane.isClosed) {
    throw new PaneClosedConflictError(`Pane ${pane.id} is closed.`);
  }
}

// Never DESIGN or VIDEO: those panes have no browser in v1, and a browser would need the operator's guarded Browser Host restart.
const BROWSER_PANE_MODES: ReadonlyArray<Pane["mode"]> = ["BROWSER", "YOUTUBE", "JOB_APPLY", "MARKETING_COPILOT", "FREELANCE_COPILOT"];

export function isBrowserPane(pane: Pick<Pane, "mode">): boolean {
  return BROWSER_PANE_MODES.includes(pane.mode);
}

export function assertBrowserPaneCompatible(pane: Pane) {
  if (!isBrowserPane(pane)) {
    throw new SpaceConflictError(`Pane ${pane.id} is ${pane.mode}; browser sessions require BROWSER, YOUTUBE, JOB_APPLY, MARKETING_COPILOT or FREELANCE_COPILOT panes.`);
  }
  if (pane.isClosed) {
    throw new SpaceConflictError(`Pane ${pane.id} is closed.`);
  }
}

/**
 * A Job, Marketing or Freelance Copilot pane's browser is its own agent's while that agent runs: no other pane drives it
 * (15/11 04:03 BKK: Jack's Job Copilot, its own browser stopped, took Max's Freelance Copilot browser from the room's context).
 */
export async function isOtherAgentsBrowser(store: Pick<SpaceStore, "getActivePaneCliSession">, pane: Pick<Pane, "id" | "mode">, cliPaneId: string): Promise<boolean> {
  return pane.id !== cliPaneId && isCliPane(pane) && isBrowserPane(pane) && Boolean(await store.getActivePaneCliSession(pane.id));
}

export async function assertNotOtherAgentsBrowser(store: Pick<SpaceStore, "getActivePaneCliSession">, pane: Pane, cliPaneId: string) {
  if (await isOtherAgentsBrowser(store, pane, cliPaneId)) {
    throw new SpaceConflictError(`Pane ${pane.id} is the browser of another agent's ${pane.mode} pane; drive your own: space_browser_start without targetPaneId.`);
  }
}

export function assertNormalCliSession(session: PaneCliSession): void {
  if (session.purpose !== "NORMAL") {
    throw new SpaceConflictError("CLI login sessions support only terminal authentication I/O, reconnect, and cancellation.");
  }
}

export async function getActiveBrowserSessionForPane(store: SpaceStore, pane: Pane): Promise<PaneBrowserSession> {
  const session = await store.getActivePaneBrowserSession(pane.id);
  if (!session || !session.isActive || session.status === "CLOSED") {
    throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
  }
  return session;
}

/** 15/11 Dino/Jack: Antigravity reports "gemini-3.8-flash-high" for a pane configured "gemini-3.8-flash": the same model, "-high" is its default effort. */
export const sameModelId = (left: string | null | undefined, right: string | null | undefined) => left?.replace(/-high$/, "") === right?.replace(/-high$/, "");
