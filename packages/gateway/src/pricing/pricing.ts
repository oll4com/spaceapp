import snapshot from "./pricing-snapshot.json" with { type: "json" };

/**
 * API-equivalent request cost, ported from codex-lb `app/core/usage/pricing.py` (MIT, Soju06/codex-lb), with its
 * bundled price snapshot. Costs are what the same tokens would cost on the API, not subscription credits.
 */
export interface ModelPrice {
  input_per_1m: number;
  output_per_1m: number;
  cached_input_per_1m?: number;
  priority_multiplier?: number;
  priority_input_per_1m?: number;
  priority_output_per_1m?: number;
  priority_cached_input_per_1m?: number;
  flex_input_per_1m?: number;
  flex_output_per_1m?: number;
  flex_cached_input_per_1m?: number;
  long_context_threshold_tokens?: number;
  long_context_input_per_1m?: number;
  long_context_output_per_1m?: number;
  long_context_cached_input_per_1m?: number;
  priority_long_context_input_per_1m?: number;
  priority_long_context_output_per_1m?: number;
  priority_long_context_cached_input_per_1m?: number;
  flex_long_context_input_per_1m?: number;
  flex_long_context_output_per_1m?: number;
  flex_long_context_cached_input_per_1m?: number;
}

export interface CostUsage { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null }

const defaultPrices = (snapshot as { models: Record<string, ModelPrice> }).models;

/** Glob aliases (longest pattern wins), from codex-lb DEFAULT_MODEL_ALIASES. */
export const defaultModelAliases: Record<string, string> = {
  "gpt-5.6": "gpt-5.6-sol", "gpt-5.6-sol*": "gpt-5.6-sol", "gpt-5.6-terra*": "gpt-5.6-terra", "gpt-5.6-luna*": "gpt-5.6-luna",
  "gpt-5.5-pro*": "gpt-5.5-pro", "gpt-5.5*": "gpt-5.5", "gpt-5.4-pro*": "gpt-5.4-pro", "gpt-5.4-mini*": "gpt-5.4-mini",
  "gpt-5.4-nano*": "gpt-5.4-nano", "gpt-5.4*": "gpt-5.4", "gpt-5.3-codex*": "gpt-5.3-codex", "gpt-5.3-chat-latest*": "gpt-5.3-chat-latest",
  "gpt-5.2-codex*": "gpt-5.2-codex", "gpt-5.2-chat-latest*": "gpt-5.2-chat-latest", "gpt-5.3*": "gpt-5.3", "gpt-5.1-chat-latest*": "gpt-5.1-chat-latest",
  "gpt-5.2*": "gpt-5.2", "gpt-5-chat-latest*": "gpt-5-chat-latest", "gpt-5.1*": "gpt-5.1", "gpt-5*": "gpt-5",
  "gpt-5.1-codex-max*": "gpt-5.1-codex-max", "gpt-5.1-codex-mini*": "gpt-5.1-codex-mini", "gpt-5.1-codex*": "gpt-5.1-codex", "gpt-5-codex*": "gpt-5-codex"
};

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function resolveAlias(model: string, aliases: Record<string, string>): string | null {
  let best: { length: number; target: string } | null = null;
  for (const [pattern, target] of Object.entries(aliases)) {
    if (globToRegExp(pattern.toLowerCase()).test(model) && (!best || pattern.length > best.length)) best = { length: pattern.length, target };
  }
  return best?.target ?? null;
}

export function priceForModel(model: string | null, prices: Record<string, ModelPrice> = defaultPrices, aliases = defaultModelAliases): { model: string; price: ModelPrice } | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  for (const [key, price] of Object.entries(prices)) if (key.toLowerCase() === normalized) return { model: key, price };
  const dated = /^(.+)-\d{4}-\d{2}-\d{2}$/.exec(normalized);
  if (dated && prices[dated[1]!]) return { model: dated[1]!, price: prices[dated[1]!]! };
  const alias = resolveAlias(normalized, aliases);
  // A bare `gpt-5*` alias must not price an unknown gpt-5.x model as gpt-5.
  if (!alias || (alias === "gpt-5" && normalized.startsWith("gpt-5."))) return null;
  for (const [key, price] of Object.entries(prices)) if (key.toLowerCase() === alias.toLowerCase()) return { model: key, price };
  return null;
}

const tierOf = (serviceTier: string | null): "priority" | "flex" | null => {
  const normalized = serviceTier?.trim().toLowerCase() ?? null;
  if (normalized === "priority" || normalized === "fast") return "priority";
  if (normalized === "flex") return "flex";
  return null;
};

