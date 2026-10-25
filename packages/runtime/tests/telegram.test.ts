import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryTelegramPersistence,
  TelegramApiError,
  TelegramBotApiClient,
  TelegramIntegrationManager,
  TelegramSecretStore
} from "../src/telegram.js";

const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";
const stagedRoots: string[] = [];

afterEach(async () => {
  await Promise.all(stagedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Telegram Bot API client", () => {
  it("uses only the fixed Telegram origin, rejects redirects, and validates response schemas", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        ok: true,
        result: { id: 42, is_bot: true, first_name: "Space", username: "space_completion_bot" }
      });
    });
    const client = new TelegramBotApiClient(token, { fetchImpl });

    await expect(client.getMe()).resolves.toMatchObject({ id: "42", username: "space_completion_bot" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${token}/getMe`);
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBeUndefined();

    const invalid = new TelegramBotApiClient(token, {
      fetchImpl: vi.fn(async () => jsonResponse({ ok: true, result: { id: "wrong", is_bot: "yes" } }))
    });
    await expect(invalid.getMe()).rejects.toMatchObject({ code: "TELEGRAM_INVALID_RESPONSE" });
  });

  it("returns only bounded safe errors and preserves Telegram retry_after", async () => {
    const client = new TelegramBotApiClient(token, {
      fetchImpl: vi.fn(async () => jsonResponse({
        ok: false,
        error_code: 429,
        description: "sensitive upstream description",
        parameters: { retry_after: 17 }
      }, 429))
    });

    await expect(client.sendMessage("123", "hello")).rejects.toEqual(
      expect.objectContaining({ code: "TELEGRAM_RATE_LIMITED", statusCode: 429, retryAfterSeconds: 17 })
    );
    try {
      await client.sendMessage("123", "hello");
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramApiError);
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain("123");
      expect(String(error)).not.toContain("sensitive upstream description");
    }
  });

  it("long-polls with callback queries, sends inline keyboards, answers a pressed button and keeps the connected chat's offset (Nous two-way, 2026-10-24)", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).endsWith("/getUpdates")) return jsonResponse({ ok: true, result: [
        { update_id: 5, message: { text: "ναι", chat: { id: 123, type: "private" }, reply_to_message: { text: "Nous: Send it?\n\nDecision nous_decision:abc123def456" } } },
        { update_id: 6, callback_query: { id: "q6", data: "nd:abc123def456:a", message: { chat: { id: 123, type: "private" } } } }
      ] });
      if (String(url).endsWith("/answerCallbackQuery")) return jsonResponse({ ok: true, result: true });
      return jsonResponse({ ok: true, result: { message_id: 9 } });
    });
    const client = new TelegramBotApiClient(token, { fetchImpl });
    const updates = await client.getUpdates(3, { allowed: ["message", "callback_query"], timeoutSeconds: 20 });
    expect(updates).toEqual([
      { updateId: 5, message: { text: "ναι", replyToText: "Nous: Send it?\n\nDecision nous_decision:abc123def456", chat: { id: "123", type: "private" } } },
      { updateId: 6, callbackQuery: { id: "q6", data: "nd:abc123def456:a", chatId: "123" }, message: undefined }
    ]);
    const polled = new URLSearchParams(calls[0]!.body);
    expect([polled.get("offset"), polled.get("timeout"), polled.get("allowed_updates")]).toEqual(["3", "20", JSON.stringify(["message", "callback_query"])]);
    // The pairing's plain poll is unchanged.
    await client.getUpdates(3);
    expect(new URLSearchParams(calls[1]!.body).get("allowed_updates")).toBe(JSON.stringify(["message"]));
    await client.sendMessage("123", "card", { replyMarkup: { inline_keyboard: [[{ text: "Approve", callback_data: "nd:abc123def456:a" }]] } });
    expect(new URLSearchParams(calls[2]!.body).get("reply_markup")).toBe(JSON.stringify({ inline_keyboard: [[{ text: "Approve", callback_data: "nd:abc123def456:a" }]] }));
    await client.answerCallbackQuery("q6", "Approved");
    expect(calls[3]!.url).toBe(`https://api.telegram.org/bot${token}/answerCallbackQuery`);
    expect(new URLSearchParams(calls[3]!.body).get("callback_query_id")).toBe("q6");
    const persistence = new InMemoryTelegramPersistence("2026-10-24T00:00:00.000Z");
    await persistence.updateIntegrationOffset(12, "2026-10-24T01:00:00.000Z");
    await persistence.updateIntegrationOffset(9, "2026-10-24T02:00:00.000Z");
    expect(await persistence.getIntegration()).toMatchObject({ pollingOffset: 12, updatedAt: "2026-10-24T02:00:00.000Z" });
  });

  it("validates the Bot API message limit by Unicode characters instead of UTF-16 code units", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 1 } }));
    const client = new TelegramBotApiClient(token, { fetchImpl });

    await expect(client.sendMessage("123", "🙂".repeat(2_500))).resolves.toEqual({ messageId: "1" });
    await expect(client.sendMessage("123", "🙂".repeat(4_097))).rejects.toMatchObject({
      code: "TELEGRAM_MESSAGE_INVALID"
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("Telegram secret storage and pairing", () => {
  it("writes versioned credentials atomically with 0700 directories and 0600 files", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-secret-"));
    stagedRoots.push(root);
    const secrets = new TelegramSecretStore(root);

    const version = await secrets.write(token);
    expect(await secrets.read(version)).toBe(token);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "tokens"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "tokens", version))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(root, "tokens", version), "utf8")).toBe(token);
  });

  it("keeps the previous credential active until private-chat pairing and automatic test succeed", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-manager-"));
    stagedRoots.push(root);
    const secrets = new TelegramSecretStore(root);
    const persistence = new InMemoryTelegramPersistence();
    let activeCode = "";
    const sent: Array<{ chatId: string; text: string }> = [];
    const clientFactory = vi.fn(() => ({
      async getMe() {
        return { id: "42", isBot: true, firstName: "Space", username: "space_completion_bot" };
      },
      async getWebhookInfo() {
        return { url: "" };
      },
      async getUpdates() {
        return [{
          updateId: 9,
          message: {
            text: `/start ${activeCode}`,
            chat: { id: "998877", type: "private", firstName: "Ada", username: "ada" }
          }
        }];
      },
      async sendMessage(chatId: string, text: string) {
        sent.push({ chatId, text });
        return { messageId: "1" };
      }
    }));
    const manager = new TelegramIntegrationManager({ persistence, secrets, clientFactory });

    const pairing = await manager.createPairing(token, "user:admin");
    activeCode = new URL(pairing.pairing.pairingUrl).searchParams.get("start") ?? "";
    expect(pairing.integration.connectionStatus).toBe("PAIRING");
    expect(pairing.integration.isEnabled).toBe(false);
    expect(JSON.stringify(pairing)).not.toContain(token);

    const connected = await manager.checkPairing(pairing.pairing.id);
    expect(connected).toMatchObject({
      connectionStatus: "CONNECTED",
      isEnabled: true,
      botUsername: "space_completion_bot",
      chatDisplayName: "Ada (@ada)"
    });
    expect(sent).toEqual([{ chatId: "998877", text: expect.stringContaining("Space") }]);
    expect((await persistence.getIntegration()).legacySuppressionActive).toBe(true);
  });

  it("can retry pairing activation after a transient database failure without losing the matched update", async () => {
    class FailOnceActivationPersistence extends InMemoryTelegramPersistence {
      activationAttempts = 0;

      override async activatePairing(input: Parameters<InMemoryTelegramPersistence["activatePairing"]>[0]) {
        this.activationAttempts += 1;
        if (this.activationAttempts === 1) throw new Error("transient database failure");
        return super.activatePairing(input);
      }
    }

    const root = await mkdtemp(join(tmpdir(), "space-telegram-pairing-retry-"));
    stagedRoots.push(root);
    const persistence = new FailOnceActivationPersistence();
    let activeCode = "";
    let updateOffset = 0;
    let testMessageCount = 0;
    const manager = new TelegramIntegrationManager({
      persistence,
      secrets: new TelegramSecretStore(root),
      clientFactory: () => ({
        async getMe() {
          return { id: "42", isBot: true, firstName: "Space", username: "space_completion_bot" };
        },
        async getWebhookInfo() {
          return { url: "" };
        },
        async getUpdates(offset) {
          updateOffset = offset;
          return offset <= 9
            ? [{
                updateId: 9,
                message: {
                  text: `/start ${activeCode}`,
                  chat: { id: "998877", type: "private", firstName: "Ada" }
                }
              }]
            : [];
        },
        async sendMessage() {
          testMessageCount += 1;
          return { messageId: String(testMessageCount) };
        }
      })
    });

    const pairing = await manager.createPairing(token, "user:admin");
    activeCode = new URL(pairing.pairing.pairingUrl).searchParams.get("start") ?? "";

    await expect(manager.checkPairing(pairing.pairing.id)).rejects.toThrow("transient database failure");
    await expect(manager.checkPairing(pairing.pairing.id)).resolves.toMatchObject({
      connectionStatus: "CONNECTED",
      isEnabled: true
    });
    expect(updateOffset).toBe(0);
    expect(testMessageCount).toBe(2);
  });

  it("rejects webhooks, non-private chats, expired codes, and replayed pairing checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-telegram-rejections-"));
    stagedRoots.push(root);
    const secrets = new TelegramSecretStore(root);
    const persistence = new InMemoryTelegramPersistence();
    let code = "";
    let now = new Date("2026-07-14T10:00:00.000Z");
    const updates = [{
      updateId: 2,
      message: { text: "", chat: { id: "100", type: "group", title: "Unsafe group" } }
    }];
    const manager = new TelegramIntegrationManager({
      persistence,
      secrets,
      now: () => now,
      clientFactory: () => ({
        async getMe() {
          return { id: "42", isBot: true, firstName: "Space", username: "space_completion_bot" };
        },
        async getWebhookInfo() {
          return { url: "" };
        },
        async getUpdates() {
          updates[0]!.message.text = `/start ${code}`;
          return updates;
        },
        async sendMessage() {
          return { messageId: "1" };
        }
      })
    });
    const pairing = await manager.createPairing(token, "user:admin");
    code = new URL(pairing.pairing.pairingUrl).searchParams.get("start") ?? "";
    await expect(manager.checkPairing(pairing.pairing.id)).resolves.toMatchObject({ connectionStatus: "PAIRING" });

    updates[0]!.message.chat = { id: "100", type: "private", firstName: "Ada" };
    await expect(manager.checkPairing(pairing.pairing.id)).resolves.toMatchObject({ connectionStatus: "CONNECTED" });
    await expect(manager.checkPairing(pairing.pairing.id)).rejects.toMatchObject({ code: "TELEGRAM_PAIRING_REPLAYED" });

    const webhookManager = new TelegramIntegrationManager({
      persistence: new InMemoryTelegramPersistence(),
      secrets,
      clientFactory: () => ({
        async getMe() {
          return { id: "42", isBot: true, firstName: "Space", username: "space_completion_bot" };
        },
        async getWebhookInfo() {
          return { url: "https://example.invalid/webhook" };
        },
        async getUpdates() {
          return [];
        },
        async sendMessage() {
          return { messageId: "1" };
        }
      })
    });
    await expect(webhookManager.createPairing(token, "user:admin")).rejects.toMatchObject({ code: "TELEGRAM_WEBHOOK_CONFLICT" });

    const expiryPersistence = new InMemoryTelegramPersistence();
    const expiryManager = new TelegramIntegrationManager({
      persistence: expiryPersistence,
      secrets,
      now: () => now,
      clientFactory: () => ({
        async getMe() { return { id: "42", isBot: true, firstName: "Space", username: "space_completion_bot" }; },
        async getWebhookInfo() { return { url: "" }; },
        async getUpdates() { return []; },
        async sendMessage() { return { messageId: "1" }; }
      })
    });
    const expiring = await expiryManager.createPairing(token, "user:admin");
    now = new Date("2026-07-14T10:11:00.000Z");
    await expect(expiryManager.checkPairing(expiring.pairing.id)).rejects.toMatchObject({ code: "TELEGRAM_PAIRING_EXPIRED" });
  });
});
