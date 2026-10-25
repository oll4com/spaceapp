import { z } from "zod";
import type { AgentRunCost, AgentRunUsage } from "./agent-run-ledger.js";
import { dotIdSchema, dotPermissionModeSchema } from "./dots.js";
import type { AgentPaneModelOption } from "./schemas.js";

// Space Dots Stage 8: every Dot setting lives in SpaceApp Settings → Dots, and each
// Dot has one continuous feed across rooms (its messages plus notices it sends itself).

const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const dotProactiveSettingsSchema = z.object({
  enabled: z.boolean(),
  /** The Dot that checks and writes notices; null means the default Dot. */
  dotId: dotIdSchema.nullable(),
  email: z.boolean(),
  calendar: z.boolean(),
  intervalMinutes: z.number().int().min(30).max(1440),
  /** Notices found in quiet hours wait until they end (user's time zone). */
  quietHours: z.object({ start: clockSchema, end: clockSchema }).strict().nullable(),
  maxPerDay: z.number().int().min(1).max(20),
  alsoSlack: z.boolean()
}).strict();
export const DOT_PROACTIVE_DEFAULTS: DotProactiveSettings = {
  enabled: true, dotId: null, email: true, calendar: true, intervalMinutes: 60,
  quietHours: { start: "23:00", end: "08:00" }, maxPerDay: 5, alsoSlack: false
};
export const dotUserSettingsSchema = z.object({
  /** The Dot a new Chat pane opens with; null means the first Dot. */
  defaultDotId: dotIdSchema.nullable(),
  /** Model for Dots without their own; null keeps the Chat default. */
  defaultModelConfigId: z.string().trim().min(1).max(260).nullable(),
  defaultPermissionMode: dotPermissionModeSchema.nullable(),
  /** Sending email and creating calendar events wait for the user's approval. */
  confirmExternalActions: z.boolean(),
  proactive: dotProactiveSettingsSchema,
  updatedAt: z.iso.datetime().nullable()
}).strict();
export const updateDotUserSettingsSchema = z.object({
  defaultDotId: dotIdSchema.nullable().optional(),
  defaultModelConfigId: z.string().trim().min(1).max(260).nullable().optional(),
  defaultPermissionMode: dotPermissionModeSchema.nullable().optional(),
  confirmExternalActions: z.boolean().optional(),
  proactive: dotProactiveSettingsSchema.partial().strict().optional()
}).strict().refine(input => Object.keys(input).length > 0, "Provide a settings change.");
export type DotProactiveSettings = z.infer<typeof dotProactiveSettingsSchema>;
export type DotUserSettings = z.infer<typeof dotUserSettingsSchema>;
export type UpdateDotUserSettings = z.infer<typeof updateDotUserSettingsSchema>;

/**
 * One model call of a proactive check. These calls have no Chat run, so they are recorded here (PROACTIVE) with the
 * Stage 7 measurement: the usage the model gateway reported and the estimate from the operator's price catalog.
 */
export interface DotProactiveUsageEntry {
  calledAt: string; dotId: string | null; model: string; status: "COMPLETED" | "FAILED";
  candidates: number; notices: number; usage: AgentRunUsage; cost: AgentRunCost;
}
const count = z.number().int().min(0);
export const dotProactiveUsageSchema = z.object({
  kind: z.literal("PROACTIVE"),
  days: z.number().int().min(1).max(30),
  calls: count,
  failedCalls: count,
  notices: count,
  /** Calls whose gateway reported tokens; the token totals cover only these. */
  measuredCalls: count,
  inputTokens: count, cachedInputTokens: count, outputTokens: count, reasoningOutputTokens: count, totalTokens: count,
  /** Sum over the priced calls only; a call without a price is counted in `unknownCostCalls`, never as zero. */
  estimatedCostUsd: z.number().finite().nonnegative().nullable(),
  estimatedCalls: count,
  unknownCostCalls: count,
  /** Why the latest unpriced call has no cost. */
  unknownCostReason: z.string().max(1000).nullable(),
  priceCatalogVersions: z.array(z.string().max(160)).max(10),
  models: z.array(z.string().max(200)).max(10),
  lastCallAt: z.iso.datetime().nullable()
}).strict();
export type DotProactiveUsage = z.infer<typeof dotProactiveUsageSchema>;

