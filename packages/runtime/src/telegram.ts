import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTelegramPairingInputSchema,
  telegramIntegrationStatusSchema,
  telegramPairingResponseSchema,
  type TelegramConnectionStatus,
  type TelegramIntegrationStatus,
  type TelegramPairingResponse
} from "@space/contracts";
import { nanoid } from "nanoid";
import { z } from "zod";

const telegramApiOrigin = "https://api.telegram.org";
const secretVersionPattern = /^telegram_[A-Za-z0-9_-]{8,96}$/;
const pairingCodePattern = /^[A-Za-z0-9_-]{1,64}$/;

export class TelegramApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly retryAfterSeconds: number | null = null,
    public readonly permanent = false
  ) {
    super(code);
    this.name = "TelegramApiError";
  }
}

export class TelegramIntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409
  ) {
    super(message);
    this.name = "TelegramIntegrationError";
  }
}

const telegramFailureSchema = z.object({
  ok: z.literal(false),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().int().positive().max(86_400).optional() }).optional()
});

const telegramUserSchema = z.object({
  id: z.union([z.number().int(), z.string().regex(/^\d+$/)]),
  is_bot: z.literal(true),
  first_name: z.string().min(1).max(256),
  username: z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/)
});

const telegramWebhookInfoSchema = z.object({
  url: z.string().max(2048)
});

const telegramChatSchema = z.object({
  id: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  title: z.string().max(256).optional()
});

const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    text: z.string().max(4096).optional(),
    chat: telegramChatSchema
  }).optional()
});

const telegramMessageSchema = z.object({
  message_id: z.union([z.number().int(), z.string().regex(/^\d+$/)])
});

function telegramSuccessSchema<T extends z.ZodType>(result: T) {
  return z.object({ ok: z.literal(true), result });
}

function safeTelegramError(statusCode: number, retryAfterSeconds: number | null): TelegramApiError {
  if (statusCode === 429) return new TelegramApiError("TELEGRAM_RATE_LIMITED", statusCode, retryAfterSeconds, false);
  if (statusCode === 400) return new TelegramApiError("TELEGRAM_BAD_REQUEST", statusCode, null, true);
  if (statusCode === 401) return new TelegramApiError("TELEGRAM_UNAUTHORIZED", statusCode, null, true);
  if (statusCode === 403) return new TelegramApiError("TELEGRAM_FORBIDDEN", statusCode, null, true);
  if (statusCode >= 500) return new TelegramApiError("TELEGRAM_UPSTREAM_UNAVAILABLE", statusCode, null, false);
  return new TelegramApiError("TELEGRAM_REQUEST_FAILED", statusCode || 502, null, statusCode >= 400 && statusCode < 500);
}

export interface TelegramBotUser {
  id: string;
  isBot: true;
  firstName: string;
  username: string;
}

export interface TelegramWebhookInfo {
  url: string;
}

export interface TelegramUpdate {
  updateId: number;
  message?: {
    text?: string;
    chat: {
      id: string;
      type: "private" | "group" | "supergroup" | "channel";
      firstName?: string;
      lastName?: string;
      username?: string;
      title?: string;
    };
  };
}

export interface TelegramBotClient {
  getMe(): Promise<TelegramBotUser>;
  getWebhookInfo(): Promise<TelegramWebhookInfo>;
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<{ messageId: string }>;
}

