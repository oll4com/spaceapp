import type { StreamingOverlaySnapshot } from "@space/contracts";

// Only selected public numeric metrics are suitable for a live-chat prompt.
// Provider labels, account names and custom overlay text are intentionally excluded.
export function formatStreamingBotLiveMetrics(snapshot: StreamingOverlaySnapshot): string {
  return snapshot.tiles
    .filter((tile) => tile.provider !== "SPACE" && (
      ((tile.state === "FRESH" || tile.state === "STALE") && typeof tile.value === "number") ||
      tile.state === "OFFLINE"
    ))
    .map((tile) => {
      const reading = tile.state === "OFFLINE" ? "offline" : String(tile.value);
      const freshness = tile.state === "STALE" ? " (stale)" : "";
      return `- ${tile.provider} ${tile.metricKey}: ${reading}${freshness}`;
    })
    .join("\n");
}
