import { z } from "zod";

// App Studio pane (plan clipboard:v7hyZ76ThCyv, operator request 2026-10-19): a CLI agent builds mobile apps for Android and
// iOS with Expo (React Native) and shows an image preview per device type. The preview is captured by the agent's own tool
// inside its CLI (the app is never framed on the Space origin, which would hand it the operator's cookie). The Browser Host
// parses every pane row with the contracts it loaded at start, so every metadata field is declared here up front.
export const APP_STUDIO_PANE_MODE = "APP_STUDIO" as const;

// ---- device presets -----------------------------------------------------------------------------
export const APP_STUDIO_PLATFORMS = ["ANDROID", "IOS"] as const;
export type AppStudioPlatform = (typeof APP_STUDIO_PLATFORMS)[number];
/** What the screen's camera takes away: drawn by the pane's device frame. */
export type AppStudioCutout = "PUNCH_HOLE" | "NOTCH" | "ISLAND";
export interface AppStudioDevice {
  id: string;
  platform: AppStudioPlatform;
  label: string;
  /** CSS pixels, portrait. */
  width: number;
  height: number;
  /** CSS pixels the system bars and the cutout cover (env(safe-area-inset-*)). */
  safeArea: { top: number; bottom: number };
  cutout: AppStudioCutout;
}

/**
 * The most-used current phone viewports (StatCounter mobile worldwide, Sept 2026; DeviceAtlas, May 2026); operator request
 * 2026-10-19: about ten, covering most phones, no old ones (414x896, the 2018-19 iPhone XR/11, is left out).
 */
export const APP_STUDIO_DEVICES: readonly AppStudioDevice[] = [
  { id: "android-360x800", platform: "ANDROID", label: "Galaxy A series", width: 360, height: 800, safeArea: { top: 32, bottom: 24 }, cutout: "PUNCH_HOLE" },
  { id: "android-384x832", platform: "ANDROID", label: "Galaxy S Ultra", width: 384, height: 832, safeArea: { top: 32, bottom: 24 }, cutout: "PUNCH_HOLE" },
  { id: "android-393x873", platform: "ANDROID", label: "Xiaomi / Redmi", width: 393, height: 873, safeArea: { top: 32, bottom: 24 }, cutout: "PUNCH_HOLE" },
  { id: "android-360x780", platform: "ANDROID", label: "Galaxy S24 / S25", width: 360, height: 780, safeArea: { top: 32, bottom: 24 }, cutout: "PUNCH_HOLE" },
  { id: "android-412x915", platform: "ANDROID", label: "Pixel", width: 412, height: 915, safeArea: { top: 32, bottom: 24 }, cutout: "PUNCH_HOLE" },
  { id: "iphone-390x844", platform: "IOS", label: "iPhone 12-14", width: 390, height: 844, safeArea: { top: 47, bottom: 34 }, cutout: "NOTCH" },
  { id: "iphone-393x852", platform: "IOS", label: "iPhone 15 / 16", width: 393, height: 852, safeArea: { top: 59, bottom: 34 }, cutout: "ISLAND" },
  { id: "iphone-402x874", platform: "IOS", label: "iPhone 17 / 16 Pro", width: 402, height: 874, safeArea: { top: 62, bottom: 34 }, cutout: "ISLAND" },
  { id: "iphone-430x932", platform: "IOS", label: "iPhone Plus / Pro Max", width: 430, height: 932, safeArea: { top: 59, bottom: 34 }, cutout: "ISLAND" },
  { id: "iphone-440x956", platform: "IOS", label: "iPhone 17 Pro Max", width: 440, height: 956, safeArea: { top: 62, bottom: 34 }, cutout: "ISLAND" }
];
export const APP_STUDIO_DEFAULT_DEVICE_IDS = ["android-412x915", "iphone-402x874"] as const;
/** Format only (the presets may grow without a migration); `appStudioDevice` says whether one exists. */
export const appStudioDeviceIdSchema = z.string().regex(/^(android|iphone)-\d{3}x\d{3}$/);
export function appStudioDevice(id: string): AppStudioDevice | null {
  return APP_STUDIO_DEVICES.find((device) => device.id === id) ?? null;
}
/** A route inside the app, e.g. "/" or "/settings". */
export const appStudioRouteSchema = z.string().trim().min(1).max(200).regex(/^\/[A-Za-z0-9/_\-.[\]()]*$/)
  .refine((route) => !route.split("/").includes(".."), "A route never leaves the app.");
export const APP_STUDIO_MAX_ROUTES = 20;

