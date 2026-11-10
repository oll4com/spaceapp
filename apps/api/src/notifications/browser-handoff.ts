import { makeNeedsYouAsk, NEEDS_YOU_GO_NOW, needsYouTargetSchema, type PaneBrowserSession } from "@space/contracts";
import { SpaceNotFoundError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import { NOUS_PANE_NOTICE_PREFIX } from "../nous/pane-notices.js";
import { agentNeedsYouKey } from "../pane-reports.js";
import type { NotificationService } from "./service.js";

type HandoffStore = Pick<SpaceStore, "getPane" | "listBrowserHandoffRequests" | "getActiveBrowserHandoffRequest" | "getBrowserHandoffRequest"> & Partial<Pick<SpaceStore, "getPaneBrowserSession" | "getPaneCliSession">>;
interface SettleDeps { store: HandoffStore; notifications: Pick<NotificationService, "unresolvedBySource" | "resolve"> }

/** One notification per pane: a new handoff request in the pane refreshes it. */
export const browserHandoffNotificationKey = (paneId: string) => `browser-handoff:${paneId}`;
// A deleted pane nulls the notification's pane_id (ON DELETE SET NULL); its dedupe key still names the pane.
/** The agent's reason ("CAPTCHA: Upwork: Cloudflare check, tick the box") names the site and what to click: its first line, without the kind. */
export function browserHandoffTitle(reason: string | null | undefined): string {
  // Notification titles hold 200 characters; a longer first line made the whole alert fail (2026-10-22).
  return reason?.replace(/^(CAPTCHA|LOGIN|MFA|OTHER):\s*/, "").split("\n")[0]?.trim().slice(0, 200).trim() || "The browser needs you";
}
const hostOf = (url: string) => URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, "") : null;
/**
 * Where Go now lands (operator nous_msg:4b36b80e, 6/11: a sign-in card arrived as a list of steps while the pane showed another site): the
 * tab of the page the handoff is about: the https address the reason names, then the site it names (a sign-in popup while another tab is
 * active), then the session's current page; else that page as a new tab.
 */
