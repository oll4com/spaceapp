import { z } from "zod";
import { marketingPostIdSchema, type MarketingChannel } from "./marketing-copilot.js";

// Design pane (plan clipboard:URdc3U314lUH, operator request 2026-10-18): a graphics studio with format presets for every
// social network, three image engines (Nano Banana and gpt-image through Space Gateway, HTML templates) and motion, called by
// other agents and panes through a request queue. It reuses the old, unused "DESIGN" pane mode: the Browser Host parses every
// pane row with the contracts it loaded at start, so a new mode value would break browser starts until its guarded restart.
// For the same reason every metadata field is declared here up front, and DESIGN never gets a pane browser in v1.
export const DESIGN_PANE_MODE = "DESIGN" as const;

export const DESIGN_NETWORKS = ["WEB", "INSTAGRAM", "FACEBOOK", "X", "LINKEDIN", "YOUTUBE", "TIKTOK", "PINTEREST", "PRODUCT_HUNT", "GITHUB", "DEVTO", "BLOG", "BRAND"] as const;
export const designNetworkSchema = z.enum(DESIGN_NETWORKS);
export type DesignNetwork = z.infer<typeof designNetworkSchema>;
export const DESIGN_NETWORK_LABELS: Record<DesignNetwork, string> = {
  WEB: "Web", INSTAGRAM: "Instagram", FACEBOOK: "Facebook", X: "X", LINKEDIN: "LinkedIn", YOUTUBE: "YouTube", TIKTOK: "TikTok",
  PINTEREST: "Pinterest", PRODUCT_HUNT: "Product Hunt", GITHUB: "GitHub", DEVTO: "dev.to", BLOG: "Blog", BRAND: "Brand"
};

export type DesignFormatKind = "IMAGE" | "VIDEO" | "BOTH";
/** Pixels from each edge that the network's own UI may cover (profile photos, story bars, mobile crops). */
export interface DesignSafeArea { top: number; right: number; bottom: number; left: number }
export interface DesignFormat {
  id: string;
  network: DesignNetwork;
  label: string;
  width: number;
  height: number;
  safeArea: DesignSafeArea;
  kind: DesignFormatKind;
  /** Longest motion for this format; null for image-only formats. */
  maxDurationSec: number | null;
}

const inset = (all: number): DesignSafeArea => ({ top: all, right: all, bottom: all, left: all });
const format = (id: string, network: DesignNetwork, label: string, width: number, height: number, kind: DesignFormatKind, safeArea: DesignSafeArea = inset(0), maxDurationSec: number | null = kind === "IMAGE" ? null : 60): DesignFormat =>
  Object.freeze({ id, network, label, width, height, safeArea: Object.freeze(safeArea), kind, maxDurationSec });

/**
 * Preset sizes. og, square, portrait, story, x, linkedin, ph-gallery and yt-thumb are also Media Studio sizes and must equal
 * `VIEWPORTS`/`FRAMES` in scripts/space-media-capture.mjs (packages/contracts/tests/design.test.ts asserts it).
 */
