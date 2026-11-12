// Goal 7365014c-b: the operator's answers in every copilot rail, counted on a real, disposable PostgreSQL. Skips without Docker.
import type pg from "pg";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countRailDecisions, listRailDecisions } from "../src/rail-decision-counts.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

describe.skipIf(unavailable !== null)(`Rail decision counts on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let event: (table: string, id: string, who: string, type: string, message: string, payload: object, at?: string) => Promise<unknown>;

  beforeAll(async () => {
    server = await startDisposablePostgres("rail-decision-counts");
    await server.createDatabase("space_rail_decision_counts");
    pool = server.pool("space_rail_decision_counts", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    for (const [id, email] of [[owner, "nous@space.local"], ["user:other", "other@space.local"]]) await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [id, email]);
    await pool.query(`INSERT INTO rooms(id,name,trace_id,owner_user_id) VALUES ('room:rail0001','Rail','trace:rail0001','${owner}');
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('pane:sec00001','room:rail0001','Security','TERMINAL','IDLE',0)`);
    event = (table, id, who, type, message, payload, at = "2026-10-27T10:00:00Z") =>
      pool.query(`INSERT INTO ${table}(id, owner_user_id, type, message, payload, created_at${table === "security_copilot_events" ? ", pane_id" : ""})
        VALUES ($1, $2, $3, $4, $5::jsonb, $6${table === "security_copilot_events" ? ", 'pane:sec00001'" : ""})`, [id, who, type, message, JSON.stringify(payload), at]);
    await event("mail_copilot_events", "mailevt:review0001", owner, "REVIEW_DECIDED", "You approved the reply; it was sent", { decision: "approve" });
    await event("mail_copilot_events", "mailevt:review0002", owner, "REVIEW_DECIDED", "You edited the reply; your version was sent", { decision: "edit" });
    await event("mail_copilot_events", "mailevt:review0003", owner, "REVIEW_DECIDED", "You approved the reply; it was sent", { decision: "approve" }, "2026-10-25T10:00:00Z");
    // 12/11 (goal 7365014c): a reject Nous's decision ran, its reason Nous's words, is no operator answer.
    await event("mail_copilot_events", "mailevt:review0004", owner, "REVIEW_DECIDED", "You rejected the reply: Duplicate: mailrev:abc was approved and SENT", { decision: "reject", by: "nous" });
    await event("mail_copilot_events", "mailevt:drafted001", owner, "DRAFTED", "Drafted", {});
    await event("marketing_copilot_events", "mktevt:review0001", owner, "REVIEW_DECIDED", "You approved the X post", { decision: "approve" });
    await event("marketing_copilot_events", "mktevt:review0002", owner, "REVIEW_DECIDED", "You rejected the X post", { decision: "reject" });
    // USQ6 step 4: a needs-you card's click is its own NEEDS_YOU ledger row, the Security rail counts too.
    await event("marketing_copilot_events", "mktevt:review0003", owner, "REVIEW_DECIDED", "You approved the LinkedIn post", { decision: "approve", by: "card" });
    await event("security_copilot_events", "secevt:review0001", owner, "REVIEWED", "You approved the change", { reviewId: "secrev:1", decision: "approve" });
    await event("freelance_copilot_events", "flevt:answer0001", owner, "ANSWERED", "Nous answered: yes", { questionId: "q1" });
    await event("job_apply_events", "jobevt:answer0001", owner, "ANSWERED", "You answered: 10260", {});
    await event("job_apply_events", "jobevt:other00001", "user:other", "REVIEW_DECIDED", "You approved the submission", { decision: "approve" });
    await pool.query(`INSERT INTO space_notifications(id, owner_user_id, source, kind, severity, title, status, payload) VALUES
      ('notification:ny0001', $1, 'AGENT', 'NEEDS_YOU', 'ATTENTION', 'Bob needs you', 'ACKED', $2::jsonb),
      ('notification:ny0002', $1, 'AGENT', 'NEEDS_YOU', 'ATTENTION', 'Bob needs you', 'OPEN', '{}'::jsonb)`,
    [owner, JSON.stringify({ answer: { text: "A", at: "2026-10-27T11:00:00.000Z", routed: "PANE" } })]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("counts the owner's answers per rail, type and decision since the given time, a question's answer by who answered it", async () => {
    expect(await countRailDecisions(pool, owner, "2026-10-26T12:00:00Z")).toEqual([
      { source: "Freelance Copilot", type: "ANSWERED", decision: "Nous", count: 1 },
      { source: "Job Copilot", type: "ANSWERED", decision: "answered", count: 1 },
      { source: "Mail Copilot", type: "REVIEW_DECIDED", decision: "approve", count: 1 },
      { source: "Mail Copilot", type: "REVIEW_DECIDED", decision: "edit", count: 1 },
      { source: "Mail Copilot", type: "REVIEW_DECIDED", decision: "Nous", count: 1 },
      { source: "Marketing Copilot", type: "REVIEW_DECIDED", decision: "approve", count: 2 },
      { source: "Marketing Copilot", type: "REVIEW_DECIDED", decision: "reject", count: 1 },
      { source: "Needs you", type: "AGENT", decision: "answered", count: 1 },
      { source: "Security Copilot", type: "REVIEWED", decision: "approve", count: 1 }
    ]);
    expect(await countRailDecisions(pool, "user:other", "2026-10-28T00:00:00Z")).toEqual([]);
  });

  it("lists the owner's own rail answers for the decision ledger, Nous's answers and decisions left out (R11-3)", async () => {
    expect((await listRailDecisions(pool, owner, "2026-10-26T12:00:00Z")).map(({ source, id, type, decision, title }) => [source, id, type, decision, title])).toEqual([
      ["Job Copilot", "jobevt:answer0001", "ANSWERED", "answered", "You answered: 10260"],
      ["Mail Copilot", "mailevt:review0001", "REVIEW_DECIDED", "approve", "You approved the reply; it was sent"],
      ["Mail Copilot", "mailevt:review0002", "REVIEW_DECIDED", "edit", "You edited the reply; your version was sent"],
      ["Marketing Copilot", "mktevt:review0001", "REVIEW_DECIDED", "approve", "You approved the X post"],
      ["Marketing Copilot", "mktevt:review0002", "REVIEW_DECIDED", "reject", "You rejected the X post"],
      ["Security Copilot", "secevt:review0001", "REVIEWED", "approve", "You approved the change"]
    ]);
  });

  it("0323 marks the rail decisions a Nous decision ran and removes their RAIL ledger rows (USQ6 step 4)", async () => {
    await pool.query(`INSERT INTO nous_decisions(id, owner_user_id, category, title, body, action, status, created_at, answered_at) VALUES
      ('nousdec:run1', $1, 'DIRECTION', 'Reject', 'b', '{"type":"COPILOT","copilot":"MAIL","item":"REVIEW","itemId":"mailrev:n1","decision":"reject"}', 'APPROVED', '2026-11-12T06:00:00Z', '2026-11-12T06:00:00Z'),
      ('nousdec:run2', $1, 'DIRECTION', 'Post', 'b', '{"type":"COPILOT","copilot":"MARKETING","item":"REVIEW","itemId":"mktpost:nous0001","decision":"approve"}', 'APPROVED', '2026-11-12T15:00:00Z', NULL)`, [owner]);
    await event("mail_copilot_events", "mailevt:nousrun01", owner, "REVIEW_DECIDED", "You rejected the reply", { reviewId: "mailrev:n1", decision: "reject" }, "2026-11-12T06:48:00Z");
    await event("mail_copilot_events", "mailevt:later0001", owner, "REVIEW_DECIDED", "You rejected the reply", { reviewId: "mailrev:n1", decision: "reject" }, "2026-11-12T09:00:00Z");
    await event("marketing_copilot_events", "mktevt:nousrun01", owner, "REVIEW_DECIDED", "You approved the X post", { decision: "approve" }, "2026-11-12T15:14:00Z");
    await pool.query("UPDATE marketing_copilot_events SET post_id = 'mktpost:nous0001' WHERE id = 'mktevt:nousrun01'");
    for (const ref of ["Mail Copilot:mailevt:nousrun01", "Marketing Copilot:mktevt:nousrun01", "Mail Copilot:mailevt:later0001"])
      await pool.query("INSERT INTO nous_decision_ledger(owner_user_id, source, kind, title, answer, ref) VALUES ($1, $2, 'REVIEW_DECIDED', 't', 'reject', $3)", [owner, `RAIL:${ref.split(":")[0]}`, ref]);
    await pool.query(await readFile(new URL("../migrations/0323_rail_events_run_by_nous.sql", import.meta.url), "utf8"));
    expect((await listRailDecisions(pool, owner, "2026-11-12T00:00:00Z")).map((row) => row.id)).toEqual(["mailevt:later0001"]);
    expect((await pool.query("SELECT ref FROM nous_decision_ledger WHERE owner_user_id = $1 ORDER BY ref", [owner])).rows.map((row) => row.ref)).toEqual(["Mail Copilot:mailevt:later0001"]);
  });
});
