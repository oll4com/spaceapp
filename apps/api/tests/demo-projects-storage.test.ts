import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryDemoProjectsRepository } from "@space/db";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { registerDemoProjectsRoutes } from "../src/demo-projects/routes.js";
import { DemoProjectsService } from "../src/demo-projects/service.js";

/**
 * An optional feature must never take the API down: Demo Projects initializes on
 * first use and reports its own failure to that request instead of crashing or
 * blocking Space startup (regression guard for the EACCES crash loop).
 */
function buildService(varRoot: string): DemoProjectsService {
  return new DemoProjectsService({
    repository: new InMemoryDemoProjectsRepository(),
    credentialStore: new DemoCredentialStore(join(varRoot, "secrets")),
    demoRoot: join(varRoot, "demos"),
    varRoot,
    apiPort: 4910,
    publicOrigin: "https://space.example",
    portRangeStart: 51_700,
    portRangeEnd: 51_760,
    healthTimeoutMs: 1_000
  });
}

async function buildApp(service: DemoProjectsService) {
  const app = Fastify();
  app.decorateRequest("requestIdForSpace", "");
  registerDemoProjectsRoutes(app, {
    service,
    enabled: true,
    rateLimitOptions: {},
    sessionToken: () => "session-token",
    ownerId: async () => "user:test",
    resolvePublicOrigin: () => "https://space.example"
  });
  await app.ready();
  return app;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
});

describe("demo projects startup safety", () => {
  it("does not touch the filesystem until the first request", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-demo-lazy-"));
    const service = buildService(root);
    cleanup.push(async () => {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const app = await buildApp(service);
    cleanup.push(async () => {
      await app.close();
    });
    // Creating the app alone must not create runtime state (mirrors createApp wiring).
    await expect(stat(join(root, "secrets"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.initialize()).toBeUndefined();
    expect((await stat(join(root, "secrets"))).isDirectory()).toBe(true);
    const files = await readdir(join(root, "secrets"));
    expect(files).toContain("credentials");
  });

  it("reports unavailable storage to the request instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-demo-broken-"));
    const service = buildService(join(root, "unwritable"));
    cleanup.push(async () => {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    });
    // A regular file where the storage root must be created makes mkdir fail.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "unwritable"), "not a directory", "utf8");
    const app = await buildApp(service);
    cleanup.push(async () => {
      await app.close();
    });
    const response = await app.inject({ method: "GET", url: "/api/demo-projects/state" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "DEMO_PROJECTS_UNAVAILABLE" } });
    const catalog = await app.inject({ method: "GET", url: "/api/demo-projects/state" });
    expect(catalog.statusCode).toBe(503);
  });

  it("keeps serving when the feature is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-demo-disabled-"));
    const service = buildService(root);
    cleanup.push(async () => {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const app = Fastify();
    app.decorateRequest("requestIdForSpace", "");
    registerDemoProjectsRoutes(app, {
      service,
      enabled: false,
      rateLimitOptions: {},
      sessionToken: () => "",
      ownerId: async () => "user:test",
      resolvePublicOrigin: () => "https://space.example"
    });
    await app.ready();
    cleanup.push(async () => {
      await app.close();
    });
    const response = await app.inject({ method: "GET", url: "/api/demo-projects/state" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "DEMO_PROJECTS_DISABLED" } });
  });
});
