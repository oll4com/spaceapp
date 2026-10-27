import { z } from "zod";
import {
  DESIGN_BRIEF_MAX, DESIGN_FORMATS, designAssetMadeBySchema, designRequestAutonomySchema, designRequestCallbackSchema, designRequesterSchema,
  DESIGN_REQUEST_OPEN_STATUSES, DESIGN_REQUEST_STATUSES, designRequestStatusSchema, resolveDesignFormat, type DesignFormat
} from "./design.js";
import type { MarketingChannel } from "./marketing-copilot.js";

// Video pane (plan clipboard:-HpLbbtWKj53, operator request 2026-10-21): a video studio with the Design pane's philosophy. Agents,
// Nous, Dots, the Live pane, the Marketing Copilot and the operator send a video (or a brief) and get back a finished video in
// every format they ask for: automatic clipping with a selectable technique, transitions and filters, captions, a narration
// track, music, delivered AUTO or after the operator's approval. New mode VIDEO (operator decision 2026-10-21): the Browser Host
// parses pane rows with the contracts it loaded at start, so stable needs its guarded restart before browser sessions start in
// rooms that hold a Video pane. Every metadata field is declared here up front; VIDEO never gets a pane browser.
export const VIDEO_PANE_MODE = "VIDEO" as const;

// ---- formats ------------------------------------------------------------------------------------
/** Every Design format that takes motion, same sizes, safe areas and longest durations; images are not video outputs. */
export const VIDEO_FORMATS: readonly DesignFormat[] = Object.freeze(DESIGN_FORMATS.filter((entry) => entry.kind !== "IMAGE"));
export const VIDEO_FORMAT_IDS: readonly string[] = VIDEO_FORMATS.map((entry) => entry.id);
/** The format behind a reference (a video preset or `custom-<w>x<h>`), or null. */
export function resolveVideoFormat(ref: string): DesignFormat | null {
  const format = resolveDesignFormat(ref);
  return format && format.kind !== "IMAGE" ? format : null;
}
export const videoFormatRefSchema = z.string().refine((ref) => resolveVideoFormat(ref) !== null, {
  message: "A video format is a video preset id or custom-<width>x<height> with 64–4096 px per side."
});
/** The format a Marketing Copilot channel's video gets by default; channels that take no video get none. */
export const MARKETING_CHANNEL_DEFAULT_VIDEO_FORMAT: Record<MarketingChannel, string | null> = {
  X: "x", LINKEDIN: "linkedin", YOUTUBE: "youtube", PRODUCT_HUNT: null, GITHUB: null, DEVTO: null, BLOG: null, REDDIT: null, HACKER_NEWS: null
};

// ---- editing vocabulary -------------------------------------------------------------------------
/** How the pane finds the cuts: dead air (auto-editor / silencedetect), scene changes (PySceneDetect), transcript moments the agent picks, or the agent's own list. */
export const VIDEO_TECHNIQUES = ["silence", "scene", "highlights", "manual"] as const;
export const videoTechniqueSchema = z.enum(VIDEO_TECHNIQUES);
export type VideoTechnique = z.infer<typeof videoTechniqueSchema>;
export const VIDEO_TECHNIQUE_LABELS: Record<VideoTechnique, string> = { silence: "Cut silence", scene: "Scene cuts", highlights: "Highlights", manual: "Manual cuts" };
/** How a source of another aspect fills the output: letterbox on a blurred copy, centre crop, or a crop that follows the faces per shot. */
export const VIDEO_REFRAME_MODES = ["OFF", "CENTER", "FACE"] as const;
export const videoReframeSchema = z.enum(VIDEO_REFRAME_MODES);
export type VideoReframeMode = z.infer<typeof videoReframeSchema>;
/** ffmpeg `xfade` transition names, plus auto (fade between sources, a hard cut inside one) and cut. */
export const VIDEO_TRANSITIONS = ["auto", "cut", "fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight", "slideup", "slidedown", "circleopen", "smoothleft", "zoomin"] as const;
export const videoTransitionSchema = z.enum(VIDEO_TRANSITIONS);
export type VideoTransition = z.infer<typeof videoTransitionSchema>;
export const VIDEO_FILTERS = ["none", "warm", "cool", "vivid", "cinematic", "bw", "stabilize"] as const;
export const videoFilterSchema = z.enum(VIDEO_FILTERS);
export type VideoFilter = z.infer<typeof videoFilterSchema>;
export const VIDEO_CAPTION_STYLES = ["none", "karaoke", "bold-center", "lower-third"] as const;
export const videoCaptionStyleSchema = z.enum(VIDEO_CAPTION_STYLES);
export type VideoCaptionStyle = z.infer<typeof videoCaptionStyleSchema>;
/** Narration engines: Kokoro (Apache, fast, 9 languages) and Chatterbox (MIT, 23 languages incl. Greek, voice cloning); both local. */
export const VIDEO_TTS_ENGINES = ["kokoro", "chatterbox"] as const;
export const videoTtsEngineSchema = z.enum(VIDEO_TTS_ENGINES);
export type VideoTtsEngine = z.infer<typeof videoTtsEngineSchema>;
/** Narration languages and the engines that speak them (BCP-47 base tags). */
export const VIDEO_TTS_LANGUAGES: Readonly<Record<string, readonly VideoTtsEngine[]>> = Object.freeze({
  en: ["kokoro", "chatterbox"], es: ["kokoro", "chatterbox"], fr: ["kokoro", "chatterbox"], hi: ["kokoro", "chatterbox"], it: ["kokoro", "chatterbox"],
  pt: ["kokoro", "chatterbox"], ja: ["kokoro", "chatterbox"], zh: ["kokoro", "chatterbox"],
  ar: ["chatterbox"], da: ["chatterbox"], de: ["chatterbox"], el: ["chatterbox"], fi: ["chatterbox"], he: ["chatterbox"], ko: ["chatterbox"], ms: ["chatterbox"],
  nl: ["chatterbox"], no: ["chatterbox"], pl: ["chatterbox"], ru: ["chatterbox"], sv: ["chatterbox"], sw: ["chatterbox"], tr: ["chatterbox"]
});
const languageTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);

