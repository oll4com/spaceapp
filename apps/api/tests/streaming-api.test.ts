import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { InMemoryStreamingBotRepository, InMemoryStreamingRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, redactRequestUrlForLog } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { StreamingCredentialStore } from "../src/streaming-credential-store.js";
import { StreamingService } from "../src/streaming-service.js";
import { StreamingBotService } from "../src/streaming-bot-service.js";

const sessionSecret = "streaming-api-test-secret";
const apps: FastifyInstance[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    "x-space-csrf-token": createCsrfToken(session, sessionSecret)!
  };
}

async function setup(internalToken?: string) {
  const store = new InMemorySpaceStore();
  const repository = new InMemoryStreamingRepository();
  const botRepository = new InMemoryStreamingBotRepository();
  const root = join(tmpdir(), `space-streaming-secrets-api-${crypto.randomUUID()}`);
  const streamingService = new StreamingService({
    repository,
    credentialStore: new StreamingCredentialStore(root),
    store,
    cleanupCredentialRootOnDispose: true
  });
  const app = await createApp({
    store,
    config: getApiConfig(internalToken ? { SPACE_INTERNAL_API_TOKEN: internalToken } : {}),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    streamingService,
    streamingBotService: new StreamingBotService({ botRepository, streamingRepository: repository, store, youtubeDailyBudget: 8000 })
  });
  apps.push(app);
  return { app, store, botRepository };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Streaming admin API", () => {
  it("requires the internal token for bot metric readings", async () => {
    const { app } = await setup("streaming-test-internal-token");
    const url = "/api/internal/streaming/bot/live-metrics";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url,
      headers: { "x-space-internal-token": "streaming-test-internal-token" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ metrics: "" });
  });
  it("requires authentication, ADMIN, and CSRF while returning schema-safe defaults", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/admin/streaming/catalog" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET", url: "/api/admin/streaming/catalog", headers: authHeaders("OPERATOR")
    })).statusCode).toBe(403);
    const admin = authHeaders("ADMIN");
    const catalog = await app.inject({ method: "GET", url: "/api/admin/streaming/catalog", headers: admin });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      providers: [
        { provider: "YOUTUBE", status: "UNCONFIGURED" },
        { provider: "TWITCH", status: "UNCONFIGURED" },
        { provider: "TIKTOK", status: "UNCONFIGURED" },
        { provider: "X", status: "UNCONFIGURED" },
        { provider: "DISCORD", status: "UNCONFIGURED" }
      ],
      settings: { version: 1, tiles: expect.any(Array), customTextEnabled: false }
    });
    expect((await app.inject({
      method: "PATCH",
      url: "/api/admin/streaming/overlay-settings",
      headers: { cookie: admin.cookie },
      payload: { expectedVersion: 1, tiles: [], customTextEnabled: false, customText: "" }
    })).statusCode).toBe(403);
  });

  it("keeps Streaming Live context public and rejects unverified operator actions", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/admin/streaming/live-context" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/streaming/live-context", headers: authHeaders("OPERATOR") })).statusCode).toBe(403);
    const headers = authHeaders("ADMIN");
    const context = await app.inject({ method: "GET", url: "/api/admin/streaming/live-context", headers });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({ metrics: expect.any(Array), messages: [], targets: [], moderation: [], memory: [], knowledge: expect.any(Array) });
    expect(JSON.stringify(context.json())).not.toContain("personalMemories");
    expect((await app.inject({ method: "POST", url: "/api/admin/streaming/live-action", headers,
      payload: { action: "REPLY", platform: "YOUTUBE", message: "Hello chat" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/admin/streaming/live-action", headers,
      payload: { action: "TIMEOUT", activityId: "activity:missing", durationSeconds: 300 } })).statusCode).toBe(409);
  });

  it("filters private chat content and viewer names from public Live context", async () => {
    const { app, botRepository } = await setup();
    const at = new Date().toISOString();
    await botRepository.appendActivity({ id: "activity:private-name", platform: "YOUTUBE", direction: "IN",
      accountId: "account:test", channelId: "chat:test", authorId: "viewer:one", messageId: "message:one",
      author: "person@example.com", message: "What is SpaceApp?", status: "SKIPPED", createdAt: at });
    await botRepository.appendActivity({ id: "activity:private-message", platform: "YOUTUBE", direction: "IN",
      accountId: "account:test", channelId: "chat:test", authorId: "viewer:two", messageId: "message:two",
      author: "Viewer", message: "What is your home address?", status: "SKIPPED", createdAt: at });
    const response = await app.inject({ method: "GET", url: "/api/admin/streaming/live-context", headers: authHeaders("ADMIN") });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toEqual([]);
    expect(response.json().targets.map((item: { id: string }) => item.id)).not.toContain("activity:private-name");
    expect(JSON.stringify(response.json())).not.toContain("person@example.com");
  });

  it("keeps automated replies paused until a dedicated Streaming key and model are ready", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "POST", url: "/api/admin/streaming/bot/resume", headers: authHeaders("ADMIN"), payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("MODEL_UNAVAILABLE");
    const status = await app.inject({ method: "GET", url: "/api/admin/streaming/bot/status", headers: authHeaders("ADMIN") });
    expect(status.json().enabled).toBe(false);
    const checklist = status.json().setup as Array<{ id: string; ok: boolean; hint: string | null }>;
    expect(checklist.map(item => item.id)).toEqual(["llm-key", "model", "chat", "worker"]);
    expect(checklist.find(item => item.id === "llm-key")).toMatchObject({ ok: false, hint: expect.stringContaining("_KEY_FILE") });
  });

  it("pauses even when the selected model left the catalog and keeps bot error codes on every route", async () => {
    const { app, botRepository } = await setup();
    const headers = authHeaders("ADMIN");
    const current = await botRepository.getSettings();
    await botRepository.updateSettings({ expectedVersion: current.version, updatedBy: "test", updatedAt: new Date().toISOString(),
      settings: { ...current, enabled: true, modelSelection: { kind: "API", providerId: "gone", modelId: "gone-model" } } as never });
    const paused = await app.inject({ method: "POST", url: "/api/admin/streaming/bot/pause", headers, payload: {} });
    expect(paused.statusCode).toBe(200);
    expect((await botRepository.getSettings()).enabled).toBe(false);
    const memory = await app.inject({ method: "POST", url: "/api/admin/streaming/bot/memory", headers,
      payload: { title: "Contact", body: "Write to person@example.com" } });
    expect(memory.statusCode).toBe(400);
    expect(memory.json().error.code).toBe("PRIVATE_MEMORY_BLOCKED");
  });

  it("names the moderated viewer from chat activity and times out only items waiting for review", async () => {
    const { app, botRepository } = await setup();
    const headers = authHeaders("ADMIN");
    const now = new Date().toISOString();
    const incoming = await botRepository.appendActivity({ id: "activity:in-1", platform: "TWITCH", accountId: "account-1", channelId: "chat-1",
      authorId: "viewer-1", messageId: "message-1", protectedAccount: false, direction: "IN", author: "viewer", message: "maybe rude", reply: null,
      status: "SKIPPED", createdAt: now });
    const base = { platform: "TWITCH" as const, accountId: "account-1", channelId: "chat-1", userId: "viewer-1", durationSeconds: null, platformActionId: null, safeErrorCode: null };
    await botRepository.recordModerationAction({ ...base, id: "moderation:review", messageId: "message-1", decision: "REVIEW", reason: "AMBIGUOUS", result: "REVIEW" });
    await botRepository.recordModerationAction({ ...base, id: "moderation:warn", messageId: "message-2", decision: "WARN", reason: "ABUSE", result: "SUCCEEDED" });
    const list = await app.inject({ method: "GET", url: "/api/admin/streaming/bot/moderation", headers });
    expect(list.json().actions.find((item: { id: string }) => item.id === "moderation:review"))
      .toMatchObject({ author: "viewer", message: "maybe rude", activityId: incoming.id });
    const warned = await app.inject({ method: "POST", url: "/api/admin/streaming/bot/moderation/moderation:warn/timeout", headers, payload: { durationSeconds: 300 } });
    expect([warned.statusCode, warned.json().error.code]).toEqual([409, "ACTION_NOT_IN_REVIEW"]);
    const review = await app.inject({ method: "POST", url: "/api/admin/streaming/bot/moderation/moderation:review/timeout", headers, payload: { durationSeconds: 300 } });
    expect([review.statusCode, review.json().error.code]).toEqual([409, "ACCOUNT_UNAVAILABLE"]);
    expect((await botRepository.getModerationAction("moderation:review"))?.result).toBe("REVIEW");
  });

  it("rejects private facts in settings before they can reach the public bot", async () => {
    const { app } = await setup();
    const headers = authHeaders("ADMIN");
    const current = (await app.inject({ method: "GET", url: "/api/admin/streaming/bot/settings", headers })).json().settings;
    const response = await app.inject({ method: "PATCH", url: "/api/admin/streaming/bot/settings", headers, payload: {
      expectedVersion: current.version, enabled: false, persona: current.persona, platforms: current.platforms,
      facts: [{ key: "contact", value: "person@example.com" }], faq: current.faq,
      instructions: current.instructions, guardrails: current.guardrails,
      modelSelection: current.modelSelection, fallbackModelSelection: current.fallbackModelSelection,
      memoryEnabled: current.memoryEnabled, moderationEnabled: current.moderationEnabled,
      jevEnabled: current.jevEnabled, overlayTickerEnabled: current.overlayTickerEnabled
    } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("PRIVATE_SETTINGS_BLOCKED");
  });

  it("returns HTTP 409 for optimistic setting conflicts and exposes the default Space snapshot", async () => {
    const { app } = await setup();
    const headers = authHeaders("ADMIN");
    const first = await app.inject({
      method: "PATCH",
      url: "/api/admin/streaming/overlay-settings",
      headers,
      payload: {
        expectedVersion: 1,
        tiles: [{ metricKey: "space.rooms", accountId: null }],
        customTextEnabled: true,
        customText: "Live from Space"
      }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ version: 2, customText: "Live from Space" });
    const conflict = await app.inject({
      method: "PATCH",
      url: "/api/admin/streaming/overlay-settings",
      headers,
      payload: { expectedVersion: 1, tiles: [], customTextEnabled: false, customText: "" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({ code: "STREAMING_SETTINGS_CONFLICT", details: { currentVersion: 2 } });
    const snapshot = await app.inject({ method: "GET", url: "/api/admin/streaming/overlay-snapshot", headers });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ settingsVersion: 2, customText: "Live from Space" });
  });

  it("redacts OAuth code and state query values from request logs", () => {
    const redacted = redactRequestUrlForLog(
      "/api/admin/streaming/providers/YOUTUBE/oauth/callback?code=provider-code&state=one-time-state&scope=readonly"
    );
    expect(redacted).toContain("code=%5BREDACTED%5D");
    expect(redacted).toContain("state=%5BREDACTED%5D");
    expect(redacted).not.toContain("provider-code");
    expect(redacted).not.toContain("one-time-state");
  });

  it("counts only active agents with a running run, even when their chat panes are closed", async () => {
    const { app, store } = await setup();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 0 }, "trace:room");
    const chatPane = store.createPane({ roomId: room.id, title: "Room Agent", mode: "CHAT" }, "trace:pane");
    const session = store.createSpaceAgentSession({
      paneId: chatPane.id,
      roomId: room.id,
      status: "RUNNING",
      title: "Room Agent",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high",
      selectedToolIds: [],
      isActive: true,
      lastSyncedAt: "2026-08-12T00:00:00.000Z"
    });
    const promptMessage = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "user",
      content: "Run the mission.",
      status: "COMPLETED"
    });
    const responseMessage = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    store.createSpaceAgentRun({
      sessionId: session.sessionId,
      roomId: room.id,
      paneId: chatPane.id,
      workflowId: "workflow:mission",
      status: "RUNNING",
      promptMessageId: promptMessage.messageId,
      responseMessageId: responseMessage.messageId
    });
    const stalePane = store.createPane({ roomId: room.id, title: "Stale Chat", mode: "CHAT" }, "trace:pane");
    const staleSession = store.createSpaceAgentSession({
      paneId: stalePane.id,
      roomId: room.id,
      status: "RUNNING",
      title: "Stale Chat",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high",
      selectedToolIds: [],
      isActive: true,
      lastSyncedAt: "2026-08-10T00:00:00.000Z"
    });
    const stalePrompt = store.createSpaceAgentMessage({
      sessionId: staleSession.sessionId,
      role: "user",
      content: "Finished mission.",
      status: "COMPLETED"
    });
    const staleResponse = store.createSpaceAgentMessage({
      sessionId: staleSession.sessionId,
      role: "assistant",
      content: "Done.",
      status: "COMPLETED"
    });
    store.createSpaceAgentRun({
      sessionId: staleSession.sessionId,
      roomId: room.id,
      paneId: stalePane.id,
      workflowId: "workflow:stale",
      status: "COMPLETED",
      promptMessageId: stalePrompt.messageId,
      responseMessageId: staleResponse.messageId
    });
    store.updatePane(chatPane.id, { isClosed: true, status: "CLOSED" }, "trace:pane");
    store.updatePane(stalePane.id, { isClosed: true, status: "CLOSED" }, "trace:pane");
    const snapshot = await app.inject({ method: "GET", url: "/api/admin/streaming/overlay-snapshot", headers: authHeaders("ADMIN") });
    expect(snapshot.statusCode).toBe(200);
    const tile = (snapshot.json().tiles as Array<{ metricKey: string; value: number | null; state: string }>).find(
      (candidate) => candidate.metricKey === "space.active_agents"
    );
    expect(tile).toMatchObject({ value: 1, state: "FRESH" });
  });

  it("accepts a bot ticker provider in the overlay snapshot", async () => {
    const store = new InMemorySpaceStore();
    const repository = new InMemoryStreamingRepository();
    const root = join(tmpdir(), `space-streaming-secrets-api-${crypto.randomUUID()}`);
    const streamingService = new StreamingService({
      repository,
      credentialStore: new StreamingCredentialStore(root),
      store,
      cleanupCredentialRootOnDispose: true,
      botTickerProvider: async () => ({
        enabled: true,
        ticker: [{ author: "viewer", message: "hello", reply: "hi", createdAt: "2026-08-17T00:00:00.000Z" }]
      })
    });
    const app = await createApp({
      store,
      config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      streamingService
    });
    apps.push(app);
    const snapshot = await app.inject({ method: "GET", url: "/api/admin/streaming/overlay-snapshot", headers: authHeaders("ADMIN") });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      botTickerEnabled: true,
      botTicker: [{ author: "viewer", message: "hello", reply: "hi" }]
    });
  });

  it("self-heals and prunes stale account IDs during overlay settings update without 422 error", async () => {
    const { app } = await setup();
    const headers = authHeaders("ADMIN");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/streaming/overlay-settings",
      headers,
      payload: {
        expectedVersion: 1,
        tiles: [
          { metricKey: "space.rooms", accountId: null },
          { metricKey: "youtube.channel.subscribers", accountId: "streaming-account:stale-id" }
        ],
        customTextEnabled: false,
        customText: ""
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tiles).toEqual([{ metricKey: "space.rooms", accountId: null }]);
  });
});
