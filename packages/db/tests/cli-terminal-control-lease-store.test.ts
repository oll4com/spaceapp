import { describe, expect, it } from "vitest";
import { SpaceConflictError } from "@space/runtime";
import { PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

type LeaseStatus = "ACTIVE" | "RELEASED" | "EXPIRED" | "REVOKED";

interface LeaseRow {
  leaseId: string;
  sessionId: string;
  paneId: string;
  roomId: string;
  userId: string;
  browserClientId: string;
  tabLineageId: string;
  pageClientId: string;
  status: LeaseStatus;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

const sessionRow = {
  sessionId: "cli_session:terminal-control",
  paneId: "pane:terminal-control",
  roomId: "room:terminal-control",
  runtimeId: "cli:codex",
  providerId: "codex",
  agentId: "codex",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "high",
  launchMode: "FRESH",
  purpose: "NORMAL",
  cwd: "/etc",
  codexThreadId: null,
  cliTaskId: null,
  cliTaskRevisionId: null,
  status: "RUNNING",
  statusReason: "Running",
  exitCode: null,
  isActive: true,
  startedAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  endedAt: null
};

class LeasePgClient implements PgClientLike {
  private unlock: (() => void) | null = null;

  constructor(private readonly pool: LeasePgPool) {}

  async query<T = unknown>(sql: string, values: unknown[] = []) {
    if (sql.includes("FROM pane_cli_sessions") && sql.includes("FOR UPDATE") && !this.unlock) {
      this.unlock = await this.pool.acquireSessionLock();
    }
    const result = await this.pool.execute<T>(sql, values);
    if (sql === "COMMIT" || sql === "ROLLBACK") this.releaseLock();
    return result;
  }

  release(): void {
    this.releaseLock();
  }

  private releaseLock(): void {
    this.unlock?.();
    this.unlock = null;
  }
}

class LeasePgPool implements PgPoolLike {
  private readonly leases = new Map<string, LeaseRow>();
  private clockMs = Date.parse("2026-07-23T08:00:00.000Z");
  private lockTail: Promise<void> = Promise.resolve();

  connect(): Promise<PgClientLike> {
    return Promise.resolve(new LeasePgClient(this));
  }

  query<T = unknown>(sql: string, values: unknown[] = []) {
    return this.execute<T>(sql, values);
  }

  async acquireSessionLock(): Promise<() => void> {
    const previous = this.lockTail;
    let release = () => undefined;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async execute<T = unknown>(sql: string, values: unknown[] = []) {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("FROM pane_cli_sessions")) {
      return { rows: [sessionRow as T], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO pane_cli_terminal_control_leases")) {
      const acquiredAt = this.now();
      const row: LeaseRow = {
        leaseId: String(values[0]),
        sessionId: String(values[1]),
        paneId: String(values[2]),
        roomId: String(values[3]),
        userId: String(values[4]),
        browserClientId: String(values[5]),
        tabLineageId: String(values[6]),
        pageClientId: String(values[7]),
        status: "ACTIVE",
        acquiredAt,
        heartbeatAt: acquiredAt,
        expiresAt: new Date(this.clockMs + Number(values[8]) * 1_000).toISOString(),
        releasedAt: null
      };
      this.leases.set(row.leaseId, row);
      return { rows: [{ ...row } as T], rowCount: 1 };
    }
    if (sql.includes("SET status = 'EXPIRED'")) {
      const rows = this.find(sql, String(values[0]));
      const changed: LeaseRow[] = [];
      for (const row of rows) {
        if (row.status !== "ACTIVE" || Date.parse(row.expiresAt) > this.clockMs) continue;
        const expired = { ...row, status: "EXPIRED" as const, releasedAt: row.releasedAt ?? this.now() };
        this.leases.set(row.leaseId, expired);
        changed.push(expired);
      }
      return {
        rows: sql.includes("RETURNING") ? changed.map((row) => ({ ...row } as T)) : [],
        rowCount: changed.length
      };
    }
    if (sql.includes("SET status = 'REVOKED'")) {
      const row = this.leases.get(String(values[0]));
      if (!row || row.status !== "ACTIVE") return { rows: [], rowCount: 0 };
      this.leases.set(row.leaseId, {
        ...row,
        status: "REVOKED",
        releasedAt: row.releasedAt ?? this.now()
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = $2")) {
      const row = this.leases.get(String(values[0]));
      if (!row || row.status !== values[3]) return { rows: [], rowCount: 0 };
      const ttlSeconds = values[2] === null ? null : Number(values[2]);
      const status = values[1] as LeaseStatus;
      const now = this.now();
      const updated: LeaseRow = {
        ...row,
        status,
        heartbeatAt: ttlSeconds === null ? row.heartbeatAt : now,
        expiresAt: ttlSeconds === null ? row.expiresAt : new Date(this.clockMs + ttlSeconds * 1_000).toISOString(),
        releasedAt: status === "ACTIVE" ? null : row.releasedAt ?? now
      };
      this.leases.set(row.leaseId, updated);
      return { rows: [{ ...updated } as T], rowCount: 1 };
    }
    if (sql.includes("FROM pane_cli_terminal_control_leases")) {
      const activeOnly = sql.includes("status = 'ACTIVE'");
      const rows = this.find(sql, String(values[0]))
        .filter((row) => !activeOnly || row.status === "ACTIVE")
        .map((row) => ({ ...row } as T));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }

  private find(sql: string, identity: string): LeaseRow[] {
    return [...this.leases.values()].filter((row) =>
      sql.includes("session_id = $1") ? row.sessionId === identity : row.leaseId === identity
    );
  }

  private now(): string {
    return new Date(this.clockMs).toISOString();
  }
}

function identity(pageClientId: string) {
  return {
    browserClientId: "11111111-1111-4111-8111-111111111111",
    tabLineageId: "22222222-2222-4222-8222-222222222222",
    pageClientId
  };
}

function input(leaseId: string, pageClientId: string, expectedActiveLeaseId: string | null) {
  return {
    leaseId,
    sessionId: sessionRow.sessionId,
    paneId: sessionRow.paneId,
    roomId: sessionRow.roomId,
    userId: "user:operator",
    ...identity(pageClientId),
    expectedActiveLeaseId,
    ttlSeconds: 30
  };
}

describe("PostgresSpaceStore CLI terminal control leases", () => {
  it("serializes competing acquisition and fences stale page takeovers", async () => {
    const store = new PostgresSpaceStore(new LeasePgPool());
    const attempts = await Promise.allSettled([
      store.createPaneCliTerminalControlLease(input(
        "cli_terminal_lease:first",
        "33333333-3333-4333-8333-333333333333",
        null
      )),
      store.createPaneCliTerminalControlLease(input(
        "cli_terminal_lease:competing",
        "44444444-4444-4444-8444-444444444444",
        null
      ))
    ]);

    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = attempts.find((attempt) => attempt.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("Expected one controller winner.");

    const successor = await store.createPaneCliTerminalControlLease(input(
      "cli_terminal_lease:successor",
      "55555555-5555-4555-8555-555555555555",
      winner.value.leaseId
    ));
    await expect(store.createPaneCliTerminalControlLease(input(
      "cli_terminal_lease:stale",
      "66666666-6666-4666-8666-666666666666",
      winner.value.leaseId
    ))).rejects.toBeInstanceOf(SpaceConflictError);
    await expect(store.getActivePaneCliTerminalControlLease(sessionRow.sessionId))
      .resolves.toMatchObject({ leaseId: successor.leaseId });
  });

  it("heartbeats and releases through an ACTIVE compare-and-swap", async () => {
    const store = new PostgresSpaceStore(new LeasePgPool());
    const created = await store.createPaneCliTerminalControlLease(input(
      "cli_terminal_lease:lifecycle",
      "33333333-3333-4333-8333-333333333333",
      null
    ));
    await expect(store.updatePaneCliTerminalControlLease(created.leaseId, {
      expectedStatus: "ACTIVE",
      ttlSeconds: 60
    })).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(store.updatePaneCliTerminalControlLease(created.leaseId, {
      expectedStatus: "ACTIVE",
      status: "RELEASED"
    })).resolves.toMatchObject({ status: "RELEASED", releasedAt: expect.any(String) });
    await expect(store.updatePaneCliTerminalControlLease(created.leaseId, {
      expectedStatus: "ACTIVE",
      ttlSeconds: 30
    })).rejects.toBeInstanceOf(SpaceConflictError);
  });
});
