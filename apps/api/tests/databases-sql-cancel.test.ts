// R11 (SpaceApp Android 0.2.13, plan clipboard:1cZ-YxU8zS2O): a query started with its own sessionId is cancelled by that id.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteAdapter } from "../src/databases/sqlite-adapter.js";

const adapterRef: { current: SqliteAdapter | null } = { current: null };
vi.mock("../src/databases/databases-service.js", () => ({ databasesService: { getAdapter: async () => adapterRef.current } }));
const { registerDatabasesRoutes } = await import("../src/databases/databases-routes.js");

const roots: string[] = [];
// close() kills a query left running by a failed assertion, so a failing run leaves no worker behind.
afterEach(async () => { await adapterRef.current?.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("R11: cancel a running SQL query by the id it was started with", () => {
  it("passes the request's sessionId to the adapter, so the cancel route stops that query and no other id does", async () => {
    const root = await mkdtemp(join("/tmp", "space-sql-cancel-"));
    roots.push(root);
    adapterRef.current = new SqliteAdapter({ filename: join(root, "cancel.sqlite"), isReadOnly: false });
    const app = Fastify();
    registerDatabasesRoutes(app);
    const cancel = (id: string) => app.inject({ method: "POST", url: `/api/databases/sessions/${id}/cancel?connectionId=conn:1` }).then((reply) => reply.json());
    const long = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 500000000) SELECT count(*) AS n FROM c;";
    const running = app.inject({ method: "POST", url: "/api/databases/sessions/execute", payload: { connectionId: "conn:1", sql: long, sessionId: "r11-long-query" } });
    await vi.waitFor(async () => expect(await cancel("r11-long-query")).toEqual({ ok: true }), { timeout: 10_000, interval: 50 });
    const answer = await running;
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toEqual({ ok: false, error: "Query cancelled." });
    expect(await cancel("another-query")).toEqual({ ok: false });
    const tooLong = await app.inject({ method: "POST", url: "/api/databases/sessions/execute", payload: { connectionId: "conn:1", sql: "SELECT 1;", sessionId: "x".repeat(81) } });
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  }, 30_000);
});