// ---- ids ----------------------------------------------------------------------------------------
const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{6,80}$`));
export const videoRequestIdSchema = idOf("vreq");
export const videoAssetIdSchema = idOf("vasset");
export const videoEventIdSchema = idOf("vevt");
export const videoJobIdSchema = idOf("vjob");
const paneIdSchema = idOf("pane");
const artifactIdSchema = idOf("artifact");
const isoDateTime = z.string().datetime({ offset: true });
const db = (min: number, max: number) => z.number().min(min).max(max);

// ---- sources ------------------------------------------------------------------------------------
/** A VIDEO, AUDIO or IMAGE artifact of the owner's rooms, or an https page yt-dlp can fetch, which the requester confirms the operator owns or may use. */
export const videoSourceSchema = z.union([
  z.object({ artifactId: artifactIdSchema, label: z.string().trim().max(120).optional() }).strict(),
  z.object({ url: z.string().url().max(2000).refine((url) => url.startsWith("https://"), "Only https sources."), rightsConfirmed: z.literal(true), label: z.string().trim().max(120).optional() }).strict()
]);
export type VideoSource = z.infer<typeof videoSourceSchema>;
export const VIDEO_REQUEST_MAX_SOURCES = 8;
/** Where the Studio's "Save to Agent Files" files a video: Agent Files › Media / Video. */
export const VIDEO_AGENT_FILES_FOLDER = "MEDIA/Video";

// ---- timeline -----------------------------------------------------------------------------------
export const VIDEO_TIMELINE_MAX_CLIPS = 200;
export const VIDEO_TIMELINE_MAX_OUTPUTS = 8;
export const VIDEO_TIMELINE_MAX_OVERLAYS = 20;
export const VIDEO_NARRATION_MAX = 8000;
const seconds = z.number().min(0).max(86_400);
export const videoClipSchema = z.object({
  /** Index into the request's or the pane's sources. */
  sourceIndex: z.number().int().min(0).max(VIDEO_REQUEST_MAX_SOURCES - 1),
  inSec: seconds,
  outSec: seconds,
  speed: z.number().min(0.25).max(4).default(1)
}).strict().refine((clip) => clip.outSec > clip.inSec, "A clip ends after it starts.");
export const videoCaptionsSchema = z.object({
  style: videoCaptionStyleSchema.default("none"),
  /** null: the transcript's language. */
  language: languageTag.nullable().default(null),
  position: z.enum(["TOP", "BOTTOM"]).default("BOTTOM")
}).strict();
export const videoOverlaySchema = z.object({
  /** A PNG or MP4 the Design pane or HyperFrames made (a Media artifact of the owner's rooms). */
  artifactId: artifactIdSchema,
  fromSec: seconds,
  toSec: seconds,
  position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center", "full"]).default("bottom-right"),
  opacity: z.number().min(0).max(1).default(1)
}).strict().refine((overlay) => overlay.toSec > overlay.fromSec, "An overlay ends after it starts.");
export const videoNarrationSchema = z.object({
  engine: videoTtsEngineSchema.default("kokoro"),
  voice: z.string().trim().max(60).nullable().default(null),
  language: languageTag.default("en"),
  /** What is said, at which second of the output; one segment from 0 is a plain voice-over. */
  segments: z.array(z.object({ atSec: seconds, text: z.string().trim().min(1).max(2000) }).strict()).min(1).max(60),
  volumeDb: db(-30, 6).default(0)
}).strict();
export const videoMusicSchema = z.object({
  /** An AUDIO artifact: the operator's library, a fetched CC-BY track or an upload; null: no music. */
  artifactId: artifactIdSchema.nullable().default(null),
  volumeDb: db(-40, 0).default(-18),
  /** How far the music drops under speech and narration; 0 turns ducking off. */
  duckDb: db(-30, 0).default(-12),
  fadeOutSec: z.number().min(0).max(10).default(2)
}).strict();
/** What the agent sends to assemble: the cut list and every layer, rendered once per output format. */
export const videoTimelineSchema = z.object({
  version: z.literal(1),
  clips: z.array(videoClipSchema).min(1).max(VIDEO_TIMELINE_MAX_CLIPS),
  transition: videoTransitionSchema.default("auto"),
  transitionSec: z.number().min(0.1).max(1.5).default(0.4),
  filter: videoFilterSchema.default("none"),
  reframe: videoReframeSchema.default("FACE"),
  captions: videoCaptionsSchema.default({ style: "none", language: null, position: "BOTTOM" }),
  overlays: z.array(videoOverlaySchema).max(VIDEO_TIMELINE_MAX_OVERLAYS).default([]),
  narration: videoNarrationSchema.nullable().default(null),
  music: videoMusicSchema.nullable().default(null),
  outputs: z.array(z.object({ formatId: videoFormatRefSchema, label: z.string().trim().max(120).optional() }).strict()).min(1).max(VIDEO_TIMELINE_MAX_OUTPUTS),
  /** Shorter than the format's own limit when set. */
  maxDurationSec: z.number().min(1).max(3600).optional()
}).strict();
export type VideoTimeline = z.infer<typeof videoTimelineSchema>;

// ---- pane metadata ------------------------------------------------------------------------------
export const videoPaneSettingsSchema = z.object({
  /** Preselected in the Studio and used by requests that name no format. */
  defaultFormatIds: z.array(videoFormatRefSchema).min(1).max(VIDEO_TIMELINE_MAX_OUTPUTS).default(["youtube-short"]),
  technique: videoTechniqueSchema.default("highlights"),
  reframe: videoReframeSchema.default("FACE"),
  transition: videoTransitionSchema.default("auto"),
  filter: videoFilterSchema.default("none"),
  captions: videoCaptionStyleSchema.default("karaoke"),
  narration: z.object({
    engine: videoTtsEngineSchema.default("kokoro"),
    voice: z.string().trim().max(60).default("af_heart"),
    language: languageTag.default("en")
  }).strict().default({ engine: "kokoro", voice: "af_heart", language: "en" }),
  music: z.object({ volumeDb: db(-40, 0).default(-18), duckDb: db(-30, 0).default(-12) }).strict().default({ volumeDb: -18, duckDb: -12 }),
  /** Requests from others: AUTO delivers when the video is done, APPROVAL waits for the operator's yes (the Design pane's rule). */
  requestAutonomy: designRequestAutonomySchema.default("AUTO"),
  /** The pane takes no new request while paused; the Studio keeps working. */
  paused: z.boolean().default(false),
  notifications: z.object({
    needsYou: z.boolean().default(true),
    delivered: z.boolean().default(true),
    telegram: z.boolean().default(false)
  }).strict().default({ needsYou: true, delivered: true, telegram: false })
}).strict();
export type VideoPaneSettings = z.infer<typeof videoPaneSettingsSchema>;

export const VIDEO_TABS = ["STUDIO", "REQUESTS", "LIBRARY", "MUSIC", "SETUP", "TERMINAL"] as const;
/** What the operator looks at; the agent reads it to act on "this video". */
export const videoViewSchema = z.object({
  tab: z.enum(VIDEO_TABS).nullable().default(null),
  requestId: videoRequestIdSchema.nullable().default(null),
  assetId: videoAssetIdSchema.nullable().default(null),
  sourceArtifactId: artifactIdSchema.nullable().default(null),
  updatedAt: isoDateTime
}).strict();
export type VideoView = z.infer<typeof videoViewSchema>;

export const videoPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: videoPaneSettingsSchema,
  view: videoViewSchema.optional()
}).strict();
export type VideoPaneMetadata = z.infer<typeof videoPaneMetadataSchema>;

export function defaultVideoPaneMetadata(): VideoPaneMetadata {
  return videoPaneMetadataSchema.parse({ version: 1, settings: {} });
}
/** A pane never configured reads as the defaults. */
export function resolveVideoPaneMetadata(metadata: VideoPaneMetadata | null | undefined): VideoPaneMetadata {
  return metadata ? videoPaneMetadataSchema.parse(metadata) : defaultVideoPaneMetadata();
}

// ---- requests -----------------------------------------------------------------------------------
export { DESIGN_REQUEST_STATUSES as VIDEO_REQUEST_STATUSES, DESIGN_REQUEST_OPEN_STATUSES as VIDEO_REQUEST_OPEN_STATUSES, designRequestStatusSchema as videoRequestStatusSchema, designRequesterSchema as videoRequesterSchema, designRequestCallbackSchema as videoRequestCallbackSchema };
export type VideoRequestStatus = z.infer<typeof designRequestStatusSchema>;
export type VideoRequester = z.infer<typeof designRequesterSchema>;
export type VideoRequestCallback = z.infer<typeof designRequestCallbackSchema>;
export const VIDEO_BRIEF_MAX = DESIGN_BRIEF_MAX;
/** A requester's choices; what it leaves out comes from the Video pane's settings. */
export const videoRequestOptionsSchema = z.object({
  technique: videoTechniqueSchema.optional(),
  reframe: videoReframeSchema.optional(),
  transition: videoTransitionSchema.optional(),
  filter: videoFilterSchema.optional(),
  captions: videoCaptionStyleSchema.optional(),
  narration: z.object({
    engine: videoTtsEngineSchema.optional(),
    voice: z.string().trim().max(60).optional(),
    language: languageTag.optional(),
    /** The description spoken over the video; "none" in the brief turns narration off. */
    text: z.string().trim().max(VIDEO_NARRATION_MAX).optional()
  }).strict().optional(),
  music: z.object({ artifactId: artifactIdSchema.nullable().optional(), volumeDb: db(-40, 0).optional(), duckDb: db(-30, 0).optional() }).strict().optional(),
  maxDurationSec: z.number().min(1).max(3600).optional()
}).strict();
export type VideoRequestOptions = z.infer<typeof videoRequestOptionsSchema>;

export const videoRequestSchema = z.object({
  id: videoRequestIdSchema,
  ownerUserId: z.string().min(1).max(200),
  /** null until a Video pane takes the request. */
  videoPaneId: paneIdSchema.nullable(),
  requester: designRequesterSchema,
  brief: z.string().min(1).max(VIDEO_BRIEF_MAX),
  sources: z.array(videoSourceSchema).max(VIDEO_REQUEST_MAX_SOURCES),
  formatIds: z.array(videoFormatRefSchema).min(1).max(VIDEO_TIMELINE_MAX_OUTPUTS),
  options: videoRequestOptionsSchema,
  callback: designRequestCallbackSchema.nullable(),
  status: designRequestStatusSchema,
  resultAssetIds: z.array(videoAssetIdSchema).max(32),
  /** The Video agent's open question to the operator, and the answer. */
  question: z.string().max(2000).nullable(),
  answer: z.string().max(2000).nullable(),
  /** The delivery note or the failure reason. */
  message: z.string().max(2000).nullable(),
  takenAt: isoDateTime.nullable(),
  deliveredAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type VideoRequest = z.infer<typeof videoRequestSchema>;

/** What a requester sends; formats default to the Video pane's default formats. */
export const videoRequestCreateSchema = z.object({
  brief: z.string().trim().min(1).max(VIDEO_BRIEF_MAX),
  sources: z.array(videoSourceSchema).max(VIDEO_REQUEST_MAX_SOURCES).default([]),
  formatIds: z.array(videoFormatRefSchema).max(VIDEO_TIMELINE_MAX_OUTPUTS).default([]),
  options: videoRequestOptionsSchema.default({}),
  videoPaneId: paneIdSchema.optional(),
  callback: designRequestCallbackSchema.optional()
}).strict();
export type VideoRequestCreate = z.infer<typeof videoRequestCreateSchema>;
/** What a caller may send (defaults filled by the schema). */
export type VideoRequestCreateInput = z.input<typeof videoRequestCreateSchema>;

// ---- assets -------------------------------------------------------------------------------------
export const VIDEO_ASSET_MIME_TYPES = ["video/mp4", "video/webm", "image/png", "audio/mpeg", "audio/wav"] as const;
/** What an asset is: an assembled output, a file the agent or operator uploaded, a Live recording, a narration or a music track. */
export const VIDEO_ASSET_KINDS = ["OUTPUT", "UPLOAD", "RECORDING", "NARRATION", "MUSIC"] as const;
export const videoAssetKindSchema = z.enum(VIDEO_ASSET_KINDS);
export type VideoAssetKind = z.infer<typeof videoAssetKindSchema>;
export const VIDEO_ASSET_DESCRIPTION_MAX = 2000;
export const videoAssetSchema = z.object({
  id: videoAssetIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  requestId: videoRequestIdSchema.nullable(),
  /** The Media artifact in the Video pane's room; pinned while the asset is in the library. */
  artifactId: artifactIdSchema,
  /** The output's poster frame, a pinned IMAGE artifact. */
  thumbnailArtifactId: artifactIdSchema.nullable(),
  formatId: videoFormatRefSchema.nullable(),
  width: z.number().int().min(1).max(8192).nullable(),
  height: z.number().int().min(1).max(8192).nullable(),
  durationSec: z.number().min(0).max(86_400).nullable(),
  mimeType: z.enum(VIDEO_ASSET_MIME_TYPES),
  kind: videoAssetKindSchema,
  label: z.string().max(200).nullable(),
  /** What the video shows and says (mandatory on every new asset, like Design's). */
  description: z.string().max(VIDEO_ASSET_DESCRIPTION_MAX).nullable(),
  madeBy: designAssetMadeBySchema.nullable(),
  /** Attribution the licence asks for (CC-BY music); shown where the video is published. */
  credits: z.string().max(1000).nullable(),
  /** The timeline an output was assembled from, so a re-cut starts from it. */
  timeline: videoTimelineSchema.nullable(),
  /** The asset this one is a version of. */
  parentAssetId: videoAssetIdSchema.nullable(),
  pinned: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type VideoAsset = z.infer<typeof videoAssetSchema>;

// ---- jobs (engine runs; in memory, never a table) -----------------------------------------------
export const VIDEO_JOB_OPS = ["probe", "fetch", "captions", "proxy", "transcribe", "analyze", "assemble", "tts", "music_search", "music_fetch"] as const;
export const videoJobOpSchema = z.enum(VIDEO_JOB_OPS);
export type VideoJobOp = z.infer<typeof videoJobOpSchema>;
export const VIDEO_JOB_STATUSES = ["QUEUED", "RUNNING", "DONE", "FAILED"] as const;
export const videoJobSchema = z.object({
  id: videoJobIdSchema,
  paneId: paneIdSchema,
  op: videoJobOpSchema,
  status: z.enum(VIDEO_JOB_STATUSES),
  progress: z.number().min(0).max(100),
  message: z.string().max(400),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().max(2000).nullable(),
  createdAt: isoDateTime,
  endedAt: isoDateTime.nullable()
}).strict();
export type VideoJob = z.infer<typeof videoJobSchema>;

// ---- activity -----------------------------------------------------------------------------------
export const VIDEO_EVENT_TYPES = [
  "REQUEST_CREATED", "REQUEST_TAKEN", "SOURCE_ADDED", "RECORDING_SAVED", "JOB_STARTED", "JOB_DONE", "JOB_FAILED", "ASSET_SAVED", "ASSET_DELETED",
  "QUESTION", "ANSWER", "APPROVAL_REQUESTED", "APPROVED", "DELIVERED", "FAILED", "CANCELLED", "SETTINGS_CHANGED", "RUN_STARTED", "NOTE"
] as const;
export const videoEventTypeSchema = z.enum(VIDEO_EVENT_TYPES);
export type VideoEventType = z.infer<typeof videoEventTypeSchema>;
export const videoEventSchema = z.object({
  id: videoEventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  requestId: videoRequestIdSchema.nullable(),
  assetId: videoAssetIdSchema.nullable(),
  type: videoEventTypeSchema,
  message: z.string().max(2000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type VideoEvent = z.infer<typeof videoEventSchema>;