export const DESIGN_FORMATS = Object.freeze([
  format("og", "WEB", "Open Graph link preview", 1200, 630, "IMAGE"),
  format("square", "INSTAGRAM", "Instagram post", 1080, 1080, "BOTH"),
  format("portrait", "INSTAGRAM", "Instagram portrait", 1080, 1350, "BOTH"),
  format("ig-landscape", "INSTAGRAM", "Instagram landscape", 1080, 566, "BOTH"),
  format("story", "INSTAGRAM", "Instagram story / Reels", 1080, 1920, "BOTH", { top: 250, right: 60, bottom: 340, left: 60 }, 90),
  format("fb-post", "FACEBOOK", "Facebook post", 1200, 630, "BOTH"),
  format("fb-cover", "FACEBOOK", "Facebook cover", 1640, 624, "IMAGE", { top: 0, right: 220, bottom: 0, left: 220 }),
  format("x", "X", "X post", 1600, 900, "BOTH", inset(0), 140),
  format("x-header", "X", "X header", 1500, 500, "IMAGE", { top: 60, right: 60, bottom: 60, left: 60 }),
  format("linkedin", "LINKEDIN", "LinkedIn post", 1200, 627, "BOTH"),
  format("linkedin-banner", "LINKEDIN", "LinkedIn banner", 1584, 396, "IMAGE", { top: 40, right: 60, bottom: 40, left: 420 }),
  format("linkedin-company", "LINKEDIN", "LinkedIn company cover", 1128, 191, "IMAGE", { top: 20, right: 40, bottom: 20, left: 40 }),
  format("yt-thumb", "YOUTUBE", "YouTube thumbnail", 1280, 720, "IMAGE"),
  // YouTube shows only the centred 1546×423 on every device.
  format("yt-banner", "YOUTUBE", "YouTube banner", 2560, 1440, "IMAGE", { top: 508, right: 507, bottom: 509, left: 507 }),
  format("tiktok", "TIKTOK", "TikTok video", 1080, 1920, "BOTH", { top: 130, right: 140, bottom: 480, left: 60 }),
  format("pinterest", "PINTEREST", "Pinterest pin", 1000, 1500, "BOTH"),
  format("ph-gallery", "PRODUCT_HUNT", "Product Hunt gallery", 1270, 760, "IMAGE"),
  format("ph-thumb", "PRODUCT_HUNT", "Product Hunt thumbnail", 240, 240, "BOTH", inset(0), 10),
  format("github-social", "GITHUB", "GitHub social preview", 1280, 640, "IMAGE", inset(40)),
  format("devto-cover", "DEVTO", "dev.to cover", 1000, 420, "IMAGE"),
  format("blog-hero", "BLOG", "Blog hero", 1600, 900, "IMAGE"),
  // Brand marks (operator request 2026-10-19): a square logo, a horizontal lockup and an app icon (the Studio exports a .ico from square designs).
  format("logo", "BRAND", "Logo", 1024, 1024, "IMAGE"),
  format("logo-wide", "BRAND", "Wide logo", 1600, 600, "IMAGE"),
  format("app-icon", "BRAND", "App icon", 512, 512, "IMAGE", inset(52))
]);
export const DESIGN_FORMAT_IDS: readonly string[] = DESIGN_FORMATS.map((entry) => entry.id);

export const DESIGN_CUSTOM_MIN_PX = 64;
export const DESIGN_CUSTOM_MAX_PX = 4096;
const customFormatPattern = /^custom-(\d{2,4})x(\d{2,4})$/;
const customSize = (ref: string): [number, number] | null => {
  const match = customFormatPattern.exec(ref);
  if (!match) return null;
  const [width, height] = [Number(match[1]), Number(match[2])];
  const ok = (side: number) => side >= DESIGN_CUSTOM_MIN_PX && side <= DESIGN_CUSTOM_MAX_PX;
  return ok(width) && ok(height) ? [width, height] : null;
};
/** A preset id, or `custom-<width>x<height>` with 64–4096 px per side. */
export const designFormatRefSchema = z.string().refine((ref) => DESIGN_FORMAT_IDS.includes(ref) || customSize(ref) !== null, {
  message: `A format is a preset id or custom-<width>x<height> with ${DESIGN_CUSTOM_MIN_PX}–${DESIGN_CUSTOM_MAX_PX} px per side.`
});
export const designCustomFormatRef = (width: number, height: number) => `custom-${Math.round(width)}x${Math.round(height)}`;

/** The format behind a reference, or null when the reference is not valid. */
export function resolveDesignFormat(ref: string): DesignFormat | null {
  const preset = DESIGN_FORMATS.find((entry) => entry.id === ref);
  if (preset) return preset;
  const size = customSize(ref);
  return size ? format(ref, "WEB", `Custom ${size[0]}×${size[1]}`, size[0], size[1], "BOTH") : null;
}

/** The format a Marketing Copilot channel's graphic gets by default; Hacker News posts carry no image. */
export const MARKETING_CHANNEL_DEFAULT_FORMAT: Record<MarketingChannel, string | null> = {
  X: "x", LINKEDIN: "linkedin", PRODUCT_HUNT: "ph-gallery", YOUTUBE: "yt-thumb", GITHUB: "github-social",
  DEVTO: "devto-cover", BLOG: "blog-hero", REDDIT: "og", HACKER_NEWS: null
};

