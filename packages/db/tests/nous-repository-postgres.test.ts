// Nous on a real, disposable PostgreSQL: migrations 0211-0212 apply on top of the full chain, the conversation keeps the
// newest messages in order, a decision is answered once, notes upsert and delete, a restart closes running turns, and
// the notification check accepts the NOUS source. Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOUS_TURN_FAILED_NO_ERROR } from "@space/contracts";
import { InMemoryNousRepository, PostgresNousRepository, type NousRepository } from "../src/nous-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:nous";

// 30/10 (operator: "why does my own dialogue disappear from the chat?"): 175 of the newest 200 rows were tool steps of 11 minutes.
async function expectDialogueWindow(store: NousRepository, user: string) {
  const add = (kind: "OPERATOR" | "ANSWER" | "TOOL", content: string) => store.addMessage({ ownerUserId: user, turnId: null, kind, status: "DONE", content });
  await add("TOOL", "step before");
  await add("OPERATOR", "old question");
  await add("ANSWER", "old answer");
  for (const step of ["s1", "s2", "s3", "s4", "s5"]) await add("TOOL", step);
  await add("OPERATOR", "new question");
  const contents = async (limit: number, tools?: number) => (await store.listMessages(user, limit, tools)).map((message) => message.content);
  // Tool steps never push the dialogue out; steps before its oldest message stay out; the cap keeps the newest steps.
  expect(await contents(3)).toEqual(["old question", "old answer", "s1", "s2", "s3", "s4", "s5", "new question"]);
  expect(await contents(2, 2)).toEqual(["old answer", "s4", "s5", "new question"]);
}

async function expectProvenance(store: NousRepository, user: string) {
  const base = { ownerUserId: user, reason: "OPERATOR" as const, status: "DONE" as const, planPoints: 0, tools: {}, outcomes: [],
    startedAt: "2026-11-04T00:00:00.000Z", endedAt: "2026-11-04T00:01:00.000Z", effort: "high", costUsd: null, tokens: null, goalId: null, error: null };
  await store.addTurnFacts({ ...base, turnId: `${user}:codex`, model: "codex:gpt-6-astra" });
  await store.addTurnFacts({ ...base, turnId: `${user}:claude`, model: "claude:claude-opus-5-5", endedAt: "2026-11-04T00:02:00.000Z" });
  await store.addTurnFacts({ ...base, turnId: `${user}:failed`, model: "codex:gpt-6-astra", status: "FAILED", endedAt: "2026-11-04T00:03:00.000Z" });
  expect(await store.latestServedTurn(user)).toMatchObject({ model: "claude:claude-opus-5-5" });
  expect(await store.latestServedTurn(`${user}:other`)).toBeNull();
  await store.addMessage({ ownerUserId: user, turnId: `${user}:codex`, kind: "ANSWER", status: "DONE", content: "old final" });
  await store.addMessage({ ownerUserId: user, turnId: `${user}:claude`, kind: "ANSWER", status: "DONE", content: "old interim", meta: { interim: true } });
  await store.addMessage({ ownerUserId: user, turnId: `${user}:claude`, kind: "ANSWER", status: "DONE", content: "attributed interim", meta: { interim: true, model: "codex:gpt-6-astra" } });
  const rows = await store.listMessages(user, 10);
  expect(rows.find((row) => row.content === "old final")?.meta.model).toBe("codex:gpt-6-astra");
  expect(rows.find((row) => row.content === "old interim")?.meta.model).toBeUndefined();
  expect(rows.find((row) => row.content === "attributed interim")?.meta.model).toBe("codex:gpt-6-astra");
}
it("recovers final answer provenance and the latest successful model (in memory)", () => expectProvenance(new InMemoryNousRepository(), "user:provenance"));

it("keeps the dialogue however many tool steps follow it (in memory)", () => expectDialogueWindow(new InMemoryNousRepository(), owner));

