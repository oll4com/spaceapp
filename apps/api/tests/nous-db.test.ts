// Nous reads Space's own database (operator order 2026-10-24): one read per call, never a write, secrets hidden.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbFailureLines } from "../src/nous/daily-review.js";
import { createNousTools, nousDbFailureMeta, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";
import { nousDbCastQuery, nousDbTextCastQuery, nousDbCorrectedQuery, nousDbQualifiedQuery, createNousDb, NOUS_DB_COLUMN_NOTES, NOUS_DB_GUESSED_TABLES, NOUS_DB_TABLE_USE, nousDbFlagNote, NOUS_DB_COMMON_TABLES, nousDbColumnsText, nousDbNearestTables, nousDbRows, nousDbStatement, nousDbSyntaxLine } from "../src/nous/db.js";
import { applyPendingMigrations } from "../../../packages/db/src/migration-runner.js";
import { loadMigrations } from "../../../packages/db/src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../../packages/db/tests/support/disposable-postgres.js";

describe("space_db_query statements", () => {
  it("wraps reads in a row limit, keeps EXPLAIN and SHOW, and refuses writes and side-effect calls", () => {
    expect(nousDbStatement({ sql: "select id from panes;", limit: 5 })).toEqual({ text: "SELECT * FROM (\nselect id from panes\n) AS nous_query LIMIT 6", limit: 5 });
    expect(nousDbStatement({ sql: "EXPLAIN SELECT 1" }).text).toBe("EXPLAIN SELECT 1");
    expect(() => nousDbStatement({ sql: "DELETE FROM panes" })).toThrow("reads only");
    // Queue item 45a: a leading comment is dropped, not refused; one that hides a write still fails.
    expect(nousDbStatement({ sql: "-- panes of Cleo\n/* newest */ SELECT id FROM panes" }).text).toBe("SELECT * FROM (\nSELECT id FROM panes\n) AS nous_query LIMIT 101");
    expect(() => nousDbStatement({ sql: "/* hi */ DELETE FROM panes" })).toThrow("reads only");
    expect(() => nousDbStatement({ sql: "/* a /* nested */ */ SELECT 1" })).toThrow("reads only");
    // R19-2 (29/10: 3 reads failed at ";"): a final ; with a comment after it, or doubled, is dropped too; one inside stays (two statements).
    expect(nousDbStatement({ sql: "SELECT id FROM panes; -- open ones\n" }).text).toBe("SELECT * FROM (\nSELECT id FROM panes\n) AS nous_query LIMIT 101");
    expect(nousDbStatement({ sql: "SELECT id FROM panes;;" }).text).toBe("SELECT * FROM (\nSELECT id FROM panes\n) AS nous_query LIMIT 101");
    // Goal 401b115b (9/11): a block comment or a zero-width character after the final ; too.
    expect(nousDbStatement({ sql: "SHOW search_path; /* done */\u200b\n" }).text).toBe("SHOW search_path");
    expect(() => nousDbStatement({ sql: "SELECT 1; /* then */ SELECT 2" })).toThrow("one statement per call");
    // R59 (2026-11-04 REVIEW: 6 of 24 failed reads were ";" syntax): a ; inside the text is refused before PostgreSQL, one inside a
    // string, quoted name, dollar quote or comment is no statement end.
    expect(() => nousDbStatement({ sql: "SELECT 1; SELECT 2" })).toThrow("space_db_query reads only one statement per call");
    expect(nousDbFailureMeta("space_db_query reads only one statement per call: …")).toEqual({ dbCode: "REFUSED" });
    expect(nousDbStatement({ sql: `SELECT ';' AS a, ";" FROM panes WHERE x = 'it''s; fine' -- a; b\n AND $q$c;d$q$ <> '' /* e; f */;` }).text)
      .toContain(`SELECT ';' AS a, ";" FROM panes WHERE x = 'it''s; fine' -- a; b\n AND $q$c;d$q$ <> '' /* e; f */\n)`);
    expect(() => nousDbStatement({ sql: "SELECT pg_terminate_backend(42)" })).toThrow("only reads");
    expect(() => nousDbStatement({ sql: "select set_config('statement_timeout', '0', false)" })).toThrow("only reads");
  });

  it("R78 (5/11, Nous's transcripts): reads a query in parentheses, corrects that day's column guesses and names a plan's JSON columns", () => {
    expect(nousDbStatement({ sql: "(SELECT a FROM x) UNION ALL (SELECT b FROM y) ORDER BY 1", limit: 5 }).text)
      .toBe("SELECT * FROM (\n(SELECT a FROM x) UNION ALL (SELECT b FROM y) ORDER BY 1\n) AS nous_query LIMIT 6");
    expect(() => nousDbStatement({ sql: "(DELETE FROM panes)" })).toThrow("reads only");
    const columns = new Map([["nous_turn_facts", ["turn_id", "reason", "started_at"]], ["task_items", ["id", "recurrence"]], ["nous_score_snapshots", ["at", "score", "parts"]]]);
    for (const [sql, column, fixed] of [["SELECT kind FROM nous_turn_facts", "kind", "SELECT reason FROM nous_turn_facts"],
      ["SELECT schedule_json FROM task_items", "schedule_json", "SELECT recurrence FROM task_items"],
      ["SELECT taken_at FROM nous_score_snapshots", "taken_at", "SELECT at FROM nous_score_snapshots"],
      ["SELECT payload FROM nous_score_snapshots", "payload", "SELECT parts FROM nous_score_snapshots"]]) {
      expect(nousDbCorrectedQuery(sql!, `column "${column}" does not exist`, undefined, columns)?.sql).toBe(fixed);
    }
    expect(NOUS_DB_COLUMN_NOTES.clipboard_items!.metadata).toContain("waits_on_json");
  });

  it("tool error samples (8/11): a guessed is_* flag names the table's real state columns, user_settings its settings JSON", () => {
    expect(nousDbFlagNote("rooms", "is_active", ["id", "status", "archived_at"]))
      .toEqual(["rooms has no is_active flag: its state is status (SELECT DISTINCT status FROM rooms lists its values) or archived_at (NULL while it has not happened)."]);
    expect(nousDbFlagNote("notes", "is_active", ["id", "text"])).toEqual([]);
    expect(NOUS_DB_COLUMN_NOTES.user_settings!.key).toContain("jsonb_object_keys(settings)");
  });

  it("R83 (7 d to 8/11): corrects the column guesses still failing after R78", () => {
    const columns = new Map([["nous_notes", ["id", "text"]], ["space_gateway_request_logs", ["id", "api_key_id", "status", "error_code"]],
      ["space_gateway_accounts", ["account_id", "provider", "label", "status"]], ["nous_pane_summaries", ["pane_id", "generated_at"]],
      ["security_copilot_findings", ["id", "priority"]], ["user_settings", ["user_id", "settings"]]]);
    for (const [sql, column, fixed] of [["SELECT content FROM nous_notes", "content", "SELECT text FROM nous_notes"],
      ["SELECT status_code FROM space_gateway_request_logs", "status_code", "SELECT status FROM space_gateway_request_logs"],
      ["SELECT key_id FROM space_gateway_request_logs", "key_id", "SELECT api_key_id FROM space_gateway_request_logs"],
      ["SELECT name FROM space_gateway_accounts", "name", "SELECT label FROM space_gateway_accounts"],
      ["SELECT updated_at FROM nous_pane_summaries", "updated_at", "SELECT generated_at FROM nous_pane_summaries"],
      ["SELECT severity FROM security_copilot_findings", "severity", "SELECT priority FROM security_copilot_findings"],
      ["SELECT value FROM user_settings", "value", "SELECT settings FROM user_settings"]]) {
      expect(nousDbCorrectedQuery(sql!, `column "${column}" does not exist`, undefined, columns)?.sql).toBe(fixed);
    }
  });

  it("9/11 REVIEW: a pane's type is its mode, and auth_sessions and pg_stat_statements say where their data is", () => {
    expect(nousDbCorrectedQuery("SELECT p.type FROM panes p", 'column p.type does not exist', undefined, new Map([["panes", ["id", "mode", "is_closed"]]]))?.sql)
      .toBe("SELECT p.mode FROM panes p");
    expect(NOUS_DB_TABLE_USE.auth_sessions).toContain("audit_events");
    expect(NOUS_DB_GUESSED_TABLES).toContain("no pg_stat_statements (the extension is not installed");
  });

  it("shows rows as JSON lines, hides secret-named columns and says when more rows exist", () => {
    const text = nousDbRows(["id", "password_hash", "created_at"], [["u1", "argon2…", new Date("2026-10-24T00:00:00.000Z")], ["u2", null, null]], 1);
    expect(text).toBe('1 row (more exist: raise limit or narrow the query); columns: id, password_hash, created_at\n{"id":"u1","password_hash":"[hidden]","created_at":"2026-10-24T00:00:00.000Z"}');
  });

  it("ranks the nearest table names by shared name parts", () => {
    expect(nousDbNearestTables("nous_turns", ["panes", "nous_turn_facts", "nous_messages", "turn_log"])).toEqual(["nous_turn_facts", "turn_log", "nous_messages"]);
    expect(nousDbNearestTables("xyz", ["panes"])).toEqual([]);
    expect(nousDbNearestTables("cli_sessions", ["panes", "pane_agent_sessions", "pane_cli_sessions", "session_revocations"])[0]).toBe("pane_cli_sessions");
  });

  it("casts a json argument of a text function to text in the corrected query (R12-8)", () => {
    // 7 days to 29/10: 4 reads failed "function left(jsonb, integer) does not exist".
    expect(nousDbCastQuery("SELECT id, left(payload, 80) FROM nous_messages WHERE LEFT(meta->'a', 3) = 'x'", "function left(jsonb, integer) does not exist"))
      .toBe("SELECT id, left((payload)::text, 80) FROM nous_messages WHERE LEFT((meta->'a')::text, 3) = 'x'");
    expect(nousDbCastQuery("SELECT left(name, 'x') FROM notes", "function left(text, unknown) does not exist")).toBeNull();
    expect(nousDbCastQuery("SELECT 1", "function left(jsonb, integer) does not exist")).toBeNull();
  });

  it("reads a json number in a numeric function as a number, and casts a json operand of LIKE/ILIKE to text (R25)", () => {
    // 7 days to 1/11: "function avg(jsonb) does not exist" was answered with avg((cost_usd)::text), which fails too.
    expect(nousDbCastQuery("SELECT round(avg(cost_usd)::numeric, 2) FROM nous_turn_facts", "function avg(jsonb) does not exist"))
      .toBe("SELECT round(avg((to_jsonb(cost_usd)#>>'{}')::numeric)::numeric, 2) FROM nous_turn_facts");
    // 29-31/10, 3 reads: "operator does not exist: jsonb ~~* unknown", and PostgreSQL's position is the word ILIKE.
    const like = "SELECT id FROM nous_messages WHERE meta ILIKE '%mail%'";
    expect(nousDbTextCastQuery(like, "operator does not exist: jsonb ~~* unknown", like.indexOf("ILIKE")))
      .toBe("SELECT id FROM nous_messages WHERE (meta)::text ILIKE ('%mail%')::text");
  });

  it("takes each table's own synonym, casts operator and UNION mismatches to text, and marks a corrected read on its row (R13-1)", async () => {
    const columns = new Map([["pane_reports", ["id", "pane_id", "at", "status"]], ["nous_turn_facts", ["turn_id", "status", "started_at", "ended_at"]],
      ["space_gateway_api_keys", ["key_id", "name"]], ["nous_goals", ["id", "text", "status"]], ["job_applications", ["id", "company", "role"]]]);
    // R19-2: a goal's title is its text; a job application's is still its role.
    expect(nousDbCorrectedQuery("SELECT g.title FROM nous_goals g", "column g.title does not exist", undefined, columns)?.sql).toBe("SELECT g.text FROM nous_goals g");
    expect(nousDbCorrectedQuery("SELECT title FROM job_applications", 'column "title" does not exist', undefined, columns)?.sql).toBe("SELECT role FROM job_applications");
    // R20-2 (48 h to 30/10: title guessed on tables that have a name or subject; nous_followups.at and .fire_at, whose time is due_at).
    const more = new Map([["space_gateway_api_keys", ["key_id", "name"]], ["mail_copilot_reviews_x", ["id", "subject", "text"]], ["nous_followups", ["id", "note", "due_at", "created_at"]],
      ["task_items", ["id", "title", "next_run_at"]]]);
    expect(nousDbCorrectedQuery("SELECT title FROM space_gateway_api_keys", 'column "title" does not exist', undefined, more)?.sql).toBe("SELECT name FROM space_gateway_api_keys");
    expect(nousDbCorrectedQuery("SELECT title FROM mail_copilot_reviews_x", 'column "title" does not exist', undefined, more)?.sql).toBe("SELECT subject FROM mail_copilot_reviews_x");
    expect(nousDbCorrectedQuery("SELECT f.fire_at FROM nous_followups f", "column f.fire_at does not exist", undefined, more)?.sql).toBe("SELECT f.due_at FROM nous_followups f");
    expect(nousDbCorrectedQuery("SELECT at FROM nous_followups", 'column "at" does not exist', undefined, more)?.sql).toBe("SELECT due_at FROM nous_followups");
    expect(nousDbCorrectedQuery("SELECT fire_at FROM task_items", 'column "fire_at" does not exist', undefined, more)?.sql).toBe("SELECT next_run_at FROM task_items");
    // R74 (2026-11-05 REVIEW): a task's schedule is its recurrence.
    expect(nousDbCorrectedQuery("SELECT schedule FROM task_items", 'column "schedule" does not exist', undefined, new Map([["task_items", ["id", "recurrence", "next_run_at"]]]))?.sql)
      .toBe("SELECT recurrence FROM task_items");
    // Score 5/11: the guesses of 4/11 each read the column its table has.
    const guessed = new Map([["space_notifications", ["id", "title", "payload"]], ["audit_events", ["id", "action", "metadata"]],
      ["nous_score_snapshots", ["at", "score", "parts"]], ["job_applications", ["id", "status"]], ["cli_tasks", ["task_id", "created_at"]]]);
    for (const [sql, column, fixed] of [["SELECT metadata FROM space_notifications", "metadata", "SELECT payload FROM space_notifications"],
      ["SELECT detail FROM audit_events", "detail", "SELECT metadata FROM audit_events"], ["SELECT details FROM nous_score_snapshots", "details", "SELECT parts FROM nous_score_snapshots"],
      ["SELECT total FROM nous_score_snapshots", "total", "SELECT score FROM nous_score_snapshots"], ["SELECT stage FROM job_applications", "stage", "SELECT status FROM job_applications"],
      ["SELECT id FROM cli_tasks", "id", "SELECT task_id FROM cli_tasks"]]) {
      expect(nousDbCorrectedQuery(sql!, `column "${column}" does not exist`, undefined, guessed)?.sql).toBe(fixed);
    }
    // Two tables reading detail differently: no guess.
    expect(nousDbCorrectedQuery("SELECT detail FROM audit_events a JOIN space_notifications n ON n.id = a.target_id", 'column "detail" does not exist', undefined, guessed)).toBeNull();
    expect(nousDbCorrectedQuery("SELECT created_at FROM pane_reports", 'column "created_at" does not exist', undefined, columns)?.sql).toBe("SELECT at FROM pane_reports");
    expect(nousDbCorrectedQuery("SELECT f.created_at FROM nous_turn_facts f", "column f.created_at does not exist", undefined, columns)?.sql).toBe("SELECT f.started_at FROM nous_turn_facts f");
    expect(nousDbCorrectedQuery("SELECT id, name FROM space_gateway_api_keys", 'column "id" does not exist', undefined, columns)?.sql).toBe("SELECT key_id, name FROM space_gateway_api_keys");
    // Two tables, two different synonyms: no guess.
    expect(nousDbCorrectedQuery("SELECT created_at FROM pane_reports r JOIN nous_turn_facts f ON true", 'column "created_at" does not exist', undefined, columns)).toBeNull();
    const sql = "SELECT * FROM t WHERE t.meta->>'n' = 5";
    expect(nousDbTextCastQuery(sql, "operator does not exist: text = integer", sql.indexOf("="))).toBe("SELECT * FROM t WHERE (t.meta->>'n')::text = (5)::text");
    const union = "SELECT a, b FROM x UNION SELECT c, d FROM y";
    expect(nousDbTextCastQuery(union, "UNION types text and jsonb cannot be matched", union.indexOf("d FROM"))).toBe("SELECT a, (b)::text FROM x UNION SELECT c, (d)::text FROM y");
    expect(nousDbTextCastQuery(union, "something else", 3)).toBeNull();
    const tools = createNousTools({ db: { query: async () => "Space database: characters 0-90 of 90 (end).\n\nCorrected and run: SELECT at FROM pane_reports\n(PostgreSQL first said: column \"created_at\" does not exist (code 42703))\n0 rows; columns: at" } } as unknown as NousToolDeps);
    expect(await tools.execute("space_db_query", { sql: "SELECT created_at FROM pane_reports" }, { owner: "user:operator", turnId: "nous_turn:d", callId: "toolu_d", traceId: "trace:d" }))
      .toMatchObject({ ok: true, display: "Read the database (corrected query)", meta: { dbCorrected: { code: "42703", query: "SELECT at FROM pane_reports" } } });
  });

  it("corrects the one wrong column PostgreSQL reported when exactly one real column fits (R10-9)", () => {
    const columns = new Map([["pane_cli_sessions", ["session_id", "pane_id", "started_at", "updated_at", "ended_at"]], ["panes", ["id", "room_id", "is_closed"]],
      ["security_copilot_events", ["id", "type", "status"]], ["job_applications", ["id", "company", "role", "status"]]]);
    // 28/10: s.created_at and s.id on pane_cli_sessions, kind on *_copilot_events, title on job_applications.
    expect(nousDbCorrectedQuery("SELECT s.created_at, p.id FROM pane_cli_sessions s JOIN panes p ON p.id = s.pane_id", "column s.created_at does not exist", undefined, columns))
      .toEqual({ from: "s.created_at", to: "s.started_at", sql: "SELECT s.started_at, p.id FROM pane_cli_sessions s JOIN panes p ON p.id = s.pane_id" });
    expect(nousDbCorrectedQuery("SELECT s.id FROM pane_cli_sessions s", "column s.id does not exist", undefined, columns)?.sql).toBe("SELECT s.session_id FROM pane_cli_sessions s");
    expect(nousDbCorrectedQuery("SELECT kind, count(*) FROM security_copilot_events GROUP BY kind", 'column "kind" does not exist', undefined, columns)?.sql)
      .toBe("SELECT type, count(*) FROM security_copilot_events GROUP BY type");
    expect(nousDbCorrectedQuery("SELECT title FROM job_applications", 'column "title" does not exist', undefined, columns)?.to).toBe("role");
    // PostgreSQL's own hint wins; nothing fits: no guess.
    expect(nousDbCorrectedQuery("SELECT bodyy FROM notes", 'column "bodyy" does not exist', 'Perhaps you meant to reference the column "notes.body".', new Map([["notes", ["id", "body"]]]))?.sql)
      .toBe("SELECT body FROM notes");
    expect(nousDbCorrectedQuery("SELECT p.closed FROM panes p", "column p.closed does not exist", undefined, columns)?.to).toBe("p.is_closed");
    expect(nousDbCorrectedQuery("SELECT p.colour FROM panes p", "column p.colour does not exist", undefined, columns)).toBeNull();
    // 31/10 REVIEW: a plan's status, a pane's name, a turn's estimated cost.
    const more = new Map([["clipboard_items", ["id", "title", "execution_status"]], ["panes", ["id", "pane_name", "title"]], ["nous_turn_facts", ["turn_id", "cost_usd"]]]);
    expect(nousDbCorrectedQuery("SELECT c.status FROM clipboard_items c", "column c.status does not exist", undefined, more)?.sql).toBe("SELECT c.execution_status FROM clipboard_items c");
    expect(nousDbCorrectedQuery("SELECT name FROM panes", 'column "name" does not exist', undefined, more)?.to).toBe("pane_name");
    expect(nousDbCorrectedQuery("SELECT sum(estimated_cost_usd) FROM nous_turn_facts", 'column "estimated_cost_usd" does not exist', undefined, more)?.to).toBe("cost_usd");
    expect(nousToolDefinitions({ copilots: false }).find((tool) => tool.name === "space_db_query")?.description).toContain("no nous_held_texts (space_control_records with kind 'nous_held'), no vault_audit_events (vault_audit)");
    // 2026-11-02 REVIEW (22023 jsonb_array_elements on nous_turn_facts.tools, 42P01 job_copilot_events): both named in the description.
    const description = nousToolDefinitions({ copilots: false }).find((tool) => tool.name === "space_db_query")?.description;
    expect(description).toContain("its tools is an object {tool: {calls, failed, refused}} (jsonb_each, not jsonb_array_elements)");
    expect(description).toContain("no job_copilot_events (job_apply_events: type, message, payload)");
    // R55/R59 (2026-11-04 REVIEW, 42P01): the four tables guessed in 7 days, each with where its rows are.
    expect(description).toContain("no nous_request_done (space_notifications with kind 'REQUEST_DONE'");
    expect(description).toContain("no marketing_posts (marketing_copilot_posts)");
    expect(description).toContain("no space_control_schedules (space_control_records with kind 'schedule')");
    expect(description).toContain("no pane_prompt_queue (space_control_records with kind 'schedule' and value->>'condition' = 'AFTER_TURN'");
    // R74 (2026-11-05 REVIEW: tasks guessed twice on 4/11): Space tasks are task_items.
    expect(description).toContain("no tasks (task_items)");
    expect(description).toContain("nous_notes with key LIKE 'request-done:open:%' for open requests");
    expect(description).toContain("space_request_done reads and closes the open operator requests");
  });

  it("R25-1 (7 days to 1/11, 42703 the top class): PostgreSQL's hint for another alias never overrides the synonyms; payload and status by table", () => {
    const columns = new Map([["pane_cli_sessions", ["session_id", "pane_id", "started_at"]], ["panes", ["id", "room_id", "status", "created_at"]], ["rooms", ["id"]],
      ["nous_pane_closeouts", ["pane_id", "state", "closed_at"]], ["space_gateway_accounts", ["account_id", "provider", "created_at"]],
      ["space_gateway_request_logs", ["id", "account_id", "requested_at"]], ["space_control_records", ["kind", "record_key", "value", "updated_at"]]]);
    // The hints PostgreSQL gave on stable for these joins.
    expect(nousDbCorrectedQuery("SELECT s.created_at FROM pane_cli_sessions s JOIN panes p ON p.id = s.pane_id", "column s.created_at does not exist",
      'Perhaps you meant to reference the column "p.created_at".', columns)?.sql).toBe("SELECT s.started_at FROM pane_cli_sessions s JOIN panes p ON p.id = s.pane_id");
    expect(nousDbCorrectedQuery("SELECT s.id FROM pane_cli_sessions s JOIN panes p ON p.id = s.pane_id JOIN rooms r ON r.id = p.room_id", "column s.id does not exist",
      'Perhaps you meant to reference the column "p.id" or the column "r.id".', columns)?.to).toBe("s.session_id");
    expect(nousDbCorrectedQuery("SELECT c.status FROM nous_pane_closeouts c JOIN panes p ON p.id = c.pane_id", "column c.status does not exist",
      'Perhaps you meant to reference the column "p.status".', columns)?.to).toBe("c.state");
    expect(nousDbCorrectedQuery("SELECT l.created_at FROM space_gateway_request_logs l JOIN space_gateway_accounts a ON a.account_id = l.account_id", "column l.created_at does not exist",
      'Perhaps you meant to reference the column "a.created_at".', columns)?.to).toBe("l.requested_at");
    // 1/11 02:30: a.kind with the hint "l.id" became a.id, another column; nothing fits, so no guess.
    expect(nousDbCorrectedQuery("SELECT a.kind FROM space_gateway_accounts a JOIN space_gateway_request_logs l ON l.account_id = a.account_id", "column a.kind does not exist",
      'Perhaps you meant to reference the column "l.id".', columns)).toBeNull();
    // A hint for the same reference still wins.
    expect(nousDbCorrectedQuery("SELECT p.statuss FROM panes p", "column p.statuss does not exist", 'Perhaps you meant to reference the column "p.status".', columns)?.to).toBe("p.status");
    expect(nousDbCorrectedQuery("SELECT payload FROM space_control_records WHERE kind = 'nous_held'", 'column "payload" does not exist', undefined, columns)?.sql)
      .toBe("SELECT value FROM space_control_records WHERE kind = 'nous_held'");
  });

  it("R40-1 (48 h to 2/11: the 42703 guesses still failing on stable): payload on audit_events, text on posts and events, status inside a record's value", () => {
    const columns = new Map([["audit_events", ["id", "action", "metadata", "created_at"]], ["marketing_copilot_posts", ["id", "title", "body", "status"]],
      ["job_apply_events", ["id", "type", "message", "payload"]], ["space_control_records", ["kind", "record_key", "value", "updated_at"]]]);
    expect(nousDbCorrectedQuery("SELECT action, payload FROM audit_events", 'column "payload" does not exist', undefined, columns)?.to).toBe("metadata");
    expect(nousDbCorrectedQuery("SELECT id, text FROM marketing_copilot_posts", 'column "text" does not exist', undefined, columns)?.to).toBe("body");
    expect(nousDbCorrectedQuery("SELECT text FROM job_apply_events", 'column "text" does not exist', undefined, columns)?.to).toBe("message");
    expect(nousDbCorrectedQuery("SELECT record_key, status FROM space_control_records WHERE status = 'FAILED'", 'column "status" does not exist', undefined, columns)?.sql)
      .toBe("SELECT record_key, (value->>'status') FROM space_control_records WHERE (value->>'status') = 'FAILED'");
    // R46 (2026-11-03 REVIEW: 42703 on platform): the Freelance and Marketing copilots keep a lead's, post's or rule's platform as channel.
    const copilots = new Map([["freelance_copilot_leads", ["id", "channel", "status"]], ["marketing_copilot_posts", ["id", "channel", "status"]]]);
    expect(nousDbCorrectedQuery("SELECT platform, count(*) FROM freelance_copilot_leads GROUP BY platform", 'column "platform" does not exist', undefined, copilots)?.sql)
      .toBe("SELECT channel, count(*) FROM freelance_copilot_leads GROUP BY channel");
    expect(nousDbCorrectedQuery("SELECT p.platform FROM marketing_copilot_posts p", "column p.platform does not exist", undefined, copilots)?.to).toBe("p.channel");
  });

  it("R21-1 (24 h to 1/11, 42703 ×15): record_key, shared_at and event by table, an Agent File's name and folder in its metadata, and never a quoted word", () => {
    const columns = new Map([["space_control_records", ["kind", "actor_id", "record_key", "room_id", "value", "updated_at"]], ["nous_file_shares", ["id", "artifact_id", "shared_at"]],
      ["vault_audit", ["id", "event", "created_at"]], ["artifacts", ["id", "room_id", "kind", "metadata", "created_at"]]]);
    expect(nousDbCorrectedQuery("SELECT id, kind FROM space_control_records WHERE kind = 'nous_held'", 'column "id" does not exist', undefined, columns)?.sql)
      .toBe("SELECT record_key, kind FROM space_control_records WHERE kind = 'nous_held'");
    expect(nousDbCorrectedQuery("SELECT created_at FROM nous_file_shares", 'column "created_at" does not exist', undefined, columns)?.to).toBe("shared_at");
    expect(nousDbCorrectedQuery("SELECT action FROM vault_audit", 'column "action" does not exist', undefined, columns)?.to).toBe("(event->>'action')");
    expect(nousDbCorrectedQuery("SELECT id, title FROM artifacts WHERE metadata->>'name' IS NULL ORDER BY title", 'column "title" does not exist', undefined, columns)?.sql)
      .toBe("SELECT id, (metadata->>'originalFilename') FROM artifacts WHERE metadata->>'name' IS NULL ORDER BY (metadata->>'originalFilename')");
    expect(nousDbCorrectedQuery("SELECT a.collection FROM artifacts a", "column a.collection does not exist", undefined, columns)?.sql).toBe("SELECT (a.metadata->>'folder') FROM artifacts a");
    // A table that keeps no such metadata gets no path.
    expect(nousDbCorrectedQuery("SELECT collection FROM vault_audit", 'column "collection" does not exist', undefined, columns)).toBeNull();
    const description = nousToolDefinitions({ copilots: false }).find((tool) => tool.name === "space_db_query")?.description;
    expect(description).toContain("artifacts has no title, name or collection (an Agent File's name is metadata->>'originalFilename', its folder metadata->>'folder')");
    expect(description).toContain("space_control_records has record_key and updated_at (no id, created_at)");
    expect(description).toContain("nous_turn_facts has turn_id and cost_usd (no id, estimated_cost_usd)");
    expect(description).toContain("space_gateway_api_keys has key_id (no id)");
    // R70 (28/10-4/11, guesses Space corrected): the ledger's and goal events' at ×10, space_control_records payload ×5, job_apply_events status ×3.
    expect(description).toContain("nous_decision_ledger and nous_goal_events have at, nous_turn_facts started_at (no created_at)");
    expect(description).toContain("its item in value (no payload)");
  });

  it("R50 (7 d to 3/11: 33 of 126 failed reads still failing on the current code): ambiguous columns, three guessed names and table ties", () => {
    // 42702 ×7: Nous means the table it reads, the first in FROM/JOIN order that has the column; never inside a subquery or a string.
    expect(nousDbQualifiedQuery("SELECT at, status, summary FROM pane_reports pr JOIN panes p ON p.id=pr.pane_id WHERE p.pane_name='Andy' AND status <> 'status' ORDER BY at DESC", "status", "pr"))
      .toBe("SELECT at, pr.status, summary FROM pane_reports pr JOIN panes p ON p.id=pr.pane_id WHERE p.pane_name='Andy' AND pr.status <> 'status' ORDER BY at DESC");
    expect(nousDbQualifiedQuery("SELECT p.id AS id FROM panes p JOIN rooms r ON r.id = p.room_id", "id", "p")).toBeNull();
    expect(nousDbQualifiedQuery("SELECT id, body FROM space_notifications n, LATERAL (SELECT n.body) b", "body", "n")).toBeNull();
    // 42703: the guesses with a real counterpart (status in a job event's payload, a pane check's time, a key's id).
    const columns = new Map([["job_apply_events", ["id", "type", "message", "payload", "created_at"]], ["nous_pane_checks", ["owner_user_id", "pane_id", "checked_at", "verdict", "next_check_at"]],
      ["space_gateway_api_keys", ["key_id", "name", "key_prefix"]], ["space_gateway_request_logs", ["id", "api_key_id", "requested_at"]]]);
    expect(nousDbCorrectedQuery("SELECT type, status, message FROM job_apply_events WHERE status ILIKE '%OPEN%'", 'column "status" does not exist', undefined, columns)?.sql)
      .toBe("SELECT type, (payload->>'status'), message FROM job_apply_events WHERE (payload->>'status') ILIKE '%OPEN%'");
    expect(nousDbCorrectedQuery("SELECT c.* FROM nous_pane_checks c ORDER BY c.pane_id, c.created_at DESC", "column c.created_at does not exist", undefined, columns)?.to).toBe("c.checked_at");
    expect(nousDbCorrectedQuery("SELECT k.name FROM space_gateway_request_logs l LEFT JOIN space_gateway_api_keys k ON k.api_key_id=l.api_key_id", "column k.api_key_id does not exist", undefined, columns)?.sql)
      .toBe("SELECT k.name FROM space_gateway_request_logs l LEFT JOIN space_gateway_api_keys k ON k.key_id=l.api_key_id");
    // 42P01: a tie goes to the one table sharing the missing name's first part; a tie it does not break stays unswapped.
    expect(nousDbNearestTables("vault_audit_events", ["audit_events", "vault_audit", "vault_handoff_keys"], 2, true)).toEqual(["vault_audit"]);
    expect(nousDbNearestTables("job_copilot_events", ["mail_copilot_events", "job_apply_events", "security_copilot_events", "job_applications"], 2, true)).toEqual(["job_apply_events"]);
    expect(nousDbNearestTables("mail_copilot_reviews", ["mail_copilot_actions", "mail_copilot_events", "ab"], 2, true)).toHaveLength(2);
  });

  it("R50-1/R50-2 (48 h to 3/11): a record's JSON called data, and a trailing no-op SELECT 1", () => {
    const columns = new Map([["space_control_records", ["kind", "record_key", "value", "updated_at"]], ["job_apply_events", ["id", "type", "payload"]]]);
    expect(nousDbCorrectedQuery("SELECT r.record_key, r.data->>'text' FROM space_control_records r", "column r.data does not exist", undefined, columns)?.sql)
      .toBe("SELECT r.record_key, r.value->>'text' FROM space_control_records r");
    expect(nousDbCorrectedQuery("SELECT data FROM job_apply_events", 'column "data" does not exist', undefined, columns)?.to).toBe("payload");
    for (const sql of ["SELECT id,name FROM rooms WHERE archived_at IS NULL; SELECT 1", "SELECT id,name FROM rooms WHERE archived_at IS NULL;\nselect 1;"]) {
      expect(nousDbStatement({ sql }).text, sql).toBe("SELECT * FROM (\nSELECT id,name FROM rooms WHERE archived_at IS NULL\n) AS nous_query LIMIT 101");
    }
    expect(nousDbStatement({ sql: "SELECT 1" }).text).toContain("SELECT 1\n) AS nous_query");
    expect(() => nousDbStatement({ sql: "SELECT 1; SELECT 12" })).toThrow("one statement per call"); // R59: refused before PostgreSQL
  });

  it("R66 (3/11 23:43 UTC, after R60): a decision's result is its outcome", () => {
    const columns = new Map([["nous_decisions", ["id", "title", "status", "answer", "outcome", "created_at"]]]);
    expect(nousDbCorrectedQuery("SELECT id, left(coalesce(result::text,''),300) r FROM nous_decisions WHERE id = 'nous_decision:a'", 'column "result" does not exist', undefined, columns)?.sql)
      .toBe("SELECT id, left(coalesce(outcome::text,''),300) r FROM nous_decisions WHERE id = 'nous_decision:a'");
  });

  it("R52-1 (3/11 17:11 UTC): a table's own <name>_id is its id, never a column of another table", () => {
    const columns = new Map([["panes", ["id", "room_id", "pane_name", "provider_id"]], ["nous_decisions", ["id", "status"]], ["rooms", ["id", "name"]]]);
    expect(nousDbCorrectedQuery("SELECT c.pane_id, c.pane_name FROM panes c", "column c.pane_id does not exist", undefined, columns)?.sql).toBe("SELECT c.id, c.pane_name FROM panes c");
    expect(nousDbCorrectedQuery("SELECT decision_id FROM nous_decisions", 'column "decision_id" does not exist', undefined, columns)?.to).toBe("id");
    expect(nousDbCorrectedQuery("SELECT r.pane_id FROM rooms r", "column r.pane_id does not exist", undefined, columns)).toBeNull();
  });

  it("keeps a failed read's PostgreSQL code and guessed name on its tool row, and the REVIEW counts them by code (R11-2 (5))", async () => {
    expect(nousDbFailureMeta('Postgres: column s.created_at does not exist (code 42703)\nColumns of pane_cli_sessions: session_id')).toEqual({ dbCode: "42703", dbGuess: "s.created_at" });
    expect(nousDbFailureMeta('Postgres: relation "cli_sessions" does not exist (code 42P01)')).toEqual({ dbCode: "42P01", dbGuess: "cli_sessions" });
    expect(nousDbFailureMeta('Postgres: column reference "status" is ambiguous (code 42702)')).toEqual({ dbCode: "42702", dbGuess: "status" });
    expect(nousDbFailureMeta("Only one statement per call.")).toEqual({ dbCode: "other" });
    const tools = createNousTools({ db: { query: async () => { throw new Error('Postgres: column "kind" does not exist (code 42703)'); } } } as unknown as NousToolDeps);
    expect(await tools.execute("space_db_query", { sql: "SELECT kind FROM security_copilot_events" }, { owner: "user:operator", turnId: "t", callId: "c", traceId: "x" }))
      .toMatchObject({ ok: false, display: "Reading the database failed", meta: { dbCode: "42703", dbGuess: "kind" } });
    expect(dbFailureLines([{ dbCode: "42703", dbGuess: "kind" }, { dbCode: "42703", dbGuess: "kind" }, { dbCode: "42703", dbGuess: "s.id" }, { dbCode: "42P01", dbGuess: "cli_sessions" }]))
      .toEqual(["- 42703 (wrong column): 3; guessed: kind ×2, s.id", "- 42P01 (no such table): 1; guessed: cli_sessions"]);
    expect(dbFailureLines([])).toEqual(["- No database read failed."]);
  });

  it("records a code on every failed read, and names a syntax error's token and the query around it (R17-3)", async () => {
    // 48 h to 30/10: ~25 failed reads carried no meta.dbCode; 42601 was the second code.
    expect(nousDbFailureMeta("space_db_query reads only: start with SELECT, WITH, TABLE, VALUES, EXPLAIN or SHOW.")).toEqual({ dbCode: "REFUSED" });
    expect(nousDbFailureMeta("That function changes sessions, locks, settings or files; space_db_query only reads.")).toEqual({ dbCode: "REFUSED" });
    const tools = createNousTools({ db: { query: async () => "" } } as unknown as NousToolDeps);
    expect(await tools.execute("space_db_query", { limit: 5 }, { owner: "user:operator", turnId: "t", callId: "c", traceId: "x" })).toMatchObject({ ok: false, meta: { dbCode: "REFUSED" } });
    // R20-2: a read with no database here carries a code too (UNAVAILABLE).
    const at = { owner: "user:operator", turnId: "t", callId: "c", traceId: "x" };
    expect(await createNousTools({} as NousToolDeps).execute("space_db_query", { sql: "SELECT 1" }, at)).toMatchObject({ ok: false, meta: { dbCode: "UNAVAILABLE" } });
    const { text } = nousDbStatement({ sql: "SELECT id FROM notes ORDER id" });
    expect(nousDbSyntaxLine(text, text.indexOf("id\n"), "id")).toBe('Syntax error at "id", character 28 of your query: SELECT id FROM notes ORDER ⟪here⟫id');
    expect(nousDbSyntaxLine(text, text.length - 3, null)).toBe("Syntax error at the end of your query: …SELECT id FROM notes ORDER id");
    const two = "SELECT * FROM (\nSELECT 1; SELECT 2\n) AS nous_query LIMIT 101"; // R59 refuses it first; PostgreSQL's answer stays a fallback
    expect(nousDbSyntaxLine(two, two.indexOf(";"), ";")).toMatch(/at ";", character 9 of your query: SELECT 1⟪here⟫; SELECT 2 One statement per call: send each statement as its own space_db_query\.$/);
  });

  it("lists real columns for the tool description, whole tables only, within the budget", () => {
    const tables = [{ table_name: "panes", columns: "id, is_closed" }, { table_name: "rooms", columns: "id, name" }];
    expect(nousDbColumnsText(tables)).toBe("Real columns (use these names; other tables: information_schema.columns): panes(id, is_closed); rooms(id, name);");
    expect(nousDbColumnsText(tables, 100)).not.toContain("rooms(");
    expect(nousDbColumnsText([])).toBe("");
  });
});

const unavailable = disposablePostgresUnavailableReason();
describe.skipIf(unavailable !== null)(`space_db_query on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous-db");
    await server.createDatabase("space_nous_db");
    pool = server.pool("space_nous_db", 2);
    await pool.query("CREATE TABLE notes(id int, body text); CREATE TABLE note_tags(note_id int, tag text); INSERT INTO notes VALUES (1, 'one'), (2, 'two'), (3, 'three')");
  }, 120_000);
  afterAll(async () => { await pool?.end(); await server?.stop(); });

  it("reads, and never writes: a write inside a read, a second statement and a commit all fail", async () => {
    const db = createNousDb({ pool });
    expect(await db.query({ sql: "SELECT id, body FROM notes ORDER BY id", limit: 2 })).toContain('2 rows (more exist');
    await expect(db.query({ sql: "WITH gone AS (DELETE FROM notes RETURNING id) SELECT * FROM gone" })).rejects.toThrow("Postgres:");
    await expect(db.query({ sql: "SELECT 1; DELETE FROM notes" })).rejects.toThrow("one statement per call");
    await expect(db.query({ sql: "SELECT 1) AS x; COMMIT; DELETE FROM notes; SELECT (1" })).rejects.toThrow("one statement per call");
    expect((await pool.query("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(3);
  });

  it("says what was wrong: message, code and hint, the table's real columns or the nearest table names", async () => {
    const db = createNousDb({ pool });
    const column = await db.query({ sql: "SELECT n.title FROM public.notes n JOIN note_tags t ON t.note_id = n.id" }).catch((error: Error) => error.message);
    expect(column).toContain('Postgres: column n.title does not exist (code 42703)');
    expect(column).toContain("Columns of notes: id, body");
    expect(column).toContain("Columns of note_tags: note_id, tag");
    // Goal 401b115b (9/11: metadata ×3): a table after a comma in FROM is named too.
    const listed = await db.query({ sql: "SELECT t.metadata FROM notes n, note_tags t WHERE t.note_id = n.id" }).catch((error: Error) => error.message);
    expect(listed).toContain("Columns of note_tags: note_id, tag");
    const table = await db.query({ sql: "SELECT * FROM note" }).catch((error: Error) => error.message);
    expect(table).toContain('relation "note" does not exist (code 42P01)');
    expect(table).toContain("Nearest tables: notes, note_tags");
    // R36-b (1/11 20:32 UTC): a memory table that does not exist names space_memory_recall.
    expect(await db.query({ sql: "SELECT * FROM space_memory" }).catch((error: Error) => error.message)).toContain("Space Memory is files, not a table: read it with space_memory_recall");
    expect(table).not.toContain("space_memory_recall");
    // R10-9, R13-1: when one column fits, the corrected query is run once and its rows answer, under what was corrected.
    const hinted = await db.query({ sql: "SELECT bodyy FROM notes ORDER BY 1" });
    expect(hinted).toContain('Corrected and run: SELECT body FROM notes ORDER BY 1\n(PostgreSQL first said: column "bodyy" does not exist (code 42703))\n3 rows; columns: body');
    expect(column).not.toContain("Corrected query");
    // R12-8, R13-1: a text function on a json column, an operator or a UNION over two types: cast to text and run.
    await pool.query("CREATE TABLE IF NOT EXISTS note_meta(id int, meta jsonb); INSERT INTO note_meta VALUES (1, '{\"a\": 1}')");
    expect(await db.query({ sql: "SELECT left(meta, 20) FROM note_meta" })).toContain("Corrected and run: SELECT left((meta)::text, 20) FROM note_meta");
    expect(await db.query({ sql: "SELECT n.id FROM notes n JOIN note_tags t ON n.id = t.tag" })).toContain("Corrected and run: SELECT n.id FROM notes n JOIN note_tags t ON (n.id)::text = (t.tag)::text");
    const union = await db.query({ sql: "SELECT id, body AS what FROM notes UNION ALL SELECT id, meta AS what FROM note_meta" });
    expect(union).toContain("Corrected and run: SELECT id, (body)::text AS what FROM notes UNION ALL SELECT id, (meta)::text AS what FROM note_meta");
    expect(union).toContain("(code 42804)");
    // R25: avg over a json number and ILIKE on jsonb are corrected and run.
    await pool.query(`INSERT INTO note_meta VALUES (2, '0.5'), (3, '"1.5"')`);
    expect(await db.query({ sql: "SELECT avg(meta) FROM note_meta WHERE id > 1" })).toContain("Corrected and run: SELECT avg((to_jsonb(meta)#>>'{}')::numeric) FROM note_meta WHERE id > 1");
    expect(await db.query({ sql: "SELECT id FROM note_meta WHERE meta ILIKE '%a%'" })).toContain("Corrected and run: SELECT id FROM note_meta WHERE (meta)::text ILIKE ('%a%')::text");
    // A synonym the table has (created_at → at).
    await pool.query("CREATE TABLE IF NOT EXISTS note_events(id int, at timestamptz)");
    expect(await db.query({ sql: "SELECT created_at FROM note_events" })).toContain("Corrected and run: SELECT at FROM note_events");
    // Round 9b item 3 (operator 28/10 15:04 BKK): an ambiguous column names each table and alias that has it, and the forms to use.
    await pool.query("CREATE TABLE IF NOT EXISTS note_links(id int, note_id int)");
    // With a subquery nothing is guessed (an outer alias would change what the inner query reads).
    const ambiguous = await db.query({ sql: "SELECT id FROM notes n JOIN note_links AS l ON l.note_id = n.id JOIN note_tags t ON t.note_id = n.id WHERE n.id IN (SELECT note_id FROM note_tags)" }).catch((error: Error) => error.message);
    expect(ambiguous).toContain('column reference "id" is ambiguous (code 42702)');
    expect(ambiguous).toContain("id is a column of notes (as n), note_links (as l): use n.id or l.id.");
    // R50 (42702 ×7 in 7 d to 3/11): otherwise the first table in FROM/JOIN order that has it is meant; each ambiguous column in turn, run once.
    await pool.query("CREATE TABLE IF NOT EXISTS note_copies(id int, body text); INSERT INTO note_copies VALUES (1, 'copy')");
    expect(await db.query({ sql: "SELECT id FROM notes n JOIN note_links AS l ON l.note_id = n.id JOIN note_tags t ON t.note_id = n.id" }))
      .toContain('Corrected and run: SELECT n.id FROM notes n JOIN note_links AS l ON l.note_id = n.id JOIN note_tags t ON t.note_id = n.id\n(PostgreSQL first said: column reference "id" is ambiguous (code 42702))');
    expect(await db.query({ sql: "SELECT note_id FROM note_tags JOIN note_links ON true" })).toContain("Corrected and run: SELECT note_tags.note_id FROM note_tags JOIN note_links ON true");
    expect(await db.query({ sql: "SELECT id, body FROM notes n JOIN note_copies c ON c.id = n.id ORDER BY id" }))
      .toContain("Corrected and run: SELECT n.id, n.body FROM notes n JOIN note_copies c ON c.id = n.id ORDER BY n.id\n(PostgreSQL first said: column reference \"id\" is ambiguous (code 42702))\n1 row; columns: id, body");
    // R13-1: one table nearer than all others is read. R51-1: when the corrected query fails too, its error leads (the real table's
    // columns), then the query Space ran and the first error.
    expect(await db.query({ sql: "SELECT note_id FROM note_link" })).toContain("Corrected and run: SELECT note_id FROM note_links\n(PostgreSQL first said: relation \"note_link\" does not exist (code 42P01))");
    const still = await db.query({ sql: "SELECT bogus FROM note_link" }).catch((error: Error) => error.message);
    expect(still).toMatch(/^Postgres: column "bogus" does not exist \(code 42703\)\nColumns of note_links: id, note_id\n\(Space corrected your query and ran: SELECT bogus FROM note_links\nPostgreSQL first said: relation "note_link" does not exist \(code 42P01\)/);
    expect(nousDbFailureMeta(still)).toEqual({ dbCode: "42703", dbGuess: "bogus" });
  });

  it("R21-1: corrects every wrong column of one query, one PostgreSQL answer at a time, and runs it once; a correction that fails answers what is still wrong (R51-1)", async () => {
    const db = createNousDb({ pool });
    await pool.query("CREATE TABLE IF NOT EXISTS note_records(record_key text, updated_at timestamptz, value jsonb); INSERT INTO note_records VALUES ('k1', now(), '{}')");
    const both = await db.query({ sql: "SELECT id, created_at FROM note_records ORDER BY created_at" });
    expect(both).toContain('Corrected and run: SELECT record_key, updated_at FROM note_records ORDER BY updated_at\n(PostgreSQL first said: column "id" does not exist (code 42703))\n1 row');
    const left = await db.query({ sql: "SELECT id, colour FROM note_records" }).catch((error: Error) => error.message);
    expect(left).toMatch(/^Postgres: column "colour" does not exist \(code 42703\)\nColumns of note_records: record_key, updated_at, value\n/);
    expect(left).toContain('(Space corrected your query and ran: SELECT record_key, colour FROM note_records\nPostgreSQL first said: column "id" does not exist (code 42703)');
  });

  it("names a syntax error's token and position on PostgreSQL itself (R17-3)", async () => {
    const syntax = await createNousDb({ pool }).query({ sql: "SELECT id FROM notes WHERE id = 1 ORDER id" }).catch((error: Error) => error.message);
    expect(syntax).toContain("(code 42601)");
    expect(syntax).toContain('Syntax error at "id", character 41 of your query: SELECT id FROM notes WHERE id = 1 ORDER ⟪here⟫id');
    expect(nousDbFailureMeta(syntax)).toEqual({ dbCode: "42601" });
  });

  it("R45: a regex repeat over PostgreSQL's 255 names the repeat and what reads instead (2201B ×2 in 48 h to 3/11)", async () => {
    const regex = await createNousDb({ pool }).query({ sql: "SELECT x FROM (VALUES ('a')) v(x) WHERE x ~ '^.{300,}$' OR x ~ 'a{2,9}'" }).catch((error: Error) => error.message);
    expect(regex).toContain("invalid repetition count(s) (code 2201B)");
    expect(regex).toContain("A regex repeat counts to 255 at most in PostgreSQL ({300,} here): compare length(<column>) >= 300 for a length, or split it into repeats of 255 or fewer.");
    expect(regex).not.toContain("{2,9}");
    // Goal 401b115b (9/11): a brace meant as text ({3,2} reversed counts) says how to escape it.
    const brace = await createNousDb({ pool }).query({ sql: "SELECT x FROM (VALUES ('a')) v(x) WHERE x ~ 'a{3,2}'" }).catch((error: Error) => error.message);
    expect(brace).toContain("invalid repetition count(s) (code 2201B)\nA { followed by a digit starts a repeat {n} or {n,m} with n ≤ m ≤ 255: to match a brace as text escape it");
  });

  it("R52-2/3/4 (3/11): a column of no Space table, a value that does not cast, and Space Control's items name what to do", async () => {
    const db = createNousDb({ pool });
    const catalog = await db.query({ sql: "SELECT id FROM generate_series(1, 2) g" }).catch((error: Error) => error.message);
    expect(catalog).toContain("generate_series is no Space table (a catalog view, function, CTE or subquery alias): list a relation's columns with SELECT column_name FROM information_schema.columns WHERE table_name = '<name>'.");
    const integer = await db.query({ sql: "SELECT x::int FROM (VALUES ('1'), ('prizes-2')) v(x)" }).catch((error: Error) => error.message);
    expect(integer).toContain(`A value of the column you cast is not integer ("prizes-2"): cast only the rows that are, WHERE pg_input_is_valid(<column>, 'integer'), or compare it as text.`);
    const json = await db.query({ sql: "SELECT x::json FROM (VALUES ('ONCE')) v(x)" }).catch((error: Error) => error.message);
    expect(json).toContain("A value of the column you cast is not json: cast only the rows that are, WHERE pg_input_is_valid(<column>, 'json')");
    const control = await db.query({ sql: "SELECT * FROM space_control_schedules" }).catch((error: Error) => error.message);
    expect(control).toContain("Space Control's schedules, watches, operations and audit are rows of space_control_records: WHERE kind = 'schedule'");
    // R59 (2026-11-04 REVIEW): a table Nous guessed before answers where its rows are, first, and is never swapped for a near name.
    const queue = await db.query({ sql: "SELECT * FROM pane_prompt_queue" }).catch((error: Error) => error.message);
    expect(queue).toContain("pane_prompt_queue is no table: use space_control_records with kind 'schedule' and value->>'condition' = 'AFTER_TURN'");
    expect(queue).not.toContain("Corrected");
    const done = await db.query({ sql: "SELECT * FROM public.nous_request_done" }).catch((error: Error) => error.message);
    expect(done).toContain("nous_request_done is no table: use space_notifications with kind 'REQUEST_DONE'");
  });

  it("R60 (7 d to 4/11: 8 failed reads our own corrections caused): a vault event's fields, a cast type kept, mixed numeric casts, JSON compared with a word", async () => {
    // vault_audit keeps actor, action, result and itemId inside event: R21-1's action → event compared the whole JSON with 'LIST' (22P02 ×2).
    const vault = new Map([["vault_audit", ["id", "vault_id", "owner_user_id", "seq", "event", "prev_hash", "hash", "created_at"]], ["vault_items", ["id", "label", "status"]]]);
    expect(nousDbCorrectedQuery("SELECT * FROM vault_audit WHERE action NOT IN ('LIST','STATUS')", 'column "action" does not exist', undefined, vault)?.sql)
      .toBe("SELECT * FROM vault_audit WHERE (event->>'action') NOT IN ('LIST','STATUS')");
    expect(nousDbCorrectedQuery("SELECT v.id, (SELECT count(*) FROM vault_audit a WHERE a.item_id = v.id) FROM vault_items v", "column a.item_id does not exist", undefined, vault)?.sql)
      .toBe("SELECT v.id, (SELECT count(*) FROM vault_audit a WHERE (a.event->>'itemId') = v.id) FROM vault_items v");
    // 29/10 04:24: text → message also renamed the cast type, payload::message (42704).
    const events = new Map([["mail_copilot_events", ["id", "type", "message", "payload", "created_at"]]]);
    expect(nousDbCorrectedQuery("SELECT left(text, 200), payload::text AS p FROM mail_copilot_events", 'column "text" does not exist', undefined, events)?.sql)
      .toBe("SELECT left(message, 200), payload::text AS p FROM mail_copilot_events");
    const db = createNousDb({ pool });
    // 1/11 03:38: avg(jsonb) cast every avg's argument with #>>, also the numeric one (42883 numeric #>> unknown).
    await pool.query("CREATE TABLE IF NOT EXISTS note_meta(id int, meta jsonb); CREATE TABLE IF NOT EXISTS note_recur(id int, recurrence jsonb); INSERT INTO note_recur VALUES (1, '{\"kind\": \"DAILY\"}')");
    expect(await db.query({ sql: "SELECT avg(meta), avg(id) FROM note_meta WHERE id > 1" }))
      .toContain("Corrected and run: SELECT avg((to_jsonb(meta)#>>'{}')::numeric), avg((to_jsonb(id)#>>'{}')::numeric) FROM note_meta WHERE id > 1");
    // 3/11 18:40: a jsonb column compared with a word has no cast to blame.
    const compared = await db.query({ sql: "SELECT id FROM note_recur WHERE recurrence IS NOT NULL AND recurrence <> 'ONCE'" }).catch((error: Error) => error.message);
    expect(compared).toContain("recurrence is JSON, so 'ONCE' is read as JSON, not as text: compare one of its fields (recurrence->>'<field>') or its whole value as text (recurrence #>> '{}').");
    expect(compared).not.toContain("the column you cast");
    // 3/11 20:17: control_schedule is Space Control's too.
    expect(await db.query({ sql: "SELECT * FROM control_schedule" }).catch((error: Error) => error.message)).toContain("Space Control's schedules, watches, operations and audit are rows of space_control_records");
  });

  it("R41: names another account's notification by its id, never the owner's own", async () => {
    await pool.query("CREATE TABLE space_notifications(id text, owner_user_id text, source text, kind text, status text, created_at timestamptz); "
      + "INSERT INTO space_notifications VALUES ('notification:emu1', 'user:emu', 'SYSTEM', 'TEST', 'OPEN', '2026-10-30T11:02:00Z'), "
      + "('notification:own1', 'user:operator', 'SYSTEM', 'TEST', 'OPEN', '2026-10-30T11:02:00Z')");
    const db = createNousDb({ pool });
    expect(await db.notificationElsewhere("user:operator", "notification:emu1")).toEqual({ source: "SYSTEM", kind: "TEST", status: "OPEN", createdAt: "2026-10-30T11:02:00.000Z" });
    expect(await db.notificationElsewhere("user:operator", "notification:own1")).toBeNull();
  });

  it("R66 (7 d to 4/11: a post's account ×6, an application's payload ×2, a gateway account's kind ×2): a guess no column fits names where the data is", async () => {
    await server.createDatabase("space_nous_db_r66");
    const schemaPool = server.pool("space_nous_db_r66", 2);
    try {
      const client = await schemaPool.connect();
      try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
      const db = createNousDb({ pool: schemaPool });
      // 3/11 23:40 UTC, word for word.
      await expect(db.query({ sql: "SELECT id, channel, kind, status, scheduled_at, target, account, created_at, updated_at, left(body,200) AS b FROM marketing_copilot_posts WHERE id = 'mktpost:FXtekInmGgmV'" }))
        .rejects.toThrow("the account and browser profile a site is posted from are in site_sign_ins (site, account_label, record), read with space_site_signin_get");
      // 3/11 23:34 UTC: platform and text are corrected first, then meta is what is still wrong.
      await expect(db.query({ sql: "SELECT id, status, platform, left(text,200) t FROM marketing_copilot_posts WHERE text ILIKE '%jul1ano%' OR (meta::text ILIKE '%jul1ano%')" }))
        .rejects.toThrow("marketing_copilot_posts has no account, metadata or meta column");
      await expect(db.query({ sql: "SELECT company, role, left(coalesce(payload::text,''),3000) p FROM job_applications WHERE company ILIKE '%IP Fabric%'" }))
        .rejects.toThrow("are rows of job_apply_events WHERE application_id = job_applications.id");
      await expect(db.query({ sql: "SELECT a.id, a.provider, a.kind FROM space_gateway_accounts a WHERE a.provider ILIKE '%claude%'" }))
        .rejects.toThrow("an account's kind is its provider (CLAUDE for the Claude subscriptions, ANTHROPIC_API for the Claude API key");
    } finally {
      await schemaPool.end();
    }
  }, 120_000);

  it("knows the real columns of the tables it reads most before the first query (stable 2026-10-27: four guessed names failed)", async () => {
    await server.createDatabase("space_nous_db_schema");
    const schemaPool = server.pool("space_nous_db_schema", 2);
    try {
      const client = await schemaPool.connect();
      try { await applyPendingMigrations(client, await loadMigrations()); } finally { client.release(); }
      const columns = await createNousDb({ pool: schemaPool }).columns();
      expect(columns.length).toBeLessThanOrEqual(3_000);
      for (const table of NOUS_DB_COMMON_TABLES) expect(columns).toContain(` ${table}(`);
      expect(columns).toMatch(/ nous_messages\([^)]*\bkind\b/);
      expect(columns).toMatch(/ pane_reports\([^)]*\bat\b/);
      expect(columns).toMatch(/ security_copilot_events\([^)]*\btype\b/);
      expect(columns).toMatch(/ panes\([^)]*\bis_closed\b/);
    } finally {
      await schemaPool.end();
    }
  }, 120_000);
});
