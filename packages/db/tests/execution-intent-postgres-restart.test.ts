// Execution intent across a real PostgreSQL restart (failure matrix, CORE-001).
// A disposable server with every migration applied is restarted while the
// production store is inside a Chat submission transaction, and again after the
// server committed but before the client saw COMMIT. Nothing may be lost or
// duplicated: an open transaction leaves no partial intent, an uncertain commit
// is reconciled by the submission key, and the stranded-run sweep only offers a
// retry for Chat runs whose workflow never started. Skips without Docker.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodexAppServerTurnWorkflowId, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { CanonicalMemoryEmbeddings } from "../src/canonical-memory-embeddings.js";
import { PostgresDotsRepository } from "../src/dots-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const database = "intent_restart";
const holdLock = 4242;
const unavailable = disposablePostgresUnavailableReason();
if (unavailable) process.stderr.write(`[execution intent restart] skipped: ${unavailable}\n`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
const errorShape = (error: unknown) => ({
  name: error instanceof Error ? error.name : typeof error,
  code: (error as { code?: unknown })?.code ?? null,
  message: error instanceof Error ? error.message.slice(0, 120) : null
});

/** A Unix-socket proxy that withholds the server's CommandComplete(COMMIT) once armed. */
async function startCommitProxy(serverSocketDir: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pg-commit-"));
  const peers = new Set<Socket>();
  let armed: (() => void) | null = null;
  let withheld = 0;
  const server = createServer((downstream) => {
    const upstream = createConnection(path.join(serverSocketDir, ".s.PGSQL.5432"));
    peers.add(downstream); peers.add(upstream);
    const close = () => { downstream.destroy(); upstream.destroy(); };
    for (const peer of [downstream, upstream]) {
      peer.on("error", close);
      peer.on("close", () => { peers.delete(peer); close(); });
    }
    downstream.pipe(upstream);
    let pending = Buffer.alloc(0);
    let silenced = false;
    upstream.on("data", (chunk: Buffer) => {
      if (silenced) return;
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        // Server frame: tag byte + int32 length that includes itself.
        const size = pending.readInt32BE(1) + 1;
        if (size < 5 || size > 16 * 1024 * 1024) { close(); return; }
        if (pending.length < size) return;
        const frame = pending.subarray(0, size);
        pending = pending.subarray(size);
        const tag = frame[0] === 67 ? frame.subarray(5, -1).toString("utf8") : "";
        if (tag === "COMMIT" && armed) {
          // The server has committed. Forward nothing more on this connection;
          // the restart, not the proxy, ends it.
          silenced = true;
          withheld++;
          const onCommit = armed;
          armed = null;
          onCommit();
          return;
        }
        downstream.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(dir, ".s.PGSQL.5432"), resolve);
  });
  return {
    dir,
    arm(onCommit: () => void) { armed = onCommit; },
    get withheld() { return withheld; },
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  };
}

describe.skipIf(unavailable !== null)(`execution intent across a PostgreSQL restart${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let observer: pg.Pool;
  let store: PostgresSpaceStore;

  beforeAll(async () => {
    server = await startDisposablePostgres("intent-restart");
    await server.createDatabase(database);
    pool = server.pool(database, 4);
    observer = server.pool(database, 2);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    store = new PostgresSpaceStore(pool);
  }, 240_000);

  afterAll(async () => {
    await server?.stop();
  }, 120_000);

  async function chatPane(label: string) {
    const room = await store.createRoom({ kind: "AGENT_PROOF", name: `AGENT_PROOF intent ${label}`, initialPaneCount: 1 });
    const pane = (await store.listPanes(room.id))[0]!;
    const session = await store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Chat",
      selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
      selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null });
    return { room, pane, session };
  }

  function submission(chat: Awaited<ReturnType<typeof chatPane>>, key: string) {
    const content = `Synthetic request ${key}`;
    return {
      content,
      run: {
        clientRequestId: `client:${key}`,
        requestFingerprint: createHash("sha256").update(content).digest("hex"),
        sessionId: chat.session.sessionId, paneId: chat.pane.id, roomId: chat.room.id,
        workflowId: `space-turn:${key}`, temporalRunId: null, status: "QUEUED" as const,
        promptMessageId: `message:prompt-${key}`, responseMessageId: `message:response-${key}`,
        codexThreadId: null, codexTurnId: null
      }
    };
  }

  async function persisted(input: ReturnType<typeof submission>) {
    const runs = await observer.query<{ run_id: string; status: string }>(
      "SELECT run_id, status FROM space_agent_runs WHERE pane_id = $1 AND client_request_id = $2", [input.run.paneId, input.run.clientRequestId]);
    const messages = await observer.query<{ message_id: string; run_id: string | null }>(
      "SELECT message_id, run_id FROM space_agent_messages WHERE message_id = ANY($1) ORDER BY message_id",
      [[input.run.promptMessageId, input.run.responseMessageId]]);
    const session = await observer.query<{ status: string }>("SELECT status FROM space_agent_sessions WHERE session_id = $1", [input.run.sessionId]);
    return { runs: runs.rows, messages: messages.rows, sessionStatus: session.rows[0]?.status ?? null };
  }

  it.each(["graceful", "crash"] as const)(
    "a %s restart inside the open submission transaction commits nothing; the keyed retry creates exactly one run",
    async (mode) => {
      const chat = await chatPane(`open-${mode}`);
      const input = submission(chat, `open-tx-${mode}`);
      const before = await persisted(input);
      // Hold the transaction after both messages are written, at the run INSERT.
      await observer.query(`CREATE OR REPLACE FUNCTION fault_hold_run_insert() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN PERFORM pg_advisory_xact_lock(${holdLock}); RETURN NEW; END $$`);
      await observer.query(`CREATE TRIGGER fault_hold_run_insert BEFORE INSERT ON space_agent_runs
        FOR EACH ROW EXECUTE FUNCTION fault_hold_run_insert()`);
      const holder = await server.pool(database, 1).connect();
      let outcome: unknown;
      try {
        await holder.query("SELECT pg_advisory_lock($1)", [holdLock]);
        const pending = store.createSpaceAgentSubmission(input, `trace:open-tx-${mode}`).then(() => "COMMITTED", (error) => error);
        await waitFor(async () => (await observer.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'",
          [database])).rows[0]!.n === 1, "the submission transaction to block inside the run INSERT");
        await server.restart(mode);
        outcome = await pending;
      } finally {
        holder.release(true);
        await waitFor(async () => {
          try {
            await observer.query("DROP TRIGGER IF EXISTS fault_hold_run_insert ON space_agent_runs");
            await observer.query("DROP FUNCTION IF EXISTS fault_hold_run_insert()");
            return true;
          } catch { return false; }
        }, "the fault trigger to be removed");
      }
      // The caller sees the connection failure itself, not a masking ROLLBACK error,
      // so a transient store outage stays classifiable (57P01 on a graceful restart).
      expect(errorShape(outcome)).toEqual(mode === "graceful"
        ? { name: "error", code: "57P01", message: "terminating connection due to administrator command" }
        : { name: "Error", code: null, message: "Connection terminated unexpectedly" });
      // No partial intent: neither the messages written inside the transaction nor the run nor the session change survived.
      expect(await persisted(input)).toEqual(before);
      expect(before.runs).toEqual([]);
      expect(before.messages).toEqual([]);

      // The client retries with the same submission key: one run, then a replay of it.
      const created = await store.createSpaceAgentSubmission(input);
      const replayed = await store.createSpaceAgentSubmission(input);
      expect(created.created).toBe(true);
      expect(replayed).toMatchObject({ created: false, run: { runId: created.run.runId } });
      const after = await persisted(input);
      expect(after.runs).toEqual([{ run_id: created.run.runId, status: "QUEUED" }]);
      expect(after.messages.map((message) => message.run_id)).toEqual([created.run.runId, created.run.runId]);
      expect(after.sessionStatus).toBe("RUNNING");
    },
    120_000
  );

  it.each(["graceful", "crash"] as const)(
    "a %s restart after the server committed but before the client saw COMMIT keeps one submission; the keyed retry replays it",
    async (mode) => {
      const chat = await chatPane(`ack-${mode}`);
      const input = submission(chat, `uncertain-commit-${mode}`);
      const proxy = await startCommitProxy(server.socketDir);
      const proxied = new pg.Pool({ host: proxy.dir, user: "postgres", database, max: 1, connectionTimeoutMillis: 10_000 });
      // Same listeners as createSpacePgPool: a terminated client never becomes an unhandled 'error'.
      proxied.on("error", () => {});
      proxied.on("connect", (client) => client.on("error", () => {}));
      try {
        const proxiedStore = new PostgresSpaceStore(proxied);
        await proxied.query("SELECT 1");
        let restarted: Promise<void> = Promise.resolve();
        proxy.arm(() => { restarted = server.restart(mode); });
        const outcome = await proxiedStore.createSpaceAgentSubmission(input, `trace:uncertain-${mode}`).then(() => "ACKNOWLEDGED", (error) => error);
        await restarted;
        expect(proxy.withheld).toBe(1);
        // For the client the outcome is ambiguous: the connection ended while COMMIT was in flight.
        expect(errorShape(outcome)).toEqual({ name: "Error", code: null, message: "Connection terminated unexpectedly" });
        // The commit is durable even though its acknowledgement was lost.
        const committed = await persisted(input);
        expect(committed.runs).toHaveLength(1);
        expect(committed.runs[0]!.status).toBe("QUEUED");
        expect(committed.messages.map((message) => message.run_id)).toEqual([committed.runs[0]!.run_id, committed.runs[0]!.run_id]);
        // Reconciliation by key: the retry returns the committed run instead of writing a second one.
        const retried = await proxiedStore.createSpaceAgentSubmission(input);
        expect(retried).toMatchObject({ created: false, run: { runId: committed.runs[0]!.run_id } });
        expect(await persisted(input)).toEqual(committed);
      } finally {
        await proxied.end();
        await proxy.close();
      }
    },
    120_000
  );

  it("offers the stranded-run retry only for a Chat run whose workflow never started, never for a queued Room Agent turn", async () => {
    // A Chat submission committed by an API that stopped before starting its workflow.
    const chat = await chatPane("stranded");
    const stranded = await store.createSpaceAgentSubmission(submission(chat, "stranded-chat"));
    // A Room Agent turn waiting in its supervisor queue: its child workflow does
    // not exist until the supervisor reaches it, possibly many minutes later.
    const room = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF stranded room agent", initialPaneCount: 0 });
    const agentPane = await store.getOrCreateRoomAgentPane(room.id);
    const agentSession = await store.createSpaceAgentSession({ paneId: agentPane.id, roomId: room.id, title: "Room Agent",
      selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
      selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null });
    const id = `${room.id}-queued`;
    const missionId = `mission:${room.id}`;
    const queueItem = roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
      roomId: room.id, paneId: agentPane.id, prompt: "Queued behind the active turn.", roomAgentOperatorRequest: "Queued behind the active turn.",
      agentSessionId: agentSession.sessionId, agentRunId: `run:${id}`, agentUserMessageId: `message:context-${id}`,
      agentAssistantMessageId: `message:response-${id}`, roomAgentMissionId: missionId, traceId: `trace:${id}`
    } });
    const queued = await store.enqueueRoomAgentMission({ requestId: `request:${id}`, clientRequestId: `client:${id}`,
      content: "Queued behind the active turn.", supervisorWorkflowId: `room-supervisor:${room.id}`,
      childWorkflowId: buildCodexAppServerTurnWorkflowId(queueItem.turn), promptMessageId: queueItem.turn.agentUserMessageId!,
      responseMessageId: queueItem.turn.agentAssistantMessageId!, runId: queueItem.turn.agentRunId!, queueItem });
    expect(queued.run.status).toBe("QUEUED");
    await observer.query("UPDATE space_agent_runs SET created_at = now() - interval '30 minutes' WHERE run_id = ANY($1)",
      [[stranded.run.runId, queued.run.runId]]);

    const repository = new PostgresDotsRepository(pool);
    const stale = (await repository.listStaleQueuedRuns(180, 100)).map((run) => run.runId);
    expect(stale).toContain(stranded.run.runId);
    expect(stale).not.toContain(queued.run.runId);

    // Failing is a compare-and-set on QUEUED: once only, and never after a worker moved the run on.
    expect(await repository.failStrandedRun(stranded.run.runId, "This task did not start. Retry it.")).toBe(true);
    expect(await repository.failStrandedRun(stranded.run.runId, "This task did not start. Retry it.")).toBe(false);
    expect((await store.getLatestSpaceAgentRun(chat.session.sessionId))).toMatchObject({ status: "FAILED", errorCode: "SPACE_AGENT_RUNTIME_NOT_STARTED" });

    // RUNNING: a started Chat turn without progress is listed for the Temporal check; a running Room Agent turn is not.
    const lostChat = await chatPane("lost-running");
    const lost = await store.createSpaceAgentSubmission(submission(lostChat, "lost-running"));
    await store.updateSpaceAgentRun(lost.run.runId, { status: "RUNNING" });
    await store.updateSpaceAgentRun(queued.run.runId, { status: "RUNNING" });
    await observer.query("UPDATE space_agent_runs SET updated_at = now() - interval '30 minutes' WHERE run_id = ANY($1)",
      [[lost.run.runId, queued.run.runId]]);
    const running = (await repository.listStaleRunningRuns(180, 100)).map((run) => run.runId);
    expect(running).toContain(lost.run.runId);
    expect(running).not.toContain(queued.run.runId);
    expect(await repository.failLostRunningRun(lost.run.runId, "The result is unknown.")).toBe(true);
    expect(await repository.failLostRunningRun(lost.run.runId, "The result is unknown.")).toBe(false);
    expect(await repository.failStrandedRun(lost.run.runId, "This task did not start. Retry it.")).toBe(false);
    expect((await store.getLatestSpaceAgentRun(lostChat.session.sessionId))).toMatchObject({
      status: "FAILED", errorCode: "SPACE_AGENT_RUN_OUTCOME_UNKNOWN", errorMessage: "The result is unknown."
    });
  }, 60_000);

  it("keeps the canonical-memory embedding pool usable across a restart without an unhandled idle-client error", async () => {
    const repository = CanonicalMemoryEmbeddings.fromConnectionString(
      `postgresql://postgres@localhost/${database}?host=${encodeURIComponent(server.socketDir)}`);
    try {
      // Leaves one idle pooled client, which the restart terminates.
      expect(await repository.list("fixture-provider", "fixture-model")).toEqual([]);
      await server.restart("graceful");
      await sleep(250);
      expect(await repository.list("fixture-provider", "fixture-model")).toEqual([]);
      // DATA-004: the sync removes the vectors of entries that left the canonical list.
      for (const [id, hash] of [["memory:kept-entry", "a".repeat(64)], ["memory:removed-entry", "b".repeat(64)]]) {
        await repository.upsert({ id: id!, hash: hash!, provider: "fixture-provider", model: "fixture-model", embedding: Array(1536).fill(0.1) });
      }
      await repository.remove(["memory:removed-entry"]);
      expect(await repository.list("fixture-provider", "fixture-model")).toEqual([{ id: "memory:kept-entry", inputHash: "a".repeat(64) }]);
    } finally {
      await repository.close();
    }
  }, 120_000);
});
