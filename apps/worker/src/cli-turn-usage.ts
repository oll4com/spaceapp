import type { CodexTokenTotals } from "@space/codex-app-server";
import { agentRunMeasuredUsageSchema } from "@space/contracts";

export const claudeTurnUsageSource = "claude-cli:result";
const prefix = "SPACE_CLI_TURN_USAGE_V1 ";
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The one-shot wrapper emits only native counters and model names, never the result text.
 * Old wrappers, incomplete stderr and ambiguous receipts remain UNKNOWN.
 */
export function claudeTurnUsage(stderr: string): { totals: CodexTokenTotals; model: string | null } | null {
  const lines = stderr.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || !stderr.endsWith("\n")) return null;
  let receipt: Record<string, unknown> | null;
  try { receipt = record(JSON.parse(lines[0]!.slice(prefix.length))); } catch { return null; }
  const usage = record(receipt?.usage);
  if (!usage) return null;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  if (!counter(input) || !counter(output) || !counter(read) || !counter(write)) return null;
  // Anthropic input_tokens excludes both cache reads and writes; the ledger includes both.
  const inputTokens = input + read + write;
  const outputTokens = output;
  const totals = { inputTokens, cachedInputTokens: read, outputTokens,
    reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens };
  const models = Object.keys(record(receipt?.modelUsage) ?? {});
  const model = models.length === 1 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(models[0]!) ? models[0]! : null;
  // Reuse the ledger's storage bounds; overflow must never fail an otherwise valid answer.
  if (totals.totalTokens <= 0 || !agentRunMeasuredUsageSchema.safeParse({ ...totals, status: "MEASURED",
    source: claudeTurnUsageSource, observedAt: new Date().toISOString(), model }).success) return null;
  return { totals, model };
}

export const openCodeCliTurnUsageSource = "opencode-cli:step_finish";

/** OpenCode's native step counters are disjoint: input/cache read/cache write and output/reasoning. */
export function openCodeCliTurnUsage(stderr: string): { totals: CodexTokenTotals; model: null } | null {
  const lines = stderr.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || !stderr.endsWith("\n")) return null;
  let receipt: Record<string, unknown> | null;
  try { receipt = record(JSON.parse(lines[0]!.slice(prefix.length))); } catch { return null; }
  if (receipt?.runtime !== "cli:opencode") return null;
  const tokens = record(receipt.tokens);
  const cache = record(tokens?.cache);
  const input = tokens?.input, output = tokens?.output, reasoning = tokens?.reasoning;
  const read = cache?.read, write = cache?.write;
  if (!counter(input) || !counter(output) || !counter(reasoning) || !counter(read) || !counter(write)) return null;
  const inputTokens = input + read + write;
  const outputTokens = output + reasoning;
  const totals = { inputTokens, cachedInputTokens: read, outputTokens, reasoningOutputTokens: reasoning,
    totalTokens: inputTokens + outputTokens };
  // Native step events do not report a model. Requested configuration is not evidence of the served model.
  if (totals.totalTokens <= 0 || !agentRunMeasuredUsageSchema.safeParse({ ...totals, status: "MEASURED",
    source: openCodeCliTurnUsageSource, observedAt: new Date().toISOString(), model: null }).success) return null;
  return { totals, model: null };
}

export const geminiCliTurnUsageSource = "gemini-cli:result";

/**
 * Antigravity's JSON result counters (agy 1.4.12): input, output, thinking, cache_read and total tokens; no model. Whether its input
 * counts the cache reads is not documented, so the receipt is MEASURED only when its own total fixes the reading: input + output +
 * thinking (input includes them, as Gemini's promptTokenCount) or input + cache_read + output + thinking (it does not); else UNKNOWN.
 */
export function geminiCliTurnUsage(stderr: string): { totals: CodexTokenTotals; model: null } | null {
  const lines = stderr.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || !stderr.endsWith("\n")) return null;
  let receipt: Record<string, unknown> | null;
  try { receipt = record(JSON.parse(lines[0]!.slice(prefix.length))); } catch { return null; }
  if (receipt?.runtime !== "cli:gemini") return null;
  const usage = record(receipt.usage);
  const input = usage?.input_tokens, output = usage?.output_tokens, thinking = usage?.thinking_tokens;
  const read = usage?.cache_read_tokens, total = usage?.total_tokens;
  if (!counter(input) || !counter(output) || !counter(thinking) || !counter(read) || !counter(total)) return null;
  const outputTokens = output + thinking;
  const inputTokens = total === input + outputTokens && read <= input ? input : total === input + read + outputTokens ? input + read : null;
  if (inputTokens === null) return null;
  const totals = { inputTokens, cachedInputTokens: read, outputTokens, reasoningOutputTokens: thinking, totalTokens: inputTokens + outputTokens };
  if (totals.totalTokens <= 0 || !agentRunMeasuredUsageSchema.safeParse({ ...totals, status: "MEASURED",
    source: geminiCliTurnUsageSource, observedAt: new Date().toISOString(), model: null }).success) return null;
  return { totals, model: null };
}

export const qwenCliTurnUsageSource = "qwen-cli:result";

