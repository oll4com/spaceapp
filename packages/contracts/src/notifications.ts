import { z } from "zod";

/**
 * Space notifications: one record per thing a pane or service wants the operator to see, owned by a user,
 * delivered through the channels the user turned on (in-app badges and toasts, sound, browser desktop
 * notifications, Telegram) and kept in the Notification Center until read or acknowledged.
 */
export const NOTIFICATION_SOURCES = ["MAIL_COPILOT", "JOB_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "DESIGN", "ROOM_AGENT", "COUNCIL", "NOUS", "BROWSER_HANDOFF", "ROOM_WATCHDOG", "SYSTEM"] as const;
export const notificationSourceSchema = z.enum(NOTIFICATION_SOURCES);
export type NotificationSource = z.infer<typeof notificationSourceSchema>;
/**
 * What only the operator's own hands can do: a CAPTCHA or browser handoff, a sign-in, a copilot's NEEDS_USER click. It reaches
 * them at once in the app, on the desktop and on Telegram and never waits for Nous (operator rule 2026-10-17, plan clipboard:xEQOrVRQgeAn).
 */
export const needsOperatorHands = (source: NotificationSource, kind: string) => source === "BROWSER_HANDOFF" || /SIGN_IN|LOGIN|CAPTCHA|HANDOFF|NEEDS_USER/i.test(kind);
export const NOTIFICATION_SOURCE_LABELS: Record<NotificationSource, string> = {
  MAIL_COPILOT: "Mail Copilot", JOB_COPILOT: "Job Copilot", MARKETING_COPILOT: "Marketing Copilot", FREELANCE_COPILOT: "Freelance Copilot", DESIGN: "Design", ROOM_AGENT: "Room Agent", COUNCIL: "Council", NOUS: "Nous", BROWSER_HANDOFF: "Browser", ROOM_WATCHDOG: "Room watchdog", SYSTEM: "Space"
};

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
  status: z.enum(["OPEN", "ALL"]).default("ALL"),
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
  perSource: z.partialRecord(notificationSourceSchema, notificationChannelOverridesSchema).default({})
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
