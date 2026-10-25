import { describe, expect, it } from "vitest";
import {
  createTelegramPairingInputSchema,
  telegramIntegrationStatusSchema,
  telegramPairingResponseSchema,
  updateTelegramIntegrationInputSchema
} from "../src/index.js";

describe("Telegram integration contracts", () => {
  it("accepts only bounded BotFather tokens and never models a returned credential", () => {
    expect(createTelegramPairingInputSchema.parse({
      botToken: "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE"
    })).toEqual({ botToken: "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE" });
    expect(createTelegramPairingInputSchema.safeParse({ botToken: "not-a-token" }).success).toBe(false);
    expect(createTelegramPairingInputSchema.safeParse({
      botToken: `123456789:${"a".repeat(300)}`
    }).success).toBe(false);

    const status = telegramIntegrationStatusSchema.parse({
      connectionStatus: "DISCONNECTED",
      isEnabled: false,
      botUsername: null,
      chatDisplayName: null,
      pairingId: null,
      pairingExpiresAt: null,
      pairedAt: null,
      enabledAt: null,
      disabledAt: null,
      lastTestedAt: null,
      lastDeliveredAt: null,
      errorCode: null,
      errorAt: null,
      updatedAt: "2026-07-14T10:00:00.000Z"
    });
    expect(JSON.stringify(status)).not.toMatch(/botToken|credentialPath|chatId/);
  });

  it("models a single-use pairing link and a strict enable toggle", () => {
    const response = telegramPairingResponseSchema.parse({
      integration: {
        connectionStatus: "PAIRING",
        isEnabled: false,
        botUsername: "space_completion_bot",
        chatDisplayName: null,
        pairingId: "telegram_pairing:abc123",
        pairingExpiresAt: "2026-07-14T10:10:00.000Z",
        pairedAt: null,
        enabledAt: null,
        disabledAt: null,
        lastTestedAt: null,
        lastDeliveredAt: null,
        errorCode: null,
        errorAt: null,
        updatedAt: "2026-07-14T10:00:00.000Z"
      },
      pairing: {
        id: "telegram_pairing:abc123",
        pairingUrl: "https://t.me/space_completion_bot?start=pairing_code",
        expiresAt: "2026-07-14T10:10:00.000Z",
        statusCode: "PAIRING_PENDING"
      }
    });
    expect(response.pairing.pairingUrl).toMatch(/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]+$/);
    expect(updateTelegramIntegrationInputSchema.parse({ isEnabled: true })).toEqual({ isEnabled: true });
    expect(updateTelegramIntegrationInputSchema.safeParse({ isEnabled: true, chatId: "forged" }).success).toBe(false);
  });
});
