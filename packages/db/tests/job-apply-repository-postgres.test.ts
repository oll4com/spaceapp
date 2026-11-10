// Job Copilot v2 tables on a real, disposable PostgreSQL: migrations 0160-0163 apply on top of
// the full chain, and the repository round-trips memory (full-text recall, keyed upserts),
// fields, events, runs and the queue. Skips with a reason when Docker or the image is missing.
import { readFile } from "node:fs/promises";
import { jobApplyMemorySchema } from "@space/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresJobApplyRepository } from "../src/job-apply-repository.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:jobcopilot";

describe.skipIf(unavailable !== null)(`job apply repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresJobApplyRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("jobcopilot");
    await server.createDatabase("space_jobcopilot");
    pool = server.pool("space_jobcopilot", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "jobcopilot@space.local"]);
    await pool.query(`INSERT INTO rooms(id,name,trace_id,owner_user_id) VALUES ('room:jobs','Jobs','jobs:trace','${owner}');
      INSERT INTO panes(id,room_id,title,mode,status,pane_order,is_closed) VALUES ('pane:jobs0001','room:jobs','Job Copilot','JOB_APPLY','IDLE',0,false),
        ('pane:other','room:jobs','Job Copilot','JOB_APPLY','IDLE',1,false),('pane:closed','room:jobs','Job Copilot','JOB_APPLY','IDLE',2,true)`);
    repository = new PostgresJobApplyRepository(pool as unknown as ConstructorParameters<typeof PostgresJobApplyRepository>[0]);
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("migration 0177 turns the earlier tracker's claims into truthful history", async () => {
    // Its own owner, so the other cases keep their tracker to themselves.
    const owner = "user:jobhistory";
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR') ON CONFLICT (id) DO NOTHING", [owner, "jobhistory@space.local"]);
    const imported = async (path: string, company: string, role: string, status: string, externalConfirmation: string | null, ats = "other") => {
      const row = await repository.createApplication({ ownerUserId: owner, paneId: null, company, role, ats: ats as "other", url: `https://space.local/imported/${path}`, status: "QUEUED",
        notes: `imported id: ${path.split("/").pop()}` });
      return repository.updateApplication(owner, row.id, { status: status as "SUBMITTED", externalConfirmation, appliedAt: "2026-09-02T20:09:07.000Z" });
    };
    const noForm = await imported("NO_FORM/linkedin_4453887122", "SE Conquer AI", "Unknown role", "SUBMITTED", null);
    const error = await imported("ERR/linkedin_4453088215", "Senior Backend hermeneutic", "Unknown role", "SUBMITTED", null);
    const claimed = await imported("gh-generic/databricks_8569390002", "databricks", "Job 8569390002", "VERIFIED", "imported: verified", "greenhouse");
    const applied = await imported("applied/linkedin_4459768617", "Senior Distributed Systems AI NEXadept SG", "Unknown role", "SUBMITTED", null);
    const own = await repository.createApplication({ ownerUserId: owner, paneId: null, company: "Acme", role: "Backend", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/1", status: "QUEUED", notes: null });
    await repository.updateApplication(owner, own.id, { status: "VERIFIED", externalConfirmation: "security code AB12cd34" });
    const sql = await readFile(new URL("../migrations/0177_job_apply_imported_history.sql", import.meta.url), "utf8");
    await pool.query(sql);
    // A second run changes nothing more.
    await pool.query(sql);
    const after = async (id: string) => (await repository.getApplication(owner, id))!;
    expect(await after(noForm!.id)).toMatchObject({ status: "FAILED", ats: "linkedin", role: "Title not recorded", notes: "imported id: linkedin_4453887122 | earlier tracker: no application form found" });
    expect(await after(error!.id)).toMatchObject({ status: "FAILED", notes: expect.stringContaining("the attempt ended in an error") });
    expect(await after(claimed!.id)).toMatchObject({ status: "SUBMITTED", externalConfirmation: null, role: "Title not recorded",
      notes: "imported id: databricks_8569390002 | earlier tracker said verified; no confirmation email checked yet" });
    expect(await after(applied!.id)).toMatchObject({ status: "SUBMITTED", ats: "linkedin" });
    expect(await after(own.id)).toMatchObject({ status: "VERIFIED", externalConfirmation: "security code AB12cd34", role: "Backend" });
  });

  it("keeps the copilot's Google account across other profile updates and clears it on request", async () => {
    expect((await repository.upsertProfile(owner, { candidate: { fullName: "Nikolaos" } })).googleEmail).toBeNull();
    expect((await repository.upsertProfile(owner, { googleEmail: "me@gmail.com" })).googleEmail).toBe("me@gmail.com");
    const later = await repository.upsertProfile(owner, { mailbox: null, mailboxPasswordEncrypted: null, mailboxVerifiedAt: null });
    expect(later).toMatchObject({ googleEmail: "me@gmail.com", candidate: { fullName: "Nikolaos" } });
    expect((await repository.getProfile(owner))?.googleEmail).toBe("me@gmail.com");
    expect((await repository.upsertProfile(owner, { googleEmail: null })).googleEmail).toBeNull();
    await repository.upsertProfile(owner, { candidate: {} });
  });

  it("recalls memories by full-text search and exact keys, keeps one answer per key and scope", async () => {
    const years = await repository.upsertMemoryByKey({ ownerUserId: owner, kind: "ANSWER", key: "how many years of typescript experience do you have", text: "6", site: null, company: null, tags: ["form"], source: "CV", confidence: 0.7, pinned: false });
    const again = await repository.upsertMemoryByKey({ ownerUserId: owner, kind: "ANSWER", key: "how many years of typescript experience do you have", text: "7", site: null, company: null, tags: [], source: "USER", confidence: 0.95, pinned: false });
    expect(again.id).toBe(years.id);
    expect(again).toMatchObject({ text: "7", source: "USER", tags: ["form"] });
    const scoped = await repository.upsertMemoryByKey({ ownerUserId: owner, kind: "ANSWER", key: "how many years of typescript experience do you have", text: "6 (Ashby form wants a number)", site: "ashby", company: null, tags: [], source: "AGENT", confidence: 0.8, pinned: false });
    expect(scoped.id).not.toBe(years.id);
    await repository.createMemory({ ownerUserId: owner, kind: "LESSON", key: null, text: "Greenhouse embeds: open the embed URL directly, the iframe hides the security code page.", site: "greenhouse", company: null, tags: ["embed"], source: "AGENT", confidence: 0.8, pinned: true });
    await repository.createMemory({ ownerUserId: owner, kind: "COMPANY", key: null, text: "Acme asks for a GitHub link on step 2.", site: null, company: "Acme", tags: [], source: "AGENT", confidence: 0.8, pinned: false });

    const byKey = await repository.listMemory(owner, { keys: ["how many years of typescript experience do you have"], kinds: ["ANSWER"], limit: 10 });
    expect(byKey.map((memory) => memory.text)).toEqual(["6 (Ashby form wants a number)", "7"]);
    const ashbyOnly = await repository.listMemory(owner, { keys: ["how many years of typescript experience do you have"], site: "greenhouse", limit: 10 });
    expect(ashbyOnly.map((memory) => memory.text)).toEqual(["7"]);
    const search = await repository.listMemory(owner, { query: "security code embed", limit: 10 });
    expect(search.map((memory) => memory.kind)).toEqual(["LESSON"]);
    // The ordering columns stay in SQL: the API parses every recalled memory with the strict schema.
    for (const memory of [...byKey, ...ashbyOnly, ...search]) expect(() => jobApplyMemorySchema.parse(memory)).not.toThrow();
    const company = await repository.listMemory(owner, { query: "github", company: "acme", limit: 10 });
    expect(company.map((memory) => memory.company)).toEqual(["Acme"]);
    expect(await repository.listMemory(owner, { query: "nothing matches this", limit: 10 })).toEqual([]);
    expect(await repository.listMemory("user:other", { limit: 10 })).toEqual([]);

    await repository.touchMemory(owner, [years.id], "2026-10-12T10:00:00.000Z");
    expect((await repository.getMemory(owner, years.id))).toMatchObject({ uses: 1, lastUsedAt: "2026-10-12T10:00:00.000Z" });
    expect(await repository.updateMemory(owner, years.id, { pinned: true, tags: ["form", "years"] })).toMatchObject({ pinned: true, tags: ["form", "years"] });
    expect(await repository.countMemory(owner)).toBe(4);
    expect(await repository.deleteMemory(owner, scoped.id)).toBe(true);
    expect(await repository.deleteMemory("user:other", years.id)).toBe(false);
  });

  it("stores fields per step idempotently, events in order and runs with a single active one per pane", async () => {
    const application = await repository.createApplication({ ownerUserId: owner, paneId: "pane:jobs0001", company: "Acme", role: "Backend", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/1", status: "QUEUED", notes: null, queuePosition: 0 });
    const first = await repository.upsertFields(owner, application.id, [
      { stepIndex: 0, stepTitle: "Application", label: "Full name", fieldType: "text", refHint: "e12", value: "Nikolaos", source: "PROFILE", verifiedAt: null },
      { stepIndex: 0, stepTitle: "Application", label: "Resume", fieldType: "file", refHint: null, value: "cv.pdf", source: "PROFILE", verifiedAt: null }
    ], "2026-10-12T10:00:00.000Z");
    const second = await repository.upsertFields(owner, application.id, [
      { stepIndex: 0, stepTitle: null, label: "Full name", fieldType: "text", refHint: null, value: "Nikolaos Theodoropoulos", source: "USER", verifiedAt: "2026-10-12T10:05:00.000Z" }
    ], "2026-10-12T10:05:00.000Z");
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]).toMatchObject({ value: "Nikolaos Theodoropoulos", source: "USER", stepTitle: "Application", refHint: "e12", verifiedAt: "2026-10-12T10:05:00.000Z" });
    expect((await repository.listFields(owner, application.id)).map((field) => field.label)).toEqual(["Full name", "Resume"]);
    expect(await repository.countFields(owner, application.id)).toBe(2);
    expect(await repository.updateField(owner, first[1]!.id, { value: "cv-2026.pdf" })).toMatchObject({ value: "cv-2026.pdf" });

    await repository.createEvent({ ownerUserId: owner, paneId: "pane:jobs0001", applicationId: application.id, runId: null, type: "STARTED", message: "Filling Acme", payload: {}, artifactId: null });
    await repository.createEvent({ ownerUserId: owner, paneId: "pane:jobs0001", applicationId: application.id, runId: null, type: "FIELD_FILLED", message: "Filled 2 fields", payload: { count: 2 }, artifactId: null });
    const events = await repository.listEvents(owner, { applicationId: application.id, limit: 10 });
    expect(events.map((event) => event.type)).toEqual(["FIELD_FILLED", "STARTED"]);
    expect(events[0]!.payload).toEqual({ count: 2 });
    expect(await repository.listEvents(owner, { applicationId: application.id, since: events[1]!.createdAt, limit: 10 })).toHaveLength(1);
    expect((await repository.listEvents(owner, { paneId: "pane:jobs0001", types: ["STARTED"], limit: 1 })).map((event) => event.type)).toEqual(["STARTED"]);

    const run = await repository.createRun({ ownerUserId: owner, paneId: "pane:jobs0001", status: "RUNNING" });
    expect(run.counters).toEqual({ taken: 0, submitted: 0, verified: 0, failed: 0, needsUser: 0 });
    await expect(repository.createRun({ ownerUserId: owner, paneId: "pane:jobs0001", status: "RUNNING" })).rejects.toThrow(/job_apply_runs_active_pane_idx/);
    expect((await repository.getActiveRun("pane:jobs0001"))?.id).toBe(run.id);
    const paused = await repository.updateRun(owner, run.id, { status: "PAUSED", pausedAt: "2026-10-12T10:10:00.000Z", counters: { ...run.counters, taken: 1 }, currentApplicationId: application.id });
    expect(paused).toMatchObject({ status: "PAUSED", counters: { taken: 1 }, currentApplicationId: application.id });
    await repository.updateRun(owner, run.id, { status: "STOPPED", stoppedAt: "2026-10-12T10:20:00.000Z" });
    expect(await repository.getActiveRun("pane:jobs0001")).toBeNull();
    expect((await repository.listRuns(owner, "pane:jobs0001", 5)).map((entry) => entry.status)).toEqual(["STOPPED"]);
  });

  it("orders the queue, reorders it and removes only queued rows", async () => {
    const second = await repository.createApplication({ ownerUserId: owner, paneId: "pane:jobs0001", company: "Globex", role: "Platform", ats: "ashby", url: "https://jobs.ashbyhq.com/globex/2", status: "QUEUED", notes: null, queuePosition: await repository.nextQueuePosition(owner) });
    const third = await repository.createApplication({ ownerUserId: owner, paneId: null, company: "Initech", role: "SRE", ats: "lever", url: "https://jobs.lever.co/initech/3", status: "QUEUED", notes: null, queuePosition: await repository.nextQueuePosition(owner) });
    const other = await repository.createApplication({ ownerUserId: owner, paneId: "pane:other", company: "Hooli", role: "Dev", ats: "other", url: "https://hooli.example/4", status: "QUEUED", notes: null, queuePosition: await repository.nextQueuePosition(owner) });
    expect((await repository.listQueue(owner, "pane:jobs0001")).map((row) => row.company)).toEqual(["Acme", "Globex", "Initech"]);
    expect((await repository.listQueue(owner, null)).map((row) => row.company)).toEqual(["Acme", "Globex", "Initech", "Hooli"]);
    await repository.setQueueOrder(owner, [third.id, second.id]);
    expect((await repository.listQueue(owner, "pane:jobs0001")).map((row) => [row.company, row.queuePosition])).toEqual([["Acme", 0], ["Initech", 0], ["Globex", 1]]);
    await repository.updateApplication(owner, other.id, { status: "FILLING", queuePosition: null });
    expect(await repository.deleteQueuedApplication(owner, other.id)).toBe(false);
    expect(await repository.deleteQueuedApplication(owner, third.id)).toBe(true);
    expect((await repository.listQueue(owner, null)).map((row) => row.company)).toEqual(["Acme", "Globex"]);
    // Postings of a closed or deleted pane are free for any Job Copilot pane.
    const closed = await repository.createApplication({ ownerUserId: owner, paneId: "pane:closed", company: "Umbrella", role: "Dev", ats: "other", url: "https://umbrella.example/6", status: "QUEUED", notes: null, queuePosition: await repository.nextQueuePosition(owner) });
    const gone = await repository.createApplication({ ownerUserId: owner, paneId: "pane:deleted", company: "Soylent", role: "Dev", ats: "other", url: "https://soylent.example/7", status: "QUEUED", notes: null, queuePosition: await repository.nextQueuePosition(owner) });
    expect((await repository.listQueue(owner, "pane:other")).map((row) => row.company)).toEqual(["Umbrella", "Soylent"]);
    await repository.deleteQueuedApplication(owner, closed.id);
    await repository.deleteQueuedApplication(owner, gone.id);
  });

  it("counts applications per day in a zone, apart from imported history and rows before a reset", async () => {
    const owner = "user:jobstats";
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR') ON CONFLICT (id) DO NOTHING", [owner, "jobstats@space.local"]);
    const sent = async (url: string, status: "SUBMITTED" | "VERIFIED" | "FAILED", appliedAt: string | null) => {
      const row = await repository.createApplication({ ownerUserId: owner, paneId: null, company: "Acme", role: "Dev", ats: "greenhouse", url, status: "QUEUED", notes: null });
      await repository.updateApplication(owner, row.id, { status, appliedAt });
      return row;
    };
    const archived = await sent("https://boards.greenhouse.io/acme/jobs/91", "SUBMITTED", "2026-10-01T10:00:00.000Z");
    await pool.query("UPDATE job_applications SET created_at = '2026-10-01T09:00:00Z' WHERE id = $1", [archived.id]);
    await sent("https://boards.greenhouse.io/acme/jobs/92", "VERIFIED", "2026-10-13T16:59:00.000Z");
    await sent("https://boards.greenhouse.io/acme/jobs/93", "VERIFIED", "2026-10-13T17:00:00.000Z");
    await sent("https://space.local/imported/linkedin/1", "SUBMITTED", "2026-09-02T20:09:07.000Z");
    const rows = await repository.applicationStats(owner, { tz: "Asia/Bangkok", since: "2026-10-10T00:00:00.000Z", importedUrlPrefix: "https://space.local/imported/" });
    expect(rows.map((row) => [row.day, row.status, row.scope, row.count]).sort()).toEqual([
      ["2026-09-03", "SUBMITTED", "IMPORTED", 1],
      ["2026-10-01", "SUBMITTED", "ARCHIVED", 1],
      ["2026-10-13", "VERIFIED", "CURRENT", 1],
      ["2026-10-14", "VERIFIED", "CURRENT", 1]
    ]);
    await expect(repository.applicationStats(owner, { tz: "Mars/Olympus", since: null, importedUrlPrefix: "https://space.local/imported/" })).rejects.toMatchObject({ code: "22023" });
  });

  it("resets the campaign only when its start is still the expected one, and lists the owner's active runs", async () => {
    const owner = "user:jobreset";
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR') ON CONFLICT (id) DO NOTHING", [owner, "jobreset@space.local"]);
    // No profile yet: a reset that expects an earlier one finds nothing; the first reset creates the profile.
    expect(await repository.resetCampaign(owner, "2026-10-01T00:00:00.000Z")).toBeNull();
    const first = await repository.resetCampaign(owner, null);
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await repository.getProfile(owner))?.campaignStartedAt).toBe(first);
    // The same click again (still expecting no reset) changes nothing; the returned value round-trips exactly.
    expect(await repository.resetCampaign(owner, null)).toBeNull();
    const second = await repository.resetCampaign(owner, first);
    expect(second).not.toBeNull();
    expect((await repository.getProfile(owner))?.campaignStartedAt).toBe(second);

    const running = await repository.createRun({ ownerUserId: owner, paneId: "pane:reset0001", status: "RUNNING" });
    const stopped = await repository.createRun({ ownerUserId: owner, paneId: "pane:reset0002", status: "RUNNING" });
    await repository.updateRun(owner, stopped.id, { status: "STOPPED", stoppedAt: "2026-10-14T00:00:00.000Z" });
    expect((await repository.listActiveRuns(owner)).map((run) => run.id)).toEqual([running.id]);
    expect(await repository.listActiveRuns("user:nobody")).toEqual([]);
  });

  it("closed-pane pruning keeps the newest closed Job and Marketing Copilot pane of a room and prunes the rest as before", async () => {
    await pool.query(`INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('room:prune','Prune','prune:trace','${owner}',99);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order,is_closed,updated_at) VALUES
        ('pane:prunecop1','room:prune','Job Copilot','JOB_APPLY','CLOSED',0,true,now() - interval '60 hours'),
        ('pane:prunecop2','room:prune','Job Copilot','JOB_APPLY','CLOSED',1,true,now() - interval '30 hours'),
        ('pane:pruneterm','room:prune','Terminal','TERMINAL','CLOSED',2,true,now() - interval '30 hours'),
        ('pane:prunemkt1','room:prune','Marketing Copilot','MARKETING_COPILOT','CLOSED',4,true,now() - interval '50 hours'),
        ('pane:prunemkt2','room:prune','Marketing Copilot','MARKETING_COPILOT','CLOSED',5,true,now() - interval '40 hours'),
        ('pane:pruneopen','room:prune','Job Copilot','JOB_APPLY','IDLE',3,false,now() - interval '90 hours')`);
    const store = new PostgresSpaceStore(pool as unknown as ConstructorParameters<typeof PostgresSpaceStore>[0]);
    expect(await store.pruneClosedPanes({ olderThanHours: 24, roomId: "room:prune" })).toEqual({ deletedPanes: 3 });
    expect((await pool.query<{ id: string }>("SELECT id FROM panes WHERE room_id='room:prune' ORDER BY id")).rows.map((row) => row.id)).toEqual(["pane:prunecop2", "pane:prunemkt2", "pane:pruneopen"]);
  });

  it("keeps an employer-limit deferral (not_before) on a queued row and clears it", async () => {
    const row = await repository.createApplication({ ownerUserId: owner, paneId: null, company: "Cognition", role: "Applied AI", ats: "ashby", url: "https://jobs.ashbyhq.com/cognition/5", status: "QUEUED", notes: null, queuePosition: await repository.nextQueuePosition(owner) });
    expect(row.notBefore).toBeNull();
    const deferred = await repository.updateApplication(owner, row.id, { notBefore: "2026-11-28T00:00:00.000Z", notes: "limit: one application per role every 3 months" });
    expect(deferred).toMatchObject({ status: "QUEUED", notBefore: "2026-11-28T00:00:00.000Z" });
    expect((await repository.listQueue(owner, null)).find((entry) => entry.id === row.id)?.notBefore).toBe("2026-11-28T00:00:00.000Z");
    expect(await repository.updateApplication(owner, row.id, { status: "FILLING" })).toMatchObject({ notBefore: "2026-11-28T00:00:00.000Z" });
    expect(await repository.updateApplication(owner, row.id, { notBefore: null })).toMatchObject({ notBefore: null });
  });

  it("stores mail triage events and lists the owners whose Job Copilot works with a Google account", async () => {
    expect(await repository.listGoogleProfileOwners()).toEqual([]);
    await repository.upsertProfile(owner, { googleEmail: "me@gmail.com" });
    expect(await repository.listGoogleProfileOwners()).toEqual([owner]);
    const event = await repository.createEvent({ ownerUserId: owner, paneId: "pane:jobs0001", applicationId: null, runId: null, type: "MAIL",
      message: "Action needed: Interview with Acme from Acme", payload: { category: "ACTION_NEEDED", messageId: "m1" }, artifactId: null });
    expect(event).toMatchObject({ type: "MAIL", payload: { category: "ACTION_NEEDED" } });
    await repository.upsertProfile(owner, { googleEmail: null });
    expect(await repository.listGoogleProfileOwners()).toEqual([]);
  });
});
