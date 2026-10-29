import { z } from "zod";

/**
 * Space notifications: one record per thing a pane or service wants the operator to see, owned by a user,
 * delivered through the channels the user turned on (in-app badges and toasts, sound, browser desktop
 * notifications, Telegram) and kept in the Notification Center until read or acknowledged.
 */
export const NOTIFICATION_SOURCES = ["MAIL_COPILOT", "JOB_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "DESIGN", "APP_STUDIO", "VIDEO", "SECURITY_COPILOT", "MONITORING_COPILOT", "ROOM_AGENT", "COUNCIL", "NOUS", "BROWSER_HANDOFF", "ROOM_WATCHDOG", "SYSTEM", "AGENT"] as const;
export const notificationSourceSchema = z.enum(NOTIFICATION_SOURCES);
export type NotificationSource = z.infer<typeof notificationSourceSchema>;
/**
 * What only the operator's own hands can do: a CAPTCHA or browser handoff, a sign-in, a copilot's NEEDS_USER click. It reaches
 * them at once in the app, on the desktop and on Telegram and never waits for Nous (operator rule 2026-10-17, plan clipboard:xEQOrVRQgeAn).
 */
export const needsOperatorHands = (source: NotificationSource, kind: string) => source === "BROWSER_HANDOFF" || /SIGN_IN|LOGIN|CAPTCHA|HANDOFF|NEEDS_USER|NEEDS_YOU/i.test(kind);
export const NOTIFICATION_SOURCE_LABELS: Record<NotificationSource, string> = {
  MAIL_COPILOT: "Mail Copilot", JOB_COPILOT: "Job Copilot", MARKETING_COPILOT: "Marketing Copilot", FREELANCE_COPILOT: "Freelance Copilot", DESIGN: "Design", APP_STUDIO: "App Studio", VIDEO: "Video", SECURITY_COPILOT: "Security Copilot", MONITORING_COPILOT: "Monitoring Copilot", ROOM_AGENT: "Room Agent", COUNCIL: "Council", NOUS: "Nous", BROWSER_HANDOFF: "Browser", ROOM_WATCHDOG: "Room watchdog", SYSTEM: "Space", AGENT: "Agent"
};
/**
 * Needs you (operator request 2026-10-24): a notification on a pane whose kind needs the operator there (hands, a question, a review or
 * approval, a CLI prompt waiting for them, a CLI's explicit needs-you, Nous's card). The web brings them to the pane for it instead of
 * showing a toast, and takes them back when it resolves. Never INFO; failures, "posts due" and finished work stay toasts.
 */
export const NEEDS_YOU_KINDS = /^(NEEDS_HANDS|NEEDS_YOU|NEEDS_USER|QUESTION|REVIEW_REQUESTED|RULE_PROPOSED|CAMPAIGN_PROPOSED|CLIENT_READY|HANDOFF_REQUESTED|BROWSER_HANDOFF_REQUESTED|WAITING|SIGN_IN|STUCK|USAGE_LIMIT|OVERLAP|(?:DESIGN|VIDEO)_(?:APPROVAL|QUESTION)|APP_STUDIO_QUESTION|SECURITY_(?:QUESTION|REVIEW)|MONITORING_(?:QUESTION|REVIEW))$/;
export const needsYou = (notification: { source: NotificationSource; kind: string; severity: NotificationSeverity; paneId: string | null; roomId: string | null }) =>
  Boolean(notification.paneId && notification.roomId) && notification.severity !== "INFO" && NEEDS_YOU_KINDS.test(notification.kind);

/** The copilots whose questions go to Nous first and are swept once answered (Ask Last step 7, 2026-10-27). */
export const COPILOT_QUESTION_SOURCES: readonly NotificationSource[] = ["JOB_COPILOT", "MAIL_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "DESIGN", "APP_STUDIO",
  "VIDEO", "SECURITY_COPILOT", "MONITORING_COPILOT"];
/** A copilot's question to the operator: its source, and a QUESTION kind or a `…:question:<id>` dedupe key. */
export const isCopilotQuestion = (notification: { source: NotificationSource; kind: string; dedupeKey: string | null }) =>
  COPILOT_QUESTION_SOURCES.includes(notification.source) && (/QUESTION/i.test(notification.kind) || /:question:/i.test(notification.dedupeKey ?? ""));
/** The question's item id: the card's ask target, else the dedupe key's last `prefix:id` (job-apply:question:jobq:x → jobq:x). */
export function copilotQuestionItemId(notification: { dedupeKey: string | null; payload: Record<string, unknown> }): string | null {
  const answer = (notification.payload.ask as { answer?: { questionId?: unknown } } | undefined)?.answer;
  if (typeof answer?.questionId === "string") return answer.questionId;
  const parts = notification.dedupeKey?.split(":") ?? [];
  return parts.length >= 2 ? parts.slice(-2).join(":") : null;
}
/** Held for Nous until this time (`payload.heldForNous.until`): out of Needs you, the banner, Telegram, push and the desktop pop-up. */
export function heldForNous(notification: { payload: Record<string, unknown> }, at = Date.now()): boolean {
  const until = (notification.payload.heldForNous as { until?: unknown } | undefined)?.until;
  return typeof until === "string" && Date.parse(until) > at;
}

export const notificationSeveritySchema = z.enum(["INFO", "ATTENTION", "URGENT"]);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;
export const notificationStatusSchema = z.enum(["OPEN", "READ", "ACKED", "RESOLVED"]);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

const isoDateTime = z.string().datetime({ offset: true });
export const notificationIdSchema = z.string().regex(/^notification:[A-Za-z0-9_-]{6,80}$/);

/** Where a click takes the operator: a room, a pane in it, a side surface, and a pane-specific target ("thread:<account>:<id>"). */
export const notificationLinkSchema = z.object({
  roomId: z.string().min(1).max(200).optional(),
  paneId: z.string().min(1).max(200).optional(),
  surface: z.string().min(1).max(60).optional(),
  target: z.string().min(1).max(500).optional()
}).strict();
export type NotificationLink = z.infer<typeof notificationLinkSchema>;

export const spaceNotificationSchema = z.object({
  id: notificationIdSchema,
  ownerUserId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200).nullable(),
  paneId: z.string().min(1).max(200).nullable(),
  source: notificationSourceSchema,
  /** Free kind inside the source ("MAIL_RECEIVED", "HANDOFF_REQUESTED", …). */
  kind: z.string().min(1).max(60),
  severity: notificationSeveritySchema,
  title: z.string().min(1).max(200),
  body: z.string().max(2000),
  link: notificationLinkSchema,
  /** One open notification per key; raising the same key again refreshes it instead of adding another. */
  dedupeKey: z.string().max(200).nullable(),
  status: notificationStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  readAt: isoDateTime.nullable(),
  ackedAt: isoDateTime.nullable(),
  resolvedAt: isoDateTime.nullable()
}).strict();
export type SpaceNotification = z.infer<typeof spaceNotificationSchema>;

