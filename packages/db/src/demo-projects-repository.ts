import type {
  DemoConnectionProvider,
  DemoConnectionStatus,
  DemoOperationStatus,
  DemoRunMode,
  DemoRunStatus,
  DemoSyncStepKey,
  DemoSyncStepStatus
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/**
 * Persistence for Demo Projects. Runs keep their workspace/log paths, operations
 * keep the external ids they already produced, so a restart never duplicates a
 * Salesforce record or a Google Sheets row.
 */
export interface DemoPreferenceRecord {
  ownerUserId: string;
  projectId: string;
  variantId: string;
  mode: DemoRunMode;
  updatedAt: string;
}

export interface DemoRunHealth {
  ok: boolean;
  checkedAt: string;
  latencyMs: number | null;
  detail: string | null;
}

export interface DemoRunRecord {
  id: string;
  ownerUserId: string;
  projectId: string;
  variantId: string;
  mode: DemoRunMode;
  status: DemoRunStatus;
  port: number | null;
  pid: number | null;
  previewToken: string;
  runTokenHash: string;
  workspacePath: string;
  dataPath: string;
  logPath: string;
  health: DemoRunHealth | null;
  lastError: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoConnectionRecord {
  id: string;
  ownerUserId: string;
  provider: DemoConnectionProvider;
  status: DemoConnectionStatus;
  label: string;
  detail: string | null;
  clientId: string | null;
  loginUrl: string | null;
  scopes: string[];
  credentialRef: string | null;
  connectedAt: string | null;
  lastRefreshedAt: string | null;
  lastCheckedAt: string | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoOAuthAttemptRecord {
  id: string;
  ownerUserId: string;
  provider: DemoConnectionProvider;
  stateHash: string;
  sessionHash: string;
  verifierRef: string;
  redirectUri: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface DemoSheetsTargetRecord {
  ownerUserId: string;
  spreadsheetId: string;
  spreadsheetUrl: string | null;
  title: string | null;
  tab: string;
  headerPresent: boolean;
  verifiedAt: string | null;
  updatedAt: string;
}

export interface DemoOperationStepRecord {
  key: DemoSyncStepKey;
  status: DemoSyncStepStatus;
  attempts: number;
  externalId: string | null;
  message: string | null;
  updatedAt: string;
}

export interface DemoOperationRecord {
  id: string;
  ownerUserId: string;
  operationKey: string;
  projectId: string;
  variantId: string;
  mode: DemoRunMode;
  status: DemoOperationStatus;
  accountName: string;
  contactLastName: string;
  firstName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  salesforceAccountId: string | null;
  salesforceContactId: string | null;
  salesforceInstanceUrl: string | null;
  sheetsRow: number | null;
  sheetsVerifiedAt: string | null;
  steps: DemoOperationStepRecord[];
  attempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoTestRunStepRecord {
  key: string;
  label: string;
  status: "PASSED" | "FAILED" | "SKIPPED";
  detail: string;
  durationMs: number;
}

export interface DemoTestRunRecord {
  id: string;
  ownerUserId: string;
  projectId: string;
  variantId: string;
  mode: DemoRunMode;
  status: "PASSED" | "FAILED";
  steps: DemoTestRunStepRecord[];
  startedAt: string;
  finishedAt: string;
  createdAt: string;
}

export interface DemoProjectsRepository {
  getPreference(ownerUserId: string, projectId: string): Promise<DemoPreferenceRecord | null>;
  getLatestPreference(ownerUserId: string): Promise<DemoPreferenceRecord | null>;
  upsertPreference(input: Omit<DemoPreferenceRecord, "updatedAt">): Promise<DemoPreferenceRecord>;

  getRun(id: string): Promise<DemoRunRecord | null>;
  listRuns(ownerUserId: string, limit: number): Promise<DemoRunRecord[]>;
  findActiveRun(ownerUserId: string, projectId: string, variantId: string): Promise<DemoRunRecord | null>;
  listActiveRuns(): Promise<DemoRunRecord[]>;
  upsertRun(input: Omit<DemoRunRecord, "createdAt" | "updatedAt">): Promise<DemoRunRecord>;

  listConnections(ownerUserId: string): Promise<DemoConnectionRecord[]>;
  getConnection(ownerUserId: string, provider: DemoConnectionProvider): Promise<DemoConnectionRecord | null>;
  upsertConnection(input: Omit<DemoConnectionRecord, "createdAt" | "updatedAt">): Promise<DemoConnectionRecord>;
  deleteConnection(ownerUserId: string, provider: DemoConnectionProvider): Promise<void>;

  createOAuthAttempt(input: Omit<DemoOAuthAttemptRecord, "consumedAt" | "createdAt">): Promise<DemoOAuthAttemptRecord>;
  consumeOAuthAttempt(input: { stateHash: string; sessionHash: string; consumedAt: string }): Promise<DemoOAuthAttemptRecord | null>;
  deleteExpiredOAuthAttempts(now: string): Promise<DemoOAuthAttemptRecord[]>;

  getSheetsTarget(ownerUserId: string): Promise<DemoSheetsTargetRecord | null>;
  upsertSheetsTarget(input: Omit<DemoSheetsTargetRecord, "updatedAt">): Promise<DemoSheetsTargetRecord>;

  getOperation(id: string): Promise<DemoOperationRecord | null>;
  listOperations(ownerUserId: string, input: { projectId?: string; limit: number }): Promise<DemoOperationRecord[]>;
  findOperationByKey(ownerUserId: string, projectId: string, operationKey: string): Promise<DemoOperationRecord | null>;
  upsertOperation(input: Omit<DemoOperationRecord, "createdAt" | "updatedAt">): Promise<DemoOperationRecord>;
  claimDueOperations(now: string, limit: number): Promise<DemoOperationRecord[]>;

  createTestRun(input: Omit<DemoTestRunRecord, "createdAt">): Promise<DemoTestRunRecord>;
  listTestRuns(ownerUserId: string, projectId: string, limit: number): Promise<DemoTestRunRecord[]>;

  dispose(): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

export class InMemoryDemoProjectsRepository implements DemoProjectsRepository {
  private readonly preferences = new Map<string, DemoPreferenceRecord>();
  private readonly runs = new Map<string, DemoRunRecord>();
  private readonly connections = new Map<string, DemoConnectionRecord>();
  private readonly attempts = new Map<string, DemoOAuthAttemptRecord>();
  private readonly sheetsTargets = new Map<string, DemoSheetsTargetRecord>();
  private readonly operations = new Map<string, DemoOperationRecord>();
  private readonly testRuns = new Map<string, DemoTestRunRecord>();

  private preferenceKey(ownerUserId: string, projectId: string): string {
    return `${ownerUserId}\u0000${projectId}`;
  }

  private connectionKey(ownerUserId: string, provider: DemoConnectionProvider): string {
    return `${ownerUserId}\u0000${provider}`;
  }

  async getPreference(ownerUserId: string, projectId: string): Promise<DemoPreferenceRecord | null> {
    const record = this.preferences.get(this.preferenceKey(ownerUserId, projectId));
    return record ? clone(record) : null;
  }

  async getLatestPreference(ownerUserId: string): Promise<DemoPreferenceRecord | null> {
    const record = [...this.preferences.values()]
      .filter((candidate) => candidate.ownerUserId === ownerUserId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return record ? clone(record) : null;
  }

  async upsertPreference(input: Omit<DemoPreferenceRecord, "updatedAt">): Promise<DemoPreferenceRecord> {
    const record: DemoPreferenceRecord = { ...input, updatedAt: nowIso() };
    this.preferences.set(this.preferenceKey(input.ownerUserId, input.projectId), record);
    return clone(record);
  }

  async getRun(id: string): Promise<DemoRunRecord | null> {
    const record = this.runs.get(id);
    return record ? clone(record) : null;
  }

  async listRuns(ownerUserId: string, limit: number): Promise<DemoRunRecord[]> {
    return [...this.runs.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async findActiveRun(ownerUserId: string, projectId: string, variantId: string): Promise<DemoRunRecord | null> {
    const record = [...this.runs.values()]
      .filter(
        (candidate) =>
          candidate.ownerUserId === ownerUserId &&
          candidate.projectId === projectId &&
          candidate.variantId === variantId &&
          (candidate.status === "STARTING" || candidate.status === "RUNNING")
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return record ? clone(record) : null;
  }

  async listActiveRuns(): Promise<DemoRunRecord[]> {
    return [...this.runs.values()]
      .filter((record) => record.status === "STARTING" || record.status === "RUNNING")
      .map(clone);
  }

  async upsertRun(input: Omit<DemoRunRecord, "createdAt" | "updatedAt">): Promise<DemoRunRecord> {
    const existing = this.runs.get(input.id);
    const record: DemoRunRecord = { ...input, createdAt: existing?.createdAt ?? nowIso(), updatedAt: nowIso() };
    this.runs.set(record.id, record);
    return clone(record);
  }

  async listConnections(ownerUserId: string): Promise<DemoConnectionRecord[]> {
    return [...this.connections.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .sort((left, right) => left.provider.localeCompare(right.provider))
      .map(clone);
  }

  async getConnection(ownerUserId: string, provider: DemoConnectionProvider): Promise<DemoConnectionRecord | null> {
    const record = this.connections.get(this.connectionKey(ownerUserId, provider));
    return record ? clone(record) : null;
  }

  async upsertConnection(input: Omit<DemoConnectionRecord, "createdAt" | "updatedAt">): Promise<DemoConnectionRecord> {
    const key = this.connectionKey(input.ownerUserId, input.provider);
    const existing = this.connections.get(key);
    const record: DemoConnectionRecord = { ...input, createdAt: existing?.createdAt ?? nowIso(), updatedAt: nowIso() };
    this.connections.set(key, record);
    return clone(record);
  }

  async deleteConnection(ownerUserId: string, provider: DemoConnectionProvider): Promise<void> {
    this.connections.delete(this.connectionKey(ownerUserId, provider));
  }

  async createOAuthAttempt(input: Omit<DemoOAuthAttemptRecord, "consumedAt" | "createdAt">): Promise<DemoOAuthAttemptRecord> {
    const record: DemoOAuthAttemptRecord = { ...input, consumedAt: null, createdAt: nowIso() };
    this.attempts.set(record.stateHash, record);
    return clone(record);
  }

  async consumeOAuthAttempt(input: { stateHash: string; sessionHash: string; consumedAt: string }): Promise<DemoOAuthAttemptRecord | null> {
    const record = this.attempts.get(input.stateHash);
    if (!record || record.consumedAt !== null || record.sessionHash !== input.sessionHash) return null;
    if (Date.parse(record.expiresAt) <= Date.parse(input.consumedAt)) return null;
    record.consumedAt = input.consumedAt;
    return clone(record);
  }

  async deleteExpiredOAuthAttempts(now: string): Promise<DemoOAuthAttemptRecord[]> {
    const expired: DemoOAuthAttemptRecord[] = [];
    for (const [key, record] of this.attempts) {
      if (Date.parse(record.expiresAt) <= Date.parse(now)) {
        expired.push(clone(record));
        this.attempts.delete(key);
      }
    }
    return expired;
  }

  async getSheetsTarget(ownerUserId: string): Promise<DemoSheetsTargetRecord | null> {
    const record = this.sheetsTargets.get(ownerUserId);
    return record ? clone(record) : null;
  }

  async upsertSheetsTarget(input: Omit<DemoSheetsTargetRecord, "updatedAt">): Promise<DemoSheetsTargetRecord> {
    const record: DemoSheetsTargetRecord = { ...input, updatedAt: nowIso() };
    this.sheetsTargets.set(input.ownerUserId, record);
    return clone(record);
  }

  async getOperation(id: string): Promise<DemoOperationRecord | null> {
    const record = this.operations.get(id);
    return record ? clone(record) : null;
  }

  async listOperations(ownerUserId: string, input: { projectId?: string; limit: number }): Promise<DemoOperationRecord[]> {
    return [...this.operations.values()]
      .filter((record) => record.ownerUserId === ownerUserId && (!input.projectId || record.projectId === input.projectId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit)
      .map(clone);
  }

  async findOperationByKey(ownerUserId: string, projectId: string, operationKey: string): Promise<DemoOperationRecord | null> {
    const record = [...this.operations.values()].find(
      (candidate) =>
        candidate.ownerUserId === ownerUserId &&
        candidate.projectId === projectId &&
        candidate.operationKey === operationKey
    );
    return record ? clone(record) : null;
  }

  async upsertOperation(input: Omit<DemoOperationRecord, "createdAt" | "updatedAt">): Promise<DemoOperationRecord> {
    const existing = this.operations.get(input.id);
    const record: DemoOperationRecord = { ...input, createdAt: existing?.createdAt ?? nowIso(), updatedAt: nowIso() };
    this.operations.set(record.id, record);
    return clone(record);
  }

  async claimDueOperations(now: string, limit: number): Promise<DemoOperationRecord[]> {
    const claimed: DemoOperationRecord[] = [];
    for (const record of this.operations.values()) {
      if (claimed.length >= limit) break;
      if (record.status !== "PENDING") continue;
      if (record.nextAttemptAt !== null && Date.parse(record.nextAttemptAt) > Date.parse(now)) continue;
      const updated: DemoOperationRecord = { ...record, status: "RUNNING", updatedAt: now };
      this.operations.set(updated.id, updated);
      claimed.push(clone(updated));
    }
    return claimed;
  }

  async createTestRun(input: Omit<DemoTestRunRecord, "createdAt">): Promise<DemoTestRunRecord> {
    const record: DemoTestRunRecord = { ...input, createdAt: nowIso() };
    this.testRuns.set(record.id, record);
    return clone(record);
  }

  async listTestRuns(ownerUserId: string, projectId: string, limit: number): Promise<DemoTestRunRecord[]> {
    return [...this.testRuns.values()]
      .filter((record) => record.ownerUserId === ownerUserId && record.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async dispose(): Promise<void> {
    this.preferences.clear();
    this.runs.clear();
    this.connections.clear();
    this.attempts.clear();
    this.sheetsTargets.clear();
    this.operations.clear();
    this.testRuns.clear();
  }
}

type PreferenceRow = Omit<DemoPreferenceRecord, "updatedAt"> & { updatedAt: Date | string };
type RunRow = Omit<DemoRunRecord, "createdAt" | "updatedAt" | "startedAt" | "stoppedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  startedAt: Date | string | null;
  stoppedAt: Date | string | null;
};
type ConnectionRow = Omit<
  DemoConnectionRecord,
  "createdAt" | "updatedAt" | "connectedAt" | "lastRefreshedAt" | "lastCheckedAt"
> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  connectedAt: Date | string | null;
  lastRefreshedAt: Date | string | null;
  lastCheckedAt: Date | string | null;
};
type AttemptRow = Omit<DemoOAuthAttemptRecord, "expiresAt" | "consumedAt" | "createdAt"> & {
  expiresAt: Date | string;
  consumedAt: Date | string | null;
  createdAt: Date | string;
};
type SheetsTargetRow = Omit<DemoSheetsTargetRecord, "verifiedAt" | "updatedAt"> & {
  verifiedAt: Date | string | null;
  updatedAt: Date | string;
};
type OperationRow = Omit<
  DemoOperationRecord,
  "createdAt" | "updatedAt" | "sheetsVerifiedAt" | "nextAttemptAt"
> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  sheetsVerifiedAt: Date | string | null;
  nextAttemptAt: Date | string | null;
};
type TestRunRow = Omit<DemoTestRunRecord, "createdAt" | "startedAt" | "finishedAt"> & {
  createdAt: Date | string;
  startedAt: Date | string;
  finishedAt: Date | string;
};

const preferenceSelect = `owner_user_id AS "ownerUserId", project_id AS "projectId", variant_id AS "variantId", mode, updated_at AS "updatedAt"`;
const runSelect = `
  id, owner_user_id AS "ownerUserId", project_id AS "projectId", variant_id AS "variantId", mode, status, port, pid,
  preview_token AS "previewToken", run_token_hash AS "runTokenHash", workspace_path AS "workspacePath", data_path AS "dataPath",
  log_path AS "logPath", health, last_error AS "lastError", started_at AS "startedAt", stopped_at AS "stoppedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
const connectionSelect = `
  id, owner_user_id AS "ownerUserId", provider, status, label, detail, client_id AS "clientId",
  login_url AS "loginUrl", scopes, credential_ref AS "credentialRef", connected_at AS "connectedAt",
  last_refreshed_at AS "lastRefreshedAt", last_checked_at AS "lastCheckedAt", safe_error_code AS "safeErrorCode",
  safe_error_message AS "safeErrorMessage", created_at AS "createdAt", updated_at AS "updatedAt"
`;
const attemptSelect = `
  id, owner_user_id AS "ownerUserId", provider, state_hash AS "stateHash", session_hash AS "sessionHash",
  verifier_ref AS "verifierRef", redirect_uri AS "redirectUri", expires_at AS "expiresAt", consumed_at AS "consumedAt",
  created_at AS "createdAt"
`;
const sheetsTargetSelect = `
  owner_user_id AS "ownerUserId", spreadsheet_id AS "spreadsheetId", spreadsheet_url AS "spreadsheetUrl", title, tab,
  header_present AS "headerPresent", verified_at AS "verifiedAt", updated_at AS "updatedAt"
`;
const operationSelect = `
  id, owner_user_id AS "ownerUserId", operation_key AS "operationKey", project_id AS "projectId",
  variant_id AS "variantId", mode, status, account_name AS "accountName", contact_last_name AS "contactLastName",
  first_name AS "firstName", email, phone, website, salesforce_account_id AS "salesforceAccountId",
  salesforce_contact_id AS "salesforceContactId", salesforce_instance_url AS "salesforceInstanceUrl",
  sheets_row AS "sheetsRow", sheets_verified_at AS "sheetsVerifiedAt", steps, attempts,
  next_attempt_at AS "nextAttemptAt", last_error_code AS "lastErrorCode", last_error_message AS "lastErrorMessage",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
const testRunSelect = `
  id, owner_user_id AS "ownerUserId", project_id AS "projectId", variant_id AS "variantId", mode, status, steps,
  started_at AS "startedAt", finished_at AS "finishedAt", created_at AS "createdAt"
`;

/**
 * `demo_connections.scopes` is jsonb, so the value has to be written as a JSON document:
 * `pg` turns a raw JS array parameter into a Postgres array literal, which Postgres then
 * stores as a jsonb *object* (`[]` -> `{}`) and rejects for non-empty lists. A row written
 * that way broke every read with "row.scopes is not iterable", so reads normalize
 * non-array jsonb values instead of failing the whole Demo Projects pane.
 */
function jsonbStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") {
    try {
      return jsonbStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (value && typeof value === "object") {
    // Recover scope names from the object shape the array-literal bug produced.
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

function mapConnection(row: ConnectionRow): DemoConnectionRecord {
  return {
    ...row,
    scopes: jsonbStringArray(row.scopes),
    connectedAt: isoOrNull(row.connectedAt),
    lastRefreshedAt: isoOrNull(row.lastRefreshedAt),
    lastCheckedAt: isoOrNull(row.lastCheckedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapRun(row: RunRow): DemoRunRecord {
  return {
    ...row,
    health: row.health ?? null,
    startedAt: isoOrNull(row.startedAt),
    stoppedAt: isoOrNull(row.stoppedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

export class PostgresDemoProjectsRepository implements DemoProjectsRepository {
  constructor(private readonly pool: PgPoolLike, private readonly ownsPool = false) {}

  static fromConnectionString(
    connectionString: string,
    poolOptions: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number } = {}
  ): PostgresDemoProjectsRepository {
    return new PostgresDemoProjectsRepository(createSpacePgPool(connectionString, poolOptions, 4), true);
  }

  async getPreference(ownerUserId: string, projectId: string): Promise<DemoPreferenceRecord | null> {
    const result = await this.pool.query<PreferenceRow>(
      `SELECT ${preferenceSelect} FROM demo_preferences WHERE owner_user_id = $1 AND project_id = $2`,
      [ownerUserId, projectId]
    );
    const row = result.rows[0];
    return row ? { ...row, updatedAt: iso(row.updatedAt) } : null;
  }

  async getLatestPreference(ownerUserId: string): Promise<DemoPreferenceRecord | null> {
    const result = await this.pool.query<PreferenceRow>(
      `SELECT ${preferenceSelect} FROM demo_preferences WHERE owner_user_id = $1 ORDER BY updated_at DESC, project_id ASC LIMIT 1`,
      [ownerUserId]
    );
    const row = result.rows[0];
    return row ? { ...row, updatedAt: iso(row.updatedAt) } : null;
  }

  async upsertPreference(input: Omit<DemoPreferenceRecord, "updatedAt">): Promise<DemoPreferenceRecord> {
    const result = await this.pool.query<PreferenceRow>(
      `
        INSERT INTO demo_preferences (owner_user_id, project_id, variant_id, mode)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (owner_user_id, project_id) DO UPDATE SET
          variant_id = EXCLUDED.variant_id,
          mode = EXCLUDED.mode,
          updated_at = now()
        RETURNING ${preferenceSelect}
      `,
      [input.ownerUserId, input.projectId, input.variantId, input.mode]
    );
    const row = result.rows[0]!;
    return { ...row, updatedAt: iso(row.updatedAt) };
  }

  async getRun(id: string): Promise<DemoRunRecord | null> {
    const result = await this.pool.query<RunRow>(`SELECT ${runSelect} FROM demo_runs WHERE id = $1`, [id]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listRuns(ownerUserId: string, limit: number): Promise<DemoRunRecord[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${runSelect} FROM demo_runs WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [ownerUserId, limit]
    );
    return result.rows.map(mapRun);
  }

  async findActiveRun(ownerUserId: string, projectId: string, variantId: string): Promise<DemoRunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `
        SELECT ${runSelect} FROM demo_runs
        WHERE owner_user_id = $1 AND project_id = $2 AND variant_id = $3 AND status IN ('STARTING','RUNNING')
        ORDER BY created_at DESC LIMIT 1
      `,
      [ownerUserId, projectId, variantId]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listActiveRuns(): Promise<DemoRunRecord[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT ${runSelect} FROM demo_runs WHERE status IN ('STARTING','RUNNING') ORDER BY created_at ASC`
    );
    return result.rows.map(mapRun);
  }

  async upsertRun(input: Omit<DemoRunRecord, "createdAt" | "updatedAt">): Promise<DemoRunRecord> {
    const result = await this.pool.query<RunRow>(
      `
        INSERT INTO demo_runs (
          id, owner_user_id, project_id, variant_id, mode, status, port, pid, preview_token, run_token_hash,
          workspace_path, data_path, log_path, health, last_error, started_at, stopped_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          port = EXCLUDED.port,
          pid = EXCLUDED.pid,
          preview_token = EXCLUDED.preview_token,
          run_token_hash = EXCLUDED.run_token_hash,
          workspace_path = EXCLUDED.workspace_path,
          data_path = EXCLUDED.data_path,
          log_path = EXCLUDED.log_path,
          health = EXCLUDED.health,
          last_error = EXCLUDED.last_error,
          started_at = EXCLUDED.started_at,
          stopped_at = EXCLUDED.stopped_at,
          updated_at = now()
        RETURNING ${runSelect}
      `,
      [
        input.id, input.ownerUserId, input.projectId, input.variantId, input.mode, input.status, input.port, input.pid,
        input.previewToken, input.runTokenHash, input.workspacePath, input.dataPath, input.logPath,
        input.health === null ? null : JSON.stringify(input.health), input.lastError, input.startedAt, input.stoppedAt
      ]
    );
    return mapRun(result.rows[0]!);
  }

  async listConnections(ownerUserId: string): Promise<DemoConnectionRecord[]> {
    const result = await this.pool.query<ConnectionRow>(
      `SELECT ${connectionSelect} FROM demo_connections WHERE owner_user_id = $1 ORDER BY provider ASC`,
      [ownerUserId]
    );
    return result.rows.map(mapConnection);
  }

  async getConnection(ownerUserId: string, provider: DemoConnectionProvider): Promise<DemoConnectionRecord | null> {
    const result = await this.pool.query<ConnectionRow>(
      `SELECT ${connectionSelect} FROM demo_connections WHERE owner_user_id = $1 AND provider = $2`,
      [ownerUserId, provider]
    );
    const row = result.rows[0];
    return row ? mapConnection(row) : null;
  }

  async upsertConnection(input: Omit<DemoConnectionRecord, "createdAt" | "updatedAt">): Promise<DemoConnectionRecord> {
    const result = await this.pool.query<ConnectionRow>(
      `
        INSERT INTO demo_connections (
          id, owner_user_id, provider, status, label, detail, client_id, login_url, scopes, credential_ref,
          connected_at, last_refreshed_at, last_checked_at, safe_error_code, safe_error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (owner_user_id, provider) DO UPDATE SET
          status = EXCLUDED.status,
          label = EXCLUDED.label,
          detail = EXCLUDED.detail,
          client_id = EXCLUDED.client_id,
          login_url = EXCLUDED.login_url,
          scopes = EXCLUDED.scopes,
          credential_ref = EXCLUDED.credential_ref,
          connected_at = EXCLUDED.connected_at,
          last_refreshed_at = EXCLUDED.last_refreshed_at,
          last_checked_at = EXCLUDED.last_checked_at,
          safe_error_code = EXCLUDED.safe_error_code,
          safe_error_message = EXCLUDED.safe_error_message,
          updated_at = now()
        RETURNING ${connectionSelect}
      `,
      [
        input.id, input.ownerUserId, input.provider, input.status, input.label, input.detail, input.clientId,
        input.loginUrl, JSON.stringify(input.scopes ?? []), input.credentialRef, input.connectedAt, input.lastRefreshedAt,
        input.lastCheckedAt, input.safeErrorCode, input.safeErrorMessage
      ]
    );
    return mapConnection(result.rows[0]!);
  }

  async deleteConnection(ownerUserId: string, provider: DemoConnectionProvider): Promise<void> {
    await this.pool.query(`DELETE FROM demo_connections WHERE owner_user_id = $1 AND provider = $2`, [ownerUserId, provider]);
  }

  async createOAuthAttempt(input: Omit<DemoOAuthAttemptRecord, "consumedAt" | "createdAt">): Promise<DemoOAuthAttemptRecord> {
    const result = await this.pool.query<AttemptRow>(
      `
        INSERT INTO demo_oauth_attempts (
          id, owner_user_id, provider, state_hash, session_hash, verifier_ref, redirect_uri, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING ${attemptSelect}
      `,
      [input.id, input.ownerUserId, input.provider, input.stateHash, input.sessionHash, input.verifierRef, input.redirectUri, input.expiresAt]
    );
    const row = result.rows[0]!;
    return { ...row, expiresAt: iso(row.expiresAt), consumedAt: isoOrNull(row.consumedAt), createdAt: iso(row.createdAt) };
  }

  async consumeOAuthAttempt(input: { stateHash: string; sessionHash: string; consumedAt: string }): Promise<DemoOAuthAttemptRecord | null> {
    const result = await this.pool.query<AttemptRow>(
      `
        UPDATE demo_oauth_attempts SET consumed_at = $3
        WHERE state_hash = $1 AND session_hash = $2 AND consumed_at IS NULL AND expires_at > $3
        RETURNING ${attemptSelect}
      `,
      [input.stateHash, input.sessionHash, input.consumedAt]
    );
    const row = result.rows[0];
    return row ? { ...row, expiresAt: iso(row.expiresAt), consumedAt: isoOrNull(row.consumedAt), createdAt: iso(row.createdAt) } : null;
  }

  async deleteExpiredOAuthAttempts(now: string): Promise<DemoOAuthAttemptRecord[]> {
    const result = await this.pool.query<AttemptRow>(
      `DELETE FROM demo_oauth_attempts WHERE expires_at <= $1 RETURNING ${attemptSelect}`,
      [now]
    );
    return result.rows.map((row) => ({
      ...row,
      expiresAt: iso(row.expiresAt),
      consumedAt: isoOrNull(row.consumedAt),
      createdAt: iso(row.createdAt)
    }));
  }

  async getSheetsTarget(ownerUserId: string): Promise<DemoSheetsTargetRecord | null> {
    const result = await this.pool.query<SheetsTargetRow>(
      `SELECT ${sheetsTargetSelect} FROM demo_sheets_targets WHERE owner_user_id = $1`,
      [ownerUserId]
    );
    const row = result.rows[0];
    return row ? { ...row, verifiedAt: isoOrNull(row.verifiedAt), updatedAt: iso(row.updatedAt) } : null;
  }

  async upsertSheetsTarget(input: Omit<DemoSheetsTargetRecord, "updatedAt">): Promise<DemoSheetsTargetRecord> {
    const result = await this.pool.query<SheetsTargetRow>(
      `
        INSERT INTO demo_sheets_targets (owner_user_id, spreadsheet_id, spreadsheet_url, title, tab, header_present, verified_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (owner_user_id) DO UPDATE SET
          spreadsheet_id = EXCLUDED.spreadsheet_id,
          spreadsheet_url = EXCLUDED.spreadsheet_url,
          title = EXCLUDED.title,
          tab = EXCLUDED.tab,
          header_present = EXCLUDED.header_present,
          verified_at = EXCLUDED.verified_at,
          updated_at = now()
        RETURNING ${sheetsTargetSelect}
      `,
      [input.ownerUserId, input.spreadsheetId, input.spreadsheetUrl, input.title, input.tab, input.headerPresent, input.verifiedAt]
    );
    const row = result.rows[0]!;
    return { ...row, verifiedAt: isoOrNull(row.verifiedAt), updatedAt: iso(row.updatedAt) };
  }

  async getOperation(id: string): Promise<DemoOperationRecord | null> {
    const result = await this.pool.query<OperationRow>(`SELECT ${operationSelect} FROM demo_operations WHERE id = $1`, [id]);
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async listOperations(ownerUserId: string, input: { projectId?: string; limit: number }): Promise<DemoOperationRecord[]> {
    const result = await this.pool.query<OperationRow>(
      `
        SELECT ${operationSelect} FROM demo_operations
        WHERE owner_user_id = $1 AND ($2::text IS NULL OR project_id = $2)
        ORDER BY created_at DESC LIMIT $3
      `,
      [ownerUserId, input.projectId ?? null, input.limit]
    );
    return result.rows.map(mapOperation);
  }

  async findOperationByKey(ownerUserId: string, projectId: string, operationKey: string): Promise<DemoOperationRecord | null> {
    const result = await this.pool.query<OperationRow>(
      `SELECT ${operationSelect} FROM demo_operations WHERE owner_user_id = $1 AND project_id = $2 AND operation_key = $3`,
      [ownerUserId, projectId, operationKey]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async upsertOperation(input: Omit<DemoOperationRecord, "createdAt" | "updatedAt">): Promise<DemoOperationRecord> {
    const result = await this.pool.query<OperationRow>(
      `
        INSERT INTO demo_operations (
          id, owner_user_id, operation_key, project_id, variant_id, mode, status, account_name, contact_last_name,
          first_name, email, phone, website, salesforce_account_id, salesforce_contact_id, salesforce_instance_url,
          sheets_row, sheets_verified_at, steps, attempts, next_attempt_at, last_error_code, last_error_message
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          salesforce_account_id = EXCLUDED.salesforce_account_id,
          salesforce_contact_id = EXCLUDED.salesforce_contact_id,
          salesforce_instance_url = EXCLUDED.salesforce_instance_url,
          sheets_row = EXCLUDED.sheets_row,
          sheets_verified_at = EXCLUDED.sheets_verified_at,
          steps = EXCLUDED.steps,
          attempts = EXCLUDED.attempts,
          next_attempt_at = EXCLUDED.next_attempt_at,
          last_error_code = EXCLUDED.last_error_code,
          last_error_message = EXCLUDED.last_error_message,
          updated_at = now()
        RETURNING ${operationSelect}
      `,
      [
        input.id, input.ownerUserId, input.operationKey, input.projectId, input.variantId, input.mode, input.status,
        input.accountName, input.contactLastName, input.firstName, input.email, input.phone, input.website,
        input.salesforceAccountId, input.salesforceContactId, input.salesforceInstanceUrl, input.sheetsRow,
        input.sheetsVerifiedAt, JSON.stringify(input.steps), input.attempts, input.nextAttemptAt, input.lastErrorCode,
        input.lastErrorMessage
      ]
    );
    return mapOperation(result.rows[0]!);
  }

  async claimDueOperations(now: string, limit: number): Promise<DemoOperationRecord[]> {
    const result = await this.pool.query<OperationRow>(
      `
        UPDATE demo_operations SET status = 'RUNNING', updated_at = now()
        WHERE id IN (
          SELECT id FROM demo_operations
          WHERE status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        RETURNING ${operationSelect}
      `,
      [now, limit]
    );
    return result.rows.map(mapOperation);
  }

  async createTestRun(input: Omit<DemoTestRunRecord, "createdAt">): Promise<DemoTestRunRecord> {
    const result = await this.pool.query<TestRunRow>(
      `
        INSERT INTO demo_test_runs (id, owner_user_id, project_id, variant_id, mode, status, steps, started_at, finished_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING ${testRunSelect}
      `,
      [
        input.id, input.ownerUserId, input.projectId, input.variantId, input.mode, input.status,
        JSON.stringify(input.steps), input.startedAt, input.finishedAt
      ]
    );
    return mapTestRun(result.rows[0]!);
  }

  async listTestRuns(ownerUserId: string, projectId: string, limit: number): Promise<DemoTestRunRecord[]> {
    const result = await this.pool.query<TestRunRow>(
      `
        SELECT ${testRunSelect} FROM demo_test_runs
        WHERE owner_user_id = $1 AND project_id = $2
        ORDER BY created_at DESC LIMIT $3
      `,
      [ownerUserId, projectId, limit]
    );
    return result.rows.map(mapTestRun);
  }

  async dispose(): Promise<void> {
    if (!this.ownsPool) return;
    const pool = this.pool as unknown as { end?: () => Promise<void> };
    await pool.end?.();
  }
}

function mapOperation(row: OperationRow): DemoOperationRecord {
  return {
    ...row,
    steps: [...row.steps],
    sheetsVerifiedAt: isoOrNull(row.sheetsVerifiedAt),
    nextAttemptAt: isoOrNull(row.nextAttemptAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapTestRun(row: TestRunRow): DemoTestRunRecord {
  return {
    ...row,
    steps: [...row.steps],
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: iso(row.createdAt)
  };
}