// 31/10 (operator: "questions must never be lost", «clear the window, never the database»): the dock pages back past the newest rows; Clear
// conversation moves a mark the dock's latest page starts after, and no row leaves Nous's own reads.
async function expectPagingAndClear(store: NousRepository, user: string) {
  const add = (kind: "OPERATOR" | "ANSWER" | "TOOL", content: string) => store.addMessage({ ownerUserId: user, turnId: null, kind, status: "DONE", content });
  const first = await add("OPERATOR", "q1");
  await add("TOOL", "t1");
  await add("ANSWER", "a1");
  const second = await add("OPERATOR", "q2");
  await add("ANSWER", "a2");
  const contents = async (limit: number, page?: { before?: string; sinceClear?: boolean }) => (await store.listMessages(user, limit, undefined, page)).map((message) => message.content);
  expect(await contents(2)).toEqual(["q2", "a2"]);
  expect(await contents(2, { before: second.id })).toEqual(["q1", "t1", "a1"]);
  expect(await contents(2, { before: first.id })).toEqual([]);
  expect(await contents(2, { before: "nous_msg:unknown000" })).toEqual([]);
  const rows = async () => (await store.listMessages(user, 1_000, 1_000)).length;
  expect(await rows()).toBe(5);
  expect(await store.conversationClearedAt(user)).toBeNull();
  expect(await store.clearMessages(user)).toBe(5);
  // A clear leaves the row count unchanged; its time hides the decisions asked before it in the dock (operator 2/11).
  expect(await rows()).toBe(5);
  expect(Date.parse((await store.conversationClearedAt(user))!)).toBeGreaterThan(0);
  const third = await add("OPERATOR", "q3");
  expect(await contents(10, { sinceClear: true })).toEqual(["q3"]);
  expect(await contents(10)).toEqual(["q1", "t1", "a1", "q2", "a2", "q3"]);
  expect(await contents(10, { before: third.id })).toEqual(["q1", "t1", "a1", "q2", "a2"]);
  expect(await store.clearMessages(user)).toBe(6);
  expect(await contents(10, { sinceClear: true })).toEqual([]);
  expect(await rows()).toBe(6);
  expect((await store.listOperatorMessageRefs(user)).map((ref) => ref.id)).toEqual([first.id, second.id, third.id]);
}

it("pages back past the newest rows and keeps cleared rows (in memory)", () => expectPagingAndClear(new InMemoryNousRepository(), owner));

// Plan clipboard:RQSrp1EczBbV (migration 0269): a share renews in place, expires (class B, pruned on the next share) and is removed by its owner only.
async function expectFileShares(store: NousRepository, user: string) {
  const at = Date.now();
  const share = (artifactId: string, fromHours: number, toHours: number, note: string | null = null) => store.addFileShare({ ownerUserId: user, artifactId, note, sharedBy: "nous",
    sharedAt: new Date(at + fromHours * 3_600_000).toISOString(), expiresAt: new Date(at + toHours * 3_600_000).toISOString() });
  const first = await share("artifact:icons000001", 0, 72, "Pick one");
  await share("artifact:old0000001", -100, -28);
  const renewed = await share("artifact:icons000001", 1, 24, "Pick one, again");
  expect(renewed.id).toBe(first.id);
  const second = await share("artifact:report00001", 2, 48);
  expect((await store.listFileShares(user)).map((row) => [row.artifactId, row.note])).toEqual([["artifact:report00001", null], ["artifact:icons000001", "Pick one, again"]]);
  expect(await store.listFileShares("user:someone-else")).toEqual([]);
  expect(await store.removeFileShare("user:someone-else", second.id)).toBe(false);
  expect(await store.removeFileShare(user, second.id)).toBe(true);
  expect((await store.listFileShares(user)).map((row) => row.id)).toEqual([first.id]);
}

it("keeps Agent File shares for the Nous app until they expire (in memory)", () => expectFileShares(new InMemoryNousRepository(), owner));

