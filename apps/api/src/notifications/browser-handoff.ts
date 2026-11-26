import { makeNeedsYouAsk, NEEDS_YOU_GO_NOW, needsYouBrowserPage, needsYouTargetSchema, type NotificationListQuery, type Pane, type PaneBrowserSession, type SpaceNotification } from "@space/contracts";
import { SpaceNotFoundError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import { allNotifications, NOUS_PANE_NOTICE_PREFIX } from "../nous/pane-notices.js";
import { PaneCloseRefusedError } from "../pane-guards.js";
import { createPlanNeedsYou } from "../nous/plan-needs-you.js";
import { agentNeedsYouKey } from "../pane-reports.js";
import type { NotificationService } from "./service.js";

type HandoffStore = Pick<SpaceStore, "getPane" | "listBrowserHandoffRequests" | "getActiveBrowserHandoffRequest" | "getBrowserHandoffRequest"> & Partial<Pick<SpaceStore, "getPaneBrowserSession" | "getPaneCliSession" | "listClipboardItems">>;
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
/**
 * A handoff asked in the operator's quiet hours waits for their morning with its browser open (Nous goal 91e45be1, 16/11: closing it lost
 * Cody's filled Recruitee form); its reason ends with this line, so the card keeps the page should the browser close anyway (Take control
 * reopens it there), and the agent that asked is told once the handoff is done or its card runs out after the morning.
 */
export const NIGHT_HANDOFF_MARK = "Held for the morning; the browser keeps it open on";
// shortcut: handoffs asked before 16/11 closed their browser at once and carry this mark; drop it once none waits (one night after the deploy).
const CLOSED_NIGHT_MARK = "Closed for the night; Take control reopens it on";
export const nightHandoffLine = (url: string | null | undefined) => `\n${NIGHT_HANDOFF_MARK} ${url || "its last page"}.`;
/** A night handoff's page (from its reason), or null for a day handoff. */
export function nightHandoffPage(reason: string): string | null {
  for (const mark of [NIGHT_HANDOFF_MARK, CLOSED_NIGHT_MARK]) {
    const at = reason.indexOf(mark);
    if (at >= 0) return reason.slice(at + mark.length).trim().replace(/\.$/, "");
  }
  return null;
}
/** The pane's night handoff still waiting on a browser that closed (none once a browser runs there again). */
export async function closedNightHandoff(store: Pick<SpaceStore, "listBrowserHandoffRequests" | "getActiveBrowserHandoffRequest">, pane: { id: string; roomId: string }, liveSessionId?: string) {
  for (const entry of await store.listBrowserHandoffRequests(pane.roomId)) {
    if (entry.paneId !== pane.id || entry.sessionId === liveSessionId || entry.status !== "REQUESTED" || nightHandoffPage(entry.reason) === null) continue;
    const active = await store.getActiveBrowserHandoffRequest(entry.sessionId);
    if (active?.handoffRequestId === entry.handoffRequestId) return active;
  }
  return null;
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

export async function handoffActive(store: HandoffStore, paneId: string): Promise<boolean> {
  const pane = await Promise.resolve().then(() => store.getPane(paneId)).catch((error: unknown) => { if (error instanceof SpaceNotFoundError) return null; throw error; });
  if (!pane || pane.isClosed) return false;
  const sessions = new Set((await store.listBrowserHandoffRequests(pane.roomId))
    .filter((handoff) => handoff.paneId === paneId && (handoff.status === "REQUESTED" || handoff.status === "ACCEPTED")).map((handoff) => handoff.sessionId));
  for (const sessionId of sessions) if ((await store.getActiveBrowserHandoffRequest(sessionId))?.paneId === paneId) return true;
  return false;
}

/**
 * Operator 15/11 nous_msg:9f70dbbe («έκλεισες panes που περίμεναν εμένα»: 9 Needs you items became 5): no pane closes while an unanswered
 * Needs you item or a held browser handoff waits on it, whoever closes it (Nous, a pane agent, the Room Agent, a sweep). Only the operator's
 * own close forces it (`operatorForce`), and then its items move to the plan or room (plan-needs-you.ts `carry`), never resolve.
 */
export const operatorWaitCloseGuard = (deps: { store: HandoffStore; roomOwner(roomId: string): Promise<string | null>;
  list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]> }) => async (pane: Pane): Promise<void> => {
  const owner = await deps.roomOwner(pane.roomId);
  // Goal 7365014c 22/11: protect a browser pane holding the page for another pane's open Needs you card (payload.browserPage.paneId).
  const items = owner ? (await allNotifications(deps.list, owner, { status: "NEEDS_YOU" }))
    .filter((card) => card.paneId === pane.id || needsYouBrowserPage(card)?.paneId === pane.id) : [];
  const handoff = await handoffActive(deps.store, pane.id);
  if (!items.length && !handoff) return;
  const what = [...items.map((item) => `"${item.title}" [${item.id}]`), ...(handoff ? ["a browser handoff the operator holds or was asked for"] : [])];
  throw new PaneCloseRefusedError(`This pane stays open: it waits for the operator (${what.join("; ")}). Only the operator can close it now.`,
    { needsYou: items.map((item) => ({ id: item.id, title: item.title })), handoff }, "PANE_WAITS_FOR_OPERATOR");
};

/**
 * Browser handoff notifications, one per pane: raised when an agent asks for the operator (BROWSER_HANDOFF_REQUESTED) and
 * resolved when the handoff is over. A handoff ends without an event (completed, cancelled, its TTL applied when read, its
 * pane closed): settles once at start (the ones left open before), every 15 s and on a published PANE_CLOSED.
 * Returns the stop, for the app's onClose.
 */
export function startBrowserHandoffNotifications(deps: SettleDeps & {
  notifications: Pick<NotificationService, "unresolvedBySource" | "resolve" | "raise"> & Partial<Pick<NotificationService, "list">>; eventBus: Pick<SpaceEventBus, "subscribe">;
  roomOwner(roomId: string): Promise<string | null>; log: { warn(meta: Record<string, unknown>, message: string): void };
  /** The morning wake of night handoffs: `tell` resolves once the asking CLI was told or has no pane left, throws to try again. */
  wake?: { quiet(owner: string): Promise<boolean>; tell(cliSessionId: string, text: string): Promise<void> };
}): () => void {
  const settle = (paneId?: string) => void settleBrowserHandoffNotifications(deps, paneId)
    .catch((error: unknown) => deps.log.warn({ err: error, paneId }, "Browser handoff notifications could not be settled."));
  // Operator 13/11 nous_msg:2e24947d: a closing pane's open asks move to the item of the plan it worked on first (plan-needs-you.ts), never vanish.
  const list = deps.notifications.list;
  const listPlans = deps.store.listClipboardItems;
  const plans = list && listPlans ? createPlanNeedsYou({ notifications: { list, raise: deps.notifications.raise, resolve: deps.notifications.resolve }, decisions: async () => [],
    plans: async (owner) => {
      const out = [];
      for (let page = 1; ; page += 1) {
        const result = await Promise.resolve(listPlans.call(deps.store, owner, { source: "PLAN", includeCompleted: false, page, pageSize: 100 }));
        out.push(...result.items);
        if (!result.items.length || out.length >= result.total) return out;
      }
    } }) : null;
  // A closed pane's needs-you cards (a CLI's, Nous's, its browser handoff's) move to its plan's or room's item (`carry`), then the pane's own resolve.
  // 15/11 nous_msg:9f70dbbe: an operator-forced close keeps every ask in Needs you; a failed move keeps the pane's cards (closed pane: hidden, not lost).
  const closedPaneNeedsYou = async (roomId: string | null, paneId: string) => {
    const owner = roomId ? await deps.roomOwner(roomId) : null;
    if (!owner || !plans) return;
    const moved = await plans.carry(owner, paneId).then(() => true, (error: unknown) => { deps.log.warn({ err: error, paneId }, "A closed pane's needs-you cards could not move to their plan or room."); return false; });
    if (!moved) return;
    for (const key of [agentNeedsYouKey(paneId), `${NOUS_PANE_NOTICE_PREFIX}${paneId}`]) {
      await deps.notifications.resolve(owner, key, "its pane was closed").catch((error: unknown) => deps.log.warn({ err: error, paneId }, "A closed pane's needs-you card could not be resolved."));
    }
  };
  // Correction 19/11 74a2b433 & Goal 7365014c 22/11 (stale "Go now" cards ef567c5d, 99bc2421): any open Needs you card of another pane
  // whose page was in the closed browser has no page left to act on; resolve it (its CLI asks again with a new page).
  const closedBrowserBoundCards = async (roomId: string | null, paneId: string) => {
    const owner = roomId ? await deps.roomOwner(roomId) : null;
    if (!owner || !list) return;
    for (const card of await allNotifications(list, owner, { status: "NEEDS_YOU" })) {
      if (card.paneId === paneId || !card.dedupeKey || needsYouBrowserPage(card)?.paneId !== paneId) continue;
      await deps.notifications.resolve(owner, card.dedupeKey, "the browser holding its page was closed");
    }
  };
  // A night handoff's agent stopped; once the operator's quiet hours end it learns whether they did it (a kept browser: once done or run out).
  // shortcut: in memory, so an API restart forgets a pane whose card already resolved (done overnight); its agent then asks again in the morning.
  const nightPanes = new Map<string, string>();
  const woken = new Set<string>();
  const wakeNight = async (wake: NonNullable<typeof deps.wake>) => {
    for (const card of await deps.notifications.unresolvedBySource("BROWSER_HANDOFF")) {
      const paneId = card.paneId ?? paneOfKey(card.dedupeKey);
      if (paneId && card.roomId) nightPanes.set(paneId, card.roomId);
    }
    for (const [paneId, roomId] of nightPanes) {
      const latest = (await deps.store.listBrowserHandoffRequests(roomId)).find((entry) => entry.paneId === paneId);
      const page = latest ? nightHandoffPage(latest.reason) : null;
      if (!latest || page === null || !latest.requestedById.startsWith("cli:") || latest.status === "CANCELLED" || woken.has(latest.handoffRequestId)) {
        nightPanes.delete(paneId);
        continue;
      }
      const ended = (latest.status !== "REQUESTED" && latest.status !== "ACCEPTED") || Date.parse(latest.expiresAt) <= Date.now();
      const kept = latest.reason.includes(NIGHT_HANDOFF_MARK);
      if (!ended && (latest.status === "ACCEPTED" || kept)) continue;
      const owner = await deps.roomOwner(roomId);
      if (!owner || await wake.quiet(owner)) continue;
      const what = `the browser handoff you asked for last night ("${browserHandoffTitle(latest.reason)}")`;
      await wake.tell(latest.requestedById.slice(4), latest.status === "COMPLETED" ? `The operator is available again and did ${what}. Continue that task in the pane's browser.`
        : kept ? `The operator is available again; ${what} is not done and its card ran out. Open ${page} again in the pane's browser if it no longer shows it (your filled form may be there still) and request the handoff again.`
        : `The operator is available again; ${what} is not done: its browser closed for the night. Open ${page} again in the pane's browser and request the handoff again (it replaces last night's card).`)
        .then(() => { woken.add(latest.handoffRequestId); nightPanes.delete(paneId); }, () => undefined);
    }
  };
  let waking = false;
  const tick = () => {
    settle();
    if (!deps.wake || waking) return;
    waking = true;
    void wakeNight(deps.wake).catch((error: unknown) => deps.log.warn({ err: error }, "Night browser handoffs could not wake their agents.")).finally(() => { waking = false; });
  };
  tick();
  const timer = setInterval(tick, 15_000);
  timer.unref();
  const unsubscribe = deps.eventBus.subscribe((event) => {
    // The cards move before settle resolves the handoff card of the closed pane.
    // shortcut: the 15 s tick can settle in the few ms before the move; carry by request id if a handoff card is ever lost that way.
    if (event.type === "PANE_CLOSED" && event.paneId) {
      const paneId = event.paneId;
      void closedPaneNeedsYou(event.roomId, paneId).finally(() => settle(paneId));
      void closedBrowserBoundCards(event.roomId, paneId).catch((error: unknown) => deps.log.warn({ err: error, paneId }, "A closed browser's bound cards could not be resolved."));
    }
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
