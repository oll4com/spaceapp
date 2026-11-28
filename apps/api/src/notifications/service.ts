import { createHash } from "node:crypto";
import {
  NOTIFICATION_SOURCE_LABELS, eventSchema, notificationChannelEnabled, notificationRaiseInputSchema, resolveNotificationSettings,
  type Event, type NotificationListQuery, type NotificationRaiseInput, type NotificationSource, type NotificationStatus, type NeedsYouTranslation, type NotificationStreamPayload, type PushDevice, type PushDeviceRegistration, type PushLevel, type SpaceNotification, type UiLanguage, type UserSettings, heldForNous, isHandRequest, heldUnderAllowance, isNousApproval, isNousFirstCard, needsOperatorHands, needsOperatorHandsText, NEEDS_YOU_TOPIC_KINDS, sameNeedsYouTopic, needsYou, needsYouAsk, needsYouCardTexts, NEEDS_YOU_COMPLETION_OPTION, NEEDS_YOU_GO_NOW, NEEDS_YOU_START_NOW, needsYouTranslation, needsYouMail, agentLanguageOf, agentFilesNamedIn, type AgentFileRef } from "@space/contracts";
import type { SpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, type SpaceEventBus } from "@space/runtime";
import type { FcmSender } from "./fcm.js";
import { ownerQuietNow } from "../owner-clock.js";
import { CARD_TRANSLATOR_VERSION, translateCard, translateMail, type CardTranslate } from "./translate.js";

