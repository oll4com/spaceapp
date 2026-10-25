import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpaceStore, InMemoryTelegramPersistence, TelegramIntegrationManager, TelegramSecretStore } from "@space/runtime";
import { registerTelegramRoutes } from "../src/telegram-routes.js";
import { recordAudit } from "../src/request-audit.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(role: "ADMIN" | "USER" = "ADMIN") {
  const root = await mkdtemp(join(tmpdir(), "telegram-domain-"));
  roots.push(root);
  const store = new InMemorySpaceStore();
  const persistence = new InMemoryTelegramPersistence("2026-07-14T10:00:00.000Z");
  const manager = new TelegramIntegrationManager({
    persistence, secrets: new TelegramSecretStore(root),
    clientFactory: () => ({
      getMe: async () => ({ id: "42", isBot: true, firstName: "Fixture", username: "fixture_bot" }),
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async () => [],
      sendMessage: async () => ({ messageId: "unused" })
    })
  });
  const app = Fastify();
  apps.push(app);
  await app.register(rateLimit, { global: false });
  app.addHook("onRequest", async request => {
    request.user = { id: "user:telegram-domain", email: "fixture@example.test", role };
    request.requestIdForSpace = "req:telegram-domain";
  });
  registerTelegramRoutes(app, {
    manager,
    visibility: { assertEnabled: async () => undefined },
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  return { app, store, persistence };
}

describe("Standalone Telegram domain", () => {
  it("limits pairing attempts without recording or replacing a ninth pairing", async () => {
    const { app, store, persistence } = await fixture();
    const botToken = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";
    let pairingId = "";
    for (let index = 0; index < 8; index += 1) {
      const response = await app.inject({ method: "POST", url: "/api/integrations/telegram/pairings", payload: { botToken } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ integration: { connectionStatus: "PAIRING" }, pairing: { statusCode: "PAIRING_PENDING" } });
      expect(response.body).not.toContain(botToken);
      pairingId = response.json().pairing.id;
    }
    const ninth = await app.inject({ method: "POST", url: "/api/integrations/telegram/pairings", payload: { botToken } });
    expect(ninth.statusCode).toBe(429);
    expect((await persistence.getPendingPairing())?.pairingId).toBe(pairingId);
    const audit = store.snapshot().auditEvents;
    expect(audit).toHaveLength(8);
    expect(audit.every(event => event.action === "telegram.pairing.created" && event.traceId === "req:telegram-domain")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(botToken);
    expect(JSON.stringify(audit)).not.toMatch(/botToken|chatId|credentialPath/);
  });

  it("reads safe status but denies ordinary user mutations before validation or state changes", async () => {
    const { app, store, persistence } = await fixture("USER");
    const before = await persistence.getIntegration();
    const status = await app.inject({ method: "GET", url: "/api/integrations/telegram" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ connectionStatus: "DISCONNECTED", isEnabled: false });
    const mutation = await app.inject({ method: "PATCH", url: "/api/integrations/telegram", payload: { isEnabled: "invalid" } });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().error.code).toBe("ADMIN_REQUIRED");
    expect(await persistence.getIntegration()).toEqual(before);
    expect(store.snapshot().auditEvents).toEqual([]);
  });
});
