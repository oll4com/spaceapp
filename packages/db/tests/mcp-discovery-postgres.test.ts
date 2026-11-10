import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, type RecordMcpDiscoveryCatalogInput } from "@space/runtime";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
function catalog(entries: Record<string, string[]>): RecordMcpDiscoveryCatalogInput {
  return {
    discoveredAt: "2026-11-03T00:00:00.000Z",
    servers: Object.keys(entries).map(id => ({ id, displayName: id, transport: "stdio", status: "VERIFIED",
      statusReason: "Fixture discovery", schemaVersion: "2025-11-25", configHash: "sha256:fixture", toolCount: 0, lastDiscoveredAt: null })),
    tools: Object.entries(entries).flatMap(([serverId, names]) => names.map(name => ({ id: `${serverId}:${name}`, serverId,
      name, riskLevel: "R0", schemaHash: "sha256:fixture", approvalRequired: true, status: "VERIFIED", statusReason: "Fixture schema" })))
  };
}
const identities = async (store: PostgresSpaceStore | InMemorySpaceStore) => ({
  servers: (await store.listMcpServers()).map(server => [server.id, server.toolCount]).sort(),
  tools: (await store.listMcpTools()).map(tool => tool.id).sort(),
  capabilities: (await store.listCapabilities()).filter(item => item.kind === "MCP_TOOL").map(item => item.id).sort(),
  gateway: await store.getMcpGatewayStatus()
});

describe.skipIf(unavailable !== null)(`MCP discovery recovery on disposable PostgreSQL${unavailable ? ` (${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  beforeAll(async () => { server = await startDisposablePostgres("mcp-discovery"); }, 120_000);
  afterAll(async () => { await server?.stop(); }, 120_000);

  it("reconciles a complete snapshot like memory and does not resurrect old tools after restart", async () => {
    await server.createDatabase("mcp_recovery");
    const pool = server.pool("mcp_recovery");
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
    const store = new PostgresSpaceStore(pool);
    const memory = new InMemorySpaceStore();
    const original = catalog({ "space-a": ["space_old", "space_kept"], "space-retired": ["space_gone"] });
    await store.recordMcpDiscoveryCatalog(original);
    memory.recordMcpDiscoveryCatalog(original);
    await store.createProvider({ id: "fixture-provider", displayName: "Unrelated", type: "CUSTOM" });
    const next = catalog({ "space-a": ["space_kept"], "space-empty": [] });
    await store.recordMcpDiscoveryCatalog(next);
    memory.recordMcpDiscoveryCatalog(next);
    expect(await identities(store)).toEqual(await identities(memory));
    await server.restart("graceful");
    const reopened = new PostgresSpaceStore(server.pool("mcp_recovery"));
    expect(await identities(reopened)).toEqual(await identities(memory));
    expect((await reopened.listProviders()).some(item => item.id === "fixture-provider")).toBe(true);

    const broken = catalog({ "space-a": ["space_bad"] });
    broken.servers[0]!.displayName = "Must roll back";
    broken.tools[0]!.riskLevel = "invalid" as never;
    await expect(reopened.recordMcpDiscoveryCatalog(broken)).rejects.toThrow();
    expect(await identities(reopened)).toEqual(await identities(memory));
    expect((await reopened.listMcpServers())[0]?.displayName).not.toBe("Must roll back");

    await reopened.recordMcpDiscoveryCatalog(catalog({ "space-a": [] }));
    expect(await reopened.listMcpTools()).toEqual([]);
    expect((await reopened.getMcpGatewayStatus()).toolCount).toBe(0);

    const left = catalog({ "space-left": ["space_one"] });
    const right = catalog({ "space-right": ["space_two"] });
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["space:mcp-discovery-catalog"]);
    const writers = Promise.all([reopened.recordMcpDiscoveryCatalog(left), store.recordMcpDiscoveryCatalog(right)]);
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = 'mcp_recovery' AND wait_event = 'advisory'");
        expect(waiting.rows[0].count).toBe(2);
      }, { timeout: 5_000 });
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
      await writers;
    }
    const actual = await identities(reopened);
    const expected = [left, right].map(snapshot => {
      const m = new InMemorySpaceStore(); m.recordMcpDiscoveryCatalog(snapshot); return identities(m);
    });
    expect(await Promise.all(expected)).toContainEqual(actual);
  }, 180_000);
});