// ---- pane metadata ------------------------------------------------------------------------------
export const appStudioPaneSettingsSchema = z.object({
  /** The agent takes no new brief while paused. */
  paused: z.boolean().default(false),
  /** The devices a preview captures when the agent names none. */
  devices: z.array(appStudioDeviceIdSchema).min(1).max(APP_STUDIO_DEVICES.length).default([...APP_STUDIO_DEFAULT_DEVICE_IDS]),
  notifications: z.object({
    needsYou: z.boolean().default(true),
    done: z.boolean().default(true),
    telegram: z.boolean().default(false)
  }).strict().default({ needsYou: true, done: true, telegram: false })
}).strict();
export type AppStudioPaneSettings = z.infer<typeof appStudioPaneSettingsSchema>;

export const appStudioPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: appStudioPaneSettingsSchema
}).strict();
export type AppStudioPaneMetadata = z.infer<typeof appStudioPaneMetadataSchema>;

export function defaultAppStudioPaneMetadata(): AppStudioPaneMetadata {
  return appStudioPaneMetadataSchema.parse({ version: 1, settings: {} });
}

/** Panes never configured read as defaults. */
export function resolveAppStudioPaneMetadata(metadata: AppStudioPaneMetadata | null | undefined): AppStudioPaneMetadata {
  return metadata ? appStudioPaneMetadataSchema.parse(metadata) : defaultAppStudioPaneMetadata();
}

// ---- briefs, questions and activity -------------------------------------------------------------
const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{6,80}$`));
export const appStudioEventIdSchema = idOf("asevt");
const paneIdSchema = idOf("pane");
const artifactIdSchema = idOf("artifact");
const isoDateTime = z.string().datetime({ offset: true });

/**
 * One feed: a BRIEF (work the operator or Nous gives the agent) and a QUESTION (the agent asks the operator) carry a status;
 * the rest is the activity timeline.
 */
export const APP_STUDIO_EVENT_TYPES = [
  "BRIEF", "QUESTION", "ANSWERED", "PREVIEW", "NOTE", "BRIEF_DONE", "BRIEF_FAILED", "SETTINGS_CHANGED", "RUN_STARTED", "RUN_PAUSED", "RUN_STOPPED"
] as const;
export const appStudioEventTypeSchema = z.enum(APP_STUDIO_EVENT_TYPES);
export type AppStudioEventType = z.infer<typeof appStudioEventTypeSchema>;
export const APP_STUDIO_BRIEF_STATUSES = ["PENDING", "TAKEN", "DONE", "FAILED"] as const;
export const APP_STUDIO_QUESTION_STATUSES = ["OPEN", "ANSWERED"] as const;
export const appStudioEventStatusSchema = z.enum([...APP_STUDIO_BRIEF_STATUSES, ...APP_STUDIO_QUESTION_STATUSES]);
export type AppStudioEventStatus = z.infer<typeof appStudioEventStatusSchema>;
export const APP_STUDIO_TEXT_MAX = 2000;

export const appStudioEventSchema = z.object({
  id: appStudioEventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema,
  type: appStudioEventTypeSchema,
  /** BRIEF: PENDING → TAKEN → DONE | FAILED; QUESTION: OPEN → ANSWERED; null for the timeline. */
  status: appStudioEventStatusSchema.nullable(),
  message: z.string().min(1).max(APP_STUDIO_TEXT_MAX),
  /** QUESTION: options, answer, answeredBy; BRIEF: requester, result; PREVIEW: devices, route. */
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type AppStudioEvent = z.infer<typeof appStudioEventSchema>;

export const appStudioBriefCreateSchema = z.object({ text: z.string().trim().min(1).max(APP_STUDIO_TEXT_MAX) }).strict();
export const appStudioAnswerSchema = z.object({ answer: z.string().trim().min(1).max(APP_STUDIO_TEXT_MAX) }).strict();

// ---- previews -----------------------------------------------------------------------------------
export const appStudioPreviewSchema = z.object({
  paneId: paneIdSchema,
  deviceId: appStudioDeviceIdSchema,
  route: appStudioRouteSchema,
  /** A room SCREENSHOT artifact (never Agent Files); the one it replaced expires a day later. */
  artifactId: artifactIdSchema,
  capturedAt: isoDateTime
}).strict();
export type AppStudioPreview = z.infer<typeof appStudioPreviewSchema>;

/** The run follows the newest RUN_* event: no event yet reads as IDLE. */
export const APP_STUDIO_RUN_STATUSES = ["IDLE", "RUNNING", "PAUSED", "STOPPED"] as const;
export type AppStudioRunStatus = (typeof APP_STUDIO_RUN_STATUSES)[number];
