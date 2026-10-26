// 龙娘 · 2026-10-26: exercise public PostgreSQL store methods and their bound project path values.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

class RoomPool implements PgPoolLike, PgClientLike {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  async connect(): Promise<PgClientLike> { return this; }
  release(): void {}
  async query<T = unknown>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    let rows: unknown[] = [];
    if (sql.includes('AS "nextOrder"')) rows = [{ nextOrder: 0 }];
    if (sql.includes('AS "starterRoomInitialized"')) rows = [{ starterRoomInitialized: false }];
    if (sql.includes("INSERT INTO rooms")) {
      const starter = sql.includes("'Getting Started'");
      rows = [{ id: values[0], name: starter ? "Getting Started" : values[1], description: null,
        projectPath: starter ? values[6] : values[9], kind: "WORKSPACE", order: 0, paneCap: 5,
        traceId: starter ? values[3] : values[5], archivedAt: null,
        createdAt: starter ? values[4] : values[6], updatedAt: starter ? values[4] : values[6], ownerUserId: null }];
    }
    if (sql.includes("INSERT INTO events")) rows = [{ id: values[0], roomId: values[1], paneId: values[2], turnId: values[3], workflowId: values[4], traceId: values[5], type: values[6], message: values[7], payload: JSON.parse(String(values[8])), createdAt: values[9] }];
    if (sql.includes("INSERT INTO panes")) rows = [{
      id: values[0], roomId: values[1], title: values[2], paneName: values[3], mode: values[4], status: "IDLE",
      providerId: values[5], modelId: values[6], terminalRuntimeId: values[7], reasoningEffort: "medium", cwd: values[8],
      order: values[9], columnSpan: 1, isMaximized: false, isMinimized: false, isClosed: false,
      split: JSON.parse(String(values[10])), vncTarget: null, createdAt: values[12], updatedAt: values[12],
    }];
    return { rows: rows as T[], rowCount: rows.length };
  }
}

const workspace = "/checkout/.dev-stack/workspaces";
afterEach(() => vi.unstubAllEnvs());

describe("Postgres room project defaults", () => {
  it("persists dev defaults and preserves the caller's selected source folder", async () => {
    vi.stubEnv("SPACE_INSTANCE", "dev");
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", workspace);
    const store = new PostgresSpaceStore(new RoomPool());
    expect((await store.createRoom({ name: "Default", initialPaneCount: 0 })).projectPath).toBe(workspace);
    expect((await store.createRoom({ name: "Selected", initialPaneCount: 0, projectPath: "/checkout/source" })).projectPath).toBe("/checkout/source");
  });

  it.each(["dev", "stable"])("persists the %s starter room path and pane working directory", async instance => {
    vi.stubEnv("SPACE_INSTANCE", instance);
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", workspace);
    const pool = new RoomPool();
    const store = new PostgresSpaceStore(pool);
    const room = await store.ensureUserStarterRoom("user:test", "test@example.invalid");
    expect(room?.projectPath).toBe(instance === "dev" ? workspace : "/opt/spaceapp");
    const pane = pool.calls.find(call => call.sql.includes("INSERT INTO panes"));
    expect(pane?.values[8]).toBe(instance === "dev" ? workspace : "/etc");
  });

  it("keeps the stable createRoom default despite a configured CLI workspace", async () => {
    vi.stubEnv("SPACE_INSTANCE", "stable");
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", workspace);
    const store = new PostgresSpaceStore(new RoomPool());
    expect((await store.createRoom({ name: "Default", initialPaneCount: 0 })).projectPath).toBe("/opt/spaceapp");
  });
});
