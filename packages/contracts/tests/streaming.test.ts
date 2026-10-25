import { describe, expect, it } from "vitest";
import {
  defaultStreamingOverlayTiles,
  streamingMetricDefinitions,
  streamingOverlaySnapshotSchema,
  updateStreamingOverlaySettingsInputSchema
} from "../src/index.js";

describe("streaming contracts", () => {
  it("ships only the three Space metrics as default placements", () => {
    expect(defaultStreamingOverlayTiles).toEqual([
      { metricKey: "space.rooms", accountId: null },
      { metricKey: "space.active_agents", accountId: null },
      { metricKey: "space.active_cli_sessions", accountId: null }
    ]);
    expect(streamingMetricDefinitions).toHaveLength(29);
  });

  it("enforces provider account binding, uniqueness, and the sixty-four tile limit", () => {
    expect(() => updateStreamingOverlaySettingsInputSchema.parse({
      expectedVersion: 1,
      tiles: [{ metricKey: "youtube.channel.subscribers", accountId: null }],
      customTextEnabled: false,
      customText: ""
    })).toThrow();
    expect(() => updateStreamingOverlaySettingsInputSchema.parse({
      expectedVersion: 1,
      tiles: Array.from({ length: 65 }, (_, index) => ({
        metricKey: "youtube.analytics.views",
        accountId: `account:${index}`,
        analyticsPeriod: 28
      })),
      customTextEnabled: false,
      customText: ""
    })).toThrow();
    expect(() => updateStreamingOverlaySettingsInputSchema.parse({
      expectedVersion: 1,
      tiles: [defaultStreamingOverlayTiles[0], defaultStreamingOverlayTiles[0]],
      customTextEnabled: false,
      customText: ""
    })).toThrow();
  });

  it("caps custom footer text at 160 characters and accepts safe snapshot states", () => {
    expect(() => updateStreamingOverlaySettingsInputSchema.parse({
      expectedVersion: 1,
      tiles: [],
      customTextEnabled: true,
      customText: "x".repeat(161)
    })).toThrow();
    expect(streamingOverlaySnapshotSchema.parse({
      generatedAt: "2026-08-11T10:00:00.000Z",
      settingsVersion: 1,
      tiles: [{
        metricKey: "twitch.concurrent_viewers",
        accountId: "streaming-account:one",
        provider: "TWITCH",
        label: "Concurrent viewers",
        badge: "channel",
        value: null,
        state: "OFFLINE",
        sampledAt: "2026-08-11T09:59:58.000Z"
      }],
      customTextEnabled: false,
      customText: ""
    }).tiles[0]?.state).toBe("OFFLINE");
  });
});
