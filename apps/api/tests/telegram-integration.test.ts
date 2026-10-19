import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemorySpaceStore,
  InMemoryTelegramPersistence,
  TelegramIntegrationManager,
  TelegramSecretStore,
  type TelegramBotClient
} from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "telegram-api-test-secret";
const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function authHeaders(role: "USER" | "OPERATOR" | "ADMIN") {
  const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
  return {
    cookie: `space_session=${session}`,
    csrf: createCsrfToken(session, sessionSecret)!
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "space-telegram-api-"));
  roots.push(root);
  const store = new InMemorySpaceStore();
  const persistence = new InMemoryTelegramPersistence("2026-07-14T10:00:00.000Z");
  const secrets = new TelegramSecretStore(join(root, "secrets"));
  let pairingCode = "";
  const sent: Array<{ chatId: string; text: string }> = [];
  const client: TelegramBotClient = {
    async getMe() {
      return { id: "42", isBot: true, firstName: "Space", username: "space_completion_bot" };
    },
    async getWebhookInfo() {
      return { url: "" };
    },
    async getUpdates() {
      return pairingCode
        ? [{
            updateId: 10,
            message: {
              text: `/start ${pairingCode}`,
              chat: { id: "998877", type: "private", firstName: "Ada", username: "ada" }
            }
          }]
        : [];
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { messageId: String(sent.length) };
    }
  };
  const clientFactory = vi.fn(() => client);
  const manager = new TelegramIntegrationManager({ persistence, secrets, clientFactory });
  const app = await createApp({
    store,
    telegramIntegrationManager: manager,
    config: getApiConfig({ SPACE_ARTIFACT_ROOT: join(root, "artifacts"), SPACE_TELEGRAM_SECRET_ROOT: join(root, "secrets") }),
    auth: { sessionSecret, devLogin: false, secureCookies: false }
  });
  return {
    app,
    store,
    persistence,
    clientFactory,
    sent,
    setPairingCode(value: string) {
      pairingCode = value;
    },
    root
  };
}

describe("Telegram integration API", () => {
  it("rejects every mutation before side effects for non-admins and disabled Codex", async () => {
    const { app, store, persistence, clientFactory } = await setup();
    const mutations = [
      { method: "POST" as const, url: "/api/integrations/telegram/pairings", payload: { botToken: token } },
      { method: "POST" as const, url: "/api/integrations/telegram/pairings/telegram_pairing:test/check" },
      { method: "POST" as const, url: "/api/integrations/telegram/test-deliveries" },
      { method: "PATCH" as const, url: "/api/integrations/telegram", payload: { isEnabled: true } },
      { method: "DELETE" as const, url: "/api/integrations/telegram" }
    ];
    try {
      const before = await persistence.getIntegration();
      for (const role of ["USER", "OPERATOR"] as const) {
        const auth = authHeaders(role);
        for (const mutation of mutations) {
          const response = await app.inject({ ...mutation, headers: { cookie: auth.cookie, "x-space-csrf-token": auth.csrf } });
          expect(response.statusCode, `${role} ${mutation.url}`).toBe(role === "USER" ? 404 : 403);
          expect(response.json().error.code).toBe(role === "USER" ? "NOT_FOUND" : "ADMIN_REQUIRED");
        }
      }
      await store.updateCliRuntimeSetting("cli:codex", { enabled: false, confirmationToken: "e".repeat(32) }, "user:admin");
      const admin = authHeaders("ADMIN");
      for (const mutation of mutations) {
        const response = await app.inject({ ...mutation, headers: { cookie: admin.cookie, "x-space-csrf-token": admin.csrf } });
        expect(response.statusCode, mutation.url).toBe(409);
        expect(response.json().error.code).toBe("CODEX_MASTER_DISABLED");
      }
      const status = await app.inject({ method: "GET", url: "/api/integrations/telegram", headers: { cookie: admin.cookie } });
      expect(status.statusCode).toBe(200);
      expect(await persistence.getIntegration()).toEqual(before);
      expect(clientFactory).not.toHaveBeenCalled();
      expect(store.snapshot().auditEvents.filter(event => event.action.startsWith("telegram."))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("allows authenticated operators to read safe status but requires ADMIN and CSRF for writes", async () => {
    const { app } = await setup();
    const operator = authHeaders("OPERATOR");
    const admin = authHeaders("ADMIN");

    expect((await app.inject({ method: "GET", url: "/api/integrations/telegram" })).statusCode).toBe(401);

    const status = await app.inject({
      method: "GET",
      url: "/api/integrations/telegram",
      headers: { cookie: operator.cookie }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ connectionStatus: "DISCONNECTED", isEnabled: false });

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/integrations/telegram/pairings",
      headers: { cookie: operator.cookie, "x-space-csrf-token": operator.csrf },
      payload: { botToken: token }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("ADMIN_REQUIRED");

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/integrations/telegram/pairings",
      headers: { cookie: admin.cookie },
      payload: { botToken: token }
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().error.code).toBe("CSRF_INVALID");
    await app.close();
  });

  it("validates, pairs, tests, toggles, and disconnects without returning or auditing secrets", async () => {
    const { app, store, persistence, sent, setPairingCode, root } = await setup();
    const admin = authHeaders("ADMIN");
    const headers = { cookie: admin.cookie, "x-space-csrf-token": admin.csrf };

    const invalid = await app.inject({
      method: "POST",
      url: "/api/integrations/telegram/pairings",
      headers,
      payload: { botToken: "not-a-token" }
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");

    const created = await app.inject({
      method: "POST",
      url: "/api/integrations/telegram/pairings",
      headers,
      payload: { botToken: token }
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain(token);
    expect(JSON.stringify(created.json())).not.toMatch(/credentialPath|chatId/);
    const pairingUrl = new URL(created.json().pairing.pairingUrl as string);
    setPairingCode(pairingUrl.searchParams.get("start") ?? "");

    const checked = await app.inject({
      method: "POST",
      url: `/api/integrations/telegram/pairings/${encodeURIComponent(created.json().pairing.id)}/check`,
      headers
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ connectionStatus: "CONNECTED", isEnabled: true, chatDisplayName: "Ada (@ada)" });
    expect(JSON.stringify(checked.json())).not.toContain("998877");

    const tested = await app.inject({
      method: "POST",
      url: "/api/integrations/telegram/test-deliveries",
      headers
    });
    expect(tested.statusCode).toBe(200);
    expect(sent).toHaveLength(2);

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/integrations/telegram",
      headers,
      payload: { isEnabled: false }
    });
    expect(disabled.json()).toMatchObject({ connectionStatus: "DISABLED", isEnabled: false });
    expect((await persistence.getIntegration()).legacySuppressionActive).toBe(false);

    const forged = await app.inject({
      method: "PATCH",
      url: "/api/integrations/telegram",
      headers,
      payload: { isEnabled: true, chatId: "forged" }
    });
    expect(forged.statusCode).toBe(422);

    const disconnected = await app.inject({
      method: "DELETE",
      url: "/api/integrations/telegram",
      headers
    });
    expect(disconnected.json()).toMatchObject({ connectionStatus: "DISCONNECTED", isEnabled: false, botUsername: null });
    expect(await readdir(join(root, "secrets", "tokens"))).toEqual([]);

    const audit = JSON.stringify(store.snapshot().auditEvents);
    expect(audit).not.toContain(token);
    expect(audit).not.toContain("998877");
    expect(audit).not.toMatch(/botToken|chatId|credentialPath/);
    await app.close();
  });
});
