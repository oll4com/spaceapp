import {
  TelegramApiError,
  TelegramBotApiClient,
  TelegramIntegrationError,
  TelegramSecretStore,
  type TelegramIntegrationRecord
} from "./telegram.js";

export type TelegramOutboxSourceType = "CHAT" | "ROOM_AGENT" | "TERMINAL" | "TEST" | "NOTIFICATION";
export type TelegramOutboxStatus = "PENDING" | "SENDING" | "RETRY" | "DELIVERED" | "CANCELLED" | "FAILED";

export interface TelegramOutboxRecord {
  deliveryId: string;
  integrationGeneration: number;
  sourceKey: string;
  sourceType: TelegramOutboxSourceType;
  roomId: string | null;
  paneId: string | null;
  turnId: string | null;
  roomName: string;
  paneTitle: string;
  agentLabel: string;
  taskTitle: string;
  finalResponse: string;
  completedAt: string;
  status: TelegramOutboxStatus;
  nextPartIndex: number;
  attemptCount: number;
  availableAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  safeErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface TelegramOutboxPersistence {
  getIntegration(): Promise<TelegramIntegrationRecord>;
  claimDeliveries(input: {
    workerId: string;
    limit: number;
    now: string;
    staleBefore: string;
  }): Promise<TelegramOutboxRecord[]>;
  recordDeliveryProgress(input: {
    deliveryId: string;
    workerId: string;
    nextPartIndex: number;
    delivered: boolean;
    now: string;
  }): Promise<void>;
  retryDelivery(input: {
    deliveryId: string;
    workerId: string;
    availableAt: string;
    safeErrorCode: string;
    now: string;
    /** False refunds the claim's attempt (rate limits, held batches, partial progress). */
    countAttempt?: boolean;
  }): Promise<void>;
  failDelivery(input: {
    deliveryId: string;
    workerId: string;
    safeErrorCode: string;
    now: string;
  }): Promise<void>;
  cancelDelivery(deliveryId: string, workerId: string, now: string): Promise<void>;
  markError(code: string, now: string): Promise<TelegramIntegrationRecord>;
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

export function normalizeTelegramTaskTitle(value: string, fallback = "Untitled task"): string {
  const firstNonEmptyLine = (candidate: string) => candidate
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .find((line) => line.length > 0);
  const normalized = firstNonEmptyLine(value) ?? firstNonEmptyLine(fallback) ?? "Untitled task";
  return codePoints(normalized).slice(0, 120).join("");
}

/** Room Agent notices (source key `room-agent-event:`) ask the operator for something instead of reporting a completion. */
export const ROOM_AGENT_NOTICE_SOURCE_PREFIX = "room-agent-event:";
/** Space notifications (source key `space-notification:`): the pane or service that raised it is the agent label. */
export const NOTIFICATION_SOURCE_PREFIX = "space-notification:";

export function formatTelegramCompletionParts(
  input: Pick<TelegramOutboxRecord, "agentLabel" | "roomName" | "taskTitle" | "completedAt" | "finalResponse"> & { sourceKey?: string },
  maxCharacters = 2_500
): string[] {
  const boundedMax = Math.max(500, Math.min(Math.trunc(maxCharacters), 2_500));
  const notice = input.sourceKey?.startsWith(ROOM_AGENT_NOTICE_SOURCE_PREFIX) ?? false;
  const notification = input.sourceKey?.startsWith(NOTIFICATION_SOURCE_PREFIX) ?? false;
  const header = [
    notification ? `Space — ${input.agentLabel}` : notice ? "Space — Room Agent needs you" : "Space — Task completed",
    ...(notification ? [] : [`Agent: ${input.agentLabel}`]),
    `Room: ${input.roomName}`,
    `${notice || notification ? (notification ? "About" : "Question") : "Task"}: ${input.taskTitle}`,
    `${notice || notification ? "At" : "Completed"}: ${input.completedAt}`
  ].join("\n");
  const single = `${header}\n\n${input.finalResponse}\n\n[END]`;
  if (codePoints(single).length <= boundedMax) return [single];

  const response = codePoints(input.finalResponse);
  const payloadCapacity = boundedMax - codePoints(header).length - 64;
  if (payloadCapacity < 1) throw new Error("TELEGRAM_MESSAGE_HEADER_TOO_LONG");
  const chunks: string[] = [];
  for (let offset = 0; offset < response.length; offset += payloadCapacity) {
    chunks.push(response.slice(offset, offset + payloadCapacity).join(""));
  }
  return chunks.map((chunk, index) => {
    const label = `[part ${index + 1}/${chunks.length}]`;
    const ending = index === chunks.length - 1 ? "\n\n[END]" : "";
    const part = `${header}\n${label}\n\n${chunk}${ending}`;
    if (codePoints(part).length > boundedMax) throw new Error("TELEGRAM_MESSAGE_PART_TOO_LONG");
    return part;
  });
}

export interface TelegramDeliveryLog {
  deliveryId: string;
  status: "DELIVERED" | "RETRY" | "FAILED" | "CANCELLED";
  attempt: number;
  safeErrorCode: string | null;
}

export interface TelegramDeliveryWorkerOptions {
  persistence: TelegramOutboxPersistence;
  secrets: TelegramSecretStore;
  workerId: string;
  clientFactory?: (botToken: string) => Pick<TelegramBotApiClient, "sendMessage">;
  now?: () => Date;
  maxAttempts?: number;
  log?: (record: TelegramDeliveryLog) => void;
  sleep?: (ms: number) => Promise<void>;
}

// Filesystem errors worth retrying; anything else (ENOENT, EACCES, invalid reference) needs the operator.
const TRANSIENT_CREDENTIAL_READ_ERRORS = new Set(["EAGAIN", "EBUSY", "EINTR", "EIO", "EMFILE", "ENFILE", "ETIMEDOUT"]);
const PROGRESS_WRITE_ATTEMPTS = 3;

function isTransientCredentialReadError(error: unknown): boolean {
  return error instanceof Error && TRANSIENT_CREDENTIAL_READ_ERRORS.has((error as NodeJS.ErrnoException).code ?? "");
}

/** A part reached Telegram but its progress could not be stored, so it must not be resent from here. */
class TelegramDeliveryProgressError extends Error {
  constructor(readonly code: "TELEGRAM_DELIVERY_LOCK_LOST" | "TELEGRAM_PROGRESS_UNRECORDED") {
    super(code);
  }
}

export class TelegramDeliveryWorker {
  private readonly clientFactory: (botToken: string) => Pick<TelegramBotApiClient, "sendMessage">;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TelegramDeliveryWorkerOptions) {
    this.clientFactory = options.clientFactory ?? ((botToken) => new TelegramBotApiClient(botToken));
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 5, 10));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private log(delivery: TelegramOutboxRecord, status: TelegramDeliveryLog["status"], safeErrorCode: string | null) {
    this.options.log?.({ deliveryId: delivery.deliveryId, status, attempt: delivery.attemptCount, safeErrorCode });
  }

