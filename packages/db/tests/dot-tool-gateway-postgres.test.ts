import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("records one immutable, identity-checked Dot tool receipt per call and marks only gateway threads", async () => {
  const migrations = await loadMigrations();
  const target = migrations.find(item => item.id === "0141_dot_tool_gateway");
  expect(target, "Stage 3 migration must exist").toBeDefined();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-dot-tools-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 4 });
  let created = false;
  try {
    docker(["run", "--tmpfs", "/var/lib/postgresql/data", "--detach", "--rm", "--pull=never", "--name", name, "--network", "none", "--mount", `type=bind,source=${socket},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:0.8.7-pg17-trixie", "-c", "listen_addresses="]);
    created = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error(); await pool.query("SELECT 1"); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw Error("Owned PostgreSQL did not become ready.");
    for (const item of migrations.filter(item => item.id <= target!.id)) await pool.query(item.sql);
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('tools:a','a@tools.test','USER'),('tools:b','b@tools.test','USER');
      INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('tools:room','Tools','tools:trace','tools:a',0),('tools:room-b','Other','tools:trace-b','tools:b',1);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('tools:pane','tools:room','Chat','CHAT','IDLE',0);
      INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,thread_id,is_active) VALUES
        ('tools:new','tools:pane','tools:room','READY','New',null,true),
        ('tools:legacy','tools:pane','tools:room','READY','Legacy','thread:legacy',false);`);
    const { PostgresDotsRepository } = await import("../src/dots-repository.js");
    const repository = new PostgresDotsRepository(pool);
    const [orbit, nova] = await repository.list("tools:a");
    const otherDot = (await repository.list("tools:b"))[0]!;
    // Only the session whose current thread started with gateway tools is marked.
    await repository.markSessionToolGateway("tools:legacy", "thread:other");
    expect(await repository.sessionToolGateway("tools:legacy")).toBeNull();
    await repository.markSessionToolGateway("tools:new", "thread:new");
    expect(await repository.sessionToolGateway("tools:new")).toBe("space-dot-tools-v1");
    await expect(pool.query("UPDATE space_agent_sessions SET tool_gateway='other' WHERE session_id='tools:new'")).rejects.toThrow();

    const input = { dotId: orbit!.dotId, ownerUserId: "tools:a", roomId: "tools:room", sessionId: "tools:new", runId: "run:1",
      callId: "call-1", toolId: "space.inspect", source: "SPACE_CONTROL" as const, risk: "READ" as const, arguments: { section: "STATE" } };
    const first = await repository.startToolInvocation(input);
    expect(first).toMatchObject({ created: true, running: true });
    const replay = await repository.startToolInvocation(input);
    expect(replay).toMatchObject({ created: false, running: true });
    expect(replay.invocation.invocationId).toBe(first.invocation.invocationId);
    // A reused call id with different arguments is a different call, never a silent skip.
    const different = await repository.startToolInvocation({ ...input, arguments: { section: "CONTENT" } });
    expect(different.created).toBe(true);
    await repository.finishToolInvocation(different.invocation.invocationId, { status: "COMPLETED" });
    const finished = await repository.finishToolInvocation(first.invocation.invocationId, { status: "COMPLETED", resultSummary: "x".repeat(3000) });
    expect(finished).toMatchObject({ status: "COMPLETED", completedAt: expect.any(String) });
    expect(finished!.resultSummary).toHaveLength(2000);
    expect(await repository.finishToolInvocation(first.invocation.invocationId, { status: "FAILED" })).toBeNull();
    expect((await repository.startToolInvocation(input)).invocation.status).toBe("COMPLETED");

    // Wrong Dot, owner or room never produces a receipt.
    await expect(repository.startToolInvocation({ ...input, callId: "call-2", dotId: nova!.dotId })).rejects.toThrow();
    await expect(repository.startToolInvocation({ ...input, callId: "call-3", dotId: otherDot.dotId, ownerUserId: "tools:b" })).rejects.toThrow();
    await expect(repository.startToolInvocation({ ...input, callId: "call-4", roomId: "tools:room-b" })).rejects.toThrow();
    await expect(pool.query(`UPDATE dot_tool_invocations SET tool_id='space.execute' WHERE invocation_id=$1`, [first.invocation.invocationId])).rejects.toThrow();

    // Approvals: parked once with an immutable payload, decided once, by the owner only.
    const sensitive = await repository.startToolInvocation({ ...input, callId: "call-approve", toolId: "space.execute", risk: "WRITE", arguments: { close: 1 } });
    const payload = { kind: "control", tool: "space_execute", payload: { roomId: "tools:room", actions: [{ kind: "pane", operation: "close" }] } };
    const parked = await repository.requestToolApproval(sensitive.invocation.invocationId, "tools:new", { payload, summary: "close pane:x" });
    expect(parked).toMatchObject({ status: "APPROVAL_REQUIRED", approvalSummary: "close pane:x" });
    expect(await repository.requestToolApproval(sensitive.invocation.invocationId, "tools:new", { payload: { kind: "control" }, summary: "other" })).toBeNull();
    await expect(pool.query(`UPDATE dot_tool_invocations SET approval_payload='{"kind":"control","tool":"space_execute","payload":{}}' WHERE invocation_id=$1`,
      [sensitive.invocation.invocationId])).rejects.toThrow();
    expect(await repository.hasPendingApproval("tools:new")).toBe(true);
    expect((await repository.listPendingApprovals("tools:a", orbit!.dotId, "tools:new"))?.map(item => item.invocationId)).toEqual([sensitive.invocation.invocationId]);
    expect(await repository.listPendingApprovals("tools:b", orbit!.dotId)).toBeNull();
    expect(await repository.decideToolApproval("tools:b", orbit!.dotId, sensitive.invocation.invocationId, "APPROVE", "tools:b")).toBeNull();
    const claimed = await repository.decideToolApproval("tools:a", orbit!.dotId, sensitive.invocation.invocationId, "APPROVE", "tools:a");
    expect(claimed?.payload).toEqual(payload);
    expect(claimed?.invocation).toMatchObject({ status: "FAILED", decidedAt: expect.any(String) });
    expect(await repository.decideToolApproval("tools:a", orbit!.dotId, sensitive.invocation.invocationId, "APPROVE", "tools:a")).toBeNull();
    expect(await repository.finishToolInvocation(sensitive.invocation.invocationId, { status: "COMPLETED", resultSummary: "closed" })).toMatchObject({ status: "COMPLETED" });
    expect(await repository.hasPendingApproval("tools:new")).toBe(false);
    const declinedCall = await repository.startToolInvocation({ ...input, callId: "call-decline", toolId: "space.execute", risk: "WRITE", arguments: { stop: 1 } });
    await repository.requestToolApproval(declinedCall.invocation.invocationId, "tools:new", { payload, summary: "stop pane:x" });
    expect((await repository.decideToolApproval("tools:a", orbit!.dotId, declinedCall.invocation.invocationId, "DECLINE", "tools:a"))?.invocation.status).toBe("DECLINED");
    // An expired request can never be approved by a late click.
    const stale = await repository.startToolInvocation({ ...input, callId: "call-stale", toolId: "space.execute", risk: "WRITE", arguments: { stale: 1 } });
    await repository.requestToolApproval(stale.invocation.invocationId, "tools:new", { payload, summary: "old" });
    await pool.query("UPDATE dot_tool_invocations SET started_at=now() - interval '2 days' WHERE invocation_id=$1", [stale.invocation.invocationId]);
    expect(await repository.decideToolApproval("tools:a", orbit!.dotId, stale.invocation.invocationId, "APPROVE", "tools:a")).toBeNull();
    expect((await repository.listToolInvocations("tools:a", orbit!.dotId, 50, 0))?.length).toBe(5);
    expect(await repository.listToolInvocations("tools:b", orbit!.dotId, 50, 0)).toBeNull();
    expect(await repository.listToolInvocations("tools:a", nova!.dotId, 50, 0)).toEqual([]);
    await pool.query("DELETE FROM space_agent_sessions WHERE session_id='tools:new'");
    expect(await repository.listToolInvocations("tools:a", orbit!.dotId, 50, 0)).toEqual([]);
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
