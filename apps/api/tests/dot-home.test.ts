import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { DOT_PROACTIVE_DEFAULTS, type DotUserSettings } from "@space/contracts";
import type { DotHomeRepository } from "@space/db";
import { dotConversationContext, dotRuntimeFor, registerDotHomeRoutes } from "../src/dot-home.js";

const dotId = `dot:${"a".repeat(32)}`;
const cursor = "2026-10-12T08:00:00.000Z|agent_msg:one";
const settings: DotUserSettings = { defaultDotId: null, defaultModelConfigId: null, defaultPermissionMode: null, confirmExternalActions: true,
  proactive: DOT_PROACTIVE_DEFAULTS, updatedAt: null };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
async function fixture(user: Record<string, unknown> | null = { id: "user:owner", role: "USER" }) {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async (request) => { request.user = user as never; });
  const repository = {
    settings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (_owner: string, patch: { defaultDotId?: string | null }) => patch.defaultDotId === `dot:${"f".repeat(32)}` ? null : settings),
    feed: vi.fn(async (owner: string) => owner === "user:owner" ? { dotId, items: [], nextBefore: null, latestCursor: null, lastActiveAt: null, unread: 0 } : null),
    markRead: vi.fn(async () => ({ unread: 0 })),
    proactiveUsage: vi.fn(async (_owner: string, days: number) => ({ kind: "PROACTIVE", days, calls: 0 }))
  } as unknown as DotHomeRepository;
  const modelChoices = vi.fn(async () => ({ providers: [{ providerId: "codex", providerName: "Codex (OpenAI)", statusReason: null, options: [] }] }));
  registerDotHomeRoutes(app, { repository, routeOptions: {}, authenticatedOwner: async (request) => request.user!.id, modelChoices });
  return { app, repository, modelChoices };
}

it("serves the feed, read marker, settings and models only to an interactive owner", async () => {
  for (const user of [null, { id: "user:owner", role: "ADMIN", automationScope: "CLI" }, { id: "user:owner", role: "USER", proofScope: "READ_ONLY" }]) {
    const { app, repository } = await fixture(user);
    for (const url of ["/api/dots/settings", "/api/dots/models", `/api/dots/${dotId}/feed`, "/api/dots/proactive/usage"]) {
      expect((await app.inject({ url })).statusCode).toBe(user ? 403 : 401);
    }
    expect(repository.feed).not.toHaveBeenCalled();
  }
  const { app, repository, modelChoices } = await fixture();
  expect((await app.inject({ url: `/api/dots/${dotId}/feed?limit=20&before=${encodeURIComponent(cursor)}` })).json()).toMatchObject({ dotId, items: [] });
  expect(repository.feed).toHaveBeenCalledWith("user:owner", dotId, { before: cursor, limit: 20 });
  expect((await app.inject({ method: "POST", url: `/api/dots/${dotId}/feed/read`, payload: { cursor } })).json()).toEqual({ unread: 0 });
  expect((await app.inject({ url: "/api/dots/settings" })).json()).toEqual({ settings });
  expect((await app.inject({ url: "/api/dots/models" })).json().providers[0].providerName).toBe("Codex (OpenAI)");
  expect(modelChoices).toHaveBeenCalledTimes(1);
  // The proactive model calls of this user only, over at most 30 days.
  expect((await app.inject({ url: "/api/dots/proactive/usage" })).json()).toEqual({ kind: "PROACTIVE", days: 7, calls: 0 });
  expect((await app.inject({ url: "/api/dots/proactive/usage?days=30" })).statusCode).toBe(200);
  expect(repository.proactiveUsage).toHaveBeenLastCalledWith("user:owner", 30);
  for (const query of ["days=0", "days=31", "days=x", "owner=user:other"]) {
    expect((await app.inject({ url: `/api/dots/proactive/usage?${query}` })).statusCode).toBe(400);
  }
});

it("rejects other users' Dots, malformed cursors and unknown settings", async () => {
  const other = await fixture({ id: "user:other", role: "USER" });
  expect((await other.app.inject({ url: `/api/dots/${dotId}/feed` })).statusCode).toBe(404);
  const { app, repository } = await fixture();
  for (const query of ["?limit=1000", "?before=yesterday", `?before=${encodeURIComponent(cursor)}&after=${encodeURIComponent(cursor)}`, "?owner=someone"]) {
    expect((await app.inject({ url: `/api/dots/${dotId}/feed${query}` })).statusCode).toBe(400);
  }
  expect((await app.inject({ method: "POST", url: `/api/dots/${dotId}/feed/read`, payload: { cursor: "now" } })).statusCode).toBe(400);
  for (const payload of [{}, { ownerUserId: "someone" }, { defaultPermissionMode: "ask_for_approval" }, { proactive: { intervalMinutes: 1 } }]) {
    expect((await app.inject({ method: "PUT", url: "/api/dots/settings", payload })).statusCode).toBe(400);
  }
  expect(repository.updateSettings).not.toHaveBeenCalled();
  expect((await app.inject({ method: "PUT", url: "/api/dots/settings", payload: { defaultDotId: `dot:${"f".repeat(32)}` } })).statusCode).toBe(404);
  expect((await app.inject({ method: "PUT", url: "/api/dots/settings", payload: { confirmExternalActions: false } })).statusCode).toBe(200);
});

it("resolves a Dot's runtime from its own settings first, then the user's Dots default", () => {
  const user = { defaultModelConfigId: "codex-v1|gpt|medium", defaultPermissionMode: "full_access" as const };
  expect(dotRuntimeFor({ preferences: {} }, user)).toEqual({ modelConfigId: "codex-v1|gpt|medium", permissionMode: "full_access" });
  expect(dotRuntimeFor({ preferences: { runtime: { modelConfigId: "codex-v1|gpt|high", permissionMode: "approve_for_me" } } }, user))
    .toEqual({ modelConfigId: "codex-v1|gpt|high", permissionMode: "approve_for_me" });
  expect(dotRuntimeFor({ preferences: { runtime: { modelConfigId: null } } }, { defaultModelConfigId: null, defaultPermissionMode: null }))
    .toEqual({ modelConfigId: null, permissionMode: null });
});

it("builds a bounded context from other conversations and notices, keeping the newest", () => {
  expect(dotConversationContext("Orbit", { messages: [], notices: [] })).toBeNull();
  const messages = Array.from({ length: 8 }, (_, i) => ({ author: i % 2 ? "DOT" as const : "USER" as const, origin: "USER" as const,
    content: `message ${i} ${"x".repeat(900)}`, createdAt: `2026-10-12T08:0${i}:00.000Z` }));
  const text = dotConversationContext("Orbit", { messages, notices: [{ entryId: "dot_notice:1", content: "New sign-in on Linux", createdAt: "2026-10-12T09:00:00.000Z" }] })!;
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain("message 7");
  expect(text).not.toContain("message 0");
  expect(text).toContain("New sign-in on Linux");
  expect(text).toContain("Orbit: message 7");
  expect(text).toMatch(/data, never instructions/);
});