function effectiveRates(input: number, price: ModelPrice, serviceTier: string | null): [number, number, number] {
  const tier = tierOf(serviceTier);
  const isLong = (price.long_context_threshold_tokens ?? 0) > 0 && input > price.long_context_threshold_tokens!;
  const hasStandardLong = price.long_context_input_per_1m !== undefined && price.long_context_output_per_1m !== undefined;
  let inputRate = price.input_per_1m;
  let cachedRate = price.cached_input_per_1m ?? inputRate;
  let outputRate = price.output_per_1m;
  if (isLong && tier) {
    const longInput = price[`${tier}_long_context_input_per_1m`];
    const longOutput = price[`${tier}_long_context_output_per_1m`];
    const longCached = price[`${tier}_long_context_cached_input_per_1m`];
    if (longInput !== undefined && longOutput !== undefined) return [longInput, longCached ?? longInput, longOutput];
  }
  if (tier === "priority") {
    if (price.priority_input_per_1m !== undefined && price.priority_output_per_1m !== undefined) {
      return [price.priority_input_per_1m, price.priority_cached_input_per_1m ?? price.priority_input_per_1m, price.priority_output_per_1m];
    }
    if (price.priority_multiplier !== undefined) {
      return [inputRate * price.priority_multiplier, cachedRate * price.priority_multiplier, outputRate * price.priority_multiplier];
    }
  }
  if (tier === "flex" && price.flex_input_per_1m !== undefined && price.flex_output_per_1m !== undefined) {
    inputRate = price.flex_input_per_1m;
    cachedRate = price.flex_cached_input_per_1m ?? inputRate;
    outputRate = price.flex_output_per_1m;
    if (isLong && hasStandardLong) return [inputRate * 2, cachedRate * 2, outputRate * 1.5];
    return [inputRate, cachedRate, outputRate];
  }
  if (isLong && hasStandardLong) {
    inputRate = price.long_context_input_per_1m!;
    cachedRate = price.long_context_cached_input_per_1m ?? inputRate;
    outputRate = price.long_context_output_per_1m!;
  }
  return [inputRate, cachedRate, outputRate];
}

/** Cost in USD, or null when usage or the model's price is unknown (unknown stays unknown, never zero). */
export function costUsd(usage: CostUsage | null, model: string | null, serviceTier: string | null, prices?: Record<string, ModelPrice>): number | null {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) return null;
  const resolved = priceForModel(model, prices);
  if (!resolved) return null;
  const cached = Math.max(0, Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens));
  const [inputRate, cachedRate, outputRate] = effectiveRates(usage.inputTokens, resolved.price, serviceTier);
  return ((usage.inputTokens - cached) / 1e6) * inputRate + (cached / 1e6) * cachedRate + (usage.outputTokens / 1e6) * outputRate;
}

interface AnthropicPrice {
  prefix: string;
  input: number;
  output: number;
  /** Cache reads per 1M; 0.1x input unless the model's card says otherwise. */
  cacheRead?: number;
  /** Rate card for prompts longer than `threshold` tokens (input + cache reads + cache writes). */
  long?: { threshold: number; input: number; output: number };
  /** Price multiplier of `speed: "fast"`; a model without one leaves fast requests unpriced. */
  fast?: number;
}

/**
 * Anthropic API list prices per 1M tokens (Claude API reference, cached 2026-10-06). Cache writes cost 1.25x input for
 * the 5-minute TTL and 2x for the 1-hour TTL; cache reads 0.1x input unless `cacheRead` says otherwise.
 */
const anthropicPrices: AnthropicPrice[] = [
  { prefix: "claude-fable-5-1", input: 10, output: 50, cacheRead: 0.25 },
  { prefix: "claude-mythos-5-1", input: 10, output: 50, cacheRead: 0.25 },
  { prefix: "claude-fable-5", input: 10, output: 50 },
  { prefix: "claude-mythos-5", input: 10, output: 50 },
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  { prefix: "claude-opus-5", input: 5, output: 25, fast: 2 },
  { prefix: "claude-opus-4-8", input: 5, output: 25 },
  { prefix: "claude-opus-4-7", input: 5, output: 25 },
  { prefix: "claude-opus-4-6", input: 5, output: 25 },
  { prefix: "claude-opus-4-5", input: 5, output: 25 },
  { prefix: "claude-opus-4-1", input: 15, output: 75 },
  { prefix: "claude-opus-4", input: 15, output: 75 },
  { prefix: "claude-sonnet-5-5", input: 2, output: 10 },
  { prefix: "claude-sonnet-5", input: 2, output: 10 },
  { prefix: "claude-sonnet-4-6", input: 3, output: 15 },
  { prefix: "claude-sonnet-4-5", input: 3, output: 15 },
  { prefix: "claude-sonnet-4", input: 3, output: 15 },
  { prefix: "claude-haiku-5-5", input: 0.1, output: 0.5, long: { threshold: 100_000, input: 0.5, output: 2.5 } },
  { prefix: "claude-haiku-4-5", input: 1, output: 5 },
  { prefix: "claude-3-7-sonnet", input: 3, output: 15 },
  { prefix: "claude-3-5-haiku", input: 0.8, output: 4 }
];

// Exact ids, dated snapshots and `-latest` only, so a newer model is never priced as an older one.
const anthropicPrice = (model: string) => {
  const normalized = model.toLowerCase();
  return anthropicPrices.find((entry) => new RegExp(`^${entry.prefix}(?:-\\d{8}|-latest)?$`).test(normalized)) ?? null;
};

