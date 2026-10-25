import { describe, expect, it } from "vitest";
import {
  cliRuntimeCleanupResultSchema,
  cliRuntimeDisablePreviewSchema,
  cliSessionReapResponseSchema,
  cliSessionStatsSchema,
  codexEnvironmentSchema,
  codexHistoryPurgeExecuteRequestSchema,
  codexHistoryPurgePreviewRequestSchema,
  codexHistoryPurgePreviewResponseSchema,
  codexHistoryPurgeResponseSchema,
  codexLbSpeedDefaultsResponseSchema,
  codexLbSpeedDefaultUpdateRequestSchema,
  codexResetCreditAvailabilitySchema,
  codexResetCreditRedemptionInputSchema,
  codexResetCreditRedemptionResponseSchema,
  codexUsageAccountListSchema,
  hostMemoryDetailsSchema,
  memoryReclaimResponseSchema,
  providerSwitchRequestSchema,
  providerSwitchResponseSchema,
  providerSwitchTargetsSchema
} from "../src/index.js";

const checkedAt = "2026-07-14T12:00:00.000Z";
const weeklyResetAt = "2026-07-20T09:30:00.000Z";

describe("toolbar system action contracts", () => {
  it("keeps the Codex master capability additive for older environment producers", () => {
    const legacy = {
      codexHome: "/home/space/.codex",
      stateDbPath: "/home/space/.codex/state_5.sqlite",
      config: { modelProvider: "codex-lb", model: "gpt-5.6-sol", reasoningEffort: "high" },
      mcpServers: ["space-readonly"],
      skillCount: 2,
      pluginCount: 1,
      memories: { generateMemories: true, useMemories: true },
      features: { plugins: true, memories: true },
      checkedAt
    };

    expect(codexEnvironmentSchema.parse(legacy).isCodexEnabled).toBeUndefined();
    expect(codexEnvironmentSchema.parse({ ...legacy, isCodexEnabled: false }).isCodexEnabled).toBe(false);
  });

  it("accepts only bounded reset availability without exposing credit identities", () => {
    const payload = codexResetCreditAvailabilitySchema.parse({
      data: [
        { accountId: "account:one", availableCreditCount: 2 },
        { accountId: "account:unknown", availableCreditCount: null }
      ],
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt
    });

    expect(payload.data[0]?.availableCreditCount).toBe(2);
    expect(() => codexResetCreditAvailabilitySchema.parse({
      ...payload,
      data: [{ accountId: "account:one", availableCreditCount: 2, creditIds: ["raw-credit"] }]
    })).toThrow();
  });

  it("requires one UUID idempotency key and exposes only stable redemption outcomes", () => {
    const idempotencyKey = "9943e22b-97a3-48b6-ae84-1a2cced6a353";
    expect(codexResetCreditRedemptionInputSchema.parse({ idempotencyKey })).toEqual({ idempotencyKey });
    expect(() => codexResetCreditRedemptionInputSchema.parse({ idempotencyKey: "retry-1" })).toThrow();
    expect(() => codexResetCreditRedemptionInputSchema.parse({ idempotencyKey, creditId: "raw-credit" })).toThrow();

    for (const outcome of ["RESET", "ALREADY_REDEEMED", "NOTHING_TO_RESET", "NO_CREDIT"] as const) {
      expect(codexResetCreditRedemptionResponseSchema.parse({
        accountId: "account:one",
        outcome,
        completedAt: checkedAt
      }).outcome).toBe(outcome);
    }
    expect(() => codexResetCreditRedemptionResponseSchema.parse({
      accountId: "account:one",
      outcome: "UNKNOWN",
      completedAt: checkedAt
    })).toThrow();
    expect(() => codexResetCreditRedemptionResponseSchema.parse({
      accountId: "account:one",
      outcome: "RESET",
      creditIdHash: "should-stay-server-side",
      completedAt: checkedAt
    })).toThrow();
  });

  it("adds Codex Chat and Room Agent impact while accepting legacy CLI-only previews", () => {
    const legacyPreview = cliRuntimeDisablePreviewSchema.parse({
      runtimeId: "cli:codex",
      activeSessionCount: 1,
      openPaneCount: 2,
      confirmationToken: "abcdefghijklmnopqrstuvwx",
      expiresAt: checkedAt
    });
    expect(legacyPreview).toMatchObject({
      activeChatRunCount: 0,
      openChatPaneCount: 0,
      activeRoomAgentMissionCount: 0
    });

    expect(cliRuntimeCleanupResultSchema.parse({
      requestedActiveSessionCount: 1,
      requestedOpenPaneCount: 2,
      terminatedSessionIds: [],
      closedPaneIds: [],
      unresolvedSessionIds: [],
      unresolvedPaneIds: []
    })).toMatchObject({
      requestedActiveChatRunCount: 0,
      requestedOpenChatPaneCount: 0,
      requestedRoomAgentMissionCount: 0,
      interruptedChatPaneIds: [],
      stoppedRoomAgentMissionIds: [],
      closedChatPaneIds: []
    });
  });

  it("accepts bounded per-account usage without credential material", () => {
    const payload = codexUsageAccountListSchema.parse({
      data: [
        {
          id: "account:one",
          label: "first@example.test",
          fiveHourRemainingPercent: 72.5,
          weeklyRemainingPercent: 61.2,
          fiveHourResetAt: "2026-07-14T14:30:00.000Z",
          weeklyResetAt,
          sampledAt: checkedAt
        }
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
      source: "codex-usage-host",
      isStale: false,
      error: null,
      checkedAt
    });

    expect(payload.data[0]?.weeklyRemainingPercent).toBe(61.2);
    expect(payload.data[0]?.fiveHourResetAt).toBe("2026-07-14T14:30:00.000Z");
    expect(payload.data[0]?.weeklyResetAt).toBe(weeklyResetAt);
    expect(() => codexUsageAccountListSchema.parse({ ...payload, token: "secret" })).toThrow();
  });

  it("keeps the weekly and 5h reset timestamps additive for older usage producers", () => {
    const payload = codexUsageAccountListSchema.parse({
      data: [{
        id: "account:legacy",
        label: "legacy@example.test",
        fiveHourRemainingPercent: 55,
        weeklyRemainingPercent: 45,
        sampledAt: checkedAt
      }],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
      source: "legacy-codex-usage-host",
      isStale: false,
      error: null,
      checkedAt
    });

    expect(payload.data[0]?.fiveHourResetAt).toBeUndefined();
    expect(payload.data[0]?.weeklyResetAt).toBeUndefined();
  });

  it("describes only server-classified CLI sessions and reap outcomes", () => {
    const stats = cliSessionStatsSchema.parse({
      summary: { running: 2, attached: 1, detached: 1, cleanupEligible: 1 },
      sessions: [
        {
          sessionId: "cli_session:detached",
          hostId: "main",
          runtimeId: "cli:codex",
          roomId: "room:one",
          paneId: "pane:one",
          pid: 1234,
          status: "RUNNING",
          attachmentCount: 0,
          startedAt: checkedAt,
          detachedAt: "2026-07-14T11:50:00.000Z",
          rssBytes: 1048576,
          cleanupEligible: true
        }
      ],
      sampledAt: checkedAt
    });
    expect(stats.summary.cleanupEligible).toBe(1);
    expect(() => cliSessionStatsSchema.parse({ ...stats, command: "kill -9 1234" })).toThrow();

    expect(
      cliSessionReapResponseSchema.parse({
        status: "COMPLETED",
        killedSessionIds: ["cli_session:detached"],
        skippedCount: 0,
        estimatedReclaimedBytes: 1048576,
        completedAt: checkedAt
      }).killedSessionIds
    ).toEqual(["cli_session:detached"]);
  });

  it("bounds memory details and pressure-gated reclaim results", () => {
    const memory = hostMemoryDetailsSchema.parse({
      memory: {
        totalBytes: 1000,
        usedBytes: 850,
        availableBytes: 150,
        usagePercent: 85,
        pageCacheBytes: 400,
        reclaimableBytes: 300
      },
      swap: { totalBytes: 100, usedBytes: 20, usagePercent: 20 },
      pressure: { isUnderPressure: true, availablePercent: 15, canDropPageCache: true },
      topProcesses: [
        {
          pid: 1234,
          name: "codex",
          taskTitle: null,
          rssBytes: 1048576,
          cpuPercent: 2.5,
          state: "S",
          isSpaceManaged: true,
          cleanupEligible: true
        }
      ],
      topCpuProcesses: [],
      sampledAt: checkedAt
    });
    expect(memory.topProcesses[0]?.name).toBe("codex");
    expect(() => hostMemoryDetailsSchema.parse({ ...memory, commandLine: "codex --token secret" })).toThrow();

    expect(
      memoryReclaimResponseSchema.parse({
        status: "PARTIAL",
        cli: { killedSessionIds: [], estimatedReclaimedBytes: 0 },
        kernelCache: { status: "SKIPPED_LOW_PRESSURE", reclaimedBytes: 0, message: null },
        before: memory.memory,
        after: memory.memory,
        completedAt: checkedAt
      }).kernelCache.status
    ).toBe("SKIPPED_LOW_PRESSURE");
  });

  it("keeps provider switching typed and fail-closed", () => {
    const targets = providerSwitchTargetsSchema.parse({
      data: [
        {
          providerId: "headroom-gateway",
          displayName: "Headroom Gateway",
          isCurrent: true,
          canSwitch: true,
          health: "HEALTHY",
          reason: null
        },
        {
          providerId: "strict-234-direct",
          displayName: "Strict .234 Direct",
          isCurrent: false,
          canSwitch: false,
          health: "UNAVAILABLE",
          reason: "Fallback upstream is unavailable."
        }
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
      checkedAt
    });
    expect(targets.data[1]?.canSwitch).toBe(false);
    expect(providerSwitchRequestSchema.parse({ providerId: "headroom-gateway" })).toEqual({ providerId: "headroom-gateway" });
    expect(() => providerSwitchRequestSchema.parse({ providerId: "headroom-gateway", command: "fallback" })).toThrow();
    expect(
      providerSwitchResponseSchema.parse({
        status: "NOOP",
        previousProviderId: "headroom-gateway",
        currentProviderId: "headroom-gateway",
        routeMode: "headroom",
        routeTargetMode: "auto",
        switchedAt: checkedAt
      }).status
    ).toBe("NOOP");
  });

  it("allows only supported Codex-LB models and Standard/Fast defaults", () => {
    expect(
      codexLbSpeedDefaultUpdateRequestSchema.parse({ tier: "FAST" })
    ).toEqual({ tier: "FAST" });
    expect(() => codexLbSpeedDefaultUpdateRequestSchema.parse({ tier: "priority" })).toThrow();
    expect(() => codexLbSpeedDefaultUpdateRequestSchema.parse({ tier: "FAST", path: "/tmp/map.json" })).toThrow();

    const response = codexLbSpeedDefaultsResponseSchema.parse({
      models: [
        { modelId: "provider-alpha", displayName: "Provider Alpha", tier: "FAST" },
        { modelId: "provider-beta", displayName: "Provider Beta", tier: "STANDARD" }
      ],
      updatedAt: checkedAt,
      checkedAt
    });
    expect(response.models.map((model) => model.modelId)).toEqual(["provider-alpha", "provider-beta"]);
    expect(() => codexLbSpeedDefaultsResponseSchema.parse({
      ...response,
      speedMapPath: "/home/operator/.config/codex-lb-speed-map.json"
    })).toThrow();
    expect(() => codexLbSpeedDefaultsResponseSchema.parse({
      ...response,
      models: [{ modelId: "../unsafe", displayName: "Unsafe", tier: "FAST" }]
    })).toThrow();
  });

  it("keeps Codex history purge previews server-scoped and opaque", () => {
    expect(codexHistoryPurgePreviewRequestSchema.parse({})).toEqual({});
    expect(() => codexHistoryPurgePreviewRequestSchema.parse({ threadIds: ["8f2c4dcc-5f4d-4a33-950c-7b74825dca55"] })).toThrow();

    const preview = codexHistoryPurgePreviewResponseSchema.parse({
      status: "READY",
      previewId: "9943e22b-97a3-48b6-ae84-1a2cced6a353",
      candidates: {
        threads: 12,
        cliTasks: 7,
        indexEntries: 10,
        rolloutFiles: 11,
        shellSnapshots: 4
      },
      protectedThreads: 3,
      expiresAt: "2026-07-14T12:05:00.000Z",
      checkedAt
    });
    expect(preview.candidates.threads).toBe(12);
    expect(() => codexHistoryPurgePreviewResponseSchema.parse({
      ...preview,
      manifestPath: "/tmp/codex-history-purge.json"
    })).toThrow();
    expect(() => codexHistoryPurgePreviewResponseSchema.parse({
      ...preview,
      status: "NOOP"
    })).toThrow();
  });

  it("requires typed confirmation and returns bounded purge counts", () => {
    const previewId = "9943e22b-97a3-48b6-ae84-1a2cced6a353";
    expect(codexHistoryPurgeExecuteRequestSchema.parse({
      previewId,
      confirmation: "PURGE HISTORY"
    })).toEqual({ previewId, confirmation: "PURGE HISTORY" });
    expect(() => codexHistoryPurgeExecuteRequestSchema.parse({
      previewId,
      confirmation: "PURGE",
      targets: ["8f2c4dcc-5f4d-4a33-950c-7b74825dca55"]
    })).toThrow();

    const response = codexHistoryPurgeResponseSchema.parse({
      status: "COMPLETED",
      previewId,
      backupId: "c3d866d1-9690-4db5-b44c-6294c07aa83e",
      purged: {
        threads: 12,
        cliTasks: 7,
        indexEntries: 10,
        rolloutFiles: 11,
        shellSnapshots: 4
      },
      protectedThreads: 3,
      newlyProtectedThreads: 1,
      completedAt: checkedAt
    });
    expect(response.purged.rolloutFiles).toBe(11);
    expect(() => codexHistoryPurgeResponseSchema.parse({
      ...response,
      databasePath: "/home/operator/.codex/state_5.sqlite"
    })).toThrow();
    expect(() => codexHistoryPurgeResponseSchema.parse({
      ...response,
      purged: { ...response.purged, threads: 1_000_001 }
    })).toThrow();
  });
});