/**
 * Qwen Code's JSON result (0.26.6): per model, prompt (cache reads included: its cache efficiency is cached / prompt), candidates,
 * cached, thoughts and total, the turn and its background calls summed; no served model. An OpenAI-compatible provider's candidates
 * are its completion tokens (reasoning included) and total = prompt + candidates; Qwen estimates thoughts from text when the provider
 * gives none, so they are not counted then. Gemini's own counters leave thoughts out of candidates: total = prompt + candidates +
 * thoughts. MEASURED only when the total fixes one reading; else UNKNOWN.
 */
export function qwenCliTurnUsage(stderr: string): { totals: CodexTokenTotals; model: null } | null {
  const lines = stderr.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || !stderr.endsWith("\n")) return null;
  let receipt: Record<string, unknown> | null;
  try { receipt = record(JSON.parse(lines[0]!.slice(prefix.length))); } catch { return null; }
  if (receipt?.runtime !== "cli:qwen" || !Array.isArray(receipt.models) || receipt.models.length === 0) return null;
  const sum = { prompt: 0, candidates: 0, cached: 0, thoughts: 0, total: 0 };
  for (const entry of receipt.models) {
    const tokens = record(entry);
    for (const key of Object.keys(sum) as Array<keyof typeof sum>) {
      if (!counter(tokens?.[key])) return null;
      sum[key] += tokens[key] as number;
    }
  }
  const { prompt, candidates, cached, thoughts, total } = sum;
  if (cached > prompt) return null;
  const reasoning = total === prompt + candidates ? 0 : total === prompt + candidates + thoughts ? thoughts : null;
  if (reasoning === null) return null;
  const outputTokens = candidates + reasoning;
  const totals = { inputTokens: prompt, cachedInputTokens: cached, outputTokens, reasoningOutputTokens: reasoning, totalTokens: prompt + outputTokens };
  if (totals.totalTokens <= 0 || !agentRunMeasuredUsageSchema.safeParse({ ...totals, status: "MEASURED",
    source: qwenCliTurnUsageSource, observedAt: new Date().toISOString(), model: null }).success) return null;
  return { totals, model: null };
}

export const deepSeekCliTurnUsageSource = "deepseek-cli:metrics";

/**
 * Reasonix's own run summary (`run --metrics`, 2.57.0): prompt tokens with the cache hits inside (hit + miss = prompt) and completion
 * tokens with DeepSeek's thinking inside; no served model. MEASURED only when hit + miss is the prompt; else UNKNOWN.
 */
export function deepSeekCliTurnUsage(stderr: string): { totals: CodexTokenTotals; model: null } | null {
  const lines = stderr.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || !stderr.endsWith("\n")) return null;
  let receipt: Record<string, unknown> | null;
  try { receipt = record(JSON.parse(lines[0]!.slice(prefix.length))); } catch { return null; }
  if (receipt?.runtime !== "cli:deepseek") return null;
  const tokens = record(receipt.tokens);
  const prompt = tokens?.prompt_tokens, completion = tokens?.completion_tokens, hit = tokens?.cache_hit_tokens, miss = tokens?.cache_miss_tokens;
  if (!counter(prompt) || !counter(completion) || !counter(hit) || !counter(miss) || hit + miss !== prompt) return null;
  const totals = { inputTokens: prompt, cachedInputTokens: hit, outputTokens: completion, reasoningOutputTokens: 0, totalTokens: prompt + completion };
  if (totals.totalTokens <= 0 || !agentRunMeasuredUsageSchema.safeParse({ ...totals, status: "MEASURED",
    source: deepSeekCliTurnUsageSource, observedAt: new Date().toISOString(), model: null }).success) return null;
  return { totals, model: null };
}

export const kimiCliTurnUsageSource = "kimi-cli:usage.record";

/**
 * Kimi Code's own session log (2.4.1, `usage.record` events of every agent of the run, summed by the wrapper): input split into
 * other / cache read / cache creation, and output (a chat-completions provider's completion tokens, reasoning inside); no served
 * model and no total. MEASURED only when the turn's records equal its steps' `step.end` usages (the log is whole) and the run's
 * records cover the turn's; else UNKNOWN.
 */
export function kimiCliTurnUsage(stderr: string): { totals: CodexTokenTotals; model: null } | null {
  const lines = stderr.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || !stderr.endsWith("\n")) return null;
  let receipt: Record<string, unknown> | null;
  try { receipt = record(JSON.parse(lines[0]!.slice(prefix.length))); } catch { return null; }
  if (receipt?.runtime !== "cli:kimi") return null;
  const keys = ["inputOther", "output", "inputCacheRead", "inputCacheCreation"] as const;
  const [all, turn, steps] = [record(receipt.all), record(receipt.turn), record(receipt.steps)];
  for (const key of keys) {
    const a = all?.[key], t = turn?.[key], s = steps?.[key];
    if (!counter(a) || !counter(t) || !counter(s) || t !== s || a < t) return null;
  }
  const { inputOther, output, inputCacheRead, inputCacheCreation } = all as Record<(typeof keys)[number], number>;
  const inputTokens = inputOther + inputCacheRead + inputCacheCreation;
  const totals = { inputTokens, cachedInputTokens: inputCacheRead, outputTokens: output, reasoningOutputTokens: 0, totalTokens: inputTokens + output };
  if (totals.totalTokens <= 0 || !agentRunMeasuredUsageSchema.safeParse({ ...totals, status: "MEASURED",
    source: kimiCliTurnUsageSource, observedAt: new Date().toISOString(), model: null }).success) return null;
  return { totals, model: null };
}

