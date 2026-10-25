import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { ZodError } from "zod";
import { InMemorySpaceStore, SpaceNotFoundError, SpaceConflictError } from "@space/runtime";
import { registerClipboardRoutes } from "../src/clipboard-routes.js";
import { registerTaskItemRoutes } from "../src/task-item-routes.js";
import { registerUserLinkRoutes } from "../src/user-link-routes.js";
import { recordAudit } from "../src/request-audit.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  const store = new InMemorySpaceStore();
  store.upsertUser({ id: "user:canonical", email: "owner@example.test", role: "OPERATOR" });
  const app = Fastify();
  apps.push(app);
  // Authentication is a composition-root concern; this fixture supplies two
  // verified principals and exercises domain ownership with the real store.
  app.addHook("onRequest", async request => {
    request.user = request.headers["x-fixture-other"]
      ? { id: "user:other", email: "other@example.test", role: "OPERATOR" }
      : { id: "user:broker", email: "owner@example.test", role: "OPERATOR" };
    request.requestIdForSpace = "req:domain-fixture";
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof ZodError ? 422 : error instanceof SpaceNotFoundError ? 404 : error instanceof SpaceConflictError ? 409 : 500;
    reply.status(status).send({ error: { code: status } });
  });
  const options = { store, routeOptions: {}, recordAudit: (request: Parameters<typeof recordAudit>[1], input: Parameters<typeof recordAudit>[2]) => recordAudit(store, request, input) };
  registerClipboardRoutes(app, options);
  registerTaskItemRoutes(app, options);
  registerUserLinkRoutes(app, options);
  return { app, store };
}

it("canonicalizes private clipboard ownership and never deletes another owner's item", async () => {
  const { app, store } = fixture();
  const created = await app.inject({ method: "POST", url: "/api/clipboard-items", payload: { text: "private fixture", source: "COPY" } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;
  expect(store.listClipboardItems("user:canonical").items.map(item => item.id)).toEqual([id]);
  expect((await app.inject({ url: "/api/clipboard-items", headers: { "x-fixture-other": "1" } })).json().data).toEqual([]);
  expect((await app.inject({ method: "DELETE", url: `/api/clipboard-items/${encodeURIComponent(id)}`, headers: { "x-fixture-other": "1" } })).statusCode).toBe(404);
  expect((await app.inject({ method: "PATCH", url: `/api/clipboard-items/${encodeURIComponent(id)}`, payload: { completed: true } })).statusCode).toBe(200);
  expect((await app.inject("/api/clipboard-items?includeCompleted=false")).json().data).toEqual([]);
  expect((await app.inject({ method: "DELETE", url: "/api/clipboard-items" })).json()).toEqual({ deletedCount: 1 });
});

it("validates task input, enforces owner isolation and correlates audit without objective text", async () => {
  const { app, store } = fixture();
  const input = { title: "Fixture task", objective: "private objective" };
  expect((await app.inject({ method: "POST", url: "/api/task-items", payload: { ...input, ownerUserId: "user:other" } })).statusCode).toBe(422);
  const created = await app.inject({ method: "POST", url: "/api/task-items", payload: input });
  expect(created.statusCode).toBe(201);
  const url = `/api/task-items/${encodeURIComponent(created.json().id)}`;
  expect((await app.inject({ method: "PATCH", url, headers: { "x-fixture-other": "1" }, payload: { status: "RUNNING" } })).statusCode).toBe(404);
  expect((await app.inject({ method: "PATCH", url, payload: { status: "RUNNING" } })).json()).toMatchObject({ status: "RUNNING" });
  const audit = store.snapshot().auditEvents.filter(item => item.action.startsWith("task."));
  expect(audit.length).toBeGreaterThan(0);
  expect(audit.every(item => item.traceId === "req:domain-fixture" && item.actorUserId === "user:canonical")).toBe(true);
  expect(JSON.stringify(audit)).not.toContain("private objective");
});

it("normalizes link conflicts and audits only the hostname", async () => {
  const { app, store } = fixture();
  const created = await app.inject({ method: "POST", url: "/api/links", payload: { title: "Private link", description: "private notes", url: "https://example.test/private#secret", openMode: "EMBEDDED" } });
  expect(created.statusCode).toBe(201);
  expect(created.json().url).toBe("https://example.test/private");
  expect((await app.inject({ method: "POST", url: "/api/links", payload: { title: "Duplicate", url: "https://EXAMPLE.test/private#new" } })).statusCode).toBe(409);
  expect((await app.inject({ url: "/api/links", headers: { "x-fixture-other": "1" } })).json().data).toEqual([]);
  const audit = store.snapshot().auditEvents.filter(item => item.action.startsWith("link."));
  expect(audit).toEqual([expect.objectContaining({ action: "link.create", metadata: { hostname: "example.test" }, traceId: "req:domain-fixture", actorUserId: "user:canonical" })]);
  expect(JSON.stringify(audit)).not.toContain("private");
});
