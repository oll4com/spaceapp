import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresSpaceStore, type PgClientLike, type PgPoolLike } from "../src/index.js";

interface QueryCall {
  sql: string;
  values: unknown[];
}

const clipboardRow = {
  id: "clipboard:postgres",
  text: "fallback",
  source: "AGENT_NOTE" as const,
  title: null,
  minimumModel: null,
  minimumReasoning: null,
  isCompleted: false,
  executionStatus: "PLANNED" as const,
  progressPercentage: 0,
  activeAgent: null,
  steps: [],
  lastProgressAt: null,
  roomId: null,
  paneId: null,
  paneTitle: null,
  dependsOn: [],
  dueAt: null,
  waitsOn: null,
  occurrenceCount: 1,
  characterCount: 8,
  createdAt: "2026-07-15T10:00:00.000Z",
  lastUsedAt: "2026-07-15T10:00:00.000Z"
};

class ClipboardPgPool implements PgPoolLike, PgClientLike {
  readonly calls: QueryCall[] = [];

  async connect(): Promise<PgClientLike> {
    return this;
  }

  release(): void {}

  async query<T = unknown>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("INSERT INTO clipboard_items")) {
      return { rows: [clipboardRow as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE clipboard_items")) {
      return { rows: [{ ...clipboardRow, isCompleted: true, executionStatus: "COMPLETED", progressPercentage: 100 } as T], rowCount: 1 };
    }
    if (sql.includes("SELECT count(*) AS count") && sql.includes("FROM clipboard_items")) {
      return { rows: [{ count: 1 } as T], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM clipboard_items") && sql.includes("RETURNING")) {
      return { rows: [clipboardRow as T], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM clipboard_items") && sql.includes("owner_user_id = $1") && !sql.includes("NOT IN")) {
      return { rows: [], rowCount: 3 };
    }
    if (sql.includes("FROM clipboard_items") && sql.includes("SELECT")) {
      return { rows: [clipboardRow as T], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  }
}

describe("PostgresSpaceStore clipboard history", () => {
  it("upserts and prunes under one owner transaction without interpolating clipboard text", async () => {
    const pool = new ClipboardPgPool();
    const store = new PostgresSpaceStore(pool);

    await store.upsertClipboardItem({ ownerUserId: "user:one", text: "fallback", source: "AGENT_NOTE" });

    expect(pool.calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "INSERT INTO",
      "DELETE FROM",
      "COMMIT"
    ]);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO clipboard_items"));
    expect(insert?.sql).toContain("ON CONFLICT (owner_user_id, content_hash)");
    expect(insert?.sql).not.toContain("fallback");
    expect(insert?.values).toContain("fallback");
    const prune = pool.calls.find((call) => call.sql.includes("DELETE FROM clipboard_items"))?.sql;
    expect(prune).toContain("LIMIT 100");
    expect(prune).toContain("source IN ('COPY', 'PASTE')");
  });

  it("scopes list, get, delete, and clear queries to the authenticated owner", async () => {
    const pool = new ClipboardPgPool();
    const store = new PostgresSpaceStore(pool);

    expect(await store.listClipboardItems("user:one", { q: "fall", source: "AGENT_NOTE", page: 1, pageSize: 25 }))
      .toEqual({ items: [clipboardRow], total: 1 });
    expect(await store.getClipboardItem("user:one", clipboardRow.id)).toEqual(clipboardRow);
    expect(await store.deleteClipboardItem("user:one", clipboardRow.id)).toEqual(clipboardRow);
    expect(await store.clearClipboardItems("user:one")).toBe(3);

    const scopedCalls = pool.calls.filter((call) => call.sql.includes("clipboard_items"));
    expect(scopedCalls.every((call) => call.sql.includes("owner_user_id"))).toBe(true);
    expect(scopedCalls.flatMap((call) => call.values)).not.toContain("user:two");
  });

  it("updates completion state with an owner-scoped UPDATE and hides completed items on demand", async () => {
    const pool = new ClipboardPgPool();
    const store = new PostgresSpaceStore(pool);

    const updated = await store.setClipboardItemCompleted("user:one", clipboardRow.id, true);
    expect(updated).toEqual({ ...clipboardRow, isCompleted: true, executionStatus: "COMPLETED", progressPercentage: 100 });

    const update = pool.calls.find((call) => call.sql.includes("UPDATE clipboard_items"));
    expect(update?.sql).toContain("is_completed = $3");
    expect(update?.sql).toContain("owner_user_id = $1 AND id = $2");
    expect(update?.values).toEqual(["user:one", clipboardRow.id, true]);

    pool.calls.length = 0;
    await store.listClipboardItems("user:one", { includeCompleted: false, page: 1, pageSize: 25 });
    const countCall = pool.calls.find((call) => call.sql.includes("SELECT count(*) AS count"));
    expect(countCall?.sql).toContain("is_completed = false");
    expect(countCall?.values).toEqual(["user:one"]);
  });

  it("filters plans by pane with a bound parameter", async () => {
    const pool = new ClipboardPgPool();
    const store = new PostgresSpaceStore(pool);
    await store.listClipboardItems("user:one", { source: "PLAN", includeCompleted: true, paneId: "pane:bob1234", page: 1, pageSize: 1 });
    const countCall = pool.calls.find((call) => call.sql.includes("SELECT count(*) AS count"));
    expect(countCall?.sql).toContain("owner_user_id = $1");
    expect(countCall?.sql).toContain("pane_id = $3");
    expect(countCall?.values).toEqual(["user:one", "PLAN", "pane:bob1234"]);
    await expect(store.listClipboardItems("user:one", { paneId: "pane'; DROP", page: 1, pageSize: 1 } as any)).rejects.toThrow();
  });

  it("normalizes irregular plan steps and gracefully skips corrupt rows during listClipboardItems", async () => {
    class IrregularStepsPool extends ClipboardPgPool {
      override async query<T = unknown>(sql: string, values: unknown[] = []) {
        if (sql.includes("FROM clipboard_items") && sql.includes("SELECT count(*)")) {
          return { rows: [{ count: 2 } as T], rowCount: 1 };
        }
        if (sql.includes("FROM clipboard_items") && sql.includes("ORDER BY")) {
          const validWithIrregularSteps = {
            ...clipboardRow,
            id: "clipboard:plan-with-steps",
            source: "PLAN",
            title: "Custom & Max Plan",
            stepsJson: [
              { title: "1. Contracts & DB Schema", status: "PLANNED" },
              { title: "2. Environment Preset Logic Hook", status: "PLANNED" }
            ]
          };
          const totallyCorruptRow = {
            id: "clipboard:broken",
            // missing text and invalid source will fail clipboardItemSchema
            text: null,
            source: "INVALID_SOURCE"
          };
          return { rows: [validWithIrregularSteps as T, totallyCorruptRow as T], rowCount: 2 };
        }
        return super.query<T>(sql, values);
      }
    }

    const pool = new IrregularStepsPool();
    const store = new PostgresSpaceStore(pool);
    const result = await store.listClipboardItems("user:one", { page: 1, pageSize: 25 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("clipboard:plan-with-steps");
    expect(result.items[0]?.steps).toHaveLength(2);
    expect(result.items[0]?.steps[0]).toMatchObject({
      id: "step-1",
      order: 1,
      title: "1. Contracts & DB Schema",
      status: "PENDING"
    });
    expect(result.items[0]?.steps[1]).toMatchObject({
      id: "step-2",
      order: 2,
      title: "2. Environment Preset Logic Hook",
      status: "PENDING"
    });
  });
});

describe("PostgresSpaceStore plan map (operator request 2026-10-25)", () => {
  /** The owner's open plans: the row itself and one other plan that depends on it; `managed` makes the row a managed plan. */
  class PlanPool extends ClipboardPgPool {
    constructor(private readonly managed = false) { super(); }
    override async query<T = unknown>(sql: string, values: unknown[] = []) {
      if (sql.includes("SELECT id FROM managed_plan_executions")) { this.calls.push({ sql, values }); return { rows: (this.managed ? [{ id: "exec:1" }] : []) as T[], rowCount: this.managed ? 1 : 0 }; }
      if (sql.includes('depends_on AS "dependsOn" FROM clipboard_items')) {
        this.calls.push({ sql, values });
        return { rows: [{ id: clipboardRow.id, dependsOn: [] }, { id: "clipboard:other001", dependsOn: [clipboardRow.id] }, { id: "clipboard:free0001", dependsOn: [] }] as T[], rowCount: 3 };
      }
      return super.query<T>(sql, values);
    }
  }

  it("writes depends_on, due_at and waits_on_json on a progress update and every RETURNING list carries them", async () => {
    const pool = new PlanPool();
    const store = new PostgresSpaceStore(pool);
    await store.updateClipboardItemProgress("user:one", clipboardRow.id, {
      executionStatus: "IN_PROGRESS", dependsOn: ["clipboard:free0001"], dueAt: "2026-10-30T09:00:00.000Z", waitsOn: { kind: "THIRD_PARTY", what: "the mail server", until: null }
    });
    const update = pool.calls.find((call) => call.sql.includes("UPDATE clipboard_items"));
    expect(update?.sql).toContain("depends_on = $11::jsonb");
    expect(update?.values.slice(10)).toEqual(['["clipboard:free0001"]', "2026-10-30T09:00:00.000Z", '{"kind":"THIRD_PARTY","what":"the mail server","until":null}', null, null, null]);
    const reads = pool.calls.filter((call) => call.sql.includes("RETURNING") || call.sql.includes('steps_json AS "stepsJson"'));
    expect(reads.length).toBeGreaterThan(1);
    for (const call of reads) expect(call.sql).toContain('waits_on_json AS "waitsOn"');
  });

  it("edits a plan's title and text in place with the new content hash (Nous daily upgrade 2026-10-27)", async () => {
    const pool = new PlanPool();
    const store = new PostgresSpaceStore(pool);
    await store.updateClipboardItemProgress("user:one", clipboardRow.id, { title: "New title", text: "New text." });
    const update = pool.calls.find((call) => call.sql.includes("UPDATE clipboard_items"));
    expect(update?.sql).toContain("text = COALESCE($15, text)");
    expect(update?.values.slice(13)).toEqual(["New title", "New text.", createHash("sha256").update("New text.").digest("hex")]);
  });

  it("lets a managed plan take a map-only update and refuses a loop", async () => {
    const pool = new PlanPool(true);
    const store = new PostgresSpaceStore(pool);
    await expect(store.updateClipboardItemProgress("user:one", clipboardRow.id, { progressPercentage: 10 })).rejects.toThrow("Managed plan progress");
    await store.updateClipboardItemProgress("user:one", clipboardRow.id, { dueAt: "2026-10-30T09:00:00.000Z" });
    const update = pool.calls.find((call) => call.sql.includes("UPDATE clipboard_items"));
    expect(update?.sql).toContain("SET depends_on = $3::jsonb, due_at = $4::timestamptz, waits_on_json = $5::jsonb, last_used_at = clock_timestamp()");
    expect(update?.sql).not.toContain("last_progress_at = clock_timestamp()");
    await expect(store.updateClipboardItemProgress("user:one", clipboardRow.id, { dependsOn: ["clipboard:other001"] })).rejects.toThrow("would loop");
  });
});
