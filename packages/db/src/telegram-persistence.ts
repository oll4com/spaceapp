import {
  TelegramIntegrationError,
  type ActivateTelegramPairingInput,
  type StartTelegramPairingInput,
  type TelegramIntegrationRecord,
  type TelegramOutboxPersistence,
  type TelegramOutboxRecord,
  type TelegramPairingRecord,
  type TelegramPersistence
} from "@space/runtime";
import type { PgClientLike, PgPoolLike } from "./space-store.js";

type TelegramIntegrationRow = Omit<TelegramIntegrationRecord, "generation" | "pollingOffset"> & {
  generation: number | string;
  pollingOffset: number | string;
};

type TelegramPairingRow = Omit<TelegramPairingRecord, "pollingOffset"> & {
  pollingOffset: number | string;
};

const integrationSelect = `
  SELECT
    connection_status AS "connectionStatus",
    is_enabled AS "isEnabled",
    bot_user_id AS "botUserId",
    bot_username AS "botUsername",
    chat_id AS "chatId",
    chat_display_name AS "chatDisplayName",
    secret_version AS "secretVersion",
    generation,
    polling_offset AS "pollingOffset",
    legacy_suppression_active AS "legacySuppressionActive",
    paired_at AS "pairedAt",
    enabled_at AS "enabledAt",
    disabled_at AS "disabledAt",
    last_tested_at AS "lastTestedAt",
    last_delivered_at AS "lastDeliveredAt",
    error_code AS "errorCode",
    error_at AS "errorAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM telegram_integrations
  WHERE id = 'global'
`;

