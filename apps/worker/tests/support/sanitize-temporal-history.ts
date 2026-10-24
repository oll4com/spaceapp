import { historyToJSON } from "@temporalio/common/lib/proto-utils";

/** Keep committed Temporal histories portable across machines. */
export function sanitizeTemporalHistory(history: Parameters<typeof historyToJSON>[0]): string {
  const parsed: unknown = JSON.parse(historyToJSON(history));

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (key === "stackTrace") continue;
        result[key] = key === "identity" ? "identity:fixture" : visit(child);
      }
      return result;
    }
    return value;
  };

  return `${JSON.stringify(visit(parsed), null, 2)}\n`;
}
