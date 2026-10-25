import type { GatewayRequestLog } from "@space/contracts";
import type { GatewayCompressionRow, GatewayCompressionSignalRow } from "@space/db";
import type { CompressionOutcome } from "./engine.js";

/**
 * One evaluated request as hourly rollup rows: a request row (strategy '') plus one row per strategy used. Rows are
 * mode ON; the SHADOW rows in the tables are history from before Shadow was removed (2026-10-13).
 */
export function compressionRows(outcome: CompressionOutcome, input: { at: string; mode: "ON"; provider: string }): GatewayCompressionRow[] {
  const base = { hour: input.at, mode: input.mode, provider: input.provider, requests: 0, modifiedRequests: 0, blocks: 0, rejectedBlocks: 0,
    errorBlocks: 0, timedOut: 0, originalTokens: 0, compressedTokens: 0, overheadMs: 0, maxOverheadMs: 0 };
  const rows = new Map<string, GatewayCompressionRow>();
  rows.set("", { ...base, strategy: "", requests: 1, modifiedRequests: outcome.modified ? 1 : 0, timedOut: outcome.timedOut ? 1 : 0,
    originalTokens: outcome.modified ? outcome.tokensBefore : 0, compressedTokens: outcome.modified ? outcome.tokensAfter : 0,
    overheadMs: outcome.durationMs, maxOverheadMs: outcome.durationMs });
  for (const block of outcome.blocks) {
    const action = block.action;
    if (action.kind !== "compressed" && action.kind !== "rejected_not_smaller" && action.kind !== "rejected_protected_lines"
      && action.kind !== "rejected_invalid_json" && action.kind !== "error") continue;
    const mode = input.mode;
    const key = `${mode}:${action.strategy}`;
    const row = rows.get(key) ?? { ...base, mode, strategy: action.strategy };
    if (action.kind === "compressed") {
      row.blocks += 1;
      row.originalTokens += action.originalTokens;
      row.compressedTokens += action.compressedTokens;
    } else if (action.kind === "rejected_not_smaller" || action.kind === "rejected_protected_lines" || action.kind === "rejected_invalid_json") row.rejectedBlocks += 1;
    else row.errorBlocks += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** Waste signal tokens and pipeline stage timings of one evaluated request, as hourly rollup rows. */
export function compressionSignalRows(outcome: CompressionOutcome, input: { at: string; mode: "ON"; provider: string }): GatewayCompressionSignalRow[] {
  const base = { hour: input.at, mode: input.mode, provider: input.provider };
  const rows: GatewayCompressionSignalRow[] = [];
  for (const [name, tokens] of Object.entries(outcome.waste)) if (tokens > 0) rows.push({ ...base, kind: "waste", name, count: 1, value: tokens, maxValue: tokens });
  for (const [name, ms] of Object.entries(outcome.stageMs)) rows.push({ ...base, kind: "stage", name, count: 1, value: ms, maxValue: ms });
  rows.push({ ...base, kind: "stage", name: "pipeline_total", count: 1, value: outcome.durationMs, maxValue: outcome.durationMs });
  if (outcome.cacheHits > 0) rows.push({ ...base, kind: "stage", name: "cache_hit", count: outcome.cacheHits, value: 0, maxValue: 0 });
  return rows;
}

/** What a request log keeps of a compression run: the strategies that changed it and the waste found. */
export function compressionDetail(outcome: CompressionOutcome): GatewayRequestLog["compressionDetail"] {
  const strategies = [...new Set(outcome.blocks.flatMap((block) => (block.action.kind === "compressed" ? [block.action.strategy] : [])))];
  const waste = Object.fromEntries(Object.entries(outcome.waste).filter(([, tokens]) => tokens > 0).map(([name, tokens]) => [name, Math.round(tokens)]));
  return strategies.length === 0 && Object.keys(waste).length === 0 ? null : { strategies, waste };
}
