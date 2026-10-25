import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dotMemoryContext, type DotMemory } from "@space/contracts";
import type { DotMemoryRepository } from "@space/db";
import { createDotMemoryService, registerDotMemoryRoutes } from "../src/dot-memory.js";

const orbit = `dot:${"a".repeat(32)}`;
const nova = `dot:${"b".repeat(32)}`;
const at = "2026-10-11T08:00:00.000Z";
function fixture(options: { embed?: boolean } = {}) {
  const rows = new Map<string, DotMemory & { owner: string; embedding: number[] | null }>();
  let id = 0;
  const visible = (owner: string, dotId: string, row: DotMemory & { owner: string }) => row.owner === owner && (row.dotId === dotId || row.scope === "SHARED");
  const plain = ({ owner: _owner, embedding: _embedding, ...row }: DotMemory & { owner: string; embedding: number[] | null }) => row;
  const memories: DotMemoryRepository = {
    create: vi.fn(async (input) => {
      const row = { memoryId: `dot_memory:${String(++id).padStart(32, "0")}`, dotId: input.dotId, scope: input.scope, projectKey: input.projectKey,
        text: input.text, source: input.source, sourceRef: input.sourceRef, createdAt: at, updatedAt: at, owner: input.ownerUserId, embedding: input.embedding };
      rows.set(row.memoryId, row); return plain(row);
    }),
    list: vi.fn(async (owner, dotId, filter) => [...rows.values()].filter((row) => visible(owner, dotId, row) && (!filter.scope || row.scope === filter.scope)
      && (filter.projectKey == null || row.scope !== "PROJECT" || row.projectKey === filter.projectKey)
      && (!filter.q || row.text.toLowerCase().includes(filter.q.toLowerCase()))).map(plain)),
    get: vi.fn(async (owner, dotId, memoryId) => { const row = rows.get(memoryId); return row && visible(owner, dotId, row) ? plain(row) : null; }),
    update: vi.fn(async (owner, dotId, memoryId, text, embedding) => {
      const row = rows.get(memoryId); if (!row || !visible(owner, dotId, row)) return null;
      rows.set(memoryId, { ...row, text, embedding }); return plain(rows.get(memoryId)!);
    }),
    delete: vi.fn(async (owner, dotId, memoryId) => { const row = rows.get(memoryId); if (!row || !visible(owner, dotId, row)) return false; rows.delete(memoryId); return true; }),
    recall: vi.fn(async (owner, dotId, projectKey, query) => [...rows.values()].filter((row) => visible(owner, dotId, row)
      && (row.scope !== "PROJECT" || row.projectKey === projectKey) && query.text.split(/\s+/).some((term) => row.text.toLowerCase().includes(term.toLowerCase()))).map(plain)),
    dispose: vi.fn(async () => undefined)
  };
  const rooms: Record<string, { ownerUserId: string; projectPath: string | null }> = {
    "room:project": { ownerUserId: "user:1", projectPath: "/srv/app/" }, "room:plain": { ownerUserId: "user:1", projectPath: null },
    "room:foreign": { ownerUserId: "user:2", projectPath: "/srv/foreign" } };
  const audit = vi.fn(async () => undefined);
  const service = createDotMemoryService({
    store: { getRoom: vi.fn(async (roomId: string) => { const room = rooms[roomId]; if (!room) throw Error("missing"); return room; }) } as never,
    dots: { get: vi.fn(async (owner: string, dotId: string) => owner === "user:1" && [orbit, nova].includes(dotId) ? { dotId } : null) } as never,
    memories, ...(options.embed ? { embed: vi.fn(async () => [0.1, 0.2]) } : {}), audit
  });
  return { service, rows, memories, audit };
}

