import type { SystemAnalyticsModelsResponse } from "@space/contracts";

type ModelUsage = SystemAnalyticsModelsResponse["models"][number];
type TokenCounts = Pick<ModelUsage, "tokensIn" | "tokensOut" | "tokensReasoning">;

export function recordedTotal(row: Pick<TokenCounts, "tokensIn" | "tokensOut">): number | null {
  return row.tokensIn === null && row.tokensOut === null ? null : (row.tokensIn ?? 0) + (row.tokensOut ?? 0);
}

export function sumTokenCounts(rows: TokenCounts[]): TokenCounts {
  const sum = (key: keyof TokenCounts) => {
    const values = rows.map(row => row[key]).filter((value): value is number => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return { tokensIn: sum("tokensIn"), tokensOut: sum("tokensOut"), tokensReasoning: sum("tokensReasoning") };
}

export function groupModelTokens(rows: ModelUsage[]) {
  const groups = new Map<string, ModelUsage[]>();
  for (const row of rows) groups.set(row.modelId, [...(groups.get(row.modelId) ?? []), row]);
  return [...groups].map(([modelId, entries]) => ({
    modelId, providerCount: new Set(entries.map(row => row.providerId)).size,
    ...sumTokenCounts(entries), incomplete: entries.some(row => row.tokensIn === null || row.tokensOut === null)
  })).sort((a, b) => (recordedTotal(b) ?? -1) - (recordedTotal(a) ?? -1) || a.modelId.localeCompare(b.modelId));
}