// ---- engines ------------------------------------------------------------------------------------
/** Image engines a pane can default to: Nano Banana (Google pool), Nano Banana Pro, gpt-image (Codex pool), HTML templates. */
export const DESIGN_IMAGE_ENGINES = ["NANO_BANANA", "NANO_BANANA_PRO", "GPT_IMAGE", "TEMPLATE"] as const;
export const designImageEngineSchema = z.enum(DESIGN_IMAGE_ENGINES);
export type DesignImageEngine = z.infer<typeof designImageEngineSchema>;
/** What a request may ask for: an image engine or motion (MP4/GIF rendered in the pane with HyperFrames). */
export const DESIGN_ENGINES = [...DESIGN_IMAGE_ENGINES, "MOTION"] as const;
export const designEngineSchema = z.enum(DESIGN_ENGINES);
export type DesignEngine = z.infer<typeof designEngineSchema>;
/** How an asset was made: an engine, or a file uploaded from the pane. */
export const designAssetEngineSchema = z.enum([...DESIGN_ENGINES, "UPLOAD"]);
export type DesignAssetEngine = z.infer<typeof designAssetEngineSchema>;
export const DESIGN_ENGINE_LABELS: Record<DesignEngine, string> = {
  NANO_BANANA: "Nano Banana", NANO_BANANA_PRO: "Nano Banana Pro", GPT_IMAGE: "gpt-image", TEMPLATE: "Template", MOTION: "Motion"
};
/** Space Gateway model ids of the generating engines (`POST /images/v1/generate`). */
export const DESIGN_ENGINE_MODELS = {
  NANO_BANANA: "gemini-3.1-flash-image",
  NANO_BANANA_PRO: "gemini-3-pro-image",
  GPT_IMAGE: "gpt-image"
} as const satisfies Partial<Record<DesignEngine, string>>;
export type DesignGeneratingEngine = keyof typeof DESIGN_ENGINE_MODELS;
export const DESIGN_IMAGE_MODEL_IDS = Object.values(DESIGN_ENGINE_MODELS);

/** Aspect ratios the image models accept; a format is generated at the nearest one and composed to its exact size. */
export const DESIGN_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export type DesignAspectRatio = typeof DESIGN_ASPECT_RATIOS[number];
export function nearestDesignAspectRatio(width: number, height: number): DesignAspectRatio {
  const target = Math.log(width / height);
  const value = (ratio: string) => { const [w, h] = ratio.split(":").map(Number); return Math.log(w! / h!); };
  return DESIGN_ASPECT_RATIOS.reduce((best, ratio) => Math.abs(value(ratio) - target) < Math.abs(value(best) - target) ? ratio : best);
}

/** HTML templates (scripts/design-templates/*.html): text, logo and brand layers over an optional background image. */
export const DESIGN_TEMPLATE_IDS = ["photo-headline", "gradient-headline", "quote-card", "release-announcement", "screenshot-frame", "wide-banner", "bold-thumbnail", "logo"] as const;
export const designTemplateIdSchema = z.enum(DESIGN_TEMPLATE_IDS);
export type DesignTemplateId = z.infer<typeof designTemplateIdSchema>;
export const DESIGN_TEMPLATE_LABELS: Record<DesignTemplateId, string> = {
  "photo-headline": "Photo with headline", "gradient-headline": "Gradient headline", "quote-card": "Quote card",
  "release-announcement": "Release announcement", "screenshot-frame": "Screenshot frame", "wide-banner": "Wide banner", "bold-thumbnail": "Bold thumbnail",
  logo: "Logo"
};

