import { z } from "zod";

/**
 * Operator-owned model metadata. Prices are deliberately optional: Space must
 * never invent a provider price or silently substitute a different model.
 */
export const liveModelPolicyEntrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  provider: z.enum(["google", "openai", "vercel", "jev", "local"]),
  protocol: z.enum(["gemini-live", "gpt-live", "openai-realtime", "responses", "classifier"]),
  tier: z.enum(["economy", "balanced", "quality"]).default("balanced"),
  enabled: z.boolean().default(true),
  inputUsdPer1kTokens: z.number().nonnegative().nullable().default(null),
  outputUsdPer1kTokens: z.number().nonnegative().nullable().default(null),
  audioUsdPerMinute: z.number().nonnegative().nullable().default(null),
  maxDailyUsd: z.number().positive().nullable().default(null),
  notes: z.string().trim().max(500).nullable().default(null)
}).strict();

export const liveModelPolicySchema = z.object({
  revision: z.string().trim().min(1).max(120),
  source: z.enum(["environment", "empty"]),
  mode: z.enum(["economy", "balanced", "quality"]),
  dailyBudgetUsd: z.number().positive().nullable(),
  models: z.array(liveModelPolicyEntrySchema).max(500)
}).strict();

export type LiveModelPolicyEntry = z.infer<typeof liveModelPolicyEntrySchema>;
export type LiveModelPolicy = z.infer<typeof liveModelPolicySchema>;

function parseBudget(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseMode(raw: string | undefined): LiveModelPolicy["mode"] {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "economy" || normalized === "quality" ? normalized : "balanced";
}

export function parseLiveModelPolicy(raw: string | undefined, budgetRaw?: string, modeRaw?: string): LiveModelPolicy {
  const mode = parseMode(modeRaw);
  if (!raw?.trim()) {
    return liveModelPolicySchema.parse({ revision: "empty", source: "empty", mode, dailyBudgetUsd: parseBudget(budgetRaw), models: [] });
  }
  try {
    const value = JSON.parse(raw) as unknown;
    const models = z.array(liveModelPolicyEntrySchema).max(500).parse(value);
    return liveModelPolicySchema.parse({
      revision: `env:${Buffer.from(raw).toString("base64url").slice(0, 32)}`,
      source: "environment",
      mode,
      dailyBudgetUsd: parseBudget(budgetRaw),
      models
    });
  } catch {
    // Invalid operator metadata is visible and empty, never a guessed catalog.
    return liveModelPolicySchema.parse({ revision: "invalid", source: "empty", mode, dailyBudgetUsd: parseBudget(budgetRaw), models: [] });
  }
}

export function estimateLiveCost(input: {
  model: LiveModelPolicyEntry;
  inputTokens?: number;
  outputTokens?: number;
  audioMinutes?: number;
}): number | null {
  const { model } = input;
  const tokenCost = model.inputUsdPer1kTokens == null || model.outputUsdPer1kTokens == null
    ? null
    : ((Math.max(0, input.inputTokens ?? 0) / 1000) * model.inputUsdPer1kTokens) +
      ((Math.max(0, input.outputTokens ?? 0) / 1000) * model.outputUsdPer1kTokens);
  const audioCost = model.audioUsdPerMinute == null || input.audioMinutes == null
    ? null
    : Math.max(0, input.audioMinutes) * model.audioUsdPerMinute;
  if (tokenCost == null && audioCost == null) return null;
  return (tokenCost ?? 0) + (audioCost ?? 0);
}

export function configuredDelegateModel(
  policy: LiveModelPolicy,
  provider: LiveModelPolicyEntry["provider"],
  fallback: string,
  mode: LiveModelPolicy["mode"] = policy.mode
): string {
  const candidates = policy.models.filter((entry) => entry.enabled && entry.provider === provider &&
    (entry.protocol === "responses" || entry.protocol === "classifier"));
  const configured = candidates.find((entry) => entry.tier === mode) || candidates.find((entry) => entry.tier === "balanced");
  return configured?.id || fallback;
}
