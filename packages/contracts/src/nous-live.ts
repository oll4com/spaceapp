import { z } from "zod";

/**
 * Nous Live (plan clipboard:f5TgJ4IIJF1m, operator decision ab7b76db 15/11): the Nous app's live voice button. The phone does
 * speech-to-text and text-to-speech itself; each spoken turn is one short text call to Space Gateway's free pools under the
 * server-held `nous-live` key. Real work goes to Nous through `ask_nous` (a normal turn). Both lines land in the Nous
 * conversation with `meta.via = "live"` and in Live history.
 */
export const NOUS_LIVE_VIA = "live" as const;
/** Spoken text is short; a dictated turn fits well under the message limit Nous itself takes. */
export const NOUS_LIVE_TURN_TEXT_MAX = 4_000;

/** Answers follow the owner's agent language (Settings → Language); a start carries nothing. */
export const nousLiveSessionInputSchema = z.object({}).strict();
export type NousLiveSessionInput = z.infer<typeof nousLiveSessionInputSchema>;

export const nousLiveSessionSchema = z.object({
  sessionId: z.string().min(1).max(80),
  /** Silence after which the phone closes the session (approval 8, a privacy and battery bound). */
  silenceCloseMs: z.number().int().positive(),
  startedAt: z.string().datetime({ offset: true })
}).strict();
export type NousLiveSession = z.infer<typeof nousLiveSessionSchema>;

export const nousLiveTurnInputSchema = z.object({
  sessionId: z.string().min(1).max(80),
  text: z.string().trim().min(1).max(NOUS_LIVE_TURN_TEXT_MAX),
  clientId: z.string().min(1).max(120).optional()
}).strict();
export type NousLiveTurnInput = z.infer<typeof nousLiveTurnInputSchema>;

export const NOUS_LIVE_TOOLS = ["time_now", "nous_now", "inbox_summary", "memory_recall", "create_note", "ask_nous"] as const;
export const nousLiveToolSchema = z.enum(NOUS_LIVE_TOOLS);
export type NousLiveTool = z.infer<typeof nousLiveToolSchema>;

/** What a tool did, for the subtitle; never a tool's whole output. */
export const nousLiveToolEventSchema = z.object({
  tool: nousLiveToolSchema,
  ok: z.boolean(),
  /** A note's text, a handoff's message id: what the operator should see happened. */
  detail: z.string().max(NOUS_LIVE_TURN_TEXT_MAX).nullable()
}).strict();
export type NousLiveToolEvent = z.infer<typeof nousLiveToolEventSchema>;

export const nousLiveTurnResultSchema = z.object({
  text: z.string(),
  /** The pool that answered; null when every pool failed. */
  pool: z.string().nullable(),
  /** The Nous conversation's message ids of this turn's two lines. */
  userMessageId: z.string(),
  answerMessageId: z.string(),
  /** Set when the turn went to Nous (`ask_nous`): the app reads Nous's answer from the conversation as usual. */
  handoff: z.object({ messageId: z.string() }).strict().nullable(),
  /** Open RELEASE, DESTRUCTIVE or EXTERNAL decisions the voice never approves: the app shows their cards. */
  needsSignature: z.array(z.string()),
  toolEvents: z.array(nousLiveToolEventSchema)
}).strict();
export type NousLiveTurnResult = z.infer<typeof nousLiveTurnResultSchema>;

/**
 * Nous Live's voice (operator 16/11 nous_msg:7f739948): "device" keeps the phone's own speech (free); a realtime provider of the Live
 * pane's registry (LIVE_AUDIO_PROVIDERS) talks with its own voice while Nous still answers. Saved per person in Nous's settings (`liveVoice`).
 */
export const NOUS_LIVE_DEVICE = "device" as const;
export const NOUS_LIVE_LANGUAGES = ["auto", "el", "en"] as const;
export const nousLiveVoiceChoiceSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(120).optional(),
  voice: z.string().trim().min(1).max(60).optional(),
  language: z.enum(NOUS_LIVE_LANGUAGES).optional()
}).strict();
export type NousLiveVoiceChoice = z.infer<typeof nousLiveVoiceChoiceSchema>;

