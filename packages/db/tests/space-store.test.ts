import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";
import {
  SpaceConflictError,
  SpaceFeatureDisabledError,
  SpaceNotFoundError,
  hashMemorySnapshot
} from "@space/runtime";

interface QueryCall {
  sql: string;
  values: unknown[];
}

class FakePgClient implements PgClientLike {
  readonly calls: QueryCall[] = [];
  private queryFailures: Array<{ sqlIncludes: string; error: Error }> = [];
  private userRows: Array<{ id: string; email: string; role: "OPERATOR" | "ADMIN"; updatedAt: unknown }> = [];
  private auditRows: unknown[] = [];
  private roomId = "room:test-1";
  private roomRows: unknown[] = [];
  private paneId = "pane:test-1";
  private paneRows: unknown[] = [];
  private workflowId = "workflow:test-1";
  private workflowRows: Record<string, unknown>[] = [];
  private providerRows: unknown[] = [];
  private providerSettingsRow: unknown | null = null;
  private codexCliModeDefaultsRow: Record<string, unknown> | null = null;
  private providerValidationRows: unknown[] = [];
  private codexHandshakeRows: unknown[] = [];
  private codexTurnSmokeRows: unknown[] = [];
  private mcpDiscoverySmokeRows: unknown[] = [];
  private memoryEmbeddingSmokeRows: unknown[] = [];
  private modelRows: unknown[] = [];
  private mcpServerRows: unknown[] = [];
  private mcpToolRows: unknown[] = [];
  private importCandidateRows: unknown[] = [];
  private memoryRows: unknown[] = [];
  private memoryIssueStateRows: unknown[] = [];
  private memoryConsolidationRunRows: unknown[] = [];
  private memoryConsolidationFindingRows: unknown[] = [];
  private memoryConsolidationOperationRows: unknown[] = [];
  private memoryCommandIdempotencyRows: unknown[] = [];
  private memoryChangeSetRows: unknown[] = [];
  private artifactRows: unknown[] = [];
  private skillRows: unknown[] = [];
  private reviewRows: unknown[] = [];
  private reviewCheckRows: unknown[] = [];
  private reviewDiffRows: unknown[] = [];
  private swarmTaskRows: unknown[] = [];
  private swarmLockRows: unknown[] = [];
  private swarmMessageRows: unknown[] = [];
  private swarmReconcileRows: unknown[] = [];
  private agentPaneBindingRows: unknown[] = [];
  private agentPaneSessionRows: unknown[] = [];
  private spaceAgentSessionRows: unknown[] = [];
  private spaceAgentMessageRows: unknown[] = [];
  private spaceAgentRunRows: unknown[] = [];
  private roomAgentBindingRows: unknown[] = [];
  private roomAgentRequestRows: unknown[] = [];
  private roomAgentMissionRows: unknown[] = [];
  private roomAgentActionRows: unknown[] = [];
  private paneBrowserSessionRows: unknown[] = [];
  private paneCliSessionRows: unknown[] = [];
  private cliTaskRows: Record<string, unknown>[] = [];
  private cliTaskRevisionRows: Record<string, unknown>[] = [];
  private paneCliCodexThreadOwnershipRows: unknown[] = [];
  private paneCliTranscriptRows: unknown[] = [];
  readonly turnRows: unknown[] = [];
  private eventRows: unknown[] = [];

  seedEvents(rows: Record<string, unknown>[]): void {
    this.eventRows = [...rows];
  }

  failNextQuery(sqlIncludes: string, error: Error): void {
    this.queryFailures.push({ sqlIncludes, error });
  }

