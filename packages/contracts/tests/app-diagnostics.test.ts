import { describe, expect, it } from "vitest";
import {
  appDiagnosticsMaxSegments,
  appDiagnosticsTechnicalEventSchema,
  appDiagnosticsEventBatchSchema,
  appDiagnosticsStatusSchema,
  appDiagnosticsVideoSegmentQuerySchema
} from "../src/index.js";

const captureId = "app_debug_capture:20260724abcdefgh";
const clientId = "app_debug_client:12345678abcdefgh";

describe("app diagnostics contracts", () => {
  it("accepts numeric resize traces and rejects content or arbitrary reasons", () => {
    const event = {
      sequence: 1, occurredAt: "2026-10-05T03:30:00.000Z", category: "PERFORMANCE",
      metric: "TERMINAL_GEOMETRY", phase: "SAMPLE",
      terminalResizeTrace: {
        version: 1, event: "HOLD_RELEASE", reason: "QUIET", elapsedMs: 240,
        cols: 100, rows: 30, baseY: 800, viewportY: 120, cursorY: 28,
        synchronized: false, held: false, visible: true, minimized: false,
        parsed: 6, rendered: 2, scrolls: 3, written: 14000
      }
    };
    expect(appDiagnosticsTechnicalEventSchema.safeParse(event).success).toBe(true);
    for (const extra of [{ text: "private terminal text" }, { reason: "arbitrary text" }, { viewportY: -1 }]) {
      expect(appDiagnosticsTechnicalEventSchema.safeParse({ ...event,
        terminalResizeTrace: { ...event.terminalResizeTrace, ...extra }
      }).success).toBe(false);
    }
  });
  it("bounds the persistent segment index to the MCP-readable sidecar envelope", () => {
    expect(appDiagnosticsMaxSegments).toBe(250_000);
  });
  it("accepts only bounded structured technical events", () => {
    const parsed = appDiagnosticsEventBatchSchema.parse({
      captureId,
      clientId,
      batchId: "app_debug_batch:12345678abcdefgh",
      firstSequence: 10,
      lastSequence: 12,
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:02.000Z",
      droppedBeforeBatch: 2,
      events: [
        {
          sequence: 10,
          occurredAt: "2026-07-24T10:00:00.100Z",
          category: "LIFECYCLE",
          event: "VISIBILITY",
          visibilityState: "visible"
        },
        {
          sequence: 11,
          occurredAt: "2026-07-24T10:00:00.300Z",
          category: "NETWORK",
          transport: "HTTP",
          phase: "COMPLETE",
          method: "GET",
          pathTemplate: "/api/rooms/:id",
          status: 200,
          durationMs: 18.4,
          correlationId: "req:abcdefgh1234"
        },
        {
          sequence: 12,
          occurredAt: "2026-07-24T10:00:00.500Z",
          category: "ERROR",
          name: "TypeError",
          code: "RENDER_FAILED",
          stackLocations: [
            { file: "/assets/App.js", line: 120, column: 8 }
          ]
        }
      ],
      snapshots: [
        {
          snapshotId: "app_debug_snapshot:abcdefgh1234",
          anomalySequence: 12,
          capturedAt: "2026-07-24T10:00:00.510Z",
          truncated: false,
          nodes: [
            {
              index: 0,
              parentIndex: null,
              tag: "main",
              role: "main",
              classes: ["workspace-shell"],
              style: {
                display: "grid",
                visibility: "visible",
                opacity: "1",
                position: "relative",
                transform: "none",
                animationName: "none",
                transitionProperty: "opacity"
              }
            }
          ]
        }
      ]
    });

    expect(parsed.events).toHaveLength(3);
    expect(parsed.snapshots).toHaveLength(1);
  });

  it("accepts strict room, geometry, and output-pressure performance metrics without terminal text", () => {
    const base = {
      captureId,
      clientId,
      batchId: "app_debug_batch:performance1234",
      firstSequence: 20,
      lastSequence: 23,
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:02.000Z",
      droppedBeforeBatch: 0,
      snapshots: []
    };
    const parsed = appDiagnosticsEventBatchSchema.parse({
      ...base,
      events: [
        {
          sequence: 20,
          occurredAt: "2026-07-24T10:00:00.100Z",
          category: "PERFORMANCE",
          metric: "ROOM_PRESENTATION",
          roomId: "room:stress-one",
          phase: "COMPLETE",
          value: 12,
          durationMs: 18.5
        },
        {
          sequence: 21,
          occurredAt: "2026-07-24T10:00:00.300Z",
          category: "PERFORMANCE",
          metric: "TERMINAL_GEOMETRY",
          roomId: "room:stress-one",
          paneId: "pane:stress-one",
          phase: "READY",
          width: 1280,
          height: 720,
          cols: 160,
          rows: 44,
          repaired: false
        },
        {
          sequence: 22,
          occurredAt: "2026-07-24T10:00:00.500Z",
          category: "PERFORMANCE",
          metric: "TERMINAL_OUTPUT_PRESSURE",
          roomId: "room:stress-one",
          paneId: "pane:stress-one",
          phase: "TOTAL_LIMIT",
          bufferedBytes: 2_097_153,
          bufferedEvents: 42,
          totalBufferedBytes: 16_777_217,
          writtenBytes: 1_024,
          writtenEvents: 3
        },
        {
          sequence: 23,
          occurredAt: "2026-07-24T10:00:00.700Z",
          category: "PERFORMANCE",
          metric: "WARM_ROOM_CAPACITY",
          phase: "SAMPLE",
          safeCapacity: 3,
          hardCapacity: 4,
          warmRoomCount: 2,
          connectedPaneCount: 32,
          safePaneCapacity: 48,
          hardPaneCapacity: 64,
          estimatedRoomBytes: 268_435_456,
          usedBytes: 536_870_912,
          longTaskCount: 0,
          driftCount: 0
        }
      ]
    });

    expect(parsed.events).toHaveLength(4);
    expect(JSON.stringify(parsed.events)).not.toContain("terminalText");
    expect(() => appDiagnosticsEventBatchSchema.parse({
      ...base,
      firstSequence: 20,
      lastSequence: 20,
      events: [{
        sequence: 20,
        occurredAt: "2026-07-24T10:00:00.100Z",
        category: "PERFORMANCE",
        metric: "TERMINAL_OUTPUT_PRESSURE",
        roomId: "room:stress-one",
        paneId: "pane:stress-one",
        phase: "PANE_LIMIT",
        bufferedBytes: 10,
        terminalText: "must never be accepted"
      }]
    })).toThrow();
  });

  it("accepts redacted terminal edge-leak samples without terminal text", () => {
    const parsed = appDiagnosticsEventBatchSchema.parse({
      captureId,
      clientId,
      batchId: "app_debug_batch:edgeleak1234",
      firstSequence: 30,
      lastSequence: 30,
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:02.000Z",
      droppedBeforeBatch: 0,
      snapshots: [],
      events: [
        {
          sequence: 30,
          occurredAt: "2026-07-24T10:00:00.100Z",
          category: "PERFORMANCE",
          metric: "TERMINAL_EDGE_LEAK",
          roomId: "room:stress-one",
          paneId: "pane:stress-one",
          phase: "EDGE_SAMPLE",
          cols: 80,
          rows: 24,
          scannedRows: 24,
          fragRows: 2,
          fragTruecolor: 1,
          frag256: 0,
          fragCup: 0,
          fragPartial: 1,
          fragEsc: 0,
          wideRows: 0,
          ambiguousRows: 3,
          ambiguousCells: 5,
          overflowPx: 0,
          viewportY: 120,
          staleDom: true
        }
      ]
    });
    expect(parsed.events).toHaveLength(1);
    expect(JSON.stringify(parsed.events)).not.toContain("terminalText");
  });

  it("rejects query strings, request bodies, arbitrary text, secrets, and typed characters", () => {
    const base = {
      captureId,
      clientId,
      batchId: "app_debug_batch:12345678abcdefgh",
      firstSequence: 1,
      lastSequence: 1,
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:01.000Z",
      droppedBeforeBatch: 0
    };

    const forbiddenEvents = [
      {
        sequence: 1,
        occurredAt: "2026-07-24T10:00:00.100Z",
        category: "NETWORK",
        transport: "HTTP",
        phase: "COMPLETE",
        method: "POST",
        pathTemplate: "/api/rooms?token=secret",
        status: 200
      },
      {
        sequence: 1,
        occurredAt: "2026-07-24T10:00:00.100Z",
        category: "ERROR",
        name: "Error",
        message: "chat and terminal content must not be captured"
      },
      {
        sequence: 1,
        occurredAt: "2026-07-24T10:00:00.100Z",
        category: "INTERACTION",
        event: "KEYBOARD",
        elementTag: "input",
        key: "p"
      },
      {
        sequence: 1,
        occurredAt: "2026-07-24T10:00:00.100Z",
        category: "NETWORK",
        transport: "HTTP",
        phase: "COMPLETE",
        method: "POST",
        pathTemplate: "/api/turns",
        requestBody: { prompt: "do not store me" }
      }
    ];

    for (const event of forbiddenEvents) {
      expect(() => appDiagnosticsEventBatchSchema.parse({ ...base, events: [event], snapshots: [] }))
        .toThrow();
    }
  });

  it("keeps status additive and exposes recorder/quota counters without raw paths", () => {
    const parsed = appDiagnosticsStatusSchema.parse({
      isEnabled: true,
      captureId,
      enabledAt: "2026-07-24T10:00:00.000Z",
      enabledByUserId: "user:admin",
      retentionHours: 24,
      quotaBytes: 8 * 1024 ** 3,
      technicalQuotaBytes: 512 * 1024 ** 2,
      visualQuotaBytes: 7680 * 1024 ** 2,
      usage: {
        technicalBytes: 1024,
        visualBytes: 2048,
        totalBytes: 3072,
        segmentCount: 3
      },
      counters: {
        droppedEvents: 4,
        quotaDrops: 1,
        rejectedUploads: 2
      },
      recorder: {
        status: "ACTIVE",
        leaseId: "app_debug_lease:abcdefgh1234",
        clientId,
        acquiredAt: "2026-07-24T10:01:00.000Z",
        heartbeatAt: "2026-07-24T10:01:30.000Z",
        expiresAt: "2026-07-24T10:03:00.000Z"
      },
      checkedAt: "2026-07-24T10:01:31.000Z"
    });

    expect(JSON.stringify(parsed)).not.toContain("relativePath");
    expect(parsed.retentionHours).toBe(24);
    expect(parsed.quotaBytes).toBe(8 * 1024 ** 3);
  });

  it("validates video timing and event-sequence correlation metadata", () => {
    expect(appDiagnosticsVideoSegmentQuerySchema.parse({
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:30.000Z",
      firstEventSequence: "10",
      lastEventSequence: "30"
    })).toEqual({
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:30.000Z",
      firstEventSequence: 10,
      lastEventSequence: 30
    });
    expect(() => appDiagnosticsEventBatchSchema.parse({
      captureId,
      clientId,
      batchId: "app_debug_batch:sequence-invalid",
      firstSequence: 10,
      lastSequence: 10,
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:01.000Z",
      droppedBeforeBatch: 0,
      events: [{
        sequence: 10,
        occurredAt: "2026-07-24T10:00:00.100Z",
        category: "LIFECYCLE",
        event: "PAGE_SHOW"
      }],
      snapshots: [{
        snapshotId: "app_debug_snapshot:sequence-invalid",
        anomalySequence: 11,
        capturedAt: "2026-07-24T10:00:00.200Z",
        truncated: false,
        nodes: []
      }]
    })).toThrow(/snapshot sequence/i);
  });
});
