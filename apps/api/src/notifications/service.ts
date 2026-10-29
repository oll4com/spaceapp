import {
  NOTIFICATION_SOURCE_LABELS, eventSchema, notificationChannelEnabled, notificationRaiseInputSchema, resolveNotificationSettings,
  type Event, type NotificationListQuery, type NotificationRaiseInput, type NotificationSource, type NotificationStatus, type NotificationStreamPayload, type PushDeviceRegistration, type SpaceNotification, type UserSettings, isCopilotQuestion, isHandRequest, needsOperatorHands, needsYou } from "@space/contracts";
import type { SpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, type SpaceEventBus } from "@space/runtime";
import type { FcmSender } from "./fcm.js";
import { ownerQuietState } from "../owner-clock.js";

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
    /** Goal 7365014c-d: answers a new needs-you card of a kind the operator always answers the same way; its ACKED record, or null. */
    autoAnswer?(notification: SpaceNotification): Promise<SpaceNotification | null> };
  log?: { warn(meta: Record<string, unknown>, message: string): void };
  now?(): string;
}

/** How long a copilot's question waits for Nous before it reaches the operator anyway (Ask Last step 7). */
export const NOUS_QUESTION_HOLD_MS = 60 * 60_000;

/** Kept for 30 days, then pruned, except unresolved ATTENTION and URGENT items, which stay until resolved (Record Retention Invariant). */
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 3_600_000;