/**
 * Needs you as questions (operator request 2026-10-27, plan clipboard:5AQvaoSR-IZa): the ONE question a needs-you record asks, its
 * options (the recommended one marked) and where the operator's answer goes, kept in payload.ask. PANE: the pane's next prompt;
 * COPILOT_QUESTION: the copilot's own answer path; COPILOT_DECISION: approve or decline its review or rule; NOUS: Nous's message;
 * MAIL_FIX: an option acknowledges, words hand the mail to Mail Copilot's Send to AI; ACK: acknowledged only.
 */
export const needsYouAnswerKindSchema = z.enum(["PANE", "COPILOT_QUESTION", "COPILOT_DECISION", "NOUS", "MAIL_FIX", "ACK"]);
export const needsYouAskSchema = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(80)).max(6).optional(),
  recommended: z.string().trim().min(1).max(80).optional(),
  answer: z.object({
    kind: needsYouAnswerKindSchema,
    copilot: z.string().min(1).max(40).optional(),
    questionId: z.string().min(1).max(200).optional(),
    item: z.enum(["REVIEW", "RULE", "CAMPAIGN", "LEAD"]).optional(),
    itemId: z.string().min(1).max(200).optional(),
    account: z.string().min(1).max(320).optional(),
    threadId: z.string().min(1).max(200).optional()
  }).strict()
}).strict().refine((ask) => !ask.recommended || (ask.options ?? []).includes(ask.recommended), { message: "recommended must be one of the options", path: ["recommended"] });
export type NeedsYouAsk = z.infer<typeof needsYouAskSchema>;

