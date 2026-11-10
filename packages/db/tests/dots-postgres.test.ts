import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("migrates legacy threads in place and isolates six durable dots across owners and old writers", async () => {
  const migrations = await loadMigrations();
  const migration = migrations.find(item => item.id === "0131_space_dots");
  expect(migration, "Stage 1 migration must exist").toBeDefined();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-dots-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 6 });
  let created = false;
  try {
    docker(["run", "--detach", "--rm", "--pull=never", "--name", name, "--network", "none", "--mount", `type=bind,source=${socket},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:0.8.7-pg17-trixie", "-c", "listen_addresses="]);
    created = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error(); await pool.query("SELECT 1"); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw Error("Owned PostgreSQL did not become ready.");
    for (const item of migrations.filter(item => item.id < migration!.id)) await pool.query(item.sql);
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('dots:a','a@dots.test','ADMIN'),('dots:b','b@dots.test','ADMIN');
      INSERT INTO rooms(id,name,trace_id,owner_user_id) VALUES ('dots:room','Dots proof','dots:trace','dots:a');
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('dots:pane','dots:room','Chat','CHAT','IDLE',0);
      INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,thread_id,is_active) VALUES
        ('dots:old1','dots:pane','dots:room','RUNNING','One','native:one',true),
        ('dots:old2','dots:pane','dots:room','READY','Two','native:two',false);
      INSERT INTO memory_records(id,scope,room_id,title,body,provenance) VALUES ('dots:memory','ROOM','dots:room','Memory','private','test'),('dots:shared','GLOBAL',null,'Global','shared','test');
      INSERT INTO space_control_records(kind,actor_id,record_key,room_id,value) VALUES ('schedule','dots:a','dots:schedule','dots:room','{"status":"SCHEDULED"}');`);
    const before = (await pool.query("SELECT session_id,thread_id,status,is_active,updated_at FROM space_agent_sessions ORDER BY session_id")).rows;
    await pool.query(migration!.sql);
    expect((await pool.query("SELECT session_id,thread_id,status,is_active,updated_at FROM space_agent_sessions ORDER BY session_id")).rows).toEqual(before);
    const { PostgresDotsRepository } = await import("../src/dots-repository.js");
    const repository = new PostgresDotsRepository(pool);
    const [a, b] = await Promise.all([repository.list("dots:a"), repository.list("dots:b")]);
    expect(a.map(dot => dot.name)).toEqual(["Orbit", "Nova", "Byte", "Comet", "Luna", "Cosmo"]);
    expect(new Set([...a, ...b].map(dot => dot.dotId)).size).toBe(12);
    expect(await repository.get("dots:b", a[0]!.dotId)).toBeNull();
    expect(await repository.update("dots:b", a[0]!.dotId, { name: "Stolen" })).toBeNull();
    const renamed = await repository.update("dots:a", a[1]!.dotId, { name: "My Nova", preferences: { communicationStyle: "Concise", language: "el" } });
    expect(renamed?.name).toBe("My Nova");
    expect((await new PostgresDotsRepository(pool).list("dots:a"))[1]).toEqual(renamed);
    expect((await repository.related("dots:a", a[0]!.dotId, "sessions", 50, 0))?.map(row => row.sessionId).sort()).toEqual(["dots:old1", "dots:old2"]);
    expect(await repository.related("dots:a", a[1]!.dotId, "sessions", 50, 0)).toEqual([]);
    expect(await repository.related("dots:b", a[0]!.dotId, "memory", 50, 0)).toBeNull();
    expect((await repository.related("dots:a", a[0]!.dotId, "memory", 50, 0))?.map(row => row.id)).toEqual(["dots:memory"]);
    expect((await pool.query("SELECT dot_id FROM memory_records WHERE id='dots:shared'")).rows[0]).toEqual({ dot_id: null });
    expect((await repository.related("dots:a", a[0]!.dotId, "schedules", 50, 0))?.[0]?.dotId).toBe(a[0]!.dotId);
    await pool.query("INSERT INTO users(id,email,role) VALUES ('dots:new','new@dots.test','ADMIN')");
    expect(await repository.list("dots:new")).toHaveLength(6);
    await pool.query(`INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,is_active) VALUES ('dots:new-old-client','dots:pane','dots:room','READY','Old client',false)`);
    expect((await pool.query("SELECT dot_id FROM space_agent_sessions WHERE session_id='dots:new-old-client'")).rows[0]?.dot_id).toBe(a[0]!.dotId);
    await pool.query(`INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,is_active,dot_id) VALUES ('dots:nova','dots:pane','dots:room','READY','Nova',false,$1)`, [a[1]!.dotId]);
    await expect(pool.query("UPDATE space_agent_sessions SET dot_id=$1 WHERE session_id='dots:nova'", [b[1]!.dotId])).rejects.toThrow();
    await expect(pool.query("UPDATE space_agent_sessions SET dot_id=$1 WHERE session_id='dots:nova'", [a[0]!.dotId])).rejects.toThrow();
    // The store below is today's code; give it today's schema (later migrations add columns such as t3code_metadata).
    for (const item of migrations.filter(item => item.id > migration!.id)) await pool.query(item.sql);
    const { PostgresSpaceStore } = await import("../src/space-store.js");
    const store = new PostgresSpaceStore(pool);
    expect((await store.getSpaceAgentSession("dots:old1"))?.dotId).toBe(a[0]!.dotId);
    for (const dot of a) {
      const saved = await store.createSpaceAgentSession({ paneId: "dots:pane", roomId: "dots:room", title: dot.name,
        dotId: dot.dotId, isActive: false, selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
        selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null });
      expect(saved.dotId).toBe(dot.dotId);
      expect((await store.getSpaceAgentSession(saved.sessionId))?.dotId).toBe(dot.dotId);
    }
    expect((await store.getActiveSpaceAgentSession("dots:pane"))?.sessionId).toBe("dots:old1");
    await Promise.all([
      repository.update("dots:a", a[2]!.dotId, { preferences: { language: "el" } }),
      new PostgresDotsRepository(pool).update("dots:a", a[2]!.dotId, { preferences: { communicationStyle: "Direct" } })
    ]);
    expect((await repository.get("dots:a", a[2]!.dotId))?.preferences).toEqual({ language: "el", communicationStyle: "Direct" });
    const nativeGoal = { threadId: "native:one", goalId: "goal:legacy", objective: "Keep working", status: "active" as const,
      tokenBudget: null, tokensUsed: 12, timeUsedSeconds: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const nativeGoals = await repository.related("dots:a", a[0]!.dotId, "goals", 50, 0, [nativeGoal]);
    expect(nativeGoals?.[0]).toMatchObject({ dotId: a[0]!.dotId, sessionId: "dots:old1", goalId: "goal:legacy", status: "active" });
    expect(await repository.related("dots:b", b[0]!.dotId, "goals", 50, 0, [nativeGoal])).toEqual([]);
    await pool.query(`INSERT INTO space_agent_messages(message_id,session_id,role,content,status) VALUES ('dots:prompt','dots:nova','user','test','COMPLETED'),('dots:answer','dots:nova','assistant','answer','COMPLETED');
      INSERT INTO space_agent_runs(run_id,session_id,pane_id,room_id,workflow_id,status,prompt_message_id,response_message_id,client_request_id,request_fingerprint) VALUES ('dots:run','dots:nova','dots:pane','dots:room','dots:workflow','RUNNING','dots:prompt','dots:answer','dots:request','${"a".repeat(64)}')`);
    expect((await repository.related("dots:a", a[1]!.dotId, "tasks", 50, 0))?.[0]?.dotId).toBe(a[1]!.dotId);
    expect((await repository.related("dots:a", a[1]!.dotId, "receipts", 50, 0))?.[0]?.runId).toBe("dots:run");
    await expect(pool.query("UPDATE space_agent_runs SET dot_id=$1 WHERE run_id='dots:run'", [a[0]!.dotId])).rejects.toThrow();
    // Rollback means retaining additive schema: the previous binary still writes unchanged SQL.
    await pool.query("UPDATE space_agent_runs SET status='COMPLETED' WHERE run_id='dots:run'");
    expect((await repository.related("dots:a", a[1]!.dotId, "tasks", 50, 0))?.[0]?.status).toBe("COMPLETED");
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
