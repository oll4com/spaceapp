import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { DotsRepository } from "@space/db";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture(user: Record<string, unknown> | null = { id: "user:dot-owner", role: "ADMIN" }) {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async request => { request.user = user as never; });
  const repository = { list: vi.fn(async () => []), get: vi.fn(async () => null), update: vi.fn(async () => null), related: vi.fn(async () => null), dispose: vi.fn() } as unknown as DotsRepository;
  const { registerDotsRoutes } = await import("../src/dots-routes.js");
  registerDotsRoutes(app, { repository, routeOptions: {}, authenticatedOwner: async request => request.user!.id });
  return { app, repository };
}
it("requires an interactive authenticated owner even when scoped callers are admins", async () => {
  for (const user of [null, { id: "user:dot-owner", role: "ADMIN", automationScope: "CLI" }, { id: "user:dot-owner", role: "ADMIN", proofScope: "READ_ONLY" }]) {
    const { app, repository } = await fixture(user);
    expect((await app.inject({ url: "/api/dots" })).statusCode).toBe(user ? 403 : 401);
    expect(repository.list).not.toHaveBeenCalled();
  }
});
it("binds every lookup to the authenticated owner and returns 404 for another user's dot", async () => {
  const { app, repository } = await fixture();
  const dotId = `dot:${"a".repeat(32)}`;
  expect((await app.inject({ url: "/api/dots" })).statusCode).toBe(200);
  expect(repository.list).toHaveBeenCalledWith("user:dot-owner");
  for (const suffix of ["", "/sessions", "/tasks", "/goals", "/memory", "/schedules", "/receipts", "/activity"]) {
    expect((await app.inject({ url: `/api/dots/${dotId}${suffix}` })).statusCode).toBe(404);
  }
  expect(repository.related).not.toHaveBeenCalled();
  expect((await app.inject({ method: "PATCH", url: `/api/dots/${dotId}`, payload: { name: "Private" } })).statusCode).toBe(404);
  expect(repository.update).toHaveBeenCalledWith("user:dot-owner", dotId, { name: "Private" });
});
it("rejects ownership spoofing, permission escalation, invalid identifiers and unbounded lists", async () => {
  const { app, repository } = await fixture();
  const dotId = `dot:${"a".repeat(32)}`;
  for (const payload of [{ ownerUserId: "other" }, { permissions: { mode: "ADMIN" } }, {}]) {
    expect((await app.inject({ method: "PATCH", url: `/api/dots/${dotId}`, payload })).statusCode).toBe(400);
  }
  expect(repository.update).not.toHaveBeenCalled();
  expect((await app.inject({ url: "/api/dots/not-a-dot" })).statusCode).toBe(400);
  expect((await app.inject({ url: `/api/dots/${dotId}/tasks?limit=100000` })).statusCode).toBe(400);
  expect((await app.inject({ url: "/api/dots?ownerUserId=other" })).statusCode).toBe(400);
});

it("projects collections explicitly and never returns raw payloads or credentials", async () => {
  const { app, repository } = await fixture();
  const dotId = `dot:${"a".repeat(32)}`;
  vi.mocked(repository.get).mockResolvedValue({ dotId } as never);
  vi.mocked(repository.related).mockResolvedValue([{ dotId, id: "record:one", kind: "CONTROL", roomId: "room:one", status: "COMPLETED",
    updatedAt: "2026-10-09T10:00:00.000Z", results: { secret: "private" }, payload: "private", value: { private: true }, provenance: { secret: "private" } }]);
  for (const resource of ["sessions", "tasks", "goals", "memory", "schedules", "receipts", "activity"]) {
    const response = await app.inject({ url: `/api/dots/${dotId}/${resource}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("private");
    expect(response.json().items[0].dotId).toBe(dotId);
  }
});

it("serves every collection under /collections and leaves dedicated paths to their own routes", async () => {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async request => { request.user = { id: "user:dot-owner", role: "USER" } as never; });
  const dotId = `dot:${"a".repeat(32)}`;
  const repository = { get: vi.fn(async () => ({ dotId })), related: vi.fn(async () => [{ dotId, kind: "MISSION", status: "RUNNING" }]) } as unknown as DotsRepository;
  const { registerDotsRoutes } = await import("../src/dots-routes.js");
  registerDotsRoutes(app, { repository, dedicatedResources: ["goals", "schedules"], routeOptions: {}, authenticatedOwner: async request => request.user!.id });
  // A dedicated Stage 4 route can own the plain path without a duplicate-route error.
  app.get("/api/dots/:dotId/goals", async () => ({ dedicated: true }));
  app.get("/api/dots/:dotId/schedules", async () => ({ dedicated: true }));
  expect((await app.inject({ url: `/api/dots/${dotId}/goals` })).json()).toEqual({ dedicated: true });
  expect((await app.inject({ url: `/api/dots/${dotId}/collections/goals` })).json()).toMatchObject({ dotId, items: [{ dotId, kind: "MISSION" }] });
  expect((await app.inject({ url: `/api/dots/${dotId}/tasks` })).statusCode).toBe(200);
  expect((await app.inject({ url: `/api/dots/${dotId}/collections/unknown` })).statusCode).toBe(400);
});

it("validates both the authenticated owner and current room owner for session associations", async () => {
  const { validateSessionDotOwner } = await import("../src/dots-routes.js");
  const dotId = `dot:${"a".repeat(32)}`;
  const repository = { get: vi.fn(async (owner: string) => owner === "user:one" ? { dotId } : null) } as unknown as DotsRepository;
  const store = { getRoom: async () => ({ ownerUserId: "user:one" }) } as never;
  const pane = { roomId: "room:one" } as never;
  await validateSessionDotOwner(store, repository, pane, dotId, "user:one");
  await expect(validateSessionDotOwner(store, repository, pane, dotId, "user:other")).rejects.toThrow();
  await expect(validateSessionDotOwner({ getRoom: async () => ({ ownerUserId: "user:other" }) } as never,
    repository, pane, dotId, "user:one")).rejects.toThrow();
});
