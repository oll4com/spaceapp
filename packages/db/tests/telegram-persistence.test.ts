import { describe, expect, it } from "vitest";
import { PostgresSpaceStore, PostgresTelegramPersistence, type PgClientLike, type PgPoolLike } from "../src/index.js";

const now = "2026-07-14T10:00:00.000Z";

function integrationRow(overrides: Record<string, unknown> = {}) {
  return {
    connectionStatus: "DISCONNECTED",
    isEnabled: false,
    botUserId: null,
    botUsername: null,
    chatId: null,
    chatDisplayName: null,
    secretVersion: null,
    generation: "0",
    pollingOffset: "0",
    legacySuppressionActive: false,
    pairedAt: null,
    enabledAt: null,
    disabledAt: null,
    lastTestedAt: null,
    lastDeliveredAt: null,
    errorCode: null,
    errorAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function pairingRow(overrides: Record<string, unknown> = {}) {
  return {
    pairingId: "telegram_pairing:testing123",
    codeHash: "a".repeat(64),
    secretVersion: "telegram_12345678_testing",
    botUserId: "42",
    botUsername: "space_completion_bot",
    pollingOffset: "0",
    status: "PENDING",
    expiresAt: "2026-07-14T10:10:00.000Z",
    createdByUserId: "user:admin",
    createdAt: now,
    confirmedAt: null,
    cancelledAt: null,
    ...overrides
  };
}

class RecordingClient implements PgClientLike {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  released = false;

  constructor(private readonly handler: (sql: string, values?: unknown[]) => unknown[]) {}

  async query<T>(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    return { rows: this.handler(sql, values) as T[], rowCount: null };
  }

  release() {
    this.released = true;
  }
}

class RecordingPool implements PgPoolLike {
  constructor(readonly client: RecordingClient) {}

  async connect() {
    return this.client;
  }

  async query<T>(sql: string, values?: unknown[]) {
    return this.client.query<T>(sql, values);
  }
}

describe("Postgres Telegram persistence", () => {
  it("lists terminal and Space agent Codex thread ownership for the legacy boundary", async () => {
    const client = new RecordingClient((sql) => {
      if (sql.includes("FROM pane_cli_codex_thread_ownerships") && sql.includes("UNION")) {
        return [
          { threadId: "019f0000-0000-7000-8000-000000000041" },
          { threadId: "019f0000-0000-7000-8000-000000000042" }
        ];
      }
      return [];
    });
    const store = new PostgresSpaceStore(new RecordingPool(client));

    await expect(store.listManagedCodexThreadIds()).resolves.toEqual([
      "019f0000-0000-7000-8000-000000000041",
      "019f0000-0000-7000-8000-000000000042"
    ]);
    expect(client.calls[0]?.sql).toContain("FROM space_agent_sessions");
    expect(client.calls[0]?.sql).toContain("thread_id IS NOT NULL");
  });

  it("lists only thread ids attached to active terminal and Space agent sessions", async () => {
    const client = new RecordingClient((sql) => {
      if (sql.includes("FROM pane_cli_sessions") && sql.includes("is_active = true")) {
        return [
          { threadId: "019f0000-0000-7000-8000-000000000051" },
          { threadId: "019f0000-0000-7000-8000-000000000052" }
        ];
      }
      return [];
    });
    const store = new PostgresSpaceStore(new RecordingPool(client));

    await expect(store.listActiveManagedCodexThreadIds()).resolves.toEqual([
      "019f0000-0000-7000-8000-000000000051",
      "019f0000-0000-7000-8000-000000000052"
    ]);
    expect(client.calls[0]?.sql).toContain("FROM pane_cli_sessions");
    expect(client.calls[0]?.sql).toContain("FROM space_agent_sessions");
    expect(client.calls[0]?.sql.match(/is_active = true/g)).toHaveLength(2);
  });

  it("moves the connected chat's polling offset forward only (Nous two-way, 2026-10-24)", async () => {
    const client = new RecordingClient(() => []);
    const persistence = new PostgresTelegramPersistence(new RecordingPool(client));
    await persistence.updateIntegrationOffset(42.9, "2026-10-24T10:00:00.000Z");
    const call = client.calls.find((entry) => entry.sql.includes("UPDATE telegram_integrations SET polling_offset"));
    expect(call?.sql).toContain("GREATEST(polling_offset, $1)");
    expect(call?.values).toEqual([42, "2026-10-24T10:00:00.000Z"]);
  });

  it("starts pairing transactionally while returning staged credentials that must be removed", async () => {
    const client = new RecordingClient((sql) => {
      if (sql.includes("FROM telegram_integrations")) return [integrationRow()];
      if (sql.includes("UPDATE telegram_pairing_sessions") && sql.includes("RETURNING secret_version")) {
        return [{ secretVersion: "telegram_12345678_cancelled" }];
      }
      if (sql.includes("INSERT INTO telegram_pairing_sessions")) return [pairingRow()];
      return [];
    });
    const persistence = new PostgresTelegramPersistence(new RecordingPool(client));

    const started = await persistence.startPairing({
      pairingId: "telegram_pairing:testing123",
      codeHash: "a".repeat(64),
      secretVersion: "telegram_12345678_testing",
      botUserId: "42",
      botUsername: "space_completion_bot",
      expiresAt: "2026-07-14T10:10:00.000Z",
      createdByUserId: "user:admin",
      now
    });

    expect(started.pairing).toMatchObject({ pairingId: "telegram_pairing:testing123", status: "PENDING" });
    expect(started.cancelledSecretVersions).toEqual(["telegram_12345678_cancelled"]);
    expect(client.calls.map((call) => call.sql.trim())).toContain("BEGIN");
    expect(client.calls.map((call) => call.sql.trim())).toContain("COMMIT");
    expect(client.calls.some((call) => call.sql.includes("FOR UPDATE"))).toBe(true);
    expect(client.released).toBe(true);
  });

  it("atomically switches generations, cancels backlog, and preserves the previous version for deletion", async () => {
    const client = new RecordingClient((sql) => {
      if (sql.includes("FROM telegram_integrations") && sql.includes("FOR UPDATE")) {
        return [integrationRow({
          connectionStatus: "CONNECTED",
          isEnabled: true,
          secretVersion: "telegram_12345678_previous",
          chatId: "998877",
          botUsername: "old_bot"
        })];
      }
      if (sql.includes("FROM telegram_pairing_sessions") && sql.includes("FOR UPDATE")) return [pairingRow()];
      if (sql.includes("UPDATE telegram_integrations") && sql.includes("RETURNING")) {
        return [integrationRow({
          connectionStatus: "CONNECTED",
          isEnabled: true,
          botUserId: "42",
          botUsername: "space_completion_bot",
          chatId: "998877",
          chatDisplayName: "Ada (@ada)",
          secretVersion: "telegram_12345678_testing",
          generation: "4",
          pollingOffset: "11",
          legacySuppressionActive: true,
          pairedAt: now,
          enabledAt: now,
          lastTestedAt: now
        })];
      }
      return [];
    });
    const persistence = new PostgresTelegramPersistence(new RecordingPool(client));

    const activated = await persistence.activatePairing({
      pairingId: "telegram_pairing:testing123",
      chatId: "998877",
      chatDisplayName: "Ada (@ada)",
      pollingOffset: 11,
      now
    });

    expect(activated.previousSecretVersion).toBe("telegram_12345678_previous");
    expect(activated.integration).toMatchObject({ generation: 4, isEnabled: true, legacySuppressionActive: true });
    expect(client.calls.some((call) => call.sql.includes("telegram_notification_outbox") && call.sql.includes("CANCELLED"))).toBe(true);
    expect(client.calls.some((call) => call.sql.includes("generation = generation + 1"))).toBe(true);
    expect(client.calls.map((call) => call.sql.trim())).toContain("COMMIT");
  });

  it("completes a Room Agent run with final-only Telegram agent, room, and task metadata in one transaction", async () => {
    const run = {
      runId: "agent_run:test123",
      sessionId: "agent_session:test123",
      paneId: "pane:test123",
      roomId: "room:test123",
      workflowId: "workflow:test123",
      temporalRunId: null,
      codexThreadId: null,
      codexTurnId: null,
      status: "RUNNING",
      promptMessageId: "agent_msg:prompt123",
      responseMessageId: "agent_msg:response123",
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    const session = {
      sessionId: "agent_session:test123",
      paneId: "pane:test123",
      roomId: "room:test123",
      source: "SPACE",
      status: "RUNNING",
      title: "Planner",
      threadId: null,
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: null,
      selectedProviderName: null,
      selectedModelName: null,
      selectedReasoningKey: null,
      selectedToolIds: [],
      permissionMode: null,
      collaborationMode: "default",
      isActive: true,
      lastSyncedAt: null,
      createdAt: now,
      updatedAt: now
    };
    const message = {
      messageId: "agent_msg:response123",
      sessionId: "agent_session:test123",
      runId: "agent_run:test123",
      role: "assistant",
      content: "",
      status: "RUNNING",
      createdAt: now,
      updatedAt: now
    };
    const promptMessage = {
      messageId: "agent_msg:prompt123",
      sessionId: "agent_session:test123",
      runId: "agent_run:test123",
      role: "user",
      content: "  Διόρθωση   Telegram flood  \nΧωρίς ενδιάμεσες ειδοποιήσεις.",
      status: "COMPLETED",
      createdAt: now,
      updatedAt: now
    };
    const pane = {
      id: "pane:test123",
      roomId: "room:test123",
      title: "Planner",
      paneName: null,
      titleSource: null,
      mode: "CHAT",
      status: "RUNNING",
      providerId: null,
      modelId: null,
      terminalRuntimeId: null,
      reasoningEffort: "medium",
      cwd: "/etc",
      order: 0,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      vncTarget: null,
      createdAt: now,
      updatedAt: now
    };
    const client = new RecordingClient((sql, values) => {
      // Completion locks the pane first so it orders with submission and polling.
      if (sql.includes("FROM panes") && sql.includes("FOR UPDATE")) return [pane];
      if (sql.includes("UPDATE space_agent_messages")) return [{ ...message, content: values?.[1], status: "COMPLETED" }];
      if (sql.includes("UPDATE space_agent_runs")) {
        return [{ ...run, status: "COMPLETED", codexThreadId: values?.[1], codexTurnId: values?.[2], completedAt: values?.[3] }];
      }
      if (sql.includes("UPDATE space_agent_sessions")) {
        return [{ ...session, status: "READY", threadId: values?.[1], lastSyncedAt: values?.[2] }];
      }
      if (sql.includes("FROM space_agent_runs")) return [run];
      if (sql.includes("FROM space_agent_sessions")) return [session];
      if (sql.includes("FROM space_agent_messages") && values?.[0] === promptMessage.messageId) return [promptMessage];
      if (sql.includes("FROM space_agent_messages")) return [message];
      if (sql.includes("INSERT INTO events")) {
        return [{
          id: values?.[0],
          roomId: values?.[1],
          paneId: values?.[2],
          turnId: values?.[3],
          workflowId: values?.[4],
          traceId: values?.[5],
          type: values?.[6],
          message: values?.[7],
          payload: JSON.parse(String(values?.[8])),
          createdAt: values?.[9]
        }];
      }
      return [];
    });
    const store = new PostgresSpaceStore(new RecordingPool(client));

    const completed = await store.completeSpaceAgentRun({
      runId: run.runId,
      sessionId: session.sessionId,
      responseMessageId: message.messageId,
      responseContent: "Final answer",
      finalResponse: "Full final answer",
      codexThreadId: "11111111-1111-4111-8111-111111111111",
      codexTurnId: "turn:codex123",
      sourceType: "ROOM_AGENT",
      traceId: "trace:test123",
      completedAt: now
    });

    expect(completed).toMatchObject({
      run: { status: "COMPLETED" },
      session: { status: "READY" },
      responseMessage: { content: "Final answer", status: "COMPLETED" },
      event: { type: "TURN_COMPLETED" }
    });
    const statements = client.calls.map((call) => call.sql);
    const paneLock = statements.findIndex(sql => sql.includes("FROM panes") && sql.includes("FOR UPDATE"));
    const runLock = statements.findIndex(sql => sql.includes("FROM space_agent_runs") && sql.includes("FOR UPDATE"));
    expect(paneLock).toBeGreaterThanOrEqual(0);
    expect(runLock).toBeGreaterThan(paneLock);
    const outboxCall = client.calls.find((call) => call.sql.includes("INSERT INTO telegram_notification_outbox"));
    expect(outboxCall?.sql).toContain("agent_label, task_title");
    expect(outboxCall?.values).toContain("Διόρθωση Telegram flood");
    expect(outboxCall?.values).toContain("Full final answer");
    expect(statements.findIndex((sql) => sql.includes("FROM panes") && sql.includes("FOR UPDATE"))).toBeLessThan(
      statements.findIndex((sql) => sql.includes("FROM space_agent_runs") && sql.includes("FOR UPDATE"))
    );
    expect(statements.findIndex((sql) => sql.includes("INSERT INTO telegram_notification_outbox"))).toBeLessThan(
      statements.findIndex((sql) => sql.trim() === "COMMIT")
    );
    expect(statements.filter((sql) => sql.trim() === "BEGIN")).toHaveLength(1);
    expect(statements.filter((sql) => sql.trim() === "COMMIT")).toHaveLength(1);
  });

  it("refunds the claimed attempt only when a retry is not counted", async () => {
    const client = new RecordingClient(() => []);
    const persistence = new PostgresTelegramPersistence(new RecordingPool(client));
    const retry = { deliveryId: "telegram_delivery:test123", workerId: "worker:test", availableAt: now, safeErrorCode: "TELEGRAM_RATE_LIMITED", now };

    await persistence.retryDelivery(retry);
    await persistence.retryDelivery({ ...retry, countAttempt: false });

    expect(client.calls[0]?.sql).toContain("GREATEST(attempt_count - 1, 0)");
    expect(client.calls[0]?.sql).toContain("locked_by = $2");
    expect(client.calls.map((call) => call.values?.[5])).toEqual([true, false]);
  });

  it("atomically completes a terminal marker without enqueuing completions older than enable", async () => {
    const marker = {
      markerId: "codex_cli_turn:test123",
      sessionId: "cli_session:test123",
      roomId: "room:test123",
      paneId: "pane:test123",
      clientTurnMarker: "browser-marker-test123",
      status: "PROCESSING",
      codexThreadId: "11111111-1111-4111-8111-111111111111",
      rolloutPath: null,
      completionEventId: null,
      submittedAt: "2026-07-14T09:59:00.000Z",
      completedAt: null,
      nextCheckAt: now,
      checkAttemptCount: 2,
      lockedAt: now,
      lockedBy: "worker:test123",
      safeErrorCode: null,
      updatedAt: now
    };
    const client = new RecordingClient((sql, values) => {
      if (sql.includes("FROM codex_cli_turn_markers") && sql.includes("FOR UPDATE")) return [marker];
      if (sql.includes("INSERT INTO events")) {
        return [{
          id: values?.[0],
          roomId: values?.[1],
          paneId: values?.[2],
          turnId: values?.[3],
          workflowId: values?.[4],
          traceId: values?.[5],
          type: values?.[6],
          message: values?.[7],
          payload: JSON.parse(String(values?.[8])),
          createdAt: values?.[9]
        }];
      }
      if (sql.includes("UPDATE codex_cli_turn_markers") && sql.includes("SET status = 'COMPLETED'")) {
        return [{
          ...marker,
          status: "COMPLETED",
          rolloutPath: values?.[2],
          completionEventId: values?.[3],
          completedAt: values?.[4],
          lockedAt: null,
          lockedBy: null,
          updatedAt: values?.[4]
        }];
      }
      return [];
    });
    const store = new PostgresSpaceStore(new RecordingPool(client));

    await expect(store.completeCodexCliTurnMarker({
      markerId: marker.markerId,
      workerId: marker.lockedBy,
      codexThreadId: marker.codexThreadId,
      codexTurnId: "turn:test123",
      rolloutPath: "/var/lib/spaceapp-user/.codex/space-codex-homes/pane--session/sessions/rollout-test.jsonl",
      finalResponse: "Terminal final response",
      completedAt: now,
      traceId: "trace:terminal-test123"
    })).resolves.toMatchObject({ status: "COMPLETED", completionEventId: expect.any(String) });

    const statements = client.calls.map((call) => call.sql);
    const outboxSql = statements.find((sql) => sql.includes("INSERT INTO telegram_notification_outbox"));
    expect(outboxSql).toContain("agent_label, task_title");
    expect(outboxSql).toContain("'Agent '");
    expect(outboxSql).toContain("p.title");
    expect(outboxSql).toContain("i.enabled_at IS NOT NULL");
    expect(outboxSql).toContain("$4 >= i.enabled_at");
    expect(statements.findIndex((sql) => sql.includes("INSERT INTO events"))).toBeLessThan(
      statements.findIndex((sql) => sql.includes("INSERT INTO telegram_notification_outbox"))
    );
    expect(statements.findIndex((sql) => sql.includes("INSERT INTO telegram_notification_outbox"))).toBeLessThan(
      statements.findIndex((sql) => sql.includes("SET status = 'COMPLETED'"))
    );
    expect(statements.filter((sql) => sql.trim() === "BEGIN")).toHaveLength(1);
    expect(statements.filter((sql) => sql.trim() === "COMMIT")).toHaveLength(1);
    const outboxCall = client.calls.find((call) => call.sql.includes("INSERT INTO telegram_notification_outbox"));
    expect(outboxCall?.sql).toContain("ON CONFLICT (source_key) DO NOTHING");
    expect(outboxCall?.values?.[1]).toBe(`codex_cli_turn:${marker.codexThreadId}:turn:test123`);
  });

  it("keys terminal completions by Codex turn so markers resolving to one turn notify once", async () => {
    const markers = ["codex_cli_turn:first123", "codex_cli_turn:second123"].map((markerId) => ({
      markerId,
      sessionId: "cli_session:test123",
      roomId: "room:test123",
      paneId: "pane:test123",
      clientTurnMarker: `browser-${markerId}`,
      status: "PROCESSING",
      codexThreadId: "11111111-1111-4111-8111-111111111111",
      rolloutPath: null,
      completionEventId: null,
      submittedAt: "2026-07-14T09:59:00.000Z",
      completedAt: null,
      nextCheckAt: now,
      checkAttemptCount: 1,
      lockedAt: now,
      lockedBy: "worker:test123",
      safeErrorCode: null,
      updatedAt: now
    }));
    const sourceKeys: unknown[] = [];
    const client = new RecordingClient((sql, values) => {
      if (sql.includes("FROM codex_cli_turn_markers") && sql.includes("FOR UPDATE")) {
        return [markers.find((marker) => marker.markerId === values?.[0])];
      }
      if (sql.includes("INSERT INTO events")) {
        return [{ id: values?.[0], roomId: values?.[1], paneId: values?.[2], turnId: null, workflowId: null, traceId: values?.[5], type: values?.[6], message: values?.[7], payload: JSON.parse(String(values?.[8])), createdAt: values?.[9] }];
      }
      if (sql.includes("INSERT INTO telegram_notification_outbox")) sourceKeys.push(values?.[1]);
      if (sql.includes("UPDATE codex_cli_turn_markers") && sql.includes("SET status = 'COMPLETED'")) {
        return [{ ...markers.find((marker) => marker.markerId === values?.[0]), status: "COMPLETED", lockedAt: null, lockedBy: null }];
      }
      return [];
    });
    const store = new PostgresSpaceStore(new RecordingPool(client));
    for (const marker of markers) {
      await store.completeCodexCliTurnMarker({
        markerId: marker.markerId,
        workerId: marker.lockedBy,
        codexThreadId: marker.codexThreadId,
        codexTurnId: "turn:shared123",
        rolloutPath: "/tmp/rollout-test.jsonl",
        finalResponse: "Terminal final response",
        completedAt: now,
        traceId: "trace:terminal-test123"
      });
    }
    expect(new Set(sourceKeys)).toEqual(new Set([`codex_cli_turn:${markers[0]!.codexThreadId}:turn:shared123`]));

    sourceKeys.length = 0;
    await store.completeCodexCliTurnMarker({
      markerId: markers[0]!.markerId,
      workerId: markers[0]!.lockedBy,
      codexThreadId: markers[0]!.codexThreadId,
      codexTurnId: null,
      rolloutPath: "/tmp/rollout-test.jsonl",
      finalResponse: "Terminal final response",
      completedAt: now,
      traceId: "trace:terminal-test123"
    });
    expect(sourceKeys).toEqual([`codex_cli_marker:${markers[0]!.markerId}`]);
  });
});
