import { z } from "zod";
import type { ModelPriceCatalog } from "./agent-run-ledger.js";

/**
 * Space Dots Stage 7: Auto model routing, in shadow mode only.
 *
 * For every Chat task Space records which model and reasoning the versioned
 * Auto policy would have chosen, next to what actually ran. The choice is
 * never applied: the user's or the session's selection always runs until the
 * declared evaluation gates pass on real runs. The policy only uses facts it
 * can check — the runtime's model catalog (input modalities, context window,
 * reasoning levels), the models the user can select right now, quota state
 * when reported, and the operator's price list — and records why.
 */
export const AUTO_ROUTE_POLICY_VERSION = "auto-route-v1";

export const autoRouteTierSchema = z.enum(["LIGHT", "STANDARD", "DEEP"]);
export type AutoRouteTier = z.infer<typeof autoRouteTierSchema>;

/** What Space knows about the task when it is submitted. */
export const autoRouteTaskSchema = z.object({
  promptChars: z.number().int().min(0),
  /** Input kinds the model has to accept natively (images are sent as images; other files are read into text). */
  modalities: z.array(z.enum(["text", "image"])).min(1).max(2),
  attachments: z.number().int().min(0).max(64),
  /** Characters Space extracted from attached files. */
  attachmentChars: z.number().int().min(0),
  toolGateway: z.boolean(),
  /** Goal steps, reminders and proactive work run without the user watching. */
  background: z.boolean(),
  /** The user declared result checks for the task. */
  declaredChecks: z.boolean()
}).strict();
export type AutoRouteTask = z.infer<typeof autoRouteTaskSchema>;

export const autoRouteCandidateSchema = z.object({
  modelId: z.string().min(1).max(200),
  /** From the runtime's model catalog; null when the catalog does not say. */
  inputModalities: z.array(z.string().min(1).max(40)).max(10).nullable(),
  contextWindow: z.number().int().positive().nullable(),
  reasoningEfforts: z.array(z.string().min(1).max(40)).max(20),
  /** The provider's default model. */
  isDefault: z.boolean(),
  quota: z.enum(["OK", "LOW", "EXHAUSTED", "UNKNOWN"])
}).strict();
export type AutoRouteCandidate = z.infer<typeof autoRouteCandidateSchema>;

const modelChoice = z.object({ model: z.string().min(1).max(200), reasoning: z.string().min(1).max(40).nullable() }).strict();

/** The shadow record kept with each task. */
export const autoRouteShadowSchema = z.object({
  policyVersion: z.string().min(1).max(80),
  mode: z.literal("SHADOW"),
  decidedAt: z.string().datetime({ offset: true }),
  tier: autoRouteTierSchema,
  estimatedInputTokens: z.number().int().min(0),
  /** Null when no selectable model satisfies the task's constraints. */
  choice: modelChoice.nullable(),
  reasons: z.array(z.string().min(1).max(300)).max(12),
  excluded: z.array(z.object({ model: z.string().min(1).max(200), reason: z.string().min(1).max(200) }).strict()).max(40),
  /** What ran: an explicit user choice always wins; Auto is not applied in shadow mode. */
  actual: z.object({ model: z.string().min(1).max(200).nullable(), reasoning: z.string().min(1).max(40).nullable(),
    source: z.enum(["USER_SELECTED", "RUNTIME_DEFAULT"]) }).strict(),
  agreesWithActual: z.boolean().nullable()
}).strict();
export type AutoRouteShadow = z.infer<typeof autoRouteShadowSchema>;

/** Rough token estimate: about four characters per token, a fixed allowance per image and for instructions. */
export function estimateAutoRouteInputTokens(task: AutoRouteTask): number {
  const images = task.modalities.includes("image") ? 1_500 : 0;
  return Math.ceil((task.promptChars + task.attachmentChars) / 4) + images * Math.max(1, task.attachments) + (task.toolGateway ? 12_000 : 6_000);
}

export function autoRouteTier(task: AutoRouteTask, estimatedInputTokens: number): { tier: AutoRouteTier; reason: string } {
  if (task.background) return { tier: "DEEP", reason: "Background work runs without the user watching." };
  if (task.declaredChecks) return { tier: "DEEP", reason: "The task declares result checks." };
  if (estimatedInputTokens > 60_000) return { tier: "DEEP", reason: "The task carries a large amount of input." };
  if (task.attachments >= 3) return { tier: "DEEP", reason: "The task has several attached files." };
  if (task.promptChars <= 280 && task.attachments === 0) return { tier: "LIGHT", reason: "A short request with no files." };
  return { tier: "STANDARD", reason: "An ordinary request." };
}