  private async fail(delivery: TelegramOutboxRecord, safeErrorCode: string): Promise<void> {
    await this.options.persistence.failDelivery({
      deliveryId: delivery.deliveryId,
      workerId: this.options.workerId,
      safeErrorCode,
      now: this.now().toISOString()
    });
    this.log(delivery, "FAILED", safeErrorCode);
  }

  private backoffMs(delivery: TelegramOutboxRecord): number {
    return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, delivery.attemptCount - 1));
  }

  private async recordProgress(input: Parameters<TelegramOutboxPersistence["recordDeliveryProgress"]>[0]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.options.persistence.recordDeliveryProgress(input);
        return;
      } catch (error) {
        if (error instanceof TelegramIntegrationError && error.code === "TELEGRAM_DELIVERY_LOCK_LOST") {
          throw new TelegramDeliveryProgressError("TELEGRAM_DELIVERY_LOCK_LOST");
        }
        if (attempt >= PROGRESS_WRITE_ATTEMPTS) throw new TelegramDeliveryProgressError("TELEGRAM_PROGRESS_UNRECORDED");
        await this.sleep(250 * attempt);
      }
    }
  }

  async runOnce(limit = 10): Promise<{ claimed: number; delivered: number; retried: number; failed: number; cancelled: number }> {
    const now = this.now();
    const deliveries = await this.options.persistence.claimDeliveries({
      workerId: this.options.workerId,
      limit: Math.max(1, Math.min(Math.trunc(limit), 50)),
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - 5 * 60_000).toISOString()
    });
    const summary = { claimed: deliveries.length, delivered: 0, retried: 0, failed: 0, cancelled: 0 };
    let rateLimitedUntil: string | null = null;

    for (const delivery of deliveries) {
      const deliveryNow = this.now();
      if (rateLimitedUntil) {
        // Telegram rate limits the whole chat: hold the rest of the batch without spending attempts.
        await this.options.persistence.retryDelivery({
          deliveryId: delivery.deliveryId,
          workerId: this.options.workerId,
          availableAt: rateLimitedUntil,
          safeErrorCode: "TELEGRAM_RATE_LIMITED",
          now: deliveryNow.toISOString(),
          countAttempt: false
        });
        this.log(delivery, "RETRY", "TELEGRAM_RATE_LIMITED");
        summary.retried += 1;
        continue;
      }
      const integration = await this.options.persistence.getIntegration();
      if (
        !integration.isEnabled ||
        integration.connectionStatus !== "CONNECTED" ||
        !integration.secretVersion ||
        !integration.chatId ||
        integration.generation !== delivery.integrationGeneration
      ) {
        await this.options.persistence.cancelDelivery(delivery.deliveryId, this.options.workerId, deliveryNow.toISOString());
        this.log(delivery, "CANCELLED", null);
        summary.cancelled += 1;
        continue;
      }
      let client: Pick<TelegramBotApiClient, "sendMessage">;
      try {
        const botToken = await this.options.secrets.read(integration.secretVersion);
        client = this.clientFactory(botToken);
      } catch (error) {
        if (isTransientCredentialReadError(error) && delivery.attemptCount < this.maxAttempts) {
          // A flaky read must not disable the integration; retry with the usual backoff.
          const safeErrorCode = "TELEGRAM_CREDENTIAL_READ_FAILED";
          await this.options.persistence.retryDelivery({
            deliveryId: delivery.deliveryId,
            workerId: this.options.workerId,
            availableAt: new Date(this.now().getTime() + this.backoffMs(delivery)).toISOString(),
            safeErrorCode,
            now: this.now().toISOString()
          });
          this.log(delivery, "RETRY", safeErrorCode);
          summary.retried += 1;
          continue;
        }
        const safeErrorCode = "TELEGRAM_CREDENTIAL_UNAVAILABLE";
        await this.fail(delivery, safeErrorCode);
        await this.options.persistence.markError(safeErrorCode, this.now().toISOString());
        summary.failed += 1;
        continue;
      }
      let parts: string[];
      try {
        parts = formatTelegramCompletionParts(delivery);
      } catch {
        // Formatting is deterministic, so retrying cannot help.
        await this.fail(delivery, "TELEGRAM_MESSAGE_UNFORMATTABLE");
        summary.failed += 1;
        continue;
      }
      let sentParts = 0;
      try {
        for (let partIndex = delivery.nextPartIndex; partIndex < parts.length; partIndex += 1) {
          await client.sendMessage(integration.chatId, parts[partIndex]!);
          sentParts += 1;
          const delivered = partIndex === parts.length - 1;
          await this.recordProgress({
            deliveryId: delivery.deliveryId,
            workerId: this.options.workerId,
            nextPartIndex: partIndex + 1,
            delivered,
            now: this.now().toISOString()
          });
        }
        this.log(delivery, "DELIVERED", null);
        summary.delivered += 1;
      } catch (error) {
        if (error instanceof TelegramDeliveryProgressError) {
          // Retrying here would resend a part Telegram already accepted. The row keeps its lock until
          // stale recovery (or the worker that took it over) resumes from the stored progress.
          this.log(delivery, "RETRY", error.code);
          summary.retried += 1;
          continue;
        }
        const telegramError = error instanceof TelegramApiError
          ? error
          : new TelegramApiError("TELEGRAM_NETWORK_ERROR", 502);
        if (telegramError.permanent) {
          await this.fail(delivery, telegramError.code);
          // A rejected message fails only itself; auth and chat errors disable the integration.
          if (telegramError.code !== "TELEGRAM_BAD_REQUEST") {
            await this.options.persistence.markError(telegramError.code, this.now().toISOString());
          }
          summary.failed += 1;
          continue;
        }
        const rateLimited = telegramError.code === "TELEGRAM_RATE_LIMITED" && Boolean(telegramError.retryAfterSeconds);
        // Rate limits and attempts that delivered parts are progress, not failures, so the cap ignores them.
        const countAttempt = !rateLimited && sentParts === 0;
        if (countAttempt && delivery.attemptCount >= this.maxAttempts) {
          await this.fail(delivery, telegramError.code);
          summary.failed += 1;
          continue;
        }
        const delayMs = telegramError.retryAfterSeconds
          ? telegramError.retryAfterSeconds * 1_000
          : this.backoffMs(delivery);
        const availableAt = new Date(this.now().getTime() + delayMs).toISOString();
        if (rateLimited) rateLimitedUntil = availableAt;
        await this.options.persistence.retryDelivery({
          deliveryId: delivery.deliveryId,
          workerId: this.options.workerId,
          availableAt,
          safeErrorCode: telegramError.code,
          now: this.now().toISOString(),
          countAttempt
        });
        this.log(delivery, "RETRY", telegramError.code);
        summary.retried += 1;
      }
    }
    return summary;
  }
}
