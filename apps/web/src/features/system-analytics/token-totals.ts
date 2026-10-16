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

/** API value of rows: null when none of them has a price. */
export function sumCost(rows: { costUsd?: number | null }[]): number | null {
  const priced = rows.map(row => row.costUsd).filter((value): value is number => typeof value === "number");
  return priced.length ? priced.reduce((total, value) => total + value, 0) : null;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value > 0 && value < 0.01) return "< $0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function groupModelTokens(rows: ModelUsage[]) {
  const groups = new Map<string, ModelUsage[]>();
  for (const row of rows) groups.set(row.modelId, [...(groups.get(row.modelId) ?? []), row]);
  return [...groups].map(([modelId, entries]) => ({
    modelId, providerCount: new Set(entries.map(row => row.providerId)).size,
    ...sumTokenCounts(entries), incomplete: entries.some(row => row.tokensIn === null || row.tokensOut === null),
    costUsd: sumCost(entries)
  })).sort((a, b) => (recordedTotal(b) ?? -1) - (recordedTotal(a) ?? -1) || a.modelId.localeCompare(b.modelId));
}