const tierEffort: Record<AutoRouteTier, string> = { LIGHT: "low", STANDARD: "medium", DEEP: "high" };
const effortOrder = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** The tier's effort, or the nearest supported level above it (below only when nothing higher exists). */
function supportedEffort(wanted: string, supported: string[]): string | null {
  if (!supported.length) return null;
  if (supported.includes(wanted)) return wanted;
  const rank = (effort: string) => { const index = effortOrder.indexOf(effort); return index < 0 ? effortOrder.length : index; };
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b));
  return sorted.find((effort) => rank(effort) > rank(wanted)) ?? sorted.at(-1)!;
}

/** Per-million cost of a typical request mix, for ranking only; null when the model has no price. */
function priceIndex(model: string, prices: ModelPriceCatalog | null): number | null {
  const price = prices?.prices.find((entry) => entry.model === model);
  return price ? price.inputPerMillion * 0.8 + price.outputPerMillion * 0.2 : null;
}

export interface AutoRouteInput {
  task: AutoRouteTask;
  candidates: AutoRouteCandidate[];
  prices: ModelPriceCatalog | null;
  actual: AutoRouteShadow["actual"];
  at: string;
}

export function decideAutoRoute(input: AutoRouteInput): AutoRouteShadow {
  const task = autoRouteTaskSchema.parse(input.task);
  const estimatedInputTokens = estimateAutoRouteInputTokens(task);
  const { tier, reason: tierReason } = autoRouteTier(task, estimatedInputTokens);
  const reasons = [tierReason];
  const excluded: AutoRouteShadow["excluded"] = [];
  const eligible = input.candidates.filter((candidate) => {
    const exclude = (reason: string) => { excluded.push({ model: candidate.modelId, reason }); return false; };
    if (candidate.quota === "EXHAUSTED") return exclude("Its usage quota is exhausted.");
    if (task.modalities.includes("image") && !candidate.inputModalities?.includes("image")) {
      return exclude(candidate.inputModalities ? "It does not accept images." : "The catalog does not say it accepts images.");
    }
    // Leave room for the conversation so far and the answer.
    if (candidate.contextWindow !== null && estimatedInputTokens * 1.5 > candidate.contextWindow) return exclude("Its context window is too small for this input.");
    return true;
  });
  if (!eligible.length) {
    reasons.push("No selectable model satisfies the task's constraints.");
    return autoRouteShadowSchema.parse({ policyVersion: AUTO_ROUTE_POLICY_VERSION, mode: "SHADOW", decidedAt: input.at, tier, estimatedInputTokens,
      choice: null, reasons, excluded: excluded.slice(0, 40), actual: input.actual, agreesWithActual: null });
  }
  // Light work goes to the cheapest priced model; everything else keeps the provider's default.
  // Without measured quality per model, cost is the only defensible reason to move light work.
  const fallback = eligible.find((candidate) => candidate.isDefault) ?? eligible[0]!;
  let chosen = fallback;
  if (tier === "LIGHT") {
    const priced = eligible.map((candidate) => ({ candidate, index: priceIndex(candidate.modelId, input.prices) }))
      .filter((entry): entry is { candidate: AutoRouteCandidate; index: number } => entry.index !== null)
      .sort((a, b) => a.index - b.index || a.candidate.modelId.localeCompare(b.candidate.modelId));
    if (priced.length && priced[0]!.candidate !== fallback) {
      chosen = priced[0]!.candidate;
      reasons.push(`The cheapest priced model that fits (${input.prices!.version}).`);
    } else {
      reasons.push(priced.length ? "The default model is also the cheapest priced one." : "No prices are configured, so the default model stays.");
    }
  } else {
    reasons.push(fallback.isDefault ? "The provider's default model fits." : "The first selectable model that fits.");
  }
  if (chosen.quota === "LOW") reasons.push("Its quota is low.");
  const reasoning = supportedEffort(tierEffort[tier], chosen.reasoningEfforts);
  const choice = { model: chosen.modelId, reasoning };
  // The runtime default is only known once the runtime reports it; reasoning counts only when it was chosen.
  const agreesWithActual = input.actual.model === null ? null
    : input.actual.model === choice.model && (input.actual.reasoning === null || input.actual.reasoning === choice.reasoning);
  return autoRouteShadowSchema.parse({ policyVersion: AUTO_ROUTE_POLICY_VERSION, mode: "SHADOW", decidedAt: input.at, tier, estimatedInputTokens,
    choice, reasons: reasons.slice(0, 12), excluded: excluded.slice(0, 40), actual: input.actual, agreesWithActual });
}

