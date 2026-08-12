import {
  defaultStreamingOverlayTiles,
  streamingOverlaySettingsSchema,
  streamingOverlayTileSchema,
  type StreamingAccountStatus,
  type StreamingAnalyticsPeriod,
  type StreamingAuthorizationStatus,
  type StreamingOAuthProvider,
  type StreamingOverlaySettings,
  type StreamingOverlayTile
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface StreamingAuthorizationRecord {
  id: string;
  provider: StreamingOAuthProvider;
  externalGrantId: string;
  credentialRef: string;
  status: StreamingAuthorizationStatus;
  scopes: string[];
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  lastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertStreamingAuthorizationInput {
  id: string;
  provider: StreamingOAuthProvider;
  externalGrantId: string;
  credentialRef: string;
  status: StreamingAuthorizationStatus;
  scopes: string[];
  safeErrorCode?: string | null;
  safeErrorMessage?: string | null;
  lastRefreshedAt?: string | null;
}

export interface StreamingPlatformAccountRecord {
  id: string;
  authorizationId: string;
  provider: StreamingOAuthProvider;
  externalAccountId: string;
  displayName: string;
  badge: string;
  status: StreamingAccountStatus;
  analyticsPeriod: StreamingAnalyticsPeriod;
  verifiedAt: string | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertStreamingPlatformAccountInput {
  id: string;
  authorizationId: string;
  provider: StreamingOAuthProvider;
  externalAccountId: string;
  displayName: string;
  badge: string;
  status?: StreamingAccountStatus;
  analyticsPeriod?: StreamingAnalyticsPeriod;
  verifiedAt?: string | null;
  safeErrorCode?: string | null;
  safeErrorMessage?: string | null;
}

export interface StreamingOAuthAttemptRecord {
  id: string;
  provider: StreamingOAuthProvider;
  stateHash: string;
  sessionHash: string;
  verifierCredentialRef: string;
  redirectUri: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface CreateStreamingOAuthAttemptInput {
  id: string;
  provider: StreamingOAuthProvider;
  stateHash: string;
  sessionHash: string;
  verifierCredentialRef: string;
  redirectUri: string;
  expiresAt: string;
}

export interface StreamingRepository {
  listAuthorizations(): Promise<StreamingAuthorizationRecord[]>;
  getAuthorization(id: string): Promise<StreamingAuthorizationRecord | null>;
  upsertAuthorization(input: UpsertStreamingAuthorizationInput): Promise<StreamingAuthorizationRecord>;
  setAuthorizationStatus(input: {
    id: string;
    status: StreamingAuthorizationStatus;
    safeErrorCode?: string | null;
    safeErrorMessage?: string | null;
    lastRefreshedAt?: string | null;
  }): Promise<StreamingAuthorizationRecord>;
  deleteAuthorization(id: string): Promise<StreamingAuthorizationRecord | null>;
  listAccounts(): Promise<StreamingPlatformAccountRecord[]>;
  getAccount(id: string): Promise<StreamingPlatformAccountRecord | null>;
  upsertAccount(input: UpsertStreamingPlatformAccountInput): Promise<StreamingPlatformAccountRecord>;
  updateAccount(input: {
    id: string;
    status?: StreamingAccountStatus;
    analyticsPeriod?: StreamingAnalyticsPeriod;
    verifiedAt?: string | null;
    safeErrorCode?: string | null;
    safeErrorMessage?: string | null;
  }): Promise<StreamingPlatformAccountRecord>;
  deleteAccount(id: string): Promise<StreamingPlatformAccountRecord | null>;
  createOAuthAttempt(input: CreateStreamingOAuthAttemptInput): Promise<StreamingOAuthAttemptRecord>;
  consumeOAuthAttempt(input: { stateHash: string; sessionHash: string; consumedAt: string }): Promise<StreamingOAuthAttemptRecord | null>;
  deleteExpiredOAuthAttempts(now: string): Promise<StreamingOAuthAttemptRecord[]>;
  getOverlaySettings(): Promise<StreamingOverlaySettings>;
  updateOverlaySettings(input: {
    expectedVersion: number;
    tiles: StreamingOverlayTile[];
    customTextEnabled: boolean;
    customText: string;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StreamingOverlaySettings>;
  dispose(): Promise<void>;
}

export class StreamingSettingsVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`Streaming overlay settings changed at version ${currentVersion}.`);
    this.name = "StreamingSettingsVersionConflictError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSettings(): StreamingOverlaySettings {
  return streamingOverlaySettingsSchema.parse({
    version: 1,
    tiles: defaultStreamingOverlayTiles,
    customTextEnabled: false,
    customText: "",
    updatedAt: nowIso(),
    updatedBy: null
  });
}

export class InMemoryStreamingRepository implements StreamingRepository {
  private readonly authorizations = new Map<string, StreamingAuthorizationRecord>();
  private readonly accounts = new Map<string, StreamingPlatformAccountRecord>();
  private readonly attempts = new Map<string, StreamingOAuthAttemptRecord>();
  private settings = defaultSettings();

  async listAuthorizations(): Promise<StreamingAuthorizationRecord[]> {
    return [...this.authorizations.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
  }

  async getAuthorization(id: string): Promise<StreamingAuthorizationRecord | null> {
    return this.authorizations.has(id) ? clone(this.authorizations.get(id)!) : null;
  }

  async upsertAuthorization(input: UpsertStreamingAuthorizationInput): Promise<StreamingAuthorizationRecord> {
    const duplicate = [...this.authorizations.values()].find(
      (record) => record.provider === input.provider && record.externalGrantId === input.externalGrantId
    );
    const existing = duplicate ?? this.authorizations.get(input.id);
    const at = nowIso();
    const record: StreamingAuthorizationRecord = {
      id: existing?.id ?? input.id,
      provider: input.provider,
      externalGrantId: input.externalGrantId,
      credentialRef: input.credentialRef,
      status: input.status,
      scopes: [...input.scopes],
      safeErrorCode: input.safeErrorCode ?? null,
      safeErrorMessage: input.safeErrorMessage ?? null,
      lastRefreshedAt: input.lastRefreshedAt ?? null,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    };
    this.authorizations.set(record.id, record);
    return clone(record);
  }

  async setAuthorizationStatus(input: {
    id: string;
    status: StreamingAuthorizationStatus;
    safeErrorCode?: string | null;
    safeErrorMessage?: string | null;
    lastRefreshedAt?: string | null;
  }): Promise<StreamingAuthorizationRecord> {
    const current = this.authorizations.get(input.id);
    if (!current) throw new Error(`Streaming authorization ${input.id} was not found.`);
    const record = {
      ...current,
      status: input.status,
      safeErrorCode: input.safeErrorCode === undefined ? current.safeErrorCode : input.safeErrorCode,
      safeErrorMessage: input.safeErrorMessage === undefined ? current.safeErrorMessage : input.safeErrorMessage,
      lastRefreshedAt: input.lastRefreshedAt === undefined ? current.lastRefreshedAt : input.lastRefreshedAt,
      updatedAt: nowIso()
    };
    this.authorizations.set(record.id, record);
    return clone(record);
  }

  async deleteAuthorization(id: string): Promise<StreamingAuthorizationRecord | null> {
    const current = this.authorizations.get(id);
    if (!current) return null;
    this.authorizations.delete(id);
    for (const [accountId, account] of this.accounts) {
      if (account.authorizationId === id) this.accounts.delete(accountId);
    }
    return clone(current);
  }

  async listAccounts(): Promise<StreamingPlatformAccountRecord[]> {
    return [...this.accounts.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(clone);
  }

  async getAccount(id: string): Promise<StreamingPlatformAccountRecord | null> {
    return this.accounts.has(id) ? clone(this.accounts.get(id)!) : null;
  }

  async upsertAccount(input: UpsertStreamingPlatformAccountInput): Promise<StreamingPlatformAccountRecord> {
    const duplicate = [...this.accounts.values()].find(
      (record) => record.provider === input.provider && record.externalAccountId === input.externalAccountId
    );
    const existing = duplicate ?? this.accounts.get(input.id);
    const at = nowIso();
    const record: StreamingPlatformAccountRecord = {
      id: existing?.id ?? input.id,
      authorizationId: input.authorizationId,
      provider: input.provider,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
      badge: input.badge,
      status: input.status ?? "ACTIVE",
      analyticsPeriod: input.analyticsPeriod ?? existing?.analyticsPeriod ?? 28,
      verifiedAt: input.verifiedAt ?? existing?.verifiedAt ?? null,
      safeErrorCode: input.safeErrorCode ?? null,
      safeErrorMessage: input.safeErrorMessage ?? null,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    };
    this.accounts.set(record.id, record);
    return clone(record);
  }

  async updateAccount(input: {
    id: string;
    status?: StreamingAccountStatus;
    analyticsPeriod?: StreamingAnalyticsPeriod;
    verifiedAt?: string | null;
    safeErrorCode?: string | null;
    safeErrorMessage?: string | null;
  }): Promise<StreamingPlatformAccountRecord> {
    const current = this.accounts.get(input.id);
    if (!current) throw new Error(`Streaming account ${input.id} was not found.`);
    const record: StreamingPlatformAccountRecord = {
      ...current,
      status: input.status ?? current.status,
      analyticsPeriod: input.analyticsPeriod ?? current.analyticsPeriod,
      verifiedAt: input.verifiedAt === undefined ? current.verifiedAt : input.verifiedAt,
      safeErrorCode: input.safeErrorCode === undefined ? current.safeErrorCode : input.safeErrorCode,
      safeErrorMessage: input.safeErrorMessage === undefined ? current.safeErrorMessage : input.safeErrorMessage,
      updatedAt: nowIso()
    };
    this.accounts.set(record.id, record);
    return clone(record);
  }

  async deleteAccount(id: string): Promise<StreamingPlatformAccountRecord | null> {
    const current = this.accounts.get(id);
    if (!current) return null;
    this.accounts.delete(id);
    return clone(current);
  }

  async createOAuthAttempt(input: CreateStreamingOAuthAttemptInput): Promise<StreamingOAuthAttemptRecord> {
    const record: StreamingOAuthAttemptRecord = { ...input, consumedAt: null, createdAt: nowIso() };
    this.attempts.set(record.id, record);
    return clone(record);
  }

  async consumeOAuthAttempt(input: { stateHash: string; sessionHash: string; consumedAt: string }): Promise<StreamingOAuthAttemptRecord | null> {
    const record = [...this.attempts.values()].find(
      (attempt) => attempt.stateHash === input.stateHash
        && attempt.sessionHash === input.sessionHash
        && attempt.consumedAt === null
        && Date.parse(attempt.expiresAt) > Date.parse(input.consumedAt)
    );
    if (!record) return null;
    record.consumedAt = input.consumedAt;
    return clone(record);
  }

  async deleteExpiredOAuthAttempts(now: string): Promise<StreamingOAuthAttemptRecord[]> {
    const expired: StreamingOAuthAttemptRecord[] = [];
    for (const [id, attempt] of this.attempts) {
      if (Date.parse(attempt.expiresAt) <= Date.parse(now) || attempt.consumedAt !== null) {
        expired.push(clone(attempt));
        this.attempts.delete(id);
      }
    }
    return expired;
  }

  async getOverlaySettings(): Promise<StreamingOverlaySettings> {
    return clone(this.settings);
  }

  async updateOverlaySettings(input: {
    expectedVersion: number;
    tiles: StreamingOverlayTile[];
    customTextEnabled: boolean;
    customText: string;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StreamingOverlaySettings> {
    if (input.expectedVersion !== this.settings.version) {
      throw new StreamingSettingsVersionConflictError(this.settings.version);
    }
    this.settings = streamingOverlaySettingsSchema.parse({
      version: this.settings.version + 1,
      tiles: input.tiles,
      customTextEnabled: input.customTextEnabled,
      customText: input.customText,
      updatedAt: input.updatedAt,
      updatedBy: input.updatedBy
    });
    return clone(this.settings);
  }

  async dispose(): Promise<void> {}
}

type AuthorizationRow = Omit<StreamingAuthorizationRecord, "scopes" | "createdAt" | "updatedAt" | "lastRefreshedAt"> & {
  scopes: string[];
  createdAt: Date | string;
  updatedAt: Date | string;
  lastRefreshedAt: Date | string | null;
};

type AccountRow = Omit<StreamingPlatformAccountRecord, "analyticsPeriod" | "createdAt" | "updatedAt" | "verifiedAt"> & {
  analyticsPeriod: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  verifiedAt: Date | string | null;
};

type AttemptRow = Omit<StreamingOAuthAttemptRecord, "expiresAt" | "consumedAt" | "createdAt"> & {
  expiresAt: Date | string;
  consumedAt: Date | string | null;
  createdAt: Date | string;
};

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function mapAuthorization(row: AuthorizationRow): StreamingAuthorizationRecord {
  return {
    ...row,
    scopes: [...row.scopes],
    lastRefreshedAt: row.lastRefreshedAt === null ? null : iso(row.lastRefreshedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapAccount(row: AccountRow): StreamingPlatformAccountRecord {
  return {
    ...row,
    analyticsPeriod: row.analyticsPeriod as StreamingAnalyticsPeriod,
    verifiedAt: row.verifiedAt === null ? null : iso(row.verifiedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapAttempt(row: AttemptRow): StreamingOAuthAttemptRecord {
  return {
    ...row,
    expiresAt: iso(row.expiresAt),
    consumedAt: row.consumedAt === null ? null : iso(row.consumedAt),
    createdAt: iso(row.createdAt)
  };
}

const authorizationSelect = `
  id, provider, external_grant_id AS "externalGrantId", credential_ref AS "credentialRef",
  status, scopes, safe_error_code AS "safeErrorCode", safe_error_message AS "safeErrorMessage",
  last_refreshed_at AS "lastRefreshedAt", created_at AS "createdAt", updated_at AS "updatedAt"
`;

const accountSelect = `
  id, authorization_id AS "authorizationId", provider, external_account_id AS "externalAccountId",
  display_name AS "displayName", badge, status, analytics_period AS "analyticsPeriod",
  verified_at AS "verifiedAt", safe_error_code AS "safeErrorCode", safe_error_message AS "safeErrorMessage",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const attemptSelect = `
  id, provider, state_hash AS "stateHash", session_hash AS "sessionHash",
  verifier_credential_ref AS "verifierCredentialRef", redirect_uri AS "redirectUri",
  expires_at AS "expiresAt", consumed_at AS "consumedAt", created_at AS "createdAt"
`;

export class PostgresStreamingRepository implements StreamingRepository {
  constructor(private readonly pool: PgPoolLike, private readonly ownsPool = false) {}

  static fromConnectionString(
    connectionString: string,
    poolOptions: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number } = {}
  ): PostgresStreamingRepository {
    return new PostgresStreamingRepository(createSpacePgPool(connectionString, poolOptions, 2), true);
  }

  async listAuthorizations(): Promise<StreamingAuthorizationRecord[]> {
    const result = await this.pool.query<AuthorizationRow>(
      `SELECT ${authorizationSelect} FROM streaming_oauth_authorizations ORDER BY created_at ASC, id ASC`
    );
    return result.rows.map(mapAuthorization);
  }

  async getAuthorization(id: string): Promise<StreamingAuthorizationRecord | null> {
    const result = await this.pool.query<AuthorizationRow>(
      `SELECT ${authorizationSelect} FROM streaming_oauth_authorizations WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapAuthorization(result.rows[0]) : null;
  }

  async upsertAuthorization(input: UpsertStreamingAuthorizationInput): Promise<StreamingAuthorizationRecord> {
    const result = await this.pool.query<AuthorizationRow>(
      `
        INSERT INTO streaming_oauth_authorizations (
          id, provider, external_grant_id, credential_ref, status, scopes,
          safe_error_code, safe_error_message, last_refreshed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (provider, external_grant_id) DO UPDATE SET
          credential_ref = EXCLUDED.credential_ref,
          status = EXCLUDED.status,
          scopes = EXCLUDED.scopes,
          safe_error_code = EXCLUDED.safe_error_code,
          safe_error_message = EXCLUDED.safe_error_message,
          last_refreshed_at = EXCLUDED.last_refreshed_at,
          updated_at = now()
        RETURNING ${authorizationSelect}
      `,
      [
        input.id, input.provider, input.externalGrantId, input.credentialRef, input.status, input.scopes,
        input.safeErrorCode ?? null, input.safeErrorMessage ?? null, input.lastRefreshedAt ?? null
      ]
    );
    return mapAuthorization(result.rows[0]!);
  }

  async setAuthorizationStatus(input: {
    id: string;
    status: StreamingAuthorizationStatus;
    safeErrorCode?: string | null;
    safeErrorMessage?: string | null;
    lastRefreshedAt?: string | null;
  }): Promise<StreamingAuthorizationRecord> {
    const result = await this.pool.query<AuthorizationRow>(
      `
        UPDATE streaming_oauth_authorizations SET
          status = $2,
          safe_error_code = CASE WHEN $3::boolean THEN $4 ELSE safe_error_code END,
          safe_error_message = CASE WHEN $5::boolean THEN $6 ELSE safe_error_message END,
          last_refreshed_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE last_refreshed_at END,
          updated_at = now()
        WHERE id = $1
        RETURNING ${authorizationSelect}
      `,
      [
        input.id, input.status,
        input.safeErrorCode !== undefined, input.safeErrorCode ?? null,
        input.safeErrorMessage !== undefined, input.safeErrorMessage ?? null,
        input.lastRefreshedAt !== undefined, input.lastRefreshedAt ?? null
      ]
    );
    if (!result.rows[0]) throw new Error(`Streaming authorization ${input.id} was not found.`);
    return mapAuthorization(result.rows[0]);
  }

  async deleteAuthorization(id: string): Promise<StreamingAuthorizationRecord | null> {
    const result = await this.pool.query<AuthorizationRow>(
      `DELETE FROM streaming_oauth_authorizations WHERE id = $1 RETURNING ${authorizationSelect}`,
      [id]
    );
    return result.rows[0] ? mapAuthorization(result.rows[0]) : null;
  }

  async listAccounts(): Promise<StreamingPlatformAccountRecord[]> {
    const result = await this.pool.query<AccountRow>(
      `SELECT ${accountSelect} FROM streaming_platform_accounts ORDER BY created_at ASC, id ASC`
    );
    return result.rows.map(mapAccount);
  }

  async getAccount(id: string): Promise<StreamingPlatformAccountRecord | null> {
    const result = await this.pool.query<AccountRow>(
      `SELECT ${accountSelect} FROM streaming_platform_accounts WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async upsertAccount(input: UpsertStreamingPlatformAccountInput): Promise<StreamingPlatformAccountRecord> {
    const result = await this.pool.query<AccountRow>(
      `
        INSERT INTO streaming_platform_accounts (
          id, authorization_id, provider, external_account_id, display_name, badge, status,
          analytics_period, verified_at, safe_error_code, safe_error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (provider, external_account_id) DO UPDATE SET
          authorization_id = EXCLUDED.authorization_id,
          display_name = EXCLUDED.display_name,
          badge = EXCLUDED.badge,
          status = EXCLUDED.status,
          verified_at = EXCLUDED.verified_at,
          safe_error_code = EXCLUDED.safe_error_code,
          safe_error_message = EXCLUDED.safe_error_message,
          updated_at = now()
        RETURNING ${accountSelect}
      `,
      [
        input.id, input.authorizationId, input.provider, input.externalAccountId, input.displayName, input.badge,
        input.status ?? "ACTIVE", input.analyticsPeriod ?? 28, input.verifiedAt ?? null,
        input.safeErrorCode ?? null, input.safeErrorMessage ?? null
      ]
    );
    return mapAccount(result.rows[0]!);
  }

  async updateAccount(input: {
    id: string;
    status?: StreamingAccountStatus;
    analyticsPeriod?: StreamingAnalyticsPeriod;
    verifiedAt?: string | null;
    safeErrorCode?: string | null;
    safeErrorMessage?: string | null;
  }): Promise<StreamingPlatformAccountRecord> {
    const result = await this.pool.query<AccountRow>(
      `
        UPDATE streaming_platform_accounts SET
          status = COALESCE($2, status),
          analytics_period = COALESCE($3, analytics_period),
          verified_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE verified_at END,
          safe_error_code = CASE WHEN $6::boolean THEN $7 ELSE safe_error_code END,
          safe_error_message = CASE WHEN $8::boolean THEN $9 ELSE safe_error_message END,
          updated_at = now()
        WHERE id = $1
        RETURNING ${accountSelect}
      `,
      [
        input.id, input.status ?? null, input.analyticsPeriod ?? null,
        input.verifiedAt !== undefined, input.verifiedAt ?? null,
        input.safeErrorCode !== undefined, input.safeErrorCode ?? null,
        input.safeErrorMessage !== undefined, input.safeErrorMessage ?? null
      ]
    );
    if (!result.rows[0]) throw new Error(`Streaming account ${input.id} was not found.`);
    return mapAccount(result.rows[0]);
  }

  async deleteAccount(id: string): Promise<StreamingPlatformAccountRecord | null> {
    const result = await this.pool.query<AccountRow>(
      `DELETE FROM streaming_platform_accounts WHERE id = $1 RETURNING ${accountSelect}`,
      [id]
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async createOAuthAttempt(input: CreateStreamingOAuthAttemptInput): Promise<StreamingOAuthAttemptRecord> {
    const result = await this.pool.query<AttemptRow>(
      `
        INSERT INTO streaming_oauth_attempts (
          id, provider, state_hash, session_hash, verifier_credential_ref, redirect_uri, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING ${attemptSelect}
      `,
      [input.id, input.provider, input.stateHash, input.sessionHash, input.verifierCredentialRef, input.redirectUri, input.expiresAt]
    );
    return mapAttempt(result.rows[0]!);
  }

  async consumeOAuthAttempt(input: { stateHash: string; sessionHash: string; consumedAt: string }): Promise<StreamingOAuthAttemptRecord | null> {
    const result = await this.pool.query<AttemptRow>(
      `
        UPDATE streaming_oauth_attempts SET consumed_at = $3
        WHERE state_hash = $1 AND session_hash = $2 AND consumed_at IS NULL AND expires_at > $3
        RETURNING ${attemptSelect}
      `,
      [input.stateHash, input.sessionHash, input.consumedAt]
    );
    return result.rows[0] ? mapAttempt(result.rows[0]) : null;
  }

  async deleteExpiredOAuthAttempts(now: string): Promise<StreamingOAuthAttemptRecord[]> {
    const result = await this.pool.query<AttemptRow>(
      `DELETE FROM streaming_oauth_attempts WHERE expires_at <= $1 OR consumed_at IS NOT NULL RETURNING ${attemptSelect}`,
      [now]
    );
    return result.rows.map(mapAttempt);
  }

  async getOverlaySettings(): Promise<StreamingOverlaySettings> {
    const result = await this.pool.query<{
      version: number;
      tiles: unknown;
      customTextEnabled: boolean;
      customText: string;
      updatedBy: string | null;
      updatedAt: Date | string;
    }>(`
      SELECT version, tiles, custom_text_enabled AS "customTextEnabled", custom_text AS "customText",
             updated_by AS "updatedBy", updated_at AS "updatedAt"
      FROM streaming_overlay_settings WHERE singleton = true
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Streaming overlay settings are missing.");
    return streamingOverlaySettingsSchema.parse({ ...row, tiles: zodTiles(row.tiles), updatedAt: iso(row.updatedAt) });
  }

  async updateOverlaySettings(input: {
    expectedVersion: number;
    tiles: StreamingOverlayTile[];
    customTextEnabled: boolean;
    customText: string;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StreamingOverlaySettings> {
    const result = await this.pool.query<{
      version: number;
      tiles: unknown;
      customTextEnabled: boolean;
      customText: string;
      updatedBy: string | null;
      updatedAt: Date | string;
    }>(`
      UPDATE streaming_overlay_settings SET
        version = version + 1,
        tiles = $2::jsonb,
        custom_text_enabled = $3,
        custom_text = $4,
        updated_by = $5,
        updated_at = $6
      WHERE singleton = true AND version = $1
      RETURNING version, tiles, custom_text_enabled AS "customTextEnabled", custom_text AS "customText",
                updated_by AS "updatedBy", updated_at AS "updatedAt"
    `, [input.expectedVersion, JSON.stringify(input.tiles), input.customTextEnabled, input.customText, input.updatedBy, input.updatedAt]);
    const row = result.rows[0];
    if (!row) {
      const current = await this.getOverlaySettings();
      throw new StreamingSettingsVersionConflictError(current.version);
    }
    return streamingOverlaySettingsSchema.parse({ ...row, tiles: zodTiles(row.tiles), updatedAt: iso(row.updatedAt) });
  }

  async dispose(): Promise<void> {
    if (!this.ownsPool) return;
    const maybeEnd = (this.pool as PgPoolLike & { end?: () => Promise<void> }).end;
    if (maybeEnd) await maybeEnd.call(this.pool);
  }
}

function zodTiles(value: unknown): StreamingOverlayTile[] {
  return streamingOverlayTileSchema.array().max(12).parse(value);
}