export function createNotificationService(deps: NotificationServiceDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
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

  async function sendPush(push: FcmSender, notification: SpaceNotification) {
    const data = { notificationId: notification.id, title: `${NOTIFICATION_SOURCE_LABELS[notification.source]}: ${notification.title}`, body: notification.body.slice(0, 240) };
    for (const token of await deps.repository.pushTokens(notification.ownerUserId)) {
      const result = await push.send(token, data).catch((error: unknown) => { deps.log?.warn({ err: error, notificationId: notification.id }, "Notification push failed."); return "FAILED" as const; });
      if (result === "INVALID_TOKEN") await deps.repository.disablePushDevice(token);
    }
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
    async raise(rawInput: NotificationRaiseInput, options: { realert?: boolean; held?: boolean; telegramSend?: (text: string) => Promise<boolean> } = {}): Promise<SpaceNotification> {
      const parsed = notificationRaiseInputSchema.parse(rawInput);
      const settings = await deps.userSettings(parsed.ownerUserId).catch(() => null);
      // The operator's night (plan clipboard:9XSwTPyxXP1W): a hand request waits for the morning batch, recorded with when it is held
      // until (the web shows it without a pop-up meanwhile). URGENT never waits.
      const night = parsed.severity !== "URGENT" && isHandRequest(parsed.source, parsed.kind) ? ownerQuietState(settings, new Date(now())) : null;
      const input = night?.quiet ? { ...parsed, payload: { ...parsed.payload, heldUntil: night.wakeAt } } : parsed;
      let { notification, created } = await deps.repository.raise({ ...input, reopen: options.realert === true });
      // Ask Last step 7: a new copilot question goes to Nous first (its inbox line below), up to an hour; only a new record is held, so
      // a producer refreshing a released question never holds it again.
      const forNous = created && Boolean(notification.dedupeKey) && isCopilotQuestion(notification) && parsed.severity !== "URGENT"
        && Boolean(await deps.nous?.holdsCopilotQuestions?.(input.ownerUserId).catch(() => false));
      if (forNous) notification = (await deps.repository.raise({ ...input, payload: { ...input.payload,
        heldForNous: { until: new Date(Date.parse(now()) + NOUS_QUESTION_HOLD_MS).toISOString() } } })).notification;
      // Goal 7365014c-d: a card the operator chose "Always answer like this" for is answered before anyone is alerted.
      const answered = created && !forNous && needsYou(notification) && deps.nous?.autoAnswer
        ? await deps.nous.autoAnswer(notification).catch((error) => { deps.log?.warn({ err: error, notificationId: notification.id }, "Notification auto-answer failed."); return null; }) : null;
      if (answered) notification = answered;
      await publish(created ? "NOTIFICATION_CREATED" : "NOTIFICATION_UPDATED", notification);
      if ((created || options.realert) && !answered) {
        const channels = resolveNotificationSettings(settings?.notifications);
        // What only the operator's hands can do (handoff, CAPTCHA, sign-in, NEEDS_USER) never waits for Nous.
        const held = options.held === true || night?.quiet === true || forNous
          || (input.severity === "ATTENTION" && input.source !== "NOUS" && !needsOperatorHands(input.source, input.kind) && Boolean(await deps.nous?.held(input.ownerUserId).catch(() => false)));
        const telegram = !held && (input.telegram ?? (notificationChannelEnabled(channels, input.source, "telegram") && input.severity !== "INFO"));
        if (telegram && !settings?.suppressNotifications) {
          const sent = options.telegramSend ? await options.telegramSend(`${NOTIFICATION_SOURCE_LABELS[notification.source]}: ${notification.title}${notification.body ? `\n${notification.body}` : ""}`)
            .catch((error) => { deps.log?.warn({ err: error, notificationId: notification.id }, "Notification Telegram direct send failed."); return false; }) : false;
          if (!sent) await deps.repository.enqueueTelegram(notification, { source: NOTIFICATION_SOURCE_LABELS[notification.source] }, created ? undefined : notification.updatedAt)
            .catch((error) => deps.log?.warn({ err: error, notificationId: notification.id }, "Notification Telegram enqueue failed."));
        }
        // Like Telegram: what needs the user, per the channel and source switches; the producer's Telegram override is Telegram's own.
        if (deps.push && !held && !settings?.suppressNotifications && input.severity !== "INFO" && notificationChannelEnabled(channels, input.source, "push")) {
          void sendPush(deps.push, notification).catch((error: unknown) => deps.log?.warn({ err: error, notificationId: notification.id }, "Notification push failed."));
        }
        if (created) deps.nous?.raised(notification);
      }
      return notification;
    },
    get: (owner: string, id: string) => deps.repository.get(owner, id),
    pushAvailable: () => Boolean(deps.push),
    registerPushDevice: (owner: string, device: PushDeviceRegistration) => deps.repository.registerPushDevice(owner, device),
    removePushDevice: (owner: string, token: string) => deps.repository.removePushDevice(owner, token),
    list: (owner: string, query: NotificationListQuery) => deps.repository.list(owner, query),
    pending: (owner: string) => deps.repository.pending(owner),
    unresolvedBySource: (source: NotificationSource) => deps.repository.unresolvedBySource(source),
    async setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">, payload?: Record<string, unknown>): Promise<SpaceNotification | null> {
      const updated = await deps.repository.setStatus(owner, id, status, payload);
      if (updated) await publish("NOTIFICATION_UPDATED", updated);
      return updated;
    },
    async readAll(owner: string): Promise<number> {
      const count = await deps.repository.readAll(owner);
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
    async releaseHeldForNous(owner: string, id: string): Promise<SpaceNotification | null> {
      const item = await deps.repository.get(owner, id);
      if (!item?.dedupeKey || !item.payload.heldForNous || (item.status !== "OPEN" && item.status !== "READ")) return null;
      const { heldForNous: _held, ...payload } = item.payload;
      return service.raise({ ownerUserId: owner, roomId: item.roomId, paneId: item.paneId, source: item.source, kind: item.kind, severity: item.severity,
        title: item.title, body: item.body, link: item.link, dedupeKey: item.dedupeKey, payload: { ...payload, alertAt: now() }, telegram: null }, { realert: true });
    },
    /** A question answered or a thread handled resolves its open notification. */
    async resolve(owner: string, dedupeKey: string): Promise<number> {
      const count = await deps.repository.resolveByDedupeKey(owner, dedupeKey);
      if (count) {
        const latest = (await deps.repository.list(owner, { status: "ALL", limit: 1 }))[0];
        if (latest) await publish("NOTIFICATION_UPDATED", latest);
      }
      return count;
    },
    prune: () => deps.repository.prune(new Date(Date.parse(now()) - NOTIFICATION_RETENTION_MS).toISOString()),
    /**
     * At the end of the operator's night: ONE "Morning batch" alert per wake time with the hand requests still open, per pane (plan
     * clipboard:9XSwTPyxXP1W). Returns the batch, or null when nothing waits. Safe to call every minute: a wake time is batched once.
     */
    async morningBatch(owner: string): Promise<SpaceNotification | null> {
      const at = Date.parse(now());
      const held = (await deps.repository.list(owner, { status: "OPEN", limit: 200 }))
        .filter((item) => typeof item.payload?.heldUntil === "string" && Date.parse(item.payload.heldUntil as string) <= at && Date.parse(item.payload.heldUntil as string) > at - 12 * 3_600_000);
      if (!held.length) return null;
      const wakeAt = held.map((item) => item.payload.heldUntil as string).sort().at(-1)!;
      if (batched.has(`${owner}|${wakeAt}`)) return null;
      batched.add(`${owner}|${wakeAt}`);
      const lines = held.map((item) => `- ${NOTIFICATION_SOURCE_LABELS[item.source]}: ${item.title}`);
      return service.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "MORNING_BATCH", severity: "ATTENTION",
        title: `Good morning: ${held.length} thing${held.length === 1 ? "" : "s"} wait for your hands`, body: lines.join("\n").slice(0, 2_000),
        link: {}, dedupeKey: `quiet:morning:${wakeAt}`, payload: { notificationIds: held.map((item) => item.id) }, telegram: null });
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