/** Totals of the calls in the window, newest first. */
export function summarizeDotProactiveUsage(entries: DotProactiveUsageEntry[], days: number): DotProactiveUsage {
  const summary: DotProactiveUsage = { kind: "PROACTIVE", days, calls: entries.length, failedCalls: 0, notices: 0, measuredCalls: 0, inputTokens: 0,
    cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, estimatedCostUsd: null, estimatedCalls: 0, unknownCostCalls: 0,
    unknownCostReason: null, priceCatalogVersions: [], models: [], lastCallAt: null };
  let cost = 0;
  for (const entry of [...entries].sort((a, b) => b.calledAt.localeCompare(a.calledAt))) {
    summary.lastCallAt ??= new Date(entry.calledAt).toISOString();
    if (entry.status === "FAILED") summary.failedCalls += 1;
    summary.notices += entry.notices;
    if (!summary.models.includes(entry.model) && summary.models.length < 10) summary.models.push(entry.model);
    if (entry.usage.status === "MEASURED") {
      summary.measuredCalls += 1;
      summary.inputTokens += entry.usage.inputTokens; summary.cachedInputTokens += entry.usage.cachedInputTokens;
      summary.outputTokens += entry.usage.outputTokens; summary.reasoningOutputTokens += entry.usage.reasoningOutputTokens;
      summary.totalTokens += entry.usage.totalTokens;
    }
    if (entry.cost.status === "UNKNOWN") {
      summary.unknownCostCalls += 1;
      summary.unknownCostReason ??= entry.cost.reason;
    } else {
      summary.estimatedCalls += 1;
      cost += entry.cost.amountUsd;
      const version = entry.cost.priceCatalogVersion;
      if (version && !summary.priceCatalogVersions.includes(version) && summary.priceCatalogVersions.length < 10) summary.priceCatalogVersions.push(version);
    }
  }
  summary.estimatedCostUsd = summary.estimatedCalls ? Math.round(cost * 1_000_000) / 1_000_000 : null;
  return summary;
}

/** Models a Dot can use, from the same Chat catalog the panes use (Settings → Dots → Model). */
export interface DotModelChoices {
  providers: Array<{ providerId: string; providerName: string; statusReason: string | null; options: AgentPaneModelOption[] }>;
}

/** Stored settings with defaults for every missing or invalid field. */
export function dotUserSettingsFrom(stored: { defaultDotId: string | null; settings: Record<string, unknown>; updatedAt: string | null } | null): DotUserSettings {
  const settings = stored?.settings ?? {};
  const field = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : fallback;
  };
  const proactive = typeof settings.proactive === "object" && settings.proactive ? settings.proactive as Record<string, unknown> : {};
  return {
    defaultDotId: field(dotIdSchema.nullable(), stored?.defaultDotId ?? null, null),
    defaultModelConfigId: field(dotUserSettingsSchema.shape.defaultModelConfigId, settings.defaultModelConfigId ?? null, null),
    defaultPermissionMode: field(dotUserSettingsSchema.shape.defaultPermissionMode, settings.defaultPermissionMode ?? null, null),
    confirmExternalActions: field(z.boolean(), settings.confirmExternalActions, true),
    proactive: Object.fromEntries(Object.entries(DOT_PROACTIVE_DEFAULTS).map(([key, fallback]) =>
      [key, field(dotProactiveSettingsSchema.shape[key as keyof DotProactiveSettings] as z.ZodType<unknown>, proactive[key], fallback)])) as DotProactiveSettings,
    updatedAt: stored?.updatedAt ?? null
  };
}

export const dotFeedOriginSchema = z.enum(["USER", "VOICE", "CHANNEL", "APPROVAL", "SCHEDULE", "GOAL", "DELEGATION", "PROACTIVE"]);
export const dotFeedItemSchema = z.object({
  id: z.string().min(1).max(200),
  /** MESSAGE is a bubble, EVENT a one-line record of work Space started, NOTICE a message the Dot sent on its own. */
  kind: z.enum(["MESSAGE", "EVENT", "NOTICE"]),
  author: z.enum(["USER", "DOT"]),
  origin: dotFeedOriginSchema,
  content: z.string().max(50000),
  summary: z.string().max(400).nullable(),
  status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED"]),
  createdAt: z.iso.datetime(),
  sessionId: z.string().min(1).max(200).nullable(),
  roomId: z.string().min(1).max(200).nullable(),
  runId: z.string().min(1).max(200).nullable(),
  /** The first message of a conversation (a new context started with ✎). */
  conversationStart: z.boolean(),
  link: z.object({ label: z.string().min(1).max(120), url: z.url({ protocol: /^https$/ }) }).strict().nullable(),
  /** Files the user sent with the message (names only); a message may be only files. */
  attachments: z.array(z.object({ name: z.string().min(1).max(300), mimeType: z.string().max(200) }).strict()).max(8)
}).strict();
export const dotFeedSchema = z.object({
  dotId: dotIdSchema,
  /** DOT: the owner's workspace rooms. ROOM: only the Agent Proof room it was asked from. */
  scope: z.enum(["DOT", "ROOM"]),
  items: z.array(dotFeedItemSchema).max(100),
  /** Pass as `before` to read older items; null when there are none. */
  nextBefore: z.string().nullable(),
  /** Pass as `after` to read newer items. */
  latestCursor: z.string().nullable(),
  lastActiveAt: z.iso.datetime().nullable(),
  unread: z.number().int().min(0).max(99)
}).strict();
export type DotFeedOrigin = z.infer<typeof dotFeedOriginSchema>;
export type DotFeedItem = z.infer<typeof dotFeedItemSchema>;
export type DotFeed = z.infer<typeof dotFeedSchema>;

const cursorPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([A-Za-z0-9:_.-]{1,200})$/;
export const dotFeedCursorSchema = z.string().max(240).regex(cursorPattern);
export function dotFeedCursor(item: { createdAt: string; id: string }): string {
  return `${new Date(item.createdAt).toISOString()}|${item.id}`;
}
export function parseDotFeedCursor(cursor: string): { createdAt: string; id: string } {
  const match = cursorPattern.exec(cursor);
  if (!match) throw new Error("Invalid feed cursor.");
  return { createdAt: match[1]!, id: match[2]! };
}

/** Request-key prefixes of turns Space starts for the user (Stages 4–6); a plain key is the user's own message. */
export function dotFeedOrigin(clientRequestId: string | null | undefined): DotFeedOrigin | "EVALUATION" {
  const key = clientRequestId ?? "";
  if (key.startsWith("live-")) return "VOICE";
  if (key.startsWith("channel-")) return "CHANNEL";
  if (key.startsWith("approval-")) return "APPROVAL";
  if (key.startsWith("schedule-") || key.startsWith("proactive-")) return "SCHEDULE";
  if (key.startsWith("goal-")) return "GOAL";
  if (key.startsWith("delegation-")) return "DELEGATION";
  if (key.startsWith("eval-")) return "EVALUATION";
  return "USER";
}

const internalActionBlockPattern = /```space-(?:room|memory|clipboard|chat|task|skill|mcp|browser)-actions\b[\s\S]*?(?:```|$)/gi;
/** Assistant text without the fenced action blocks Space executes. */
export function visibleAssistantText(content: string): string {
  return content.replace(internalActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

function firstLine(content: string, max = 240): string {
  const line = content.trim().split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function eventSummary(origin: DotFeedOrigin, content: string): string {
  if (origin === "SCHEDULE") {
    const title = /^Scheduled task “(.+?)”/.exec(content)?.[1];
    return title ? `Reminder: ${firstLine(title, 200)}` : firstLine(content);
  }
  if (origin === "GOAL") {
    const step = /^Goal step (\d+)/.exec(content)?.[1];
    const objective = /^Objective: (.+)$/m.exec(content)?.[1];
    return step ? `Goal step ${step}${objective ? `: ${firstLine(objective, 160)}` : ""}` : firstLine(content);
  }
  return firstLine(content);
}

export interface DotFeedMessageRow {
  id: string; role: string; content: string; status: string; createdAt: string;
  sessionId: string | null; roomId: string | null; runId: string | null; clientRequestId: string | null;
  conversationStart: boolean; notice?: boolean; link?: { label: string; url: string } | null;
  attachments?: Array<{ name?: unknown; mimeType?: unknown }> | null;
}
/**
 * One stored message as the user sees it. Work Space started (approvals, reminders, Goal
 * steps, delegation reports) is an EVENT, not a message the user typed. Hidden: empty
 * placeholders, system and tool rows, and evaluation runs.
 */
export function projectDotFeedRow(row: DotFeedMessageRow): DotFeedItem | null {
  const status = dotFeedItemSchema.shape.status.safeParse(row.status);
  if (!status.success) return null;
  const createdAt = new Date(row.createdAt).toISOString();
  const base = { id: row.id, status: status.data, createdAt, sessionId: row.sessionId, roomId: row.roomId, runId: row.runId,
    conversationStart: row.conversationStart, link: null, summary: null, attachments: [] };
  if (row.notice) {
    const content = row.content.trim();
    return content ? { ...base, kind: "NOTICE", author: "DOT", origin: "PROACTIVE", content: content.slice(0, 50000), link: row.link ?? null } : null;
  }
  const origin = dotFeedOrigin(row.clientRequestId);
  if (origin === "EVALUATION") return null;
  if (row.role === "assistant") {
    const content = visibleAssistantText(row.content);
    if (!content && status.data !== "FAILED") return null;
    return { ...base, kind: "MESSAGE", author: "DOT", origin, content: content.slice(0, 50000) };
  }
  if (row.role !== "user") return null;
  const content = row.content.trim();
  const attachments = (row.attachments ?? []).flatMap((file) => typeof file?.name === "string" && file.name.trim()
    ? [{ name: file.name.trim().slice(0, 300), mimeType: typeof file.mimeType === "string" ? file.mimeType.slice(0, 200) : "" }] : []).slice(0, 8);
  // A photo or file sent without text is the user's request too (Stage 5).
  if (!content && !(attachments.length && origin === "USER")) return null;
  if (origin === "USER" || origin === "CHANNEL") return { ...base, kind: "MESSAGE", author: "USER", origin, content: content.slice(0, 50000), attachments };
  if (origin === "VOICE") return { ...base, kind: "MESSAGE", author: "USER", origin, content: content.replace(/^\(Voice\)\s*/, "").slice(0, 50000) };
  return { ...base, kind: "EVENT", author: "USER", origin, content: content.slice(0, 50000), summary: eventSummary(origin, content) };
}