/** One recorded task for the shadow summary. */
export interface AutoRouteShadowRun {
  autoRoute: AutoRouteShadow;
  status: string;
  runtimeModelAtStart: string | null;
  ledger: { usage: { status: string; totalTokens?: number; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
    cost: { status: string; amountUsd: number | null }; evaluation: { status: string; qualityScore?: number; criticalFailure?: boolean } } | null;
}
interface ShadowGroup { runs: number; completed: number; failed: number; checksScored: number; checksPassed: number }
const emptyGroup = (): ShadowGroup => ({ runs: 0, completed: 0, failed: 0, checksScored: 0, checksPassed: 0 });

/**
 * Aggregates shadow decisions with what happened to each task. Agreement uses
 * the runtime's reported model when the user kept the default. The same-token
 * price of Auto's choice is hypothetical: another model would use different
 * tokens, so it informs a canary decision and never proves a saving.
 */
export function summarizeAutoRouteShadow(runs: AutoRouteShadowRun[], prices: ModelPriceCatalog | null) {
  const byTier: Record<AutoRouteTier, { runs: number; agree: number; differ: number; unknown: number }> = {
    LIGHT: { runs: 0, agree: 0, differ: 0, unknown: 0 }, STANDARD: { runs: 0, agree: 0, differ: 0, unknown: 0 }, DEEP: { runs: 0, agree: 0, differ: 0, unknown: 0 } };
  const wouldChoose: Record<string, number> = {};
  const outcomes = { agree: emptyGroup(), differ: emptyGroup(), unknown: emptyGroup() };
  let noFit = 0, measured = 0, actualEstimated = 0, actualUsd = 0, hypotheticalPriced = 0, hypotheticalUsd = 0;
  for (const run of runs) {
    const route = run.autoRoute;
    const tier = byTier[route.tier];
    tier.runs += 1;
    if (!route.choice) noFit += 1; else wouldChoose[route.choice.model] = (wouldChoose[route.choice.model] ?? 0) + 1;
    const agrees = route.agreesWithActual ?? (route.choice && run.runtimeModelAtStart ? route.choice.model === run.runtimeModelAtStart : null);
    const key = agrees === null ? "unknown" : agrees ? "agree" : "differ";
    tier[key] += 1;
    const group = outcomes[key];
    group.runs += 1;
    if (run.status === "COMPLETED") group.completed += 1;
    if (run.status === "FAILED" || run.status === "INTERRUPTED") group.failed += 1;
    if (run.ledger?.evaluation.status === "SCORED") {
      group.checksScored += 1;
      if (run.ledger.evaluation.qualityScore === 100 && !run.ledger.evaluation.criticalFailure) group.checksPassed += 1;
    }
    const usage = run.ledger?.usage;
    if (usage?.status === "MEASURED") {
      measured += 1;
      const price = route.choice ? prices?.prices.find((entry) => entry.model === route.choice!.model) : undefined;
      if (price && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        const cached = usage.cachedInputTokens ?? 0;
        hypotheticalPriced += 1;
        hypotheticalUsd += ((usage.inputTokens - cached) * price.inputPerMillion + cached * (price.cachedInputPerMillion ?? price.inputPerMillion)
          + usage.outputTokens * price.outputPerMillion) / 1_000_000;
      }
    }
    if (run.ledger?.cost.status === "ESTIMATED" || run.ledger?.cost.status === "ACTUAL") { actualEstimated += 1; actualUsd += run.ledger.cost.amountUsd ?? 0; }
  }
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  return {
    policyVersion: AUTO_ROUTE_POLICY_VERSION, mode: "SHADOW" as const, applied: false, runs: runs.length, noFit, byTier, wouldChoose, outcomes,
    usage: { measured, unknown: runs.length - measured },
    cost: { pricedRuns: actualEstimated, estimatedUsd: round(actualUsd), unknownRuns: runs.length - actualEstimated,
      sameTokenEstimateForAutoChoice: { runs: hypotheticalPriced, usd: round(hypotheticalUsd), priceCatalogVersion: prices?.version ?? null,
        note: "Hypothetical: the same tokens priced at Auto's choice; another model would use different tokens." } },
    note: "Auto is not applied. The current model choices stay until the declared evaluation gates pass on real runs."
  };
}
export type AutoRouteShadowSummary = ReturnType<typeof summarizeAutoRouteShadow>;
