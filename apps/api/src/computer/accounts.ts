import { rollbackKeepingError, type PgPoolLike } from "@space/db";
import type { CellOrchestrator } from "./cells.js";

// K4 account lifecycle (plan clipboard:ZGz1LnD51ELH step 7): one place moves the tenant's status, its Nous Gateway keys and its cell
// together. Order: closing steps shut the tenant gate first (the provisioner refuses a non-ACTIVE tenant), reopening steps open it
// last, so a step that fails half way leaves the account closed; every step is idempotent and safe to retry.
// The account API (account-routes.ts) and the hourly finishDueDeletions sweep are wired in platform-routes-wiring.ts (headless only).

/** Deletion stays undoable this long (K2 design §3.2). */
export const DELETION_UNDO_MS = 7 * 24 * 60 * 60_000;

/** Sweep cadence: a deletion finishes at most this long after its undo window ends. */
export const DELETION_SWEEP_MS = 60 * 60_000;

export class AccountStateError extends Error {}

export type AccountLifecycle = ReturnType<typeof createAccountLifecycle>;

export interface AccountView {
  tenantId: string;
  kind: string;
  region: string | null;
  status: string;
  /** When the data goes, while a deletion can still be cancelled; null otherwise. */
  deleteAfter: string | null;
}

/** The Nous Gateway admin call POST /tenants/:id/status (packages/gateway/src/nous/admin.ts); a fake in tests. */
export interface TenantKeyStatusPort {
  setStatus(tenantId: string, status: "ACTIVE" | "FROZEN" | "REVOKED", reason: string): Promise<void>;
}

