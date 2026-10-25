import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { InMemoryStreamingRepository, InMemoryStreamingBotRepository } from "@space/db";
import { registerStreamingAdminRoutes } from "../src/streaming-admin-routes.js";
import { registerStreamingBotRoutes } from "../src/streaming-bot-routes.js";
import { StreamingService } from "../src/streaming-service.js";
import { StreamingBotService } from "../src/streaming-bot-service.js";
import { StreamingCredentialStore } from "../src/streaming-credential-store.js";
import { createMcpToolExecutor } from "../src/mcp-tool-executor.js";
import { createDecisionsService } from "../src/decisions-service.js";
import { recordAudit } from "../src/request-audit.js";
import { getApiConfig } from "../src/config.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-streaming-secrets-domain-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new InMemorySpaceStore();
  const repository = new InMemoryStreamingRepository();
  const botRepository = new InMemoryStreamingBotRepository();
  const streamingService = new StreamingService({
    repository, store, credentialStore: new StreamingCredentialStore(root)
  });
  cleanups.push(() => streamingService.dispose());
  const streamingBotService = new StreamingBotService({
    botRepository, streamingRepository: repository, store, youtubeDailyBudget: 8000
  });
  const app = Fastify();
  cleanups.push(() => app.close());
  await app.register(cookie);
  // The full application suite tests real authentication/CSRF. This isolated
  // domain harness supplies a principal, without booting other app services.
  app.addHook("onRequest", async request => {
    if (request.headers["x-fixture-role"] === "anonymous") return;
    const role = request.headers["x-fixture-role"] === "OPERATOR" ? "OPERATOR" : "ADMIN";
    request.user = { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@fixture.test`, role };
    request.requestIdForSpace = "req:streaming-domain";
  });
  const audit = (request: Parameters<typeof recordAudit>[1], input: Parameters<typeof recordAudit>[2]) => recordAudit(store, request, input);
  registerStreamingAdminRoutes(app, { streamingService, recordAudit: audit });
  registerStreamingBotRoutes(app, {
    streamingService, streamingBotService, store, recordAudit: audit,
    decisionsService: createDecisionsService({ enabled: false }),
    executeMcpToolWithPolicy: createMcpToolExecutor({
      store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: root }), eventBus: new SpaceEventBus(), recordAudit: audit
    }),
    routeOptions: {}
  });
  return { app, store, repository, streamingBotService, streamingService };
}

it("denies operator mutations in both domains and leaves their state unchanged", async () => {
  const { app, store, repository, streamingBotService } = await fixture();
  const headers = { "x-fixture-role": "OPERATOR" };
  for (const [url, payload] of [
    ["/api/admin/streaming/providers/YOUTUBE/oauth/start", {}],
    ["/api/admin/streaming/bot/memory", { title: "Public note", body: "Visible to viewers" }]
  ] as const) {
    const response = await app.inject({ method: "POST", url, headers, payload });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ADMIN_REQUIRED");
  }
  expect(await repository.listAuthorizations()).toEqual([]);
  expect(await streamingBotService.listReviewedMemory("APPROVED", 50)).toEqual([]);
  expect(store.listAuditEvents()).toEqual([]);
});

it("persists public bot memory and audits correlation without copying its content", async () => {
  const { app, store } = await fixture();
  const response = await app.inject({
    method: "POST", url: "/api/admin/streaming/bot/memory",
    payload: { title: "Public stream schedule", body: "Viewer-facing fixture content" }
  });
  expect(response.statusCode).toBe(200);
  const entry = response.json();
  const read = await app.inject({ method: "GET", url: "/api/admin/streaming/bot/memory?status=APPROVED" });
  expect(read.json().entries).toEqual([expect.objectContaining({ id: entry.id, body: "Viewer-facing fixture content" })]);
  const audit = store.listAuditEvents();
  expect(audit).toEqual([expect.objectContaining({
    action: "admin.streaming.bot_memory_created", traceId: "req:streaming-domain", targetId: entry.id
  })]);
  expect(JSON.stringify(audit)).not.toContain("Viewer-facing fixture content");
});

it("renders an OAuth failure without reflecting provider query data", async () => {
  const { app } = await fixture();
  const response = await app.inject({
    method: "GET",
    url: "/api/admin/streaming/providers/YOUTUBE/oauth/callback?error=private-provider-detail&code=private-code&state=private-state"
  });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain("Connection failed");
  expect(response.body).toContain('"ok":false');
  expect(response.body).not.toContain("private-");
});

it("keeps internal MCP execution fail-closed and optional moderation explicitly unavailable", async () => {
  const { app, store } = await fixture();
  const execution = await app.inject({
    method: "POST", url: "/api/internal/streaming/bot/mcp-execute",
    payload: { toolId: "fixture:unavailable", arguments: {} }
  });
  expect(execution.statusCode).toBe(200);
  expect(execution.json()).toMatchObject({ status: "FAILED", code: "GATEWAY_DISABLED" });
  expect(store.listAuditEvents()).toEqual([expect.objectContaining({ action: "mcp.tool.execute" })]);
  const moderation = await app.inject({
    method: "POST", url: "/api/internal/streaming/bot/moderation-triage", payload: { message: "Hello everyone" }
  });
  expect(moderation.statusCode).toBe(200);
  expect(moderation.json()).toEqual({ available: false, verdict: null });
});

it("keeps cross-browser authorization state-gated after moving it into the domain", async () => {
  const { app, store, streamingService } = await fixture();
  const lookup = vi.spyOn(streamingService, "getPendingAuthorization")
    .mockImplementation((provider, state) => provider === "YOUTUBE" && state === "owned-pending-state"
      ? "https://provider.example/authorize?state=owned-pending-state" : null);
  const headers = { "x-fixture-role": "anonymous" };
  for (const path of ["YOUTUBE/oauth/authorize", "YOUTUBE/oauth/authorize?state=expired", "UNKNOWN/oauth/authorize?state=owned-pending-state"]) {
    const response = await app.inject({ method: "GET", url: `/api/admin/streaming/providers/${path}`, headers });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  }
  const response = await app.inject({ method: "GET", url: "/api/admin/streaming/providers/YOUTUBE/oauth/authorize?state=owned-pending-state", headers });
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe("https://provider.example/authorize?state=owned-pending-state");
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(store.listAuditEvents()).toEqual([]);
});