  async query<T = unknown>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("FROM space_agent_runs") && (sql.includes("cli_task_id") || sql.includes("cli_task_revision_id"))) {
      throw new Error("space_agent_runs does not own CLI logical-task columns");
    }
    const failureIndex = this.queryFailures.findIndex((failure) => sql.includes(failure.sqlIncludes));
    if (failureIndex >= 0) {
      const [failure] = this.queryFailures.splice(failureIndex, 1);
      throw failure.error;
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql === "SELECT pg_advisory_xact_lock(hashtext('rooms_order_lock'))" || sql === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("JOIN room_agent_missions") && sql.includes("r.signaled_at IS NULL")) {
      const limit = Number(values[0] ?? 20);
      const rows = this.roomAgentRequestRows
        .filter((row) => {
          const request = row as { requestId?: unknown; missionId?: unknown; signaledAt?: unknown; turnPayload?: unknown };
          const mission = this.roomAgentMissionRows.find(
            (candidate) => {
              const record = candidate as { id?: unknown; requestId?: unknown };
              return record.id === request.missionId || (request.missionId == null && record.requestId === request.requestId);
            }
          ) as { status?: unknown } | undefined;
          return request.signaledAt == null && request.turnPayload != null &&
            mission != null && ["QUEUED", "RUNNING", "PAUSED"].includes(String(mission.status));
        })
        .slice(0, limit);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM room_agent_bindings") && sql.includes("JOIN panes")) {
      const roomId = String(values[0]);
      const binding = this.roomAgentBindingRows.find((row) => (row as { roomId?: unknown }).roomId === roomId) as
        | { paneId: string }
        | undefined;
      const pane = binding
        ? this.paneRows.find((row) => (row as { id?: unknown }).id === binding.paneId)
        : undefined;
      return { rows: pane ? [pane as T] : [], rowCount: pane ? 1 : 0 };
    }
    if (sql.includes("SELECT transcript_cleared_at") && sql.includes("FROM room_agent_bindings")) {
      const roomId = String(values[0]);
      const binding = this.roomAgentBindingRows.find((row) => (row as { roomId?: unknown }).roomId === roomId) as
        | { transcriptClearedAt?: unknown }
        | undefined;
      return {
        rows: binding ? [{ transcriptClearedAt: binding.transcriptClearedAt ?? null } as T] : [],
        rowCount: binding ? 1 : 0
      };
    }
    if (sql.includes("UPDATE room_agent_bindings") && sql.includes("transcript_cleared_at")) {
      const roomId = String(values[0]);
      const binding = this.roomAgentBindingRows.find((row) => (row as { roomId?: unknown }).roomId === roomId) as
        | Record<string, unknown>
        | undefined;
      if (!binding) return { rows: [], rowCount: 0 };
      binding.transcriptClearedAt = values[1];
      return { rows: [{ transcriptClearedAt: values[1] } as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO room_agent_bindings")) {
      const row = { roomId: values[0], paneId: values[1], createdAt: values[2], updatedAt: values[2] };
      this.roomAgentBindingRows.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE panes") && sql.includes("SET status = 'CLOSED'")) {
      const paneId = String(values[0]);
      const current = this.paneRows.find((row) => (row as { id?: unknown }).id === paneId) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = { ...current, status: "CLOSED", reasoningEffort: "high", isClosed: true, updatedAt: values[1] };
      this.paneRows = [row, ...this.paneRows.filter((item) => (item as { id?: unknown }).id !== paneId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM room_agent_requests") && sql.includes("WHERE request_id = $1")) {
      const requestId = String(values[0]);
      const roomId = String(values[1]);
      const sessionId = String(values[2]);
      const row = this.roomAgentRequestRows.find((item) => {
        const request = item as { requestId?: unknown; roomId?: unknown; sessionId?: unknown };
        return request.requestId === requestId && request.roomId === roomId && request.sessionId === sessionId;
      });
      return { rows: row ? [{ requestId } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM room_agent_requests")) {
      const roomId = String(values[0]);
      const clientRequestId = String(values[1]);
      const rows = this.roomAgentRequestRows.filter((row) => {
        const request = row as { roomId?: unknown; clientRequestId?: unknown };
        return request.roomId === roomId && request.clientRequestId === clientRequestId;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO room_agent_requests")) {
      const row = {
        requestId: values[0],
        roomId: values[1],
        sessionId: values[2],
        missionId: values[3] ?? null,
        requestKind: values[4] ?? "MISSION",
        clientRequestId: values[5],
        promptMessageId: values[6],
        responseMessageId: values[7],
        turnPayload: values[8] ? JSON.parse(String(values[8])) : null,
        signaledAt: null,
        createdAt: "2026-07-11T18:00:00.000Z"
      };
      this.roomAgentRequestRows.push(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE room_agent_requests SET mission_id")) {
      const row = this.roomAgentRequestRows.find((item) =>
        (item as { requestId?: unknown }).requestId === values[0]
      ) as Record<string, unknown> | undefined;
      if (!row) return { rows: [], rowCount: 0 };
      row.missionId = values[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE room_agent_requests SET signaled_at")) {
      const row = this.roomAgentRequestRows.find((item) => {
        const request = item as { roomId?: unknown; clientRequestId?: unknown };
        return request.roomId === values[0] && request.clientRequestId === values[1];
      }) as Record<string, unknown> | undefined;
      if (!row) return { rows: [], rowCount: 0 };
      row.signaledAt = values[2];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO room_agent_missions")) {
      const row = {
        id: values[0],
        requestId: values[1],
        roomId: values[2],
        sessionId: values[3],
        workflowId: values[4],
        status: values[5],
        currentPaneId: values[6],
        statusReason: values[7],
        queuedAt: "2026-07-11T18:00:01.000Z",
        startedAt: null,
        completedAt: null,
        pausedAt: null,
        totalPausedMs: 0,
        lastProgressAt: null,
        executionState: values[8] ? JSON.parse(String(values[8])) : {},
        updatedAt: "2026-07-11T18:00:01.000Z"
      };
      this.roomAgentMissionRows.push(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE room_agent_missions") && sql.includes("SET execution_state = $3::jsonb")) {
      const missionId = String(values[0]);
      const current = this.roomAgentMissionRows.find((row) => (row as { id?: unknown }).id === missionId) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        executionState: JSON.parse(String(values[2])),
        completedAt: null,
        statusReason: values[3],
        lastProgressAt: values[4],
        updatedAt: values[4]
      };
      this.roomAgentMissionRows = [row, ...this.roomAgentMissionRows.filter((item) => (item as { id?: unknown }).id !== missionId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE room_agent_missions")) {
      const missionId = String(values[0]);
      const current = this.roomAgentMissionRows.find((row) => (row as { id?: unknown }).id === missionId) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        status: values[1] ?? current.status,
        currentPaneId: values[2] ? values[3] : current.currentPaneId,
        statusReason: values[4] ?? current.statusReason,
        startedAt: values[5] ? values[6] : current.startedAt,
        completedAt: values[7] ? values[8] : current.completedAt,
        pausedAt: values[9] ? values[10] : current.pausedAt,
        totalPausedMs: values[11] ?? current.totalPausedMs,
        lastProgressAt: values[12] ? values[13] : current.lastProgressAt,
        executionState: values[14] ? JSON.parse(String(values[15])) : current.executionState,
        updatedAt: values[16]
      };
      this.roomAgentMissionRows = [row, ...this.roomAgentMissionRows.filter((item) => (item as { id?: unknown }).id !== missionId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("SELECT mission_id AS id FROM room_agent_missions")) {
      if (sql.includes("status IN ('QUEUED', 'RUNNING', 'PAUSED')")) {
        const rows = this.roomAgentMissionRows.filter(item => {
          const mission = item as { id: string; roomId: string; status: string };
          return mission.roomId === values[0] && ["QUEUED", "RUNNING", "PAUSED"].includes(mission.status);
        }).slice(0, 1);
        return { rows: rows as T[], rowCount: rows.length };
      }
      const missionId = String(values[0]);
      const row = this.roomAgentMissionRows.find((item) => (item as { id?: unknown }).id === missionId);
      return { rows: row ? [{ id: missionId } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM room_agent_missions")) {
      const lookup = String(values[0]);
      const rows = this.roomAgentMissionRows.filter((row) => {
        const mission = row as { id?: unknown; roomId?: unknown; requestId?: unknown };
        if (sql.includes("WHERE mission_id = $1 OR request_id = $2")) {
          return mission.id === values[0] || mission.requestId === values[1];
        }
        if (sql.includes("WHERE request_id = $1")) return mission.requestId === lookup;
        if (sql.includes("WHERE room_id = $1 AND mission_id = $2")) {
          return mission.roomId === lookup && mission.id === values[1];
        }
        return mission.roomId === lookup;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO room_agent_actions")) {
      const row = {
        actionId: values[0],
        missionId: values[1],
        roomId: values[2],
        paneId: values[3],
        idempotencyKey: values[4],
        actionType: values[5],
        status: values[6],
        requestPayload: JSON.parse(String(values[7])),
        evidence: JSON.parse(String(values[8])),
        attemptCount: values[9],
        statusReason: values[10],
        createdAt: "2026-07-11T18:00:02.000Z",
        updatedAt: "2026-07-11T18:00:02.000Z",
        completedAt: null
      };
      this.roomAgentActionRows.push(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE room_agent_actions")) {
      const actionId = String(values[0]);
      const current = this.roomAgentActionRows.find((row) => (row as { actionId?: unknown }).actionId === actionId) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        paneId: values[1] ? values[2] : current.paneId,
        status: values[3] ?? current.status,
        evidence: values[4] === null ? current.evidence : JSON.parse(String(values[4])),
        attemptCount: values[5] ?? current.attemptCount,
        statusReason: values[6] ?? current.statusReason,
        completedAt: values[7] ? values[8] : current.completedAt,
        updatedAt: values[9]
      };
      this.roomAgentActionRows = [row, ...this.roomAgentActionRows.filter((item) => (item as { actionId?: unknown }).actionId !== actionId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM room_agent_actions") && sql.includes("WHERE idempotency_key = $1")) {
      const idempotencyKey = String(values[0]);
      const row = this.roomAgentActionRows.find(
        (item) => (item as { idempotencyKey?: unknown }).idempotencyKey === idempotencyKey
      ) as { actionId?: string } | undefined;
      return { rows: row ? [{ actionId: row.actionId } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM room_agent_actions")) {
      const missionId = String(values[0]);
      const rows = this.roomAgentActionRows.filter((row) => {
        const action = row as { actionId?: unknown; missionId?: unknown };
        if (action.missionId !== missionId) return false;
        return !sql.includes("WHERE mission_id = $1 AND action_id = $2") || action.actionId === values[1];
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("WITH updated_email")) {
      const [id, email, role, updatedAt] = values as [string, string, "OPERATOR" | "ADMIN", unknown];
      const existingByEmail = this.userRows.find((row) => row.email.toLowerCase() === email.toLowerCase());
      if (existingByEmail) {
        existingByEmail.role = role;
        existingByEmail.updatedAt = updatedAt;
        return { rows: [{ id: existingByEmail.id, email: existingByEmail.email, role } as T], rowCount: 1 };
      }
      const existingById = this.userRows.find((row) => row.id === id);
      if (existingById) {
        existingById.email = email;
        existingById.role = role;
        existingById.updatedAt = updatedAt;
        return { rows: [{ id, email, role } as T], rowCount: 1 };
      }
      this.userRows.push({ id, email, role, updatedAt });
      return { rows: [{ id, email, role } as T], rowCount: 1 };
    }
    if (sql.includes("SELECT id FROM users WHERE id = $1")) {
      const row = this.userRows.find((user) => user.id === values[0]);
      return { rows: row ? [{ id: row.id } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM pg_extension")) {
      return { rows: [{ extensionVersion: "0.8.3" } as T], rowCount: 1 };
    }
    if (sql.includes("FROM pg_attribute")) {
      return { rows: [{ formattedType: "vector(1536)" } as T], rowCount: 1 };
    }
    if (sql.includes("to_regclass('idx_memory_records_embedding_hnsw')")) {
      return { rows: [{ vectorIndexReady: true } as T], rowCount: 1 };
    }
    if (sql.includes("SELECT COALESCE(MAX(room_order), -1) + 1 AS \"nextOrder\" FROM rooms")) {
      const nextOrder = this.roomRows.reduce((max, row) => {
        const order = Number((row as { order?: unknown }).order ?? -1);
        return Number.isFinite(order) ? Math.max(max, order) : max;
      }, -1) + 1;
      return { rows: [{ nextOrder } as T], rowCount: 1 };
    }
    if (sql.includes("SELECT COALESCE(MAX(pane_order), -1) + 1 AS \"nextOrder\" FROM panes")) {
      const roomId = String(values[0] ?? this.roomId);
      const nextOrder = this.paneRows
        .filter((row) => (row as { roomId?: unknown; isClosed?: unknown }).roomId === roomId && (row as { isClosed?: unknown }).isClosed !== true)
        .reduce((max, row) => {
          const order = Number((row as { order?: unknown }).order ?? -1);
          return Number.isFinite(order) ? Math.max(max, order) : max;
        }, -1) + 1;
      return { rows: [{ nextOrder } as T], rowCount: 1 };
    }
    if (sql.includes("SELECT count(*) AS count FROM panes WHERE room_id = $1 AND is_closed = false")) {
      const roomId = String(values[0] ?? this.roomId);
      const count = this.paneRows.filter(
        (row) => (row as { roomId?: unknown; isClosed?: unknown }).roomId === roomId && (row as { isClosed?: unknown }).isClosed !== true
      ).length;
      return { rows: [{ count: String(count) } as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO rooms")) {
      this.roomId = String(values[0]);
      const row = {
        id: this.roomId,
        name: values[1],
        description: values[2],
        kind: values[7],
        order: values[3],
        paneLayoutColumns: null,
        paneCap: values[4],
        traceId: values[5],
        archivedAt: null,
        createdAt: values[6],
        updatedAt: values[6]
      };
      this.roomRows = [row, ...this.roomRows.filter((item) => (item as { id?: unknown }).id !== this.roomId)];
      return {
        rows: [row],
        rowCount: 1
      } as { rows: T[]; rowCount: number };
    }
    if (sql.includes("UPDATE rooms") && sql.includes("pane_layout_columns = $2")) {
      const roomId = String(values[0]);
      const current = this.roomRows.find((row) => (row as { id?: unknown }).id === roomId) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        paneLayoutColumns: values[1],
        paneLayoutHeight: values[4] ?? current.paneLayoutHeight ?? 1,
        traceId: values[2],
        updatedAt: values[3]
      };
      this.roomRows = [row, ...this.roomRows.filter((item) => (item as { id?: unknown }).id !== roomId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM unnest($1::text[]) WITH ORDINALITY") && sql.includes("room_order = -ordered.room_order - 1")) {
      const roomIds = values[0] as string[];
      const traceId = values[1];
      const orderById = new Map(roomIds.map((roomId, index) => [roomId, index]));
      this.roomRows = this.roomRows.map((row) => {
        const current = row as {
          id: string;
          traceId: unknown;
          order: number;
        };
        const nextOrder = orderById.get(current.id);
        if (nextOrder === undefined) return row;
        return {
          ...current,
          traceId,
          order: -nextOrder - 1
        };
      });
      return { rows: [], rowCount: this.roomRows.length };
    }
    if (sql === "UPDATE rooms SET room_order = -room_order - 1") {
      this.roomRows = this.roomRows.map((row) => {
        const current = row as { order: number };
        return {
          ...(row as Record<string, unknown>),
          order: -current.order - 1
        };
      });
      return { rows: [], rowCount: this.roomRows.length };
    }
    if (sql.includes("FROM unnest($2::text[]) WITH ORDINALITY") && sql.includes("pane_order = -ordered.pane_order - 1")) {
      const paneIds = values[1] as string[];
      const traceId = values[2];
      const orderById = new Map(paneIds.map((paneId, index) => [paneId, index]));
      this.paneRows = this.paneRows.map((row) => {
        const current = row as {
          id: string;
          traceId: unknown;
          order: number;
        };
        const nextOrder = orderById.get(current.id);
        if (nextOrder === undefined) return row;
        return {
          ...current,
          traceId,
          order: -nextOrder - 1
        };
      });
      return { rows: [], rowCount: this.paneRows.length };
    }
    if (sql.includes("UPDATE panes SET pane_order = -pane_order - 1")) {
      this.paneRows = this.paneRows.map((row) => {
        const current = row as { order: number };
        return {
          ...(row as Record<string, unknown>),
          order: -current.order - 1
        };
      });
      return { rows: [], rowCount: this.paneRows.length };
    }
    if (sql.includes("SELECT pane_name AS \"paneName\" FROM panes")) {
      const roomId = String(values[0] ?? this.roomId);
      const rows = this.paneRows
        .filter((row) => (row as { roomId?: unknown; isClosed?: unknown }).roomId === roomId && (row as { isClosed?: unknown }).isClosed !== true)
        .map((row) => ({ paneName: (row as { paneName?: string }).paneName }))
        .filter((r) => Boolean(r.paneName));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("SELECT count(*) AS count FROM panes WHERE room_id = $1 AND is_closed = false AND pane_name = $2")) {
      const roomId = String(values[0] ?? this.roomId);
      const targetName = String(values[1] ?? "");
      const count = this.paneRows.filter(
        (row) =>
          (row as { roomId?: unknown; isClosed?: unknown; paneName?: unknown }).roomId === roomId &&
          (row as { isClosed?: unknown }).isClosed !== true &&
          (row as { paneName?: unknown }).paneName === targetName
      ).length;
      return { rows: [{ count: String(count) } as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO panes")) {
      this.paneId = String(values[0]);
      const row = {
        id: this.paneId,
        roomId: values[1],
        title: values[2],
        paneName: values[3],
        mode: values[4],
        status: "IDLE",
        providerId: values[5],
        modelId: values[6],
        terminalRuntimeId: values[7],
        reasoningEffort: "medium",
        cwd: values[8],
        order: values[9],
        columnSpan: 1,
        isMaximized: false,
        isMinimized: false,
        isClosed: false,
        split: JSON.parse(String(values[10])),
        vncTarget: values[11] ? JSON.parse(String(values[11])) : null,
        createdAt: values[12],
        updatedAt: values[12]
      };
      this.paneRows = [row, ...this.paneRows.filter((item) => (item as { id?: unknown }).id !== this.paneId)];
      return {
        rows: [row],
        rowCount: 1
      } as { rows: T[]; rowCount: number };
    }
    if (
      sql.includes("UPDATE panes") &&
      sql.includes("column_span = 1") &&
      sql.includes("is_maximized = false") &&
      sql.includes("WHERE room_id = $1 AND is_closed = false")
    ) {
      const roomId = String(values[0]);
      let updated = 0;
      this.paneRows = this.paneRows.map((row) => {
        const current = row as Record<string, unknown> & { roomId?: unknown; isClosed?: unknown };
        if (current.roomId !== roomId || current.isClosed === true) return row;
        updated += 1;
        return { ...current, columnSpan: 1, isMaximized: false, updatedAt: values[1] };
      });
      return { rows: [], rowCount: updated };
    }
    if (sql.includes("UPDATE panes") && sql.includes("SET title = $2")) {
      const paneId = String(values[0]);
      const current = this.paneRows.find((row) => (row as { id?: unknown }).id === paneId) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        title: values[1],
        titleSource: values[2],
        mode: values[3],
        status: values[4],
        providerId: values[5],
        modelId: values[6],
        terminalRuntimeId: values[7],
        reasoningEffort: values[8],
        cwd: values[9],
        order: values[10],
        columnSpan: values[11],
        isMaximized: values[12],
        isMinimized: values[13],
        isClosed: values[14],
        split: JSON.parse(String(values[15])),
        categoryColor: values[16],
        vncTarget: values[17] ? JSON.parse(String(values[17])) : null,
        updatedAt: values[18],
        taskMetadata: values[19] ? JSON.parse(String(values[19])) : null,
        paneName: values[20] ?? current.paneName
      };
      this.paneRows = [row, ...this.paneRows.filter((item) => (item as { id?: unknown }).id !== paneId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE panes") && sql.includes("SET room_id = $2")) {
      const paneId = String(values[0]);
      const current = this.paneRows.find((row) => (row as { id?: unknown }).id === paneId) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        roomId: values[1],
        order: values[2],
        columnSpan: 1,
        isMaximized: false,
        isMinimized: false,
        split: JSON.parse(String(values[3])),
        updatedAt: values[4],
        paneName: values[5] ?? current.paneName
      };
      this.paneRows = [row, ...this.paneRows.filter((item) => (item as { id?: unknown }).id !== paneId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE panes") && sql.includes("SET status = 'CLOSED'")) {
      const paneId = String(values[0]);
      const current = this.paneRows.find((row) => (row as { id?: unknown }).id === paneId) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        status: "CLOSED",
        isClosed: true,
        updatedAt: values[1]
      };
      this.paneRows = [row, ...this.paneRows.filter((item) => (item as { id?: unknown }).id !== paneId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO pane_agent_bindings")) {
      const current = this.agentPaneBindingRows.find((row) => (row as { paneId?: unknown }).paneId === values[0]) as
        | Record<string, unknown>
        | undefined;
      const row = {
        paneId: values[0],
        source: values[1],
        coderChatId: values[2],
        status: values[3],
        title: values[4],
        selectedModelConfigId: values[5],
        selectedProviderName: values[6],
        selectedModelName: values[7],
        selectedReasoningKey: values[8],
        selectedToolIds: values[9],
        lastSyncedAt: values[10],
        createdAt: current?.createdAt ?? values[11],
        updatedAt: values[11]
      };
      this.agentPaneBindingRows = [row, ...this.agentPaneBindingRows.filter((item) => (item as { paneId?: unknown }).paneId !== values[0])];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_agent_bindings")) {
      const paneId = String(values[0]);
      const current = this.agentPaneBindingRows.find((row) => (row as { paneId?: unknown }).paneId === paneId) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        coderChatId: values[1],
        status: values[2],
        title: values[3],
        selectedModelConfigId: values[4],
        selectedProviderName: values[5],
        selectedModelName: values[6],
        selectedReasoningKey: values[7],
        selectedToolIds: values[8],
        lastSyncedAt: values[9],
        updatedAt: values[10]
      };
      this.agentPaneBindingRows = [row, ...this.agentPaneBindingRows.filter((item) => (item as { paneId?: unknown }).paneId !== paneId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO pane_agent_sessions")) {
      const current = this.agentPaneSessionRows.find(
        (row) => (row as { paneId?: unknown; coderChatId?: unknown }).paneId === values[0] &&
          (row as { paneId?: unknown; coderChatId?: unknown }).coderChatId === values[3]
      ) as Record<string, unknown> | undefined;
      const row = {
        paneId: values[0],
        roomId: values[1],
        source: values[2],
        coderChatId: values[3],
        status: values[4],
        title: values[5],
        selectedModelConfigId: values[6],
        selectedProviderName: values[7],
        selectedModelName: values[8],
        selectedReasoningKey: values[9],
        selectedToolIds: values[10],
        lastSyncedAt: values[11],
        createdAt: current?.createdAt ?? values[12],
        updatedAt: values[12]
      };
      this.agentPaneSessionRows = [
        row,
        ...this.agentPaneSessionRows.filter(
          (item) => !(
            (item as { paneId?: unknown; coderChatId?: unknown }).paneId === values[0] &&
            (item as { paneId?: unknown; coderChatId?: unknown }).coderChatId === values[3]
          )
        )
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_agent_sessions SET room_id = $2")) {
      const paneId = values[0];
      this.agentPaneSessionRows = this.agentPaneSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.paneId === paneId ? { ...item, roomId: values[1], updatedAt: values[2] } : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE space_agent_sessions") && sql.includes("RETURNING session_record.session_id")) {
      const updatedAt = String(values[0]);
      const stale = this.spaceAgentSessionRows.filter((row) => {
        const item = row as Record<string, unknown>;
        if (item.isActive !== true) return false;
        const hasRunningRun = this.spaceAgentRunRows.some(
          (run) => (run as { sessionId?: unknown; status?: unknown }).sessionId === item.sessionId &&
            (run as { status?: unknown }).status === "RUNNING"
        );
        if (hasRunningRun) return false;
        const pane = this.paneRows.find((candidate) => (candidate as { id?: unknown }).id === item.paneId) as
          | Record<string, unknown>
          | undefined;
        if (pane && pane.isClosed !== true) return false;
        return true;
      });
      this.spaceAgentSessionRows = this.spaceAgentSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        if (!stale.includes(row)) return row;
        return { ...item, isActive: false, status: "READY", updatedAt };
      });
      return { rows: stale as T[], rowCount: stale.length };
    }
    if (sql.includes("UPDATE space_agent_sessions SET is_active = false")) {
      const paneId = values[0];
      const excludedSessionId = values.length > 2 ? values[1] : null;
      this.spaceAgentSessionRows = this.spaceAgentSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        if (item.paneId !== paneId || (excludedSessionId && item.sessionId === excludedSessionId)) return row;
        return { ...item, isActive: false, updatedAt: values.at(-1) };
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO space_agent_sessions")) {
      const current = this.spaceAgentSessionRows.find((row) => (row as { sessionId?: unknown }).sessionId === values[0]) as
        | Record<string, unknown>
        | undefined;
      const row = {
        sessionId: values[0],
        paneId: values[1],
        roomId: values[2],
        source: "SPACE",
        status: values[3],
        title: values[4],
        threadId: values[5],
        selectedProviderId: values[6],
        selectedModelId: values[7],
        selectedModelConfigId: values[8],
        selectedProviderName: values[9],
        selectedModelName: values[10],
        selectedReasoningKey: values[11],
        selectedToolIds: values[12],
        permissionMode: values[13],
        collaborationMode: values[14],
        isActive: values[15],
        lastSyncedAt: values[16],
        createdAt: current?.createdAt ?? values[17],
        updatedAt: values[17]
      };
      this.spaceAgentSessionRows = [
        row,
        ...this.spaceAgentSessionRows.filter((item) => (item as { sessionId?: unknown }).sessionId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE space_agent_sessions") && sql.includes("WHERE session_id = $1")) {
      if (sql.includes("SET status = 'RUNNING'")) {
        const current = this.spaceAgentSessionRows.find((row) => (row as { sessionId?: unknown }).sessionId === values[0]) as
          | Record<string, unknown>
          | undefined;
        if (!current) return { rows: [], rowCount: 0 };
        const row = { ...current, status: "RUNNING", lastSyncedAt: values[1], updatedAt: values[1] };
        this.spaceAgentSessionRows = [
          row,
          ...this.spaceAgentSessionRows.filter((item) => (item as { sessionId?: unknown }).sessionId !== values[0])
        ];
        return { rows: [], rowCount: 1 };
      }
      const current = this.spaceAgentSessionRows.find((row) => (row as { sessionId?: unknown }).sessionId === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        paneId: values[1],
        roomId: values[2],
        status: values[3],
        title: values[4],
        threadId: values[5],
        selectedProviderId: values[6],
        selectedModelId: values[7],
        selectedModelConfigId: values[8],
        selectedProviderName: values[9],
        selectedModelName: values[10],
        selectedReasoningKey: values[11],
        selectedToolIds: values[12],
        permissionMode: values[13],
        collaborationMode: values[14],
        isActive: values[15],
        lastSyncedAt: values[16],
        updatedAt: values[17]
      };
      this.spaceAgentSessionRows = [
        row,
        ...this.spaceAgentSessionRows.filter((item) => (item as { sessionId?: unknown }).sessionId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE space_agent_sessions SET room_id = $2")) {
      const paneId = values[0];
      this.spaceAgentSessionRows = this.spaceAgentSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.paneId === paneId ? { ...item, roomId: values[1], updatedAt: values[2] } : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO space_agent_messages")) {
      const row = {
        messageId: values[0],
        sessionId: values[1],
        runId: values[2],
        role: values[3],
        content: values[4],
        status: values[5],
        createdAt: values[6],
        updatedAt: values[6]
      };
      this.spaceAgentMessageRows = [
        row,
        ...this.spaceAgentMessageRows.filter((item) => (item as { messageId?: unknown }).messageId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE space_agent_messages") && sql.includes("SET run_id = $2, updated_at = $3")) {
      const current = this.spaceAgentMessageRows.find((row) => (row as { messageId?: unknown }).messageId === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      current.runId = values[1];
      current.updatedAt = values[2];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE space_agent_messages")) {
      const current = this.spaceAgentMessageRows.find((row) => (row as { messageId?: unknown }).messageId === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        runId: values[1],
        content: values[2],
        status: values[3],
        updatedAt: values[4]
      };
      this.spaceAgentMessageRows = [
        row,
        ...this.spaceAgentMessageRows.filter((item) => (item as { messageId?: unknown }).messageId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO space_agent_runs")) {
      const row = {
        runId: values[0],
        sessionId: values[1],
        paneId: values[2],
        roomId: values[3],
        workflowId: values[4],
        temporalRunId: values[5],
        codexThreadId: values[6],
        codexTurnId: values[7],
        status: values[8],
        promptMessageId: values[9],
        responseMessageId: values[10],
        errorCode: values[11],
        errorMessage: values[12],
        createdAt: values[13],
        updatedAt: values[13],
        completedAt: values[14],
        execution: sql.includes("execution_context") && values[15] ? JSON.parse(String(values[15])) : null,
        ledger: sql.includes("task_ledger")
          ? (sql.includes("execution_context") ? (values[19] ? JSON.parse(String(values[19])) : null) : (values[15] ? JSON.parse(String(values[15])) : null))
          : null,
        startedAt: sql.includes("started_at") ? (values[16] ?? null) : null,
        runtimeModelAtStart: null
      };
      this.spaceAgentRunRows = [
        row,
        ...this.spaceAgentRunRows.filter((item) => (item as { runId?: unknown }).runId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE space_agent_runs SET room_id = $2")) {
      const paneId = values[0];
      this.spaceAgentRunRows = this.spaceAgentRunRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.paneId === paneId ? { ...item, roomId: values[1], updatedAt: values[2] } : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE space_agent_runs")) {
      const current = this.spaceAgentRunRows.find((row) => (row as { runId?: unknown }).runId === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        temporalRunId: values[1],
        codexThreadId: values[2],
        codexTurnId: values[3],
        status: values[4],
        errorCode: values[5],
        errorMessage: values[6],
        updatedAt: values[7],
        completedAt: values[8],
        runtimeModelAtStart: values[9] ?? current.runtimeModelAtStart ?? null,
        startedAt: current.startedAt ?? (values[4] === "RUNNING" ? values[7] : null)
      };
      this.spaceAgentRunRows = [
        row,
        ...this.spaceAgentRunRows.filter((item) => (item as { runId?: unknown }).runId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO cli_tasks")) {
      const taskId = String(values[0]);
      if (!this.cliTaskRows.some((row) => row.taskId === taskId)) {
        this.cliTaskRows.push({
          taskId,
          currentRevisionId: null,
          historyHiddenAt: null,
          createdAt: values[1],
          updatedAt: values[1]
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE cli_tasks") && sql.includes("SET current_revision_id")) {
      const row = this.cliTaskRows.find((item) => item.taskId === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.currentRevisionId = values[1];
      row.updatedAt = values[2];
      if (sql.includes("history_hidden_at = NULL")) row.historyHiddenAt = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE cli_tasks task") && sql.includes("SET history_hidden_at = $2")) {
      const taskIds = new Set(Array.isArray(values[0]) ? values[0] : []);
      const rows = this.cliTaskRows.flatMap((row) => {
        if (!taskIds.has(row.taskId) || row.historyHiddenAt) return [];
        const hasActiveSession = this.paneCliSessionRows.some((session) => {
          const item = session as Record<string, unknown>;
          return item.cliTaskId === row.taskId && item.isActive === true;
        });
        if (hasActiveSession) return [];
        row.historyHiddenAt = values[1];
        return [{ taskId: row.taskId }];
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("UPDATE cli_tasks SET history_hidden_at = NULL")) {
      const taskIds = new Set(Array.isArray(values[0]) ? values[0] : []);
      for (const row of this.cliTaskRows) {
        if (taskIds.has(row.taskId)) row.historyHiddenAt = null;
      }
      return { rows: [], rowCount: taskIds.size };
    }
    if (sql.includes("UPDATE cli_tasks SET updated_at")) {
      const row = this.cliTaskRows.find((item) => item.taskId === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.updatedAt = values[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.trimStart().startsWith("SELECT") && sql.includes("FROM cli_tasks") && !sql.includes("first_input")) {
      const taskId = values[0];
      const rows = this.cliTaskRows.filter((row) => !taskId || row.taskId === taskId);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO cli_task_revisions")) {
      const explicit = values.length >= 15;
      const row: Record<string, unknown> = explicit
        ? {
            revisionId: values[0], taskId: values[1], runtimeId: values[2], providerId: values[3], agentId: values[4],
            nativeTaskRef: values[5], sourceRevisionId: values[6], latestSpaceSessionId: values[7],
            displayTitle: values[8], firstUserMessage: values[9], preview: values[10], cwd: values[11],
            modelId: values[12], reasoningEffort: values[13], createdAt: values[14], updatedAt: values[14]
          }
        : {
            revisionId: values[0], taskId: values[1], runtimeId: values[2], providerId: values[3], agentId: values[4],
            nativeTaskRef: values[5], sourceRevisionId: values[6], latestSpaceSessionId: null,
            displayTitle: values[7], firstUserMessage: "", preview: "", cwd: values[8],
            modelId: values[9], reasoningEffort: values[10], createdAt: values[11], updatedAt: values[11]
          };
      this.cliTaskRevisionRows = [
        row,
        ...this.cliTaskRevisionRows.filter((item) => item.revisionId !== row.revisionId)
      ];
      return { rows: explicit ? [row as T] : [], rowCount: 1 };
    }
    if (sql.includes("UPDATE cli_task_revisions SET latest_space_session_id = NULL")) {
      const row = this.cliTaskRevisionRows.find((item) => item.revisionId === values[0]);
      if (row?.latestSpaceSessionId === values[2]) row.latestSpaceSessionId = null;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE pane_cli_sessions SET cli_task_id = $2")) {
      const row = this.paneCliSessionRows.find((item) => (item as Record<string, unknown>).sessionId === values[0]) as Record<string, unknown>;
      if (row) Object.assign(row, { cliTaskId: values[1], cliTaskRevisionId: values[2], updatedAt: values[3] });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE cli_task_revisions SET latest_space_session_id")) {
      const row = this.cliTaskRevisionRows.find((item) => item.revisionId === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.latestSpaceSessionId = values[1];
      row.updatedAt = values[2];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE cli_task_revisions revision") && sql.includes("latest_space_session_id = $2")) {
      const row = this.cliTaskRevisionRows.find((item) => item.revisionId === values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.latestSpaceSessionId = values[1];
      if (values[2]) row.nativeTaskRef = values[2];
      row.updatedAt = values[3];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE cli_task_revisions revision") && sql.includes("first_user_message = CASE")) {
      const row = this.cliTaskRevisionRows.find((item) => item.revisionId === values[1]);
      if (!row) return { rows: [], rowCount: 0 };
      if (values[2] === "stdin" && !String(row.firstUserMessage ?? "").trim()) row.firstUserMessage = values[3];
      if (["stdout", "stderr"].includes(String(values[2])) || !String(row.preview ?? "").trim()) row.preview = values[3];
      row.updatedAt = values[4];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET native_task_ref = $2, latest_space_session_id = $3")) {
      const row = this.cliTaskRevisionRows.find(
        (item) => item.revisionId === values[0] && item.taskId === values[4]
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.nativeTaskRef = values[1];
      row.latestSpaceSessionId = values[2];
      row.updatedAt = values[3];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE cli_task_revisions") && sql.includes("native_task_ref = NULL")) {
      for (const row of this.cliTaskRevisionRows) {
        const matchesRevision = sql.includes("WHERE revision_id = $1") && row.revisionId === values[0];
        const matchesRuntimeRef =
          sql.includes("WHERE runtime_id = $1") &&
          row.runtimeId === values[0] &&
          row.nativeTaskRef === values[1] &&
          row.revisionId !== values[2];
        const matchesTaskRuntimeRef =
          sql.includes("WHERE task_id = $1") &&
          row.taskId === values[0] &&
          row.runtimeId === values[1] &&
          row.nativeTaskRef === values[2] &&
          row.revisionId !== values[4];
        if (matchesRevision || matchesRuntimeRef || matchesTaskRuntimeRef) {
          row.nativeTaskRef = null;
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.trimStart().startsWith("SELECT") && sql.includes("FROM cli_task_revisions")) {
      const rows = this.cliTaskRevisionRows.filter((row) => {
        if (sql.includes("revision_id = $1") && row.revisionId !== values[0]) return false;
        if (sql.includes("runtime_id = $1") && (row.runtimeId !== values[0] || row.nativeTaskRef !== values[1])) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("UPDATE pane_cli_sessions") && sql.includes("WHERE pane_id = $1 AND status = 'RUNNING'")) {
      this.paneCliSessionRows = this.paneCliSessionRows.map(row => {
        const item = row as Record<string, unknown>;
        return item.paneId === values[0] && item.status === "RUNNING"
          ? { ...item, status: "EXITED", isActive: false, endedAt: item.endedAt ?? values[1], updatedAt: values[1] }
          : row;
      });
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE pane_cli_sessions SET is_active = false")) {
      const paneId = values[0];
      const excludedSessionId = values.length > 2 ? values[1] : null;
      this.paneCliSessionRows = this.paneCliSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        if (item.paneId !== paneId || (excludedSessionId && item.sessionId === excludedSessionId)) return row;
        return { ...item, isActive: false, updatedAt: values.at(-1) };
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_sessions SET codex_thread_id = NULL")) {
      this.paneCliSessionRows = this.paneCliSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.codexThreadId === values[0] && item.sessionId !== values[1]
          ? { ...item, codexThreadId: null, updatedAt: values[2] }
          : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_sessions SET codex_thread_id = $2")) {
      this.paneCliSessionRows = this.paneCliSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.sessionId === values[0]
          ? { ...item, codexThreadId: values[1], updatedAt: values[2] }
          : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO pane_cli_sessions")) {
      const current = this.paneCliSessionRows.find((row) => (row as { sessionId?: unknown }).sessionId === values[0]) as
        | Record<string, unknown>
        | undefined;
      const row = {
        sessionId: values[0],
        paneId: values[1],
        roomId: values[2],
        runtimeId: values[3],
        providerId: values[4],
        agentId: values[5],
        modelId: values[6],
        reasoningEffort: values[7],
        launchMode: values[8],
        purpose: values[9],
        cwd: values[10],
        codexThreadId: values[11],
        cliTaskId: values[12],
        cliTaskRevisionId: values[13],
        accountProfileId: values[14],
        status: values[15],
        statusReason: values[16],
        exitCode: null,
        isActive: values[17],
        startedAt: current?.startedAt ?? values[18],
        updatedAt: values[18],
        endedAt: null
      };
      this.paneCliSessionRows = [
        row,
        ...this.paneCliSessionRows.filter((item) => (item as { sessionId?: unknown }).sessionId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_sessions SET room_id = $2")) {
      const paneId = values[0];
      this.paneCliSessionRows = this.paneCliSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.paneId === paneId ? { ...item, roomId: values[1], updatedAt: values[2] } : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_terminal_control_leases SET room_id = $2")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_sessions") && sql.includes("SET updated_at = now()")) {
      this.paneCliSessionRows = this.paneCliSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.sessionId === values[0] && item.status === "RUNNING"
          ? { ...item, updatedAt: new Date().toISOString() }
          : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_sessions SET terminal_geometry")) {
      this.paneCliSessionRows = this.paneCliSessionRows.map(row => {
        const item = row as Record<string, unknown>;
        return item.sessionId === values[0] ? { ...item, terminalGeometry: JSON.parse(String(values[1])) } : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_sessions") && sql.includes("WHERE session_id = $1")) {
      const current = this.paneCliSessionRows.find((row) => (row as { sessionId?: unknown }).sessionId === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };      const row = {
        ...current,
        status: values[1],
        statusReason: values[2],
        exitCode: values[3],
        isActive: values[4],
        updatedAt: values[5],
        endedAt: values[6],
        codexThreadId: values[7],
        modelId: values[8],
        reasoningEffort: values[9],
        launchMode: values[10],
        cliTaskId: values[11],
        cliTaskRevisionId: values[12],
        accountProfileId: values[13]
      };
      this.paneCliSessionRows = [
        row,
        ...this.paneCliSessionRows.filter((item) => (item as { sessionId?: unknown }).sessionId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO pane_cli_transcript_chunks")) {
      const row = {
        chunkId: values[0],
        sessionId: values[1],
        paneId: values[2],
        roomId: values[3],
        sequence: values[4],
        stream: values[5],
        content: values[6],
        byteLength: values[7],
        createdAt: values[8]
      };
      this.paneCliTranscriptRows = [
        row,
        ...this.paneCliTranscriptRows.filter((item) => (item as { chunkId?: unknown }).chunkId !== values[0])
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_transcript_chunks SET room_id = $2")) {
      const paneId = values[0];
      this.paneCliTranscriptRows = this.paneCliTranscriptRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.paneId === paneId ? { ...item, roomId: values[1] } : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_cli_codex_thread_ownerships SET room_id = $2")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM pane_cli_codex_thread_ownerships")) {
      this.paneCliCodexThreadOwnershipRows = this.paneCliCodexThreadOwnershipRows.filter((row) => {
        const item = row as { threadId?: unknown; cliSessionId?: unknown; source?: unknown };
        return !(
          item.threadId === values[0] &&
          item.cliSessionId === values[1] &&
          item.source === "HISTORY_TRANSFER"
        );
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO pane_cli_codex_thread_ownerships")) {
      const existing = this.paneCliCodexThreadOwnershipRows.find(
        (row) => (row as { threadId?: unknown }).threadId === values[0]
      ) as Record<string, unknown> | undefined;
      const row = {
        threadId: values[0],
        roomId: values[1],
        paneId: values[2],
        cliSessionId: values[3],
        source: values[4],
        createdAt: existing?.createdAt ?? values[5],
        updatedAt: values[5]
      };
      this.paneCliCodexThreadOwnershipRows = [
        row,
        ...this.paneCliCodexThreadOwnershipRows.filter(
          (item) => (item as { threadId?: unknown }).threadId !== values[0]
        )
      ];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM pane_cli_transcript_chunks")) {
      const sessionId = values[0];
      const limit = Number(values[1]);
      const rows = this.paneCliTranscriptRows
        .filter((row) => (row as { sessionId?: unknown }).sessionId === sessionId)
        .sort((left, right) => Number((right as { sequence?: unknown }).sequence) - Number((left as { sequence?: unknown }).sequence));
      const keep = new Set(rows.slice(0, limit).map((row) => (row as { chunkId?: unknown }).chunkId));
      this.paneCliTranscriptRows = this.paneCliTranscriptRows.filter(
        (row) => (row as { sessionId?: unknown }).sessionId !== sessionId || keep.has((row as { chunkId?: unknown }).chunkId)
      );
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE pane_browser_sessions SET room_id = $2")) {
      const paneId = values[0];
      this.paneBrowserSessionRows = this.paneBrowserSessionRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.paneId === paneId ? { ...item, roomId: values[1], updatedAt: values[2] } : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO events")) {
      const row = {
        id: values[0],
        roomId: values[1],
        paneId: values[2],
        turnId: values[3],
        workflowId: values[4],
        traceId: values[5],
        type: values[6],
        message: values[7],
        payload: JSON.parse(String(values[8])),
        createdAt: values[9]
      };
      this.eventRows.push(row);
      return {
        rows: [row],
        rowCount: 1
      } as { rows: T[]; rowCount: number };
    }
    if (sql.includes("UPDATE events SET room_id = $2 WHERE pane_id = $1")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO skills")) {
      const row = {
        id: values[0],
        displayName: values[1],
        version: values[2],
        status: "DISABLED",
        statusReason: "Operator proposal recorded; execution remains disabled until review and allowlists pass.",
        triggerDescription: values[3],
        body: values[4],
        allowedTools: JSON.parse(String(values[5])),
        contentHash: values[6],
        source: "OPERATOR_PROPOSAL",
        createdAt: values[7],
        updatedAt: values[7]
      };
      this.skillRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM skills")) {
      return { rows: this.skillRows as T[], rowCount: this.skillRows.length };
    }
    if (sql.includes("INSERT INTO workflows")) {
      this.workflowId = String(values[0]);
      const row = {
        workflowId: this.workflowId,
        runId: values[1],
        type: "AGENT_TURN",
        taskQueue: values[2],
        status: "PENDING",
        roomId: values[3],
        paneId: values[4],
        traceId: values[5],
        startedAt: values[6],
        closedAt: null
      };
      this.workflowRows.unshift(row);
      return {
        rows: [row as T],
        rowCount: 1
      } as { rows: T[]; rowCount: number };
    }
    if (sql.includes("UPDATE workflows SET room_id = $2 WHERE pane_id = $1")) {
      const paneId = values[0];
      this.workflowRows = this.workflowRows.map((row) =>
        row.paneId === paneId ? { ...row, roomId: values[1] } : row
      );
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE workflows")) {
      const workflowId = String(values[0]);
      const current = this.workflowRows.find((row) => row.workflowId === workflowId);
      if (!current) return { rows: [], rowCount: 0 };
      if (sql.includes("SET run_id = $2")) {
        const row = { ...current, runId: values[1] };
        this.workflowRows = [row, ...this.workflowRows.filter((item) => item.workflowId !== workflowId)];
        return { rows: [row as T], rowCount: 1 };
      }
      const row = { ...current, status: sql.includes("'FAILED'") ? "FAILED" : "COMPLETED", closedAt: values[1] };
      this.workflowRows = [row, ...this.workflowRows.filter((item) => item.workflowId !== workflowId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO turns")) {
      const row = {
        id: values[0],
        roomId: values[1],
        paneId: values[2],
        workflowId: values[3],
        providerId: values[4],
        modelId: values[5],
        status: "QUEUED",
        prompt: values[6],
        promptHash: values[7],
        artifactIds: [],
        createdAt: values[8],
        updatedAt: values[8]
      };
      this.turnRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE turns SET room_id = $2")) {
      const paneId = values[0];
      this.turnRows = this.turnRows.map((row) =>
        row.paneId === paneId ? { ...row, roomId: values[1], updatedAt: values[2] } : row
      );
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE turns")) {
      const turnId = String(values[0]);
      const current = this.turnRows.find((row) => (row as { id?: unknown }).id === turnId) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = { ...current, status: sql.includes("'FAILED'") ? "FAILED" : "COMPLETED", updatedAt: values[1] };
      const index = this.turnRows.findIndex((item) => (item as { id?: unknown }).id === turnId);
      this.turnRows.splice(index, 1, row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE panes SET status")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE rooms SET updated_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO audit_events")) {
      const row = {
        id: values[0],
        actorUserId: values[1],
        traceId: values[2],
        action: values[3],
        targetType: values[4],
        targetId: values[5],
        metadata: JSON.parse(String(values[6])),
        createdAt: values[7]
      };
      this.auditRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO provider_validation_checks")) {
      const row = {
        id: values[0],
        providerId: values[1],
        status: values[2],
        code: values[3],
        statusReason: values[4],
        maskedKeyPrefix: values[5],
        credentialLabel: values[6],
        modelCount: values[7],
        checkedAt: values[8]
      };
      this.providerValidationRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("SELECT DISTINCT ON (provider_id)") && sql.includes("FROM provider_validation_checks")) {
      const latest = new Map<string, unknown>();
      for (const row of this.providerValidationRows) {
        const providerId = String((row as { providerId?: unknown }).providerId);
        if (!latest.has(providerId)) latest.set(providerId, row);
      }
      return { rows: Array.from(latest.values()) as T[], rowCount: latest.size };
    }
    if (sql.includes("FROM providers")) {
      return { rows: this.providerRows as T[], rowCount: this.providerRows.length };
    }
    if (sql.includes("FROM provider_settings")) {
      return { rows: (this.providerSettingsRow ? [this.providerSettingsRow] : []) as T[], rowCount: this.providerSettingsRow ? 1 : 0 };
    }
    if (sql.includes("FROM codex_cli_mode_defaults")) {
      return {
        rows: (this.codexCliModeDefaultsRow ? [this.codexCliModeDefaultsRow] : []) as T[],
        rowCount: this.codexCliModeDefaultsRow ? 1 : 0
      };
    }
    if (sql.includes("INSERT INTO codex_cli_mode_defaults")) {
      if (!this.codexCliModeDefaultsRow || this.codexCliModeDefaultsRow.runtimeInitialized !== true) {
        this.codexCliModeDefaultsRow = {
          buildModelId: values[0],
          buildReasoningEffort: values[1],
          planModelId: values[2],
          planReasoningEffort: values[3],
          runtimeInitialized: true,
          updatedAt: values[4]
        };
      }
      return { rows: [this.codexCliModeDefaultsRow as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE codex_cli_mode_defaults")) {
      if (!this.codexCliModeDefaultsRow) return { rows: [], rowCount: 0 };
      const mode = String(values[0]);
      this.codexCliModeDefaultsRow = {
        ...this.codexCliModeDefaultsRow,
        ...(mode === "build"
          ? { buildModelId: values[1], buildReasoningEffort: values[2] }
          : { planModelId: values[1], planReasoningEffort: values[2] }),
        runtimeInitialized: true,
        updatedAt: values[3]
      };
      return { rows: [this.codexCliModeDefaultsRow as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO provider_settings")) {
      const row = {
        defaultProviderId: values[0],
        titleGenerationModelId: values[1],
        titleGenerationReasoningEffort: values[2],
        updatedAt: values[3]
      };
      this.providerSettingsRow = row;
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO providers")) {
      const isCreateProvider = sql.includes("VALUES ($1, $2, $3, 'DISABLED'");
      const row = isCreateProvider
        ? {
            id: values[0],
            displayName: values[1],
            type: values[2],
            status: "DISABLED",
            statusReason: values[3],
            maskedKeyPrefix: null,
            baseUrl: values[4],
            healthCheckedAt: null,
            routeProfile: values[5],
            backingProviderId: values[6],
            credentialRef: values[7],
            isBuiltIn: false
          }
        : {
            id: values[0],
            displayName: values[1],
            type: values[2],
            status: values[3],
            statusReason: values[4],
            maskedKeyPrefix: values[5],
            baseUrl: values[6],
            healthCheckedAt: values[7],
            routeProfile: values[8],
            backingProviderId: values[9],
            credentialRef: values[10],
            isBuiltIn: values[11]
          };
      this.providerRows = [row, ...this.providerRows.filter((item) => (item as { id?: unknown }).id !== values[0])];
      return { rows: sql.includes("RETURNING") ? [row as T] : [], rowCount: 1 };
    }
    if (sql.includes("UPDATE providers")) {
      const current = this.providerRows.find((row) => (row as { id?: unknown }).id === values[0]) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        displayName: values[1],
        type: values[2],
        status: "DISABLED",
        statusReason: values[3],
        maskedKeyPrefix: null,
        baseUrl: values[4],
        healthCheckedAt: null,
        routeProfile: values[5],
        backingProviderId: values[6],
        credentialRef: values[7],
        isBuiltIn: false
      };
      this.providerRows = [row, ...this.providerRows.filter((item) => (item as { id?: unknown }).id !== values[0])];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM models")) {
      const providerId = String(values[0]);
      this.modelRows = this.modelRows.filter((row) => (row as { providerId?: unknown }).providerId !== providerId);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO models")) {
      const row = {
        id: values[0],
        providerId: values[1],
        displayName: values[2],
        status: values[3],
        capabilities: JSON.parse(String(values[4]))
      };
      this.modelRows = [row, ...this.modelRows.filter((item) => (item as { id?: unknown }).id !== values[0])];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM models")) {
      return { rows: this.modelRows as T[], rowCount: this.modelRows.length };
    }
    if (sql.includes("INSERT INTO codex_app_server_handshake_checks")) {
      const row = {
        checkId: values[0],
        actorUserId: values[1],
        traceId: values[2],
        status: values[3],
        code: values[4],
        message: values[5],
        transport: values[6],
        schemasGenerated: values[7],
        schemaManifest: values[8] === null ? null : JSON.parse(String(values[8])),
        serverInfo: values[9] === null ? null : JSON.parse(String(values[9])),
        startedAt: values[10],
        finishedAt: values[11],
        durationMs: values[12],
        checkedAt: values[13]
      };
      this.codexHandshakeRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM codex_app_server_handshake_checks")) {
      return { rows: this.codexHandshakeRows as T[], rowCount: this.codexHandshakeRows.length };
    }
    if (sql.includes("INSERT INTO codex_app_server_turn_smoke_checks")) {
      const row = {
        checkId: values[0],
        actorUserId: values[1],
        traceId: values[2],
        status: values[3],
        code: values[4],
        message: values[5],
        transport: values[6],
        schemasGenerated: values[7],
        schemaManifest: values[8] === null ? null : JSON.parse(String(values[8])),
        model: values[9],
        threadId: values[10],
        turnId: values[11],
        turnStatus: values[12],
        notificationCount: values[13],
        completedNotificationSeen: values[14],
        startedAt: values[15],
        finishedAt: values[16],
        durationMs: values[17],
        checkedAt: values[18]
      };
      this.codexTurnSmokeRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM codex_app_server_turn_smoke_checks")) {
      return { rows: this.codexTurnSmokeRows as T[], rowCount: this.codexTurnSmokeRows.length };
    }
    if (sql.includes("INSERT INTO mcp_discovery_smoke_checks")) {
      const row = {
        checkId: values[0],
        actorUserId: values[1],
        traceId: values[2],
        status: values[3],
        code: values[4],
        message: values[5],
        targetSpecVersion: values[6],
        discoveryEnabled: values[7],
        serverCount: values[8],
        toolCount: values[9],
        startedAt: values[10],
        finishedAt: values[11],
        durationMs: values[12],
        checkedAt: values[13]
      };
      this.mcpDiscoverySmokeRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM mcp_discovery_smoke_checks")) {
      return { rows: this.mcpDiscoverySmokeRows as T[], rowCount: this.mcpDiscoverySmokeRows.length };
    }
    if (sql.includes("INSERT INTO memory_embedding_smoke_checks")) {
      const row = {
        checkId: values[0],
        actorUserId: values[1],
        traceId: values[2],
        status: values[3],
        code: values[4],
        message: values[5],
        smokeEnabled: values[6],
        provider: values[7],
        model: values[8],
        dimensions: values[9],
        pgvectorReady: values[10],
        embeddingProviderReady: values[11],
        startedAt: values[12],
        finishedAt: values[13],
        durationMs: values[14],
        checkedAt: values[15]
      };
      this.memoryEmbeddingSmokeRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM memory_embedding_smoke_checks")) {
      return { rows: this.memoryEmbeddingSmokeRows as T[], rowCount: this.memoryEmbeddingSmokeRows.length };
    }
    if (sql.includes("INSERT INTO mcp_servers")) {
      const row = {
        id: values[0],
        displayName: values[1],
        transport: values[2],
        status: values[3],
        statusReason: values[4],
        schemaVersion: values[5],
        configHash: values[6],
        toolCount: values[7],
        lastDiscoveredAt: values[8]
      };
      this.mcpServerRows = [row, ...this.mcpServerRows.filter((item) => (item as { id?: unknown }).id !== values[0])];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM mcp_servers")) {
      return { rows: this.mcpServerRows as T[], rowCount: this.mcpServerRows.length };
    }
    if (sql.includes("INSERT INTO mcp_tools")) {
      const row = {
        id: values[0],
        serverId: values[1],
        name: values[2],
        riskLevel: values[3],
        schemaHash: values[4],
        approvalRequired: values[5],
        status: values[6],
        statusReason: values[7]
      };
      this.mcpToolRows = [row, ...this.mcpToolRows.filter((item) => (item as { id?: unknown }).id !== values[0])];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM mcp_tools")) {
      return { rows: this.mcpToolRows as T[], rowCount: this.mcpToolRows.length };
    }
    if (sql.includes("INSERT INTO memory_records")) {
      const row = {
        id: values[0],
        scope: values[1],
        roomId: values[2],
        title: values[3],
        body: values[4],
        provenance: values[5],
        memoryRecordId: values[0],
        canonicalMemoryId: null,
        linkSource: null,
        linkedAt: null,
        createdAt: values[7] ?? values[6]
      };
      this.memoryRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE memory_records") && sql.includes("canonical_memory_id")) {
      const row = this.memoryRows.find((item) => (item as { id?: unknown }).id === values[0]) as Record<string, unknown> | undefined;
      if (!row || row.canonicalMemoryId) return { rows: [], rowCount: 0 };
      row.canonicalMemoryId = values[1];
      row.linkSource = values[2];
      row.linkedAt = values[3];
      return { rows: [{
        memoryRecordId: row.memoryRecordId,
        canonicalMemoryId: row.canonicalMemoryId,
        linkSource: row.linkSource,
        linkedAt: row.linkedAt
      } as T], rowCount: 1 };
    }
    if (sql.includes("FROM memory_records") && sql.includes("canonical_memory_id")) {
      if (sql.includes("ORDER BY canonical_linked_at")) {
        const selectedIds = Array.isArray(values[0]) ? new Set(values[0]) : null;
        const limit = Number(values.at(-1) ?? 500);
        const rows = this.memoryRows
          .filter((item) => {
            const row = item as { memoryRecordId?: unknown; canonicalMemoryId?: unknown };
            return Boolean(row.canonicalMemoryId) && (!selectedIds || selectedIds.has(row.memoryRecordId));
          })
          .slice(0, limit)
          .map((item) => {
            const row = item as Record<string, unknown>;
            return {
              memoryRecordId: row.memoryRecordId,
              canonicalMemoryId: row.canonicalMemoryId,
              linkSource: row.linkSource,
              linkedAt: row.linkedAt
            };
          });
        return { rows: rows as T[], rowCount: rows.length };
      }
      const row = this.memoryRows.find((item) => (item as { id?: unknown }).id === values[0]) as Record<string, unknown> | undefined;
      const included = row && (!sql.includes("canonical_memory_id IS NOT NULL") || row.canonicalMemoryId);
      return {
        rows: included ? [{
          memoryRecordId: row.memoryRecordId,
          canonicalMemoryId: row.canonicalMemoryId,
          linkSource: row.linkSource,
          linkedAt: row.linkedAt
        } as T] : [],
        rowCount: included ? 1 : 0
      };
    }
    if (sql.includes("INSERT INTO import_candidates")) {
      const row = {
        id: values[0],
        sourceKind: values[1],
        targetKind: values[2],
        status: "PENDING",
        statusReason: values[3],
        sourceRef: values[4],
        roomId: values[5],
        memoryScope: values[6],
        title: values[7],
        body: values[8],
        provenance: values[9],
        skillVersion: values[10],
        skillTriggerDescription: values[11],
        allowedTools: JSON.parse(String(values[12])),
        importedMemoryId: null,
        importedSkillId: null,
        createdAt: values[13],
        decidedAt: null
      };
      this.importCandidateRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE import_candidates")) {
      const candidateId = String(values[0]);
      const current = this.importCandidateRows.find((row) => (row as { id?: unknown }).id === candidateId) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        status: values[1],
        statusReason: values[2],
        importedMemoryId: values[3],
        importedSkillId: values[4],
        decidedAt: values[5]
      };
      this.importCandidateRows = [row, ...this.importCandidateRows.filter((item) => (item as { id?: unknown }).id !== candidateId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM import_candidates")) {
      const id = values.find((value) => typeof value === "string" && String(value).startsWith("import:"));
      const status = values.find((value) => value === "PENDING" || value === "IMPORTED" || value === "REJECTED");
      const targetKind = values.find((value) => value === "MEMORY" || value === "SKILL");
      const rows = this.importCandidateRows.filter((row) => {
        const item = row as { id?: unknown; status?: unknown; targetKind?: unknown };
        if (id && item.id !== id) return false;
        if (status && item.status !== status) return false;
        if (targetKind && item.targetKind !== targetKind) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM memory_records")) {
      const scope = values.find((value) => value === "ROOM" || value === "PROJECT" || value === "SYSTEM");
      const search = values.find((value) => typeof value === "string" && String(value).startsWith("%"));
      const rows = this.memoryRows.filter((row) => {
        const item = row as { scope?: unknown; title?: unknown; body?: unknown; provenance?: unknown };
        if (scope && item.scope !== scope) return false;
        if (search) {
          const needle = String(search).replaceAll("%", "").toLowerCase();
          return `${item.title ?? ""}\n${item.body ?? ""}\n${item.provenance ?? ""}`.toLowerCase().includes(needle);
        }
        return true;
      });
      const limit = sql.includes("LIMIT") ? Number(values.at(-1)) : rows.length;
      return { rows: rows.slice(0, limit) as T[], rowCount: Math.min(rows.length, limit) };
    }
    if (sql.includes("INSERT INTO memory_graph_issue_states")) {
      const row = {
        issueId: values[0],
        issueType: values[1],
        recordId: values[2],
        sourceHash: values[3],
        status: values[4],
        reason: values[5],
        actorUserId: values[6],
        version: 1,
        createdAt: values[7],
        updatedAt: values[7]
      };
      this.memoryIssueStateRows.push(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE memory_graph_issue_states")) {
      const row = this.memoryIssueStateRows.find((item) => (item as { issueId?: unknown }).issueId === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!row || row.version !== values[8]) return { rows: [], rowCount: 0 };
      row.issueType = values[1];
      row.recordId = values[2];
      row.sourceHash = values[3];
      row.status = values[4];
      row.reason = values[5];
      row.actorUserId = values[6];
      row.version = Number(row.version) + 1;
      row.updatedAt = values[7];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM memory_graph_issue_states")) {
      const issueId = sql.includes("issue_id = $1") ? values[0] : undefined;
      const issueIds = sql.includes("issue_id = ANY")
        ? values.find((value) => Array.isArray(value)) as unknown[] | undefined
        : undefined;
      const status = values.find((value) => ["OPEN", "IGNORED", "RESOLVED"].includes(String(value)));
      const rows = this.memoryIssueStateRows.filter((item) => {
        const row = item as { issueId?: unknown; status?: unknown; recordId?: unknown };
        if (issueId && row.issueId !== issueId) return false;
        if (issueIds && !issueIds.includes(row.issueId)) return false;
        if (status && row.status !== status) return false;
        if (sql.includes("record_id =") && !values.includes(row.recordId)) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO memory_consolidation_runs")) {
      const existing = this.memoryConsolidationRunRows.find((item) =>
        (item as { dedupeKey?: unknown }).dedupeKey === values[4]
      );
      if (existing) return { rows: [existing as T], rowCount: 1 };
      const row = {
        id: values[0], mode: values[1], triggerKind: values[2], status: "QUEUED",
        workflowId: values[3], dedupeKey: values[4], sourceHash: values[5], actorUserId: values[6],
        progressCompleted: 0, progressTotal: 0, findingCount: 0, appliedOperationCount: 0,
        skippedOperationCount: 0, failedOperationCount: 0, metrics: {}, modelId: null,
        aiVerified: false, aiEvidence: {}, statusReason: null, createdAt: values[7],
        startedAt: null, completedAt: null, updatedAt: values[7]
      };
      this.memoryConsolidationRunRows.push(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE memory_consolidation_runs")) {
      const row = this.memoryConsolidationRunRows.find((item) => (item as { id?: unknown }).id === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, {
        status: values[1], sourceHash: values[2], progressCompleted: values[3], progressTotal: values[4],
        findingCount: values[5], appliedOperationCount: values[6], skippedOperationCount: values[7],
        failedOperationCount: values[8], metrics: JSON.parse(String(values[9])), modelId: values[10],
        aiVerified: values[11], aiEvidence: JSON.parse(String(values[12])), statusReason: values[13],
        startedAt: values[14], completedAt: values[15], updatedAt: values[16]
      });
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM memory_consolidation_runs")) {
      const rows = this.memoryConsolidationRunRows.filter((item) => {
        const row = item as { id?: unknown; workflowId?: unknown; dedupeKey?: unknown };
        if (sql.includes("dedupe_key = $1 OR workflow_id = $2")) return row.dedupeKey === values[0] || row.workflowId === values[1];
        if (sql.includes("WHERE id = $1")) return row.id === values[0];
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO memory_consolidation_findings")) {
      const row = {
        id: values[0], runId: values[1], issueId: values[2], findingType: values[3], severity: values[4],
        status: "OPEN", confidence: values[5], recordIds: JSON.parse(String(values[6])), sourcePath: values[7],
        evidence: values[8], createdAt: values[9], updatedAt: values[9]
      };
      this.memoryConsolidationFindingRows.push(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE memory_consolidation_findings")) {
      const row = this.memoryConsolidationFindingRows.find((item) => (item as { id?: unknown }).id === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!row) return { rows: [], rowCount: 0 };
      row.status = values[1];
      row.updatedAt = values[2];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM memory_consolidation_findings")) {
      const rows = this.memoryConsolidationFindingRows.filter((item) => {
        const row = item as { id?: unknown; runId?: unknown; issueId?: unknown };
        if (sql.includes("WHERE id = $1") && row.id !== values[0]) return false;
        if (sql.includes("run_id = $1") && !sql.includes("WHERE id = $1") && row.runId !== values[0]) return false;
        if (sql.includes("run_id = $2") && row.runId !== values[1]) return false;
        if (sql.includes("issue_id = $2") && row.issueId !== values[1]) return false;
        return true;
      });
      const limitedRows = sql.includes("LIMIT $2") ? rows.slice(0, Number(values[1])) : rows;
      return { rows: limitedRows as T[], rowCount: limitedRows.length };
    }
    if (sql.includes("INSERT INTO memory_consolidation_operations")) {
      const row = {
        id: values[0], runId: values[1], findingId: values[2], operationKind: values[3], status: "PROPOSED",
        recordIds: JSON.parse(String(values[4])), changeSetId: null, reason: values[5], statusReason: null,
        createdAt: values[6], updatedAt: values[6], appliedAt: null
      };
      this.memoryConsolidationOperationRows.push(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE memory_consolidation_operations")) {
      const row = this.memoryConsolidationOperationRows.find((item) => (item as { id?: unknown }).id === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!row) return { rows: [], rowCount: 0 };
      row.status = values[1];
      row.changeSetId = values[2];
      row.statusReason = values[3];
      row.updatedAt = values[4];
      if (values[1] === "APPLIED") row.appliedAt = values[4];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM memory_consolidation_operations")) {
      const rows = this.memoryConsolidationOperationRows.filter((item) => {
        const row = item as { id?: unknown; runId?: unknown };
        if (sql.includes("WHERE id = $1") && row.id !== values[0]) return false;
        if (sql.includes("run_id = $1") && !sql.includes("WHERE id = $1") && row.runId !== values[0]) return false;
        return true;
      });
      const limitedRows = sql.includes("LIMIT $2") ? rows.slice(0, Number(values[1])) : rows;
      return { rows: limitedRows as T[], rowCount: limitedRows.length };
    }
    if (sql.includes("INSERT INTO memory_command_idempotency")) {
      const existing = this.memoryCommandIdempotencyRows.find((item) => {
        const row = item as { commandScope?: unknown; actorKey?: unknown; idempotencyKeyHash?: unknown };
        return row.commandScope === values[0] && row.actorKey === values[1] && row.idempotencyKeyHash === values[2];
      }) as Record<string, unknown> | undefined;
      if (existing) return { rows: [{ ...existing, created: false } as T], rowCount: 1 };
      const row = {
        commandScope: values[0], actorKey: values[1], idempotencyKeyHash: values[2], requestHash: values[3],
        resourceType: values[4], resourceId: values[5], workflowId: values[6], createdAt: values[7]
      };
      this.memoryCommandIdempotencyRows.push(row);
      return { rows: [{ ...row, created: true } as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO memory_graph_change_sets")) {
      const row = {
        id: values[0],
        kind: values[1],
        status: "PROPOSED",
        sourcePath: values[2],
        recordIds: JSON.parse(String(values[3])),
        resolvesIssueIds: JSON.parse(String(values[4])),
        expectedSourceHash: values[5],
        resultingSourceHash: null,
        beforeContentHash: values[6],
        afterContentHash: values[7],
        beforeSnapshot: values[8],
        afterSnapshot: values[9],
        reason: values[10],
        statusReason: null,
        actorUserId: values[11],
        traceId: values[12],
        rollbackOfChangeSetId: values[13],
        rolledBackByChangeSetId: null,
        createdAt: values[14],
        updatedAt: values[14],
        appliedAt: null,
        failedAt: null,
        rolledBackAt: null
      };
      this.memoryChangeSetRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE memory_graph_change_sets") && sql.includes("SET status = 'ROLLED_BACK'")) {
      const current = this.memoryChangeSetRows.find((row) => (row as { id?: unknown }).id === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      current.status = "ROLLED_BACK";
      current.rolledBackByChangeSetId = values[1];
      current.rolledBackAt = values[2];
      current.updatedAt = values[2];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE memory_graph_change_sets")) {
      const current = this.memoryChangeSetRows.find((row) => (row as { id?: unknown }).id === values[0]) as
        | Record<string, unknown>
        | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      current.status = values[1];
      current.resultingSourceHash = values[2] ?? current.resultingSourceHash;
      current.statusReason = values[3] ?? current.statusReason;
      current.updatedAt = values[4];
      if (values[1] === "APPLIED") current.appliedAt = values[4];
      if (values[1] === "FAILED") current.failedAt = values[4];
      return { rows: [current as T], rowCount: 1 };
    }
    if (sql.includes("FROM memory_graph_change_sets")) {
      const id = sql.includes("WHERE id = $1") ? values[0] : undefined;
      const kind = values.find((value) => ["EDIT", "MERGE", "ARCHIVE", "ROLLBACK"].includes(String(value)));
      const status = values.find((value) =>
        ["PROPOSED", "APPROVED", "APPLYING", "APPLIED", "FAILED", "ROLLED_BACK", "REJECTED"].includes(String(value))
      );
      const rows = this.memoryChangeSetRows.filter((row) => {
        const item = row as {
          id?: unknown;
          kind?: unknown;
          status?: unknown;
          sourcePath?: unknown;
          recordIds?: unknown[];
          resolvesIssueIds?: unknown[];
          rollbackOfChangeSetId?: unknown;
        };
        if (id && item.id !== id) return false;
        if (kind && item.kind !== kind) return false;
        if (status && item.status !== status) return false;
        if (sql.includes("source_path =") && !values.includes(item.sourcePath)) return false;
        if (sql.includes("record_ids ?") && !item.recordIds?.some((recordId) => values.includes(recordId))) return false;
        if (sql.includes("resolves_issue_ids ?") && !item.resolvesIssueIds?.some((issueId) => values.includes(issueId))) return false;
        if (sql.includes("rollback_of_change_set_id =") && !values.includes(item.rollbackOfChangeSetId)) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO artifacts")) {
      const row = {
        id: values[0],
        roomId: values[1],
        paneId: values[2],
        turnId: values[3],
        workflowId: values[4],
        kind: values[5],
        mimeType: values[6],
        storageUri: values[7],
        sha256: values[8],
        byteSize: values[9],
        metadata: JSON.parse(String(values[10])),
        expiresAt: values[11],
        pinnedAt: values[12],
        deletedAt: values[13],
        createdAt: values[14]
      };
      this.artifactRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE artifacts SET room_id = $2 WHERE pane_id = $1")) {
      const paneId = values[0];
      this.artifactRows = this.artifactRows.map((row) => {
        const item = row as Record<string, unknown>;
        return item.paneId === paneId ? { ...item, roomId: values[1] } : row;
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM artifacts")) {
      const artifactId = String(values[0]);
      const before = this.artifactRows.length;
      this.artifactRows = this.artifactRows.filter((row) => (row as { id?: unknown }).id !== artifactId);
      return { rows: [], rowCount: before - this.artifactRows.length };
    }
    if (sql.includes("FROM artifacts") && !sql.includes("FROM turns")) {
      const artifactId = values.find((value) => typeof value === "string" && String(value).startsWith("artifact:"));
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const kind = values.find((value) => typeof value === "string" && value === String(value).toUpperCase());
      const rows = this.artifactRows.filter((row) => {
        const item = row as { id?: unknown; roomId?: unknown; kind?: unknown };
        if (artifactId && item.id !== artifactId) return false;
        if (roomId && item.roomId !== roomId) return false;
        if (kind && item.kind !== kind) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO review_decisions")) {
      const row = {
        id: values[0],
        roomId: values[1],
        workflowId: values[2],
        decision: values[3],
        summary: values[4],
        evidenceArtifactIds: JSON.parse(String(values[5])),
        rollbackNote: values[6],
        createdAt: values[7]
      };
      this.reviewRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM review_decisions")) {
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const rows = roomId
        ? this.reviewRows.filter((row) => (row as { roomId?: unknown }).roomId === roomId)
        : this.reviewRows;
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO review_checks")) {
      const row = {
        id: values[0],
        roomId: values[1],
        reviewDecisionId: values[2],
        name: values[3],
        status: values[4],
        command: values[5],
        summary: values[6],
        artifactIds: JSON.parse(String(values[7])),
        metadata: JSON.parse(String(values[8])),
        createdAt: values[9]
      };
      this.reviewCheckRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM review_checks")) {
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const status = values.find((value) => ["PASS", "WARN", "FAIL", "SKIPPED", "RUNNING"].includes(String(value)));
      const rows = this.reviewCheckRows.filter((row) => {
        const item = row as { roomId?: unknown; status?: unknown };
        if (roomId && item.roomId !== roomId) return false;
        if (status && item.status !== status) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO review_diff_summaries")) {
      const row = {
        id: values[0],
        roomId: values[1],
        reviewDecisionId: values[2],
        title: values[3],
        filePath: values[4],
        status: values[5],
        additions: values[6],
        deletions: values[7],
        patchArtifactId: values[8],
        summary: values[9],
        createdAt: values[10]
      };
      this.reviewDiffRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM review_diff_summaries")) {
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const status = values.find((value) => ["ADDED", "MODIFIED", "DELETED", "RENAMED"].includes(String(value)));
      const rows = this.reviewDiffRows.filter((row) => {
        const item = row as { roomId?: unknown; status?: unknown };
        if (roomId && item.roomId !== roomId) return false;
        if (status && item.status !== status) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO swarm_tasks")) {
      const row = {
        id: values[0],
        roomId: values[1],
        parentTaskId: values[2],
        role: values[3],
        title: values[4],
        goal: values[5],
        status: "PLANNED",
        assignee: values[6],
        dependsOnTaskIds: JSON.parse(String(values[7])),
        lockIds: [],
        resultSummary: null,
        createdAt: values[8],
        updatedAt: values[8],
        completedAt: null
      };
      this.swarmTaskRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE swarm_tasks")) {
      const taskId = String(values[0]);
      const current = this.swarmTaskRows.find((row) => (row as { id?: unknown }).id === taskId) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = {
        ...current,
        status: values[1],
        assignee: values[2],
        dependsOnTaskIds: JSON.parse(String(values[3])),
        lockIds: JSON.parse(String(values[4])),
        resultSummary: values[5],
        updatedAt: values[6],
        completedAt: values[7]
      };
      this.swarmTaskRows = [row, ...this.swarmTaskRows.filter((item) => (item as { id?: unknown }).id !== taskId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM swarm_tasks")) {
      const id = values.find((value) => typeof value === "string" && String(value).startsWith("swarm_task:"));
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const status = values.find((value) => ["PLANNED", "READY", "RUNNING", "BLOCKED", "DONE", "CANCELLED"].includes(String(value)));
      const role = values.find((value) => ["PLANNER", "WORKER", "REVIEWER"].includes(String(value)));
      const rows = this.swarmTaskRows.filter((row) => {
        const item = row as { id?: unknown; roomId?: unknown; status?: unknown; role?: unknown };
        if (id && item.id !== id) return false;
        if (roomId && item.roomId !== roomId) return false;
        if (status && item.status !== status) return false;
        if (role && item.role !== role) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO swarm_locks")) {
      const row = {
        id: values[0],
        roomId: values[1],
        taskId: values[2],
        resource: values[3],
        status: "ACTIVE",
        holder: values[4],
        reason: values[5],
        createdAt: values[6],
        releasedAt: null
      };
      this.swarmLockRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE swarm_locks")) {
      const lockId = String(values[0]);
      const current = this.swarmLockRows.find((row) => (row as { id?: unknown }).id === lockId) as Record<string, unknown> | undefined;
      if (!current) return { rows: [], rowCount: 0 };
      const row = { ...current, status: "RELEASED", releasedAt: values[1] };
      this.swarmLockRows = [row, ...this.swarmLockRows.filter((item) => (item as { id?: unknown }).id !== lockId)];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM swarm_locks")) {
      const id = values.find((value) => typeof value === "string" && String(value).startsWith("swarm_lock:"));
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const resource = values.find((value) => value === "/opt/spaceapp");
      const rows = this.swarmLockRows.filter((row) => {
        const item = row as { id?: unknown; roomId?: unknown; resource?: unknown; status?: unknown };
        if (id && item.id !== id) return false;
        if (roomId && item.roomId !== roomId) return false;
        if (resource && item.resource !== resource) return false;
        if (sql.includes("status = 'ACTIVE'") && item.status !== "ACTIVE") return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO swarm_messages")) {
      const row = {
        id: values[0],
        roomId: values[1],
        taskId: values[2],
        fromRole: values[3],
        toRole: values[4],
        body: values[5],
        createdAt: values[6]
      };
      this.swarmMessageRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM swarm_messages")) {
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const rows = roomId
        ? this.swarmMessageRows.filter((row) => (row as { roomId?: unknown }).roomId === roomId)
        : this.swarmMessageRows;
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO swarm_reconciles")) {
      const row = {
        id: values[0],
        roomId: values[1],
        taskIds: JSON.parse(String(values[2])),
        decision: values[3],
        summary: values[4],
        nextSteps: values[5],
        createdAt: values[6]
      };
      this.swarmReconcileRows.unshift(row);
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM swarm_reconciles")) {
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const rows = roomId
        ? this.swarmReconcileRows.filter((row) => (row as { roomId?: unknown }).roomId === roomId)
        : this.swarmReconcileRows;
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM space_agent_sessions")) {
      const sessionId = values.find((value) => typeof value === "string" && String(value).startsWith("agent_session:"));
      const paneId = values.find((value) => typeof value === "string" && String(value).startsWith("pane:"));
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const activeOnly = sql.includes("is_active = true");
      const rows = this.spaceAgentSessionRows
        .filter((row) => {
          const item = row as { sessionId?: unknown; paneId?: unknown; roomId?: unknown; isActive?: unknown };
          if (sessionId && item.sessionId !== sessionId) return false;
          if (paneId && item.paneId !== paneId) return false;
          if (roomId && item.roomId !== roomId) return false;
          if (activeOnly && item.isActive !== true) return false;
          return true;
        })
        .map((row) => ({
          ...(row as Record<string, unknown>),
          paneTitle: "Existing pane",
          paneIsClosed: false
        }));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("SELECT count(*) AS count FROM space_agent_messages")) {
      const sessionId = String(values[0]);
      const count = this.spaceAgentMessageRows.filter(
        (row) => (row as { sessionId?: unknown }).sessionId === sessionId
      ).length;
      return { rows: [{ count: String(count) } as T], rowCount: 1 };
    }
    if (sql.includes("FROM space_agent_messages")) {
      const messageId = values.find((value) => typeof value === "string" && String(value).startsWith("agent_msg:"));
      const sessionId = values.find((value) => typeof value === "string" && String(value).startsWith("agent_session:"));
      const limit = typeof values[1] === "number" ? Number(values[1]) : null;
      const matchingRows = this.spaceAgentMessageRows.filter((row) => {
        const item = row as { messageId?: unknown; sessionId?: unknown };
        if (messageId && item.messageId !== messageId) return false;
        if (sessionId && item.sessionId !== sessionId) return false;
        return true;
      });
      if (sql.includes("ORDER BY") && sql.includes("CASE role")) {
        matchingRows.sort((a, b) => {
          const rowA = a as { createdAt?: string; role?: string; messageId?: string };
          const rowB = b as { createdAt?: string; role?: string; messageId?: string };
          const timeA = rowA.createdAt ? Date.parse(rowA.createdAt) : 0;
          const timeB = rowB.createdAt ? Date.parse(rowB.createdAt) : 0;
          if (timeA !== timeB) return timeA - timeB;
          const roleRank = (role?: string) => (role === "user" ? 1 : role === "assistant" ? 2 : 3);
          const diff = roleRank(rowA.role) - roleRank(rowB.role);
          if (diff !== 0) return diff;
          return String(rowA.messageId ?? "").localeCompare(String(rowB.messageId ?? ""));
        });
      }
      const rows = sql.includes("LIMIT COALESCE") && limit !== null ? matchingRows.slice(0, limit) : matchingRows;
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM space_agent_runs")) {
      const runId = values.find((value) => typeof value === "string" && String(value).startsWith("agent_run:"));
      const sessionId = values.find((value) => typeof value === "string" && String(value).startsWith("agent_session:"));
      const workflowId = values.find((value) => typeof value === "string" && String(value).startsWith("workflow:"));
      const rows = this.spaceAgentRunRows.filter((row) => {
        const item = row as { runId?: unknown; sessionId?: unknown; workflowId?: unknown };
        if (runId && item.runId !== runId) return false;
        if (sessionId && item.sessionId !== sessionId) return false;
        if (workflowId && item.workflowId !== workflowId) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM pane_browser_sessions")) {
      const sessionId = values.find((value) => typeof value === "string" && String(value).startsWith("browser_session:"));
      const paneId = values.find((value) => typeof value === "string" && String(value).startsWith("pane:"));
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const activeOnly = sql.includes("is_active = true");
      const rows = this.paneBrowserSessionRows.filter((row) => {
        const item = row as { sessionId?: unknown; paneId?: unknown; roomId?: unknown; isActive?: unknown };
        if (sessionId && item.sessionId !== sessionId) return false;
        if (paneId && item.paneId !== paneId) return false;
        if (roomId && item.roomId !== roomId) return false;
        if (activeOnly && item.isActive !== true) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM browser_capture_segments")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM browser_handoff_requests") || sql.includes("UPDATE browser_handoff_requests")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("pane_cli_sessions") && sql.includes("first_input")) {
      const query = String(values[0] ?? "").toLowerCase();
      const allowedRuntimeIds = Array.isArray(values[1]) ? new Set(values[1].map(String)) : null;
      const taskRows = this.cliTaskRows.flatMap((task) => {
        if (task.historyHiddenAt) return [];
        const revision = this.cliTaskRevisionRows.find((row) => row.revisionId === task.currentRevisionId);
        if (!revision || (allowedRuntimeIds && !allowedRuntimeIds.has(String(revision.runtimeId)))) return [];
        const session = this.paneCliSessionRows.find(
          (row) => (row as Record<string, unknown>).sessionId === revision.latestSpaceSessionId
        ) as Record<string, unknown> | undefined;
        if (!session || session.purpose !== "NORMAL") return [];
        const pane = this.paneRows.find((row) => (row as { id?: unknown }).id === session.paneId) as
          | Record<string, unknown>
          | undefined;
        const chunks = this.paneCliTranscriptRows
          .filter((row) => (row as { sessionId?: unknown }).sessionId === session.sessionId)
          .map((row) => row as Record<string, unknown>);
        const firstInput = chunks
          .filter((row) => row.stream === "stdin" && String(row.content ?? "").trim().length > 0)
          .sort((left, right) => Number(left.sequence) - Number(right.sequence))[0];
        if (!pane || !firstInput) return [];
        const latestOutput = chunks
          .filter((row) => ["stdout", "stderr"].includes(String(row.stream)) && String(row.content ?? "").trim().length > 0)
          .sort((left, right) => Number(right.sequence) - Number(left.sequence))[0];
        const latestChunk = [...chunks].sort((left, right) => Number(right.sequence) - Number(left.sequence))[0];
        const searchable = `${pane.title ?? ""}\n${firstInput.content ?? ""}\n${latestOutput?.content ?? ""}`.toLowerCase();
        if (query && !searchable.includes(query)) return [];
        return [{
          taskId: task.taskId,
          revisionId: revision.revisionId,
          revisionRuntimeId: revision.runtimeId,
          revisionProviderId: revision.providerId,
          revisionAgentId: revision.agentId,
          nativeTaskRef: revision.nativeTaskRef,
          sourceRevisionId: revision.sourceRevisionId,
          latestSpaceSessionId: revision.latestSpaceSessionId,
          displayTitle: revision.displayTitle,
          revisionFirstUserMessage: revision.firstUserMessage,
          revisionPreview: revision.preview,
          revisionCwd: revision.cwd,
          revisionModelId: revision.modelId,
          revisionReasoningEffort: revision.reasoningEffort,
          revisionCreatedAt: revision.createdAt,
          revisionUpdatedAt: revision.updatedAt,
          ...session,
          paneTitle: pane.title,
          firstUserMessage: firstInput.content,
          preview: latestOutput?.content ?? firstInput.content,
          recencyAt: latestChunk?.createdAt ?? session.updatedAt
        }];
      }).sort((left, right) => {
        const recency = String(right.recencyAt ?? "").localeCompare(String(left.recencyAt ?? ""));
        return recency || String(right.sessionId ?? "").localeCompare(String(left.sessionId ?? ""));
      });
      if (sql.includes("SELECT count(*) AS total")) {
        return { rows: [{ total: taskRows.length } as T], rowCount: 1 };
      }
      const limit = Number(values[2]);
      const offset = Number(values[3]);
      const rows = taskRows.slice(offset, offset + limit).map((row) => ({ ...row, total: taskRows.length }));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM pane_cli_sessions")) {
      const sessionId = values.find((value) => typeof value === "string" && String(value).startsWith("cli_session:"));
      const paneId = values.find((value) => typeof value === "string" && String(value).startsWith("pane:"));
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const codexThreadId = values.find(
        (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))
      );
      const excludeSessionId = sql.includes("session_id <>") ? sessionId : null;
      const activeOnly = sql.includes("is_active = true");
      const rows = this.paneCliSessionRows.filter((row) => {
        const item = row as { sessionId?: unknown; paneId?: unknown; roomId?: unknown; isActive?: unknown; codexThreadId?: unknown };
        if (excludeSessionId ? item.sessionId === excludeSessionId : sessionId && item.sessionId !== sessionId) return false;
        if (paneId && item.paneId !== paneId) return false;
        if (roomId && item.roomId !== roomId) return false;
        if (codexThreadId && item.codexThreadId !== codexThreadId) return false;
        if (activeOnly && item.isActive !== true) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM pane_cli_codex_thread_ownerships")) {
      const rows = this.paneCliCodexThreadOwnershipRows.filter((row) => {
        const item = row as { threadId?: unknown; cliSessionId?: unknown };
        if (values[0] && item.threadId !== values[0]) return false;
        return true;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes('SELECT coalesce(max(sequence), -1) + 1 AS "nextSequence" FROM pane_cli_transcript_chunks')) {
      const sessionId = values[0];
      const nextSequence = this.paneCliTranscriptRows
        .filter((row) => (row as { sessionId?: unknown }).sessionId === sessionId)
        .reduce((maximum, row) => Math.max(maximum, Number((row as { sequence?: unknown }).sequence)), -1) + 1;
      return { rows: [{ nextSequence } as T], rowCount: 1 };
    }
    if (sql.includes("FROM pane_cli_transcript_chunks")) {
      const sessionId = values.find((value) => typeof value === "string" && String(value).startsWith("cli_session:"));
      const limit = Number(values.find((value) => typeof value === "number") ?? 200);
      const rows = this.paneCliTranscriptRows
        .filter((row) => !sessionId || (row as { sessionId?: unknown }).sessionId === sessionId)
        .sort((left, right) => Number((left as { sequence?: unknown }).sequence) - Number((right as { sequence?: unknown }).sequence))
        .slice(-limit);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM pane_agent_sessions")) {
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:")) ?? this.roomId;
      const sessionKeys = new Set(
        this.agentPaneSessionRows.map((row) => `${(row as { paneId?: unknown }).paneId}:${(row as { coderChatId?: unknown }).coderChatId}`)
      );
      const legacyRows = this.agentPaneBindingRows
        .filter((row) => (row as { coderChatId?: unknown }).coderChatId)
        .filter((row) => !sessionKeys.has(`${(row as { paneId?: unknown }).paneId}:${(row as { coderChatId?: unknown }).coderChatId}`))
        .map((row) => ({ ...(row as Record<string, unknown>), roomId }));
      const rows = [...this.agentPaneSessionRows, ...legacyRows]
        .filter((row) => (row as { roomId?: unknown }).roomId === roomId)
        .map((row) => ({
          ...(row as Record<string, unknown>),
          paneTitle: "Existing pane",
          paneIsClosed: false
        }));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM pane_agent_bindings") && sql.includes("JOIN panes")) {
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:")) ?? this.roomId;
      const rows = this.agentPaneBindingRows
        .filter((row) => (row as { coderChatId?: unknown }).coderChatId)
        .map((row) => ({
          ...(row as Record<string, unknown>),
          roomId,
          paneTitle: "Existing pane",
          paneIsClosed: false
        }));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM pane_agent_bindings")) {
      const paneId = values.find((value) => typeof value === "string" && String(value).startsWith("pane:"));
      const rows = this.agentPaneBindingRows.filter((row) => {
        const item = row as { paneId?: unknown };
        return !paneId || item.paneId === paneId;
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM provider_validation_checks")) {
      const providerId = String(values[0]);
      const rows = this.providerValidationRows.filter((row) => (row as { providerId?: unknown }).providerId === providerId);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM audit_events")) {
      return { rows: this.auditRows as T[], rowCount: this.auditRows.length };
    }
    if (sql.includes("FROM events")) {
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      if (sql.includes("SELECT count(*) AS count")) {
        const count = this.eventRows.filter((row) => !roomId || (row as { roomId?: unknown }).roomId === roomId).length;
        return { rows: [{ count: String(count) } as T], rowCount: 1 };
      }
      const relaySequenceOrder = sql.includes("ORDER BY relay_sequence");
      const descending = relaySequenceOrder
        ? sql.includes("ORDER BY relay_sequence DESC")
        : sql.includes("created_at DESC");
      const valueForPlaceholder = (match: RegExpMatchArray | null, index = 1): unknown => {
        const placeholder = match?.[index];
        return placeholder ? values[Number(placeholder) - 1] : undefined;
      };
      const since = valueForPlaceholder(sql.match(/created_at >= \$(\d+)::timestamptz/));
      const afterSequence = valueForPlaceholder(sql.match(/relay_sequence > \$(\d+)::bigint/));
      const afterMatch = sql.match(/\(created_at, id\) > \(\$(\d+)::timestamptz, \$(\d+)\)/);
      const throughMatch = sql.match(/\(created_at, id\) <= \(\$(\d+)::timestamptz, \$(\d+)\)/);
      const after = afterMatch
        ? { createdAt: String(valueForPlaceholder(afterMatch, 1)), id: String(valueForPlaceholder(afterMatch, 2)) }
        : null;
      const through = throughMatch
        ? { createdAt: String(valueForPlaceholder(throughMatch, 1)), id: String(valueForPlaceholder(throughMatch, 2)) }
        : null;
      const limit = Number(valueForPlaceholder(sql.match(/LIMIT \$(\d+)/)) ?? this.eventRows.length);
      const offset = Number(valueForPlaceholder(sql.match(/OFFSET \$(\d+)/)) ?? 0);
      const rows = this.eventRows
        .filter((row) => {
          const candidate = row as { roomId?: unknown; createdAt?: unknown; id?: unknown; relaySequence?: unknown };
          if (roomId && candidate.roomId !== roomId) return false;
          if (afterSequence !== undefined && BigInt(String(candidate.relaySequence)) <= BigInt(String(afterSequence))) return false;
          const cursor = { createdAt: String(candidate.createdAt), id: String(candidate.id) };
          if (since && cursor.createdAt < String(since)) return false;
          if (after && (cursor.createdAt.localeCompare(after.createdAt) || cursor.id.localeCompare(after.id)) <= 0) return false;
          if (through && (cursor.createdAt.localeCompare(through.createdAt) || cursor.id.localeCompare(through.id)) > 0) return false;
          return true;
        })
        .sort((left, right) => {
          const leftEvent = left as { createdAt?: unknown; id?: unknown; relaySequence?: unknown };
          const rightEvent = right as { createdAt?: unknown; id?: unknown; relaySequence?: unknown };
          const order = relaySequenceOrder
            ? BigInt(String(leftEvent.relaySequence)) < BigInt(String(rightEvent.relaySequence)) ? -1 : 1
            : String(leftEvent.createdAt).localeCompare(String(rightEvent.createdAt)) ||
              String(leftEvent.id).localeCompare(String(rightEvent.id));
          return descending ? -order : order;
        })
        .slice(offset, offset + limit);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("FROM turns")) {
      return { rows: this.turnRows as T[], rowCount: this.turnRows.length };
    }
    if (sql.includes("FROM workflows")) {
      return { rows: this.workflowRows as T[], rowCount: this.workflowRows.length };
    }
    if (sql.includes("SELECT count(*) AS count")) {
      if (sql.includes("FROM panes WHERE room_id = $1 AND is_closed = false")) {
        const roomId = String(values[0] ?? this.roomId);
        const count = this.paneRows.filter(
          (row) => (row as { roomId?: unknown; isClosed?: unknown }).roomId === roomId && (row as { isClosed?: unknown }).isClosed !== true
        ).length;
        return { rows: [{ count: String(count) } as T], rowCount: 1 };
      }
      return { rows: [{ count: "0" } as T], rowCount: 1 };
    }
    if (sql.includes("FROM panes")) {
      const paneId = values.find((value) => typeof value === "string" && String(value).startsWith("pane:"));
      const roomId = values.find((value) => typeof value === "string" && String(value).startsWith("room:"));
      const includeClosed = typeof values[1] === "boolean" ? values[1] : true;
      const fallback = {
        id: this.paneId,
        roomId: this.roomId,
        title: "Existing pane",
        mode: "CHAT",
        status: "IDLE",
        providerId: null,
        modelId: null,
        reasoningEffort: "medium",
        cwd: null,
        order: 0,
        columnSpan: 1,
        isMaximized: false,
        isMinimized: false,
        isClosed: false,
        split: { parentId: null, direction: null, size: null },
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z"
      };
      const rows = this.paneRows.length ? this.paneRows : [fallback];
      const selectedRows = rows
        .filter((row) => !paneId || (row as { id?: unknown }).id === paneId)
        .filter((row) => !roomId || (row as { roomId?: unknown }).roomId === roomId)
        .filter((row) => includeClosed || (row as { isClosed?: unknown }).isClosed !== true)
        .sort((left, right) => {
          const leftOrder = Number((left as { order?: unknown }).order ?? 0);
          const rightOrder = Number((right as { order?: unknown }).order ?? 0);
          if (leftOrder !== rightOrder) return leftOrder - rightOrder;
          const leftCreatedAt = String((left as { createdAt?: unknown }).createdAt ?? "");
          const rightCreatedAt = String((right as { createdAt?: unknown }).createdAt ?? "");
          if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt.localeCompare(rightCreatedAt);
          return String((left as { id?: unknown }).id ?? "").localeCompare(String((right as { id?: unknown }).id ?? ""));
        });
      return {
        rows: selectedRows as T[],
        rowCount: selectedRows.length
      };
    }
    if (sql.includes("FROM rooms")) {
      const fallback = {
        id: this.roomId,
        name: "Existing",
        description: null,
        kind: "WORKSPACE",
        order: 0,
        paneLayoutColumns: null,
        paneCap: 16,
        traceId: "trace:test-1",
        archivedAt: null,
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z"
      };
      const rows = this.roomRows.length ? this.roomRows : [fallback];
      const orderedRows = sql.includes("ORDER BY room_order ASC, created_at ASC")
        ? [...rows].sort((left, right) => {
            const leftOrder = Number((left as { order?: unknown }).order ?? 0);
            const rightOrder = Number((right as { order?: unknown }).order ?? 0);
            if (leftOrder !== rightOrder) return leftOrder - rightOrder;
            const leftCreatedAt = String((left as { createdAt?: unknown }).createdAt ?? "");
            const rightCreatedAt = String((right as { createdAt?: unknown }).createdAt ?? "");
            return leftCreatedAt.localeCompare(rightCreatedAt);
          })
        : rows;
      return {
        rows: orderedRows as T[],
        rowCount: orderedRows.length
      };
    }
    if (sql.includes("GROUP BY job.status") || sql.includes("GROUP BY segment.status")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO telegram_notification_outbox")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM source_control_connections")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class FakePgPool extends FakePgClient implements PgPoolLike {
  readonly txClient = new FakePgClient();

  override async query<T = unknown>(sql: string, values: unknown[] = []) {
    if (
      sql.includes("FROM rooms") ||
      sql.includes("FROM panes") ||
      sql.includes("FROM events") ||
      sql.includes("FROM turns") ||
      sql.includes("FROM workflows") ||
      sql.includes("UPDATE workflows") ||
      sql.includes("FROM models") ||
      sql.includes("FROM mcp_servers") ||
      sql.includes("FROM mcp_tools") ||
      sql.includes("FROM import_candidates") ||
      sql.includes("FROM memory_records") ||
      sql.includes("memory_graph_issue_states") ||
      sql.includes("memory_consolidation_runs") ||
      sql.includes("memory_consolidation_findings") ||
      sql.includes("memory_consolidation_operations") ||
      sql.includes("memory_command_idempotency") ||
      sql.includes("FROM memory_graph_change_sets") ||
      sql.includes("FROM artifacts") ||
      sql.includes("FROM skills") ||
      sql.includes("FROM review_decisions") ||
      sql.includes("FROM review_checks") ||
      sql.includes("FROM review_diff_summaries") ||
      sql.includes("FROM swarm_tasks") ||
      sql.includes("FROM swarm_locks") ||
      sql.includes("FROM swarm_messages") ||
      sql.includes("FROM swarm_reconciles") ||
      sql.includes("space_agent_sessions") ||
      sql.includes("space_agent_messages") ||
      sql.includes("space_agent_runs") ||
      sql.includes("room_agent_") ||
      sql.includes("pane_browser_sessions") ||
      sql.includes("FROM cli_tasks") ||
      sql.includes("FROM cli_task_revisions") ||
      sql.includes("pane_cli_sessions") ||
      sql.includes("pane_cli_codex_thread_ownerships") ||
      sql.includes("pane_cli_transcript_chunks") ||
      sql.includes("FROM pane_agent_bindings")
    ) {
      return this.txClient.query<T>(sql, values);
    }
    return super.query<T>(sql, values);
  }

  async connect(): Promise<PgClientLike> {
    return this.txClient;
  }
}

describe("PostgresSpaceStore", () => {
  it("defaults missing source-control connections to the Space repository", async () => {
    const store = new PostgresSpaceStore(new FakePgPool());

    await expect(store.listSourceControlConnections()).resolves.toEqual([
      expect.objectContaining({ provider: "gitea", repositoryName: "spaceapp" }),
      expect.objectContaining({ provider: "github", repositoryName: "spaceapp" })
    ]);
    await expect(store.getSourceControlConnection("gitea")).resolves.toEqual(
      expect.objectContaining({ provider: "gitea", repositoryName: "spaceapp" })
    );
  });

  it("reads one pane directly and pages events with SQL limits and stable ordering", async () => {
    const pool = new FakePgPool();
    pool.txClient.seedEvents([
      {
        id: "event:test-1",
        roomId: "room:test-1",
        paneId: null,
        turnId: null,
        workflowId: null,
        traceId: "trace:test-1",
        type: "ROOM_CREATED",
        message: "one",
        payload: {},
        createdAt: "2026-07-18T06:00:00.000Z"
      },
      {
        id: "event:test-2",
        roomId: "room:test-1",
        paneId: null,
        turnId: null,
        workflowId: null,
        traceId: "trace:test-2",
        type: "PANE_UPDATED",
        message: "two",
        payload: {},
        createdAt: "2026-07-18T06:00:01.000Z"
      },
      {
        id: "event:test-3",
        roomId: "room:test-1",
        paneId: null,
        turnId: null,
        workflowId: null,
        traceId: "trace:test-3",
        type: "PANE_UPDATED",
        message: "three",
        payload: {},
        createdAt: "2026-07-18T06:00:02.000Z"
      }
    ]);
    const store = new PostgresSpaceStore(pool);

    await expect(store.getPane("pane:test-1")).resolves.toMatchObject({ id: "pane:test-1", roomId: "room:test-1" });
    await expect(store.getLatestEvent("room:test-1")).resolves.toMatchObject({ id: "event:test-3" });
    await expect(
      store.listEventsPage({ roomId: "room:test-1", page: 2, pageSize: 2, sortOrder: "desc" })
    ).resolves.toEqual({ items: [expect.objectContaining({ id: "event:test-1" })], total: 3 });

    const paneRead = pool.txClient.calls.find((call) => call.sql.includes("FROM panes") && call.sql.includes("WHERE id = $1"));
    const latestEventRead = pool.txClient.calls.find(
      (call) => call.sql.includes("FROM events") && call.sql.includes("ORDER BY created_at DESC, id DESC LIMIT 1")
    );
    const eventRead = pool.txClient.calls.find(
      (call) => call.sql.includes("FROM events") && call.sql.includes("LIMIT") && call.sql.includes("OFFSET")
    );
    expect(paneRead?.values).toEqual(["pane:test-1"]);
    expect(latestEventRead?.values).toEqual(["room:test-1"]);
    expect(eventRead?.sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(eventRead?.values).toEqual(["room:test-1", 2, 2]);
  });

  it("pages durable event sequences and includes a later commit with older chronology", async () => {
    const pool = new FakePgPool();
    const rows = Array.from({ length: 500 }, (_, index) => ({
      id: `event:range-${String(index).padStart(4, "0")}`,
      roomId: "room:test-1",
      paneId: null,
      turnId: null,
      workflowId: null,
      traceId: `trace:range-${index}`,
      type: "PANE_UPDATED",
      message: `event ${index}`,
      payload: {},
      createdAt: new Date(Date.parse("2026-07-18T06:00:00.000Z") + index).toISOString(),
      relaySequence: String(index + 1)
    }));
    pool.txClient.seedEvents(rows);
    const store = new PostgresSpaceStore(pool);

    const first = await store.listEventChanges({
      afterSequence: null,
      sortOrder: "asc",
      limit: 500
    });
    const lateCommit = {
      ...rows[0]!,
      id: "event:late-commit",
      traceId: "trace:late-commit",
      message: "late commit",
      createdAt: "2026-07-18T05:59:00.000Z",
      relaySequence: "501"
    };
    pool.txClient.seedEvents([...rows, lateCommit]);
    const second = await store.listEventChanges({
      afterSequence: first.at(-1)!.sequence,
      sortOrder: "asc",
      limit: 500
    });

    expect(first).toHaveLength(500);
    expect(second).toEqual([{ sequence: "501", event: expect.objectContaining({ id: "event:late-commit" }) }]);
    const rangeCalls = pool.txClient.calls.filter((call) => call.sql.includes("FROM events") && call.sql.includes("relay_sequence"));
    expect(rangeCalls).toHaveLength(2);
    expect(rangeCalls[1]?.sql).toContain("relay_sequence >");
    expect(rangeCalls[1]?.sql).toContain("ORDER BY relay_sequence ASC");
  });

  it("queries persisted browser recording segments and handoff requests", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    await expect(store.getBrowserCaptureSegment("browser_segment:test-1")).resolves.toBeNull();
    await expect(store.listBrowserCaptureSegments("browser_capture:test-1")).resolves.toEqual([]);
    await expect(store.getBrowserCaptureMetrics()).resolves.toEqual({
      jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
      segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
    });
    await expect(store.getActiveBrowserHandoffRequest("browser_session:test-1")).resolves.toBeNull();
    await expect(store.getBrowserHandoffRequest("browser_handoff:test-1")).resolves.toBeNull();
    await expect(store.listBrowserHandoffRequests("room:test-1")).resolves.toEqual([]);

    expect(pool.calls.some((call) => call.sql.includes("FROM browser_capture_segments"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("ORDER BY segment_sequence ASC"))).toBe(true);
    const allCalls = [...pool.calls, ...pool.txClient.calls];
    expect(allCalls.some((call) => call.sql.includes("GROUP BY job.status"))).toBe(true);
    expect(allCalls.some((call) => call.sql.includes("GROUP BY segment.status"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("FROM browser_handoff_requests"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("status IN ('REQUESTED', 'ACCEPTED')"))).toBe(true);
  });

  it("keeps the existing user id when production auth reuses the dev-login email", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const devUser = await store.upsertUser({
      id: "user:dev-operator",
      email: "space@space.local",
      role: "ADMIN"
    });
    const operatorUser = await store.upsertUser({
      id: "user:operator",
      email: "space@space.local",
      role: "ADMIN"
    });

    expect(devUser).toEqual({ id: "user:dev-operator", email: "space@space.local", role: "ADMIN" });
    expect(operatorUser).toEqual({ id: "user:dev-operator", email: "space@space.local", role: "ADMIN" });
    const userUpserts = pool.calls.filter((call) => call.sql.includes("WITH updated_email"));
    expect(userUpserts).toHaveLength(2);
    expect(userUpserts[1]?.sql).toContain("WHERE lower(email) = lower($2)");
  });

  it("creates rooms and initial panes inside one transaction with parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const room = await store.createRoom(
      {
        name: "Launch'; drop table rooms; --",
        initialPaneCount: 2
      },
      "trace:test-1"
    );

    expect(room.name).toBe("Launch'; drop table rooms; --");
    expect(room.kind).toBe("WORKSPACE");
    expect(pool.txClient.calls.map((call) => call.sql)).toContain("BEGIN");
    expect(pool.txClient.calls.map((call) => call.sql)).toContain("COMMIT");

    const roomInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO rooms"));
    expect(roomInsert?.sql).not.toContain("drop table");
    expect(roomInsert?.values).toContain("Launch'; drop table rooms; --");
    expect(roomInsert?.values).toContain("WORKSPACE");

    const paneInserts = pool.txClient.calls.filter((call) => call.sql.includes("INSERT INTO panes"));
    expect(paneInserts).toHaveLength(2);
    const eventInserts = pool.txClient.calls.filter((call) => call.sql.includes("INSERT INTO events"));
    expect(eventInserts).toHaveLength(3);
  });

  it("persists the internal agent proof room classification", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const room = await store.createRoom(
      { name: "Agent Proof", initialPaneCount: 0, kind: "AGENT_PROOF" },
      "trace:proof"
    );

    expect(room.kind).toBe("AGENT_PROOF");
    const roomInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO rooms"));
    expect(roomInsert?.values).toContain("AGENT_PROOF");
  });

  it("creates ordered pane batches under the room lock and rejects overflow before inserts", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ name: "Batch", initialPaneCount: 1 }, "trace:room");
    const callsBeforeBatch = pool.txClient.calls.length;

    const panes = await store.createPanes([
      { roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex", cwd: "/etc" },
      { roomId: room.id, title: "Chat", mode: "CHAT" }
    ], "trace:batch");

    expect(panes.map((pane) => ({ title: pane.title, order: pane.order }))).toEqual([
      { title: "Codex CLI 2", order: 1 },
      { title: "Chat 3", order: 2 }
    ]);
    const batchCalls = pool.txClient.calls.slice(callsBeforeBatch);
    const lockIndex = batchCalls.findIndex((call) => call.sql.includes("FROM rooms") && call.sql.includes("FOR UPDATE"));
    const countIndex = batchCalls.findIndex((call) => call.sql.includes("SELECT count(*) AS count FROM panes"));
    const insertIndex = batchCalls.findIndex((call) => call.sql.includes("INSERT INTO panes"));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(countIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBeGreaterThan(countIndex);
    expect(batchCalls.filter((call) => call.sql.includes("INSERT INTO panes"))).toHaveLength(2);
    expect(batchCalls.filter((call) => call.sql.includes("INSERT INTO events"))).toHaveLength(2);
    expect(batchCalls.map((call) => call.sql)).toContain("COMMIT");

    const fullPool = new FakePgPool();
    const fullStore = new PostgresSpaceStore(fullPool);
    const fullRoom = await fullStore.createRoom({ name: "Full", initialPaneCount: 15 }, "trace:full");
    const fullCallsBeforeBatch = fullPool.txClient.calls.length;
    await expect(fullStore.createPanes([
      { roomId: fullRoom.id, title: "Chat", mode: "CHAT" },
      { roomId: fullRoom.id, title: "Chat", mode: "CHAT" }
    ], "trace:overflow")).rejects.toThrow(SpaceConflictError);
    const overflowCalls = fullPool.txClient.calls.slice(fullCallsBeforeBatch);
    expect(overflowCalls.filter((call) => call.sql.includes("INSERT INTO panes"))).toHaveLength(0);
    expect(overflowCalls.map((call) => call.sql)).toContain("ROLLBACK");
    expect(overflowCalls.map((call) => call.sql)).not.toContain("COMMIT");
  });

  it("persists one hidden room-agent pane with idempotent request and recoverable checkpoints", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ name: "Supervisor", initialPaneCount: 0 }, "trace:room-agent");

    const hiddenPane = await store.getOrCreateRoomAgentPane(room.id, "trace:room-agent-pane");
    const samePane = await store.getOrCreateRoomAgentPane(room.id, "trace:room-agent-pane-repeat");
    expect(samePane.id).toBe(hiddenPane.id);
    expect(hiddenPane).toMatchObject({
      roomId: room.id,
      title: "Room Agent",
      mode: "CHAT",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      status: "CLOSED",
      isClosed: true
    });
    expect(await store.listPanes(room.id)).toEqual([]);
    expect(await store.getRoomAgentTranscriptClearedAt(room.id)).toBeNull();
    await expect(store.clearRoomAgentTranscript(room.id, "2026-07-11T18:00:00.000Z")).resolves.toBe(
      "2026-07-11T18:00:00.000Z"
    );
    await expect(store.getRoomAgentTranscriptClearedAt(room.id)).resolves.toBe("2026-07-11T18:00:00.000Z");

    const request = await store.createRoomAgentRequest({
      requestId: "room_agent_request:postgres",
      roomId: room.id,
      sessionId: "space_agent_session:postgres",
      clientRequestId: "room-agent-client-request-postgres",
      promptMessageId: "space_agent_message:prompt",
      responseMessageId: "space_agent_message:response"
    });
    expect((await store.getRoomAgentRequest(room.id, request.clientRequestId))?.requestId).toBe(request.requestId);
    await expect(store.createRoomAgentRequest({ ...request })).rejects.toThrow(SpaceConflictError);

    const mission = await store.createRoomAgentMission({
      id: "room_agent_mission:postgres",
      requestId: request.requestId,
      roomId: room.id,
      sessionId: request.sessionId,
      workflowId: "room-supervisor:postgres",
      status: "QUEUED",
      currentPaneId: null,
      statusReason: "Mission queued."
    });
    const action = await store.createRoomAgentAction({
      actionId: "room_agent_action:postgres",
      missionId: mission.id,
      roomId: room.id,
      paneId: null,
      idempotencyKey: "room-agent-action-postgres-0001",
      actionType: "INSPECT",
      status: "QUEUED",
      requestPayload: { scope: "room" },
      evidence: {},
      attemptCount: 0,
      statusReason: "Inspection queued."
    });
    await expect(store.createRoomAgentAction({ ...action })).rejects.toThrow(SpaceConflictError);

    const running = await store.updateRoomAgentMission(mission.id, {
      status: "RUNNING",
      currentPaneId: hiddenPane.id,
      startedAt: "2026-07-11T18:00:03.000Z",
      statusReason: "Inspecting room panes."
    });
    const completedAction = await store.updateRoomAgentAction(action.actionId, {
      status: "COMPLETED",
      paneId: hiddenPane.id,
      evidence: { paneCount: 0 },
      attemptCount: 1,
      statusReason: "Room inspected.",
      completedAt: "2026-07-11T18:00:04.000Z"
    });

    expect(running).toMatchObject({ status: "RUNNING", currentPaneId: hiddenPane.id });
    expect(completedAction).toMatchObject({ status: "COMPLETED", evidence: { paneCount: 0 }, attemptCount: 1 });
    await expect(store.getRoomAgentMission(room.id, mission.id)).resolves.toEqual(running);
    await expect(store.getRoomAgentMission(room.id, "room_agent_mission:missing")).resolves.toBeNull();
    await expect(store.getRoomAgentAction(mission.id, action.actionId)).resolves.toEqual(completedAction);
    await expect(store.getRoomAgentAction(mission.id, "room_agent_action:missing")).resolves.toBeNull();
    expect(await store.listRoomAgentMissions(room.id)).toEqual([running]);
    expect(await store.listRoomAgentActions(mission.id)).toEqual([completedAction]);
    expect(pool.txClient.calls.filter((call) => call.sql.includes("INSERT INTO panes"))).toHaveLength(1);
    expect(pool.txClient.calls.some((call) => call.sql.includes("INSERT INTO room_agent_bindings"))).toBe(true);
  });

  it("stores and reuses the complete room-agent enqueue in one transaction", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ name: "Durable supervisor queue", initialPaneCount: 0 }, "trace:durable-room-agent");
    const pane = await store.getOrCreateRoomAgentPane(room.id);
    const session = await store.createSpaceAgentSession({
      sessionId: pane.id,
      paneId: pane.id,
      roomId: room.id,
      title: "Room Agent",
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high"
    });
    const input = {
      requestId: "room_agent_request:durable",
      initialExecutionState: { source: "LIVE", objective: "Complete every pane." },
      clientRequestId: "room-agent-client-durable",
      content: "Complete every pane.",
      supervisorWorkflowId: `room-supervisor:${room.id}`,
      childWorkflowId: `workflow:codex-app-server:${room.id}:${pane.id}:room-agent-client-durable`,
      promptMessageId: "agent_msg:room-agent-durable-user",
      responseMessageId: "agent_msg:room-agent-durable-assistant",
      runId: "agent_run:room-agent-durable",
      queueItem: {
        missionId: "room_agent_mission:durable",
        turn: {
          roomId: room.id,
          paneId: pane.id,
          prompt: "Full-room supervisor context. Complete every pane.",
          modelId: "gpt-5.6-sol" as const,
          reasoningEffort: "high" as const,
          agentSessionId: session.sessionId,
          agentRunId: "agent_run:room-agent-durable",
          roomAgentMissionId: "room_agent_mission:durable",
          agentUserMessageId: "agent_msg:room-agent-durable-user",
          agentAssistantMessageId: "agent_msg:room-agent-durable-assistant",
          traceId: "room-agent-client-durable"
        }
      }
    };

    const first = await store.enqueueRoomAgentMission(input);
    expect(first.mission.executionState).toEqual(input.initialExecutionState);
    await expect(store.enqueueRoomAgentMission({ ...input, requireNewMission: true, clientRequestId: "client:another-goal" })).rejects.toThrow(/already active/);
    const replayedStart = await store.enqueueRoomAgentMission({ ...input, requireNewMission: true });
    expect(replayedStart.created).toBe(false);
    const retry = await store.enqueueRoomAgentMission({ ...input, requestId: "room_agent_request:retry-ignored" });
    expect(await store.listUnsignaledRoomAgentEnqueues()).toEqual([
      expect.objectContaining({ request: first.request, queueItem: first.queueItem })
    ]);
    await store.markRoomAgentMissionSignaled(room.id, input.clientRequestId);
    const acknowledgedRetry = await store.enqueueRoomAgentMission(input);
    const followUpInput = {
      ...input,
      requestId: "room_agent_request:durable-follow-up",
      clientRequestId: "room-agent-client-durable-follow-up",
      content: "Also verify the mobile pane.",
      childWorkflowId: `workflow:codex-app-server:${room.id}:${pane.id}:room-agent-client-durable-follow-up`,
      promptMessageId: "agent_msg:room-agent-durable-follow-up-user",
      responseMessageId: "agent_msg:room-agent-durable-follow-up-assistant",
      runId: "agent_run:room-agent-durable-follow-up",
      queueItem: {
        ...input.queueItem,
        turn: {
          ...input.queueItem.turn,
          prompt: "Full-room supervisor follow-up. Also verify the mobile pane.",
          agentRunId: "agent_run:room-agent-durable-follow-up",
          agentUserMessageId: "agent_msg:room-agent-durable-follow-up-user",
          agentAssistantMessageId: "agent_msg:room-agent-durable-follow-up-assistant",
          traceId: "room-agent-client-durable-follow-up"
        }
      }
    };
    await store.updateRoomAgentMission(first.mission.id, {
      status: "PAUSED",
      pausedAt: "2026-07-11T18:00:05.000Z",
      executionState: {
        pendingCompletion: { status: "COMPLETED", statusReason: "Earlier turn completed.", completedAt: "2026-07-11T18:00:05.000Z" }
      },
      statusReason: "Paused after completion."
    });
    const followUp = await store.enqueueRoomAgentMission(followUpInput);

    expect(first.created).toBe(true);
    expect(first.request).toMatchObject({ missionId: first.mission.id, requestKind: "MISSION" });
    expect(retry.created).toBe(false);
    expect(retry.queueItem).toEqual(first.queueItem);
    expect(acknowledgedRetry.signaledAt).not.toBeNull();
    expect(followUp).toMatchObject({
      mission: {
        id: first.mission.id,
        status: "PAUSED",
        completedAt: null,
        executionState: {},
        statusReason: "Follow-up queued for the paused Room Agent goal."
      },
      request: { missionId: first.mission.id, requestKind: "FOLLOW_UP" },
      responseMessage: { content: expect.stringContaining("active Room Agent goal") }
    });
    expect(await store.listUnsignaledRoomAgentEnqueues()).toEqual([
      expect.objectContaining({ request: followUp.request, queueItem: followUp.queueItem })
    ]);
    expect(pool.txClient.calls.filter((call) => call.sql.includes("INSERT INTO room_agent_requests"))).toHaveLength(2);
    expect(pool.txClient.calls.filter((call) => call.sql.includes("INSERT INTO room_agent_missions"))).toHaveLength(1);
    expect(pool.txClient.calls.filter((call) => call.sql.includes("INSERT INTO space_agent_runs"))).toHaveLength(2);
    expect(pool.txClient.calls.map((call) => call.sql)).toContain("COMMIT");
  });

  it("reorders rooms without violating the unique room_order index", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const first = await store.createRoom({ name: "First", initialPaneCount: 0 }, "trace:room-1");
    const second = await store.createRoom({ name: "Second", initialPaneCount: 0 }, "trace:room-2");
    const third = await store.createRoom({ name: "Third", initialPaneCount: 0 }, "trace:room-3");

    const reordered = await store.reorderRooms([third.id, first.id, second.id], "trace:room-reorder");

    expect(reordered.map((room) => [room.id, room.order])).toEqual([
      [third.id, 0],
      [first.id, 1],
      [second.id, 2]
    ]);
    expect(pool.txClient.calls.some((call) => call.sql.includes("room_order = -ordered.room_order - 1"))).toBe(true);
    expect(pool.txClient.calls.some((call) => call.sql === "UPDATE rooms SET room_order = -room_order - 1")).toBe(true);
  });

  it("reorders active panes of a room and renumbers pane order", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const room = await store.createRoom({ name: "PaneReorder", initialPaneCount: 3 }, "trace:pane-reorder-room");
    const panes = await store.listPanes(room.id);
    const [first, second, third] = panes;
    expect(panes.map((pane) => pane.order)).toEqual([0, 1, 2]);

    const reordered = await store.reorderPanes(room.id, [second!.id, third!.id, first!.id], "trace:pane-reorder");

    expect(reordered.map((pane) => [pane.id, pane.order])).toEqual([
      [second!.id, 0],
      [third!.id, 1],
      [first!.id, 2]
    ]);
    expect(pool.txClient.calls.some((call) => call.sql.includes("pane_order = -ordered.pane_order - 1"))).toBe(true);
    expect(pool.txClient.calls.some((call) => call.sql.includes("UPDATE panes SET pane_order = -pane_order - 1"))).toBe(true);
  });

  it("rejects a pane reorder payload that omits active panes", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const room = await store.createRoom({ name: "PaneReorderReject", initialPaneCount: 3 }, "trace:pane-reorder-reject-room");
    const panes = await store.listPanes(room.id);

    await expect(store.reorderPanes(room.id, [panes[0]!.id, panes[1]!.id], "trace:pane-reorder-reject")).rejects.toThrow(
      /include every active pane of the room exactly once/
    );
  });

  it("updates a pane to the four-column span offered by the all-panes-width menu", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ name: "FourColumnSpan", initialPaneCount: 1 }, "trace:four-column-span-room");
    const [pane] = await store.listPanes(room.id);

    const updated = await store.updatePane(pane!.id, { columnSpan: 4 }, "trace:four-column-span");

    expect(updated.columnSpan).toBe(4);
    const updateCall = pool.txClient.calls.find(
      (call) => call.sql.includes("UPDATE panes") && call.sql.includes("column_span = $12")
    );
    expect(updateCall?.values).toEqual(expect.arrayContaining([4]));
  });

  it("updates room layout and resets every open pane in one transaction", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ name: "Layouts", initialPaneCount: 2 }, "trace:room-layout");
    const panes = await store.listPanes(room.id);
    await store.updatePane(panes[0]!.id, { columnSpan: 3, isMaximized: true }, "trace:maximize");
    await store.updatePane(panes[1]!.id, { columnSpan: 2, isMinimized: true }, "trace:minimize");

    const result = await store.updateRoomPaneLayout(room.id, { paneLayoutColumns: 4 }, "trace:preset");

    expect(result.room).toMatchObject({ id: room.id, paneLayoutColumns: 4, paneLayoutHeight: 1, traceId: "trace:preset" });
    expect(result.panes.map((pane) => [pane.id, pane.order, pane.columnSpan, pane.isMaximized, pane.isMinimized])).toEqual([
      [panes[0]!.id, panes[0]!.order, 1, false, false],
      [panes[1]!.id, panes[1]!.order, 1, false, true]
    ]);

    await store.updatePane(panes[0]!.id, { columnSpan: 3, isMaximized: true }, "trace:height-preserve");
    const heightResult = await store.updateRoomPaneLayout(room.id, { paneLayoutHeight: 3 }, "trace:height");
    expect(heightResult.panes[0]).toMatchObject({ columnSpan: 3, isMaximized: true });
    expect(heightResult.panes[1]).toMatchObject({ isMinimized: true });
    expect(heightResult.room).toMatchObject({ id: room.id, paneLayoutColumns: 4, paneLayoutHeight: 3, traceId: "trace:height" });
    expect(pool.txClient.calls.map((call) => call.sql)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    expect(pool.txClient.calls.some((call) => call.sql.includes("pane_layout_columns = $2"))).toBe(true);
    expect(
      pool.txClient.calls.some(
        (call) => call.sql.includes("UPDATE panes") && call.sql.includes("column_span = 1") && call.sql.includes("is_maximized = false")
      )
    ).toBe(true);
  });

  it("records audit events with parameterized SQL and JSON metadata", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const auditEvent = await store.recordAuditEvent({
      actorUserId: "user:test-1",
      traceId: "trace:audit-1",
      action: "room.create",
      targetType: "room",
      targetId: "room:test-1",
      metadata: { name: "Launch'; drop table audit_events; --" }
    });

    expect(auditEvent.metadata).toEqual({ name: "Launch'; drop table audit_events; --" });
    const auditInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO audit_events"));
    expect(auditInsert?.sql).not.toContain("drop table");
    expect(auditInsert?.values).toContain("room.create");
    expect(auditInsert?.values).toContain(JSON.stringify({ name: "Launch'; drop table audit_events; --" }));

    const auditEvents = await store.listAuditEvents();
    expect(auditEvents.map((event) => event.action)).toEqual(["room.create"]);
  });

  it("creates, loads, and updates pane agent bindings with parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const created = await store.upsertAgentPaneBinding({
      paneId: "pane:test-1",
      source: "CODER",
      coderChatId: "chat:test-1",
      status: "READY",
      title: "Planner'; drop table pane_agent_bindings; --",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "OpenAI",
      selectedModelName: "gpt-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github"],
      lastSyncedAt: "2026-06-29T00:00:00.000Z"
    });

    expect(created.title).toBe("Planner'; drop table pane_agent_bindings; --");
    const insert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO pane_agent_bindings"));
    expect(insert?.sql).not.toContain("drop table");
    expect(insert?.values).toContain("Planner'; drop table pane_agent_bindings; --");

    await expect(store.getAgentPaneBinding("pane:test-1")).resolves.toEqual(created);

    const updated = await store.updateAgentPaneBinding("pane:test-1", {
      status: "RUNNING",
      selectedModelConfigId: null,
      selectedProviderName: null,
      selectedModelName: null,
      selectedReasoningKey: null,
      selectedToolIds: [],
      lastSyncedAt: "2026-06-29T00:00:01.000Z"
    });

    expect(updated).toMatchObject({
      paneId: "pane:test-1",
      status: "RUNNING",
      title: "Planner'; drop table pane_agent_bindings; --",
      selectedModelConfigId: null,
      selectedProviderName: null,
      selectedModelName: null,
      selectedReasoningKey: null,
      selectedToolIds: [],
      lastSyncedAt: "2026-06-29T00:00:01.000Z"
    });
    const update = pool.txClient.calls.find((call) => call.sql.includes("UPDATE pane_agent_bindings"));
    expect(update?.sql).not.toContain("drop table");
    const second = await store.upsertAgentPaneStoredSession({
      paneId: "pane:test-1",
      roomId: "room:test-1",
      source: "CODER",
      coderChatId: "chat:test-2",
      status: "READY",
      title: "Second session",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "OpenAI",
      selectedModelName: "gpt-5.5",
      selectedReasoningKey: "medium",
      selectedToolIds: ["mcp:linear"],
      lastSyncedAt: "2026-06-29T00:00:02.000Z"
    });
    expect(second.coderChatId).toBe("chat:test-2");
    await expect(store.listAgentPaneHistory("room:test-1")).resolves.toHaveLength(2);
  });

  it("creates, loads, and updates Space-native agent sessions, messages, and runs", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const session = await store.createSpaceAgentSession({
      sessionId: "agent_session:test-1",
      paneId: "pane:test-1",
      roomId: "room:test-1",
      title: "Planner'; drop table space_agent_sessions; --",
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.5",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github"],
      permissionMode: "ask_for_approval",
      collaborationMode: "plan"
    });
    const userMessage = await store.createSpaceAgentMessage({
      messageId: "agent_msg:user-1",
      sessionId: session.sessionId,
      role: "user",
      content: "Run independently from Coder."
    });
    const assistantMessage = await store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const statusMessage = await store.createSpaceAgentMessage({
      messageId: "agent_msg:status-1",
      sessionId: session.sessionId,
      role: "system",
      content: "Monitoring every pane."
    });
    const run = await store.createSpaceAgentRun({
      runId: "agent_run:test-1",
      execution: { traceId: "trace:persisted-choice", modelConfigId: "codex-v1|original|high", providerId: null,
        providerName: "Codex", requestedModel: "original", requestedReasoning: "high",
        attachments: [{ artifactId: "artifact:saved-input", name: "input.pdf", mimeType: "application/pdf", byteSize: 1234, sha256: "a".repeat(64) }] },
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      workflowId: "workflow:codex-app-server:room:test-1:pane:test-1:trace:test-1",
      status: "RUNNING",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });
    const provisionalRunEvent = pool.txClient.calls.find(
      (call) => call.sql.includes("INSERT INTO events") && call.values[7] === "Pane agent run started."
    );

    expect(run.execution?.requestedModel).toBe("original");
    expect(run.execution?.attachments?.[0]).toMatchObject({ artifactId: "artifact:saved-input", name: "input.pdf", byteSize: 1234 });
    expect(run.startedAt).toBeTruthy();
    await store.updateSpaceAgentRun(run.runId, { runtimeModelAtStart: "runtime-original" });
    expect(session.source).toBe("SPACE");
    expect(session).toMatchObject({ permissionMode: "ask_for_approval", collaborationMode: "plan" });
    expect(session.title).toContain("drop table");
    expect(pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO space_agent_sessions"))?.values).toContain(session.title);
    expect(provisionalRunEvent?.values[4]).toBeNull();
    await expect(store.getActiveSpaceAgentSession("pane:test-1")).resolves.toMatchObject({ sessionId: session.sessionId });
    await expect(store.listSpaceAgentHistory("room:test-1")).resolves.toEqual([
      expect.objectContaining({ source: "SPACE", sessionId: session.sessionId, coderChatId: null })
    ]);
    await expect(store.listSpaceAgentMessages(session.sessionId)).resolves.toHaveLength(3);
    await expect(store.listSpaceAgentMessages(session.sessionId, 2)).resolves.toHaveLength(2);
    await expect(store.countSpaceAgentMessages(session.sessionId)).resolves.toBe(3);
    expect(
      pool.txClient.calls.find(
        (call) => call.sql.includes("FROM space_agent_messages") && call.sql.includes("LIMIT COALESCE") && call.values[1] === 2
      )?.values
    ).toEqual([session.sessionId, 2]);

    const sameTime = "2026-10-06T11:00:00.000Z";
    // The store stamps created_at itself; freeze the clock so both rows really tie (a 1 ms gap on a slow runner
    // ordered them by time instead of by role).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(sameTime));
    await store.createSpaceAgentMessage({
      messageId: "agent_msg:tied-assistant",
      sessionId: session.sessionId,
      runId: run.runId,
      role: "assistant",
      content: "Assistant message at same time",
      status: "COMPLETED",
      createdAt: sameTime,
      updatedAt: sameTime
    });
    await store.createSpaceAgentMessage({
      messageId: "agent_msg:tied-user",
      sessionId: session.sessionId,
      runId: run.runId,
      role: "user",
      content: "User message at same time",
      status: "COMPLETED",
      createdAt: sameTime,
      updatedAt: sameTime
    });
    vi.useRealTimers();
    const tiedMessages = await store.listSpaceAgentMessages(session.sessionId);
    const userIndex = tiedMessages.findIndex((m) => m.messageId === "agent_msg:tied-user");
    const assistantIndex = tiedMessages.findIndex((m) => m.messageId === "agent_msg:tied-assistant");
    expect(userIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeLessThan(assistantIndex);

    await expect(
      store.updateSpaceAgentRun(run.runId, {
        status: "COMPLETED",
        codexThreadId: "thread:test-1",
        codexTurnId: "turn:test-1"
      })
    ).resolves.toMatchObject({ status: "COMPLETED", codexThreadId: "thread:test-1" });
    await expect(
      store.updateSpaceAgentMessage(assistantMessage.messageId, {
        content: "I kept running inside Space.",
        status: "COMPLETED"
      })
    ).resolves.toMatchObject({ content: "I kept running inside Space.", status: "COMPLETED" });
    await expect(store.getLatestSpaceAgentRun(session.sessionId)).resolves.toMatchObject({
      runId: run.runId, execution: run.execution, runtimeModelAtStart: "runtime-original", startedAt: run.startedAt
    });
    const spaceAgentRunReads = [...pool.calls, ...pool.txClient.calls].filter(
      (call) => call.sql.includes("FROM space_agent_runs")
    );
    expect(spaceAgentRunReads.length).toBeGreaterThan(0);
    expect(spaceAgentRunReads.every((call) => !call.sql.includes("cli_task_id"))).toBe(true);
    expect(spaceAgentRunReads.every((call) => !call.sql.includes("cli_task_revision_id"))).toBe(true);
    await expect(
      store.updateSpaceAgentRun(run.runId, {
        status: "INTERRUPTED",
        errorCode: "INTERRUPTED",
        errorMessage: "Operator interrupted the Space agent run."
      })
    ).resolves.toMatchObject({ status: "INTERRUPTED" });
    const interruptedRunEvent = pool.txClient.calls.find(
      (call) => call.sql.includes("INSERT INTO events") && call.values[7] === "Pane agent run interrupted."
    );
    expect(interruptedRunEvent?.values[4]).toBeNull();
    await expect(
      store.updateSpaceAgentSession(session.sessionId, {
        permissionMode: "full_access",
        collaborationMode: "default"
      })
    ).resolves.toMatchObject({ permissionMode: "full_access", collaborationMode: "default" });
    expect(JSON.stringify({ session, run })).not.toMatch(new RegExp("10\\.100\\.0\\.216|api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));
  });

  it("creates, tails, and updates terminal CLI sessions with parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const chatPane = await store.createPane({ roomId: "room:test-1", title: "Chat", mode: "CHAT" }, "trace:cli");
    const cliPane = await store.createPane({ roomId: "room:test-1", title: "Codex CLI", mode: "TERMINAL", cwd: "/opt/spaceapp" }, "trace:cli");
    const codexThreadId = "019f3805-9299-7b92-b70c-cd4d49b02774";
    const updatedCodexThreadId = "019f3806-9299-7b92-b70c-cd4d49b02775";

    await expect(
      store.createPaneCliSession({
        sessionId: "cli_session:chat-1",
        paneId: chatPane.id,
        roomId: "room:test-1",
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: null,
        reasoningEffort: "medium",
        cwd: "/opt/spaceapp"
      })
    ).rejects.toBeInstanceOf(SpaceConflictError);

    const session = await store.createPaneCliSession({
      sessionId: "cli_session:test-1",
      paneId: cliPane.id,
      roomId: "room:test-1",
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      launchMode: "RESUME",
      cwd: "/opt/spaceapp",
      codexThreadId
    });
    expect(session.codexThreadId).toBe(codexThreadId);
    expect(session.launchMode).toBe("RESUME");
    const terminalGeometry = { generationId: "host-generation", cols: 61, rows: 74 };
    await store.updatePaneCliTerminalGeometry(session.sessionId, terminalGeometry);
    const restoredStore = new PostgresSpaceStore(pool);
    await expect(restoredStore.getPaneCliSession(session.sessionId)).resolves.toMatchObject({
      terminalGeometry, status: session.status, updatedAt: session.updatedAt
    });
    const sessionInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO pane_cli_sessions"));
    expect(sessionInsert?.sql).toContain(
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NULL, $18, $19, $19, NULL)"
    );
    expect(sessionInsert?.values).toHaveLength(19);
    expect(sessionInsert?.values.slice(10, 19)).toEqual([
      "/opt/spaceapp",
      codexThreadId,
      session.sessionId,
      session.sessionId,
      null,
      "IDLE",
      null,
      true,
      expect.any(String)
    ]);
    await store.appendPaneCliTranscriptChunk({
      chunkId: "cli_chunk:test-1",
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      sequence: 0,
      stream: "system",
      content: "CLI runtime is disabled until command/config smoke passes."
    });
    await store.appendPaneCliTranscriptChunk({
      chunkId: "cli_chunk:test-2",
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      sequence: 1,
      stream: "stdout",
      content: "ready"
    });

    await expect(store.getActivePaneCliSession(cliPane.id)).resolves.toMatchObject({
      sessionId: session.sessionId,
      codexThreadId,
      cliTaskId: session.sessionId,
      cliTaskRevisionId: session.sessionId
    });
    const cliSessionRead = [...pool.calls, ...pool.txClient.calls].find(
      (call) => call.sql.includes("FROM pane_cli_sessions") && call.sql.includes("WHERE pane_id = $1")
    );
    expect(cliSessionRead?.sql).toContain('cli_task_id AS "cliTaskId"');
    expect(cliSessionRead?.sql).toContain('cli_task_revision_id AS "cliTaskRevisionId"');
    await expect(store.listPaneCliSessions(cliPane.id, 10)).resolves.toEqual([
      expect.objectContaining({ sessionId: session.sessionId, codexThreadId })
    ]);
    expect(pool.txClient.calls.at(-1)).toMatchObject({ values: [cliPane.id, 10] });
    await expect(store.listPaneCliTranscriptChunks(session.sessionId, 1)).resolves.toEqual([
      expect.objectContaining({ chunkId: "cli_chunk:test-2", sequence: 1 })
    ]);
    await expect(store.updatePaneCliSession(session.sessionId, { status: "EXITED", exitCode: 0, isActive: false })).resolves.toMatchObject({
      status: "EXITED",
      exitCode: 0,
      isActive: false,
      codexThreadId
    });
    await expect(store.touchPaneCliSessionActivity(session.sessionId)).resolves.toBeUndefined();
    await expect(store.updatePaneCliSession(session.sessionId, { codexThreadId: updatedCodexThreadId })).resolves.toMatchObject({
      codexThreadId: updatedCodexThreadId
    });
    await expect(
      store.updatePaneCliSession(session.sessionId, { modelId: "gpt-5.6", reasoningEffort: "xhigh", launchMode: "FRESH" })
    ).resolves.toMatchObject({
      modelId: "gpt-5.6",
      reasoningEffort: "xhigh",
      launchMode: "FRESH"
    });

    const insert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO pane_cli_sessions"));
    expect(insert?.values).toContain("cli:codex");
    expect(insert?.values).toContain(codexThreadId);
    expect(insert?.sql).not.toContain("cli:codex");
    await expect(
      store.appendPaneCliTranscriptChunk({
        sessionId: session.sessionId,
        paneId: session.paneId,
        roomId: session.roomId,
        sequence: 2,
        stream: "stderr",
        content: "password=raw-value"
      })
    ).rejects.toThrow();
  });

  it("lists Space-owned CLI task history with literal search and stable pagination totals", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const qwenPane = await store.createPane(
      { roomId: "room:test-1", title: "Qwen 100% transfer", mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc" },
      "trace:cli-history"
    );
    const otherPane = await store.createPane(
      { roomId: "room:test-1", title: "Other task", mode: "TERMINAL", terminalRuntimeId: "cli:codex", cwd: "/etc" },
      "trace:cli-history"
    );
    const qwenSession = await store.createPaneCliSession({
      sessionId: "cli_session:history-qwen",
      paneId: qwenPane.id,
      roomId: qwenPane.roomId,
      runtimeId: "cli:claude",
      providerId: "claude",
      agentId: "claude",
      modelId: "sonnet",
      reasoningEffort: "high",
      cwd: "/etc"
    });
    const otherSession = await store.createPaneCliSession({
      sessionId: "cli_session:history-other",
      paneId: otherPane.id,
      roomId: otherPane.roomId,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "medium",
      cwd: "/etc"
    });
    await store.appendPaneCliTranscriptChunk({
      sessionId: qwenSession.sessionId,
      paneId: qwenPane.id,
      roomId: qwenPane.roomId,
      sequence: 0,
      stream: "stdin",
      content: "Continue the literal 100% task"
    });
    await store.appendPaneCliTranscriptChunk({
      sessionId: qwenSession.sessionId,
      paneId: qwenPane.id,
      roomId: qwenPane.roomId,
      sequence: 1,
      stream: "stdout",
      content: "Transfer is ready"
    });
    await store.appendPaneCliTranscriptChunk({
      sessionId: otherSession.sessionId,
      paneId: otherPane.id,
      roomId: otherPane.roomId,
      sequence: 0,
      stream: "stdin",
      content: "Unrelated task"
    });

    await expect(store.listPaneCliTaskHistory({ page: 1, pageSize: 10, query: "100%" })).resolves.toEqual({
      items: [
        expect.objectContaining({
          taskId: qwenSession.sessionId,
          paneTitle: "Qwen 100% transfer",
          firstUserMessage: "Continue the literal 100% task",
          preview: "Transfer is ready",
          session: expect.objectContaining({ runtimeId: "cli:claude" })
        })
      ],
      total: 1
    });
    const literalSearch = pool.txClient.calls.find((call) =>
      call.sql.includes("WITH tasks AS") && call.values[0] === "100%"
    );
    expect(literalSearch?.sql).toContain("position($1 in lower(");
    expect(literalSearch?.sql).toContain("s.purpose = 'NORMAL'");
    expect(literalSearch?.values).toEqual(["100%", null, 10, 0]);

    await expect(store.listPaneCliTaskHistory({ page: 3, pageSize: 1 })).resolves.toEqual({
      items: [],
      total: 2
    });
    const countQuery = pool.txClient.calls.find((call) => call.sql.includes("SELECT count(*) AS total") && call.values[0] === "");
    expect(countQuery?.sql).toContain("s.purpose = 'NORMAL'");
    expect(countQuery?.sql).toContain("task.history_hidden_at IS NULL");
  });

  it("purges shared CLI history with an active-session guard and supports rollback", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const taskId = "cli_task:inactive-history";

    await expect(store.listInactivePaneCliTaskIds()).resolves.toEqual([]);
    await expect(store.hideInactivePaneCliTasks([taskId])).resolves.toEqual([]);
    await expect(store.restorePaneCliTasks([taskId])).resolves.toBeUndefined();

    const candidateQuery = pool.txClient.calls.find((call) =>
      call.sql.includes('SELECT task.task_id AS "taskId"') && call.sql.includes("history_hidden_at")
    );
    expect(candidateQuery?.sql).toContain("NOT EXISTS");
    expect(candidateQuery?.sql).toContain("active_session.is_active = true");
    const purgeQuery = pool.txClient.calls.find((call) =>
      call.sql.includes("UPDATE cli_tasks task") && call.sql.includes("history_hidden_at = $2")
    );
    expect(purgeQuery?.sql).toContain("active_session.is_active = true");
    expect(purgeQuery?.values[0]).toEqual([taskId]);
    expect([...pool.calls, ...pool.txClient.calls].some((call) =>
      call.sql.includes("SET history_hidden_at = NULL") &&
      Array.isArray(call.values[0]) &&
      call.values[0][0] === taskId
    )).toBe(true);
  });

  it("allocates the next CLI transcript sequence while holding the session row lock", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const pane = await store.createPane(
      { roomId: "room:test-1", title: "Atomic CLI", mode: "TERMINAL", cwd: "/etc" },
      "trace:atomic-cli"
    );
    const session = await store.createPaneCliSession({
      sessionId: "cli_session:atomic-sequence",
      paneId: pane.id,
      roomId: "room:test-1",
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "medium",
      cwd: "/etc"
    });
    await store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: session.roomId,
      sequence: 7,
      stream: "stdout",
      content: "existing output"
    });

    const callsBeforeAtomicAppend = pool.txClient.calls.length;
    const first = await store.appendPaneCliTranscriptChunkAtNextSequence({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: session.roomId,
      stream: "system",
      content: "first marker"
    });
    const second = await store.appendPaneCliTranscriptChunkAtNextSequence({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: session.roomId,
      stream: "system",
      content: "second marker"
    });

    expect([first.sequence, second.sequence]).toEqual([8, 9]);
    const atomicCalls = pool.txClient.calls.slice(callsBeforeAtomicAppend);
    const sessionLockIndex = atomicCalls.findIndex((call) =>
      call.sql.includes("FROM pane_cli_sessions") && call.sql.includes("FOR UPDATE")
    );
    const nextSequenceIndex = atomicCalls.findIndex((call) => call.sql.includes('AS "nextSequence"'));
    expect(sessionLockIndex).toBeGreaterThanOrEqual(0);
    expect(nextSequenceIndex).toBeGreaterThan(sessionLockIndex);
  });

  it("retries CLI session creation once after a PostgreSQL deadlock", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const cliPane = await store.createPane(
      { roomId: "room:test-1", title: "Codex CLI", mode: "TERMINAL", cwd: "/opt/spaceapp" },
      "trace:cli-deadlock"
    );
    pool.txClient.calls.length = 0;
    pool.txClient.failNextQuery(
      "UPDATE pane_cli_sessions SET is_active = false",
      Object.assign(new Error("deadlock detected"), { code: "40P01" })
    );

    await expect(
      store.createPaneCliSession({
        sessionId: "cli_session:deadlock-retry",
        paneId: cliPane.id,
        roomId: "room:test-1",
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: "gpt-5.5",
        reasoningEffort: "high",
        cwd: "/opt/spaceapp"
      })
    ).resolves.toMatchObject({ sessionId: "cli_session:deadlock-retry", isActive: true });

    expect(pool.txClient.calls.filter((call) => call.sql === "BEGIN")).toHaveLength(2);
    expect(pool.txClient.calls.filter((call) => call.sql === "ROLLBACK")).toHaveLength(1);
    expect(pool.txClient.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
  });

  it("retries CLI transcript append once after a PostgreSQL deadlock", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const cliPane = await store.createPane(
      { roomId: "room:test-1", title: "Codex CLI", mode: "TERMINAL", cwd: "/opt/spaceapp" },
      "trace:cli-transcript-deadlock"
    );
    const session = await store.createPaneCliSession({
      sessionId: "cli_session:transcript-deadlock-retry",
      paneId: cliPane.id,
      roomId: "room:test-1",
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/opt/spaceapp"
    });
    pool.txClient.calls.length = 0;
    pool.txClient.failNextQuery(
      "INSERT INTO pane_cli_transcript_chunks",
      Object.assign(new Error("deadlock detected"), { code: "40P01" })
    );

    await expect(store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: cliPane.id,
      roomId: "room:test-1",
      sequence: 0,
      stream: "system",
      content: "Session allocation marker."
    })).resolves.toMatchObject({ sessionId: session.sessionId, sequence: 0 });

    expect(pool.txClient.calls.filter((call) => call.sql === "BEGIN")).toHaveLength(2);
    expect(pool.txClient.calls.filter((call) => call.sql === "ROLLBACK")).toHaveLength(1);
    expect(pool.txClient.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
  });

  it("retries room deletion once after a PostgreSQL deadlock on the cascading pane cleanup", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    pool.txClient.calls.length = 0;
    pool.txClient.failNextQuery(
      "DELETE FROM rooms",
      Object.assign(new Error("deadlock detected"), { code: "40P01" })
    );

    await expect(store.deleteRoom("room:test-deadlock-delete")).resolves.toMatchObject({
      id: "room:test-1",
      name: "Existing"
    });

    expect(pool.txClient.calls.filter((call) => call.sql === "BEGIN")).toHaveLength(2);
    expect(pool.txClient.calls.filter((call) => call.sql === "ROLLBACK")).toHaveLength(1);
    expect(pool.txClient.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
    expect(pool.txClient.calls.some((call) => call.sql.includes("DELETE FROM rooms"))).toBe(true);
  });

  it("keeps new and reopened panes at the active tail order", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const first = await store.createPane({ roomId: "room:test-1", title: "First", mode: "CHAT" }, "trace:order");
    const second = await store.createPane({ roomId: "room:test-1", title: "Second", mode: "CHAT" }, "trace:order");
    const third = await store.createPane({ roomId: "room:test-1", title: "Third", mode: "CHAT" }, "trace:order");

    await expect(store.updatePane(second.id, { isClosed: true, status: "CLOSED" }, "trace:order")).resolves.toMatchObject({
      isClosed: true
    });

    const createdAfterClose = await store.createPane({ roomId: "room:test-1", title: "Fourth", mode: "CHAT" }, "trace:order");
    expect(createdAfterClose.order).toBe(3);

    const reopened = await store.updatePane(second.id, { isClosed: false, status: "IDLE" }, "trace:order");
    expect(reopened.order).toBe(4);

    await expect(store.listPanes("room:test-1")).resolves.toEqual([
      expect.objectContaining({ id: first.id, title: "First", order: 0 }),
      expect.objectContaining({ id: third.id, title: "Third", order: 2 }),
      expect.objectContaining({ id: createdAfterClose.id, title: "Fourth", order: 3 }),
      expect.objectContaining({ id: second.id, title: "Second", order: 4 })
    ]);
  });

  it("moves panes to another room in place and resets their layout", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const sourceRoom = await store.createRoom({ name: "Source", initialPaneCount: 0 }, "trace:move-source");
    const targetRoom = await store.createRoom({ name: "Target", initialPaneCount: 0 }, "trace:move-target");
    const pane = await store.createPane(
      {
        roomId: sourceRoom.id,
        title: "CLI Root",
        mode: "TERMINAL",
        cwd: "/etc",
        terminalRuntimeId: "cli:root"
      },
      "trace:move"
    );
    await store.updatePane(pane.id, { providerId: "codex-lb", modelId: "gpt-5.5", reasoningEffort: "high" }, "trace:move-settings");

    const moved = await store.movePane(pane.id, { targetRoomId: targetRoom.id }, "trace:move");

    expect(moved.sourcePane).toMatchObject({
      id: pane.id,
      roomId: sourceRoom.id,
      status: "IDLE",
      isClosed: false
    });
    expect(moved.targetPane).toMatchObject({
      id: pane.id,
      roomId: targetRoom.id,
      title: "CLI Root",
      status: "IDLE",
      providerId: "codex-lb",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      cwd: "/etc",
      terminalRuntimeId: "cli:root",
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false
    });
    await expect(store.listPanes(sourceRoom.id)).resolves.toEqual([]);
    await expect(store.listPanes(targetRoom.id)).resolves.toEqual([
      expect.objectContaining({ id: moved.targetPane.id, title: "CLI Root", terminalRuntimeId: "cli:root" })
    ]);

    const paneMoveUpdate = pool.txClient.calls.find(
      (call) => call.sql.includes("UPDATE panes") && call.sql.includes("SET room_id = $2")
    );
    expect(paneMoveUpdate?.values).toEqual([
      pane.id,
      targetRoom.id,
      0,
      JSON.stringify({ parentId: null, direction: null, size: null }),
      expect.any(String),
      "Andy"
    ]);
  });

  it("moves panes with active CLI sessions and keeps transcript appends working", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const sourceRoom = await store.createRoom({ name: "Source", initialPaneCount: 0 }, "trace:cli-source");
    const targetRoom = await store.createRoom({ name: "Target", initialPaneCount: 0 }, "trace:cli-target");
    const pane = await store.createPane({ roomId: sourceRoom.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/opt/spaceapp" }, "trace:cli-move");

    const session = await store.createPaneCliSession({
      sessionId: "cli_session:move-test",
      paneId: pane.id,
      roomId: sourceRoom.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp"
    });
    await store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: sourceRoom.id,
      sequence: 0,
      stream: "stdout",
      content: "before move",
      byteLength: 11
    });

    const moved = await store.movePane(pane.id, { targetRoomId: targetRoom.id }, "trace:cli-move");
    const appended = await store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: sourceRoom.id,
      sequence: 1,
      stream: "stdout",
      content: "after move",
      byteLength: 10
    });

    expect(moved.targetPane).toMatchObject({ id: pane.id, roomId: targetRoom.id });
    await expect(store.getActivePaneCliSession(pane.id)).resolves.toMatchObject({
      sessionId: session.sessionId,
      roomId: targetRoom.id
    });
    expect(appended.roomId).toBe(targetRoom.id);
    await expect(store.listPaneCliTranscriptChunks(session.sessionId, 10)).resolves.toEqual([
      expect.objectContaining({ sequence: 0, roomId: targetRoom.id }),
      expect.objectContaining({ sequence: 1, roomId: targetRoom.id })
    ]);
  });

  it("moves panes with active Space agent sessions in place", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const sourceRoom = await store.createRoom({ name: "Source", initialPaneCount: 0 }, "trace:agent-source");
    const targetRoom = await store.createRoom({ name: "Target", initialPaneCount: 0 }, "trace:agent-target");
    const pane = await store.createPane({ roomId: sourceRoom.id, title: "Planner", mode: "CHAT" }, "trace:agent-pane");

    const session = await store.createSpaceAgentSession({
      sessionId: "agent_session:move-test",
      paneId: pane.id,
      roomId: sourceRoom.id,
      title: "Planner",
      threadId: "thread:planner",
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.5",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "Codex LB",
      selectedModelName: "GPT-5.5",
      selectedReasoningKey: "medium",
      selectedToolIds: ["mcp:github"]
    });
    const promptMessage = await store.createSpaceAgentMessage({
      messageId: "agent_msg:prompt",
      sessionId: session.sessionId,
      role: "user",
      content: "Move me to another room."
    });
    const responseMessage = await store.createSpaceAgentMessage({
      messageId: "agent_msg:response",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const run = await store.createSpaceAgentRun({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: sourceRoom.id,
      workflowId: "workflow:move-agent",
      temporalRunId: "run:move-agent",
      status: "RUNNING",
      promptMessageId: promptMessage.messageId,
      responseMessageId: responseMessage.messageId,
      codexThreadId: "thread:planner",
      codexTurnId: null
    });

    await store.movePane(pane.id, { targetRoomId: targetRoom.id }, "trace:agent-move");

    await expect(store.getActiveSpaceAgentSession(pane.id)).resolves.toMatchObject({
      sessionId: session.sessionId,
      roomId: targetRoom.id
    });
    await expect(store.getLatestSpaceAgentRun(session.sessionId)).resolves.toMatchObject({
      runId: run.runId,
      roomId: targetRoom.id
    });
    await expect(store.listSpaceAgentHistory(sourceRoom.id)).resolves.toEqual([]);
    await expect(store.listSpaceAgentHistory(targetRoom.id)).resolves.toEqual([
      expect.objectContaining({ sessionId: session.sessionId, roomId: targetRoom.id, paneId: pane.id })
    ]);
  });

  it("rejects duplicate active Codex thread ownership across different panes", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const firstPane = await store.createPane({ roomId: "room:test-1", title: "CLI 1", mode: "TERMINAL", cwd: "/etc" }, "trace:owners");
    const secondPane = await store.createPane({ roomId: "room:test-1", title: "CLI 2", mode: "TERMINAL", cwd: "/etc" }, "trace:owners");
    const codexThreadId = "019f467b-ce39-7080-817a-891658a17a0f";

    const owner = await store.createPaneCliSession({
      sessionId: "cli_session:owner",
      paneId: firstPane.id,
      roomId: "room:test-1",
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "medium",
      cwd: "/etc",
      codexThreadId,
      status: "RUNNING",
      isActive: true
    });
    const claimant = await store.createPaneCliSession({
      sessionId: "cli_session:claimant",
      paneId: secondPane.id,
      roomId: "room:test-1",
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "medium",
      cwd: "/etc",
      status: "RUNNING",
      isActive: true
    });

    await expect(store.getActivePaneCliSessionByCodexThreadId(codexThreadId)).resolves.toMatchObject({
      sessionId: owner.sessionId
    });
    await expect(store.updatePaneCliSession(claimant.sessionId, { codexThreadId })).rejects.toBeInstanceOf(SpaceConflictError);
    await expect(
      store.createPaneCliSession({
        sessionId: "cli_session:duplicate",
        paneId: secondPane.id,
        roomId: "room:test-1",
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: null,
        reasoningEffort: "medium",
        cwd: "/etc",
        codexThreadId,
        status: "RUNNING",
        isActive: true
      })
    ).rejects.toBeInstanceOf(SpaceConflictError);
  });

  it("replaces explicit history-transfer ownership when a fork auto-binds its new thread", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const pane = await store.createPane(
      { roomId: "room:test-1", title: "CLI fork", mode: "TERMINAL", cwd: "/etc" },
      "trace:fork-owner"
    );
    const sourceThreadId = "019f4e26-6780-778a-9acd-c72c780a634a";
    const forkedThreadId = "019f4e27-6780-778a-9acd-c72c780a634b";
    const session = await store.createPaneCliSession({
      sessionId: "cli_session:fork-owner",
      paneId: pane.id,
      roomId: pane.roomId,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: null,
      status: "RUNNING",
      isActive: true
    });

    await store.claimPaneCliCodexThread(session.sessionId, sourceThreadId, "HISTORY_TRANSFER", "trace:history-transfer");
    await store.claimPaneCliCodexThread(session.sessionId, forkedThreadId, "AUTO", "trace:fork-auto-bind");

    await expect(store.getPaneCliCodexThreadOwnership(sourceThreadId)).resolves.toBeNull();
    await expect(store.getPaneCliCodexThreadOwnership(forkedThreadId)).resolves.toMatchObject({
      cliSessionId: session.sessionId,
      source: "AUTO"
    });
    await expect(store.getPaneCliSession(session.sessionId)).resolves.toMatchObject({ codexThreadId: forkedThreadId });
    expect(
      pool.txClient.calls.some(
        (call) =>
          call.sql.includes("DELETE FROM pane_cli_codex_thread_ownerships") &&
          call.values[0] === sourceThreadId &&
          call.values[1] === session.sessionId
      )
    ).toBe(true);
  });

  it.each([null, "cli_session:retained-owner"])(
    "handles a retained native revision with latest session %s before automatic binding",
    async (latestSpaceSessionId) => {
      const pool = new FakePgPool();
      const store = new PostgresSpaceStore(pool);
      const threadId = "019f4e26-6780-778a-9acd-c72c780a634a";
      const retained = await store.createCliTaskRevision({
        revisionId: "revision:retained", taskId: "task:retained", runtimeId: "cli:codex",
        providerId: "codex", agentId: "codex", nativeTaskRef: threadId,
        sourceRevisionId: null, latestSpaceSessionId, displayTitle: "Retained task",
        firstUserMessage: "Keep my history", preview: "Previous progress", cwd: "/etc",
        modelId: "gpt-5.6-sol", reasoningEffort: "high"
      });
      const pane = await store.createPane({ roomId: "room:test-1", title: "CLI", mode: "TERMINAL", cwd: "/etc" });
      const session = await store.createPaneCliSession({
        sessionId: "cli_session:reattach", paneId: pane.id, roomId: pane.roomId,
        runtimeId: "cli:codex", providerId: "codex", agentId: "codex", modelId: "gpt-5.6-sol",
        reasoningEffort: "high", cwd: "/etc", codexThreadId: null, status: "RUNNING", isActive: true
      });
      if (latestSpaceSessionId) {
        await expect(store.claimPaneCliCodexThread(session.sessionId, threadId, "AUTO"))
          .rejects.toBeInstanceOf(SpaceConflictError);
        await expect(store.getPaneCliSession(session.sessionId)).resolves.toMatchObject({
          codexThreadId: null, cliTaskId: session.cliTaskId
        });
        await expect(store.getCliTaskRevision(retained.revisionId)).resolves.toEqual(retained);
        return;
      }
      await store.claimPaneCliCodexThread(session.sessionId, threadId, "AUTO");
      await store.claimPaneCliCodexThread(session.sessionId, threadId, "AUTO");
      await expect(store.getPaneCliSession(session.sessionId)).resolves.toMatchObject({
        codexThreadId: threadId, cliTaskId: retained.taskId, cliTaskRevisionId: retained.revisionId,
        status: "RUNNING", isActive: true
      });
      await expect(store.getCliTaskRevision(retained.revisionId)).resolves.toMatchObject({
        nativeTaskRef: threadId, latestSpaceSessionId: session.sessionId,
        firstUserMessage: "Keep my history", preview: "Previous progress"
      });
      await expect(store.getCliTaskRevision(session.cliTaskRevisionId!)).resolves.toMatchObject({
        nativeTaskRef: null, latestSpaceSessionId: null
      });
    }
  );

  it("transfers a native task reference across legacy logical tasks only for explicit history resume", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const sourcePane = await store.createPane(
      { roomId: "room:test-1", title: "Source CLI", mode: "TERMINAL", cwd: "/etc" },
      "trace:native-source"
    );
    const targetPane = await store.createPane(
      { roomId: "room:test-1", title: "Target CLI", mode: "TERMINAL", cwd: "/etc" },
      "trace:native-target"
    );
    const source = await store.createPaneCliSession({
      sessionId: "cli_session:native-source",
      paneId: sourcePane.id,
      roomId: sourcePane.roomId,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: null,
      status: "RUNNING",
      isActive: true
    });
    const target = await store.createPaneCliSession({
      sessionId: "cli_session:native-target",
      paneId: targetPane.id,
      roomId: targetPane.roomId,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: null,
      status: "RUNNING",
      isActive: true
    });
    const threadId = "019f4e26-6780-778a-9acd-c72c780a634a";

    await store.claimPaneCliCodexThread(source.sessionId, threadId, "AUTO", "trace:native-source");
    await store.updatePaneCliSession(source.sessionId, { status: "EXITED", isActive: false });
    await expect(
      store.claimPaneCliCodexThread(target.sessionId, threadId, "AUTO", "trace:native-auto-rejected")
    ).rejects.toThrow(/permanently owned/);
    await expect(store.getCliTaskRevision(source.sessionId)).resolves.toMatchObject({ nativeTaskRef: threadId });
    await expect(store.getCliTaskRevision(target.sessionId)).resolves.toMatchObject({ nativeTaskRef: null });
    await store.claimPaneCliCodexThread(target.sessionId, threadId, "HISTORY_TRANSFER", "trace:native-transfer");

    expect(source.cliTaskRevisionId).toBe(source.sessionId);
    expect(target.cliTaskRevisionId).toBe(target.sessionId);
    await expect(store.getCliTaskRevision(source.sessionId)).resolves.toMatchObject({ nativeTaskRef: null });
    await expect(store.getCliTaskRevision(target.sessionId)).resolves.toMatchObject({ nativeTaskRef: threadId });
    await expect(store.getPaneCliCodexThreadOwnership(threadId)).resolves.toMatchObject({
      cliSessionId: target.sessionId,
      source: "HISTORY_TRANSFER"
    });
  });

  it("persists pane column spans on create and update", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const pane = await store.createPane({ roomId: "room:test-1", title: "Review", mode: "REVIEW" }, "trace:pane");
    expect(pane.columnSpan).toBe(1);

    const updated = await store.updatePane(pane.id, { columnSpan: 3 }, "trace:pane");
    expect(updated.columnSpan).toBe(3);
    await expect(store.listPanes("room:test-1", true)).resolves.toEqual([
      expect.objectContaining({ id: pane.id, columnSpan: 3 })
    ]);

    const update = pool.txClient.calls.find((call) => call.sql.includes("column_span = $12"));
    expect(update?.values).toContain(3);
    expect(update?.sql).not.toMatch(/column_span\s*=\s*3\b/);
  });

  it("round-trips minimized pane state and enforces maximize exclusivity", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const pane = await store.createPane({ roomId: "room:test-1", title: "Browser", mode: "BROWSER" }, "trace:layout");

    expect(pane).toMatchObject({ isMaximized: false, isMinimized: false });
    await expect(store.updatePane(pane.id, { isMaximized: true }, "trace:maximize")).resolves.toMatchObject({
      isMaximized: true,
      isMinimized: false
    });
    await expect(store.updatePane(pane.id, { isMinimized: true }, "trace:minimize")).resolves.toMatchObject({
      isMaximized: false,
      isMinimized: true
    });
    await expect(store.listPanes("room:test-1", true)).resolves.toEqual([
      expect.objectContaining({ id: pane.id, isMaximized: false, isMinimized: true })
    ]);
    const update = pool.txClient.calls.find((call) => call.sql.includes("is_minimized = $14") && call.values[13] === true);
    expect(update?.values[13]).toBe(true);
  });

  it("assigns sequential unique pane names per room and reuses released names", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const p1 = await store.createPane({ roomId: "room:test-1", title: "CLI 1", mode: "CHAT" });
    const p2 = await store.createPane({ roomId: "room:test-1", title: "CLI 2", mode: "CHAT" });
    expect(p1.paneName).toBe("Andy");
    expect(p2.paneName).toBe("Bob");

    await store.updatePane(p1.id, { isClosed: true });
    const p3 = await store.createPane({ roomId: "room:test-1", title: "CLI 3", mode: "CHAT" });
    expect(p3.paneName).toBe("Andy");
  });

  it("records and searches memory entries with redaction and parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const record = await store.createMemoryEntry(
      {
        scope: "ROOM",
        roomId: "room:test-1",
        title: "Storage blocker",
        body: "Dedicated storage is required. token=raw-test-value must not persist.",
        provenance: "operator"
      },
      "trace:memory"
    );

    expect(record.entry.id).toMatch(/^memory:/);
    expect(record.entry.body).toContain("[REDACTED]");
    expect(record.entry.body).not.toContain("raw-test-value");
    expect(record.event.type).toBe("MEMORY_SAVED");

    const insert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO memory_records"));
    expect(insert?.sql).not.toContain("raw-test-value");
    expect(insert?.sql).toContain("embedding");
    expect(insert?.values).toContain("Storage blocker");
    expect(insert?.values.some((value) => typeof value === "string" && value.includes("raw-test-value"))).toBe(false);

    const results = await store.listMemoryEntries({ page: 1, pageSize: 25, sortOrder: "desc", q: "storage" });
    expect(results).toEqual([record.entry]);
    await store.listMemoryEntries({ page: 1, pageSize: 25, sortOrder: "desc" }, { limit: 1 });
    const boundedQuery = pool.txClient.calls.find((call) => call.sql.includes("FROM memory_records") && call.sql.includes("LIMIT"));
    expect(boundedQuery?.values.at(-1)).toBe(1);
    await expect(
      store.listMemoryEntries({ page: 1, pageSize: 25, sortOrder: "desc", q: "storage", searchMode: "semantic" })
    ).rejects.toThrow(SpaceFeatureDisabledError);

    await store.listMemoryEntries(
      { page: 1, pageSize: 25, sortOrder: "desc", q: "storage", searchMode: "semantic" },
      { semanticReady: true, queryEmbedding: [0.1, 0.2, 0.3] }
    );
    const semanticQuery = pool.txClient.calls.find((call) => call.sql.includes("embedding <=>"));
    expect(semanticQuery?.sql).toContain("embedding IS NOT NULL");
    expect(semanticQuery?.values).toContain("[0.1,0.2,0.3]");
  });

  it("records skill proposals as disabled persisted catalog entries", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const record = await store.createSkillProposal(
      {
        displayName: "Browser QA",
        version: "0.1.0",
        triggerDescription: "Use after UI changes.",
        body: "Capture browser evidence. token=raw-test-value must not persist.",
        allowedTools: ["browser.collectConsole", "browser.captureScreenshot", "browser.collectConsole"]
      },
      "trace:skill"
    );

    expect(record.skill.id).toMatch(/^skill:/);
    expect(record.skill.status).toBe("DISABLED");
    expect(record.skill.source).toBe("OPERATOR_PROPOSAL");
    expect(record.skill.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record.skill.allowedTools).toEqual(["browser.captureScreenshot", "browser.collectConsole"]);
    expect(record.skill.body).toContain("[REDACTED]");
    expect(record.event).toMatchObject({
      type: "SKILL_PROPOSED",
      payload: { skillId: record.skill.id, status: "DISABLED", allowedToolCount: 2 }
    });

    const insert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO skills"));
    expect(insert?.sql).not.toContain("raw-test-value");
    expect(insert?.values.some((value) => typeof value === "string" && value.includes("raw-test-value"))).toBe(false);

    const skills = await store.listSkills();
    expect(skills[0]).toEqual(record.skill);
  });

  it("adds read-only Codex filesystem skills to the Postgres catalog without persisting copies", async () => {
    const root = mkdtempSync(join(tmpdir(), "space-db-skill-roots-"));
    const skillDir = join(root, "skills", "api-and-interface-design");
    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: api-and-interface-design",
          "description: Designs stable API boundaries.",
          "---",
          "",
          "# API Design"
        ].join("\n")
      );
      const pool = new FakePgPool();
      const store = new PostgresSpaceStore(pool, { codexSkillRoots: [join(root, "skills")], codexPluginSkillRoots: [] });

      const skills = await store.listSkills();
      expect(skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "api-and-interface-design",
            source: "CODEX_SKILL",
            status: "VERIFIED",
            triggerDescription: "Designs stable API boundaries."
          })
        ])
      );
      expect(pool.calls.filter((call) => call.sql.includes("INSERT INTO skills"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records explicit import candidates and imports native memory only after approval", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const staged = await store.createImportCandidate(
      {
        sourceKind: "CODEX_MEMORY",
        targetKind: "MEMORY",
        sourceRef: "operator-paste token=raw-test-value",
        roomId: "room:test-1",
        memoryScope: "ROOM",
        title: "Imported storage note",
        body: "Dedicated storage is required. token=raw-test-value",
        provenance: "explicit-import-gate"
      },
      "trace:import"
    );

    expect(staged.candidate.id).toMatch(/^import:/);
    expect(staged.candidate.status).toBe("PENDING");
    expect(staged.candidate.sourceRef).toContain("[REDACTED]");
    expect(staged.candidate.body).toContain("[REDACTED]");
    expect(staged.event.type).toBe("IMPORT_CANDIDATE_CREATED");

    const insert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO import_candidates"));
    expect(insert?.sql).not.toContain("raw-test-value");
    expect(insert?.values.some((value) => typeof value === "string" && value.includes("raw-test-value"))).toBe(false);

    const decided = await store.decideImportCandidate(staged.candidate.id, { decision: "IMPORT", reason: "Approved" }, "trace:import");
    expect(decided.candidate.status).toBe("IMPORTED");
    expect(decided.memoryEntry?.id).toMatch(/^memory:/);
    expect(decided.skill).toBeNull();
    expect(decided.events.map((event) => event.type)).toEqual(["MEMORY_SAVED", "IMPORT_CANDIDATE_DECIDED"]);
    expect(decided.candidate.importedMemoryId).toBe(decided.memoryEntry?.id);
    expect(JSON.stringify(decided)).not.toContain("raw-test-value");

    const imported = await store.listImportCandidates({ page: 1, pageSize: 25, sortOrder: "desc", status: "IMPORTED" });
    expect(imported[0]).toEqual(decided.candidate);
  });

  it("records review decisions with redaction and parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const fakeToken = "to" + "ken=raw-test-value";
    const fakeApiKey = "api" + "_key=raw-test-value";

    const record = await store.createReviewDecision(
      {
        roomId: "room:test-1",
        workflowId: "workflow:test-1",
        decision: "BLOCK",
        summary: `Tests failed. ${fakeToken} must not persist.`,
        evidenceArtifactIds: ["artifact:test-1", "artifact:test-1"],
        rollbackNote: `Rollback ${fakeApiKey}.`
      },
      "trace:review"
    );

    expect(record.decision.id).toMatch(/^review:/);
    expect(record.decision.summary).toContain("[REDACTED]");
    expect(record.decision.rollbackNote).toContain("[REDACTED]");
    expect(record.decision.evidenceArtifactIds).toEqual(["artifact:test-1"]);
    expect(record.event).toMatchObject({
      type: "REVIEW_DECISION_CREATED",
      payload: { reviewDecisionId: record.decision.id, decision: "BLOCK", evidenceArtifactCount: 1 }
    });

    const insert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO review_decisions"));
    expect(insert?.sql).not.toContain("raw-test-value");
    expect(insert?.values.some((value) => typeof value === "string" && value.includes("raw-test-value"))).toBe(false);

    const results = await store.listReviewDecisions({ page: 1, pageSize: 25, sortOrder: "desc", roomId: "room:test-1" });
    expect(results).toEqual([record.decision]);
    await store.listReviewDecisions({ page: 1, pageSize: 25, sortOrder: "asc", roomId: "room:test-1" });
    expect(pool.txClient.calls.at(-1)?.sql).toContain("ORDER BY created_at ASC");
  });

  it("persists memory change-set transitions and rollback links with parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    await store.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
    const input = {
      kind: "EDIT" as const,
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      recordIds: ["memory_graph_record:first"],
      resolvesIssueIds: ["memory_graph_issue:stale"],
      expectedSourceHash: "a".repeat(64),
      beforeContentHash: hashMemorySnapshot("before\n"),
      afterContentHash: hashMemorySnapshot("after\n"),
      beforeSnapshot: "before\n",
      afterSnapshot: "after\n",
      reason: "Remove stale wording. token=raw-test-value",
      actorUserId: "user:operator"
    };

    const proposed = await store.createMemoryChangeSet(input, "trace:memory-change");
    expect(proposed).toMatchObject({ status: "PROPOSED", resultingSourceHash: null, traceId: "trace:memory-change" });
    expect(proposed.reason).toContain("[REDACTED]");
    const stableStore = new PostgresSpaceStore(new FakePgPool());
    await stableStore.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
    const stable = await stableStore.createMemoryChangeSet(input, "trace:stable", { id: "memory_change:stable-create" });
    expect(stable.id).toBe("memory_change:stable-create");
    expect(await stableStore.createMemoryChangeSet(input, "trace:retry", { id: stable.id })).toEqual(stable);
    await expect(stableStore.createMemoryChangeSet(
      { ...input, reason: "A different request." },
      "trace:collision",
      { id: stable.id }
    )).rejects.toThrow(SpaceConflictError);
    const insert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO memory_graph_change_sets"));
    expect(insert?.sql).not.toContain("raw-test-value");
    expect(insert?.values.some((value) => typeof value === "string" && value.includes("raw-test-value"))).toBe(false);
    await expect(store.createMemoryChangeSet({ ...input, afterSnapshot: "tampered\n" })).rejects.toThrow(SpaceConflictError);

    await expect(
      store.createMemoryChangeSet({
        ...input,
        kind: "ROLLBACK",
        rollbackOfChangeSetId: proposed.id,
        expectedSourceHash: "d".repeat(64),
        beforeContentHash: input.afterContentHash,
        afterContentHash: input.beforeContentHash,
        beforeSnapshot: input.afterSnapshot,
        afterSnapshot: input.beforeSnapshot,
        reason: "A proposed operation must not be rollback-eligible."
      })
    ).rejects.toThrow(SpaceConflictError);

    await expect(
      store.updateMemoryChangeSet(proposed.id, { status: "APPLIED", resultingSourceHash: "d".repeat(64) })
    ).rejects.toThrow(SpaceConflictError);
    await store.updateMemoryChangeSet(proposed.id, { status: "APPROVED" });
    await store.updateMemoryChangeSet(proposed.id, { status: "APPLYING" });
    const applied = await store.updateMemoryChangeSet(proposed.id, {
      status: "APPLIED",
      resultingSourceHash: "d".repeat(64)
    });
    expect(applied.status).toBe("APPLIED");

    const rollback = await store.createMemoryChangeSet({
      ...input,
      kind: "ROLLBACK",
      rollbackOfChangeSetId: proposed.id,
      expectedSourceHash: "d".repeat(64),
      beforeContentHash: input.afterContentHash,
      afterContentHash: input.beforeContentHash,
      beforeSnapshot: input.afterSnapshot,
      afterSnapshot: input.beforeSnapshot,
      reason: "Restore the audited before snapshot."
    });
    await store.updateMemoryChangeSet(rollback.id, { status: "APPROVED" });
    await store.updateMemoryChangeSet(rollback.id, { status: "APPLYING" });
    await store.updateMemoryChangeSet(rollback.id, { status: "APPLIED", resultingSourceHash: proposed.expectedSourceHash });

    expect(
      await store.listMemoryChangeSets({ status: "ROLLED_BACK", page: 1, pageSize: 25, sortOrder: "desc" })
    ).toEqual([expect.objectContaining({ id: proposed.id, rolledBackByChangeSetId: rollback.id })]);
    expect(
      await store.listMemoryChangeSets({ issueId: "memory_graph_issue:stale", page: 1, pageSize: 25, sortOrder: "desc" })
    ).toHaveLength(2);
    expect(
      await store.listMemoryChangeSets({ rollbackOfChangeSetId: proposed.id, page: 1, pageSize: 25, sortOrder: "desc" })
    ).toEqual([expect.objectContaining({ id: rollback.id })]);
    expect((await store.listMemoryChangeSets())[0]).not.toHaveProperty("beforeSnapshot");
  });

  it("persists cache links, issue overlays, consolidation state and idempotency with parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const fakeToken = "to" + "ken=raw-test-value";
    await store.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
    const cached = (await store.createMemoryEntry({
      scope: "SYSTEM",
      title: "Canonical cache row",
      body: "Cached body",
      provenance: "memory-graph-test"
    })).entry;
    const link = await store.linkMemoryCacheRecord({
      memoryRecordId: cached.id,
      canonicalMemoryId: "memory:canonical-record",
      linkSource: "EXACT_BACKFILL"
    });
    expect(await store.getMemoryCacheLink(cached.id)).toEqual(link);
    expect(await store.listMemoryCacheLinks({ memoryRecordIds: [cached.id], limit: 1 })).toEqual([link]);
    const batchLinkQuery = pool.txClient.calls.find((call) => call.sql.includes("canonical_memory_id IS NOT NULL") && call.sql.includes("ANY"));
    expect(batchLinkQuery?.values).toEqual([[cached.id], 1]);

    const issue = await store.upsertMemoryIssueState({
      issueId: "memory_issue:duplicate",
      issueType: "EXACT_DUPLICATE",
      recordId: "memory:canonical-record",
      sourceHash: "a".repeat(64),
      status: "IGNORED",
      reason: `Reviewed duplicate. ${fakeToken}`,
      actorUserId: "user:operator"
    });
    const resolved = await store.upsertMemoryIssueState({
      issueId: issue.issueId,
      issueType: issue.issueType,
      recordId: issue.recordId,
      sourceHash: issue.sourceHash,
      status: "RESOLVED",
      reason: "Resolved after review.",
      actorUserId: "user:operator",
      expectedVersion: issue.version
    });
    expect(resolved.version).toBe(2);
    expect(await store.listMemoryIssueStates({
      issueIds: [resolved.issueId],
      page: 1,
      pageSize: 500,
      sortOrder: "desc"
    })).toEqual([resolved]);
    const batchIssueQuery = pool.txClient.calls.find((call) =>
      call.sql.includes("FROM memory_graph_issue_states") && call.sql.includes("issue_id = ANY")
    );
    expect(batchIssueQuery?.values[0]).toEqual([resolved.issueId]);

    const run = await store.createMemoryConsolidationRun({
      mode: "AUDIT",
      triggerKind: "OPERATOR",
      workflowId: "workflow:memory-consolidation-1",
      dedupeKey: "operator:memory-consolidation-1",
      actorUserId: "user:operator",
      sourceHash: "a".repeat(64)
    });
    expect(await store.createMemoryConsolidationRun({
      mode: "AUDIT",
      triggerKind: "OPERATOR",
      workflowId: "workflow:memory-consolidation-1",
      dedupeKey: "operator:memory-consolidation-1",
      actorUserId: "user:operator",
      sourceHash: "a".repeat(64)
    })).toEqual(run);
    expect(pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO memory_consolidation_runs"))?.sql)
      .toContain("ON CONFLICT (dedupe_key)");
    await store.updateMemoryConsolidationRun(run.id, { status: "RUNNING", progressCompleted: 0, progressTotal: 1 });
    const finding = await store.createMemoryConsolidationFinding({
      runId: run.id,
      issueId: issue.issueId,
      findingType: "EXACT_DUPLICATE",
      severity: "WARN",
      confidence: 1,
      recordIds: ["memory:canonical-record"],
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      evidence: `Exact content hashes match. ${fakeToken}`
    });
    const operation = await store.createMemoryConsolidationOperation({
      runId: run.id,
      findingId: finding.id,
      operationKind: "REPORT_ISSUE",
      recordIds: ["memory:canonical-record"],
      reason: "Retain for operator review."
    });
    await store.updateMemoryConsolidationOperation(operation.id, { status: "APPLYING" });
    await store.updateMemoryConsolidationOperation(operation.id, { status: "APPLIED" });
    await store.updateMemoryConsolidationFinding(finding.id, { status: "APPLIED" });
    const succeeded = await store.updateMemoryConsolidationRun(run.id, {
      status: "SUCCEEDED",
      progressCompleted: 1,
      progressTotal: 1,
      findingCount: 1,
      appliedOperationCount: 1
    });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(await store.listMemoryConsolidationFindings(run.id, 1)).toHaveLength(1);
    expect(await store.listMemoryConsolidationOperations(run.id, 1)).toHaveLength(1);
    expect(pool.txClient.calls.at(-2)?.sql).toContain("LIMIT $2");
    expect(pool.txClient.calls.at(-1)?.sql).toContain("LIMIT $2");

    const command = {
      commandScope: "memory.consolidation.create",
      actorKey: "user:operator",
      idempotencyKeyHash: "b".repeat(64),
      requestHash: "c".repeat(64),
      resourceType: "memory_consolidation",
      resourceId: run.id,
      workflowId: run.workflowId
    };
    expect((await store.claimMemoryCommand(command)).created).toBe(true);
    expect((await store.claimMemoryCommand(command)).created).toBe(false);
    await expect(store.claimMemoryCommand({ ...command, requestHash: "d".repeat(64) })).rejects.toThrow(SpaceConflictError);

    const durableCalls = pool.txClient.calls.filter((call) => call.sql.includes("memory_") || call.sql.includes("canonical_memory_id"));
    expect(durableCalls.every((call) => call.values.every((value) =>
      typeof value !== "string" || !value.includes("raw-test-value")
    ))).toBe(true);
  });

  it("records review checks and diff summaries with redaction and parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const fakeToken = "to" + "ken=raw-test-value";
    const fakeSecret = "sec" + "ret=raw-test-value";

    const check = await store.createReviewCheck(
      {
        roomId: "room:test-1",
        reviewDecisionId: "review:test-1",
        name: "npm test",
        status: "PASS",
        command: `npm test ${fakeToken}`,
        summary: `All tests passed. ${fakeSecret}`,
        artifactIds: ["artifact:test-1", "artifact:test-1"],
        metadata: { suite: "unit", token: fakeToken }
      },
      "trace:review"
    );

    expect(check.check.id).toMatch(/^review_check:/);
    expect(check.check.command).toContain("[REDACTED]");
    expect(check.check.summary).toContain("[REDACTED]");
    expect(check.check.artifactIds).toEqual(["artifact:test-1"]);
    expect(JSON.stringify(check.check.metadata)).not.toContain("raw-test-value");
    expect(check.event).toMatchObject({
      type: "REVIEW_CHECK_RECORDED",
      payload: { reviewCheckId: check.check.id, status: "PASS", artifactCount: 1 }
    });
    const checkInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO review_checks"));
    expect(checkInsert?.sql).not.toContain("raw-test-value");
    expect(checkInsert?.values.some((value) => typeof value === "string" && value.includes("raw-test-value"))).toBe(false);

    const diff = await store.createReviewDiffSummary(
      {
        roomId: "room:test-1",
        reviewDecisionId: "review:test-1",
        title: `Review UI ${fakeSecret}`,
        filePath: "apps/web/src/App.tsx",
        status: "MODIFIED",
        additions: 42,
        deletions: 7,
        patchArtifactId: "artifact:test-1",
        summary: `Adds review aggregation ${fakeToken}.`
      },
      "trace:review"
    );

    expect(diff.diff.id).toMatch(/^review_diff:/);
    expect(diff.diff.title).toContain("[REDACTED]");
    expect(diff.diff.summary).toContain("[REDACTED]");
    expect(diff.event).toMatchObject({
      type: "REVIEW_DIFF_RECORDED",
      payload: { reviewDiffId: diff.diff.id, status: "MODIFIED", additions: 42, deletions: 7 }
    });
    const diffInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO review_diff_summaries"));
    expect(diffInsert?.sql).not.toContain("raw-test-value");
    expect(diffInsert?.values.some((value) => typeof value === "string" && value.includes("raw-test-value"))).toBe(false);

    expect(await store.listReviewChecks({ page: 1, pageSize: 25, sortOrder: "desc", roomId: "room:test-1", status: "PASS" })).toEqual([
      check.check
    ]);
    expect(await store.listReviewDiffSummaries({ page: 1, pageSize: 25, sortOrder: "desc", roomId: "room:test-1", status: "MODIFIED" })).toEqual([
      diff.diff
    ]);
  });

  it("records swarm control-plane state with lock conflicts and redaction", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const fakeToken = "to" + "ken=raw-test-value";

    const planner = await store.createSwarmTask(
      {
        roomId: "room:test-1",
        role: "PLANNER",
        title: "Plan swarm rollout",
        goal: `Map the work. ${fakeToken}`,
        assignee: "planner-1",
        dependsOnTaskIds: []
      },
      "trace:swarm"
    );
    const worker = await store.createSwarmTask(
      {
        roomId: "room:test-1",
        parentTaskId: planner.task.id,
        role: "WORKER",
        title: "Build task graph",
        goal: "Implement control-plane APIs.",
        assignee: "worker-1",
        dependsOnTaskIds: [planner.task.id, planner.task.id]
      },
      "trace:swarm"
    );
    expect(worker.task.dependsOnTaskIds).toEqual([planner.task.id]);
    expect(worker.event.type).toBe("SWARM_TASK_CREATED");
    expect(JSON.stringify(planner)).not.toContain("raw-test-value");

    const lock = await store.claimSwarmLock(
      {
        roomId: "room:test-1",
        taskId: worker.task.id,
        resource: "/opt/spaceapp",
        holder: "worker-1",
        reason: "Prevent concurrent writes."
      },
      "trace:swarm"
    );
    expect(lock.lock.status).toBe("ACTIVE");
    await expect(
      store.claimSwarmLock({
        roomId: "room:test-1",
        taskId: worker.task.id,
        resource: "/opt/spaceapp",
        holder: "reviewer-1",
        reason: "Conflicting write."
      })
    ).rejects.toThrow("already locked");

    const updated = await store.updateSwarmTask(
      worker.task.id,
      {
        status: "RUNNING",
        lockIds: [lock.lock.id],
        resultSummary: `Started. ${fakeToken}`
      },
      "trace:swarm"
    );
    expect(updated.task.lockIds).toEqual([lock.lock.id]);
    expect(updated.task.resultSummary).toContain("[REDACTED]");
    expect(updated.event.type).toBe("SWARM_TASK_UPDATED");

    const message = await store.postSwarmMessage(
      {
        roomId: "room:test-1",
        taskId: worker.task.id,
        fromRole: "WORKER",
        toRole: "REVIEWER",
        body: `Ready. ${fakeToken}`
      },
      "trace:swarm"
    );
    expect(message.message.body).toContain("[REDACTED]");
    expect(message.event.type).toBe("SWARM_MESSAGE_POSTED");

    const released = await store.releaseSwarmLock(lock.lock.id, { reason: `Done. ${fakeToken}` }, "trace:swarm");
    expect(released.lock.status).toBe("RELEASED");
    expect(JSON.stringify(released)).not.toContain("raw-test-value");

    const done = await store.updateSwarmTask(worker.task.id, { status: "DONE", resultSummary: "Task complete." }, "trace:swarm");
    expect(done.task.completedAt).toBeTruthy();

    const reconcile = await store.createSwarmReconcile(
      {
        roomId: "room:test-1",
        taskIds: [planner.task.id, worker.task.id],
        decision: "MERGED",
        summary: "Planner and worker outputs reconciled.",
        nextSteps: "Send to Review Room."
      },
      "trace:swarm"
    );
    expect(reconcile.event.type).toBe("SWARM_RECONCILED");

    const state = await store.getSwarmState("room:test-1");
    expect(state).toMatchObject({
      executionStatus: "DISABLED",
      statusReason: expect.stringContaining("control-plane only")
    });
    expect(state.tasks).toHaveLength(2);
    expect(state.locks).toEqual([expect.objectContaining({ status: "RELEASED" })]);
    expect(state.messages).toHaveLength(1);
    expect(state.reconciles).toHaveLength(1);

    const taskInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO swarm_tasks"));
    const lockInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO swarm_locks"));
    expect(taskInsert?.sql).not.toContain("raw-test-value");
    expect(lockInsert?.values).toContain("/opt/spaceapp");
    expect(pool.txClient.calls.some((call) => call.sql.includes("INSERT INTO swarm_reconciles"))).toBe(true);
  });

  it("registers artifacts with redaction and parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const fakeSensitive = "to" + "ken=raw-test-value";

    const record = await store.createArtifact(
      {
        roomId: "room:test-1",
        paneId: null,
        turnId: null,
        workflowId: "workflow:test-1",
        kind: "SCREENSHOT",
        mimeType: "image/png",
        storageUri: `cas://sha256/${"a".repeat(64)}?${fakeSensitive}`,
        sha256: "a".repeat(64),
        byteSize: 2048,
        metadata: { viewport: "1440x900", ["sec" + "ret"]: fakeSensitive }
      },
      "trace:artifact"
    );

    expect(record.artifact.id).toMatch(/^artifact:/);
    expect(record.artifact.storageUri).toContain("[REDACTED]");
    expect(JSON.stringify(record.artifact)).not.toContain("raw-test-value");
    expect(record.event).toMatchObject({
      type: "ARTIFACT_CREATED",
      payload: { artifactId: record.artifact.id, kind: "SCREENSHOT", byteSize: 2048 }
    });

    const insert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO artifacts"));
    expect(insert?.sql).not.toContain("raw-test-value");
    expect(insert?.values.some((value) => typeof value === "string" && value.includes("raw-test-value"))).toBe(false);

    const results = await store.listArtifacts({ page: 1, pageSize: 25, sortOrder: "desc", roomId: "room:test-1", kind: "SCREENSHOT" });
    expect(results).toEqual([record.artifact]);
    await store.listArtifacts({ page: 1, pageSize: 25, sortOrder: "asc", roomId: "room:test-1" });
    expect(pool.txClient.calls.at(-1)?.sql).toContain("ORDER BY created_at ASC");
    await store.listArtifacts({
      page: 1,
      pageSize: 25,
      sortOrder: "desc",
      roomId: "room:test-1",
      collection: "AGENT_FILES"
    });
    expect(pool.txClient.calls.at(-1)?.sql).toContain("storage_uri LIKE 'space-artifact://agent-files/%'");
    await store.listArtifacts({
      page: 1,
      pageSize: 25,
      sortOrder: "desc",
      roomId: "room:test-1",
      collection: "ROOM_MEDIA"
    });
    expect(pool.txClient.calls.at(-1)?.sql).toContain("space-artifact://cli-uploads/%");
    expect(pool.txClient.calls.at(-1)?.sql).not.toContain("space-artifact://agent-files/%");

    await expect(store.getArtifact(record.artifact.id)).resolves.toEqual(record.artifact);
    const deleted = await store.deleteArtifact(record.artifact.id);
    expect(deleted).toEqual(record.artifact);
    await expect(store.getArtifact(record.artifact.id)).rejects.toThrow(`Artifact ${record.artifact.id} was not found.`);
    expect(pool.txClient.calls.some((call) => call.sql.includes("DELETE FROM artifacts WHERE id = $1"))).toBe(true);
  });

  it("records latest provider validation checks with parameterized SQL", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.getLatestProviderValidation("codex-lb")).toBeNull();
    const result = await store.recordProviderValidation({
      providerId: "codex-lb",
      status: "DISABLED",
      code: "MISSING_CONFIG",
      statusReason: "Missing config.",
      checkedAt: "2026-06-26T00:00:00.000Z",
      maskedKeyPrefix: null,
      credentialLabel: null,
      modelCount: null
    });

    expect(result.code).toBe("MISSING_CONFIG");
    expect(await store.getLatestProviderValidation("codex-lb")).toEqual(result);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO provider_validation_checks"));
    expect(insert?.values).toContain("codex-lb");
    expect(insert?.sql).not.toContain("Missing config.");
  });

  it("persists global provider settings and custom provider metadata", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.getProviderSettings()).toMatchObject({ defaultProviderId: "codex-lb" });
    const provider = await store.createProvider({
      id: "custom-route",
      displayName: "Custom Route",
      type: "CUSTOM",
      baseUrl: "https://custom.example/v1",
      routeProfile: "custom",
      backingProviderId: "openai",
      credentialRef: "/run/secrets/custom-route"
    });
    expect(provider).toMatchObject({
      id: "custom-route",
      status: "DISABLED",
      credentialRef: "/run/secrets/custom-route"
    });

    expect(await store.updateProviderSettings({ defaultProviderId: "custom-route" })).toMatchObject({
      defaultProviderId: "custom-route"
    });
    expect(await store.updateProvider("custom-route", { displayName: "Custom Route 2" })).toMatchObject({
      displayName: "Custom Route 2",
      status: "DISABLED"
    });
    const providerInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO providers"));
    expect(providerInsert?.values).toContain("custom-route");
    expect(providerInsert?.sql).not.toContain("Custom Route");
    const settingsInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO provider_settings"));
    expect(settingsInsert?.values).toContain("custom-route");
  });

  it("persists independent Codex CLI mode defaults across store instances", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);
    const initialized = await store.initializeCodexCliModeDefaults({
      build: { modelId: "gpt-build", reasoningEffort: "high" },
      plan: { modelId: "gpt-plan", reasoningEffort: "xhigh" }
    });

    const updated = await store.updateCodexCliModeDefaults({
      mode: "plan",
      modelId: "gpt-plan-2",
      reasoningEffort: "medium"
    });
    const restartedStore = new PostgresSpaceStore(pool);

    expect(updated.build).toEqual(initialized.build);
    expect(updated.plan).toEqual({ modelId: "gpt-plan-2", reasoningEffort: "medium" });
    await expect(restartedStore.getCodexCliModeDefaults()).resolves.toEqual(updated);
    expect(pool.calls.find((call) => call.sql.includes("UPDATE codex_cli_mode_defaults"))?.values.slice(0, 3))
      .toEqual(["plan", "gpt-plan-2", "medium"]);
  });

  it("does not invent Codex CLI mode defaults before provider-backed initialization", async () => {
    const store = new PostgresSpaceStore(new FakePgPool());

    await expect(store.getCodexCliModeDefaults()).rejects.toBeInstanceOf(SpaceNotFoundError);
  });

  it("persists verified provider models in the existing model registry table", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    await store.recordProviderValidation({
      providerId: "codex-lb",
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Credential smoke passed.",
      checkedAt: "2026-06-26T00:00:00.000Z",
      maskedKeyPrefix: "sk-c...207",
      credentialLabel: "space-dev",
      modelCount: 1
    });
    const models = await store.replaceProviderModels("codex-lb", [
      {
        id: "gpt-test",
        providerId: "codex-lb",
        displayName: "gpt-test",
        status: "VERIFIED",
        contextWindow: null,
        supportsTools: false,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: false,
        defaultReasoningEffort: null
      }
    ]);

    expect(models).toEqual([expect.objectContaining({ id: "gpt-test", providerId: "codex-lb", status: "VERIFIED" })]);
    expect(await store.listModels()).toEqual([expect.objectContaining({ id: "gpt-test", providerId: "codex-lb" })]);
    expect(await store.listProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openai", status: "DISABLED" }),
        expect.objectContaining({ id: "codex-lb", status: "VERIFIED", maskedKeyPrefix: "sk-c...207" }),
        expect.objectContaining({ id: "anthropic", status: "DISABLED" }),
        expect.objectContaining({ id: "local", status: "DISABLED" })
      ])
    );
    const modelInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO models"));
    expect(modelInsert?.values).toContain("gpt-test");
    expect(modelInsert?.sql).not.toContain("gpt-test");
  });

  it("persists duplicate runtime model ids under separate route provider configs", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    await store.replaceProviderModels("codex-lb", [
      {
        id: "codex-lb:gpt-shared",
        providerId: "codex-lb",
        runtimeId: "gpt-shared",
        displayName: "gpt-shared",
        status: "VERIFIED",
        contextWindow: null,
        supportsTools: false,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: false,
        defaultReasoningEffort: null
      }
    ]);
    await store.replaceProviderModels("openai", [
      {
        id: "openai:gpt-shared",
        providerId: "openai",
        runtimeId: "gpt-shared",
        displayName: "gpt-shared",
        status: "VERIFIED",
        contextWindow: null,
        supportsTools: false,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: false,
        defaultReasoningEffort: null
      }
    ]);

    expect(await store.listModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex-lb:gpt-shared",
          providerId: "codex-lb",
          runtimeId: "gpt-shared"
        }),
        expect.objectContaining({
          id: "openai:gpt-shared",
          providerId: "openai",
          runtimeId: "gpt-shared"
        })
      ])
    );
  });

  it("exposes MCP gateway status fail-closed without running discovery", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.getMcpGatewayStatus()).toMatchObject({
      id: "mcp-gateway",
      status: "DISABLED",
      approvalMode: "DISABLED",
      serverCount: 1,
      toolCount: 0
    });
    expect(await store.listMcpServers()).toEqual([
      expect.objectContaining({
        id: "mcp-gateway",
        status: "DISABLED",
        schemaVersion: "2025-11-25",
        toolCount: 0
      })
    ]);
    expect(await store.listMcpTools()).toEqual([]);
    const serialized = JSON.stringify(await store.getMcpGatewayStatus()).toLowerCase();
    for (const fragment of ["sec" + "ret", "tok" + "en", "pass" + "word"]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("records latest Codex App Server handshake checks with parameterized SQL and JSON metadata", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.getLatestCodexAppServerHandshake()).toBeNull();
    const result = await store.recordCodexAppServerHandshake({
      id: "codex-app-server",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "VERIFIED",
      code: "HANDSHAKE_OK",
      message: "Codex App Server stdio initialize handshake completed.",
      transport: "stdio",
      schemasGenerated: true,
      schemaManifest: {
        schemaVersion: 1,
        codexCliVersion: "codex-cli 0.142.2",
        generatedAt: "2026-06-26T00:00:00.000Z",
        jsonSchemaFileCount: 267,
        typeScriptFileCount: 585,
        jsonSchemaBundleSha256: "a".repeat(64),
        typeScriptIndexSha256: "b".repeat(64)
      },
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.216Z",
      durationMs: 216,
      serverInfo: { platformFamily: "unix" }
    });

    expect(result.checkId).toMatch(/^codex_handshake:/);
    expect(result.code).toBe("HANDSHAKE_OK");
    expect(await store.getLatestCodexAppServerHandshake()).toEqual(result);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO codex_app_server_handshake_checks"));
    expect(insert?.values).toContain("HANDSHAKE_OK");
    expect(insert?.values).toContain(JSON.stringify({ platformFamily: "unix" }));
    expect(insert?.sql).not.toContain("platformFamily");
    expect(JSON.stringify(result)).not.toContain("space-dev");
  });

  it("records latest Codex App Server turn smoke checks without storing prompt content", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.getLatestCodexAppServerTurnSmoke()).toBeNull();
    const result = await store.recordCodexAppServerTurnSmoke({
      id: "codex-app-server",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "VERIFIED",
      code: "TURN_COMPLETED",
      message: "Codex App Server thread/start and turn/start smoke completed.",
      transport: "stdio",
      schemasGenerated: true,
      schemaManifest: null,
      model: "gpt-5.4",
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:02.000Z",
      durationMs: 2000,
      threadId: "thread:test-1",
      turnId: "turn:test-1",
      turnStatus: "completed",
      notificationCount: 3,
      completedNotificationSeen: true
    });

    expect(result.checkId).toMatch(/^codex_turn_smoke:/);
    expect(result.code).toBe("TURN_COMPLETED");
    expect(await store.getLatestCodexAppServerTurnSmoke()).toEqual(result);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO codex_app_server_turn_smoke_checks"));
    expect(insert?.values).toContain("gpt-5.4");
    expect(insert?.values).toContain("thread:test-1");
    expect(insert?.sql).not.toContain("Reply with exactly");
    expect(JSON.stringify(result)).not.toContain("space-ok");
  });

  it("records latest MCP discovery smoke checks without executing tools", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.getLatestMcpDiscoverySmoke()).toBeNull();
    const result = await store.recordMcpDiscoverySmoke({
      id: "mcp-gateway",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "DISABLED",
      code: "DISCOVERY_SMOKE_DISABLED",
      message: "Discovery smoke is disabled.",
      targetSpecVersion: "2025-11-25",
      discoveryEnabled: false,
      serverCount: 1,
      toolCount: 0,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1
    });

    expect(result.checkId).toMatch(/^mcp_discovery_smoke:/);
    expect(result.code).toBe("DISCOVERY_SMOKE_DISABLED");
    expect(result.toolCount).toBe(0);
    expect(await store.getLatestMcpDiscoverySmoke()).toEqual(result);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO mcp_discovery_smoke_checks"));
    expect(insert?.values).toContain("DISCOVERY_SMOKE_DISABLED");
    expect(insert?.values).toContain("2025-11-25");
    expect(insert?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));
  });

  it("records latest memory embedding smoke checks without enabling semantic search", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.getLatestMemoryEmbeddingSmoke()).toBeNull();
    const result = await store.recordMemoryEmbeddingSmoke({
      id: "memory-embedding-smoke",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "DISABLED",
      code: "EMBEDDING_SMOKE_DISABLED",
      message: "Memory embedding smoke is disabled.",
      smokeEnabled: false,
      provider: null,
      model: null,
      dimensions: 1536,
      pgvectorReady: false,
      embeddingProviderReady: false,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1
    });

    expect(result.checkId).toMatch(/^memory_embed_smoke:/);
    expect(result.code).toBe("EMBEDDING_SMOKE_DISABLED");
    expect(result.embeddingProviderReady).toBe(false);
    expect(await store.getLatestMemoryEmbeddingSmoke()).toEqual(result);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO memory_embedding_smoke_checks"));
    expect(insert?.values).toContain("EMBEDDING_SMOKE_DISABLED");
    expect(insert?.values).toContain(1536);
    expect(insert?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));
  });

  it("checks pgvector extension, embedding column, and vector index readiness", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const readiness = await store.getMemoryVectorReadiness(1536);

    expect(readiness).toMatchObject({
      id: "memory-vector-readiness",
      status: "VERIFIED",
      code: "MEMORY_VECTOR_READY",
      runtimeStore: "postgres",
      extensionInstalled: true,
      extensionVersion: "0.8.3",
      embeddingColumnReady: true,
      embeddingDimensions: 1536,
      expectedDimensions: 1536,
      vectorIndexReady: true
    });
    expect(pool.calls.some((call) => call.sql.includes("FROM pg_extension"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("FROM pg_attribute"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("idx_memory_records_embedding_hnsw"))).toBe(true);
  });

  it("records MCP discovery catalog metadata with parameterized upserts and disabled approvals", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const record = await store.recordMcpDiscoveryCatalog({
      discoveredAt: "2026-06-26T00:00:00.000Z",
      servers: [
        {
          id: "filesystem-readonly",
          displayName: "Filesystem Readonly",
          transport: "stdio",
          status: "VERIFIED",
          statusReason: "Discovery metadata captured; execution remains disabled.",
          schemaVersion: "2025-11-25",
          configHash: "sha256:test-config",
          toolCount: 0,
          lastDiscoveredAt: null
        }
      ],
      tools: [
        {
          id: "filesystem-readonly:list",
          serverId: "filesystem-readonly",
          name: "list",
          riskLevel: "R1",
          schemaHash: "sha256:test-schema",
          approvalRequired: true,
          status: "VERIFIED",
          statusReason: "Schema metadata captured; execution remains disabled."
        }
      ]
    });

    expect(record.gatewayStatus).toMatchObject({
      status: "VERIFIED",
      approvalMode: "DISABLED",
      serverCount: 1,
      toolCount: 1
    });
    expect(await store.listMcpServers()).toEqual([
      expect.objectContaining({ id: "filesystem-readonly", toolCount: 1 })
    ]);
    expect(await store.listMcpTools()).toEqual([
      expect.objectContaining({ id: "filesystem-readonly:list", approvalRequired: true })
    ]);
    expect((await store.listCapabilities()).filter((capability) => capability.kind === "MCP_TOOL")).toEqual([
      expect.objectContaining({ id: "filesystem-readonly:list", requiresApproval: true })
    ]);

    const serverInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO mcp_servers"));
    const toolInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO mcp_tools"));
    expect(serverInsert?.values).toContain("filesystem-readonly");
    expect(toolInsert?.values).toContain("filesystem-readonly:list");
    expect(serverInsert?.sql).not.toContain("Filesystem Readonly");
    expect(toolInsert?.sql).not.toContain("Schema metadata captured");
  });

  it("records queued turns with workflow state, prompt history, prompt hash, and replay event", async () => {
    const pool = new FakePgPool();
    const store = new PostgresSpaceStore(pool);

    const queued = await store.recordTurnQueued({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      workflowId: "workflow:dummy:test-1",
      runId: "run:test-1",
      taskQueue: "space-agent-turns",
      traceId: "trace:turn-1",
      prompt: "hello'; drop table turns; --",
      providerId: null,
      modelId: null
    });

    expect(queued.workflow.status).toBe("PENDING");
    const startedWorkflow = await store.recordWorkflowRunId(queued.workflow.workflowId, "run:test-1b");
    expect(startedWorkflow.runId).toBe("run:test-1b");
    expect(queued.turn.status).toBe("QUEUED");
    expect(queued.turn.prompt).toBe("hello'; drop table turns; --");
    expect(queued.turn.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(queued.event).toMatchObject({
      turnId: queued.turn.id,
      workflowId: queued.workflow.workflowId,
      type: "TURN_STARTED"
    });

    const workflowInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO workflows"));
    expect(workflowInsert?.values).toContain("workflow:dummy:test-1");
    const turnInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO turns"));
    expect(turnInsert?.sql).not.toContain("drop table");
    expect(turnInsert?.values).toContain("hello'; drop table turns; --");
    const eventInsert = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO events"));
    expect(eventInsert?.values).toContain(queued.workflow.workflowId);

    const turns = await store.listTurns("room:test-1");
    expect(turns).toEqual([queued.turn]);

    const completed = await store.recordTurnCompleted({
      workflowId: queued.workflow.workflowId,
      traceId: "trace:turn-1",
      message: "Dummy Temporal turn completed.",
      metadata: {
        codexAppServer: {
          threadId: "thread:test-1",
          turnId: "turn:test-1",
          agentMessageText: "Final answer from Chat"
        }
      }
    });

    expect(completed.workflow.status).toBe("COMPLETED");
    expect(completed.turn.status).toBe("COMPLETED");
    expect(completed.event).toMatchObject({
      turnId: queued.turn.id,
      workflowId: queued.workflow.workflowId,
      type: "TURN_COMPLETED",
      payload: expect.objectContaining({
        metadata: {
          codexAppServer: {
            threadId: "thread:test-1",
            turnId: "turn:test-1",
            agentMessageText: "Final answer from Chat"
          }
        }
      })
    });

    const chatOutbox = pool.txClient.calls.find((call) => call.sql.includes("INSERT INTO telegram_notification_outbox"));
    expect(chatOutbox?.sql).toContain("agent_label, task_title");
    expect(chatOutbox?.sql).toContain("'Agent '");
    expect(chatOutbox?.sql).toContain("p.title");
    expect(chatOutbox?.values).toContain("Final answer from Chat");

    const failedQueued = await store.recordTurnQueued({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      workflowId: "workflow:codex-app-server:test-2",
      runId: "run:test-2",
      taskQueue: "space-agent-turns",
      traceId: "trace:turn-2",
      prompt: "hello fail closed",
      runtime: "CODEX_APP_SERVER",
      providerId: null,
      modelId: null
    });
    const failed = await store.recordTurnFailed({
      workflowId: failedQueued.workflow.workflowId,
      traceId: "trace:turn-2",
      message: "Codex App Server real turn workflow is not implemented yet.",
      reasonCode: "CODEX_APP_SERVER_NOT_IMPLEMENTED",
      metadata: {
        codexAppServer: {
          threadId: null,
          turnId: null,
          notificationCount: 0
        }
      }
    });

    expect(failed.workflow.status).toBe("FAILED");
    expect(failed.turn.status).toBe("FAILED");
    expect(failed.event).toMatchObject({
      turnId: failedQueued.turn.id,
      workflowId: failedQueued.workflow.workflowId,
      type: "TURN_FAILED",
      payload: expect.objectContaining({
        status: "FAILED",
        reasonCode: "CODEX_APP_SERVER_NOT_IMPLEMENTED",
        metadata: {
          codexAppServer: {
            threadId: null,
            turnId: null,
            notificationCount: 0
          }
        }
      })
    });
    expect(pool.txClient.calls.some((call) => call.sql.includes("UPDATE workflows"))).toBe(true);
    expect(pool.txClient.calls.some((call) => call.sql.includes("UPDATE turns"))).toBe(true);
  });

  it("reconciles stale space agent sessions with a single guarded UPDATE", async () => {
    const pool = new FakePgPool();
    pool.txClient.paneRows = [
      { id: "pane:closed-a", roomId: "room:r", isClosed: true },
      { id: "pane:closed-b", roomId: "room:r", isClosed: true },
      { id: "pane:open-c", roomId: "room:r", isClosed: false }
    ];
    pool.txClient.spaceAgentSessionRows = [
      {
        sessionId: "agent_session:a", paneId: "pane:closed-a", roomId: "room:r", source: "SPACE",
        status: "RUNNING", title: "Stale A", threadId: null, selectedProviderId: "codex-lb",
        selectedModelId: "gpt-5.6-sol", selectedModelConfigId: "gpt-5.6-sol:high",
        selectedProviderName: null, selectedModelName: "GPT-5.6", selectedReasoningKey: "high",
        selectedToolIds: [], permissionMode: null, collaborationMode: "default",
        isActive: true, lastSyncedAt: "2026-08-12T00:00:00.000Z",
        createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z"
      },
      {
        sessionId: "agent_session:b", paneId: "pane:closed-b", roomId: "room:r", source: "SPACE",
        status: "RUNNING", title: "Busy B", threadId: null, selectedProviderId: "codex-lb",
        selectedModelId: "gpt-5.6-sol", selectedModelConfigId: "gpt-5.6-sol:high",
        selectedProviderName: null, selectedModelName: "GPT-5.6", selectedReasoningKey: "high",
        selectedToolIds: [], permissionMode: null, collaborationMode: "default",
        isActive: true, lastSyncedAt: "2026-08-12T00:00:00.000Z",
        createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z"
      },
      {
        sessionId: "agent_session:c", paneId: "pane:open-c", roomId: "room:r", source: "SPACE",
        status: "READY", title: "Open C", threadId: null, selectedProviderId: "codex-lb",
        selectedModelId: "gpt-5.6-sol", selectedModelConfigId: "gpt-5.6-sol:high",
        selectedProviderName: null, selectedModelName: "GPT-5.6", selectedReasoningKey: "high",
        selectedToolIds: [], permissionMode: null, collaborationMode: "default",
        isActive: true, lastSyncedAt: "2026-08-12T00:00:00.000Z",
        createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z"
      }
    ];
    pool.txClient.spaceAgentRunRows = [
      {
        runId: "agent_run:b", sessionId: "agent_session:b", paneId: "pane:closed-b", roomId: "room:r",
        workflowId: "workflow:b", temporalRunId: null, codexThreadId: null, codexTurnId: null,
        status: "RUNNING", promptMessageId: null, responseMessageId: null, errorCode: null,
        errorMessage: null, createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z", completedAt: null
      }
    ];
    const store = new PostgresSpaceStore(pool);

    const deactivated = await store.reconcileStaleSpaceAgentSessions();

    expect(deactivated).toBe(1);
    const updateCall = pool.txClient.calls.find((call) => call.sql.includes("RETURNING session_record.session_id"));
    expect(updateCall?.sql).toContain("NOT EXISTS");
    expect(updateCall?.sql).toContain("is_closed = false");
    expect(updateCall?.sql).toContain("status = 'READY'");
    const remaining = pool.txClient.spaceAgentSessionRows as Record<string, unknown>[];
    expect(remaining.find((row) => row.sessionId === "agent_session:a")).toMatchObject({ isActive: false, status: "READY" });
    expect(remaining.find((row) => row.sessionId === "agent_session:b")).toMatchObject({ isActive: true });
    expect(remaining.find((row) => row.sessionId === "agent_session:c")).toMatchObject({ isActive: true });
  });
});