/** An ask from a producer's own words, clipped to the schema's bounds (at most 6 options; a recommendation that is not an option is dropped). */
export function makeNeedsYouAsk(question: string, answer: NeedsYouAsk["answer"], options: readonly string[] = [], recommended?: string | null): NeedsYouAsk {
  const clip = (text: string, max: number) => { const value = text.replace(/\s+/g, " ").trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
  const picks = [...new Set(options.map((option) => clip(option, 80)).filter(Boolean))].slice(0, 6);
  const best = recommended ? clip(recommended, 80) : "";
  return { question: clip(question, 300) || "What should happen next?", ...(picks.length ? { options: picks } : {}), ...(best && picks.includes(best) ? { recommended: best } : {}), answer };
}

/** A record's ask: its payload.ask, or (older records and producers without one) the body's first line, answered through Nous. */
export function needsYouAsk(notification: Pick<SpaceNotification, "title" | "body" | "payload">): NeedsYouAsk {
  const parsed = needsYouAskSchema.safeParse(notification.payload.ask);
  if (parsed.success) return parsed.data;
  const first = notification.body.split("\n").map((line) => line.trim()).find(Boolean) ?? notification.title;
  return { question: first.length > 300 ? `${first.slice(0, 299)}…` : first, answer: { kind: "NOUS" } };
}

/**
 * Goal 7365014c-d: what "Always answer like this" stores for a needs-you card, or null when it may not: no recommended option, or a
 * handoff, sign-in, CAPTCHA or other hands item. The kind holds the source, the record kind, the question's shape (numbers as #), the
 * options and the recommended option itself, so a later card with the same question but another recommendation is never answered for them.
 */
export function needsYouAnswerKind(record: Pick<SpaceNotification, "source" | "kind" | "title" | "body" | "payload">): { key: string; label: string } | null {
  const ask = needsYouAsk(record);
  if (!ask.recommended || record.source === "BROWSER_HANDOFF" || /SIGN_IN|LOGIN|CAPTCHA|HANDOFF|NEEDS_USER|NEEDS_HANDS/i.test(record.kind)) return null;
  const shape = ask.question.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  return { key: `needs-you:${record.source}:${record.kind}:${shape}:${(ask.options ?? []).join("|")}:${ask.recommended}`.slice(0, 2_000),
    label: `answer "${ask.recommended}" when ${record.source.toLowerCase().replace(/_/g, " ")} asks "${ask.question.slice(0, 160)}"` };
}

/** The operator's answer to a needs-you record (POST /api/notifications/:id/answer): one of its options, words, or both. */
export const notificationAnswerInputSchema = z.object({
  option: z.string().trim().min(1).max(80).optional(),
  text: z.string().trim().min(1).max(2000).optional(),
  /** "Always answer like this": with the recommended option, the next card of this kind is answered with it (needsYouAnswerKind). */
  always: z.boolean().optional()
}).strict().refine((input) => input.option || input.text, { message: "Pick an option or write an answer." });
export type NotificationAnswerInput = z.infer<typeof notificationAnswerInputSchema>;
export const notificationAnswerResultSchema = z.object({ routed: needsYouAnswerKindSchema, display: z.string(), notification: spaceNotificationSchema.nullable() }).strict();
export type NotificationAnswerResult = z.infer<typeof notificationAnswerResultSchema>;

export const notificationRaiseInputSchema = z.object({
  ownerUserId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200).nullable().default(null),
  paneId: z.string().min(1).max(200).nullable().default(null),
  source: notificationSourceSchema,
  kind: z.string().min(1).max(60),
  severity: notificationSeveritySchema.default("INFO"),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(2000).default(""),
  link: notificationLinkSchema.default({}),
  dedupeKey: z.string().max(200).nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Producer override for Telegram (a pane setting); null follows the user's channel settings. */
  telegram: z.boolean().nullable().default(null)
}).strict();
export type NotificationRaiseInput = z.infer<typeof notificationRaiseInputSchema>;

/** What the shared event stream carries: ids only, never title or body, because every signed-in user receives every event. */
export const notificationStreamPayloadSchema = z.object({
  notificationId: notificationIdSchema,
  ownerUserId: z.string().min(1).max(200),
  source: notificationSourceSchema,
  kind: z.string().min(1).max(60),
  severity: notificationSeveritySchema,
  status: notificationStatusSchema,
  roomId: z.string().min(1).max(200).nullable(),
  paneId: z.string().min(1).max(200).nullable()
}).strict();
export type NotificationStreamPayload = z.infer<typeof notificationStreamPayloadSchema>;

