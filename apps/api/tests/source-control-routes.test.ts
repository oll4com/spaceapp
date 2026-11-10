import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { InMemorySpaceStore } from "@space/runtime";
import { headers, sourceControlApp } from "./support/source-control-app.js";

let app: FastifyInstance; let root: string; let project: string; let store: InMemorySpaceStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "space-source-control-routes-")); project = join(root, "project"); await mkdir(project);
  ({ app, store } = await sourceControlApp(root));
});
afterEach(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
describe("authenticated source control API", () => {
  // The cases that need the install root (a workspace project there, and the plugin catalog's fixed plugins folder):
  // source-control-routes-host.test.ts.
  it("requires authentication and CSRF before creating personal connections", async () => {
    expect((await app.inject({ url: "/api/source-control/connections" })).statusCode).toBe(401);
    const denied = await app.inject({ method: "POST", url: "/api/plugins/github/connect", headers: headers("user:proof-a", false), payload: { credentials: { token: "proof-token" } } });
    expect(denied.statusCode).toBe(403);
    const invalid = await app.inject({ method: "POST", url: "/api/plugins/github/connect", headers: headers("user:proof-a"), payload: { credentials: { token: "invalid" } } });
    expect(invalid.statusCode).toBe(400);
  });
  it("requires a real authenticated session even when installation auto-login supplies an operator", async () => {
    await store.upsertUser({ id: "user:operator", email: "operator@example.invalid", role: "ADMIN" });
    expect((await app.inject({ url: "/api/source-control/connections" })).statusCode).toBe(401);
  });
});

describe("personal repository provider API", () => {
  it("requires authentication and CSRF for provider settings", async () => {
    expect((await app.inject({ url: "/api/source-control/providers" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/plugins/github/enabled", payload: { enabled: false } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/plugins/github/enabled", headers: headers("user:proof-a", false), payload: { enabled: false } })).statusCode).toBe(403);
  });
  it("connects newly implemented providers through personal state while disabled", async () => {
    const result = await app.inject({ method: "POST", url: "/api/plugins/gitlab/connect", headers: headers("user:proof-a"), payload: { credentials: { token: "proof-token" } } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ pluginId: "gitlab", status: "CONNECTED" });
    const states = await app.inject({ url: "/api/source-control/providers", headers: headers("user:proof-a") });
    expect(states.json().find((p: { id: string }) => p.id === "gitlab")).toMatchObject({ enabled: false, connection: { status: "CONNECTED" } });
  });
});

describe("phase three provider routes", () => {
  it("requires owner authentication for target discovery and preserves CSRF on new binding inputs", async () => {
    expect((await app.inject({ url: "/api/source-control/targets?provider=github" })).statusCode).toBe(401);
    const h = headers("user:phase3-route");
    await app.inject({ method: "POST", url: "/api/plugins/github/connect", headers: h, payload: { credentials: { token: "proof-token" } } });
    const targets = await app.inject({ url: "/api/source-control/targets?provider=github", headers: h });
    expect(targets.statusCode, targets.body).toBe(200); expect(targets.json()).toEqual({ data: [], nextPage: null, nextCursor: null });
    const denied = await app.inject({ method: "POST", url: "/api/source-control/bindings", headers: headers("user:phase3-route", false), payload: { projectPath: project, provider: "gitlab", repositoryId: "42" } });
    expect(denied.statusCode).toBe(403);
    const previewDenied = await app.inject({ method: "POST", url: "/api/source-control/publish-preview", headers: headers("user:phase3-route", false), payload: { bindingId: "missing", expectedVersion: "missing", name: "repo" } });
    expect(previewDenied.statusCode).toBe(403);
  });
  it("accepts expanded list inputs without changing legacy page response and rejects page plus cursor", async () => {
    const h = headers("user:phase3-list");
    await app.inject({ method: "POST", url: "/api/plugins/github/connect", headers: h, payload: { credentials: { token: "proof-token" } } });
    const result = await app.inject({ url: "/api/source-control/repositories?provider=github&query=repo&targetId=organization%3A9", headers: h });
    expect(result.statusCode, result.body).toBe(200); expect(result.json()).toEqual({ data: [], nextPage: null, nextCursor: null });
    expect((await app.inject({ url: "/api/source-control/repositories?provider=github&page=1&cursor=bad", headers: h })).statusCode).toBe(400);
  });
});