/** One provider row of the picker: every row can be chosen; `ready` false names its reason in `state` (no balance, quota out) and a start falls back. */
export const nousLiveVoiceProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  ready: z.boolean(),
  state: z.string(),
  free: z.boolean(),
  models: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  voices: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  defaultModel: z.string().nullable(),
  defaultVoice: z.string().nullable()
}).strict();
export type NousLiveVoiceProvider = z.infer<typeof nousLiveVoiceProviderSchema>;

export const nousLiveVoiceOptionsSchema = z.object({
  choice: nousLiveVoiceChoiceSchema,
  providers: z.array(nousLiveVoiceProviderSchema)
}).strict();
export type NousLiveVoiceOptions = z.infer<typeof nousLiveVoiceOptionsSchema>;

/**
 * A realtime session: the phone opens `websocketUrl` (a one-use token, no key) and sends `setup` first; Nous's context and tools are inside it.
 * A provider the phone cannot speak itself runs through Space's relay: `websocketUrl` is then a path on the phone's server (`/api/...`).
 * `fallback` says why the chosen provider was not the one that started.
 */
export const nousLiveRealtimeSessionSchema = nousLiveSessionSchema.extend({
  provider: z.string(),
  model: z.string(),
  voice: z.string().nullable(),
  protocol: z.literal("gemini-live"),
  websocketUrl: z.string(),
  setup: z.record(z.string(), z.unknown()),
  expiresAt: z.string(),
  fallback: z.object({ from: z.string(), reason: z.string() }).strict().optional()
}).strict();
export type NousLiveRealtimeSession = z.infer<typeof nousLiveRealtimeSessionSchema>;

/** The realtime model calls a Nous Live tool; the server runs it with the same rules as a text turn. */
export const nousLiveRealtimeToolInputSchema = z.object({
  sessionId: z.string().min(1).max(80),
  name: nousLiveToolSchema,
  args: z.record(z.string(), z.unknown()).optional(),
  clientId: z.string().min(1).max(120).optional()
}).strict();
export type NousLiveRealtimeToolInput = z.infer<typeof nousLiveRealtimeToolInputSchema>;

export const nousLiveRealtimeToolResultSchema = z.object({
  output: z.string(),
  event: nousLiveToolEventSchema.nullable(),
  handoff: z.object({ messageId: z.string() }).strict().nullable(),
  needsSignature: z.array(z.string())
}).strict();
export type NousLiveRealtimeToolResult = z.infer<typeof nousLiveRealtimeToolResultSchema>;

/** One spoken exchange of a realtime session, from the provider's own transcripts, written to the conversation like a text turn. */
export const nousLiveRealtimeExchangeInputSchema = z.object({
  sessionId: z.string().min(1).max(80),
  heard: z.string().trim().max(NOUS_LIVE_TURN_TEXT_MAX),
  said: z.string().trim().max(NOUS_LIVE_TURN_TEXT_MAX),
  clientId: z.string().min(1).max(120).optional(),
  /** Milliseconds from the end of the operator's speech to the first audio, measured on the phone. */
  firstAudioMs: z.number().int().min(0).max(600_000).optional(),
  /** Why the realtime session failed (the provider's close reason); the picker shows it until a session works again. */
  failure: z.string().trim().min(1).max(300).optional()
}).strict();
export type NousLiveRealtimeExchangeInput = z.infer<typeof nousLiveRealtimeExchangeInputSchema>;

export const nousLiveRealtimeExchangeResultSchema = z.object({
  userMessageId: z.string().nullable(),
  answerMessageId: z.string().nullable(),
  needsSignature: z.array(z.string())
}).strict();
export type NousLiveRealtimeExchangeResult = z.infer<typeof nousLiveRealtimeExchangeResultSchema>;