/** A push device's public id: a hash of its FCM token, so the devices list never carries the token itself. */
export const pushDeviceId = (token: string) => `push_device:${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
export { createCardTranslator } from "./translate.js";

export type CardMailReader = (owner: string, named: { reviewId: string | null; account: string | null; threadId: string | null }) => Promise<{ subject: string; text: string; at: string | null } | null>;

export interface NotificationServiceDeps {
  repository: SpaceNotificationsRepository;
  eventBus: Pick<SpaceEventBus, "publish">;
  /** The owner's settings decide the channels; `suppressNotifications` silences every pop-up and Telegram. */
  userSettings(userId: string): Promise<UserSettings>;
  /** Room events are kept (and replayed) by the store; notifications outside a room only travel the live bus. */
  recordRoomEvent(input: Omit<Event, "id" | "createdAt" | "workflowId">): Promise<Event>;
  /** FCM pushes to the owner's Android devices; absent when no service account key is configured (dev). */
  push?: FcmSender | null;
  /**
   * Nous, the mind of SpaceApp (operator decision 2026-10-17): while it is on and working, what needs the operator reaches
   * Nous first and their phone only through Nous's own decisions; anything urgent still goes out.
   */
  nous?: { held(owner: string): Promise<boolean>; raised(notification: SpaceNotification): void;
    /** "Copilot questions go to Nous first" is on, Nous is on and its model is not paused (Ask Last step 7). */
    holdsCopilotQuestions?(owner: string): Promise<boolean>;
    /** Operator 2/11 15:08 BKK: Nous is on with "May send to third parties": the approvals it covers (isNousApproval) are Nous's alone. */
    coversApproval?(owner: string): Promise<boolean>;
    /** Goal 7365014c-d: answers a new needs-you card of a kind the operator always answers the same way; its ACKED record, or null. */
    autoAnswer?(notification: SpaceNotification): Promise<SpaceNotification | null>;
    /** R16-9: the option a needs-you card without a recommended one takes from the operator's base rate of its kind, or null. */
    recommend?(card: { ownerUserId: string; source: NotificationSource; kind: string; options: string[] }): Promise<{ option: string; answers: number } | null>;
    /** 23/11 REVIEW: the option of another producer's card that follows the operator's principle rule its recommended pick goes against, or null. */
    principlePick?(card: { recommended: string; context: string; options: string[] }): Promise<{ option: string; rule: { id: string; title: string } } | null>;
    /** nous_msg:8e7e6c25: the text with each workspace file it names filed in Agent Files and its id written beside it. */
    annotate?(owner: string, text: string): Promise<string>;
    /** nous_msg:0cb8d563: the owner's Agent Files, of which a needs-you card's `payload.files` are those its text or producer names. */
    agentFiles?(owner: string): Promise<AgentFileRef[]> };
  log?: { warn(meta: Record<string, unknown>, message: string): void };
  now?(): string;
  /** A needs-you card's text in the owner's language (Settings → Language), added as `payload.translated` once it is raised. */
  translate?: CardTranslate;
}

export type MobileWake = (owner: string, urgent: boolean) => Promise<void>;

/** The allowance a covered approval is held under (`payload.heldForNous.allowance`): "May send to third parties". */
export const NOUS_APPROVAL_ALLOWANCE = "maySend";
/** How long a copilot's question waits for Nous before it reaches the operator anyway (Ask Last step 7); a covered approval's re-wake period. */
export const NOUS_QUESTION_HOLD_MS = 60 * 60_000;
/**
 * 13/11 19:25 BKK (Iris, public-host Space Link): the operator answered the pane's card "Ready now", its next needs-you carried a 2-minute pairing code,
 * was held for Nous and expired unseen. A card the operator is waiting for (an answer on its pane this recent) or a code this short-lived shows at once.
 */
export const OPERATOR_JUST_ANSWERED_MS = 10 * 60_000;
// DEV3D-049: "within", "changes" and «μέσα σε» are expiry words too ("enter the code within 60 seconds").
// The words between a time and "code" may be hyphenated ("120 s public-host pairing code").
// DEV3D-039: "code" as a whole word, and seconds only right before it or after an expiry word ("tests ran in 45s" beside "code review" is no code).
const EXPIRING_CODE = /\b(?:[1-9]|1[0-5])[- ]?(?:minutes?|mins?|λεπτ\p{L}*)\s+(?:\p{L}[\p{L}-]*\s+){0,2}(?:codes?\b|κωδικ\p{L}*)|(?<!\p{L})(?:codes?\b|κωδικ\p{L}*)[^\n]{0,120}?(?:expires?|valid|within|changes?|λ[ηή]γει|ισχ[υύ]ει|μ[εέ]σα\s+σε)[^.\n]{0,30}?\b(?:[1-9]|1[0-5])\s*(?:minutes?|mins?|λεπτ)|\b\d+\s*(?:(?:s|secs?|seconds?)\b|δευτερ\p{L}*)\s+(?:[\p{L}\d][\p{L}\d-]*\s+){0,2}(?:codes?\b|κωδικ\p{L}*)|(?<!\p{L})(?:codes?\b|κωδικ\p{L}*)[^\n]{0,120}?(?:expires?|valid|within|changes?|λ[ηή]γει|ισχ[υύ]ει|μ[εέ]σα\s+σε)[^.\n]{0,30}?\b\d+\s*(?:(?:s|secs?|seconds?)\b|δευτερ\p{L}*)|\bQR\b/iu;

/** Kept for 30 days, then pruned, except unresolved ATTENTION and URGENT items, which stay until resolved (Record Retention Invariant). */
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 3_600_000;

/**
 * R9-12 (operator 28/10 15:33 BKK «παλι χαθηκε το needs you»): a needs-you ask, an agent's (`agent:needs-you:`) or Nous's pane card
 * (`nous:pane:`), that ends RESOLVED (never the operator's answer or acknowledgement, which ACK it) is told to the listeners with why,
 * so Nous raises a lost ask again in the same turn.
 */
export interface NeedsYouEnded { record: SpaceNotification; reason: string }
const ASK_KEY = /^(?:agent:needs-you:|nous:pane:)/;
const CLOSED_PANE_KEY = "nous:closed-pane:";
/** One ask in two cards: the first paragraphs (what the operator does) share most words; the checks below them differ card to card. */
export function sameAsk(left: Pick<SpaceNotification, "title" | "body">, right: Pick<SpaceNotification, "title" | "body">): boolean {
  const words = (card: Pick<SpaceNotification, "title" | "body">) => new Set((card.body || card.title).split(/\n\s*\n/)[0]!.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const [a, b] = [words(left), words(right)];
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return small.size >= 4 && [...small].filter((word) => large.has(word)).length / small.size >= 0.8;
}
const askEndedListeners = new Set<(event: NeedsYouEnded) => void>();
export function onNeedsYouEnded(listener: (event: NeedsYouEnded) => void): () => void {
  askEndedListeners.add(listener);
  return () => { askEndedListeners.delete(listener); };
}
const tellAskEnded = (records: SpaceNotification[], reason: string) => {
  for (const record of records) for (const listener of askEndedListeners) { try { listener({ record, reason }); } catch { /* a listener never changes the resolve */ } }
};
// 2/11: an agent's ask held for Nous never reached the operator, so its end (Nous closed it, the pane moved on) is no lost ask.
const waiting = (record: SpaceNotification | null): record is SpaceNotification => Boolean(record && ASK_KEY.test(record.dedupeKey ?? "") && (record.status === "OPEN" || record.status === "READ")
  && !record.payload.heldForNous);

export function createNotificationService(deps: NotificationServiceDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  let wake: MobileWake | null = null;
  /** The inbox Thread a record belongs to (set by the Nous wiring once the inbox exists): a phone shows one notification per Thread. */
  let threadOf: ((owner: string, notificationId: string) => Promise<string | null>) | null = null;
  // The mail a card names, as Needs you shows it (set where the Mail Copilot is made, copilot-pane-routes-wiring.ts).
  let mailOf: CardMailReader | null = null;
  /** owner|wakeAt already batched (a restart may send one wake time's batch once more, never more). */
  const batched = new Set<string>();

  function payloadOf(notification: SpaceNotification): NotificationStreamPayload {
    return { notificationId: notification.id, ownerUserId: notification.ownerUserId, source: notification.source, kind: notification.kind, severity: notification.severity,
      status: notification.status, roomId: notification.roomId, paneId: notification.paneId };
  }
  async function publish(type: "NOTIFICATION_CREATED" | "NOTIFICATION_UPDATED", notification: SpaceNotification) {
    const base = { roomId: notification.roomId ?? "", paneId: notification.paneId, turnId: null, workflowId: null, traceId: `notification:${notification.id}`, type,
      message: `${NOTIFICATION_SOURCE_LABELS[notification.source]}: ${notification.kind}`.slice(0, 1000), payload: payloadOf(notification) as unknown as Record<string, unknown> };
    try {
      // Ids only on the shared stream: every signed-in user receives every event; the owner reads the record through the API.
      if (notification.roomId) deps.eventBus.publish(await deps.recordRoomEvent({ ...base, roomId: notification.roomId }));
      else deps.eventBus.publish(eventSchema.parse({ ...base, id: makeSpaceId("event"), roomId: null, createdAt: now() }));
    } catch (error) {
      deps.log?.warn({ err: error, notificationId: notification.id }, "Notification event could not be published.");
    }
  }

  // A device FCM no longer accepts (UNREGISTERED or INVALID_ARGUMENT) stops getting pushes until the app registers again; logged, so the next
  // "my phone gets nothing" has its time and cause (operator 17/11, nous_msg:e58363a2: the 13/11 16:02Z disable left no trace).
  async function disableDevice(token: string, notificationId: string | null) {
    await deps.repository.disablePushDevice(token);
    deps.log?.warn({ notificationId, device: token.slice(-6) }, "Push device disabled: FCM answered UNREGISTERED or INVALID_ARGUMENT.");
  }

  // Technical: a push shows a short preview (240); a longer body ends with "…" and the tap opens the whole card.
  async function sendPush(push: FcmSender, notification: SpaceNotification, levels: readonly PushLevel[]) {
    // `source`: an app drops what another app on the same phone shows (SpaceApp Android leaves NOUS to the Nous app).
    // `message`: Expo's Android apps show a data push's `message` as its text (they read `body` as a JSON object), so the text went missing.
    const body = notification.body.length > 240 ? `${notification.body.slice(0, 239)}…` : notification.body;
    // Spec v2 §7 (step 4): `threadId` and `tag`, so a newer record of the same Thread replaces its notification on the phone.
    const threadId = await threadOf?.(notification.ownerUserId, notification.id).catch(() => null) ?? null;
    // `channelId`: Expo reads a data push's Android channel from it (else its fallback channel); a phone without "spaceapp" falls back the same way.
    const data = { notificationId: notification.id, title: `${NOTIFICATION_SOURCE_LABELS[notification.source]}: ${notification.title}`, body, message: body,
      source: notification.source, channelId: "spaceapp", ...(threadId ? { threadId, tag: threadId } : {}), ...appointmentPush(notification) };
    for (const token of await deps.repository.pushTokens(notification.ownerUserId, levels)) {
      const result = await push.send(token, data).catch((error: unknown) => { deps.log?.warn({ err: error, notificationId: notification.id }, "Notification push failed."); return "FAILED" as const; });
      if (result === "INVALID_TOKEN") await disableDevice(token, notification.id);
    }
  }

  /**
   * Spec v2 §7 (step 4): a Thread that stopped alerting takes its push off every phone: a data push with no title or text, which Expo never
   * shows, so an app that does not know `clear` stays silent. No `source`, so the app that dropped the Thread's push clears nothing.
   */
  async function clearThreadPush(owner: string, threadId: string) {
    if (!deps.push) return;
    for (const token of await deps.repository.pushTokens(owner)) {
      const result = await deps.push.send(token, { threadId, tag: threadId, clear: "1" })
        .catch((error: unknown) => { deps.log?.warn({ err: error, threadId }, "Inbox clear push failed."); return "FAILED" as const; });
      if (result === "INVALID_TOKEN") await disableDevice(token, null);
    }
  }

  // Technical: identical cards (a pane's card raised again) reuse their translation instead of another model call; the newest 200 are kept.
  const translations = new Map<string, NeedsYouTranslation>();
  const translating = new Set<string>();
  // A card the model could not translate is tried again 10 minutes later, not on every read.
  const failed = new Map<string, number>();
  const markFailed = (key: string) => {
    failed.set(key, Date.parse(now()));
    if (failed.size > 200) failed.delete(failed.keys().next().value!);
  };
  async function translateLater(record: SpaceNotification, language: UiLanguage) {
    // A translation an older translator made is made again once (it shows meanwhile); a failure keeps it.
    if ((needsYouTranslation(record, language)?.version ?? 0) >= CARD_TRANSLATOR_VERSION) return;
    const { from } = needsYouCardTexts(record);
    const key = `${language}\n${from}`;
    // The dock reads Needs you every few seconds: one model call per card text at a time.
    const flight = `${record.id}\n${key}`;
    if (translating.has(flight) || (failed.get(key) ?? 0) > Date.parse(now()) - 10 * 60_000) return;
    // Held until the translation is stored: a read in between would otherwise pay for a second model call.
    translating.add(flight);
    try {
      // A failure waits its 10 minutes and reaches the caller's log with its reason (stable 1/11: bff6dfcb kept its version 1 text silently).
      const translated = translations.get(key) ?? await translateCard(deps.translate!, record, language).catch((error: unknown) => {
        markFailed(key);
        throw error;
      });
      if (!translated) {
        markFailed(key);
        return;
      }
      translations.delete(key);
      translations.set(key, translated);
      if (translations.size > 200) translations.delete(translations.keys().next().value!);
      const updated = await deps.repository.addPayload(record.ownerUserId, record.id, { translated });
      if (updated) await publish("NOTIFICATION_UPDATED", updated);
    } finally {
      translating.delete(flight);
    }
  }

  /**
   * Operator 21/11 nous_msg:e9b4df3e: the mail a card names, in the owner's language when it reads in neither Greek nor English, stored once as
   * `payload.mailTranslated` (also when it needed none, so it is read once); a failure leaves the card as it is and is tried again 10 minutes later.
   */
  async function translateMailLater(record: SpaceNotification, language: UiLanguage) {
    const named = needsYouMail(record);
    if (!named || !mailOf || !deps.translate || (record.payload.mailTranslated as { language?: unknown } | undefined)?.language === language) return;
    const key = `mail\n${record.id}\n${language}`;
    if (translating.has(key) || (failed.get(key) ?? 0) > Date.parse(now()) - 10 * 60_000) return;
    translating.add(key);
    try {
      const mail = await mailOf(record.ownerUserId, named);
      const mailTranslated = mail && await translateMail(deps.translate, mail, language, record.id).catch((error: unknown) => { markFailed(key); throw error; });
      if (!mailTranslated) return markFailed(key);
      const updated = await deps.repository.addPayload(record.ownerUserId, record.id, { mailTranslated });
      if (updated && mailTranslated.text !== undefined) await publish("NOTIFICATION_UPDATED", updated);
    } finally {
      translating.delete(key);
    }
  }

  /** The Agent Files a needs-you card names (its text, or ids its producer gave in `payload.files`), as chips that open them. */
  async function cardFiles(record: Pick<SpaceNotification, "ownerUserId" | "title" | "body" | "payload">, owned?: Promise<AgentFileRef[]>): Promise<AgentFileRef[]> {
    const given = Array.isArray(record.payload.files) ? record.payload.files.map((file: unknown) => typeof file === "string" ? file
      : (file as { artifactId?: unknown } | null)?.artifactId).filter((id): id is string => typeof id === "string") : [];
    const files = await (owned ?? deps.nous!.agentFiles!(record.ownerUserId));
    return agentFilesNamedIn([...needsYouCardTexts(record).texts, ...given].join("\n"), files);
  }

  /** Every record of a query, 200 a page (the list's page), paging on the oldest one's time. */
  async function everyRecord(owner: string, query: Omit<NotificationListQuery, "limit" | "before">): Promise<SpaceNotification[]> {
    const out: SpaceNotification[] = [];
    for (let before: string | undefined; ;) {
      const page = await deps.repository.list(owner, { ...query, limit: 200, ...(before ? { before } : {}) });
      out.push(...page);
      if (page.length < 200) return out;
      before = page.at(-1)!.createdAt;
    }
  }
  /**
   * 17/11 (cards 7454e78e and e90ddf3c, one Admin key ask twice): a closed pane's carried card that a newer Nous card asks again closes, so the
   * newest stays. Run after a Nous card is raised, and once at start for the cards raised before. A carry of Room Agent cards only (carried
   * before request 1feac683 left them out: they read the closed pane's own CLI) closes too.
   */
  async function dropCarriedDuplicates(owner: string): Promise<number> {
    const open = (await everyRecord(owner, { status: "WAITING", source: "NOUS" })).filter(needsYou);
    let closed = 0;
    for (const carry of open.filter((item) => item.dedupeKey?.startsWith(CLOSED_PANE_KEY))) {
      const carried = Array.isArray(carry.payload.carried) ? carry.payload.carried as Array<{ dedupeKey?: string | null }> : [];
      const screenOnly = carried.length > 0 && carried.every((item) => item.dedupeKey?.startsWith("room-agent-event:"));
      const newer = screenOnly ? undefined : open.find((item) => item.id !== carry.id && item.createdAt > carry.createdAt && sameAsk(item, carry));
      if (!screenOnly && !newer) continue;
      const updated = await deps.repository.setStatus(owner, carry.id, "RESOLVED", { resolvedReason: newer ? `a newer card asks the same (${newer.id})` : "its pane was closed" });
      if (updated?.status !== "RESOLVED") continue;
      closed += 1;
      await publish("NOTIFICATION_UPDATED", updated);
    }
    return closed;
  }
  const service = {
    /**
     * Records the notification (or refreshes the open one with its dedupe key), publishes it, queues Telegram and pushes to the
     * owner's devices when the owner wants it. `realert`: a refreshed record is unread again and goes out once more (Nous's
     * per-pane card when its list changed, plan clipboard:8FfXWclYUfOH). `held`: recorded and listed, but no Telegram or push
     * (Nous's own alerts while the operator is away, plan clipboard:B7eTUHTJYg3X).
     */
    /**
     * `telegramSend`: a producer that delivers the Telegram text itself (Nous's decision cards with Approve/Decline buttons, 2026-10-24)
     * takes the outbox's place when it answers true; false or an error falls back to the outbox, so nothing is lost. The same rules
     * decide whether Telegram is wanted at all (held, suppressed, the channel switches).
     */
    async raise(rawInput: NotificationRaiseInput, options: { realert?: boolean; held?: boolean; telegramSend?: (text: string) => Promise<boolean | string> } = {}): Promise<SpaceNotification> {
      let parsed = notificationRaiseInputSchema.parse(rawInput);
      // nous_msg:8e7e6c25: files a card, a reminder or a Done record names are always in Agent Files, and open from the card.
      if (deps.nous?.annotate) {
        const annotate = (text: string) => deps.nous!.annotate!(parsed.ownerUserId, text).catch(() => text);
        const summary = typeof parsed.payload.summary === "string" ? await annotate(parsed.payload.summary) : null;
        // 23/11 (nous_msg:acb1aa48 «Δεν μου δίνεις λινκ»): a workspace path a producer gives in payload.files is filed too, so its chip opens.
        const given = Array.isArray(parsed.payload.files) ? await Promise.all(parsed.payload.files.map((file: unknown) => typeof file === "string" ? annotate(file) : file)) : null;
        parsed = { ...parsed, body: notificationRaiseInputSchema.shape.body.parse(await annotate(parsed.body)),
          ...(summary || given ? { payload: { ...parsed.payload, ...(summary ? { summary } : {}), ...(given ? { files: given } : {}) } } : {}) };
      }
      if (deps.nous?.agentFiles && needsYou(parsed)) {
        const files = await cardFiles(parsed).catch((error: unknown) => { deps.log?.warn({ err: error }, "Needs you files could not be read."); return null; });
        if (files) parsed = { ...parsed, payload: { ...parsed.payload, files } };
      }
      // R16-9: a needs-you card asking with options and no recommended one takes the operator's usual answer to its kind, marked as such.
      const asked = parsed.payload.ask ? needsYouAsk({ title: parsed.title, body: parsed.body, payload: parsed.payload }) : null;
      if (asked?.options?.length && !asked.recommended && needsYou(parsed)) {
        const base = await deps.nous?.recommend?.({ ownerUserId: parsed.ownerUserId, source: parsed.source, kind: parsed.kind, options: asked.options }).catch(() => null);
        if (base) parsed = { ...parsed, body: notificationRaiseInputSchema.shape.body.parse(`${parsed.body}\n\nRecommended "${base.option}" by your last ${base.answers} answers.`),
          payload: { ...parsed.payload, ask: { ...asked, recommended: base.option }, baseRate: base } };
        else {
          // Audit §4 item 8: no producer nor base rate recommends: Go now, else the first option that is no completion ("Done": only the operator
          // says it, 16/11 21:55 BKK), marked so "Always answer like this" never stores it; none such: no recommendation.
          // Daily Nous errors 26/11: a "Start now?" card verified live recommends Go now itself; unverified, its page may be done or need a re-check.
          const option = asked.question === NEEDS_YOU_START_NOW ? undefined
            : asked.options.find((item) => item === NEEDS_YOU_GO_NOW) ?? asked.options.find((item) => !NEEDS_YOU_COMPLETION_OPTION.test(item));
          deps.log?.warn({ source: parsed.source, kind: parsed.kind, options: asked.options }, "Needs you card with options and no recommended one: a default is recommended.");
          if (option) parsed = { ...parsed, payload: { ...parsed.payload, ask: { ...asked, recommended: option }, recommendedDefault: true } };
        }
      }
      // 23/11 REVIEW (Village Global, ledger 1813): an agent's or copilot's pick goes against a saved operator rule; Nous's own cards are held in its tools.
      const picked = parsed.payload.ask ? needsYouAsk({ title: parsed.title, body: parsed.body, payload: parsed.payload }) : null;
      if (picked?.recommended && picked.options?.length && parsed.source !== "NOUS" && needsYou(parsed)) {
        const fix = await deps.nous?.principlePick?.({ recommended: picked.recommended, context: `${parsed.title}\n${parsed.body}\n${picked.question ?? ""}`, options: picked.options }).catch(() => null);
        if (fix) parsed = { ...parsed, body: notificationRaiseInputSchema.shape.body.parse(`${parsed.body}\n\nRecommended "${fix.option}" by your rule [${fix.rule.id}] "${fix.rule.title.slice(0, 80)}".`),
          payload: { ...parsed.payload, ask: { ...picked, recommended: fix.option } } };
      }
      // Read before the raise: a refresh of the answered record would replace its answer. Before the refresh too, which then drops its hold.
      const awaited = isNousFirstCard(parsed) && (EXPIRING_CODE.test(`${parsed.title}\n${parsed.body}`) || Boolean(parsed.paneId
        && (await everyRecord(parsed.ownerUserId, { status: "ALL", paneId: parsed.paneId }).catch(() => [] as SpaceNotification[])).some((item) => {
          const at = Date.parse(String((item.payload.answer as { at?: unknown } | undefined)?.at ?? ""));
          return Date.parse(now()) - at < OPERATOR_JUST_ANSWERED_MS;
        })));
      // Operator 27/11 (nous_msg:766ca4f6): an identity check or their own interview or test is the operator's own hands: never held for Nous.
      const handsText = isNousFirstCard(parsed) && needsOperatorHandsText([parsed.title, parsed.body, needsYouAsk(parsed).question].join("\n"));
      // 2/11 (operator 10:16 BKK: two Mail Copilot cards for one Google Cloud billing account): a card about what an open one of its source,
      // kind and pane is about refreshes that one (its key joins `mergedKeys`, so resolving either key closes it); and a refreshed card held
      // for Nous stays held (a raise replaces the payload, which let an agent's second ask skip Nous).
      let prior: SpaceNotification | undefined;
      // A plan's own card (plan-needs-you.ts, no pane) is one per plan: never merged into another plan's by topic.
      if (parsed.dedupeKey && !parsed.dedupeKey.startsWith("nous:plan:") && needsYou(parsed) && (isNousFirstCard(parsed) || NEEDS_YOU_TOPIC_KINDS.test(parsed.kind))) {
        // Speed audit 14/11: its own key's card and the waiting ones of its kind (a topic is one kind's), not every waiting record of the source
        // (6,275 read Mail Copilot notices for each of its questions).
        const open = await Promise.all([deps.repository.list(parsed.ownerUserId, { status: "WAITING", source: parsed.source, dedupeKey: parsed.dedupeKey, limit: 1 }),
          everyRecord(parsed.ownerUserId, { status: "WAITING", source: parsed.source, kind: parsed.kind })]).then((found) => found.flat()).catch(() => [] as SpaceNotification[]);
        prior = open.find((item) => item.dedupeKey === parsed.dedupeKey) ?? open.find((item) => item.dedupeKey && sameNeedsYouTopic(item, parsed));
        if (prior) {
          const merged = [...new Set([...(Array.isArray(prior.payload.mergedKeys) ? prior.payload.mergedKeys as string[] : []), ...(prior.dedupeKey === parsed.dedupeKey ? [] : [parsed.dedupeKey])])];
          parsed = { ...parsed, dedupeKey: prior.dedupeKey, payload: { ...parsed.payload, ...(merged.length ? { mergedKeys: merged } : {}),
            // A release is no refresh; an allowance hold is set again below only while it still covers the card.
            ...(heldForNous(prior, Date.parse(now())) && !heldUnderAllowance(prior) && !parsed.payload.releasedFromNous && !awaited && !handsText ? { heldForNous: prior.payload.heldForNous } : {}) } };
        }
      }
      // Operator 2/11 15:08 BKK («να μην φτανει σε εμενα το aprove»): an approval "May send" covers is held for Nous with no time limit while
      // Nous and the allowance are on (a refresh too), and wakes Nous at once below; with either off it is the operator's as before.
      const covered = isNousApproval(parsed) && parsed.severity !== "URGENT" && Boolean(await deps.nous?.coversApproval?.(parsed.ownerUserId).catch(() => false));
      if (covered) parsed = { ...parsed, payload: { ...parsed.payload, heldForNous: { until: new Date(Date.parse(now()) + NOUS_QUESTION_HOLD_MS).toISOString(), allowance: NOUS_APPROVAL_ALLOWANCE } } };
      const keptHold = Boolean(parsed.payload.heldForNous);
      const settings = await deps.userSettings(parsed.ownerUserId).catch(() => null);
      // The operator's night (operator 31/10 09:50 BKK, 30 alerts in one night): every notification waits for the morning batch,
      // recorded and listed with when it is held until (the web shows it without a pop-up meanwhile). Only URGENT goes, and a P0 the
      // Security Copilot fixes on its own (`payload.selfFixing`) is no person's job at night, so it waits as ATTENTION.
      const quiet = await ownerQuietNow(settings, parsed.ownerUserId, new Date(now()));
      const night = quiet.quiet && (parsed.severity !== "URGENT" || parsed.payload.selfFixing === true) ? quiet : null;
      const input = night ? { ...parsed, severity: parsed.severity === "URGENT" ? "ATTENTION" as const : parsed.severity, payload: { ...parsed.payload, heldUntil: night.wakeAt } } : parsed;
      const { notification: raised, created } = await deps.repository.raise({ ...input, reopen: options.realert === true });
      let notification = raised;
      // Goal 7365014c-d: a card the operator chose "Always answer like this" for is answered before anyone is alerted, Nous included
      // (R24-2: a review held for Nous first keeps the operator's own standing answer).
      const answered = created && needsYou(notification) && deps.nous?.autoAnswer
        ? await deps.nous.autoAnswer(notification).catch((error) => { deps.log?.warn({ err: error, notificationId: notification.id }, "Notification auto-answer failed."); return null; }) : null;
      if (answered) notification = answered;
      // Ask Last step 7: a new copilot question goes to Nous first (its inbox line below), up to an hour; only a new record is held, so
      // a producer refreshing a released question never holds it again.
      const forNous = !covered && created && !answered && !handsText && Boolean(notification.dedupeKey) && isNousFirstCard(notification) && parsed.severity !== "URGENT" && !awaited
        && Boolean(await deps.nous?.holdsCopilotQuestions?.(input.ownerUserId).catch(() => false));
      if (forNous) notification = (await deps.repository.raise({ ...input, payload: { ...input.payload,
        heldForNous: { until: new Date(Date.parse(now()) + NOUS_QUESTION_HOLD_MS).toISOString() } } })).notification;
      await publish(created ? "NOTIFICATION_CREATED" : "NOTIFICATION_UPDATED", notification);
      if ((created || options.realert || keptHold) && !answered) {
        const channels = resolveNotificationSettings(settings?.notifications);
        // What only the operator's hands can do (handoff, CAPTCHA, sign-in, NEEDS_USER) never waits for Nous.
        const hands = input.severity === "URGENT" || needsOperatorHands(input.source, input.kind) || handsText;
        const forNousNow = forNous || keptHold || (input.severity === "ATTENTION" && input.source !== "NOUS" && !hands && !awaited && Boolean(await deps.nous?.held(input.ownerUserId).catch(() => false)));
        const quietHeld = options.held === true || night?.quiet === true;
        const held = quietHeld || forNousNow;
        // N2/R6: a card Nous leaves to the operator (released while Nous is on) reaches NOUS and ALL phones; ALL phones also get what waits
        // for Nous, never an approval "May send" covers (operator 2/11) and never in quiet hours.
        const released = Boolean(input.payload.releasedFromNous);
        const levels: readonly PushLevel[] | null = quietHeld ? null : !forNousNow ? (hands ? ["HANDS", "NOUS", "ALL"] : ["NOUS", "ALL"])
          : released ? ["NOUS", "ALL"] : covered ? null : ["ALL"];
        const telegram = !held && (input.telegram ?? (notificationChannelEnabled(channels, input.source, "telegram") && input.severity !== "INFO"));
        if (telegram && !settings?.suppressNotifications) {
          const sent = options.telegramSend ? await options.telegramSend(`${NOTIFICATION_SOURCE_LABELS[notification.source]}: ${notification.title}${notification.body ? `\n${notification.body}` : ""}`)
            .catch((error) => { deps.log?.warn({ err: error, notificationId: notification.id }, "Notification Telegram direct send failed."); return false; }) : false;
          // A producer's own send that names its chat message is recorded delivered, so its Thread can edit it later (step 4b).
          if (!sent || typeof sent === "string") await deps.repository.enqueueTelegram(notification, { source: NOTIFICATION_SOURCE_LABELS[notification.source] }, created ? undefined : notification.updatedAt,
            typeof sent === "string" ? sent : undefined)
            .catch((error) => deps.log?.warn({ err: error, notificationId: notification.id }, "Notification Telegram enqueue failed."));
        }
        // Like Telegram: what needs the user, per the channel and source switches; the producer's Telegram override is Telegram's own.
        const pushed = levels && !settings?.suppressNotifications && input.severity !== "INFO" && notificationChannelEnabled(channels, input.source, "push");
        if (pushed && deps.push) {
          void sendPush(deps.push, notification, levels).catch((error: unknown) => deps.log?.warn({ err: error, notificationId: notification.id }, "Notification push failed."));
        }
        // The Nous app's wake (Nous Pro phase 2b): the same decision as a push to a phone on the default level, an opaque id only.
        if (pushed && levels.includes("NOUS") && wake) void wake(notification.ownerUserId, input.severity === "URGENT").catch((error: unknown) => deps.log?.warn({ err: error, notificationId: notification.id }, "Mobile wake failed."));
        // A held card refreshed with a new ask reaches Nous again (its inbox line is replaced by the newer one).
        if (created || keptHold) deps.nous?.raised(notification);
      }
      const language = agentLanguageOf(settings);
      if (created && notification.source === "NOUS" && needsYou(notification)) {
        await dropCarriedDuplicates(notification.ownerUserId).catch((error: unknown) => deps.log?.warn({ err: error, notificationId: notification.id }, "Carried card dedupe failed."));
      }
      if (deps.translate && !answered && needsYou(notification)) {
        void translateLater(notification, language).catch((error: unknown) => deps.log?.warn({ err: error, notificationId: notification.id }, "Notification translation failed."));
        void translateMailLater(notification, language).catch((error: unknown) => deps.log?.warn({ err: error, notificationId: notification.id }, "Notification mail translation failed."));
      }
      return notification;
    },
    get: (owner: string, id: string) => deps.repository.get(owner, id),
    dropCarriedDuplicates,
    /** The owner's night now: a producer with its own direct line (the Room Agent's Telegram notice) waits too. */
    quiet: async (owner: string) => (await ownerQuietNow(await deps.userSettings(owner).catch(() => null), owner, new Date(now()))).quiet,
    pushAvailable: () => Boolean(deps.push),
    /** The mobile wake sender (mobile/wake.ts), set where the device repository lives (app-signin.ts) when SPACE_MOBILE_PUSH_URL is. */
    setWake(sender: MobileWake | null) { wake = sender; },
    setThreadOf(lookup: typeof threadOf) { threadOf = lookup; },
    setMail(reader: CardMailReader | null) { mailOf = reader; },
    clearThreadPush,
    telegramMessageIds: (owner: string, refs: readonly string[]) => deps.repository.telegramMessageIds(owner, refs),
    registerPushDevice: (owner: string, device: PushDeviceRegistration) => deps.repository.registerPushDevice(owner, device),
    removePushDevice: (owner: string, token: string) => deps.repository.removePushDevice(owner, token),
    listPushDevices: async (owner: string, currentToken: string | null): Promise<PushDevice[]> =>
      (await deps.repository.pushDevices(owner)).map(({ token, ...device }) => ({ id: pushDeviceId(token), ...device, isCurrent: token === currentToken })),
    removePushDeviceById: async (owner: string, id: string) => {
      const device = (await deps.repository.pushDevices(owner)).find((candidate) => pushDeviceId(candidate.token) === id);
      return device ? await deps.repository.removePushDevice(owner, device.token) : false;
    },
    list: async (owner: string, query: NotificationListQuery, browserLanguages: readonly string[] = []) => {
      let records = await deps.repository.list(owner, query);
      // nous_msg:0cb8d563: a card raised before its files were resolved gets them when Needs you is read, once (stored, an empty list too).
      if (deps.nous?.agentFiles && query.status === "NEEDS_YOU" && records.some((record) => !Array.isArray(record.payload.files))) {
        // shortcut: a file filed after the card's first read shows only if the card is raised again; upgrade by re-resolving on artifact writes.
        const owned = deps.nous.agentFiles(owner);
        owned.catch(() => undefined);
        records = await Promise.all(records.map(async (record) => {
          if (Array.isArray(record.payload.files) || !needsYou(record)) return record;
          const files = await cardFiles(record, owned).catch((error: unknown) => { deps.log?.warn({ err: error }, "Needs you files could not be read."); return null; });
          return files ? await deps.repository.addPayload(owner, record.id, { files }).catch(() => null) ?? { ...record, payload: { ...record.payload, files } } : record;
        }));
      }
      // A card raised before the operator chose their language (or whose translation failed) is translated when Needs you is read.
      if (deps.translate && query.status === "NEEDS_YOU") {
        const language = agentLanguageOf(await deps.userSettings(owner).catch(() => null), browserLanguages);
        for (const record of records) {
          void translateLater(record, language).catch((error: unknown) => deps.log?.warn({ err: error, notificationId: record.id }, "Notification translation failed."));
          void translateMailLater(record, language).catch((error: unknown) => deps.log?.warn({ err: error, notificationId: record.id }, "Notification mail translation failed."));
        }
      }
      return records;
    },
    pending: (owner: string) => deps.repository.pending(owner),
    /** Every record still waiting (open or read), read whole. */
    waiting: (owner: string) => everyRecord(owner, { status: "WAITING" }),
    unresolvedBySource: (source: NotificationSource) => deps.repository.unresolvedBySource(source),
    async setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">, payload?: Record<string, unknown>, reason = "resolved directly (space_resolve_notification)"): Promise<SpaceNotification | null> {
      const before = status === "RESOLVED" && askEndedListeners.size ? await deps.repository.get(owner, id) : null;
      const updated = await deps.repository.setStatus(owner, id, status, payload);
      if (updated) await publish("NOTIFICATION_UPDATED", updated);
      if (updated?.status === "RESOLVED" && waiting(before)) tellAskEnded([before], reason);
      return updated;
    },
    /** R13-6: what a waiting record learned (an answer that failed), its status unchanged. */
    async addPayload(owner: string, id: string, payload: Record<string, unknown>): Promise<SpaceNotification | null> {
      const updated = await deps.repository.addPayload(owner, id, payload);
      if (updated) await publish("NOTIFICATION_UPDATED", updated);
      return updated;
    },
    async readAll(owner: string, only?: string): Promise<number> {
      const count = await deps.repository.readAll(owner, only);
      if (count) {
        const latest = (await deps.repository.list(owner, { status: "ALL", limit: 1 }))[0];
        if (latest) await publish("NOTIFICATION_UPDATED", latest);
      }
      return count;
    },
    /**
     * A copilot question held for Nous goes to the operator: Nous put it on a card, its hour ended, or Nous is off or paused. The usual
     * needs-you path follows, alerted once (`alertAt` makes the web deliver the same record again). Null when it was not held or is done.
     */
    /** `add` is what Nous forwards with it (its note in the body, its recommendation in the payload). */
    async releaseHeldForNous(owner: string, id: string, add: { body?: string; payload?: Record<string, unknown> } = {}): Promise<SpaceNotification | null> {
      const item = await deps.repository.get(owner, id);
      if (!item?.dedupeKey || !item.payload.heldForNous || (item.status !== "OPEN" && item.status !== "READ")) return null;
      const payload = { ...item.payload };
      delete payload.heldForNous;
      return service.raise({ ownerUserId: owner, roomId: item.roomId, paneId: item.paneId, source: item.source, kind: item.kind, severity: item.severity,
        title: item.title, body: add.body ?? item.body, link: item.link, dedupeKey: item.dedupeKey, payload: { ...payload, ...add.payload, alertAt: now(), releasedFromNous: now() }, telegram: null }, { realert: true });
    },
    /** A question answered or a thread handled resolves its open notification. */
    async resolve(owner: string, dedupeKey: string, reason = "resolved"): Promise<number> {
      const before = (await deps.repository.list(owner, { status: "WAITING", dedupeKey, limit: 200 })).filter((item) => item.dedupeKey === dedupeKey);
      // 17/11 (card 1e91952e closed 7 s after it was raised, no trace of why): each card records what closed it.
      for (const item of before) await deps.repository.addPayload(owner, item.id, { resolvedReason: reason.slice(0, 300) }).catch(() => null);
      let count = await deps.repository.resolveByDedupeKey(owner, dedupeKey);
      const closed: SpaceNotification[] = count ? before.map((item) => ({ ...item, status: "RESOLVED" as const })) : [];
      // 2/11: a key merged into another open card (the same topic) closes that card.
      if (!count) for (const item of (await everyRecord(owner, { status: "WAITING", payloadHas: "mergedKeys" })).filter((entry) => Array.isArray(entry.payload.mergedKeys) && entry.payload.mergedKeys.includes(dedupeKey))) {
        const updated = await deps.repository.setStatus(owner, item.id, "RESOLVED");
        if (updated?.status === "RESOLVED") { count += 1; closed.push(updated); }
      }
      if (count && ASK_KEY.test(dedupeKey) && askEndedListeners.size && before.some(waiting)) tellAskEnded(before.filter(waiting), reason);
      // Each card it closed is announced (the inbox follows a decision answered anywhere); the newest record only when none was listed.
      for (const item of closed) await publish("NOTIFICATION_UPDATED", item);
      if (count && !closed.length) {
        const latest = (await deps.repository.list(owner, { status: "ALL", limit: 1 }))[0];
        if (latest) await publish("NOTIFICATION_UPDATED", latest);
      }
      return count;
    },
    prune: () => deps.repository.prune(new Date(Date.parse(now()) - NOTIFICATION_RETENTION_MS).toISOString()),
    /**
     * At the end of the operator's night: ONE "Good morning" alert per wake time with everything held that still waits, counted by kind
     * (plan clipboard:9XSwTPyxXP1W; every kind since 31/10). Returns the batch, or null when nothing waits. Safe to call every minute:
     * a wake time is batched once.
     */
    async morningBatch(owner: string): Promise<SpaceNotification | null> {
      const at = Date.parse(now());
      // Every open record (until 31/10 the newest 200: a busy night left held ones out of the batch).
      const held = (await everyRecord(owner, { status: "OPEN" }))
        .filter((item) => item.kind !== "MORNING_BATCH" && typeof item.payload?.heldUntil === "string" && Date.parse(item.payload.heldUntil as string) <= at && Date.parse(item.payload.heldUntil as string) > at - 12 * 3_600_000);
      if (!held.length) return null;
      const wakeAt = held.map((item) => item.payload.heldUntil as string).sort().at(-1)!;
      if (batched.has(`${owner}|${wakeAt}`)) return null;
      batched.add(`${owner}|${wakeAt}`);
      const kindOf = (item: SpaceNotification) => item.kind.startsWith("DECISION_") ? "decision" : isHandRequest(item.source, item.kind) ? "hands"
        : /REVIEW/.test(item.kind) ? "review" : /QUESTION/.test(item.kind) ? "question" : item.kind === "REQUEST_DONE" ? "done" : item.severity === "INFO" ? "info" : "other";
      const counts = new Map<string, number>();
      for (const item of held) counts.set(kindOf(item), (counts.get(kindOf(item)) ?? 0) + 1);
      const summary = ["decision", "review", "question", "hands", "done", "info", "other"].filter((kind) => counts.has(kind))
        .map((kind) => { const count = counts.get(kind)!; return kind === "hands" || kind === "info" || kind === "other" ? `${count} ${kind}` : `${count} ${kind}${count === 1 ? "" : "s"}`; });
      // A phone paired at night alerted at once (URGENT is never held); the morning names it again so it is not missed (Nous Pro 1b, no mail).
      const paired = (await deps.repository.list(owner, { status: "ALL", source: "SYSTEM", kind: "MOBILE_PAIRED", limit: 200 }))
        .filter((item) => Date.parse(item.createdAt) > at - 12 * 3_600_000 && !held.some((entry) => entry.id === item.id));
      if (paired.length) { counts.set("paired", paired.length); summary.push(`${paired.length} phone${paired.length === 1 ? "" : "s"} paired`); }
      const lines = [...held, ...paired].map((item) => `- ${NOTIFICATION_SOURCE_LABELS[item.source]}: ${item.title}`);
      return service.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "MORNING_BATCH", severity: "ATTENTION",
        title: `Good morning: ${held.length} held overnight (${summary.join(", ")})`, body: lines.join("\n"),
        link: {}, dedupeKey: `quiet:morning:${wakeAt}`, payload: { notificationIds: held.map((item) => item.id), counts: Object.fromEntries(counts) }, telegram: null });
    },
    /**
     * The operator is active at night (operator 1/11 23:08 BKK): what quiet hours held is theirs now. Each held record loses its
     * `heldUntil` and is alerted once in the open tab (`alertAt`); the morning batch no longer counts it. Returns how many.
     */
    async releaseQuietHeld(owner: string): Promise<number> {
      const at = now();
      const held = (await everyRecord(owner, { status: "WAITING", payloadHas: "heldUntil" }))
        .filter((item) => typeof item.payload?.heldUntil === "string" && Date.parse(item.payload.heldUntil as string) > Date.parse(at));
      for (const item of held) {
        const updated = await deps.repository.addPayload(owner, item.id, { heldUntil: null, alertAt: at });
        if (updated) await publish("NOTIFICATION_UPDATED", updated);
      }
      return held.length;
    },
    /** Runs morningBatch for every owner each minute; returns the stop (the app's onClose). */
    startMorningBatches(owners: () => Promise<string[]>, intervalMs = 60_000): () => void {
      const timer = setInterval(() => void owners().then((list) => Promise.all(list.map((owner) => service.morningBatch(owner))))
        .catch((error: unknown) => deps.log?.warn({ err: error }, "Morning batch failed.")), intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    }
  };
  return service;
}
export type NotificationService = ReturnType<typeof createNotificationService>;

/**
 * An appointment reminder rings like a calendar alert in the Nous app (operator 17/11, nous_msg:e58363a2): its own «Ραντεβού» channel,
 * the appointment and its time as the title (no source prefix), and with a join link the «Μπες» action (`categoryId`) that opens it.
 */
function appointmentPush(notification: SpaceNotification): Record<string, string> {
  if (notification.kind !== "APPOINTMENT_REMINDER") return {};
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const joinUrl = /^https?:\/\//i.test(text(notification.payload.joinUrl)) ? text(notification.payload.joinUrl) : "";
  const startsAt = text(notification.payload.startsAt);
  return { kind: "APPOINTMENT_REMINDER", channelId: "appointments", title: notification.title, ...(startsAt ? { startsAt } : {}), ...(joinUrl ? { joinUrl, categoryId: "appointment" } : {}) };
}
