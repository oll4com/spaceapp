import { TelegramApiError, TelegramBotApiClient, TelegramSecretStore, type TelegramIntegrationRecord } from "./telegram.js";

export type TelegramOutboxSourceType = "CHAT" | "ROOM_AGENT" | "TERMINAL" | "TEST";
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

export function formatTelegramCompletionParts(
  input: Pick<TelegramOutboxRecord, "agentLabel" | "roomName" | "taskTitle" | "completedAt" | "finalResponse">,
  maxCharacters = 2_500
): string[] {
  const boundedMax = Math.max(500, Math.min(Math.trunc(maxCharacters), 2_500));
  const header = [
    "Space — Task completed",
    `Agent: ${input.agentLabel}`,
    `Room: ${input.roomName}`,
    `Task: ${input.taskTitle}`,
    `Completed: ${input.completedAt}`
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
}

export class TelegramDeliveryWorker {
  private readonly clientFactory: (botToken: string) => Pick<TelegramBotApiClient, "sendMessage">;
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  constructor(private readonly options: TelegramDeliveryWorkerOptions) {
    this.clientFactory = options.clientFactory ?? ((botToken) => new TelegramBotApiClient(botToken));
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 5, 10));
  }

  private log(delivery: TelegramOutboxRecord, status: TelegramDeliveryLog["status"], safeErrorCode: string | null) {
    this.options.log?.({ deliveryId: delivery.deliveryId, status, attempt: delivery.attemptCount, safeErrorCode });
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

    for (const delivery of deliveries) {
      const deliveryNow = this.now();
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
      } catch {
        const safeErrorCode = "TELEGRAM_CREDENTIAL_UNAVAILABLE";
        await this.options.persistence.failDelivery({
          deliveryId: delivery.deliveryId,
          workerId: this.options.workerId,
          safeErrorCode,
          now: this.now().toISOString()
        });
        await this.options.persistence.markError(safeErrorCode, this.now().toISOString());
        this.log(delivery, "FAILED", safeErrorCode);
        summary.failed += 1;
        continue;
      }
      try {
        const parts = formatTelegramCompletionParts(delivery);
        for (let partIndex = delivery.nextPartIndex; partIndex < parts.length; partIndex += 1) {
          await client.sendMessage(integration.chatId, parts[partIndex]!);
          const delivered = partIndex === parts.length - 1;
          await this.options.persistence.recordDeliveryProgress({
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
        const telegramError = error instanceof TelegramApiError
          ? error
          : new TelegramApiError("TELEGRAM_NETWORK_ERROR", 502);
        if (telegramError.permanent) {
          await this.options.persistence.failDelivery({
            deliveryId: delivery.deliveryId,
            workerId: this.options.workerId,
            safeErrorCode: telegramError.code,
            now: this.now().toISOString()
          });
          await this.options.persistence.markError(telegramError.code, this.now().toISOString());
          this.log(delivery, "FAILED", telegramError.code);
          summary.failed += 1;
          continue;
        }
        if (delivery.attemptCount >= this.maxAttempts) {
          await this.options.persistence.failDelivery({
            deliveryId: delivery.deliveryId,
            workerId: this.options.workerId,
            safeErrorCode: telegramError.code,
            now: this.now().toISOString()
          });
          this.log(delivery, "FAILED", telegramError.code);
          summary.failed += 1;
          continue;
        }
        const delayMs = telegramError.retryAfterSeconds
          ? telegramError.retryAfterSeconds * 1_000
          : Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, delivery.attemptCount - 1));
        await this.options.persistence.retryDelivery({
          deliveryId: delivery.deliveryId,
          workerId: this.options.workerId,
          availableAt: new Date(this.now().getTime() + delayMs).toISOString(),
          safeErrorCode: telegramError.code,
          now: this.now().toISOString()
        });
        this.log(delivery, "RETRY", telegramError.code);
        summary.retried += 1;
      }
    }
    return summary;
  }
}