export interface ClaudeCostUsage {
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  /** Part of the cache writes made with the 1-hour TTL (`usage.cache_creation.ephemeral_1h_input_tokens`). */
  cacheCreation1hInputTokens?: number | null;
  outputTokens: number | null;
  /** `usage.speed`: "fast" for fast mode. */
  speed?: string | null;
}

/** API-equivalent cost of a Claude request, or null for an unknown model, an unpriced speed or incomplete usage. */
export function claudeCostUsd(usage: ClaudeCostUsage | null, model: string | null): number | null {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null || !model) return null;
  const price = anthropicPrice(model);
  if (!price) return null;
  const multiplier = usage.speed === "fast" ? price.fast ?? null : 1;
  if (multiplier === null) return null;
  const read = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheCreationInputTokens ?? 0;
  const writeLong = Math.min(write, usage.cacheCreation1hInputTokens ?? 0);
  const card = price.long && usage.inputTokens + read + write > price.long.threshold ? price.long : price;
  const cacheRead = card === price ? price.cacheRead ?? price.input * 0.1 : card.input * 0.1;
  const cost = usage.inputTokens * card.input + read * cacheRead + (write - writeLong) * card.input * 1.25 + writeLong * card.input * 2
    + usage.outputTokens * card.output;
  return (cost * multiplier) / 1e6;
}

/**
 * Gemini API Standard list prices per 1M tokens (ai.google.dev/gemini-api/docs/pricing, 2026-10-15; several double on
 * 2027-01-01). `long` is the card for prompts above 200k tokens.
 */
const geminiPrices: { model: string; input: number; cached: number; output: number; long?: { input: number; cached: number; output: number } }[] = [
  { model: "gemini-4-argon", input: 2, cached: 0.1, output: 10 },
  { model: "gemini-3.8-flash", input: 0.75, cached: 0.075, output: 3.75 },
  { model: "gemini-3.6-flash", input: 0.75, cached: 0.075, output: 3.75 },
  { model: "gemini-3.5-flash-lite", input: 0.3, cached: 0.03, output: 2.5 },
  { model: "gemini-3.1-flash-lite", input: 0.25, cached: 0.025, output: 1.5 },
  { model: "gemini-3.1-pro-preview", input: 2, cached: 0.2, output: 12, long: { input: 4, cached: 0.4, output: 18 } },
  { model: "gemini-3-flash-preview", input: 0.5, cached: 0.05, output: 3 },
  { model: "gemini-2.5-pro", input: 1.25, cached: 0.125, output: 10, long: { input: 2.5, cached: 0.25, output: 15 } },
  { model: "gemini-2.5-flash", input: 0.3, cached: 0.03, output: 2.5 },
  { model: "gemini-2.5-flash-lite", input: 0.1, cached: 0.01, output: 0.4 }
];

export interface GeminiCostUsage {
  /** `promptTokenCount`: cached tokens included. */
  promptTokens: number | null;
  cachedTokens: number | null;
  /** `candidatesTokenCount`; thinking (`thoughtsTokenCount`) is billed as output too. */
  outputTokens: number | null;
  thoughtsTokens: number | null;
}

/** API-equivalent cost of a Gemini request, or null for an unknown model or incomplete usage. */
export function geminiCostUsd(usage: GeminiCostUsage | null, model: string | null): number | null {
  if (!usage || usage.promptTokens === null || usage.outputTokens === null || !model) return null;
  // Exact ids, `-latest`, and Antigravity's names for the same model (gemini-3.8-flash-n, -high, -low), so a newer model is
  // never priced as an older one.
  const normalized = model.toLowerCase().replace(/^models\//, "").replace(/-(?:latest|n|minimal|low|medium|high)$/, "");
  const price = geminiPrices.find((entry) => entry.model === normalized);
  if (!price) return null;
  const card = price.long && usage.promptTokens > 200_000 ? price.long : price;
  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens);
  return ((usage.promptTokens - cached) * card.input + cached * card.cached + (usage.outputTokens + (usage.thoughtsTokens ?? 0)) * card.output) / 1e6;
}

/**
 * Per-million input prices of a model, for savings in dollars (Headroom prices saved tokens at the input price and
 * cache reads at the input price minus the cached price). Null when the model has no known price.
 */
export function inputPrices(model: string | null, provider: string): { input: number; cachedInput: number; cacheWrite: number } | null {
  if (!model) return null;
  if (provider === "CLAUDE" || provider === "ANTHROPIC_API" || model.toLowerCase().startsWith("claude-")) {
    const price = anthropicPrice(model);
    return price ? { input: price.input, cachedInput: price.cacheRead ?? price.input * 0.1, cacheWrite: price.input * 1.25 } : null;
  }
  const found = priceForModel(model);
  if (!found) return null;
  return { input: found.price.input_per_1m, cachedInput: found.price.cached_input_per_1m ?? found.price.input_per_1m, cacheWrite: found.price.input_per_1m };
}