const pairingSelect = `
  SELECT
    pairing_id AS "pairingId",
    code_hash AS "codeHash",
    secret_version AS "secretVersion",
    bot_user_id AS "botUserId",
    bot_username AS "botUsername",
    polling_offset AS "pollingOffset",
    status,
    expires_at AS "expiresAt",
    created_by_user_id AS "createdByUserId",
    created_at AS "createdAt",
    confirmed_at AS "confirmedAt",
    cancelled_at AS "cancelledAt"
  FROM telegram_pairing_sessions
`;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function mapIntegration(row: TelegramIntegrationRow | undefined): TelegramIntegrationRecord {
  if (!row) throw new TelegramIntegrationError("TELEGRAM_STATE_MISSING", "Telegram integration state is unavailable.", 500);
  return {
    ...row,
    generation: Number(row.generation),
    pollingOffset: Number(row.pollingOffset),
    pairedAt: iso(row.pairedAt),
    enabledAt: iso(row.enabledAt),
    disabledAt: iso(row.disabledAt),
    lastTestedAt: iso(row.lastTestedAt),
    lastDeliveredAt: iso(row.lastDeliveredAt),
    errorAt: iso(row.errorAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!
  };
}

function mapPairing(row: TelegramPairingRow | undefined): TelegramPairingRecord | null {
  if (!row) return null;
  return {
    ...row,
    pollingOffset: Number(row.pollingOffset),
    expiresAt: iso(row.expiresAt)!,
    createdAt: iso(row.createdAt)!,
    confirmedAt: iso(row.confirmedAt),
    cancelledAt: iso(row.cancelledAt)
  };
}

type TelegramOutboxRow = Omit<TelegramOutboxRecord, "integrationGeneration" | "nextPartIndex" | "attemptCount"> & {
  integrationGeneration: number | string;
  nextPartIndex: number | string;
  attemptCount: number | string;
};

function mapOutbox(row: TelegramOutboxRow): TelegramOutboxRecord {
  return {
    ...row,
    integrationGeneration: Number(row.integrationGeneration),
    nextPartIndex: Number(row.nextPartIndex),
    attemptCount: Number(row.attemptCount),
    completedAt: iso(row.completedAt)!,
    availableAt: iso(row.availableAt)!,
    lockedAt: iso(row.lockedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    deliveredAt: iso(row.deliveredAt)
  };
}

const outboxReturning = `
  o.delivery_id AS "deliveryId",
  o.integration_generation AS "integrationGeneration",
  o.source_key AS "sourceKey",
  o.source_type AS "sourceType",
  o.room_id AS "roomId",
  o.pane_id AS "paneId",
  o.turn_id AS "turnId",
  o.room_name AS "roomName",
  o.pane_title AS "paneTitle",
  o.agent_label AS "agentLabel",
  o.task_title AS "taskTitle",
  o.final_response AS "finalResponse",
  o.completed_at AS "completedAt",
  o.status,
  o.next_part_index AS "nextPartIndex",
  o.attempt_count AS "attemptCount",
  o.available_at AS "availableAt",
  o.locked_at AS "lockedAt",
  o.locked_by AS "lockedBy",
  o.safe_error_code AS "safeErrorCode",
  o.created_at AS "createdAt",
  o.updated_at AS "updatedAt",
  o.delivered_at AS "deliveredAt"
`;

export class PostgresTelegramPersistence implements TelegramPersistence, TelegramOutboxPersistence {
  constructor(private readonly pool: PgPoolLike) {}

  private async withTransaction<T>(callback: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }

  async getIntegration(): Promise<TelegramIntegrationRecord> {
    const result = await this.pool.query<TelegramIntegrationRow>(integrationSelect);
    return mapIntegration(result.rows[0]);
  }

  async getPendingPairing(): Promise<TelegramPairingRecord | null> {
    const result = await this.pool.query<TelegramPairingRow>(
      `${pairingSelect} WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT 1`
    );
    return mapPairing(result.rows[0]);
  }

  async getPairing(pairingId: string): Promise<TelegramPairingRecord | null> {
    const result = await this.pool.query<TelegramPairingRow>(`${pairingSelect} WHERE pairing_id = $1`, [pairingId]);
    return mapPairing(result.rows[0]);
  }

  async startPairing(input: StartTelegramPairingInput): Promise<{
    pairing: TelegramPairingRecord;
    cancelledSecretVersions: string[];
  }> {
    return this.withTransaction(async (client) => {
      const integration = await client.query<TelegramIntegrationRow>(`${integrationSelect} FOR UPDATE`);
      mapIntegration(integration.rows[0]);
      const cancelled = await client.query<{ secretVersion: string }>(
        `
          UPDATE telegram_pairing_sessions
          SET status = 'CANCELLED', cancelled_at = $1
          WHERE status = 'PENDING'
          RETURNING secret_version AS "secretVersion"
        `,
        [input.now]
      );
      const result = await client.query<TelegramPairingRow>(
        `
          INSERT INTO telegram_pairing_sessions (
            pairing_id, code_hash, secret_version, bot_user_id, bot_username,
            polling_offset, status, expires_at, created_by_user_id, created_at
          )
          VALUES ($1, $2, $3, $4, $5, 0, 'PENDING', $6, $7, $8)
          RETURNING
            pairing_id AS "pairingId", code_hash AS "codeHash", secret_version AS "secretVersion",
            bot_user_id AS "botUserId", bot_username AS "botUsername", polling_offset AS "pollingOffset",
            status, expires_at AS "expiresAt", created_by_user_id AS "createdByUserId",
            created_at AS "createdAt", confirmed_at AS "confirmedAt", cancelled_at AS "cancelledAt"
        `,
        [
          input.pairingId,
          input.codeHash,
          input.secretVersion,
          input.botUserId,
          input.botUsername,
          input.expiresAt,
          input.createdByUserId,
          input.now
        ]
      );
      await client.query(
        `
          UPDATE telegram_integrations
          SET
            connection_status = CASE WHEN secret_version IS NULL THEN 'PAIRING' ELSE connection_status END,
            bot_user_id = CASE WHEN secret_version IS NULL THEN $1 ELSE bot_user_id END,
            bot_username = CASE WHEN secret_version IS NULL THEN $2 ELSE bot_username END,
            error_code = NULL,
            error_at = NULL,
            updated_at = $3
          WHERE id = 'global'
        `,
        [input.botUserId, input.botUsername, input.now]
      );
      const pairing = mapPairing(result.rows[0]);
      if (!pairing) throw new TelegramIntegrationError("TELEGRAM_PAIRING_CREATE_FAILED", "Pairing session was not created.", 500);
      return { pairing, cancelledSecretVersions: cancelled.rows.map((row) => row.secretVersion) };
    });
  }

  async updatePairingOffset(pairingId: string, pollingOffset: number, now: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE telegram_pairing_sessions
        SET polling_offset = GREATEST(polling_offset, $2)
        WHERE pairing_id = $1 AND status = 'PENDING'
      `,
      [pairingId, pollingOffset]
    );
    await this.pool.query("UPDATE telegram_integrations SET updated_at = $1 WHERE id = 'global'", [now]);
  }

  async expirePairing(pairingId: string, now: string): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(`${integrationSelect} FOR UPDATE`);
      await client.query(
        `UPDATE telegram_pairing_sessions SET status = 'EXPIRED', cancelled_at = $2 WHERE pairing_id = $1 AND status = 'PENDING'`,
        [pairingId, now]
      );
      await client.query(
        `
          UPDATE telegram_integrations
          SET
            connection_status = CASE WHEN secret_version IS NULL THEN 'DISCONNECTED' ELSE connection_status END,
            bot_user_id = CASE WHEN secret_version IS NULL THEN NULL ELSE bot_user_id END,
            bot_username = CASE WHEN secret_version IS NULL THEN NULL ELSE bot_username END,
            updated_at = $1
          WHERE id = 'global'
        `,
        [now]
      );
    });
  }

  async activatePairing(input: ActivateTelegramPairingInput): Promise<{
    integration: TelegramIntegrationRecord;
    previousSecretVersion: string | null;
  }> {
    return this.withTransaction(async (client) => {
      const integrationResult = await client.query<TelegramIntegrationRow>(`${integrationSelect} FOR UPDATE`);
      const previous = mapIntegration(integrationResult.rows[0]);
      const pairingResult = await client.query<TelegramPairingRow>(`${pairingSelect} WHERE pairing_id = $1 FOR UPDATE`, [input.pairingId]);
      const pairing = mapPairing(pairingResult.rows[0]);
      if (!pairing || pairing.status !== "PENDING") {
        throw new TelegramIntegrationError("TELEGRAM_PAIRING_REPLAYED", "This pairing session is no longer active.");
      }
      await client.query(
        `UPDATE telegram_pairing_sessions SET status = 'CONFIRMED', confirmed_at = $2 WHERE pairing_id = $1`,
        [input.pairingId, input.now]
      );
      await client.query(
        `
          UPDATE telegram_notification_outbox
          SET status = 'CANCELLED', locked_at = NULL, locked_by = NULL, updated_at = $1
          WHERE status IN ('PENDING', 'RETRY', 'SENDING')
        `,
        [input.now]
      );
      const updated = await client.query<TelegramIntegrationRow>(
        `
          UPDATE telegram_integrations
          SET
            connection_status = 'CONNECTED', is_enabled = true,
            bot_user_id = $1, bot_username = $2,
            chat_id = $3, chat_display_name = $4, secret_version = $5,
            generation = generation + 1, polling_offset = $6,
            legacy_suppression_active = true,
            paired_at = $7, enabled_at = $7, disabled_at = NULL,
            last_tested_at = $7, error_code = NULL, error_at = NULL, updated_at = $7
          WHERE id = 'global'
          RETURNING
            connection_status AS "connectionStatus", is_enabled AS "isEnabled",
            bot_user_id AS "botUserId", bot_username AS "botUsername", chat_id AS "chatId",
            chat_display_name AS "chatDisplayName", secret_version AS "secretVersion", generation,
            polling_offset AS "pollingOffset", legacy_suppression_active AS "legacySuppressionActive",
            paired_at AS "pairedAt", enabled_at AS "enabledAt", disabled_at AS "disabledAt",
            last_tested_at AS "lastTestedAt", last_delivered_at AS "lastDeliveredAt",
            error_code AS "errorCode", error_at AS "errorAt", created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [
          pairing.botUserId,
          pairing.botUsername,
          input.chatId,
          input.chatDisplayName,
          pairing.secretVersion,
          input.pollingOffset,
          input.now
        ]
      );
      return { integration: mapIntegration(updated.rows[0]), previousSecretVersion: previous.secretVersion };
    });
  }

  async setEnabled(isEnabled: boolean, now: string): Promise<TelegramIntegrationRecord> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<TelegramIntegrationRow>(`${integrationSelect} FOR UPDATE`);
      const current = mapIntegration(currentResult.rows[0]);
      if (!current.secretVersion || !current.chatId) {
        throw new TelegramIntegrationError("TELEGRAM_NOT_CONNECTED", "Connect a Telegram bot before enabling notifications.");
      }
      await client.query(
        `
          UPDATE telegram_notification_outbox
          SET status = 'CANCELLED', locked_at = NULL, locked_by = NULL, updated_at = $1
          WHERE status IN ('PENDING', 'RETRY', 'SENDING')
        `,
        [now]
      );
      const result = await client.query<TelegramIntegrationRow>(
        `
          UPDATE telegram_integrations
          SET connection_status = $1, is_enabled = $2, generation = generation + 1,
              legacy_suppression_active = $2,
              enabled_at = CASE WHEN $2 THEN $3 ELSE enabled_at END,
              disabled_at = CASE WHEN $2 THEN NULL ELSE $3 END,
              error_code = NULL, error_at = NULL, updated_at = $3
          WHERE id = 'global'
          RETURNING
            connection_status AS "connectionStatus", is_enabled AS "isEnabled",
            bot_user_id AS "botUserId", bot_username AS "botUsername", chat_id AS "chatId",
            chat_display_name AS "chatDisplayName", secret_version AS "secretVersion", generation,
            polling_offset AS "pollingOffset", legacy_suppression_active AS "legacySuppressionActive",
            paired_at AS "pairedAt", enabled_at AS "enabledAt", disabled_at AS "disabledAt",
            last_tested_at AS "lastTestedAt", last_delivered_at AS "lastDeliveredAt",
            error_code AS "errorCode", error_at AS "errorAt", created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [isEnabled ? "CONNECTED" : "DISABLED", isEnabled, now]
      );
      return mapIntegration(result.rows[0]);
    });
  }

  async recordTested(now: string): Promise<TelegramIntegrationRecord> {
    const result = await this.pool.query<TelegramIntegrationRow>(
      `
        UPDATE telegram_integrations SET last_tested_at = $1, updated_at = $1 WHERE id = 'global'
        RETURNING
          connection_status AS "connectionStatus", is_enabled AS "isEnabled",
          bot_user_id AS "botUserId", bot_username AS "botUsername", chat_id AS "chatId",
          chat_display_name AS "chatDisplayName", secret_version AS "secretVersion", generation,
          polling_offset AS "pollingOffset", legacy_suppression_active AS "legacySuppressionActive",
          paired_at AS "pairedAt", enabled_at AS "enabledAt", disabled_at AS "disabledAt",
          last_tested_at AS "lastTestedAt", last_delivered_at AS "lastDeliveredAt",
          error_code AS "errorCode", error_at AS "errorAt", created_at AS "createdAt", updated_at AS "updatedAt"
      `,
      [now]
    );
    return mapIntegration(result.rows[0]);
  }

  async disconnect(now: string): Promise<{ integration: TelegramIntegrationRecord; secretVersions: string[] }> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<TelegramIntegrationRow>(`${integrationSelect} FOR UPDATE`);
      const current = mapIntegration(currentResult.rows[0]);
      const pairingSecrets = await client.query<{ secretVersion: string }>(
        `SELECT secret_version AS "secretVersion" FROM telegram_pairing_sessions`
      );
      await client.query(
        `
          UPDATE telegram_notification_outbox
          SET status = 'CANCELLED', locked_at = NULL, locked_by = NULL, updated_at = $1
          WHERE status IN ('PENDING', 'RETRY', 'SENDING')
        `,
        [now]
      );
      await client.query("DELETE FROM telegram_pairing_sessions");
      const result = await client.query<TelegramIntegrationRow>(
        `
          UPDATE telegram_integrations
          SET connection_status = 'DISCONNECTED', is_enabled = false,
              bot_user_id = NULL, bot_username = NULL, chat_id = NULL, chat_display_name = NULL,
              secret_version = NULL, generation = generation + 1, polling_offset = 0,
              legacy_suppression_active = false,
              paired_at = NULL, enabled_at = NULL, disabled_at = $1,
              last_tested_at = NULL, last_delivered_at = NULL,
              error_code = NULL, error_at = NULL, updated_at = $1
          WHERE id = 'global'
          RETURNING
            connection_status AS "connectionStatus", is_enabled AS "isEnabled",
            bot_user_id AS "botUserId", bot_username AS "botUsername", chat_id AS "chatId",
            chat_display_name AS "chatDisplayName", secret_version AS "secretVersion", generation,
            polling_offset AS "pollingOffset", legacy_suppression_active AS "legacySuppressionActive",
            paired_at AS "pairedAt", enabled_at AS "enabledAt", disabled_at AS "disabledAt",
            last_tested_at AS "lastTestedAt", last_delivered_at AS "lastDeliveredAt",
            error_code AS "errorCode", error_at AS "errorAt", created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [now]
      );
      const versions = new Set(pairingSecrets.rows.map((row) => row.secretVersion));
      if (current.secretVersion) versions.add(current.secretVersion);
      return { integration: mapIntegration(result.rows[0]), secretVersions: [...versions] };
    });
  }

  async markError(code: string, now: string): Promise<TelegramIntegrationRecord> {
    return this.withTransaction(async (client) => {
      await client.query(`${integrationSelect} FOR UPDATE`);
      await client.query(
        `
          UPDATE telegram_notification_outbox
          SET status = 'CANCELLED', locked_at = NULL, locked_by = NULL, updated_at = $1
          WHERE status IN ('PENDING', 'RETRY', 'SENDING')
        `,
        [now]
      );
      const result = await client.query<TelegramIntegrationRow>(
        `
          UPDATE telegram_integrations
          SET connection_status = 'ERROR', is_enabled = false,
              generation = generation + 1, legacy_suppression_active = false,
              error_code = $1, error_at = $2, updated_at = $2
          WHERE id = 'global'
          RETURNING
            connection_status AS "connectionStatus", is_enabled AS "isEnabled",
            bot_user_id AS "botUserId", bot_username AS "botUsername", chat_id AS "chatId",
            chat_display_name AS "chatDisplayName", secret_version AS "secretVersion", generation,
            polling_offset AS "pollingOffset", legacy_suppression_active AS "legacySuppressionActive",
            paired_at AS "pairedAt", enabled_at AS "enabledAt", disabled_at AS "disabledAt",
            last_tested_at AS "lastTestedAt", last_delivered_at AS "lastDeliveredAt",
            error_code AS "errorCode", error_at AS "errorAt", created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [code, now]
      );
      return mapIntegration(result.rows[0]);
    });
  }

  async claimDeliveries(input: {
    workerId: string;
    limit: number;
    now: string;
    staleBefore: string;
  }): Promise<TelegramOutboxRecord[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<TelegramOutboxRow>(
        `
          WITH stale AS (
            UPDATE telegram_notification_outbox
            SET status = 'RETRY', locked_at = NULL, locked_by = NULL,
                available_at = LEAST(available_at, $1), safe_error_code = 'TELEGRAM_STALE_LOCK_RECOVERED', updated_at = $1
            WHERE status = 'SENDING' AND locked_at < $2
            RETURNING delivery_id
          ),
          candidates AS (
            SELECT o.delivery_id
            FROM telegram_notification_outbox o
            JOIN telegram_integrations i ON i.id = 'global'
            WHERE o.status IN ('PENDING', 'RETRY')
              AND o.available_at <= $1
              AND i.connection_status = 'CONNECTED'
              AND i.is_enabled = true
              AND o.integration_generation = i.generation
            ORDER BY o.available_at ASC, o.created_at ASC
            FOR UPDATE OF o SKIP LOCKED
            LIMIT $3
          )
          UPDATE telegram_notification_outbox o
          SET status = 'SENDING', locked_at = $1, locked_by = $4,
              attempt_count = attempt_count + 1, safe_error_code = NULL, updated_at = $1
          FROM candidates
          WHERE o.delivery_id = candidates.delivery_id
          RETURNING ${outboxReturning}
        `,
        [input.now, input.staleBefore, input.limit, input.workerId]
      );
      return result.rows.map(mapOutbox);
    });
  }

  async recordDeliveryProgress(input: {
    deliveryId: string;
    workerId: string;
    nextPartIndex: number;
    delivered: boolean;
    now: string;
  }): Promise<void> {
    await this.withTransaction(async (client) => {
      const result = await client.query(
        `
          UPDATE telegram_notification_outbox
          SET next_part_index = GREATEST(next_part_index, $3),
              status = CASE WHEN $4 THEN 'DELIVERED' ELSE status END,
              delivered_at = CASE WHEN $4 THEN $5 ELSE delivered_at END,
              locked_at = CASE WHEN $4 THEN NULL ELSE locked_at END,
              locked_by = CASE WHEN $4 THEN NULL ELSE locked_by END,
              updated_at = $5
          WHERE delivery_id = $1 AND status = 'SENDING' AND locked_by = $2
          RETURNING integration_generation
        `,
        [input.deliveryId, input.workerId, input.nextPartIndex, input.delivered, input.now]
      );
      if (!result.rowCount) {
        throw new TelegramIntegrationError("TELEGRAM_DELIVERY_LOCK_LOST", "Telegram delivery lock is no longer held.", 409);
      }
      if (input.delivered) {
        await client.query(
          `
            UPDATE telegram_integrations
            SET last_delivered_at = $1, updated_at = $1
            WHERE id = 'global'
              AND generation = (SELECT integration_generation FROM telegram_notification_outbox WHERE delivery_id = $2)
          `,
          [input.now, input.deliveryId]
        );
      }
    });
  }

  async retryDelivery(input: {
    deliveryId: string;
    workerId: string;
    availableAt: string;
    safeErrorCode: string;
    now: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE telegram_notification_outbox
        SET status = 'RETRY', available_at = $3, locked_at = NULL, locked_by = NULL,
            safe_error_code = $4, updated_at = $5
        WHERE delivery_id = $1 AND status = 'SENDING' AND locked_by = $2
      `,
      [input.deliveryId, input.workerId, input.availableAt, input.safeErrorCode, input.now]
    );
  }

  async failDelivery(input: {
    deliveryId: string;
    workerId: string;
    safeErrorCode: string;
    now: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE telegram_notification_outbox
        SET status = 'FAILED', locked_at = NULL, locked_by = NULL, safe_error_code = $3, updated_at = $4
        WHERE delivery_id = $1 AND status = 'SENDING' AND locked_by = $2
      `,
      [input.deliveryId, input.workerId, input.safeErrorCode, input.now]
    );
  }

  async cancelDelivery(deliveryId: string, workerId: string, now: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE telegram_notification_outbox
        SET status = 'CANCELLED', locked_at = NULL, locked_by = NULL, updated_at = $3
        WHERE delivery_id = $1 AND status = 'SENDING' AND locked_by = $2
      `,
      [deliveryId, workerId, now]
    );
  }
}
