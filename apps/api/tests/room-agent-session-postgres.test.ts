import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSpaceStore, createSpacePgPool } from "../../../packages/db/src/space-store.js";
import { loadMigrations } from "../../../packages/db/src/migrations.js";
import { applyMigration } from "../../../packages/db/src/migration-runner.js";
import { disposablePostgresUnavailableReason } from "../../../packages/db/tests/support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

// Real PostgreSQL, owned synthetic data only. Never reads production config.
// The image must already exist locally; tests never pull or install software.
describe.skipIf(postgresUnavailable)("Hidden Room Agent PostgreSQL session lifecycle", () => {
  const name = `space-live-room-session-proof-${randomUUID()}`;
  let created = false, directory: string, url: string, pool: ReturnType<typeof createSpacePgPool>;
  let store: PostgresSpaceStore;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const connect = async () => {
    pool = createSpacePgPool(url, { max: 6 });
    store = new PostgresSpaceStore(pool);
    let failure = "unknown";
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        // The image's temporary init server also accepts SQL, then shuts down.
        // Wait for PID 1 to become the final server before applying migrations.
        if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error("Initializing proof database.");
        await pool.query("SELECT 1"); return;
      }
      catch (error) { failure = error instanceof Error ? error.message : "unknown"; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    throw Error(`Owned PostgreSQL proof container did not become ready: ${failure}. ${docker(["logs", "--tail", "5", name])}`);
  };
  beforeAll(async () => {
    docker(["image", "inspect", "pgvector/pgvector:0.8.7-pg17-trixie", "--format", "{{.Id}}"]);
    directory = await mkdtemp(`${tmpdir()}/space-pg-`);
    const socket = `${directory}/pg-socket`;
    await mkdir(socket, { mode: 0o777 });
    docker(["run", "--detach", "--rm", "--pull=never", "--name", name,
      "--label", "space.agent.task=ai-live-history-proof", "--network", "none",
      "--mount", `type=bind,source=${socket},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:0.8.7-pg17-trixie", "-c", "listen_addresses="]);
    created = true;
    url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`;
    await connect();
    const client = await pool.connect();
    try {
      await client.query("CREATE TABLE space_schema_migrations (id text PRIMARY KEY, filename text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const migration of await loadMigrations()) await applyMigration(client, migration);
    } finally { client.release(); }
  }, 60_000);
  afterAll(async () => {
    try { await pool?.end(); }
    finally {
      if (created) {
        try { docker(["exec", "--user", "root", name, "chmod", "0777", "/var/run/postgresql"]); }
        finally { docker(["rm", "--force", "--volumes", name]); }
      }
      if (directory) await rm(directory, { force: true, recursive: true });
    }
  });
  it("keeps bound hidden sessions active across completion, maintenance and PostgreSQL restart", async () => {
    const room = await store.createRoom({ kind: "AGENT_PROOF", name: "AGENT_PROOF hidden session", initialPaneCount: 0 });
    const pane = await store.getOrCreateRoomAgentPane(room.id);
    expect(pane.isClosed).toBe(true);
    const session = await store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Room Agent",
      selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
      selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null });
    const prompt = await store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Synthetic allocation" });
    const response = await store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "Queued" });
    const run = await store.createSpaceAgentRun({ sessionId: session.sessionId, roomId: room.id, paneId: pane.id,
      workflowId: "workflow:synthetic-allocation", status: "RUNNING", promptMessageId: prompt.messageId, responseMessageId: response.messageId });
    const complete = () => store.completeSpaceAgentRun({ runId: run.runId, sessionId: session.sessionId, responseMessageId: response.messageId,
      responseContent: "Background queued", finalResponse: "Background queued", codexThreadId: null, codexTurnId: null,
      sourceType: "ROOM_AGENT", traceId: "trace:synthetic", completedAt: new Date().toISOString() });
    await complete();
    expect((await store.getSpaceAgentSession(session.sessionId))?.isActive).toBe(true);
    expect(await store.reconcileStaleSpaceAgentSessions()).toBe(0);
    await pool.end(); docker(["restart", "--time", "5", name]); await connect();
    expect((await store.getActiveSpaceAgentSession(pane.id))?.sessionId).toBe(session.sessionId);
    await store.updateSpaceAgentSession(session.sessionId, { isActive: false });
    await complete();
    expect((await store.getSpaceAgentSession(session.sessionId))?.isActive).toBe(false);
  }, 60_000);
});
