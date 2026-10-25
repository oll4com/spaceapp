import type { AnyProjectBinding, PersonalGitConnection, GitRemoteRepository, RepositoryProviderId } from "@space/contracts";
import { normalizeProjectBinding } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface PersonalGitConnectionRecord extends PersonalGitConnection<RepositoryProviderId> { ownerUserId: string; credentialRef: string | null }
export interface RepositoryPublishOperation {
  ownerUserId: string; bindingId: string; operationId: string; fingerprint: string;
  state: "creating" | "created" | "unknown" | "rejected";
  previousOperationIds?: string[];
  name?: string; targetId?: string | null;
  remote: GitRemoteRepository | null; errorCode: string | null; createdAt: string;
}
export interface SourceControlRepository {
  getPublish(owner: string, bindingId: string): Promise<RepositoryPublishOperation | null>;
  claimPublish(operation: RepositoryPublishOperation): Promise<boolean>;
  finishPublish(operation: RepositoryPublishOperation): Promise<void>;
  /** Marks an unconfirmed (unknown/creating) operation as rejected after the user verified nothing was created. */
  dismissPublish(owner: string, bindingId: string, operationId: string): Promise<boolean>;
  getConnection(owner: string, provider: RepositoryProviderId): Promise<PersonalGitConnectionRecord | null>;
  saveConnection(record: PersonalGitConnectionRecord): Promise<void>;
  getBinding(owner: string, id: string): Promise<AnyProjectBinding | null>;
  listBindings(owner: string): Promise<AnyProjectBinding[]>;
  saveBinding(record: AnyProjectBinding): Promise<void>;
  setDefaultBinding?(owner: string, projectPath: string, provider: RepositoryProviderId, bindingId: string | null): Promise<void>;
  close?(): Promise<void>;
}
export class InMemorySourceControlRepository implements SourceControlRepository {
  private publishes = new Map<string, RepositoryPublishOperation>();
  async getPublish(owner: string, bindingId: string) { const record = this.publishes.get(bindingId); return record?.ownerUserId === owner ? structuredClone(record) : null; }
  async claimPublish(operation: RepositoryPublishOperation) {
    if (this.bindings.get(operation.bindingId)?.ownerUserId !== operation.ownerUserId) return false;
    const previous = this.publishes.get(operation.bindingId);
    if (previous && (previous.ownerUserId !== operation.ownerUserId || previous.state !== "rejected" || previous.operationId === operation.operationId || previous.previousOperationIds?.includes(operation.operationId))) return false;
    const next = previous ? { ...operation, previousOperationIds: [...previous.previousOperationIds ?? [], previous.operationId] } : operation;
    this.publishes.set(operation.bindingId, structuredClone(next)); return true;
  }
  async finishPublish(operation: RepositoryPublishOperation) {
    const current = this.publishes.get(operation.bindingId);
    if (!current || current.ownerUserId !== operation.ownerUserId || current.operationId !== operation.operationId || current.fingerprint !== operation.fingerprint || current.state !== "creating" || operation.state === "creating") throw new Error("Publish operation ownership or state changed.");
    this.publishes.set(operation.bindingId, structuredClone({ ...operation, ...(current.previousOperationIds ? { previousOperationIds: current.previousOperationIds } : {}) }));
  }
  async dismissPublish(owner: string, bindingId: string, operationId: string) {
    const current = this.publishes.get(bindingId);
    if (!current || current.ownerUserId !== owner || current.operationId !== operationId || current.state !== "unknown" && current.state !== "creating") return false;
    this.publishes.set(bindingId, { ...current, state: "rejected", errorCode: "DISMISSED_BY_USER" }); return true;
  }
  private connections = new Map<string, PersonalGitConnectionRecord>();
  private bindings = new Map<string, AnyProjectBinding>();
  async getConnection(owner: string, provider: RepositoryProviderId) { return structuredClone(this.connections.get(JSON.stringify([owner, provider])) ?? null); }
  async saveConnection(record: PersonalGitConnectionRecord) { this.connections.set(JSON.stringify([record.ownerUserId, record.provider]), structuredClone(record)); }
  async getBinding(owner: string, id: string) { const record = this.bindings.get(id); return record?.ownerUserId === owner ? normalizeProjectBinding(structuredClone(record)) : null; }
  async listBindings(owner: string) { return [...this.bindings.values()].filter(r => r.ownerUserId === owner).map(r => normalizeProjectBinding(structuredClone(r))); }
  async saveBinding(record: AnyProjectBinding) {
    const existing = this.bindings.get(record.id);
    if (existing && existing.ownerUserId !== record.ownerUserId) throw new Error("Binding ownership mismatch.");
    if (record.kind !== "local" && record.kind !== "git-url" && record.isDefault) {
      for (const [key, b] of this.bindings.entries()) {
        if (b.kind !== "local" && b.kind !== "git-url" && b.ownerUserId === record.ownerUserId && b.projectPath === record.projectPath && b.provider === record.provider && b.id !== record.id) {
          this.bindings.set(key, { ...b, isDefault: false });
        }
      }
    }
    this.bindings.set(record.id, structuredClone(record));
  }
  async setDefaultBinding(owner: string, projectPath: string, provider: RepositoryProviderId, bindingId: string | null) {
    for (const [key, b] of this.bindings.entries()) {
      if (b.kind !== "local" && b.kind !== "git-url" && b.ownerUserId === owner && b.projectPath === projectPath && b.provider === provider) {
        this.bindings.set(key, { ...b, isDefault: bindingId ? b.id === bindingId : false });
      }
    }
  }
}
export class PostgresSourceControlRepository implements SourceControlRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(connectionString: string) { return new PostgresSourceControlRepository(createSpacePgPool(connectionString, { max: 2 }, 2)); }
  async getPublish(owner: string, bindingId: string) {
    const result = await this.pool.query<{ data: RepositoryPublishOperation }>("SELECT data FROM repository_publish_operations WHERE owner_user_id=$1 AND binding_id=$2", [owner, bindingId]);
    return result.rows[0]?.data ?? null;
  }
  async claimPublish(operation: RepositoryPublishOperation) {
    const result = await this.pool.query("INSERT INTO repository_publish_operations(binding_id,owner_user_id,data) SELECT $1,$2,$3::jsonb WHERE EXISTS(SELECT 1 FROM project_repository_bindings WHERE id=$1 AND owner_user_id=$2) ON CONFLICT(binding_id) DO UPDATE SET data=jsonb_set(EXCLUDED.data,'{previousOperationIds}',COALESCE(repository_publish_operations.data->'previousOperationIds','[]'::jsonb) || to_jsonb(repository_publish_operations.data->>'operationId')) WHERE repository_publish_operations.owner_user_id=EXCLUDED.owner_user_id AND repository_publish_operations.data->>'state'='rejected' AND repository_publish_operations.data->>'operationId' <> EXCLUDED.data->>'operationId' AND NOT COALESCE(repository_publish_operations.data->'previousOperationIds','[]'::jsonb) ? (EXCLUDED.data->>'operationId') RETURNING binding_id", [operation.bindingId, operation.ownerUserId, JSON.stringify(operation)]);
    return result.rows.length === 1;
  }
  async finishPublish(operation: RepositoryPublishOperation) {
    if (operation.state === "creating") throw new Error("Invalid publish transition.");
    const result = await this.pool.query("UPDATE repository_publish_operations SET data=$1::jsonb || CASE WHEN data ? 'previousOperationIds' THEN jsonb_build_object('previousOperationIds', data->'previousOperationIds') ELSE '{}'::jsonb END WHERE binding_id=$2 AND owner_user_id=$3 AND data->>'operationId'=$4 AND data->>'fingerprint'=$5 AND data->>'state'='creating' RETURNING binding_id", [JSON.stringify(operation), operation.bindingId, operation.ownerUserId, operation.operationId, operation.fingerprint]);
    if (result.rows.length !== 1) throw new Error("Publish operation ownership or state changed.");
  }
  async dismissPublish(owner: string, bindingId: string, operationId: string) {
    const result = await this.pool.query("UPDATE repository_publish_operations SET data=data || jsonb_build_object('state','rejected','errorCode','DISMISSED_BY_USER') WHERE binding_id=$1 AND owner_user_id=$2 AND data->>'operationId'=$3 AND data->>'state' IN ('unknown','creating') RETURNING binding_id", [bindingId, owner, operationId]);
    return result.rows.length === 1;
  }
  async getConnection(owner: string, provider: RepositoryProviderId) {
    const result = await this.pool.query<{ data: PersonalGitConnectionRecord }>("SELECT data FROM personal_git_connections WHERE owner_user_id=$1 AND provider=$2", [owner, provider]);
    return result.rows[0]?.data ?? null;
  }
  async saveConnection(record: PersonalGitConnectionRecord) {
    await this.pool.query("INSERT INTO personal_git_connections(owner_user_id,provider,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(owner_user_id,provider) DO UPDATE SET data=EXCLUDED.data", [record.ownerUserId, record.provider, JSON.stringify(record)]);
  }
  async getBinding(owner: string, id: string) {
    const result = await this.pool.query<{ data: AnyProjectBinding }>("SELECT data FROM project_repository_bindings WHERE owner_user_id=$1 AND id=$2", [owner, id]);
    return result.rows[0] ? normalizeProjectBinding(result.rows[0].data) : null;
  }
  async listBindings(owner: string) {
    const result = await this.pool.query<{ data: AnyProjectBinding }>("SELECT data FROM project_repository_bindings WHERE owner_user_id=$1 ORDER BY id", [owner]);
    return result.rows.map(r => normalizeProjectBinding(r.data));
  }
  async saveBinding(record: AnyProjectBinding) {
    if (record.kind === "provider" && record.isDefault) {
      const list = await this.listBindings(record.ownerUserId);
      for (const b of list) {
        if (b.kind === "provider" && b.projectPath === record.projectPath && b.provider === record.provider && b.id !== record.id && b.isDefault) {
          const updated = { ...b, isDefault: false };
          await this.pool.query("UPDATE project_repository_bindings SET data=$1::jsonb WHERE owner_user_id=$2 AND id=$3", [JSON.stringify(updated), record.ownerUserId, b.id]);
        }
      }
    }
    await this.pool.query("INSERT INTO project_repository_bindings(id,owner_user_id,project_path,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,project_path=EXCLUDED.project_path WHERE project_repository_bindings.owner_user_id=EXCLUDED.owner_user_id", [record.id, record.ownerUserId, record.projectPath, JSON.stringify(record)]);
  }
  async setDefaultBinding(owner: string, projectPath: string, provider: RepositoryProviderId, bindingId: string | null) {
    const list = await this.listBindings(owner);
    for (const b of list) {
      if (b.kind === "provider" && b.projectPath === projectPath && b.provider === provider) {
        const isDef = bindingId ? b.id === bindingId : false;
        if (Boolean(b.isDefault) !== isDef) {
          const updated = { ...b, isDefault: isDef };
          await this.pool.query("UPDATE project_repository_bindings SET data=$1::jsonb WHERE owner_user_id=$2 AND id=$3", [JSON.stringify(updated), owner, b.id]);
        }
      }
    }
  }
  async close() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