export interface TelegramBotApiClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class TelegramBotApiClient implements TelegramBotClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly botToken: string,
    options: TelegramBotApiClientOptions = {}
  ) {
    createTelegramPairingInputSchema.parse({ botToken });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 10_000, 30_000));
  }

  private async request<T>(method: string, resultSchema: z.ZodType<T>, payload?: Record<string, string>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImpl(`${telegramApiOrigin}/bot${this.botToken}/${method}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: payload ? { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } : undefined,
        body: payload ? new URLSearchParams(payload).toString() : undefined
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw response.status >= 500
          ? safeTelegramError(response.status, null)
          : new TelegramApiError("TELEGRAM_INVALID_RESPONSE", 502);
      }
      const failure = telegramFailureSchema.safeParse(body);
      if (failure.success) {
        const upstreamStatus = failure.data.error_code ?? response.status;
        throw safeTelegramError(upstreamStatus, failure.data.parameters?.retry_after ?? null);
      }
      const success = telegramSuccessSchema(resultSchema).safeParse(body);
      if (!response.ok || !success.success) {
        if (!response.ok) throw safeTelegramError(response.status, null);
        throw new TelegramApiError("TELEGRAM_INVALID_RESPONSE", 502);
      }
      return success.data.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (controller.signal.aborted) throw new TelegramApiError("TELEGRAM_TIMEOUT", 504);
      throw new TelegramApiError("TELEGRAM_NETWORK_ERROR", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe(): Promise<TelegramBotUser> {
    const result = await this.request("getMe", telegramUserSchema);
    return {
      id: String(result.id),
      isBot: true,
      firstName: result.first_name,
      username: result.username
    };
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return this.request("getWebhookInfo", telegramWebhookInfoSchema);
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const result = await this.request("getUpdates", z.array(telegramUpdateSchema).max(100), {
      offset: String(Math.max(0, Math.trunc(offset))),
      limit: "100",
      timeout: "0",
      allowed_updates: JSON.stringify(["message"])
    });
    return result.map((update) => ({
      updateId: update.update_id,
      message: update.message
        ? {
            ...(update.message.text === undefined ? {} : { text: update.message.text }),
            chat: {
              id: String(update.message.chat.id),
              type: update.message.chat.type,
              ...(update.message.chat.first_name === undefined ? {} : { firstName: update.message.chat.first_name }),
              ...(update.message.chat.last_name === undefined ? {} : { lastName: update.message.chat.last_name }),
              ...(update.message.chat.username === undefined ? {} : { username: update.message.chat.username }),
              ...(update.message.chat.title === undefined ? {} : { title: update.message.chat.title })
            }
          }
        : undefined
    }));
  }

  async sendMessage(chatId: string, text: string): Promise<{ messageId: string }> {
    if (!/^-?\d{1,24}$/.test(chatId)) throw new TelegramApiError("TELEGRAM_CHAT_INVALID", 400, null, true);
    if (!text || Array.from(text).length > 4096) {
      throw new TelegramApiError("TELEGRAM_MESSAGE_INVALID", 400, null, true);
    }
    const result = await this.request("sendMessage", telegramMessageSchema, { chat_id: chatId, text });
    return { messageId: String(result.message_id) };
  }
}

export class TelegramSecretStore {
  private readonly tokensDirectory: string;

  constructor(private readonly rootDirectory = "/opt/spaceapp/secrets/telegram") {
    this.tokensDirectory = join(rootDirectory, "tokens");
  }

  private assertVersion(version: string): void {
    if (!secretVersionPattern.test(version)) {
      throw new TelegramIntegrationError("TELEGRAM_SECRET_VERSION_INVALID", "Telegram credential reference is invalid.", 500);
    }
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.rootDirectory, 0o700);
    await mkdir(this.tokensDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.tokensDirectory, 0o700);
  }

  async write(botToken: string): Promise<string> {
    const parsed = createTelegramPairingInputSchema.parse({ botToken });
    await this.ensureDirectories();
    const version = `telegram_${Date.now()}_${nanoid(16)}`;
    const target = join(this.tokensDirectory, version);
    const temporary = join(this.tokensDirectory, `.${version}.${nanoid(8)}.tmp`);
    try {
      await writeFile(temporary, parsed.botToken, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      await chmod(target, 0o600);
      return version;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async read(version: string): Promise<string> {
    this.assertVersion(version);
    return readFile(join(this.tokensDirectory, version), "utf8");
  }

  async delete(version: string | null): Promise<void> {
    if (!version) return;
    this.assertVersion(version);
    await unlink(join(this.tokensDirectory, version)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export interface TelegramIntegrationRecord {
  connectionStatus: TelegramConnectionStatus;
  isEnabled: boolean;
  botUserId: string | null;
  botUsername: string | null;
  chatId: string | null;
  chatDisplayName: string | null;
  secretVersion: string | null;
  generation: number;
  pollingOffset: number;
  legacySuppressionActive: boolean;
  pairedAt: string | null;
  enabledAt: string | null;
  disabledAt: string | null;
  lastTestedAt: string | null;
  lastDeliveredAt: string | null;
  errorCode: string | null;
  errorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TelegramPairingStatus = "PENDING" | "CONFIRMED" | "EXPIRED" | "CANCELLED";

export interface TelegramPairingRecord {
  pairingId: string;
  codeHash: string;
  secretVersion: string;
  botUserId: string;
  botUsername: string;
  pollingOffset: number;
  status: TelegramPairingStatus;
  expiresAt: string;
  createdByUserId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
}

export interface StartTelegramPairingInput {
  pairingId: string;
  codeHash: string;
  secretVersion: string;
  botUserId: string;
  botUsername: string;
  expiresAt: string;
  createdByUserId: string | null;
  now: string;
}

export interface ActivateTelegramPairingInput {
  pairingId: string;
  chatId: string;
  chatDisplayName: string;
  pollingOffset: number;
  now: string;
}

export interface TelegramPersistence {
  getIntegration(): Promise<TelegramIntegrationRecord>;
  getPendingPairing(): Promise<TelegramPairingRecord | null>;
  getPairing(pairingId: string): Promise<TelegramPairingRecord | null>;
  startPairing(input: StartTelegramPairingInput): Promise<{
    pairing: TelegramPairingRecord;
    cancelledSecretVersions: string[];
  }>;
  updatePairingOffset(pairingId: string, pollingOffset: number, now: string): Promise<void>;
  expirePairing(pairingId: string, now: string): Promise<void>;
  activatePairing(input: ActivateTelegramPairingInput): Promise<{ integration: TelegramIntegrationRecord; previousSecretVersion: string | null }>;
  setEnabled(isEnabled: boolean, now: string): Promise<TelegramIntegrationRecord>;
  recordTested(now: string): Promise<TelegramIntegrationRecord>;
  disconnect(now: string): Promise<{ integration: TelegramIntegrationRecord; secretVersions: string[] }>;
  markError(code: string, now: string): Promise<TelegramIntegrationRecord>;
}

function copyIntegration(value: TelegramIntegrationRecord): TelegramIntegrationRecord {
  return { ...value };
}

function copyPairing(value: TelegramPairingRecord): TelegramPairingRecord {
  return { ...value };
}

export class InMemoryTelegramPersistence implements TelegramPersistence {
  private integration: TelegramIntegrationRecord;
  private readonly pairings = new Map<string, TelegramPairingRecord>();

  constructor(now = new Date().toISOString()) {
    this.integration = {
      connectionStatus: "DISCONNECTED",
      isEnabled: false,
      botUserId: null,
      botUsername: null,
      chatId: null,
      chatDisplayName: null,
      secretVersion: null,
      generation: 0,
      pollingOffset: 0,
      legacySuppressionActive: false,
      pairedAt: null,
      enabledAt: null,
      disabledAt: null,
      lastTestedAt: null,
      lastDeliveredAt: null,
      errorCode: null,
      errorAt: null,
      createdAt: now,
      updatedAt: now
    };
  }

  async getIntegration(): Promise<TelegramIntegrationRecord> {
    return copyIntegration(this.integration);
  }

  async getPendingPairing(): Promise<TelegramPairingRecord | null> {
    return [...this.pairings.values()].find((pairing) => pairing.status === "PENDING") ?? null;
  }

  async getPairing(pairingId: string): Promise<TelegramPairingRecord | null> {
    const pairing = this.pairings.get(pairingId);
    return pairing ? copyPairing(pairing) : null;
  }

  async startPairing(input: StartTelegramPairingInput): Promise<{
    pairing: TelegramPairingRecord;
    cancelledSecretVersions: string[];
  }> {
    const cancelledSecretVersions: string[] = [];
    for (const [id, pairing] of this.pairings) {
      if (pairing.status === "PENDING") {
        cancelledSecretVersions.push(pairing.secretVersion);
        this.pairings.set(id, { ...pairing, status: "CANCELLED", cancelledAt: input.now });
      }
    }
    const pairing: TelegramPairingRecord = {
      pairingId: input.pairingId,
      codeHash: input.codeHash,
      secretVersion: input.secretVersion,
      botUserId: input.botUserId,
      botUsername: input.botUsername,
      pollingOffset: 0,
      status: "PENDING",
      expiresAt: input.expiresAt,
      createdByUserId: input.createdByUserId,
      createdAt: input.now,
      confirmedAt: null,
      cancelledAt: null
    };
    this.pairings.set(pairing.pairingId, pairing);
    if (!this.integration.secretVersion) {
      this.integration = {
        ...this.integration,
        connectionStatus: "PAIRING",
        isEnabled: false,
        botUserId: input.botUserId,
        botUsername: input.botUsername,
        errorCode: null,
        errorAt: null,
        updatedAt: input.now
      };
    }
    return { pairing: copyPairing(pairing), cancelledSecretVersions };
  }

  async updatePairingOffset(pairingId: string, pollingOffset: number, now: string): Promise<void> {
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.status !== "PENDING") return;
    this.pairings.set(pairingId, { ...pairing, pollingOffset: Math.max(pairing.pollingOffset, pollingOffset) });
    this.integration = { ...this.integration, updatedAt: now };
  }

  async expirePairing(pairingId: string, now: string): Promise<void> {
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.status !== "PENDING") return;
    this.pairings.set(pairingId, { ...pairing, status: "EXPIRED", cancelledAt: now });
    if (!this.integration.secretVersion) {
      this.integration = {
        ...this.integration,
        connectionStatus: "DISCONNECTED",
        botUserId: null,
        botUsername: null,
        updatedAt: now
      };
    }
  }

  async activatePairing(input: ActivateTelegramPairingInput): Promise<{ integration: TelegramIntegrationRecord; previousSecretVersion: string | null }> {
    const pairing = this.pairings.get(input.pairingId);
    if (!pairing || pairing.status !== "PENDING") {
      throw new TelegramIntegrationError("TELEGRAM_PAIRING_REPLAYED", "This pairing session is no longer active.");
    }
    const previousSecretVersion = this.integration.secretVersion;
    this.pairings.set(pairing.pairingId, { ...pairing, status: "CONFIRMED", confirmedAt: input.now });
    this.integration = {
      ...this.integration,
      connectionStatus: "CONNECTED",
      isEnabled: true,
      botUserId: pairing.botUserId,
      botUsername: pairing.botUsername,
      chatId: input.chatId,
      chatDisplayName: input.chatDisplayName,
      secretVersion: pairing.secretVersion,
      generation: this.integration.generation + 1,
      pollingOffset: input.pollingOffset,
      legacySuppressionActive: true,
      pairedAt: input.now,
      enabledAt: input.now,
      disabledAt: null,
      lastTestedAt: input.now,
      errorCode: null,
      errorAt: null,
      updatedAt: input.now
    };
    return { integration: copyIntegration(this.integration), previousSecretVersion };
  }

  async setEnabled(isEnabled: boolean, now: string): Promise<TelegramIntegrationRecord> {
    if (!this.integration.secretVersion || !this.integration.chatId) {
      throw new TelegramIntegrationError("TELEGRAM_NOT_CONNECTED", "Connect a Telegram bot before enabling notifications.");
    }
    this.integration = {
      ...this.integration,
      connectionStatus: isEnabled ? "CONNECTED" : "DISABLED",
      isEnabled,
      generation: this.integration.generation + 1,
      legacySuppressionActive: isEnabled,
      enabledAt: isEnabled ? now : this.integration.enabledAt,
      disabledAt: isEnabled ? null : now,
      errorCode: null,
      errorAt: null,
      updatedAt: now
    };
    return copyIntegration(this.integration);
  }

  async recordTested(now: string): Promise<TelegramIntegrationRecord> {
    this.integration = { ...this.integration, lastTestedAt: now, updatedAt: now };
    return copyIntegration(this.integration);
  }

  async disconnect(now: string): Promise<{ integration: TelegramIntegrationRecord; secretVersions: string[] }> {
    const secretVersions = new Set<string>();
    if (this.integration.secretVersion) secretVersions.add(this.integration.secretVersion);
    for (const pairing of this.pairings.values()) secretVersions.add(pairing.secretVersion);
    this.pairings.clear();
    this.integration = {
      ...this.integration,
      connectionStatus: "DISCONNECTED",
      isEnabled: false,
      botUserId: null,
      botUsername: null,
      chatId: null,
      chatDisplayName: null,
      secretVersion: null,
      generation: this.integration.generation + 1,
      pollingOffset: 0,
      legacySuppressionActive: false,
      pairedAt: null,
      enabledAt: null,
      disabledAt: now,
      lastTestedAt: null,
      lastDeliveredAt: null,
      errorCode: null,
      errorAt: null,
      updatedAt: now
    };
    return { integration: copyIntegration(this.integration), secretVersions: [...secretVersions] };
  }

  async markError(code: string, now: string): Promise<TelegramIntegrationRecord> {
    this.integration = {
      ...this.integration,
      connectionStatus: "ERROR",
      isEnabled: false,
      legacySuppressionActive: false,
      generation: this.integration.generation + 1,
      errorCode: code,
      errorAt: now,
      updatedAt: now
    };
    return copyIntegration(this.integration);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashMatch(value: string, expectedHex: string): boolean {
  const actual = Buffer.from(sha256(value), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function chatDisplayName(chat: NonNullable<TelegramUpdate["message"]>["chat"]): string {
  const name = [chat.firstName, chat.lastName].filter(Boolean).join(" ").trim();
  const username = chat.username ? `@${chat.username}` : "";
  if (name && username) return `${name} (${username})`.slice(0, 160);
  return (name || username || "Private chat").slice(0, 160);
}

export interface TelegramIntegrationManagerOptions {
  persistence: TelegramPersistence;
  secrets: TelegramSecretStore;
  clientFactory?: (botToken: string) => TelegramBotClient;
  now?: () => Date;
  pairingTtlMs?: number;
}

export class TelegramIntegrationManager {
  private readonly clientFactory: (botToken: string) => TelegramBotClient;
  private readonly now: () => Date;
  private readonly pairingTtlMs: number;

  constructor(private readonly options: TelegramIntegrationManagerOptions) {
    this.clientFactory = options.clientFactory ?? ((botToken) => new TelegramBotApiClient(botToken));
    this.now = options.now ?? (() => new Date());
    this.pairingTtlMs = Math.max(60_000, Math.min(options.pairingTtlMs ?? 10 * 60_000, 30 * 60_000));
  }

  private async publicStatus(): Promise<TelegramIntegrationStatus> {
    const [integration, pending] = await Promise.all([
      this.options.persistence.getIntegration(),
      this.options.persistence.getPendingPairing()
    ]);
    return telegramIntegrationStatusSchema.parse({
      connectionStatus: integration.connectionStatus,
      isEnabled: integration.isEnabled,
      botUsername: integration.botUsername,
      chatDisplayName: integration.chatDisplayName,
      pairingId: pending?.pairingId ?? null,
      pairingExpiresAt: pending?.expiresAt ?? null,
      pairedAt: integration.pairedAt,
      enabledAt: integration.enabledAt,
      disabledAt: integration.disabledAt,
      lastTestedAt: integration.lastTestedAt,
      lastDeliveredAt: integration.lastDeliveredAt,
      errorCode: integration.errorCode,
      errorAt: integration.errorAt,
      updatedAt: integration.updatedAt
    });
  }

  async getStatus(): Promise<TelegramIntegrationStatus> {
    return this.publicStatus();
  }

  async createPairing(botToken: string, createdByUserId: string | null): Promise<TelegramPairingResponse> {
    const parsed = createTelegramPairingInputSchema.parse({ botToken });
    const client = this.clientFactory(parsed.botToken);
    const bot = await client.getMe();
    const webhook = await client.getWebhookInfo();
    if (webhook.url) {
      throw new TelegramIntegrationError(
        "TELEGRAM_WEBHOOK_CONFLICT",
        "This bot has an active webhook. Remove it in Telegram before connecting it to Space."
      );
    }
    const code = randomBytes(32).toString("base64url");
    if (!pairingCodePattern.test(code)) {
      throw new TelegramIntegrationError("TELEGRAM_PAIRING_CODE_INVALID", "Could not create a safe pairing code.", 500);
    }
    const now = this.now();
    const pairingId = `telegram_pairing:${nanoid(20)}`;
    const secretVersion = await this.options.secrets.write(parsed.botToken);
    let started: { pairing: TelegramPairingRecord; cancelledSecretVersions: string[] };
    try {
      started = await this.options.persistence.startPairing({
        pairingId,
        codeHash: sha256(code),
        secretVersion,
        botUserId: bot.id,
        botUsername: bot.username,
        expiresAt: new Date(now.getTime() + this.pairingTtlMs).toISOString(),
        createdByUserId,
        now: now.toISOString()
      });
    } catch (error) {
      await this.options.secrets.delete(secretVersion);
      throw error;
    }
    await Promise.all(started.cancelledSecretVersions.map((version) => this.options.secrets.delete(version)));
    const pairing = started.pairing;
    return telegramPairingResponseSchema.parse({
      integration: await this.publicStatus(),
      pairing: {
        id: pairing.pairingId,
        pairingUrl: `https://t.me/${pairing.botUsername}?start=${code}`,
        expiresAt: pairing.expiresAt,
        statusCode: "PAIRING_PENDING"
      }
    });
  }

  async checkPairing(pairingId: string): Promise<TelegramIntegrationStatus> {
    const pairing = await this.options.persistence.getPairing(pairingId);
    if (!pairing) throw new TelegramIntegrationError("TELEGRAM_PAIRING_NOT_FOUND", "Pairing session was not found.", 404);
    if (pairing.status === "CONFIRMED") {
      throw new TelegramIntegrationError("TELEGRAM_PAIRING_REPLAYED", "This pairing session has already been used.");
    }
    if (pairing.status !== "PENDING") {
      throw new TelegramIntegrationError(
        pairing.status === "EXPIRED" ? "TELEGRAM_PAIRING_EXPIRED" : "TELEGRAM_PAIRING_CANCELLED",
        "This pairing session is no longer active."
      );
    }
    const now = this.now();
    if (new Date(pairing.expiresAt).getTime() <= now.getTime()) {
      await this.options.persistence.expirePairing(pairing.pairingId, now.toISOString());
      await this.options.secrets.delete(pairing.secretVersion);
      throw new TelegramIntegrationError("TELEGRAM_PAIRING_EXPIRED", "The pairing link expired. Start a new connection.");
    }
    const botToken = await this.options.secrets.read(pairing.secretVersion);
    const client = this.clientFactory(botToken);
    const updates = await client.getUpdates(pairing.pollingOffset);
    const nextOffset = updates.reduce((maximum, update) => Math.max(maximum, update.updateId + 1), pairing.pollingOffset);
    const match = updates.find((update) => {
      if (update.message?.chat.type !== "private" || !update.message.text) return false;
      const parsedStart = /^\/start ([A-Za-z0-9_-]{1,64})$/.exec(update.message.text);
      return Boolean(parsedStart?.[1] && safeHashMatch(parsedStart[1], pairing.codeHash));
    });
    if (!match?.message) {
      if (nextOffset !== pairing.pollingOffset) {
        await this.options.persistence.updatePairingOffset(pairing.pairingId, nextOffset, now.toISOString());
      }
      return this.publicStatus();
    }

    await client.sendMessage(match.message.chat.id, "Space Telegram notifications are connected. Test delivery succeeded. [END]");
    const activated = await this.options.persistence.activatePairing({
      pairingId: pairing.pairingId,
      chatId: match.message.chat.id,
      chatDisplayName: chatDisplayName(match.message.chat),
      pollingOffset: nextOffset,
      now: now.toISOString()
    });
    if (activated.previousSecretVersion && activated.previousSecretVersion !== pairing.secretVersion) {
      await this.options.secrets.delete(activated.previousSecretVersion);
    }
    return this.publicStatus();
  }

  async sendTest(): Promise<TelegramIntegrationStatus> {
    const integration = await this.options.persistence.getIntegration();
    if (!integration.secretVersion || !integration.chatId) {
      throw new TelegramIntegrationError("TELEGRAM_NOT_CONNECTED", "Connect a Telegram bot before sending a test.");
    }
    const botToken = await this.options.secrets.read(integration.secretVersion);
    await this.clientFactory(botToken).sendMessage(
      integration.chatId,
      `Space Telegram test\nCompleted at: ${this.now().toISOString()}\n[END]`
    );
    await this.options.persistence.recordTested(this.now().toISOString());
    return this.publicStatus();
  }

  async setEnabled(isEnabled: boolean): Promise<TelegramIntegrationStatus> {
    await this.options.persistence.setEnabled(isEnabled, this.now().toISOString());
    return this.publicStatus();
  }

  async disconnect(): Promise<TelegramIntegrationStatus> {
    const disconnected = await this.options.persistence.disconnect(this.now().toISOString());
    await Promise.all(disconnected.secretVersions.map((version) => this.options.secrets.delete(version)));
    return this.publicStatus();
  }
}
