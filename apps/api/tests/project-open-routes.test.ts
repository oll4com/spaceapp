import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { createApp } from "../src/app.js";
import { signSession, createCsrfToken } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { SourceControlService } from "../src/source-control/service.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";

const secret = "project-open-proof-session-secret";
let app: FastifyInstance; let root: string;
const headers = (owner: string, csrf = true, role: "ADMIN" | "USER" = "ADMIN") => {
  const session = signSession({ id: owner, email: `${owner.replace(":", "-")}@example.invalid`, role }, secret);
  return { cookie: `space_session=${session}`, ...(csrf ? { "x-space-csrf-token": createCsrfToken(session, secret)! } : {}) };
};
beforeEach(async () => {
  const scratch = join(tmpdir(), "repository-provider-test-fixtures"); await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "open-routes-"));
  const sourceControlService = new SourceControlService({ repository: new InMemorySourceControlRepository(), credentials: new DemoCredentialStore(join(root, "secrets")), credentialRoot: join(root, "secrets") });
  app = await createApp({ store: new InMemorySpaceStore(), sourceControlService, config: getApiConfig({}), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
}, 30000);
afterEach(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); }, 30000);

describe("project open API", () => {
  it("requires a session and CSRF before creating anything", async () => {
    const payload = { source: { kind: "new", name: "fresh" }, destination: join(root, "fresh") };
    expect((await app.inject({ method: "POST", url: "/api/projects/open", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/projects/open", headers: headers("user:proof-open-a", false), payload })).statusCode).toBe(403);
    await expect(stat(join(root, "fresh"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);

  it("creates a project for an operator and binds it locally without a provider account", async () => {
    const response = await app.inject({ method: "POST", url: "/api/projects/open", headers: headers("user:proof-open-a"), payload: { source: { kind: "new", name: "fresh" }, destination: join(root, "fresh") } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ projectPath: join(root, "fresh"), binding: { kind: "local" }, source: { kind: "new" } });
    const local = await app.inject({ method: "POST", url: "/api/source-control/bindings", headers: headers("user:proof-open-a"), payload: { projectPath: join(root, "fresh"), kind: "local" } });
    expect(local.json().id).toBe(response.json().binding.id);
    const status = await app.inject({ url: `/api/source-control/status?bindingId=${local.json().id}`, headers: headers("user:proof-open-a") });
    expect(status.statusCode).toBe(200); expect(status.json().initialized).toBe(true);
    expect((await app.inject({ url: `/api/source-control/status?bindingId=${local.json().id}`, headers: headers("user:proof-open-b") })).statusCode).toBe(404);
  }, 30000);

  it("keeps non-admin users inside the workspace and reports missing or invalid input clearly", async () => {
    const outside = await app.inject({ method: "POST", url: "/api/projects/open", headers: headers("user:proof-open-u", true, "USER"), payload: { source: { kind: "new", name: "fresh" }, destination: join(root, "fresh") } });
    // Projects live on the owner's disk, which a USER never reaches (MU-001).
    expect(outside.statusCode).toBe(404); expect(outside.json().error.code).toBe("NOT_FOUND");
    await expect(stat(join(root, "fresh"))).rejects.toMatchObject({ code: "ENOENT" });
    const missing = await app.inject({ method: "POST", url: "/api/projects/open", headers: headers("user:proof-open-a"), payload: { source: { kind: "local", path: join(root, "missing") } } });
    expect(missing.statusCode).toBe(404); expect(missing.json().error.code).toBe("PATH_NOT_FOUND");
    for (const payload of [
      { source: { kind: "git-url", url: "https://token@example.org/repo.git" }, destination: join(root, "x") },
      { source: { kind: "git-url", url: "file:///etc" }, destination: join(root, "x") },
      { source: { kind: "local", path: root }, destination: join(root, "x") },
      { source: { kind: "new", name: "x" } }
    ]) expect((await app.inject({ method: "POST", url: "/api/projects/open", headers: headers("user:proof-open-a"), payload })).statusCode).toBe(400);
    expect(await readdir(root)).not.toContain("x");
  }, 30000);

  it("refuses a private-network Git URL without an installation allowlist before creating the folder", async () => {
    const response = await app.inject({ method: "POST", url: "/api/projects/open", headers: headers("user:proof-open-a"), payload: { source: { kind: "git-url", url: "https://127.0.0.1:9/repo.git" }, destination: join(root, "ssrf") } });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe("INVALID_SERVER");
    await expect(stat(join(root, "ssrf"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);
});
