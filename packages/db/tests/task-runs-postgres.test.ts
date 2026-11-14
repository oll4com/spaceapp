// Task runs on a real, disposable PostgreSQL (migration 0277, plan clipboard:GA__W4qBxSPR): one row per claimed occurrence in the
// claim's own statement, the pane's report deciding a typed run, NO_REPORT after 6 h, paging, filters and counts. Skips without Docker.
import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:taskruns";

describe.skipIf(unavailable !== null)(`Task runs on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("taskruns");
    await server.createDatabase("space_task_runs");
    pool = server.pool("space_task_runs", 2);
    const client = await pool.connect();
    try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, 'taskruns@space.local', 'ADMIN')", [owner]);
    await pool.query(`INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('room:taskruns01','Alex','trace:taskruns01','${owner}',0);
      INSERT INTO panes(id,room_id,title,pane_name,mode,status,pane_order) VALUES ('pane:taskruns01','room:taskruns01','Claude','Andy','TERMINAL','IDLE',0)`);
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("logs each claim once, lets the pane's report decide a typed run, settles silent ones and pages newest first", async () => {
    const store = new PostgresSpaceStore(pool);
    const schedule = { recurrence: { kind: "INTERVAL" as const, minutes: 120 }, timeZone: "UTC" };
    const typedTask = await store.upsertTaskItem({ ownerUserId: owner, title: "Check the ticket", objective: "Check it.", status: "OPEN", source: "AGENT", paneId: "pane:taskruns01", roomId: "room:taskruns01", schedule });
    const reminder = await store.upsertTaskItem({ ownerUserId: owner, title: "Stretch", objective: "Stretch.", status: "OPEN", source: "MANUAL", schedule });
    const due = (await store.getTaskItem(owner, typedTask.id))!.schedule!.nextRunAt!;
    const claim = { nextRunAt: "2030-01-01T00:00:00.000Z", outcome: "Sent to the CLI.", status: "RUNNING" as const, at: "2026-10-15T10:00:10.000Z" };
    expect(await store.claimTaskSchedule(typedTask.id, due, claim)).toBe(true);
    expect(await store.claimTaskSchedule(typedTask.id, due, claim)).toBe(false);
    expect((await store.getTaskItem(owner, typedTask.id))!.schedule).toMatchObject({ lastOutcome: "Sent to the CLI.", lastRunAt: "2026-10-15T10:00:10.000Z" });
    const reminderDue = (await store.getTaskItem(owner, reminder.id))!.schedule!.nextRunAt!;
    expect(await store.claimTaskSchedule(reminder.id, reminderDue, { nextRunAt: null, outcome: "Reminder due.", status: "REMINDER", at: "2026-10-15T10:00:11.000Z" })).toBe(true);

    let page = await store.listTaskRuns(owner, { limit: 100 });
    expect(page.runs.map(({ taskTitle, status, typed, roomName, paneName }) => ({ taskTitle, status, typed, roomName, paneName }))).toEqual([
      { taskTitle: "Stretch", status: "REMINDER", typed: false, roomName: null, paneName: null },
      { taskTitle: "Check the ticket", status: "RUNNING", typed: true, roomName: "Alex", paneName: "Andy" }]);
    expect(page.runs[1]).toMatchObject({ dueAt: due, at: "2026-10-15T10:00:10.000Z", detail: "Sent to the CLI.", reportAt: null });

    const report = (at: string, status: string, summary = status) => store.noteTaskRunReport(owner, { paneId: "pane:taskruns01", at, status, summary });
    expect(await report("2026-10-15T10:00:00.000Z", "DONE")).toBe(false);
    expect(await report("2026-10-15T10:05:00.000Z", "TURN_END", "Read the ticket")).toBe(true);
    expect(await report("2026-10-15T10:06:00.000Z", "NEEDS_YOU", "Which account?")).toBe(true);
    expect(await report("2026-10-15T10:07:00.000Z", "HEARTBEAT")).toBe(false);
    expect(await report("2026-10-15T10:20:00.000Z", "BLOCKED", "Ticket portal down")).toBe(true);
    expect(await report("2026-10-15T10:30:00.000Z", "DONE")).toBe(false);
    page = await store.listTaskRuns(owner, { limit: 100, taskId: typedTask.id });
    expect(page.runs[0]).toMatchObject({ status: "FAILED", report: "Ticket portal down", reportAt: "2026-10-15T10:20:00.000Z" });

    // A later typed run with no report at all ends NO_REPORT 6 h after it, not before.
    await pool.query(`INSERT INTO task_runs (owner_user_id, task_id, task_title, pane_id, due_at, at, status, typed, detail)
      VALUES ($1, $2, 'Check the ticket', 'pane:taskruns01', '2026-10-15T12:00:00Z', '2026-10-15T12:00:10Z', 'RUNNING', true, 'Sent.')`, [owner, typedTask.id]);
    expect(await store.settleTaskRuns("2026-10-15T18:00:10.000Z")).toBe(0);
    expect(await store.settleTaskRuns("2026-10-15T18:00:11.000Z")).toBe(1);

    page = await store.listTaskRuns(owner, { limit: 1 });
    expect(page).toMatchObject({ hasMore: true, counts: { NO_REPORT: 1, FAILED: 1, REMINDER: 1, RUNNING: 0, SUCCEEDED: 0, WAITING: 0, SKIPPED: 0 } });
    expect(page.runs.map((run) => run.status)).toEqual(["NO_REPORT"]);
    expect(page.tasks).toEqual([{ taskId: typedTask.id, title: "Check the ticket", runs: 2 }, { taskId: reminder.id, title: "Stretch", runs: 1 }]);
    const older = await store.listTaskRuns(owner, { limit: 100, before: page.runs[0]!.id });
    expect(older.runs.map((run) => run.status)).toEqual(["REMINDER", "FAILED"]);
    expect((await store.listTaskRuns(owner, { limit: 100, status: "FAILED" })).runs.map((run) => run.taskTitle)).toEqual(["Check the ticket"]);
    expect((await store.listTaskRuns(owner, { limit: 100, taskId: reminder.id })).counts).toMatchObject({ REMINDER: 1, FAILED: 0 });
    // A deleted task keeps its history.
    await store.deleteTaskItem(owner, reminder.id);
    expect((await store.listTaskRuns(owner, { limit: 100, taskId: reminder.id })).runs).toHaveLength(1);
  });

  it("queue item 267: an agent's ONCE task closes when its pane reports it done; failed, recurring and the operator's own stay open", async () => {
    const store = new PostgresSpaceStore(pool);
    await pool.query(`INSERT INTO panes(id,room_id,title,pane_name,mode,status,pane_order) VALUES
      ('pane:taskruns02','room:taskruns01','Claude','Bob','TERMINAL','IDLE',1), ('pane:taskruns03','room:taskruns01','Claude','Cody','TERMINAL','IDLE',2),
      ('pane:taskruns04','room:taskruns01','Claude','Dana','TERMINAL','IDLE',3), ('pane:taskruns05','room:taskruns01','Claude','Eva','TERMINAL','IDLE',4)`);
    const once = { recurrence: { kind: "ONCE" as const, at: "2030-06-01T10:00:00.000Z" }, timeZone: "UTC" };
    const typed = async (title: string, source: "AGENT" | "MANUAL", paneId: string, schedule: typeof once | { recurrence: { kind: "INTERVAL"; minutes: number }; timeZone: string } = once) => {
      const task = await store.upsertTaskItem({ ownerUserId: owner, title, objective: `${title}.`, status: "OPEN", source, paneId, roomId: "room:taskruns01", schedule });
      const due = (await store.getTaskItem(owner, task.id))!.schedule!.nextRunAt!;
      const next = schedule.recurrence.kind === "ONCE" ? null : "2030-01-01T00:00:00.000Z";
      expect(await store.claimTaskSchedule(task.id, due, { nextRunAt: next, outcome: "Sent to the CLI.", status: "RUNNING", at: "2026-11-01T10:00:10.000Z" })).toBe(true);
      return task.id;
    };
    const agentOnce = await typed("Agent once", "AGENT", "pane:taskruns02");
    const agentFailed = await typed("Agent once failed", "AGENT", "pane:taskruns03");
    const operatorOnce = await typed("Operator once", "MANUAL", "pane:taskruns04");
    const agentRecurring = await typed("Agent recurring", "AGENT", "pane:taskruns05", { recurrence: { kind: "INTERVAL", minutes: 120 }, timeZone: "UTC" });
    const report = (paneId: string, status: string) => store.noteTaskRunReport(owner, { paneId, at: "2026-11-01T10:05:00.000Z", status, summary: status });
    expect(await report("pane:taskruns02", "DONE")).toBe(true);
    expect(await report("pane:taskruns03", "FAILED")).toBe(true);
    expect(await report("pane:taskruns04", "DONE")).toBe(true);
    expect(await report("pane:taskruns05", "DONE")).toBe(true);
    const status = async (id: string) => (await store.getTaskItem(owner, id))!.status;
    expect([await status(agentOnce), await status(agentFailed), await status(operatorOnce), await status(agentRecurring)]).toEqual(["DONE", "OPEN", "OPEN", "OPEN"]);
    expect((await store.getTaskItem(owner, agentOnce))!.schedule).toMatchObject({ lastOutcome: "Sent to the CLI." });
  });

  it("keeps each owner's history period only (history.periodDays, 90 days unset) and lists only that period", async () => {
    const store = new PostgresSpaceStore(pool);
    await pool.query("INSERT INTO users(id, email, role) VALUES ('user:taskruns7', 'taskruns7@space.local', 'ADMIN')");
    await store.updateUserSettings("user:taskruns7", { history: { periodDays: 7 } });
    const add = (who: string, at: string) => pool.query(`INSERT INTO task_runs (owner_user_id, task_id, task_title, due_at, at, status, detail)
      VALUES ($1, 'task:prune', 'Prune', $2, $2, 'REMINDER', 'Reminder due.')`, [who, at]);
    await add("user:taskruns7", "2026-10-20T00:00:00Z");
    await add("user:taskruns7", "2026-10-28T00:00:00Z");
    await add(owner, "2026-08-01T00:00:00Z");
    await add(owner, "2026-08-10T00:00:00Z");
    expect((await store.listTaskRuns("user:taskruns7", { limit: 100, since: "2026-10-25T00:00:00.000Z" })).counts.REMINDER).toBe(1);
    expect(await store.pruneTaskRuns("2026-11-01T00:00:00.000Z")).toBe(2);
    const left = await pool.query<{ owner_user_id: string; at: Date }>("SELECT owner_user_id, at FROM task_runs WHERE task_id = 'task:prune' ORDER BY at");
    expect(left.rows.map((row) => [row.owner_user_id, row.at.toISOString()])).toEqual([[owner, "2026-08-10T00:00:00.000Z"], ["user:taskruns7", "2026-10-28T00:00:00.000Z"]]);
  });

  it("marks when a schedule began to apply: a pause clears it, the restore and a reopen set it, a time change or an upsert keeps it (Score 13/11)", async () => {
    const store = new PostgresSpaceStore(pool);
    const daily = (time: string) => ({ recurrence: { kind: "DAILY" as const, time }, timeZone: "Asia/Bangkok" });
    const fields = { ownerUserId: owner, title: "Daily scan", objective: "Scan.", status: "OPEN" as const, source: "AGENT" as const, paneId: "pane:taskruns01", roomId: "room:taskruns01" };
    const task = await store.upsertTaskItem({ ...fields, schedule: daily("09:00") });
    expect(task.schedule?.scheduledSince).toBeUndefined(); // since it was made
    expect((await store.updateTaskItem(owner, task.id, { schedule: null })).schedule).toBeNull();
    const before = Date.now();
    const since = (await store.updateTaskItem(owner, task.id, { schedule: daily("09:00") })).schedule?.scheduledSince;
    expect(Date.parse(since!)).toBeGreaterThanOrEqual(before - 1_000);
    expect((await store.updateTaskItem(owner, task.id, { schedule: daily("09:20") })).schedule?.scheduledSince).toBe(since);
    expect((await store.upsertTaskItem({ ...fields, schedule: daily("09:30") })).schedule?.scheduledSince).toBe(since);
    expect((await store.updateTaskItem(owner, task.id, { status: "DONE" })).schedule).toMatchObject({ nextRunAt: null });
    expect((await store.getTaskItem(owner, task.id))!.schedule?.scheduledSince).toBeUndefined();
    expect(Date.parse((await store.upsertTaskItem({ ...fields, schedule: daily("09:30") })).schedule!.scheduledSince!)).toBeGreaterThanOrEqual(Date.parse(since!));
  });

  it("0326 backfills when a schedule restored before 0324 began to apply, from the pane's audited clear and set (Daily tasks 13/11)", async () => {
    const store = new PostgresSpaceStore(pool);
    const fields = { ownerUserId: owner, status: "OPEN" as const, source: "AGENT" as const, paneId: "pane:taskruns01", roomId: "room:taskruns01",
      schedule: { recurrence: { kind: "DAILY" as const, time: "11:10" }, timeZone: "UTC" } };
    const [restored, neverPaused, alreadySet] = await Promise.all(["X session 11:10", "X report 22:40", "Reddit 12:10"].map((title) => store.upsertTaskItem({ ...fields, title, objective: title })));
    await pool.query("UPDATE task_items SET scheduled_since = CASE WHEN id = $1 THEN '2026-11-13T03:00:00Z'::timestamptz END WHERE id = ANY($2)", [alreadySet.id, [restored.id, neverPaused.id, alreadySet.id]]);
    const audit = (target: string, at: string, schedule: boolean) => pool.query(`INSERT INTO audit_events(id, trace_id, action, target_type, target_id, metadata, created_at)
      VALUES ($1, 'trace:backfill', 'task.agent.update', 'task_item', $2, $3, $4)`, [`audit:${target}:${at}`, target, JSON.stringify({ schedule }), at]);
    for (const target of [restored.id, alreadySet.id]) {
      await audit(target, "2026-11-09T14:00:00Z", true);
      await audit(target, "2026-11-09T15:07:01Z", false); // the Azure pause
      await audit(target, "2026-11-12T14:23:00Z", true); // the restore
      await audit(target, "2026-11-12T15:26:00Z", true); // a later time change keeps it
    }
    await audit(neverPaused.id, "2026-11-12T14:23:00Z", true);
    const migration = (await loadMigrations()).find((entry) => entry.filename.startsWith("0326_"))!;
    await pool.query(migration.sql);
    const since = async (id: string) => (await store.getTaskItem(owner, id))!.schedule?.scheduledSince;
    expect(await since(restored.id)).toBe("2026-11-12T14:23:00.000Z");
    expect(await since(neverPaused.id)).toBeUndefined(); // never cleared: createdAt stays right
    expect(await since(alreadySet.id)).toBe("2026-11-13T03:00:00.000Z");
  });

  it("0331 backfills a restore no audit saw from the first run after the pane's audited clear (Daily tasks 13/11)", async () => {
    const store = new PostgresSpaceStore(pool);
    const fields = { ownerUserId: owner, status: "OPEN" as const, source: "AGENT" as const, paneId: "pane:taskruns01", roomId: "room:taskruns01",
      schedule: { recurrence: { kind: "DAILY" as const, time: "02:00" }, timeZone: "UTC" } };
    const [restored, nousPaused, notRunYet, alreadySet] = await Promise.all(["Mail round 1/3", "Temporal rustls", "Upwork scan", "Grants re-measure"]
      .map((title) => store.upsertTaskItem({ ...fields, title, objective: title })));
    const ids = [restored.id, nousPaused.id, notRunYet.id, alreadySet.id];
    await pool.query("UPDATE task_items SET scheduled_since = CASE WHEN id = $1 THEN '2026-11-13T03:00:00Z'::timestamptz END WHERE id = ANY($2)", [alreadySet.id, ids]);
    for (const target of [restored.id, notRunYet.id, alreadySet.id]) await pool.query(`INSERT INTO audit_events(id, trace_id, action, target_type, target_id, metadata, created_at)
      VALUES ('audit:0331:' || $1, 'trace:backfill0331', 'task.agent.update', 'task_item', $1, '{"schedule":false}', '2026-11-09T15:07:01Z')`, [target]); // the Azure pause
    const run = (task: string, due: string) => pool.query(`INSERT INTO task_runs(owner_user_id, task_id, task_title, due_at, at, status, typed, detail)
      VALUES ($1, $2, 'x', $3, $3::timestamptz + interval '5 seconds', 'RUNNING', true, 'Sent to the CLI.')`, [owner, task, due]);
    for (const task of [restored.id, nousPaused.id, notRunYet.id, alreadySet.id]) await run(task, "2026-11-09T02:00:00Z"); // before the pause
    for (const task of [restored.id, nousPaused.id, alreadySet.id]) for (const due of ["2026-11-14T02:00:00Z", "2026-11-13T02:00:00Z"]) await run(task, due);
    await pool.query((await loadMigrations()).find((entry) => entry.filename.startsWith("0331_"))!.sql);
    const since = async (id: string) => (await store.getTaskItem(owner, id))!.schedule?.scheduledSince;
    expect(await since(restored.id)).toBe("2026-11-13T02:00:00.000Z");
    expect(await since(nousPaused.id)).toBeUndefined(); // no audited clear to anchor on
    expect(await since(notRunYet.id)).toBeUndefined();
    expect(await since(alreadySet.id)).toBe("2026-11-13T03:00:00.000Z");
  });

  it("a changed objective re-keys the task so a rebind moves it, and 0327 re-keys rows an older change left stale (Temu 12/11)", async () => {
    const store = new PostgresSpaceStore(pool);
    const fields = { ownerUserId: owner, status: "OPEN" as const, source: "AGENT" as const, roomId: "room:taskruns01",
      schedule: { recurrence: { kind: "DAILY" as const, time: "02:00" }, timeZone: "UTC" } };
    const task = await store.upsertTaskItem({ ...fields, title: "Temu watch", objective: "Temu v1", paneId: "pane:taskruns01" });
    await store.updateTaskItem(owner, task.id, { objective: "Temu v2" });
    const moved = await store.upsertTaskItem({ ownerUserId: owner, title: "Temu watch", objective: "Temu v2", status: "OPEN", source: "AGENT", roomId: "room:taskruns01", paneId: null });
    expect(moved).toMatchObject({ id: task.id, paneId: null, schedule: { recurrence: { kind: "DAILY", time: "02:00" } } });
    const other = await store.upsertTaskItem({ ...fields, title: "Other", objective: "Other" });
    await expect(store.updateTaskItem(owner, other.id, { objective: "Temu v2" })).rejects.toThrow("Another task already has this exact objective.");

    const [stale, dupOld, dupScheduled, held, shadow] = await Promise.all(["Stale", "Dup old", "Dup scheduled", "Held", "Shadow"]
      .map((title) => store.upsertTaskItem({ ...fields, title, objective: title, ...(title === "Dup old" ? { schedule: null } : {}) })));
    // What updateTaskItem left before this fix: a new objective under the old hash.
    await pool.query("UPDATE task_items SET objective = CASE id WHEN $1 THEN 'Stale v2' WHEN $4 THEN 'Held' ELSE 'Dup' END, character_count = char_length(CASE id WHEN $1 THEN 'Stale v2' WHEN $4 THEN 'Held' ELSE 'Dup' END) WHERE id = ANY(ARRAY[$1, $2, $3, $4])",
      [stale.id, dupOld.id, dupScheduled.id, shadow.id]);
    await pool.query((await loadMigrations()).find((entry) => entry.filename.startsWith("0327_"))!.sql);
    const hashOf = async (id: string) => (await pool.query<{ content_hash: string }>("SELECT content_hash FROM task_items WHERE id = $1", [id])).rows[0]!.content_hash;
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(await hashOf(stale.id)).toBe(sha("Stale v2"));
    expect([await hashOf(dupScheduled.id), await hashOf(dupOld.id)]).toEqual([sha("Dup"), sha("Dup old")]); // one per objective, the scheduled one
    expect([await hashOf(held.id), await hashOf(shadow.id)]).toEqual([sha("Held"), sha("Shadow")]); // another row holds it: no merge
  });
});