// Plan clipboard:f4SH36t3fJ6c (migration 0273): a minute adds to its hour and day once, the sums keep the peak, and reads are per owner.
async function expectLoad(store: NousRepository, user: string) {
  const minute = (at: string, overall: number, day = "2026-10-31") => store.addLoadMinute({ ownerUserId: user, at, overall, parts: { cpu: overall }, hour: at.slice(0, 13), day });
  expect(await minute("2026-10-31T06:58:00.000Z", 40)).toBe(true);
  expect(await minute("2026-10-31T06:59:00.000Z", 60)).toBe(true);
  expect(await minute("2026-10-31T06:59:00.000Z", 99)).toBe(false);
  await minute("2026-10-31T07:00:00.000Z", 50);
  await minute("2026-10-30T17:00:00.000Z", 20, "2026-10-31");
  const read = await store.listLoad(user, { minutes: "2026-10-31T06:59:00.000Z", hours: "2026-10-31T06", days: "2026-10-30" });
  expect(read.minutes).toEqual([{ at: "2026-10-31T06:59:00.000Z", overall: 60 }, { at: "2026-10-31T07:00:00.000Z", overall: 50 }]);
  expect(read.hours).toEqual([{ bucket: "2026-10-31T06", total: 100, samples: 2, peak: 60 }, { bucket: "2026-10-31T07", total: 50, samples: 1, peak: 50 }]);
  expect(read.days).toEqual([{ bucket: "2026-10-31", total: 170, samples: 4, peak: 60 }]);
  expect(await store.listLoad("user:someone-else", { minutes: "2026-01-01T00:00:00.000Z", hours: "2026", days: "2026" })).toEqual({ minutes: [], hours: [], days: [] });
}

it("keeps the Load tab's minutes and their hour and day sums (in memory)", () => expectLoad(new InMemoryNousRepository(), owner));

// Plan clipboard:1NF6u6gcCwtj (migration 0292): one Score snapshot per time, read per owner oldest first, past 30 days pruned.
async function expectScores(store: NousRepository, user: string) {
  const snap = (at: string, score: number) => store.addScoreSnapshot({ ownerUserId: user, at, score, parts: { plans: score } });
  expect(await snap("2026-10-01T00:00:00.000Z", 5)).toBe(true);
  expect(await snap("2026-11-03T15:50:00.000Z", -12.5)).toBe(true);
  expect(await snap("2026-11-03T15:50:00.000Z", 99)).toBe(false);
  expect(await snap("2026-11-03T16:00:00.000Z", -10)).toBe(true);
  expect(await store.listScoreSnapshots(user, "2026-09-01T00:00:00.000Z")).toEqual([{ at: "2026-11-03T15:50:00.000Z", score: -12.5, parts: { plans: -12.5 } }, { at: "2026-11-03T16:00:00.000Z", score: -10, parts: { plans: -10 } }]);
  expect(await store.listScoreSnapshots("user:someone-else", "2026-01-01T00:00:00.000Z")).toEqual([]);
}

it("keeps the Score snapshots for 30 days (in memory)", () => expectScores(new InMemoryNousRepository(), owner));