export function createAccountLifecycle(options: { pool: PgPoolLike; cells: CellOrchestrator; keys: TenantKeyStatusPort; now?: () => number }) {
  const { pool, cells, keys } = options;
  const now = options.now ?? Date.now;

  /** One conditional UPDATE: the move happens only from the listed statuses, so two racing calls cannot both pass. */
  async function move(tenantId: string, from: string[], set: string, values: unknown[] = []): Promise<Record<string, unknown> | undefined> {
    const { rows } = await pool.query<Record<string, unknown>>(
      `UPDATE tenants SET ${set} WHERE id = $1 AND status = ANY($2::text[]) RETURNING status`,
      [tenantId, from, ...values]);
    return rows[0];
  }
  async function status(tenantId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
    if (!rows[0]) throw new AccountStateError(`Tenant ${tenantId} does not exist.`);
    return rows[0].status;
  }
  async function reopen(tenantId: string, reason: string) {
    await cells.resumeCell(tenantId);
    // Releases only this side's freeze: keys billing froze stay FROZEN until the subscription is paid (gateway setTenantKeyStatus).
    await keys.setStatus(tenantId, "ACTIVE", reason);
  }

  const lifecycle = {
    async account(tenantId: string): Promise<AccountView> {
      const { rows } = await pool.query<{ kind: string; region: string | null; status: string; deletion_requested_at: Date | null }>(
        "SELECT kind, region, status, deletion_requested_at FROM tenants WHERE id = $1", [tenantId]);
      const row = rows[0];
      if (!row) throw new AccountStateError(`Tenant ${tenantId} does not exist.`);
      const requested = row.status === "DELETING" && row.deletion_requested_at ? new Date(row.deletion_requested_at).getTime() : null;
      return { tenantId, kind: row.kind, region: row.region, status: row.status,
        deleteAfter: requested === null ? null : new Date(requested + DELETION_UNDO_MS).toISOString() };
    },

    /** Abuse, chargeback, staff: no AI and no computer until resume; data and export stay. */
    async suspend(tenantId: string, reason: string): Promise<void> {
      if (!(await move(tenantId, ["ACTIVE", "FROZEN"], "status = 'FROZEN'"))) throw new AccountStateError(`Tenant ${tenantId} is ${await status(tenantId)}; only an active account is suspended.`);
      await keys.setStatus(tenantId, "FROZEN", reason);
      await cells.suspendCell(tenantId);
    },

    async resume(tenantId: string, reason: string): Promise<void> {
      const current = await status(tenantId);
      if (current === "DELETING") throw new AccountStateError(`Tenant ${tenantId} is being deleted; cancel the deletion first.`);
      await reopen(tenantId, reason);
      await move(tenantId, ["FROZEN", "ACTIVE"], "status = 'ACTIVE'");
    },

    /** DELETE /api/account: closes the account now and exports the computer (GDPR Art. 17 and 20); the data goes after DELETION_UNDO_MS. */
    async requestDeletion(tenantId: string, reason: string): Promise<{ exportKey: string | null; deleteAfter: number }> {
      const at = now();
      const moved = await move(tenantId, ["ACTIVE", "FROZEN"], "status_before_deletion = status, status = 'DELETING', deletion_requested_at = to_timestamp($3 / 1000.0)", [at]);
      const requestedAt = moved ? at : await deletingSince(tenantId);
      await keys.setStatus(tenantId, "FROZEN", reason); // not revoked: the deletion can still be cancelled
      await cells.suspendCell(tenantId);
      const cell = await cells.cell(tenantId);
      const exportKey = cell && cell.state !== "NONE" && cell.state !== "DELETED" ? (await cells.exportCell(tenantId)).exportKey : null;
      return { exportKey, deleteAfter: requestedAt + DELETION_UNDO_MS };
    },

    /** The undo: back to the status the account had, so a suspended account stays suspended. */
    async cancelDeletion(tenantId: string, reason: string): Promise<void> {
      // Only inside the window: after it finishDeletion may already have revoked the keys and destroyed the cell.
      const { rows } = await pool.query<{ status: string }>(`UPDATE tenants SET status = status_before_deletion, status_before_deletion = NULL,
        deletion_requested_at = NULL WHERE id = $1 AND status = 'DELETING' AND deletion_requested_at > to_timestamp($2 / 1000.0) RETURNING status`,
        [tenantId, now() - DELETION_UNDO_MS]);
      const moved = rows[0];
      if (!moved) throw new AccountStateError(`Tenant ${tenantId} has no deletion that can still be cancelled.`);
      if (moved.status === "ACTIVE") await reopen(tenantId, reason);
    },

    /** After the undo window: keys revoked, the computer destroyed, then the tenant's rows purged (K1) and the deletion marked finished. */
    async finishDeletion(tenantId: string, reason: string): Promise<void> {
      const since = await deletingSince(tenantId);
      if (now() - since < DELETION_UNDO_MS) throw new AccountStateError(`Tenant ${tenantId} can still cancel its deletion until ${new Date(since + DELETION_UNDO_MS).toISOString()}.`);
      await keys.setStatus(tenantId, "REVOKED", reason);
      await cells.deleteCell(tenantId, { force: "tenant-deletion" });
      await purgeTenantRows(pool, tenantId, now());
    },

    /** The timer: finishes every deletion past its undo window; one failure does not stop the rest and is retried next sweep. */
    async finishDueDeletions(reason: string): Promise<{ finished: string[]; failed: Array<{ tenantId: string; error: string }> }> {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE status = 'DELETING' AND deletion_finished_at IS NULL
        AND deletion_requested_at <= to_timestamp($1 / 1000.0) ORDER BY deletion_requested_at`, [now() - DELETION_UNDO_MS]);
      const finished: string[] = [], failed: Array<{ tenantId: string; error: string }> = [];
      for (const { id } of rows) {
        try {
          await lifecycle.finishDeletion(id, reason);
          finished.push(id);
        } catch (error) {
          failed.push({ tenantId: id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { finished, failed };
    }
  };
  return lifecycle;

  async function deletingSince(tenantId: string): Promise<number> {
    const { rows } = await pool.query<{ status: string; deletion_requested_at: Date | null }>(
      "SELECT status, deletion_requested_at FROM tenants WHERE id = $1", [tenantId]);
    const row = rows[0];
    if (!row || row.status !== "DELETING" || !row.deletion_requested_at) throw new AccountStateError(`Tenant ${tenantId} is ${row?.status ?? "missing"}, not being deleted.`);
    return new Date(row.deletion_requested_at).getTime();
  }
}

/** Rows with a tenant_id that outlive the tenant: the cell stays as a DELETED row (record-retention CLASS_A). */
const PURGE_KEEPS = new Set(["nous_computer_cells"]);

/**
 * K1 purge (plan clipboard:ZGz1LnD51ELH step 7), one transaction: every row of the tenant in every table with a tenant_id (read from
 * the catalog, so a new tenant table is covered), the global rows naming its people (their spent invites, a waitlist entry), then
 * deletion_finished_at. The tenants row stays as the record that the account existed and was deleted; it holds no personal data.
 * shortcut: retries a table its foreign keys block after the others instead of ordering by the FK graph; order once if purges get slow.
 */
async function purgeTenantRows(pool: PgPoolLike, tenantId: string, at: number): Promise<void> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('space.tenant_id', $1, true)", [tenantId]); // RLS shows exactly this tenant's rows
    const { rows: people } = await client.query<{ id: string; email: string }>("SELECT id, lower(email) AS email FROM users WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM user_invites WHERE accepted_user_id = ANY($1::text[])", [people.map((person) => person.id)]);
    await client.query("DELETE FROM public_waitlist_signups WHERE email = ANY($1::text[])", [people.map((person) => person.email)]);
    let tables = (await client.query<{ table_name: string }>(`SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'tenant_id' ORDER BY table_name`)).rows.map((row) => row.table_name).filter((table) => !PURGE_KEEPS.has(table));
    while (tables.length) {
      const blocked: string[] = [];
      for (const table of tables) {
        await client.query("SAVEPOINT purge_table");
        try {
          await client.query(`DELETE FROM "${table.replaceAll('"', '""')}" WHERE tenant_id = $1`, [tenantId]);
          await client.query("RELEASE SAVEPOINT purge_table");
        } catch (error) {
          // 23503: rows of the tenant still reference these; 23502: an ON DELETE SET NULL would null a child's tenant_id. Both clear once the children go.
          if (!["23503", "23502"].includes((error as { code?: string }).code ?? "")) throw error;
          await client.query("ROLLBACK TO SAVEPOINT purge_table");
          blocked.push(table);
        }
      }
      if (blocked.length === tables.length) throw new AccountStateError(`Tenant ${tenantId} purge is blocked by foreign keys among ${blocked.join(", ")}.`);
      tables = blocked;
    }
    await client.query(`UPDATE tenants SET deletion_finished_at = to_timestamp($2 / 1000.0), ai_key_sealed = NULL, ai_key_hint = NULL, ai_key_checked_at = NULL
      WHERE id = $1 AND status = 'DELETING'`, [tenantId, at]);
    await client.query("COMMIT");
  } catch (error) {
    const rollback = await rollbackKeepingError(client, error);
    broken = rollback.failed;
    throw rollback.error;
  } finally {
    client.release?.(broken);
  }
}
