import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { InMemoryLiveHistoryRepository } from "@space/db";
import { registerLiveHistoryRoutes, verifiedLegacyVoiceTurns } from "../src/live-history-routes.js";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const turn = (id = "t1", roomId = "room:a", revision = 1, text = "ναι") => ({ id, sessionId: "s1", roomId, revision, text, role: "user" as const, timestamp: "2026-09-26T00:00:00Z", createdAtMs: 1790380800000 });
function fixture() {
  const repository = new InMemoryLiveHistoryRepository(); const app = Fastify(); apps.push(app);
  app.addHook("onRequest", async request => { request.user = { id: request.headers["x-test-owner"] ?? "owner:a", role: "ADMIN" } as any; });
  registerLiveHistoryRoutes(app, { repository, routeOptions: {}, assertAccess: async (request, room) => { if (room === "room:private" && request.user?.id !== "owner:a") throw new Error("Forbidden"); } });
  return { app, repository };
}
describe("durable Live history", () => {
  it("keeps owners isolated on list, search, write and clear", async () => {
    const { app, repository } = fixture(); await repository.write("owner:a", turn(), 0);
    for (const url of ["/api/live/history", "/api/voice/realtime/history/room:a", "/api/voice/realtime/history/search?q=ναι"]) {
      const res = await app.inject({ url, headers: { "x-test-owner": "owner:b" } }); expect(res.statusCode).toBe(200);
      expect(res.json().items ?? res.json().results).toEqual([]);
    }
    await app.inject({ method: "DELETE", url: "/api/voice/realtime/logs/room:a", headers: { "x-test-owner": "owner:b" } });
    expect((await repository.read("owner:a")).items).toHaveLength(1);
  });
  it("accepts retries once and refuses stale overwrites or different-room retargets", async () => {
    const { app, repository } = fixture();
    const send = (item: ReturnType<typeof turn>) => app.inject({ method: "POST", url: "/api/live/history/turns", payload: { expectedOwnerId: "owner:a", turns: [{ item, epoch: 0 }] } });
    await send(turn()); await send(turn()); await send(turn("t1", "room:a", 3, "new")); await send(turn("t1", "room:a", 2, "old"));
    expect((await repository.read("owner:a")).items).toMatchObject([{ text: "new", revision: 3 }]);
    expect((await send(turn("t1", "room:b", 4))).json().receipts[0].accepted).toBe(false);
  });
  it("clear increments an epoch and fences late retries without touching another room", async () => {
    const { app, repository } = fixture(); await repository.write("owner:a", turn(), 0); await repository.write("owner:a", turn("other", "room:b"), 0);
    const cleared = await app.inject({ method: "DELETE", url: "/api/voice/realtime/logs/room:a" }); expect(cleared.json().epoch).toBe(1);
    expect(await repository.write("owner:a", turn(), 0)).toBe(false);
    expect(await repository.write("owner:a", turn("fresh"), 1)).toBe(true);
    expect((await repository.read("owner:a")).items.map(item => item.id)).toEqual(["other", "fresh"]);
  });
  it("imports only explicit matching legacy ownership, never global or unowned turns", async () => {
    const rows = [ { ...turn(), ownerId: "owner:a" }, { ...turn("wrong"), ownerId: "owner:b" }, { ...turn("global", "global"), ownerId: "owner:a" }, turn("unknown") ];
    const imported = verifiedLegacyVoiceTurns("owner:a", "room:a", rows.map(item => JSON.stringify(item)).join("\n"));
    expect(imported).toHaveLength(1);
    const { repository } = fixture(); await repository.importLegacy("owner:a", "room:a", imported); await repository.clear("owner:a", "room:a");
    await repository.importLegacy("owner:a", "room:a", imported); expect((await repository.read("owner:a")).items).toEqual([]);
  });
});