// The Requests tab (plan clipboard:2NOOFNJDUIMO): operator messages newest first past Clear, the operator turns' answer links (interim ones flagged), and the turns that reported outcomes.
async function expectRequestReads(store: NousRepository, user: string) {
  const add = (kind: "OPERATOR" | "ANSWER", content: string, meta?: Record<string, unknown>, turnId: string | null = null) => store.addMessage({ ownerUserId: user, turnId, kind, status: "DONE", content, ...(meta ? { meta } : {}) });
  const first = await add("OPERATOR", "one");
  await add("ANSWER", "a", { reason: "OPERATOR", startedAt: first.createdAt, replyTo: [first.id] }, "nous_turn:r1");
  await add("ANSWER", "interim", { interim: true, reason: "OPERATOR", replyTo: [first.id] }, "nous_turn:r1");
  await add("ANSWER", "inbox", { reason: "INBOX" }, "nous_turn:r2");
  await add("ANSWER", "goal reply", { startedAt: first.createdAt, replyTo: [first.id] });
  const second = await add("OPERATOR", "two");
  await store.clearMessages(user);
  expect((await store.listOperatorMessages(user, { limit: 5 })).map((row) => row.id)).toEqual([second.id, first.id]);
  expect((await store.listOperatorMessages(user, { limit: 1 })).map((row) => row.id)).toEqual([second.id]);
  expect((await store.listOperatorMessages(user, { before: second.id, limit: 5 })).map((row) => row.id)).toEqual([first.id]);
  expect((await store.listOperatorMessages(user, { since: first.createdAt, limit: 5 })).map((row) => row.id)).toEqual([second.id, first.id]);
  expect(await store.listOperatorMessages(user, { since: "2999-01-01T00:00:00.000Z", limit: 5 })).toEqual([]);
  expect(await store.listAnswerLinks(user, first.createdAt)).toEqual([{ turnId: "nous_turn:r1", createdAt: expect.any(String), startedAt: first.createdAt, replyTo: [first.id] },
    { turnId: "nous_turn:r1", createdAt: expect.any(String), startedAt: expect.any(String), replyTo: [first.id], interim: true },
    { turnId: null, createdAt: expect.any(String), startedAt: first.createdAt, replyTo: [first.id] }]);
  const facts = (turnId: string, outcomes: Parameters<NousRepository["addTurnFacts"]>[0]["outcomes"]) => store.addTurnFacts({ turnId, ownerUserId: user, reason: "OPERATOR", status: "DONE",
    tools: {}, planPoints: 0, outcomes, startedAt: first.createdAt, endedAt: first.createdAt, model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null });
  await facts(`nous_turn:${user.slice(-6)}a`, [{ summary: "s", outcome: "SELF", messageIds: [first.id], plan: "clipboard:planReads01", answerOnly: true }]);
  await facts(`nous_turn:${user.slice(-6)}b`, []);
  expect(await store.listTurnOutcomes(user, first.createdAt)).toEqual([{ turnId: `nous_turn:${user.slice(-6)}a`, endedAt: first.createdAt,
    outcomes: [{ summary: "s", outcome: "SELF", messageIds: [first.id], plan: "clipboard:planReads01", answerOnly: true }] }]);
}

it("reads the Requests tab's rows past Clear conversation (in memory)", () => expectRequestReads(new InMemoryNousRepository(), owner));

// A goal's work history (plan clipboard:jNDx8l-vMEl9): the DONE rows of the named tools in the named turns, oldest first.
async function expectTurnTools(store: NousRepository, user: string) {
  const tool = async (turnId: string, name: string, status: "DONE" | "FAILED", content: string) => {
    const row = await store.addMessage({ ownerUserId: user, turnId, kind: "TOOL", status: "RUNNING", content: "…", meta: { name } });
    await store.updateMessage(user, row.id, { status, content, meta: { name, text: content } });
  };
  const since = new Date(Date.now() - 1_000).toISOString();
  await tool("nous_turn:goal1", "space_send_to_pane", "DONE", "sent");
  await tool("nous_turn:goal1", "space_read_pane", "DONE", "read");
  await tool("nous_turn:goal1", "space_send_to_pane", "FAILED", "failed send");
  await tool("nous_turn:goal1", "space_plan_update", "DONE", "plan");
  await tool("nous_turn:other", "space_send_to_pane", "DONE", "another turn");
  const rows = await store.listTurnTools(user, ["nous_turn:goal1"], ["space_send_to_pane", "space_plan_update"], since);
  expect(rows.map((row) => [row.content, row.meta.text])).toEqual([["sent", "sent"], ["plan", "plan"]]);
  expect(await store.listTurnTools(user, ["nous_turn:goal1"], ["space_send_to_pane"], new Date(Date.now() + 60_000).toISOString())).toEqual([]);
  expect(await store.listTurnTools(user, [], ["space_send_to_pane"], since)).toEqual([]);
}

it("reads a goal turn's work tool rows (in memory)", () => expectTurnTools(new InMemoryNousRepository(), owner));

