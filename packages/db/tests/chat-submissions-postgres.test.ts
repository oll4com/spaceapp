import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool, PostgresSpaceStore } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { applyMigration } from "../src/migration-runner.js";
import type { CreateSpaceAgentRunInput } from "@space/contracts";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("atomically accepts Chat submissions across PostgreSQL connections, rejects conflicts and rolls back partial writes", async () => {
  const name = `space-chat-submissions-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 6 });
  let created = false;
  try {
    const image = "pgvector/pgvector:0.8.7-pg17-trixie";
    docker(["image", "inspect", image]);
    docker(["run", "--detach", "--rm", "--pull=never", "--name", name, "--network", "none",
      "--mount", `type=bind,source=${socket},target=/var/run/postgresql`, "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
      image, "-c", "listen_addresses="]);
    created = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error("Initializing");
        await pool.query("SELECT 1"); ready = true; break;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw Error("Owned PostgreSQL did not become ready.");
    const client = await pool.connect();
    try {
      await client.query("CREATE TABLE space_schema_migrations(id text PRIMARY KEY,filename text NOT NULL,applied_at timestamptz DEFAULT now())");
      for (const migration of await loadMigrations()) await applyMigration(client, migration);
    } finally { client.release(); }
    const store = new PostgresSpaceStore(pool);
    const other = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ name: "Agent Proof Chat submission transactions", kind: "AGENT_PROOF", initialPaneCount: 1 });
    const pane = (await store.listPanes(room.id))[0]!;
    const session = await store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Submission test",
      selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null, selectedProviderName: null,
      selectedModelName: null, selectedReasoningKey: null });
    const input = (key: string): { content: string; run: CreateSpaceAgentRunInput } => ({ content: "Original request", run: {
      runId: `agent_run:${key}`, sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
      workflowId: `workflow:${key}`, promptMessageId: `agent_msg:user-${key}`, responseMessageId: `agent_msg:assistant-${key}`,
      status: "QUEUED", clientRequestId: `request:${key}`, requestFingerprint: "a".repeat(64),
      execution: { traceId: `trace:${key}`, modelConfigId: null, providerId: null, providerName: null,
        requestedModel: null, requestedReasoning: null, attachments: [] }
    } });
    const request = input("first");
    const duplicate = input("duplicate"); duplicate.run.clientRequestId = request.run.clientRequestId;
    const accepted = await Promise.all([store.createSpaceAgentSubmission(request), other.createSpaceAgentSubmission(duplicate)]);
    expect(accepted.map(value => value.created).sort()).toEqual([false, true]);
    expect(accepted[0]!.run.runId).toBe(accepted[1]!.run.runId);
    expect(await store.countSpaceAgentMessages(session.sessionId)).toBe(2);
    const run = accepted[0]!.run;
    expect((await new PostgresSpaceStore(pool).getSpaceAgentSubmission(pane.id, request.run.clientRequestId!))?.runId).toBe(run.runId);
    expect((await store.getLatestSpaceAgentRun(session.sessionId))?.clientRequestId).toBe(request.run.clientRequestId);
    await expect(store.createSpaceAgentSubmission({ ...request, run: { ...request.run, requestFingerprint: "b".repeat(64) } })).rejects.toThrow("different request");
    await expect(store.createSpaceAgentSubmission(input("other"))).rejects.toThrow("active task");
    expect(await store.countSpaceAgentMessages(session.sessionId)).toBe(2);
    expect(run.ledger?.evaluation.status).toBe("PENDING");
    const running = await store.updateSpaceAgentRun(run.runId, { status: "RUNNING", runtimeModelAtStart: "actual-runtime" });
    await store.completeSpaceAgentRun({ runId: run.runId, sessionId: session.sessionId,
      responseMessageId: run.responseMessageId, responseContent: "Answer", finalResponse: "Answer",
      sourceType: "CHAT", codexThreadId: "thread:ledger", codexTurnId: "turn:ledger",
      traceId: "trace:ledger", completedAt: new Date().toISOString() });
    const reloaded = await other.getLatestSpaceAgentRun(session.sessionId);
    expect(reloaded?.ledger).toMatchObject({ model: { value: "actual-runtime", source: "RUNTIME_START", observedAt: running.ledger!.model.observedAt },
      cost: { status: "UNKNOWN", amountUsd: null }, evaluation: { status: "UNSCORABLE" } });
    // Completion persists checks and answer together, readable by another connection.
    await store.completeSpaceAgentRun({ runId: run.runId, sessionId: session.sessionId,
      responseMessageId: run.responseMessageId, responseContent: "Answer", finalResponse: "Answer",
      sourceType: "CHAT", codexThreadId: "thread:ledger", codexTurnId: "turn:ledger", traceId: "trace:ledger",
      completedAt: new Date().toISOString(), evaluation: { status: "SCORED", reason: null,
        assessedAt: new Date().toISOString(), evaluator: "space:objective-validator", rubricVersion: "declared-checks-v1",
        qualityScore: 0, criticalFailure: true, evidenceIds: [run.runId, run.responseMessageId],
        validation: { scope: "DECLARED_CHECKS_ONLY", resultSha256: "b".repeat(64),
          checks: [{ id: "answer", kind: "TEXT_EQUALS", passed: false, critical: true }] } } });
    expect((await other.getLatestSpaceAgentRun(session.sessionId))?.ledger?.evaluation).toMatchObject({
      status: "SCORED", criticalFailure: true, validation: { scope: "DECLARED_CHECKS_ONLY" } });
    // The second completion replayed an unchanged answer: it recorded the evaluation but did not
    // append a second TURN_COMPLETED event for the run.
    const completedEvents = (await other.listEvents(room.id)).filter((event) =>
      event.type === "TURN_COMPLETED" && (event.payload as { runId?: string }).runId === run.runId);
    expect(completedEvents).toHaveLength(1);
    for (const status of ["FAILED", "INTERRUPTED"] as const) {
      await store.updateSpaceAgentRun(run.runId, { status });
      expect((await other.getLatestSpaceAgentRun(session.sessionId))?.ledger?.evaluation).toMatchObject({ status: "UNSCORABLE",
        reason: expect.stringContaining(status === "FAILED" ? "failed" : "stopped") });
    }
    await expect(pool.query("UPDATE space_agent_runs SET task_ledger = '{}'::jsonb WHERE run_id = $1", [run.runId])).rejects.toThrow();
    // Old writers can still omit the additive column; updating an old run must
    // preserve its reported model without manufacturing an observation time.
    await pool.query("UPDATE space_agent_runs SET task_ledger = NULL WHERE run_id = $1", [run.runId]);
    expect((await other.getLatestSpaceAgentRun(session.sessionId))?.ledger).toBeNull();
    await store.updateSpaceAgentRun(run.runId, { status: "COMPLETED" });
    expect((await other.getLatestSpaceAgentRun(session.sessionId))?.ledger?.model).toEqual({
      value: "actual-runtime", source: "RUNTIME_START", scope: "STARTUP_ONLY", observedAt: null });
    expect((await other.createSpaceAgentSubmission(request)).created).toBe(false);

    // Force failure after both messages were inserted, at the run insert.
    const broken = input("rollback"); broken.run.runId = run.runId;
    await expect(store.createSpaceAgentSubmission(broken)).rejects.toThrow();
    expect(await store.countSpaceAgentMessages(session.sessionId)).toBe(2);
    expect(await store.getSpaceAgentSubmission(pane.id, broken.run.clientRequestId!)).toBeNull();
    expect((await store.createSpaceAgentSubmission(input("rollback"))).created).toBe(true);
    expect(await store.countSpaceAgentMessages(session.sessionId)).toBe(4);
    const events = (await store.listEvents(room.id)).filter(event => event.type === "TURN_STARTED");
    expect(events).toHaveLength(2);
  } finally {
    await pool.end();
    if (created) {
      try { docker(["exec", "--user", "root", name, "chmod", "0777", "/var/run/postgresql"]); }
      finally { docker(["rm", "--force", "--volumes", name]); }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