export const notificationsPendingSchema = z.object({
  total: z.number().int().min(0),
  bySource: z.record(z.string(), z.number().int().min(0)),
  byRoom: z.record(z.string(), z.number().int().min(0)),
  byPane: z.record(z.string(), z.number().int().min(0)),
  latest: z.array(spaceNotificationSchema).max(50)
}).strict();
export type NotificationsPending = z.infer<typeof notificationsPendingSchema>;

export const notificationListQuerySchema = z.object({
  /** NEEDS_YOU: the needs-you requests still waiting (open or read, not resolved or acknowledged) on panes that are still open. */
  status: z.enum(["OPEN", "ALL", "NEEDS_YOU"]).default("ALL"),
  source: notificationSourceSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  before: isoDateTime.optional()
}).strict();
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/** The user's channel settings; a source may turn its own delivery down further. */
export const notificationChannelOverridesSchema = z.object({
  inApp: z.boolean().optional(),
  desktop: z.boolean().optional(),
  telegram: z.boolean().optional(),
  push: z.boolean().optional()
}).strict();
const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24 hours).");
export const quietHoursSchema = z.object({ enabled: z.boolean().default(true), start: clockTimeSchema.default("23:00"), end: clockTimeSchema.default("09:00") }).strict();
export type QuietHours = z.infer<typeof quietHoursSchema>;
export const defaultQuietHours: QuietHours = { enabled: true, start: "23:00", end: "09:00" };
/** A hand request: only the operator's hands can do it (a handoff, sign-in, CAPTCHA, needs-you, or Nous's per-pane card). */
export const isHandRequest = (source: NotificationSource, kind: string) => needsOperatorHands(source, kind) || (source === "NOUS" && kind === "NEEDS_HANDS");
export const notificationSettingsSchema = z.object({
  channels: z.object({
    /** Badges and the Notification Center. Off keeps the record but shows no badge. */
    inApp: z.boolean().default(true),
    toast: z.boolean().default(true),
    sound: z.boolean().default(true),
    /** Browser desktop notifications while Space is in the background (needs the browser's permission). */
    desktop: z.boolean().default(true),
    /** Telegram through the paired bot, for ATTENTION and URGENT notifications. */
    telegram: z.boolean().default(true),
    /** Push (FCM) to the user's registered Android devices, for ATTENTION and URGENT notifications, also with the app closed. */
    push: z.boolean().default(true)
  }).strict().default({ inApp: true, toast: true, sound: true, desktop: true, telegram: true, push: true }),
  perSource: z.partialRecord(notificationSourceSchema, notificationChannelOverridesSchema).default({}),
  /**
   * The operator's night (operator request 2026-10-20, plan clipboard:9XSwTPyxXP1W), in their working time zone: what needs their hands
   * (handoffs, sign-ins, CAPTCHAs, needs-you, Nous's cards) is recorded without alerts and comes as one morning batch. URGENT never waits.
   */
  quietHours: quietHoursSchema.default(defaultQuietHours)
}).strict();
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const defaultNotificationSettings: NotificationSettings = notificationSettingsSchema.parse({});

export function resolveNotificationSettings(settings: NotificationSettings | null | undefined): NotificationSettings {
  return settings ? notificationSettingsSchema.parse(settings) : defaultNotificationSettings;
}

/** Whether one channel is on for a notification: the channel switch, then the source's own override. */
export function notificationChannelEnabled(settings: NotificationSettings, source: NotificationSource, channel: "inApp" | "desktop" | "telegram" | "push"): boolean {
  const override = settings.perSource[source]?.[channel];
  return override ?? settings.channels[channel];
}

/** An Android device of the user that receives Space notifications as FCM pushes (registered by the app's page). */
export const pushDeviceTokenSchema = z.string().regex(/^[A-Za-z0-9:_.-]{20,4096}$/);
export const pushDeviceRegistrationSchema = z.object({
  token: pushDeviceTokenSchema,
  platform: z.literal("ANDROID").default("ANDROID"),
  appVersion: z.string().trim().min(1).max(40).nullable().default(null)
}).strict();
export type PushDeviceRegistration = z.infer<typeof pushDeviceRegistrationSchema>;
export const pushDeviceRemovalSchema = z.object({ token: pushDeviceTokenSchema }).strict();
