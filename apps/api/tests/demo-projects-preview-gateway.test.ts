import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryDemoProjectsRepository, type DemoProjectsRepository } from "@space/db";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { registerDemoProjectsRoutes } from "../src/demo-projects/routes.js";
import { DemoProjectsService } from "../src/demo-projects/service.js";

/**
 * The preview gateway streams a request into an untrusted demo process. A
 * misbehaving upstream (early socket close, error after headers, slow response)
 * must never write twice or escape as an uncaught exception: that crashed the
 * whole Space API once, so this is a hard regression guard.
 */
interface GatewayContext {
  service: DemoProjectsService;
  repository: DemoProjectsRepository;
  port: number;
  runId: string;
  previewToken: string;
  app: ReturnType<typeof Fastify>;
  upstream: Server;
  upstreamPort: number;
  appOrigin: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const task of cleanups.splice(0)) await task();
});

async function startUpstream(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, port: address.port };
}

async function createGateway(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void
): Promise<GatewayContext> {
  const { server: upstream, port: upstreamPort } = await startUpstream(handler);
  const repository = new InMemoryDemoProjectsRepository();
  const service = new DemoProjectsService({
    repository,
    credentialStore: new DemoCredentialStore("/tmp/space-demo-gateway-secrets"),
    demoRoot: "/tmp/space-demo-gateway-demos",
    varRoot: "/tmp/space-demo-gateway-var",
    apiPort: 4910,
    publicOrigin: "https://space.example",
    portRangeStart: 51_900,
    portRangeEnd: 51_960,
    healthTimeoutMs: 1_000
  });
  const previewToken = "preview-token-value";
  const runId = "demo-run:gateway";
  // Startup reconciliation marks stale runs failed, so initialize before seeding
  // the running run this gateway test proxies to.
  await service.initialize();
  await repository.upsertRun({
    id: runId,
    ownerUserId: "user:test",
    projectId: "project-2-crud-playground",
    variantId: "javascript-react-node",
    mode: "SAMPLE",
    status: "RUNNING",
    port: upstreamPort,
    pid: process.pid,
    previewToken,
    runTokenHash: "0".repeat(64),
    workspacePath: "/tmp/space-demo-gateway-var/runs/demo-run-gateway",
    dataPath: "/tmp/space-demo-gateway-var/runs/demo-run-gateway/data",
    logPath: "/tmp/space-demo-gateway-var/runs/demo-run-gateway/run.log",
    health: null,
    lastError: null,
    startedAt: new Date().toISOString(),
    stoppedAt: null
  });
  const app = Fastify();
  app.decorateRequest("requestIdForSpace", "req:gateway-test");
  registerDemoProjectsRoutes(app, {
    service,
    enabled: true,
    rateLimitOptions: {},
    sessionToken: () => "session-token",
    ownerId: async () => "user:test",
    resolvePublicOrigin: () => "https://space.example"
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const appOrigin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await app.close();
    await service.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  return { service, repository, port: upstreamPort, runId, previewToken, app, upstream, upstreamPort, appOrigin };
}

describe("demo run reconciliation", () => {
  it("marks a run left behind by an API restart as failed", async () => {
    const repository = new InMemoryDemoProjectsRepository();
    const service = new DemoProjectsService({
      repository,
      credentialStore: new DemoCredentialStore("/tmp/space-demo-gateway-secrets"),
      demoRoot: "/tmp/space-demo-gateway-demos",
      varRoot: "/tmp/space-demo-gateway-var",
      apiPort: 4910,
      publicOrigin: "https://space.example",
      portRangeStart: 51_900,
      portRangeEnd: 51_960,
      healthTimeoutMs: 1_000
    });
    cleanups.push(async () => {
      await service.dispose();
    });
    await repository.upsertRun({
      id: "demo-run:stale",
      ownerUserId: "user:test",
      projectId: "project-2-crud-playground",
      variantId: "javascript-react-node",
      mode: "SAMPLE",
      status: "RUNNING",
      port: 51_998,
      pid: 4_194_303,
      previewToken: "stale-preview-token",
      runTokenHash: "0".repeat(64),
      workspacePath: "/tmp/space-demo-gateway-var/runs/demo-run-stale",
      dataPath: "/tmp/space-demo-gateway-var/runs/demo-run-stale/data",
      logPath: "/tmp/space-demo-gateway-var/runs/demo-run-stale/run.log",
      health: null,
      lastError: null,
      startedAt: new Date().toISOString(),
      stoppedAt: null
    });
    await service.initialize();
    const reconciled = await repository.getRun("demo-run:stale");
    expect(reconciled?.status).toBe("FAILED");
    expect(reconciled?.lastError).toContain("interrupted");
    await expect(service.previewTarget("demo-run:stale", "stale-preview-token")).resolves.toBeNull();
  });
});

describe("demo preview gateway", () => {
  it("streams a normal preview response with hardened headers", async () => {
    const gateway = await createGateway((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body>demo</body></html>");
    });
    const response = await fetch(`${gateway.appOrigin}/api/demo-projects/preview/${gateway.runId}/${gateway.previewToken}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.text()).toContain("demo");
  });

  it("answers 502 when the upstream is unreachable", async () => {
    const gateway = await createGateway((_request, response) => {
      response.writeHead(200);
      response.end("ok");
    });
    await new Promise<void>((resolve) => gateway.upstream.close(() => resolve()));
    const response = await fetch(`${gateway.appOrigin}/api/demo-projects/preview/${gateway.runId}/${gateway.previewToken}/api/records`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "DEMO_PREVIEW_UNREACHABLE" } });
  });

  it("survives an upstream that closes the socket before and during the response", async () => {
    const gateway = await createGateway((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<html>");
      response.socket?.destroy();
    });
    for (const path of ["/", "/api/records", "/assets/app.js"]) {
      const response = await fetch(`${gateway.appOrigin}/api/demo-projects/preview/${gateway.runId}/${gateway.previewToken}${path}`);
      expect([200, 502]).toContain(response.status);
      await response.arrayBuffer().catch(() => undefined);
    }
    // The API process must still be usable after the hostile upstream.
    const state = await fetch(`${gateway.appOrigin}/api/demo-projects/state`);
    expect(state.status).toBe(200);
  });

  it("does not leak the run to an invalid preview token", async () => {
    const gateway = await createGateway((_request, response) => {
      response.writeHead(200);
      response.end("ok");
    });
    const response = await fetch(`${gateway.appOrigin}/api/demo-projects/preview/${gateway.runId}/not-the-token/`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "DEMO_PREVIEW_UNAVAILABLE" } });
  });
});