export const copilotCliTurnUsageSource = "copilot-cli:usage_record";

/**
 * GitHub Copilot CLI's own session log (1.0.105, the run's `--session-id`): every model call's `session.usage_record` summed, and the
 * one `session.shutdown`'s per-model totals. Input counts the cache reads and writes, output the reasoning (as the provider reports
 * them); no served model. MEASURED only when the records and the shutdown agree on every counter and on the number of calls; else UNKNOWN.
 */
export function copilotCliTurnUsage(stderr: string): { totals: CodexTokenTotals; model: null } | null {
  const lines = stderr.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || !stderr.endsWith("\n")) return null;
  let receipt: Record<string, unknown> | null;
  try { receipt = record(JSON.parse(lines[0]!.slice(prefix.length))); } catch { return null; }
  if (receipt?.runtime !== "cli:copilot" || receipt.shutdowns !== 1) return null;
  const [records, shutdown] = [record(receipt.records), record(receipt.shutdown)];
  const keys = ["count", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
  for (const key of keys) {
    if (!counter(records?.[key]) || records[key] !== shutdown?.[key]) return null;
  }
  const { count, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = records as Record<(typeof keys)[number], number>;
  if (count === 0 || cacheReadTokens + cacheWriteTokens > inputTokens || reasoningTokens > outputTokens) return null;
  const totals = { inputTokens, cachedInputTokens: cacheReadTokens, outputTokens, reasoningOutputTokens: reasoningTokens, totalTokens: inputTokens + outputTokens };
  if (totals.totalTokens <= 0 || !agentRunMeasuredUsageSchema.safeParse({ ...totals, status: "MEASURED",
    source: copilotCliTurnUsageSource, observedAt: new Date().toISOString(), model: null }).success) return null;
  return { totals, model: null };
}

export const hermesCliTurnUsageSource = "hermes-cli:usage-file";

/**
 * Hermes Agent's own `-z --usage-file` report (0.22.6): the main loop (input with the cache inside; its total is Hermes's own input +
 * output) and every auxiliary call such as the title (input without the cache), checked against the session's own row in state.db
 * (main loop, input without the cache). A subagent's calls are in neither, so its child sessions are counted. MEASURED only when the
 * row equals the main loop on every counter and the call count, no subagent ran, and the cache fits the input and the reasoning the
 * output; else UNKNOWN. No served model.
 */
export function hermesCliTurnUsage(stderr: string): { totals: CodexTokenTotals; model: null } | null {
  const lines = stderr.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || !stderr.endsWith("\n")) return null;
  let receipt: Record<string, unknown> | null;
  try { receipt = record(JSON.parse(lines[0]!.slice(prefix.length))); } catch { return null; }
  if (receipt?.runtime !== "cli:hermes" || receipt.children !== 0) return null;
  const keys = ["api_calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const;
  const [main, aux, stored] = [record(receipt.main), record(receipt.auxiliary), record(receipt.stored)];
  for (const key of [...keys, "total_tokens"] as const) if (!counter(main?.[key])) return null;
  for (const key of keys) if (!counter(aux?.[key]) || !counter(stored?.[key])) return null;
  type Counters = Record<(typeof keys)[number] | "total_tokens", number>;
  const [m, a, s] = [main, aux, stored] as [Counters, Counters, Counters];
  if (m.total_tokens !== m.input_tokens + m.output_tokens || m.api_calls === 0 || m.cache_read_tokens + m.cache_write_tokens > m.input_tokens
    || m.reasoning_tokens > m.output_tokens || a.reasoning_tokens > a.output_tokens) return null;
  // The row stores the main loop's input without the cache; the report's main input has it inside.
  if (s.api_calls !== m.api_calls || s.input_tokens + s.cache_read_tokens + s.cache_write_tokens !== m.input_tokens
    || (["output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const).some(key => s[key] !== m[key])) return null;
  const inputTokens = m.input_tokens + a.input_tokens + a.cache_read_tokens + a.cache_write_tokens;
  const outputTokens = m.output_tokens + a.output_tokens;
  const totals = { inputTokens, cachedInputTokens: m.cache_read_tokens + a.cache_read_tokens, outputTokens,
    reasoningOutputTokens: m.reasoning_tokens + a.reasoning_tokens, totalTokens: inputTokens + outputTokens };
  if (totals.totalTokens <= 0 || !agentRunMeasuredUsageSchema.safeParse({ ...totals, status: "MEASURED",
    source: hermesCliTurnUsageSource, observedAt: new Date().toISOString(), model: null }).success) return null;
  return { totals, model: null };
}
