import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { BrowserControlLease, Pane } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { FastifyRequest } from "fastify";
import type { BrowserHostActorContext } from "@space/browser-host";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { recordAudit } from "./request-audit.js";
import { fenceCompletedHandoff } from "./vault/fence-hooks.js";

/**
 * An operator lease with no input for this long goes back to the agent (operator decision 2026-10-15: within 2 minutes
 * when he presses nothing), whether he took control himself or through a handoff; the API's sweeper and the lease
 * heartbeat both release it. Same value as the web client's BROWSER_CONTROL_IDLE_RELEASE_MS.
 */
export const BROWSER_CONTROL_IDLE_RELEASE_MS = 60_000;
/**
 * A handoff for a sign-in, a code or a CAPTCHA: the operator may wait on the pane (an SMS) without touching it, so its idle
 * time counts only while they are not on the pane (operator 2026-10-27: the NBG sign-in closed while they waited for the SMS).
 */
export const SIGN_IN_HANDOFF_REASON = /\b(?:sign[ -]?in|log[ -]?in|login|2fa|mfa|two[- ]factor|verif\w*|one[- ]time|otp|sms|codes?|captcha|password|passcode|human check)\b/i;
/** A CLI agent of the room may take the browser back (space_browser_reclaim_control) after this much operator inactivity. */
export const BROWSER_CONTROL_AGENT_RECLAIM_IDLE_MS = 60_000;
/** How often the API checks the operator leases it watches. */
export const BROWSER_CONTROL_IDLE_SWEEP_MS = 15_000;
/** A pane browser's corner label names the CLI pane driving it this recently (or while its CDP connection stays open); later it says "Last". */
export const BROWSER_AGENT_LABEL_MS = 10 * 60_000;
/** The saved drivers file is rewritten at most this often unless a browser gets a new driver (the label shows minutes). */
const BROWSER_AGENT_SAVE_MS = 60_000;

/** A bare hover (pointer moved with no button) is not an interaction: it must not keep an operator lease. */
export function countsAsOperatorInput(input: { type?: unknown; eventType?: unknown; button?: unknown }): boolean {
  return !(input.type === "POINTER" && input.eventType === "mouseMoved" && (input.button ?? "none") === "none");
}

export type BrowserControlActivity = ReturnType<typeof createBrowserControlActivity>;

/**
 * Last operator input per control lease, kept in the API process (input arrives here: the stream socket and HTTP input).
 * The CLI pane that last drove each pane browser is also saved to `agentsFile` (operator request 2026-10-22: the label survives
 * API restarts); null keeps it in memory (tests).
 */
