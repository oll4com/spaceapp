import { describe, expect, it, vi } from "vitest";

import {
  CLI_CLIENT_EVENT_REPORT_BURST_LIMIT,
  CLI_CLIENT_EVENT_REPORT_INTERVAL_MS,
  CLI_CLIENT_EVENT_REPORT_QUEUE_LIMIT,
  createCliClientEventReporter
} from "../src/cli-client-event-reporter.js";

describe("CLI client event reporter", () => {
  it("stays below the server minute limit under the supported pane burst", () => {
    const firstMinuteMaximum =
      CLI_CLIENT_EVENT_REPORT_BURST_LIMIT +
      Math.floor(60_000 / CLI_CLIENT_EVENT_REPORT_INTERVAL_MS);

    expect(CLI_CLIENT_EVENT_REPORT_QUEUE_LIMIT).toBeGreaterThanOrEqual(512);
    expect(firstMinuteMaximum).toBeLessThanOrEqual(240);
  });

  it("paces overflow and deterministically evicts the oldest queued event", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const reporter = createCliClientEventReporter(
        async (event) => {
          sent.push(event.paneId);
          return { accepted: true };
        },
        {
          burstLimit: 2,
          intervalMs: 100,
          queueLimit: 3
        }
      );
      const event = (paneId: string) => ({
        event: "SOCKET_READY" as const,
        outcome: "SUCCESS" as const,
        reason: "INITIAL_ATTACH" as const,
        paneId,
        sessionId: null,
        runtimeId: "cli:codex",
        controlState: "AVAILABLE" as const,
        protocolVersion: 2 as const,
        clientMode: "INTERACTIVE" as const,
        clientAt: "2026-07-24T20:00:00.000Z"
      });

      for (const paneId of ["pane:1", "pane:2", "pane:3", "pane:4", "pane:5", "pane:6"]) {
        reporter.report(event(paneId));
      }

      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual(["pane:1", "pane:2"]);
      expect(reporter.pendingCount()).toBe(3);

      await vi.advanceTimersByTimeAsync(300);
      expect(sent).toEqual(["pane:1", "pane:2", "pane:4", "pane:5", "pane:6"]);
      expect(reporter.pendingCount()).toBe(0);
      reporter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