// R38-1 (28/10 22:00 → 29/10 01:59 UTC: 80 FAILED turns kept no error, so no cause): a FAILED turn is stored with its error, else a fixed reason.
async function expectFailedTurnError(store: NousRepository, user: string) {
  const base = { ownerUserId: user, reason: "INBOX" as const, tools: {}, planPoints: 0, outcomes: [], startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T10:01:00.000Z" };
  await store.addTurnFacts({ ...base, turnId: "nous_turn:r38a", status: "FAILED", error: null });
  await store.addTurnFacts({ ...base, turnId: "nous_turn:r38b", status: "FAILED", error: "  " });
  await store.addTurnFacts({ ...base, turnId: "nous_turn:r38c", status: "FAILED", error: "Invalid prompt." });
  await store.addTurnFacts({ ...base, turnId: "nous_turn:r38d", status: "DONE", error: null });
  expect((await store.listTurnFacts(user, "2026-11-02T00:00:00.000Z")).map((turn) => [turn.turnId, turn.error]).sort())
    .toEqual([["nous_turn:r38a", NOUS_TURN_FAILED_NO_ERROR], ["nous_turn:r38b", NOUS_TURN_FAILED_NO_ERROR], ["nous_turn:r38c", "Invalid prompt."], ["nous_turn:r38d", null]]);
}

it("stores a FAILED turn's error, never none (in memory)", () => expectFailedTurnError(new InMemoryNousRepository(), owner));

describe.skipIf(unavailable !== null)(`Nous repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresNousRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("nous");
    await server.createDatabase("space_nous");
    pool = server.pool("space_nous", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "nous@space.local"]);
    repository = new PostgresNousRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("keeps the newest messages in order and closes turns a restart left running", async () => {
    for (const content of ["one", "two", "three"]) await repository.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content });
    const running = await repository.addMessage({ ownerUserId: owner, turnId: "nous_turn:t1", kind: "TOOL", status: "RUNNING", content: "Reading Andy", meta: { name: "space_read_pane" } });
    expect((await repository.listMessages(owner, 2)).map((message) => message.content)).toEqual(["two", "three", "Reading Andy"]);
    expect(await repository.failRunning("The API restarted during this turn.")).toBe(1);
    const updated = await repository.updateMessage(owner, running.id, { meta: { name: "space_read_pane", result: "ok" } });
    expect(updated).toMatchObject({ status: "FAILED", meta: { result: "ok" } });
    // Stable 2026-10-22: a result clipped inside an emoji (half a surrogate pair) made jsonb refuse the row and the tool answer 500.
    const half = "🎉".slice(0, 1);
    expect((await repository.updateMessage(owner, running.id, { status: "REFUSED", meta: { result: `held ${half}` } }))?.meta).toEqual({ result: "held �" });
    expect((await repository.addMessage({ ownerUserId: owner, turnId: null, kind: "TOOL", status: "DONE", content: "x", meta: { result: `🎉 ${half}` } })).meta)
      .toEqual({ result: "🎉 �" });
    expect(await repository.clearMessages(owner)).toBe(5);
  });

  it("keeps the dialogue however many tool steps follow it", async () => {
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", ["user:nous-window", "nous-window@space.local"]);
    await expectDialogueWindow(repository, "user:nous-window");
  });

  it("pages back past the newest rows and keeps cleared rows", async () => {
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", ["user:nous-paging", "nous-paging@space.local"]);
    await expectPagingAndClear(repository, "user:nous-paging");
    expect((await pool.query("SELECT count(*)::int AS count FROM nous_messages WHERE owner_user_id = $1", ["user:nous-paging"])).rows[0].count).toBe(6);
  });

  it("reads a goal turn's work tool rows", async () => {
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", ["user:nous-goal-tools", "nous-goal-tools@space.local"]);
    await expectTurnTools(repository, "user:nous-goal-tools");
  });

  it("reads the Requests tab's rows past Clear conversation", async () => {
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", ["user:nous-reads", "nous-reads@space.local"]);
    await expectRequestReads(repository, "user:nous-reads");
  });

  it("keeps a sent attachment however old; only uploads never sent expire (Record Retention Invariant)", async () => {
    const { PostgresNousAttachmentRepository } = await import("../src/nous-attachment-repository.js");
    const files = new PostgresNousAttachmentRepository(pool);
    const file = (id: string) => files.add({ id, ownerUserId: owner, kind: "FILE", filename: "a.txt", mimeType: "text/plain", byteSize: 3, sha256: "a".repeat(64), storagePath: `/tmp/${id}`, meta: {} });
    const sent = await file(files.newId());
    const unsent = await file(files.newId());
    const message = await repository.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "with a file" });
    expect(await files.link(owner, message.id, [sent.id])).toBe(1);
    await pool.query("UPDATE nous_attachments SET created_at = now() - interval '400 days'");
    expect((await files.removeUnsent(new Date(Date.now() - 86_400_000).toISOString())).map((row) => row.id)).toEqual([unsent.id]);
    expect(await files.get(owner, sent.id)).not.toBeNull();
  });

  it("answers a decision once and keeps its action and outcome", async () => {
    const decision = await repository.createDecision({ ownerUserId: owner, category: "RELEASE", title: "Release 1.2.0", body: "All done.", options: [],
      recommendation: "Approve.", refs: { planId: "clipboard:plan01", prediction: { answer: "yes", confidence: 90 } }, action: { type: "RELEASE_APPROVE", product: "run-spaceapp" } });
    expect(await repository.listDecisions(owner, { statuses: ["OPEN"], limit: 10 })).toHaveLength(1);
    expect(await repository.listDecisions(owner, { statuses: ["OPEN"] })).toHaveLength(1);
    expect(await repository.answerDecision(owner, decision.id, { status: "APPROVED", answer: null })).toMatchObject({ status: "APPROVED" });
    expect(await repository.answerDecision(owner, decision.id, { status: "DECLINED", answer: null })).toBeNull();
    await repository.setDecisionOutcome(owner, decision.id, "Approved the run-spaceapp release train.");
    expect(await repository.getDecision(owner, decision.id)).toMatchObject({ action: { type: "RELEASE_APPROVE" }, outcome: "Approved the run-spaceapp release train." });
    // R12-11: the prediction the server stored comes back with the decision, for the ledger to score.
    expect((await repository.getDecision(owner, decision.id))!.refs.prediction).toEqual({ answer: "yes", confidence: 90 });
    expect(await repository.getDecision("user:someone", decision.id)).toBeNull();
    // The operator's feedback (migration 0213) only on an answered decision.
    expect(decision.couldHaveDecided).toBe(false);
    expect(await repository.setDecisionFeedback(owner, decision.id, true)).toMatchObject({ couldHaveDecided: true });
    const open = await repository.createDecision({ ownerUserId: owner, category: "DIRECTION", title: "Open one", body: "", options: [], recommendation: null, refs: {}, action: null });
    expect(await repository.setDecisionFeedback(owner, open.id, true)).toBeNull();
    // Operator 2/11 09:49 BKK «γιατι βλεπω ολα αυτα τα εμαιλ!!»: a decision stored with Space's account facts reads back without them; mail lines stay.
    const facts = await repository.createDecision({ ownerUserId: owner, category: "EXTERNAL", title: "Push to github.com", options: [], recommendation: null, refs: {}, action: null,
      body: "- Sign-ins for github.com: OTHER with a@example.com (0 successful); OTHER (0 successful)\n- Connected Google accounts: a@example.com, b@example.com\n"
        + "- Vault: 2 logins for github.com: github.com (a@example.com)\n\n- Mail from acme.io in 30 days: none\n"
        + "- Mail from github.com in 30 days: a@example.com: 3 threads, newest 2026-11-01 \"Your push\"\n\nPush it." });
    // The mailbox holding the threads gives way to its kind (the operator's own address, 2/11 follow-up).
    expect((await repository.getDecision(owner, facts.id))!.body)
      .toBe("- Mail from acme.io in 30 days: none\n- Mail from github.com in 30 days: 3 threads in a connected mailbox, newest 2026-11-01 \"Your push\"\n\nPush it.");
  });

  it("upserts and deletes notes, and accepts NOUS notifications", async () => {
    await repository.setNote(owner, "plan-map", "A blocks B");
    const created = (await repository.listNotes(owner))[0]!.createdAt;
    await repository.setNote(owner, "plan-map", "A blocks B; C collides with A on app.ts");
    // A rewrite keeps the note's creation time (the Score counts a lesson once, on creation).
    expect(await repository.listNotes(owner)).toEqual([expect.objectContaining({ key: "plan-map", text: "A blocks B; C collides with A on app.ts", createdAt: created })]);
    expect(created).toEqual(expect.any(String));
    await repository.setNote(owner, "plan-map", null);
    expect(await repository.listNotes(owner)).toEqual([]);
    await pool.query(`INSERT INTO space_notifications (id, owner_user_id, source, kind, severity, title, body, link, status, payload)
      VALUES ('notification:nous01', $1, 'NOUS', 'DECISION_RELEASE', 'ATTENTION', 'Nous: Release 1.2.0', '', '{}'::jsonb, 'OPEN', '{}'::jsonb)`, [owner]);
  });

  it("recovers final answer provenance and the latest successful model", async () => {
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", ["user:provenance", "provenance@space.local"]);
    await expectProvenance(repository, "user:provenance");
  });

  it("keeps one facts row per turn (migration 0212) after the conversation is cleared", async () => {
    const facts = { turnId: "nous_turn:facts1", ownerUserId: owner, reason: "OPERATOR" as const, status: "DONE" as const, planPoints: 15,
      tools: { space_world: { calls: 1, failed: 0, refused: 0 }, space_send_to_pane: { calls: 2, failed: 1, refused: 1 } },
      outcomes: [{ summary: "Recreate a room", outcome: "HELPER" as const, missing: "create a room" }],
      startedAt: "2026-10-17T10:00:00.000Z", endedAt: "2026-10-17T10:02:00.000Z" };
    await repository.addTurnFacts(facts);
    await repository.addTurnFacts({ ...facts, status: "FAILED" });
    await repository.addTurnFacts({ ...facts, turnId: "nous_turn:facts0", startedAt: "2026-10-16T10:00:00.000Z" });
    // Since 2026-10-21 (migration 0243): what the turn ran on and cost; STANDING turns; older rows read as null.
    const priced = { ...facts, turnId: "nous_turn:facts2", reason: "STANDING" as const, startedAt: "2026-10-17T11:00:00.000Z", endedAt: "2026-10-17T11:01:00.000Z",
      model: "claude-opus-5-5", effort: "xhigh", costUsd: 0.912345, tokens: { "claude-opus-5-5": { outputTokens: 300 } } };
    await repository.addTurnFacts(priced);
    // The daily self-review's own turns (migration 0249, 2026-10-24).
    const review = { ...priced, turnId: "nous_turn:facts3", reason: "REVIEW" as const, startedAt: "2026-10-17T11:30:00.000Z", endedAt: "2026-10-17T11:31:00.000Z" };
    await repository.addTurnFacts(review);
    // The goal loop's turns carry their goal (migration 0257, 2026-10-27); every other row reads goalId null.
    const goal = { ...priced, turnId: "nous_turn:facts4", reason: "GOAL" as const, startedAt: "2026-10-17T11:40:00.000Z", endedAt: "2026-10-17T11:41:00.000Z", goalId: "nous_goal:abcdef123456" };
    await repository.addTurnFacts(goal);
    // R11-1 (migration 0261): a failed turn keeps its short error; every other row reads error null.
    const refused = { ...priced, turnId: "nous_turn:facts5", reason: "INBOX" as const, status: "FAILED" as const, startedAt: "2026-10-17T11:50:00.000Z", endedAt: "2026-10-17T11:50:03.000Z",
      error: "API Error: Connection refused (ECONNREFUSED)",
      // 2/11 REVIEW: each tool's first mistake of the turn, in the tools jsonb (no migration).
      tools: { ...facts.tools, space_open_panes: { calls: 2, failed: 1, refused: 0, error: "Room Alex is capped at 16 active panes" } } };
    await repository.addTurnFacts(refused);
    await repository.clearMessages(owner);
    expect(await repository.listTurnFacts(owner, "2026-10-17T00:00:00.000Z")).toEqual([{ ...facts, model: null, effort: null, costUsd: null, tokens: null, goalId: null, error: null },
      { ...priced, goalId: null, error: null }, { ...review, goalId: null, error: null }, { ...goal, error: null }, { ...refused, goalId: null }]);
    expect(await repository.listTurnFacts(owner, "2026-10-16T00:00:00.000Z")).toHaveLength(6);
    expect(await repository.listTurnFacts("user:someone", "2026-10-16T00:00:00.000Z")).toEqual([]);
  });

  it("stores a FAILED turn's error, never none (R38-1)", async () => {
    await expectFailedTurnError(repository, owner);
  });

  it("keeps Agent File shares for the Nous app until they expire, and prunes expired ones", async () => {
    await expectFileShares(repository, owner);
    expect((await pool.query("SELECT artifact_id FROM nous_file_shares WHERE artifact_id = 'artifact:old0000001'")).rowCount).toBe(0);
  });

  it("keeps the Load tab's minutes and their hour and day sums once, and prunes minutes past 30 days on the hour (migration 0273)", async () => {
    await expectLoad(repository, owner);
    await repository.addLoadMinute({ ownerUserId: owner, at: "2026-09-20T00:00:00.000Z", overall: 10, parts: {}, hour: "2026-09-20T00", day: "2026-09-20" });
    await repository.addLoadMinute({ ownerUserId: owner, at: "2026-11-01T00:00:00.000Z", overall: 10, parts: {}, hour: "2026-11-01T00", day: "2026-11-01" });
    expect((await pool.query("SELECT 1 FROM nous_load_samples WHERE owner_user_id = $1 AND at = '2026-09-20T00:00:00Z'", [owner])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM nous_load_rollups WHERE owner_user_id = $1 AND bucket = '2026-09-20'", [owner])).rowCount).toBe(1);
  });

  it("keeps the Score snapshots once per time and prunes those past 30 days (migration 0292)", async () => {
    await expectScores(repository, owner);
  });

  it("appends decision ledger rows newest first, clips them, and prunes rows past 180 days (migration 0259, goal 7365014c-e)", async () => {
    await pool.query(`INSERT INTO nous_decision_ledger (owner_user_id, at, source, kind, title, answer) VALUES ($1, now() - interval '200 days', 'NOUS_DECISION', 'k', 'Old', 'APPROVED')`, [owner]);
    for (const store of [repository, new InMemoryNousRepository()]) {
      await store.appendLedger({ ownerUserId: owner, source: "NOUS_DECISION", kind: "EXTERNAL", title: "Send the mail?", predicted: "APPROVE", answer: "DECLINED: not today", match: false, ref: "nous_decision:a" });
      await store.appendLedger({ ownerUserId: owner, source: "NEEDS_YOU:AGENT", kind: "needs-you:k", title: "x".repeat(400), predicted: "Blue", answer: "Blue", match: true, ref: null });
      const rows = await store.listLedger(owner, "2000-01-01T00:00:00.000Z");
      expect(rows.map((row) => [row.source, row.title.length, row.predicted, row.answer, row.match])).toEqual([
        ["NEEDS_YOU:AGENT", 300, "Blue", "Blue", true], ["NOUS_DECISION", 14, "APPROVE", "DECLINED: not today", false]]);
      expect(rows[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(await store.listLedger("user:someone", "2000-01-01T00:00:00.000Z")).toEqual([]);
    }
  });
});