export function createBrowserControlActivity(now: () => number = () => Date.now(), agentsFile: string | null = null) {
  // After an API restart the map is empty: every lease gets a fresh window instead of being released at once.
  const startedAt = now();
  const lastInput = new Map<string, number>();
  // Operator leases the idle sweeper checks (leaseId -> paneId); acquire and heartbeat add them.
  const watchedLeases = new Map<string, string>();
  const agents = new Map<string, { paneId: string; at: number }>();
  if (agentsFile) {
    try {
      for (const [browser, noted] of Object.entries(JSON.parse(readFileSync(agentsFile, "utf8")) as Record<string, { paneId: string; at: number }>)) {
        if (typeof noted?.paneId === "string" && Number.isFinite(noted.at)) agents.set(browser, noted);
      }
    } catch { /* no saved drivers yet */ }
  }
  let savedAt = 0;
  let saving = Promise.resolve();
  // shortcut: a driver noted in the last minute before the API stops is lost when the browser had the same driver; fine for a label.
  const save = () => {
    savedAt = now();
    const text = `${JSON.stringify(Object.fromEntries(agents))}\n`;
    saving = saving.then(() => writeFile(`${agentsFile}.${process.pid}.tmp`, text, { mode: 0o640 }))
      .then(() => rename(`${agentsFile}.${process.pid}.tmp`, agentsFile!)).catch(() => undefined);
  };
  return {
    noteAgent(browserPaneId: string, agentPaneId: string): void {
      const changed = agents.get(browserPaneId)?.paneId !== agentPaneId;
      agents.delete(browserPaneId);
      agents.set(browserPaneId, { paneId: agentPaneId, at: now() });
      if (agents.size > 1000) agents.delete(agents.keys().next().value!);
      if (agentsFile && (changed || now() - savedAt >= BROWSER_AGENT_SAVE_MS)) save();
    },
    /** The CLI pane that last drove a pane browser; active within BROWSER_AGENT_LABEL_MS, or any time while it stays attached. */
    agentFor(browserPaneId: string, attached = false): { paneId: string; at: number; active: boolean } | null {
      const noted = agents.get(browserPaneId);
      return noted ? { ...noted, active: attached || now() - noted.at <= BROWSER_AGENT_LABEL_MS } : null;
    },
    noteInput(leaseId: string): void {
      lastInput.delete(leaseId);
      lastInput.set(leaseId, now());
      if (lastInput.size > 1000) lastInput.delete(lastInput.keys().next().value!);
    },
    idleMs(lease: Pick<BrowserControlLease, "leaseId" | "acquiredAt">): number {
      const acquired = Date.parse(lease.acquiredAt);
      return Math.max(0, now() - Math.max(startedAt, lastInput.get(lease.leaseId) ?? 0, Number.isFinite(acquired) ? acquired : 0));
    },
    watch(lease: Pick<BrowserControlLease, "leaseId" | "paneId" | "holderType" | "status">): void {
      if (lease.holderType !== "OPERATOR" || lease.status !== "ACTIVE") return;
      watchedLeases.set(lease.leaseId, lease.paneId);
      if (watchedLeases.size > 1000) watchedLeases.delete(watchedLeases.keys().next().value!);
    },
    watched(): Array<{ leaseId: string; paneId: string }> {
      return [...watchedLeases].map(([leaseId, paneId]) => ({ leaseId, paneId }));
    },
    forget(leaseId: string): void {
      lastInput.delete(leaseId);
      watchedLeases.delete(leaseId);
    }
  };
}

/** The frame label's and the census's driver of a pane browser, with its pane and room names; null once that pane is closed or gone. */
export async function browserAgentOf(store: Pick<SpaceStore, "getPane" | "getRoom">, activity: Pick<BrowserControlActivity, "agentFor">,
  browserPaneId: string, attached: boolean) {
  const noted = activity.agentFor(browserPaneId, attached);
  let pane: Pane | null = null;
  try { pane = noted ? await store.getPane(noted.paneId) : null; } catch { /* the agent's pane is gone */ }
  if (!noted || !pane || pane.isClosed) return null;
  return { paneId: pane.id, title: pane.title, paneName: pane.paneName ?? null, roomId: pane.roomId, roomName: (await store.getRoom(pane.roomId)).name,
    drivenAt: new Date(noted.at).toISOString(), active: noted.active };
}

type LeaseStore = Pick<SpaceStore, "getActiveBrowserHandoffRequest" | "getBrowserControlLease" | "updateBrowserControlLease" | "updateBrowserHandoffRequest">;

/**
 * An accepted handoff whose operator lease is over (released, or past its expiry because the tab stopped heartbeating)
 * is completed, and a lease past its expiry is marked EXPIRED (the session's control state goes back to UNCONTROLLED).
 * Before, such a handoff stayed ACCEPTED until its own 30-minute expiry and the agent kept waiting on it. A completed handoff
 * fences the page the operator worked in like a Vault fill (2026-10-19), so agents never read back what they typed.
 */
export async function settleEndedOperatorLease(store: LeaseStore, sessionId: string): Promise<void> {
  const handoff = await store.getActiveBrowserHandoffRequest(sessionId);
  if (handoff?.status !== "ACCEPTED" || !handoff.controlLeaseId) return;
  const lease = await store.getBrowserControlLease(handoff.controlLeaseId);
  if (lease?.status === "ACTIVE" && Date.parse(lease.expiresAt) > Date.now()) return;
  if (lease?.status === "ACTIVE") await store.updateBrowserControlLease(lease.leaseId, { status: "EXPIRED" });
  await fenceCompletedHandoff(store, handoff.paneId, handoff.requestedByType === "AGENT" ? handoff.requestedById : undefined);
  await store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "COMPLETED" });
}