describe("Dot memory service", () => {
  it("keeps memories per Dot, per project and shared, with their source", async () => {
    const { service, rows } = fixture({ embed: true });
    const own = await service.create("user:1", orbit, { text: "Prefers short answers", scope: "DOT" }, "USER", null, null);
    expect(own).toMatchObject({ dotId: orbit, scope: "DOT", projectKey: null, source: "USER" });
    expect(rows.get(own.memoryId)!.embedding).toEqual([0.1, 0.2]);
    const project = await service.create("user:1", orbit, { text: "Deploy with npm run ship", scope: "PROJECT", roomId: "room:project" }, "DOT", "agent_session:1", null);
    expect(project).toMatchObject({ scope: "PROJECT", projectKey: "/srv/app", source: "DOT", sourceRef: "agent_session:1" });
    await expect(service.create("user:1", orbit, { text: "x", scope: "PROJECT", roomId: "room:plain" }, "USER", null, null)).rejects.toMatchObject({ code: "DOT_MEMORY_NO_PROJECT" });
    await expect(service.create("user:1", orbit, { text: "x", scope: "PROJECT", roomId: "room:foreign" }, "USER", null, null)).rejects.toMatchObject({ code: "DOT_MEMORY_NO_PROJECT" });
    const shared = await service.create("user:1", orbit, { text: "Team time zone is Europe/Athens", scope: "SHARED" }, "USER", null, null);
    expect(shared).toMatchObject({ dotId: null, scope: "SHARED" });
    await expect(service.create("user:2", orbit, { text: "x", scope: "DOT" }, "USER", null, null)).rejects.toMatchObject({ status: 404 });
    // Secrets never reach memory verbatim.
    const redacted = await service.create("user:1", orbit, { text: "token sk-abcdefghijklmnopqrstuvwxyz0123456789", scope: "DOT" }, "USER", null, null);
    expect(redacted.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    // Nova sees shared memories but not Orbit's own.
    expect((await service.list("user:1", nova, {})).map((memory) => memory.memoryId)).toEqual([shared.memoryId]);
  });

  it("edits and really forgets memories, and gives a turn only this project's memories", async () => {
    const { service, rows, audit } = fixture();
    const own = await service.create("user:1", orbit, { text: "Likes tables", scope: "DOT" }, "USER", null, null);
    await service.create("user:1", orbit, { text: "Uses pnpm here", scope: "PROJECT", roomId: "room:project" }, "USER", null, null);
    rows.set("dot_memory:other", { ...rows.get(own.memoryId)!, memoryId: "dot_memory:other", scope: "PROJECT", projectKey: "/srv/elsewhere", text: "Elsewhere" });
    expect((await service.context("user:1", orbit, "room:project")).map((memory) => memory.text)).toEqual(["Likes tables", "Uses pnpm here"]);
    expect((await service.context("user:1", orbit, "room:plain")).map((memory) => memory.text)).toEqual(["Likes tables"]);
    expect((await service.update("user:1", orbit, own.memoryId, { text: "Likes bullet lists" }, null)).text).toBe("Likes bullet lists");
    await expect(service.update("user:1", nova, own.memoryId, { text: "x" }, null)).rejects.toMatchObject({ status: 404 });
    await service.forget("user:1", orbit, own.memoryId, null);
    expect(rows.has(own.memoryId)).toBe(false);
    await expect(service.forget("user:1", orbit, own.memoryId, null)).rejects.toMatchObject({ code: "DOT_MEMORY_NOT_FOUND" });
    // Audit records keep ids, never the memory text.
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain("Likes");
  });

  it("serves the dot_memory tools for the calling conversation", async () => {
    const { service } = fixture();
    const session = { sessionId: "agent_session:1", dotId: orbit, roomId: "room:project" };
    const saved = await service.tool(session, "user:1", "dot_memory.remember", { text: "Invoice day is the 5th", scope: "PROJECT" });
    expect(saved).toMatchObject({ status: "COMPLETED", result: { scope: "PROJECT" } });
    const memoryId = (saved as { result: { memoryId: string } }).result.memoryId;
    expect(await service.tool(session, "user:1", "dot_memory.recall", { query: "invoice" })).toMatchObject({ status: "COMPLETED",
      result: { memories: [{ memoryId, text: "Invoice day is the 5th", scope: "PROJECT" }] } });
    expect(await service.tool(session, "user:1", "dot_memory.update", { memoryId, text: "Invoice day is the 6th" })).toMatchObject({ status: "COMPLETED" });
    expect(await service.tool(session, "user:1", "dot_memory.forget", { memoryId })).toMatchObject({ status: "COMPLETED", result: { deleted: true } });
    expect(await service.tool(session, "user:1", "dot_memory.forget", { memoryId })).toMatchObject({ status: "BLOCKED", statusReason: "Memory was not found." });
    expect(await service.tool(session, "user:1", "dot_memory.recall", {})).toMatchObject({ status: "BLOCKED" });
    expect(await service.tool({ ...session, roomId: "room:plain" }, "user:1", "dot_memory.remember", { text: "x", scope: "PROJECT" }))
      .toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/no project/) });
  });

  it("starts turns with a bounded memory summary", () => {
    const text = dotMemoryContext(Array.from({ length: 50 }, (_, index) => ({ memoryId: `dot_memory:${String(index).padStart(32, "0")}`,
      scope: index % 2 ? "DOT" as const : "SHARED" as const, text: `Fact ${index} ${"x".repeat(200)}` })));
    expect(text!.length).toBeLessThan(3300);
    expect(text).toMatch(/^What you remember/);
    expect(text).toContain("[shared] Fact 0");
    expect(dotMemoryContext([])).toBeNull();
  });
});

describe("Dot memory routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  it("list, add, edit and forget for the interactive owner only", async () => {
    const { service } = fixture();
    let user: Record<string, unknown> | null = { id: "user:1", role: "USER" };
    const server = Fastify(); apps.push(server);
    server.addHook("preHandler", async (request) => { request.user = user as never; });
    registerDotMemoryRoutes(server, service, { routeOptions: {}, authenticatedOwner: async (request) => request.user!.id });
    const base = `/api/dots/${encodeURIComponent(orbit)}/memories`;
    const created = await server.inject({ method: "POST", url: base, payload: { text: "Prefers dark mode", scope: "DOT" } });
    expect(created.statusCode).toBe(200);
    const memoryId = created.json().memory.memoryId as string;
    expect((await server.inject({ url: `${base}?q=dark` })).json()).toMatchObject({ dotId: orbit, items: [{ memoryId }] });
    expect((await server.inject({ method: "PATCH", url: `${base}/${encodeURIComponent(memoryId)}`, payload: { text: "Prefers light mode" } })).json().memory.text)
      .toBe("Prefers light mode");
    expect((await server.inject({ method: "DELETE", url: `${base}/${encodeURIComponent(memoryId)}` })).json()).toEqual({ memoryId, deleted: true });
    expect((await server.inject({ method: "DELETE", url: `${base}/${encodeURIComponent(memoryId)}` })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: base, payload: { text: "", scope: "DOT" } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: base, payload: { text: "x", scope: "DOT", owner: "user:2" } })).statusCode).toBe(400);
    user = { id: "user:1", role: "USER", proofScope: "READ_ONLY" };
    expect((await server.inject({ url: base })).statusCode).toBe(403);
    user = null;
    expect((await server.inject({ url: base })).statusCode).toBe(401);
  });
});
