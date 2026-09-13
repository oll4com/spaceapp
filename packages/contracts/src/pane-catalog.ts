import { roomControlActionSchema } from "./space-control.js";
import { z } from "zod";

// Shared by menu presentation, composer, command validation and router tools.
// Readiness is a runtime observation, never inferred from these definitions.
export const PANE_CATALOG_VERSION = "room-panes-v3.1";
export const CLI_PANE_TYPES = Object.freeze([
  { typeId: "opencode", id: "cli:opencode", brand: "opencode", displayName: "OpenCode CLI", shortLabel: "OpenCode", aliases: ["open code"] },
  { typeId: "codex", id: "cli:codex", brand: "codex", displayName: "Codex CLI", shortLabel: "Codex", aliases: [] },
  { typeId: "claude", id: "cli:claude", brand: "claude", displayName: "Claude Code CLI", shortLabel: "Claude Code", aliases: ["claude code"] },
  { typeId: "gemini", id: "cli:gemini", brand: "gemini", displayName: "Gemini CLI", shortLabel: "Gemini", aliases: [] },
  { typeId: "autohand", id: "cli:autohand", brand: "autohand", displayName: "Autohand Code CLI", shortLabel: "Autohand Code", aliases: ["autohand code"] },
  { typeId: "qwen", id: "cli:qwen", brand: "qwen", displayName: "Qwen Code CLI", shortLabel: "Qwen Code", aliases: ["qwen code"] },
  { typeId: "kimi", id: "cli:kimi", brand: "kimi", displayName: "Kimi Code CLI", shortLabel: "Kimi Code", aliases: ["kimi code"] },
  { typeId: "grok", id: "cli:grok", brand: "grok", displayName: "Grok Build CLI", shortLabel: "Grok Build", aliases: ["grok build"] },
  { typeId: "deepseek", id: "cli:deepseek", brand: "deepseek", displayName: "DeepSeek CLI", shortLabel: "DeepSeek", aliases: ["deepseek cli"] },
  { typeId: "cursor", id: "cli:cursor", brand: "cursor", displayName: "Cursor CLI", shortLabel: "Cursor", aliases: [] },
  { typeId: "copilot", id: "cli:copilot", brand: "copilot", displayName: "GitHub Copilot CLI", shortLabel: "Copilot", aliases: ["github copilot"] },
  { typeId: "hermes", id: "cli:hermes", brand: "hermes", displayName: "Hermes Agent CLI", shortLabel: "Hermes", aliases: ["hermes agent"] }
] as const);

export const PANE_TYPES = Object.freeze([
  ...CLI_PANE_TYPES.map(type => ({ typeId: type.typeId, label: type.shortLabel, aliases: type.aliases,
    mode: "TERMINAL" as const, runtimeId: type.id, adapter: "cli" as const, readiness: "TERMINAL_INPUT" as const })),
  { typeId: "chat", label: "Chat", aliases: [], mode: "CHAT", runtimeId: null, adapter: "chat", readiness: "COMPOSER" },
  { typeId: "youtube", label: "YouTube", aliases: ["music"], mode: "YOUTUBE", runtimeId: null, adapter: "youtube", readiness: "PLAYER" },
  { typeId: "vnc", label: "VNC", aliases: [], mode: "VNC", runtimeId: null, adapter: "vnc", readiness: "CONNECTION_FORM" },
  { typeId: "browser", label: "Browser", aliases: [], mode: "BROWSER", runtimeId: null, adapter: "browser", readiness: "NAVIGATION" },
  { typeId: "harness", label: "DeepSeek Harness", aliases: ["deepseek harness"], mode: "HARNESS", runtimeId: null, adapter: "harness", readiness: "HARNESS_INPUT" },
  { typeId: "live", label: "Live", aliases: ["audio", "voice", "gpt-live"], mode: "LIVE", runtimeId: null, adapter: "live", readiness: "AUDIO_INPUT" }
] as const);
export type PaneType = typeof PANE_TYPES[number];
export type PaneTypeId = PaneType["typeId"];
export const paneTypeIdSchema = z.enum(PANE_TYPES.map(type => type.typeId));
export const paneCountsSchema = z.partialRecord(paneTypeIdSchema, z.number().int().min(1).max(16))
  .refine(counts => { const total = Object.values(counts).reduce((sum, count) => sum + count, 0); return total >= 1 && total <= 16; },
    "A command must open between 1 and 16 panes in total.");
export const openPanesActionSchema = z.object({ type: z.literal("OPEN_PANES"), counts: paneCountsSchema }).strict();
export const roomPaneCommandSchema = z.object({
  requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  catalogVersion: z.literal(PANE_CATALOG_VERSION),
  action: openPanesActionSchema
}).strict();
export type RoomPaneCommand = z.infer<typeof roomPaneCommandSchema>;

/** Application-owned identity. Payload hash excludes mutable defaults and trace IDs. */
export interface PaneBatchClaim { actorId: string; requestId: string; payloadHash: string }

export const roomSearchActionSchema = z.object({ type: z.literal("SEARCH"), query: z.string().trim().min(1).max(1000), engine: z.enum(["GOOGLE", "YOUTUBE"]), paneId: z.string().min(1).max(200).optional() }).strict();
export const roomPlaybackActionSchema = z.object({ type: z.literal("PLAYBACK"), action: z.enum(["PLAY", "PAUSE", "NEXT", "PREVIOUS"]), target: z.enum(["AUTO", "YOUTUBE"]) }).strict();
export const roomMiniRouteSchema = z.discriminatedUnion("type", [
  roomControlActionSchema,
  openPanesActionSchema,
  roomSearchActionSchema,
  roomPlaybackActionSchema,
  z.object({ type: z.literal("ADVANCED"), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal("CLARIFY"), reason: z.string().trim().min(1).max(500) }).strict()
]);
export type RoomMiniRoute = z.infer<typeof roomMiniRouteSchema>;

/** Public typed execution excludes model-only delegation and clarification. */
export const roomCommandActionSchema = z.discriminatedUnion("type", [
  roomControlActionSchema,
  openPanesActionSchema,
  roomSearchActionSchema,
  roomPlaybackActionSchema
]);
export const roomCommandSchema = roomPaneCommandSchema.extend({ action: roomCommandActionSchema });
export type RoomCommand = z.infer<typeof roomCommandSchema>;
