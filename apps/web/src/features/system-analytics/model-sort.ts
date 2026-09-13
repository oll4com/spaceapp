import type { SystemAnalyticsModelsResponse } from "@space/contracts";
import { recordedTotal } from "./token-totals.js";
type Row = SystemAnalyticsModelsResponse["models"][number];
export const modelColumns = [
  ["model", "Provider / model"], ["coverage", "Coverage"], ["sessions", "Sessions / active"],
  ["completed", "Completed / aborted"], ["total", "Total tokens"], ["tokens", "Tokens in / out / reasoning"],
  ["ttft", "TTFT"], ["duration", "Duration"], ["speed", "Tok/s"], ["activity", "Last activity"]
] as const;
export type ModelSortKey = typeof modelColumns[number][0];
function values(row: Row, key: ModelSortKey): Array<string | number | null> {
  switch (key) {
    case "model": return [row.providerId, row.modelId];
    case "coverage": return [row.coverage];
    case "sessions": return [row.activeSessions, row.activeTurns];
    case "completed": return [row.completedTurns, row.abortedTurns];
    case "total": return [recordedTotal(row)];
    case "tokens": return [row.tokensIn, row.tokensOut, row.tokensReasoning];
    case "ttft": return [row.avgTtftMs];
    case "duration": return [row.avgDurationMs];
    case "speed": return [row.avgTokPerSec];
    case "activity": return [row.lastActivityAt === null ? null : Date.parse(row.lastActivityAt)];
  }
}
export function sortModels(rows: Row[], key: ModelSortKey, direction: "asc" | "desc") {
  return [...rows].sort((a, b) => {
    const left = values(a, key), right = values(b, key);
    for (let i = 0; i < left.length; i++) {
      const x = left[i] ?? null, y = right[i] ?? null;
      if (x === null && y === null) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const result = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      if (result) return direction === "asc" ? result : -result;
    }
    return a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId);
  });
}