// ---- ids ----------------------------------------------------------------------------------------
const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{6,80}$`));
export const designRequestIdSchema = idOf("dreq");
export const designAssetIdSchema = idOf("dasset");
export const designBrandKitIdSchema = idOf("dbrand");
export const designEventIdSchema = idOf("devt");
const paneIdSchema = idOf("pane");
const roomIdSchema = idOf("room");
const artifactIdSchema = idOf("artifact");
const isoDateTime = z.string().datetime({ offset: true });
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

// ---- brand kits ---------------------------------------------------------------------------------
/** The built-in SpaceApp kit is this constant, never a row. */
export const DESIGN_SPACEAPP_BRAND_KIT_ID = "dbrand:spaceapp";
export const designBrandKitColorsSchema = z.object({
  background: hexColor, surface: hexColor, text: hexColor, primary: hexColor, accent: hexColor
}).strict();
const fontName = z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 -]+$/);
/** A logo is an artifact the operator uploaded, or a built-in file under apps/web/public/brand (`brand:<file>`). */
export const designBrandLogoSchema = z.union([artifactIdSchema, z.string().regex(/^brand:[a-z0-9-]{1,80}\.(svg|png)$/)]);
export const designBrandKitSchema = z.object({
  id: designBrandKitIdSchema,
  /** null for the built-in kit. */
  ownerUserId: z.string().min(1).max(200).nullable(),
  builtIn: z.boolean(),
  name: z.string().trim().min(1).max(80),
  colors: designBrandKitColorsSchema,
  fonts: z.object({ heading: fontName, body: fontName }).strict(),
  logos: z.array(designBrandLogoSchema).max(4),
  /** How the brand speaks; requester and template text never overrides it. */
  voice: z.string().trim().max(1000).nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type DesignBrandKit = z.infer<typeof designBrandKitSchema>;
export const designBrandKitInputSchema = designBrandKitSchema.pick({ name: true, colors: true, fonts: true, logos: true, voice: true }).strict();
export type DesignBrandKitInput = z.infer<typeof designBrandKitInputSchema>;

export const SPACEAPP_BRAND_KIT: Readonly<DesignBrandKit> = Object.freeze({
  id: DESIGN_SPACEAPP_BRAND_KIT_ID,
  ownerUserId: null,
  builtIn: true,
  name: "SpaceApp",
  colors: { background: "#0A0E24", surface: "#121A3A", text: "#FFFFFF", primary: "#67D9F5", accent: "#93E9FA" },
  fonts: { heading: "Inter", body: "Inter" },
  logos: ["brand:spaceapp-logo.svg", "brand:spaceapp-dev-icon.svg"],
  voice: "Clear, technical and calm: say what SpaceApp does, no hype or unqualified superlatives.",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z"
});

/**
 * A colour combination for the Studio's templates (background, title and button, accent, text): the built-in ones below,
 * and the operator's own in user settings (`designColorPresets`), shared by every Design pane.
 */
export const designColorPresetSchema = z.object({
  name: z.string().trim().min(1).max(40), background: hexColor, primary: hexColor, accent: hexColor, text: hexColor
}).strict();
export type DesignColorPreset = z.infer<typeof designColorPresetSchema>;
export const DESIGN_COLOR_PRESETS_MAX = 30;
export const DESIGN_COLOR_PRESETS: readonly DesignColorPreset[] = Object.freeze([
  { name: "SpaceApp night", background: "#0A0E24", primary: "#67D9F5", accent: "#93E9FA", text: "#FFFFFF" },
  { name: "Paper", background: "#F7F5F0", primary: "#1F4FD8", accent: "#E4572E", text: "#1A1A1A" },
  { name: "Ocean light", background: "#EAF6FB", primary: "#0077B6", accent: "#00B4D8", text: "#0B2233" },
  { name: "Sunset", background: "#2B1033", primary: "#FF7A59", accent: "#FFD166", text: "#FFF4EC" },
  { name: "Forest", background: "#0F2A1F", primary: "#6FDC8C", accent: "#F2C14E", text: "#EAF5EE" },
  { name: "Mono", background: "#111111", primary: "#FFFFFF", accent: "#9A9A9A", text: "#F5F5F5" }
]);

// ---- pane metadata ------------------------------------------------------------------------------
export const DESIGN_REQUEST_AUTONOMY = ["AUTO", "APPROVAL"] as const;
export const designRequestAutonomySchema = z.enum(DESIGN_REQUEST_AUTONOMY);
export type DesignRequestAutonomy = z.infer<typeof designRequestAutonomySchema>;

export const designPaneSettingsSchema = z.object({
  /** Preselected in the Studio and used by requests that name no format. */
  defaultFormatId: designFormatRefSchema.default("square"),
  defaultEngine: designImageEngineSchema.default("NANO_BANANA"),
  defaultTemplateId: designTemplateIdSchema.default("photo-headline"),
  /** Requests from others: AUTO delivers when the design is done, APPROVAL waits for the operator's yes. */
  requestAutonomy: designRequestAutonomySchema.default("AUTO"),
  /** The pane takes no new request while paused; the Studio keeps working. */
  paused: z.boolean().default(false),
  brandKitId: designBrandKitIdSchema.default(DESIGN_SPACEAPP_BRAND_KIT_ID),
  motion: z.object({
    defaultDurationSec: z.number().int().min(1).max(90).default(8),
    /** Also deliver a GIF next to the MP4. */
    gif: z.boolean().default(false)
  }).strict().default({ defaultDurationSec: 8, gif: false }),
  notifications: z.object({
    needsYou: z.boolean().default(true),
    delivered: z.boolean().default(true),
    telegram: z.boolean().default(false)
  }).strict().default({ needsYou: true, delivered: true, telegram: false })
}).strict();
export type DesignPaneSettings = z.infer<typeof designPaneSettingsSchema>;

export const DESIGN_TABS = ["STUDIO", "REQUESTS", "LIBRARY", "BRAND_KITS", "SETUP", "TERMINAL"] as const;
/** What the operator looks at; the agent reads it to act on "this design". */
export const designViewSchema = z.object({
  tab: z.enum(DESIGN_TABS).nullable().default(null),
  requestId: designRequestIdSchema.nullable().default(null),
  assetId: designAssetIdSchema.nullable().default(null),
  formatId: designFormatRefSchema.nullable().default(null),
  updatedAt: isoDateTime
}).strict();
export type DesignView = z.infer<typeof designViewSchema>;

export const designPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: designPaneSettingsSchema,
  view: designViewSchema.optional()
}).strict();
export type DesignPaneMetadata = z.infer<typeof designPaneMetadataSchema>;

export function defaultDesignPaneMetadata(): DesignPaneMetadata {
  return designPaneMetadataSchema.parse({ version: 1, settings: {} });
}

/** Panes created before the column existed (old DESIGN rows included), or never configured, read as defaults. */
export function resolveDesignPaneMetadata(metadata: DesignPaneMetadata | null | undefined): DesignPaneMetadata {
  return metadata ? designPaneMetadataSchema.parse(metadata) : defaultDesignPaneMetadata();
}

// ---- requests -----------------------------------------------------------------------------------
export const DESIGN_REQUESTER_KINDS = ["PANE", "AGENT", "NOUS", "DOT", "OPERATOR"] as const;
export const designRequesterSchema = z.object({
  kind: z.enum(DESIGN_REQUESTER_KINDS),
  paneId: paneIdSchema.optional(),
  roomId: roomIdSchema.optional(),
  /** Shown to the operator; requester data, never instructions. */
  label: z.string().trim().min(1).max(120)
}).strict();
export type DesignRequester = z.infer<typeof designRequesterSchema>;

/** Where a delivery goes besides the requester: a Marketing Copilot post gets the assets attached. */
export const designRequestCallbackSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MARKETING_POST"), postId: marketingPostIdSchema }).strict()
]);
export type DesignRequestCallback = z.infer<typeof designRequestCallbackSchema>;

export const DESIGN_REQUEST_STATUSES = ["QUEUED", "TAKEN", "IN_PROGRESS", "NEEDS_APPROVAL", "DELIVERED", "FAILED", "CANCELLED"] as const;
export const designRequestStatusSchema = z.enum(DESIGN_REQUEST_STATUSES);
export type DesignRequestStatus = z.infer<typeof designRequestStatusSchema>;
export const DESIGN_REQUEST_OPEN_STATUSES: readonly DesignRequestStatus[] = ["QUEUED", "TAKEN", "IN_PROGRESS", "NEEDS_APPROVAL"];
export const DESIGN_BRIEF_MAX = 4000;
export const DESIGN_REQUEST_MAX_FORMATS = 8;
export const DESIGN_REQUEST_MAX_REFERENCES = 3;

/** A template's fields (headline, subline, cta, colors, ...): limited here, each value validated by the renderer. */
export const designTemplateParamsSchema = z.record(z.string().max(40), z.unknown())
  .refine((value) => Object.keys(value).length <= 20 && JSON.stringify(value).length <= 8000, "Template fields are limited.");

export const designRequestSchema = z.object({
  id: designRequestIdSchema,
  ownerUserId: z.string().min(1).max(200),
  /** null until a Design pane takes the request. */
  designPaneId: paneIdSchema.nullable(),
  requester: designRequesterSchema,
  brief: z.string().min(1).max(DESIGN_BRIEF_MAX),
  formatIds: z.array(designFormatRefSchema).min(1).max(DESIGN_REQUEST_MAX_FORMATS),
  engine: designEngineSchema.nullable(),
  brandKitId: designBrandKitIdSchema.nullable(),
  referenceArtifactIds: z.array(artifactIdSchema).max(DESIGN_REQUEST_MAX_REFERENCES),
  callback: designRequestCallbackSchema.nullable(),
  /** The Studio's template and its fields, when the requester chose them; else the Design pane's default template. */
  templateId: designTemplateIdSchema.nullable().optional(),
  params: designTemplateParamsSchema.nullable().optional(),
  status: designRequestStatusSchema,
  resultAssetIds: z.array(designAssetIdSchema).max(32),
  /** The Design agent's open question to the operator, and the answer. */
  question: z.string().max(2000).nullable(),
  answer: z.string().max(2000).nullable(),
  /** The delivery note or the failure reason. */
  message: z.string().max(2000).nullable(),
  takenAt: isoDateTime.nullable(),
  deliveredAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type DesignRequest = z.infer<typeof designRequestSchema>;

/** What a requester sends; formats default to the Design pane's default format. */
export const designRequestCreateSchema = z.object({
  brief: z.string().trim().min(1).max(DESIGN_BRIEF_MAX),
  formatIds: z.array(designFormatRefSchema).max(DESIGN_REQUEST_MAX_FORMATS).default([]),
  engine: designEngineSchema.optional(),
  brandKitId: designBrandKitIdSchema.optional(),
  referenceArtifactIds: z.array(artifactIdSchema).max(DESIGN_REQUEST_MAX_REFERENCES).default([]),
  templateId: designTemplateIdSchema.optional(),
  params: designTemplateParamsSchema.optional(),
  designPaneId: paneIdSchema.optional(),
  callback: designRequestCallbackSchema.optional()
}).strict();
export type DesignRequestCreate = z.infer<typeof designRequestCreateSchema>;

// ---- assets -------------------------------------------------------------------------------------
export const DESIGN_ASSET_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4"] as const;
export const DESIGN_ASSET_DESCRIPTION_MAX = 2000;
/** Who made an asset: a pane's CLI agent (runtime from its session, the model it declares) or the operator in the Studio. */
export const designAssetMadeBySchema = z.object({
  by: z.enum(["AGENT", "OPERATOR"]),
  runtimeId: z.string().max(120).nullable(),
  model: z.string().max(120).nullable()
}).strict();
export type DesignAssetMadeBy = z.infer<typeof designAssetMadeBySchema>;
export const designAssetSchema = z.object({
  id: designAssetIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  requestId: designRequestIdSchema.nullable(),
  /** The Media artifact in the Design pane's room; pinned while the asset is in the library. */
  artifactId: artifactIdSchema,
  formatId: designFormatRefSchema,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  mimeType: z.enum(DESIGN_ASSET_MIME_TYPES),
  engine: designAssetEngineSchema,
  model: z.string().max(120).nullable(),
  label: z.string().max(200).nullable(),
  prompt: z.string().max(DESIGN_BRIEF_MAX).nullable(),
  /** A template render keeps its template and params so text edits re-render without regenerating. */
  templateId: designTemplateIdSchema.nullable(),
  params: z.record(z.string(), z.unknown()).nullable(),
  brandKitId: designBrandKitIdSchema.nullable(),
  /** The asset this one is a version of. */
  parentAssetId: designAssetIdSchema.nullable(),
  /** What the graphic shows, with its exact text (mandatory since 2026-10-19; null on older rows). A PNG also carries it inside. */
  description: z.string().max(DESIGN_ASSET_DESCRIPTION_MAX).nullable(),
  madeBy: designAssetMadeBySchema.nullable(),
  pinned: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type DesignAsset = z.infer<typeof designAssetSchema>;

// ---- activity -----------------------------------------------------------------------------------
export const DESIGN_EVENT_TYPES = [
  "REQUEST_CREATED", "REQUEST_TAKEN", "IMAGE_GENERATED", "RENDERED", "ASSET_SAVED", "ASSET_DELETED", "QUESTION", "ANSWER",
  "APPROVAL_REQUESTED", "APPROVED", "DELIVERED", "FAILED", "CANCELLED", "SETTINGS_CHANGED", "BRAND_KIT_CHANGED", "RUN_STARTED", "NOTE"
] as const;
export const designEventTypeSchema = z.enum(DESIGN_EVENT_TYPES);
export type DesignEventType = z.infer<typeof designEventTypeSchema>;
export const designEventSchema = z.object({
  id: designEventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  requestId: designRequestIdSchema.nullable(),
  assetId: designAssetIdSchema.nullable(),
  type: designEventTypeSchema,
  message: z.string().max(2000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type DesignEvent = z.infer<typeof designEventSchema>;
