import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHistoryPeriod, withinHistory } from "../src/history-period-routes.js";

// Every history follows the owner's History period (operator 1/11 03:37 BKK, plan clipboard:8riKjb1krKyL).
const day = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();

describe("history period", () => {
  it("keeps rows inside the period and every row that still waits, and stops paging past it", () => {
    const rows = [{ id: "new", status: "RESOLVED", createdAt: ago(1) }, { id: "old", status: "ACKED", createdAt: ago(20) },
      { id: "waits", status: "OPEN", createdAt: ago(20) }, { id: "timeless", status: "DONE" }];
    expect(withinHistory({ notifications: rows, hasMore: true, nextCursor: "9" }, ["notifications"], ago(7)).payload)
      .toEqual({ notifications: [rows[0], rows[2], rows[3]], hasMore: false, nextCursor: null });
    // The clipboard's notes and plans are records: only copies and pastes are its history.
    const clips = [{ id: "note", source: "MANUAL_NOTE", lastUsedAt: ago(20) }, { id: "copy", source: "COPY", lastUsedAt: ago(20) }];
    expect(withinHistory({ data: clips }, [{ list: "data", at: "lastUsedAt", history: (row) => row.source === "COPY" }], ago(7)))
      .toEqual({ payload: { data: [clips[0]] }, cut: true });
  });

  it("filters the listed routes' answers and floors the routes that take a lower bound, for the signed-in owner only", async () => {
    const app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("onRequest", async (request) => { if (request.headers["x-user"]) (request as unknown as { user: object }).user = { id: "user:operator" }; });
    registerHistoryPeriod(app, async () => ({ history: { periodDays: 7 } }));
    app.get("/api/notifications", async () => ({ notifications: [{ id: "a", status: "ACKED", createdAt: ago(1) }, { id: "b", status: "ACKED", createdAt: ago(30) }] }));
    app.get("/api/admin/gateway/logs", async (request) => request.query);
    app.get("/api/admin/gateway/reports", async (request) => request.query);
    app.get("/api/admin/gateway/anthropic-billing", async (request) => request.query);
    const get = async (url: string, user = true) => { const res = await app.inject({ url, headers: user ? { "x-user": "1" } : {} }); if (res.statusCode !== 200) throw new Error(res.body); return res.json(); };
    expect((await get("/api/notifications")).notifications.map((row: { id: string }) => row.id)).toEqual(["a"]);
    expect((await get("/api/notifications", false)).notifications).toHaveLength(2);
    const since = Date.parse((await get("/api/admin/gateway/logs")).from);
    expect(Math.abs(since - (Date.now() - 7 * day))).toBeLessThan(60_000);
    const recent = ago(1);
    expect((await get(`/api/admin/gateway/logs?from=${encodeURIComponent(recent)}`)).from).toBe(recent);
    expect((await get(`/api/admin/gateway/reports?from=2020-01-01&to=${ago(0).slice(0, 10)}`)).from).toBe(ago(7).slice(0, 10));
    expect(await get("/api/admin/gateway/anthropic-billing?days=30")).toEqual({ days: "7" });
    expect(await get("/api/admin/gateway/anthropic-billing?days=3")).toEqual({ days: "3" });
    await app.close();
  });
});