export function browserHandoffTarget(session: Pick<PaneBrowserSession, "currentUrl" | "pages"> | null | undefined, reason: string | null | undefined, site?: string | null): string | undefined {
  const named = /https:\/\/[^\s"'<>()[\]]+/.exec(reason ?? "")?.[0]?.replace(/[.,;:!?]+$/, "");
  const current = session?.currentUrl && /^https?:\/\//.test(session.currentUrl) ? session.currentUrl : null;
  const pages = (session?.pages ?? []).filter((entry) => entry.url);
  const onHost = (host: string | null | undefined) => host ? pages.find((entry) => { const own = hostOf(entry.url!); return own === host || Boolean(own?.endsWith(`.${host}`)); }) : undefined;
  const page = (named ? pages.find((entry) => entry.url === named) ?? onHost(hostOf(named)) : undefined) ?? onHost(site?.replace(/^www\./, ""))
    ?? (current ? pages.find((entry) => entry.url === current) ?? onHost(hostOf(current)) : undefined);
  if (page) return needsYouTargetSchema.safeParse(`tab:${page.pageId}`).data;
  const url = named ?? current;
  return url ? needsYouTargetSchema.safeParse(`url:${url}`).data : undefined;
}
/** The card's one short question (the agent's steps stay in its body, behind Details): what to do and where, from the reason's kind. */
export function browserHandoffQuestion(reason: string | null | undefined, site: string | null): string {
  const kind = /^(CAPTCHA|LOGIN|MFA|OTHER):/.exec(reason ?? "")?.[1];
  if (!site) return kind === "LOGIN" ? "Sign in in the pane's browser" : kind === "MFA" ? "Enter the sign-in code in the pane's browser"
    : kind === "CAPTCHA" ? "Solve the check in the pane's browser" : "The browser needs you";
  return kind === "LOGIN" ? `Sign in to ${site}` : kind === "MFA" ? `Enter the sign-in code on ${site}` : kind === "CAPTCHA" ? `Solve the check on ${site}` : `Take over the browser on ${site}`;
}
/**
 * A hands card's focus from the agent's text: the site it names, Go now's target, the steps as the body (behind Details) and the one
 * short question. Every sign-in, code or CAPTCHA card uses it, the browser handoff's and the Job Copilot's own (never a plain notice).
 */
export function browserHandoffFocus(session: Pick<PaneBrowserSession, "currentUrl" | "pages"> | null | undefined, text: string) {
  // R20-asks-1: the site is the first host the text names (repeat cards on it go quiet).
  const site = /(?:[a-z0-9-]+\.)+[a-z]{2,24}/i.exec(text)?.[0]?.toLowerCase() ?? null;
  return { site, target: browserHandoffTarget(session, text, site),
    // Steps the agent wrote inline ("1) … 2) …") go on their own lines, so Details lists them.
    body: /\s1\)\s[\s\S]*\s2\)\s/.test(text) ? text.replace(/\s+(?=\d{1,2}\)\s)/g, "\n") : text,
    ask: makeNeedsYouAsk(browserHandoffQuestion(text, site ?? hostOf(session?.currentUrl ?? "")), { kind: "PANE" }, [NEEDS_YOU_GO_NOW], NEEDS_YOU_GO_NOW) };
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
  notifications: Pick<NotificationService, "unresolvedBySource" | "resolve" | "raise"> & Partial<Pick<NotificationService, "list">>; eventBus: Pick<SpaceEventBus, "subscribe">;
  roomOwner(roomId: string): Promise<string | null>; log: { warn(meta: Record<string, unknown>, message: string): void };
}): () => void {
  const settle = (paneId?: string) => void settleBrowserHandoffNotifications(deps, paneId)
    .catch((error: unknown) => deps.log.warn({ err: error, paneId }, "Browser handoff notifications could not be settled."));
  // A closed pane needs nobody: its needs-you cards (a CLI's and Nous's) resolve at once (Needs you, operator request 2026-10-24).
  const closedPaneNeedsYou = async (roomId: string | null, paneId: string) => {
    const owner = roomId ? await deps.roomOwner(roomId) : null;
    if (!owner) return;
    for (const key of [agentNeedsYouKey(paneId), `${NOUS_PANE_NOTICE_PREFIX}${paneId}`]) {
      await deps.notifications.resolve(owner, key, "its pane was closed").catch((error: unknown) => deps.log.warn({ err: error, paneId }, "A closed pane's needs-you card could not be resolved."));
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
      const handoff = typeof handoffId === "string" ? await deps.store.getBrowserHandoffRequest(handoffId) : null;
      const reason = handoff?.reason ?? null;
      const session = handoff && deps.store.getPaneBrowserSession ? await Promise.resolve().then(() => deps.store.getPaneBrowserSession!(handoff.sessionId)).catch(() => null) : null;
      const dedupeKey = event.paneId ? browserHandoffNotificationKey(event.paneId) : `event:${event.id}`;
      // R20-asks-1 (30/10: 50 handoff notices reached the operator, 1 acknowledged): a new handoff on the same pane and site under 30 minutes
      // after the last one is recorded (Needs you shows it) without Telegram or push; the site is the first host its reason names.
      const { site, target, body, ask } = browserHandoffFocus(session, reason ?? event.message);
      // A one-time code (MFA) expires in minutes (6/11 PayPal: a held repeat reached nobody): never held, and its card takes the code
      // itself for the CLI that asked (`codePane`), which types it into the page.
      const mfa = /^MFA:/.test(reason ?? "");
      const cliSessionId = handoff?.requestedById.startsWith("cli:") ? handoff.requestedById.slice(4) : null;
      const codePane = mfa && cliSessionId && deps.store.getPaneCliSession
        ? (await Promise.resolve().then(() => deps.store.getPaneCliSession!(cliSessionId)).catch(() => null))?.paneId ?? null : null;
      const last = event.paneId && deps.notifications.list ? (await deps.notifications.list(owner, { status: "ALL", dedupeKey, limit: 1 }).catch(() => []))[0] : undefined;
      // A handoff the operator took was answered: the pane's next one is a new ask, whoever asks (6/11: Kate's PayPal code after Leo's
      // sign-in on the same browser was held and reached no phone).
      const recent = Boolean(last && Date.parse(last.createdAt) > Date.now() - 30 * 60_000 && (last.payload.site ?? null) === site);
      const taken = recent && Boolean((await Promise.resolve().then(() => deps.store.listBrowserHandoffRequests(roomId)).catch(() => []))
        .find((entry) => entry.paneId === event.paneId && entry.handoffRequestId !== handoffId)?.acceptedAt);
      const repeat = !mfa && recent && !taken;
      await deps.notifications.raise({
        ownerUserId: owner, roomId, paneId: event.paneId ?? null, source: "BROWSER_HANDOFF", kind: event.type, severity: "ATTENTION", title: browserHandoffTitle(reason),
        body,
        link: { roomId, ...(event.paneId ? { paneId: event.paneId } : {}), ...(event.paneId && target ? { target } : {}) }, dedupeKey,
        payload: { ...(site ? { site } : {}), ...(repeat ? { repeat: true } : {}), ...(codePane ? { codePane, ask: { question: ask.question, code: true, answer: ask.answer } } : { ask }) },
        telegram: null
      }, repeat ? { held: true } : {});
    })().catch((error: unknown) => deps.log.warn({ err: error, eventId: event.id }, "Notification producer failed."));
  });
  return () => { clearInterval(timer); unsubscribe(); };
}