/** Releases a lease through the same path as the operator's own release: host release, accepted handoff completed, audit. */
export async function releaseBrowserControlLease(deps: {
  store: SpaceStore;
  browserSessionManager: Pick<BrowserSessionManagerWithHostHealth, "releaseControl">;
  activity: BrowserControlActivity;
}, input: {
  pane: Pane;
  lease: BrowserControlLease;
  /** The HTTP request that decided it; the idle sweeper has none and passes a traceId. */
  request?: FastifyRequest;
  traceId?: string;
  auditAction: string;
  auditMetadata?: Record<string, unknown>;
}): Promise<BrowserControlLease> {
  if (!deps.browserSessionManager.releaseControl) throw new Error("Browser control handoff is unavailable on this runtime.");
  const traceId = input.request?.requestIdForSpace ?? input.traceId ?? `browser-control:${input.lease.leaseId}`;
  // The host checks the caller is the holder; the API has decided, so it releases in the holder's name.
  const holder: BrowserHostActorContext = { holderType: input.lease.holderType, holderId: input.lease.holderId };
  // The fence is up before the agent gets the browser back.
  const accepted = await deps.store.getActiveBrowserHandoffRequest(input.lease.sessionId);
  if (accepted?.status === "ACCEPTED" && accepted.controlLeaseId === input.lease.leaseId) {
    await fenceCompletedHandoff(deps.store, input.pane.id, accepted.requestedByType === "AGENT" ? accepted.requestedById : undefined);
  }
  const released = await deps.browserSessionManager.releaseControl(input.pane, { leaseId: input.lease.leaseId }, traceId, holder);
  const handoff = await deps.store.getActiveBrowserHandoffRequest(released.sessionId);
  if (handoff?.status === "ACCEPTED" && handoff.controlLeaseId === released.leaseId) {
    await deps.store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "COMPLETED" });
  }
  deps.activity.forget(released.leaseId);
  const audit = { action: input.auditAction, targetType: "pane", targetId: input.pane.id,
    metadata: { sessionId: released.sessionId, leaseId: released.leaseId, ...input.auditMetadata } };
  if (input.request) await recordAudit(deps.store, input.request, audit);
  else await deps.store.recordAuditEvent({ actorUserId: null, traceId, ...audit });
  return released;
}

/**
 * One pass over the watched operator leases: a lease past its expiry ends (with its handoff), a lease idle for
 * BROWSER_CONTROL_IDLE_RELEASE_MS is released to the agent. Returns how many ended.
 */
export async function sweepIdleOperatorLeases(deps: Parameters<typeof releaseBrowserControlLease>[0]): Promise<number> {
  let ended = 0;
  for (const { leaseId, paneId } of deps.activity.watched()) {
    try {
      const lease = await deps.store.getBrowserControlLease(leaseId);
      if (!lease || lease.status !== "ACTIVE" || lease.holderType !== "OPERATOR") {
        deps.activity.forget(leaseId);
        continue;
      }
      if (Date.parse(lease.expiresAt) <= Date.now()) {
        await deps.store.updateBrowserControlLease(leaseId, { status: "EXPIRED" });
        await settleEndedOperatorLease(deps.store, lease.sessionId);
        deps.activity.forget(leaseId);
        ended += 1;
        continue;
      }
      const idleMs = deps.activity.idleMs(lease);
      if (idleMs < BROWSER_CONTROL_IDLE_RELEASE_MS) continue;
      await releaseBrowserControlLease(deps, { pane: await deps.store.getPane(paneId), lease, traceId: `browser-idle-release:${leaseId}`,
        auditAction: "pane.browser.control.idle_release", auditMetadata: { idleSeconds: Math.floor(idleMs / 1000) } });
      ended += 1;
    } catch {
      // Host busy or the pane closed: the next pass retries, and a lease nobody renews reaches its expiry.
    }
  }
  return ended;
}

/** Runs the sweep every BROWSER_CONTROL_IDLE_SWEEP_MS; returns the stop function. */
export function startBrowserControlIdleRelease(deps: Parameters<typeof releaseBrowserControlLease>[0], intervalMs = BROWSER_CONTROL_IDLE_SWEEP_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepIdleOperatorLeases(deps).finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
