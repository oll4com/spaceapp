import { describe, expect, it } from "vitest";
import {
  createSpacePgPool,
  isSocketAccessible,
  prefersSpaceSocket,
  buildSocketConnectionString,
  DEFAULT_SPACE_PG_SOCKET_PATH,
  PostgresSpaceStore,
  type PgPoolLike
} from "../src/space-store.js";
import { InMemorySpaceStore } from "../../runtime/src/index.js";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("PostgreSQL Performance Tuning & Data Retention", () => {
  describe("Unix Domain Socket Dual-Mode Resolution", () => {
    it("detects socket absence correctly", () => {
      expect(isSocketAccessible("/nonexistent/path/to/socket")).toBe(false);
      expect(isSocketAccessible(DEFAULT_SPACE_PG_SOCKET_PATH)).toBe(false);
    });

    it("builds socket connection string from TCP URL", () => {
      const tcpUrl = "postgresql://space:secret@127.0.0.1:54329/space";
      const socketUrl = buildSocketConnectionString(tcpUrl, "/var/run/space-postgres/.s.PGSQL.5432");
      const parsed = new URL(socketUrl);

      expect(parsed.protocol).toBe("postgresql:");
      expect(parsed.username).toBe("space");
      expect(parsed.password).toBe("secret");
      expect(parsed.pathname).toBe("/space");
      expect(parsed.searchParams.get("host")).toBe("/var/run/space-postgres");
    });

    it("creates standard pool without proxy when socket is absent", async () => {
      const tcpUrl = "postgresql://space:secret@127.0.0.1:54329/space";
      const pool = createSpacePgPool(tcpUrl, { max: 2, socketPath: "/nonexistent/socket" }, 2);

      expect(pool).toBeDefined();
      expect(pool.totalCount).toBe(0);
      await pool.end();
    });

    it("transparently falls back to TCP connection when socket connection fails", async () => {
      // Create a temporary dummy file to simulate socket file presence
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "space-pg-test-"));
      const fakeSocketPath = path.join(tmpDir, ".s.PGSQL.5432");
      fs.writeFileSync(fakeSocketPath, "dummy");

      try {
        expect(isSocketAccessible(fakeSocketPath)).toBe(true);

        // Track executed queries on fallback
        const tcpUrl = "postgresql://space:secret@127.0.0.1:54329/space";
        const pool = createSpacePgPool(tcpUrl, {
          max: 2,
          connectionTimeoutMillis: 500,
          socketPath: fakeSocketPath
        });

        // The socket is not a real server listening, so socket query will fail with connection error,
        // and the pool must trigger fallback to TCP.
        // TCP to 54329 may either connect or fail with ECONNREFUSED (TCP), but crucially NOT ENOENT on the socket!
        try {
          await pool.query("SELECT 1");
        } catch (error: any) {
          // If fallback occurred, error will be from TCP (or if live DB running, it succeeds!)
          expect(error.message).toMatch(/(connect ECONNREFUSED|password authentication|relation)/i);
        } finally {
          await pool.end();
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Space socket only replaces loopback TCP", () => {
    it("never redirects an explicit socket directory or a non-loopback host", async () => {
      expect(prefersSpaceSocket("postgresql://space:secret@127.0.0.1:5432/space")).toBe(true);
      expect(prefersSpaceSocket("postgresql://space:secret@localhost/space")).toBe(true);
      expect(prefersSpaceSocket("postgresql://space:secret@[::1]:5432/space")).toBe(true);
      expect(prefersSpaceSocket("postgresql://postgres@localhost/postgres?host=%2Ftmp%2Fowned")).toBe(false);
      expect(prefersSpaceSocket("postgresql://postgres@172.18.0.9:5432/postgres")).toBe(false);
      expect(prefersSpaceSocket("not a url")).toBe(false);

      // A reachable "live" socket must not capture a test's own database.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "space-pg-guard-"));
      const liveLikeSocket = path.join(tmpDir, ".s.PGSQL.5432");
      fs.writeFileSync(liveLikeSocket, "dummy");
      try {
        expect(isSocketAccessible(liveLikeSocket)).toBe(true);
        for (const url of [
          "postgresql://postgres@localhost/postgres?host=%2Ftmp%2Fowned-test-socket",
          "postgresql://postgres@172.18.0.9:5432/postgres"
        ]) {
          const pool = createSpacePgPool(url, { max: 1, socketPath: liveLikeSocket });
          expect((pool as unknown as { options: { connectionString: string } }).options.connectionString).toBe(url);
          await pool.end();
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Automated Transcript Chunk Retention Pruning", () => {
    it("InMemorySpaceStore prunes expired transcript chunks in bounded batches", async () => {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Retention Room" });
      const pane = store.createPane({ roomId: room.id, title: "Test Pane", mode: "TERMINAL" });
      const roomId = room.id;
      const paneId = pane.id;

      // Create an active session (should NOT be pruned)
      const activeSession = store.createPaneCliSession({
        roomId,
        paneId,
        sessionId: "session:active",
        runtimeId: "cli:codex",
        providerId: "openai",
        agentId: "codex",
        reasoningEffort: "medium",
        status: "RUNNING"
      });

      // Create an old EXITED session (older than 7 days)
      const oldExitedSession = store.createPaneCliSession({
        roomId,
        paneId,
        sessionId: "session:old-exited",
        runtimeId: "cli:codex",
        providerId: "openai",
        agentId: "codex",
        reasoningEffort: "medium",
        status: "EXITED"
      });

      // Backdate the exited session to 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
      (store as any).paneCliSessions.set("session:old-exited", {
        ...oldExitedSession,
        updatedAt: tenDaysAgo
      });

      // Append transcript chunks to both sessions
      store.appendPaneCliTranscriptChunk({
        sessionId: "session:active",
        paneId,
        roomId,
        sequence: 0,
        stream: "stdout",
        content: "active session chunk"
      });

      for (let i = 0; i < 5; i++) {
        store.appendPaneCliTranscriptChunk({
          sessionId: "session:old-exited",
          paneId,
          roomId,
          sequence: i,
          stream: "stdout",
          content: `old chunk ${i}`
        });
      }

      expect(store.listPaneCliTranscriptChunks("session:active")).toHaveLength(1);
      expect(store.listPaneCliTranscriptChunks("session:old-exited")).toHaveLength(5);

      // Prune with batch size 2
      const firstBatch = store.pruneExpiredCliTranscriptChunks({ olderThanDays: 7, batchSize: 2 });
      expect(firstBatch.deletedChunks).toBe(2);
      expect(store.listPaneCliTranscriptChunks("session:old-exited")).toHaveLength(3);
      expect(store.listPaneCliTranscriptChunks("session:active")).toHaveLength(1);

      // Prune remaining with batch size 10
      const secondBatch = store.pruneExpiredCliTranscriptChunks({ olderThanDays: 7, batchSize: 10 });
      expect(secondBatch.deletedChunks).toBe(3);
      expect(store.listPaneCliTranscriptChunks("session:old-exited")).toHaveLength(0);
      expect(store.listPaneCliTranscriptChunks("session:active")).toHaveLength(1);

      // Subsequent prune has 0
      const thirdBatch = store.pruneExpiredCliTranscriptChunks({ olderThanDays: 7 });
      expect(thirdBatch.deletedChunks).toBe(0);
    });

    it("PostgresSpaceStore executes bounded non-blocking batch pruning", async () => {
      const executedQueries: Array<{ sql: string; values?: unknown[] }> = [];
      const fakePool: PgPoolLike = {
        async query<T = unknown>(sql: string, values?: unknown[]) {
          executedQueries.push({ sql, values });
          if (sql.includes("DELETE FROM pane_cli_transcript_chunks")) {
            return { rows: [{ chunk_id: "c1" }, { chunk_id: "c2" }] as T[], rowCount: 2 };
          }
          if (sql.includes("SELECT 1")) {
            return { rows: [{ "?column?": 1 }] as T[], rowCount: 1 };
          }
          return { rows: [] as T[], rowCount: 0 };
        },
        async connect() {
          return {
            query: fakePool.query.bind(fakePool),
            release: () => {}
          };
        }
      };

      const store = new PostgresSpaceStore(fakePool);
      const result = await store.pruneExpiredCliTranscriptChunks({ olderThanDays: 7, batchSize: 500 });

      expect(result.deletedChunks).toBe(2);
      expect(executedQueries).toHaveLength(1);
      expect(executedQueries[0].sql).toContain("DELETE FROM pane_cli_transcript_chunks");
      expect(executedQueries[0].sql).toContain("WHERE s.status = 'EXITED'");
      expect(executedQueries[0].sql).toContain("LIMIT $2");
      expect(executedQueries[0].values).toEqual(["7", 500]);

      // Test probe
      await store.probe();
      expect(executedQueries[1].sql).toBe("SELECT 1");
    });

    it("InMemorySpaceStore prunes closed panes older than 24 hours while preserving active and recent closed panes", async () => {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Retention Test Room" });
      const roomAgentPane = store.getOrCreateRoomAgentPane(room.id);

      // Create an active pane (should never be pruned)
      const activePane = store.createPane({ roomId: room.id, title: "Active Pane", mode: "TERMINAL" });

      // Create a recently closed pane (< 24 hours ago, should be preserved)
      const recentClosedPane = store.createPane({ roomId: room.id, title: "Recent Closed Pane", mode: "TERMINAL" });
      store.updatePane(recentClosedPane.id, { isClosed: true, status: "CLOSED" });

      // Create an old closed pane (> 24 hours ago, should be pruned)
      const oldClosedPane = store.createPane({ roomId: room.id, title: "Old Closed Pane", mode: "TERMINAL" });
      store.updatePane(oldClosedPane.id, { isClosed: true, status: "CLOSED" });
      const thirtyHoursAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
      (store as any).panes.set(oldClosedPane.id, {
        ...store.getPane(oldClosedPane.id),
        updatedAt: thirtyHoursAgo
      });

      // Verify initial state: 4 panes (room agent, active, recent closed, old closed)
      expect(store.listPanes(room.id, true)).toHaveLength(4);

      // Prune closed panes older than 24 hours
      const result = store.pruneClosedPanes({ olderThanHours: 24, batchSize: 50 });
      expect(result.deletedPanes).toBe(1);

      // Verify remaining panes: room agent, active, and recent closed
      const remainingPanes = store.listPanes(room.id, true);
      expect(remainingPanes).toHaveLength(3);
      expect(remainingPanes.map((p) => p.id)).toContain(activePane.id);
      expect(remainingPanes.map((p) => p.id)).toContain(recentClosedPane.id);
      expect(remainingPanes.map((p) => p.id)).toContain(roomAgentPane.id);
      expect(remainingPanes.map((p) => p.id)).not.toContain(oldClosedPane.id);
    });

    it("InMemorySpaceStore keeps the newest closed Job and Marketing Copilot pane of each room when pruning", async () => {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: "Job Copilot Retention" });
      const closedAt = (hoursAgo: number, mode: "JOB_APPLY" | "MARKETING_COPILOT" | "TERMINAL") => {
        const pane = store.createPane({ roomId: room.id, title: `${mode} ${hoursAgo}`, mode });
        store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
        (store as any).panes.set(pane.id, { ...store.getPane(pane.id), updatedAt: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString() });
        return pane;
      };
      const olderCopilot = closedAt(60, "JOB_APPLY");
      const newestCopilot = closedAt(30, "JOB_APPLY");
      const terminal = closedAt(30, "TERMINAL");
      // Kept per kind: the newest Marketing Copilot pane stays although a Job Copilot pane closed after it.
      const olderMarketing = closedAt(50, "MARKETING_COPILOT");
      const newestMarketing = closedAt(40, "MARKETING_COPILOT");
      expect(store.pruneClosedPanes({ olderThanHours: 24 }).deletedPanes).toBe(3);
      const remaining = store.listPanes(room.id, true).map((pane) => pane.id);
      expect(remaining).toContain(newestCopilot.id);
      expect(remaining).toContain(newestMarketing.id);
      expect(remaining).not.toContain(olderMarketing.id);
      expect(remaining).not.toContain(olderCopilot.id);
      expect(remaining).not.toContain(terminal.id);
    });

    it("PostgresSpaceStore executes bounded query and cascades task runs on closed pane pruning", async () => {
      const executedQueries: Array<{ sql: string; values?: unknown[] }> = [];
      const fakePool: PgPoolLike = {
        async query<T = unknown>(sql: string, values?: unknown[]) {
          executedQueries.push({ sql, values });
          if (sql.includes("SELECT p.id")) {
            return { rows: [{ id: "pane:old-1" }, { id: "pane:old-2" }] as T[], rowCount: 2 };
          }
          if (sql.includes("DELETE FROM panes")) {
            return { rows: [{ id: "pane:old-1" }, { id: "pane:old-2" }] as T[], rowCount: 2 };
          }
          return { rows: [] as T[], rowCount: 0 };
        },
        async connect() {
          return {
            query: fakePool.query.bind(fakePool),
            release: () => {}
          };
        }
      };

      const store = new PostgresSpaceStore(fakePool);
      const result = await store.pruneClosedPanes({ olderThanHours: 24, batchSize: 100 });

      expect(result.deletedPanes).toBe(2);
      expect(executedQueries.some((q) => q.sql.includes("SELECT p.id") && q.sql.includes("p.is_closed = true"))).toBe(true);
      expect(executedQueries.some((q) => q.sql.includes("DELETE FROM room_agent_task_runs"))).toBe(true);
      expect(executedQueries.some((q) => q.sql.includes("DELETE FROM panes WHERE id = ANY"))).toBe(true);
    });
  });
});
