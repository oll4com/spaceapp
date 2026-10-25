import { z } from "zod";

/**
 * One summarized title line. The first prompt creates line 1; a later prompt
 * adds a line only when the title model judges it to be different work.
 */
export const taskTopicSchema = z.object({
  title: z.string().max(120),
  summary: z.string().max(400).default(""),
  source: z.enum(["local", "native", "ai"]),
  at: z.string().datetime({ offset: true }),
  hasImages: z.boolean().optional(),
});
export type TaskTopic = z.infer<typeof taskTopicSchema>;
export const taskTopicsMax = 12;

export const taskMetadataSchema = z.object({
  taskKey: z.string().min(1).max(240),
  version: z.number().int().nonnegative(),
  description: z.string().max(1800),
  steps: z.array(z.string().max(220)).max(5),
  earlierWork: z.string().max(400).default(""),
  source: z.enum(["local", "native", "ai"]),
  generationStatus: z.enum(["pending", "ready", "deferred", "unavailable"]),
  nativeSyncStatus: z.enum(["pending", "synced", "unsupported", "failed"]),
  nativeTitleManual:z.boolean().optional(),
  harnessSessionId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/).optional(),
  providerId: z.string().max(160).nullable().default(null),
  modelId: z.string().max(200).nullable().default(null),
  preferredCandidateId: z.string().max(320).nullable().optional(),
  planId: z.string().max(160).nullable().optional(),
  topics: z.array(taskTopicSchema).max(taskTopicsMax).optional(),
  /** The title the CLI itself saved for this task, when the CLI type keeps one. */
  nativeTitle: z.string().max(160).nullable().optional(),
  nativeTitleLabel: z.string().max(60).nullable().optional(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type TaskMetadata = z.infer<typeof taskMetadataSchema>;

export const taskTitleSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  allowedProviderIds: z.array(z.string().min(1).max(160)).max(100).default([]),
  preferredCandidateIds: z
    .array(z.string().min(1).max(320))
    .max(20)
    .default([]),
  subscriptionProviderIds: z
    .array(z.string().min(1).max(160))
    .max(100)
    .default([]),
  subscriptionReservePercent: z.number().min(0).max(95).default(20),
  perTaskHourAttempts: z.number().int().min(1).max(60).default(8),
  perTaskDayAttempts: z.number().int().min(1).max(500).default(30),
  globalDayAttempts: z.number().int().min(1).max(5000).default(200),
});
export type TaskTitleSettings = z.infer<typeof taskTitleSettingsSchema>;

export interface TaskTitleState {
  key: string;
  /** Stable across temporary -> native identity binding, so budgets never reset. */
  budgetKey?: string;
  version: number;
  paneId: string;
  sessionId: string;
  runtimeId: string;
  nativeId: string | null;
  revisionId: string | null;
  requestHash: string;
  request: string;
  title: string;
  metadata: TaskMetadata;
  dueAt: string | null;
  lastAttemptAt: string | null;
  preferredCandidateId: string | null;
  previousSummary?: string;
  syncOnly?: boolean;
  resetNativeManual?: boolean;
  lastNativeTitle?: string | null;
  /** Validated image uploads attached to the latest request (absolute paths). */
  images?: string[];
  /** Substantive requests not yet summarized, latest last. */
  pendingRequests?: string[];
  /** "Regenerate summary": the next result replaces the latest title line. */
  regenerateLatest?: boolean;
}

export interface TaskTitleCandidateStatus {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  billing: "free" | "subscription" | "unknown";
  availability: "available" | "unknown" | "cooldown" | "unavailable";
  remainingPercent: number | null;
  checkedAt: string;
  cooldownUntil: string | null;
  /** Can read attached images, so screenshots inform the title. */
  vision?: boolean;
  /** Internal: the free model the daily picker verified with a real call. */
  pickerVerified?: boolean;
}
