import { SpaceNotFoundError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import { NOUS_PANE_NOTICE_PREFIX } from "../nous/pane-notices.js";
import { agentNeedsYouKey } from "../pane-reports.js";
import type { NotificationService } from "./service.js";

type HandoffStore = Pick<SpaceStore, "getPane" | "listBrowserHandoffRequests" | "getActiveBrowserHandoffRequest" | "getBrowserHandoffRequest">;
interface SettleDeps { store: HandoffStore; notifications: Pick<NotificationService, "unresolvedBySource" | "resolve"> }

/** One notification per pane: a new handoff request in the pane refreshes it. */
export const browserHandoffNotificationKey = (paneId: string) => `browser-handoff:${paneId}`;
// A deleted pane nulls the notification's pane_id (ON DELETE SET NULL); its dedupe key still names the pane.
/** The agent's reason ("CAPTCHA: Upwork: Cloudflare check, tick the box") names the site and what to click: its first line, without the kind. */
export function browserHandoffTitle(reason: string | null | undefined): string {
  // Notification titles hold 200 characters; a longer first line made the whole alert fail (2026-10-22).
  return reason?.replace(/^(CAPTCHA|LOGIN|MFA|OTHER):\s*/, "").split("\n")[0]?.trim().slice(0, 200).trim() || "The browser needs you";
}
const paneOfKey = (dedupeKey: string | null) => dedupeKey?.startsWith("browser-handoff:") ? dedupeKey.slice("browser-handoff:".length) : null;

/**
 * Resolves (never deletes) the BROWSER_HANDOFF notifications whose handoff is over: completed, cancelled, timed out
 * (the store's active-handoff read applies the TTL), its pane closed or deleted. `paneId` checks that pane only.
 * shortcut: a new request landing between the check and the resolve is resolved with the old one; key by request id if that bites.
 */
export async function settleBrowserHandoffNotifications(deps: SettleDeps, paneId?: string): Promise<number> {
  let resolved = 0;
  for (const notification of await deps.notifications.unresolvedBySource("BROWSER_HANDOFF")) {
    const pane = notification.paneId ?? paneOfKey(notification.dedupeKey);
    if (!pane || (paneId && pane !== paneId) || notification.dedupeKey !== browserHandoffNotificationKey(pane)) continue;
    if (await handoffActive(deps.store, pane)) continue;
    resolved += await deps.notifications.resolve(notification.ownerUserId, notification.dedupeKey);
    // The Job Copilot agent logs the same handoff as HANDOFF_REQUESTED and nothing else resolves that card.
    await deps.notifications.resolve(notification.ownerUserId, `job-apply:handoff:${pane}`);
  }
  return resolved;
}

async function handoffActive(store: HandoffStore, paneId: string): Promise<boolean> {
  const pane = await Promise.resolve().then(() => store.getPane(paneId)).catch((error: unknown) => { if (error instanceof SpaceNotFoundError) return null; throw error; });
  if (!pane || pane.isClosed) return false;
  const sessions = new Set((await store.listBrowserHandoffRequests(pane.roomId))
    .filter((handoff) => handoff.paneId === paneId && (handoff.status === "REQUESTED" || handoff.status === "ACCEPTED")).map((handoff) => handoff.sessionId));
  for (const sessionId of sessions) if ((await store.getActiveBrowserHandoffRequest(sessionId))?.paneId === paneId) return true;
  return false;
}

/**
 * Browser handoff notifications, one per pane: raised when an agent asks for the operator (BROWSER_HANDOFF_REQUESTED) and
 * resolved when the handoff is over. A handoff ends without an event (completed, cancelled, its TTL applied when read, its
 * pane closed): settles once at start (the ones left open before), every 15 s and on a published PANE_CLOSED.
 * Returns the stop, for the app's onClose.
 */
export function startBrowserHandoffNotifications(deps: SettleDeps & {
  notifications: Pick<NotificationService, "unresolvedBySource" | "resolve" | "raise">; eventBus: Pick<SpaceEventBus, "subscribe">;
  roomOwner(roomId: string): Promise<string | null>; log: { warn(meta: Record<string, unknown>, message: string): void };
}): () => void {
  const settle = (paneId?: string) => void settleBrowserHandoffNotifications(deps, paneId)
    .catch((error: unknown) => deps.log.warn({ err: error, paneId }, "Browser handoff notifications could not be settled."));
  // A closed pane needs nobody: its needs-you cards (a CLI's and Nous's) resolve at once (Needs you, operator request 2026-10-24).
  const closedPaneNeedsYou = async (roomId: string | null, paneId: string) => {
    const owner = roomId ? await deps.roomOwner(roomId) : null;
    if (!owner) return;
    for (const key of [agentNeedsYouKey(paneId), `${NOUS_PANE_NOTICE_PREFIX}${paneId}`]) {
      await deps.notifications.resolve(owner, key).catch((error: unknown) => deps.log.warn({ err: error, paneId }, "A closed pane's needs-you card could not be resolved."));
    }
  };
  settle();
  const timer = setInterval(() => settle(), 15_000);
  timer.unref();
  const unsubscribe = deps.eventBus.subscribe((event) => {
    if (event.type === "PANE_CLOSED" && event.paneId) { settle(event.paneId); void closedPaneNeedsYou(event.roomId, event.paneId); }
    if (event.type !== "BROWSER_HANDOFF_REQUESTED" || !event.roomId) return;
    const roomId = event.roomId;
    void (async () => {
      const owner = await deps.roomOwner(roomId);
      if (!owner) return;
      const handoffId = event.payload.handoffRequestId;
      const reason = typeof handoffId === "string" ? (await deps.store.getBrowserHandoffRequest(handoffId))?.reason : null;
      await deps.notifications.raise({
        ownerUserId: owner, roomId, paneId: event.paneId ?? null, source: "BROWSER_HANDOFF", kind: event.type, severity: "ATTENTION", title: browserHandoffTitle(reason),
        body: (reason ?? event.message).slice(0, 2000), link: { roomId, ...(event.paneId ? { paneId: event.paneId } : {}) },
        dedupeKey: event.paneId ? browserHandoffNotificationKey(event.paneId) : `event:${event.id}`, payload: {}, telegram: null
      });
    })().catch((error: unknown) => deps.log.warn({ err: error, eventId: event.id }, "Notification producer failed."));
  });
  return () => { clearInterval(timer); unsubscribe(); };
}
