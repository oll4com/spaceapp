import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("keeps one open Goal per conversation, guards transitions and records each step once", async () => {
  const migrations = await loadMigrations();
  const target = migrations.find(item => item.id === "0152_dot_channels");
  expect(target, "Stage 4 migrations must exist").toBeDefined();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-dot-goals-${randomUUID()}`;
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
    // Every migration: the channels repository writes columns added after Stage 6 (0180_channel_outbox_direct).
    for (const item of migrations) await pool.query(item.sql);
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('goals:a','a@goals.test','USER'),('goals:b','b@goals.test','USER');
      INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('goals:room','Goals','goals:trace','goals:a',0);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('goals:pane','goals:room','Chat','CHAT','IDLE',0);
      INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,is_active) VALUES ('goals:s1','goals:pane','goals:room','READY','One',true);`);
    const { PostgresDotsRepository } = await import("../src/dots-repository.js");
    const { PostgresDotGoalsRepository } = await import("../src/dot-goals-repository.js");
    const [orbit, nova] = await new PostgresDotsRepository(pool).list("goals:a");
    const repo = new PostgresDotGoalsRepository(pool);
    const input = { dotId: orbit!.dotId, ownerUserId: "goals:a", roomId: "goals:room", sessionId: "goals:s1", objective: "Ship",
      milestones: ["Draft", "Publish"], criteria: ["Published"], budget: { maxSteps: 3, maxMinutes: 60 } };
    const goal = await repo.create(input);
    expect(goal).toMatchObject({ status: "ACTIVE", milestones: [{ id: "m1", status: "PENDING" }, { id: "m2" }], usage: { steps: 0 } });
    expect(goal.workflowId).toBe(`dot-goal:${goal.goalId}`);
    await expect(repo.create(input)).rejects.toMatchObject({ code: "DOT_GOAL_OPEN" });
    await expect(repo.create({ ...input, dotId: nova!.dotId })).rejects.toThrow();
    expect(await repo.getOwned("goals:b", orbit!.dotId, goal.goalId)).toBeNull();

    expect((await repo.recordStep(goal.goalId, "run:1", false))?.usage.steps).toBe(1);
    expect((await repo.recordStep(goal.goalId, "run:1", false))?.usage.steps).toBe(1);
    expect((await repo.recordStep(goal.goalId, "run:2", true))?.usage).toMatchObject({ steps: 2, consecutiveFailures: 1, lastRunId: "run:2" });
    const steered = await repo.addSteering(goal.goalId, "Use the latest data");
    const steerId = steered!.steering[0]!.id;
    await repo.markSteeringDelivered(goal.goalId, [steerId]);
    expect((await repo.get(goal.goalId))!.steering[0]!.deliveredAt).not.toBeNull();
    expect((await repo.updateMilestone(goal.goalId, "m1", "DONE", "Drafted"))!.milestones[0]).toMatchObject({ status: "DONE", note: "Drafted" });
    expect(await repo.updateMilestone(goal.goalId, "m9", "DONE", null)).toBeNull();

    expect((await repo.transition(goal.goalId, ["ACTIVE"], "PAUSED", "Paused"))!.status).toBe("PAUSED");
    expect(await repo.transition(goal.goalId, ["ACTIVE"], "PAUSED", "again")).toBeNull();
    expect(await repo.updateMilestone(goal.goalId, "m2", "DONE", null)).toBeNull();
    expect((await repo.transition(goal.goalId, ["PAUSED"], "ACTIVE", null))!.status).toBe("ACTIVE");
    const done = await repo.complete(goal.goalId, [{ criterion: "Published", evidence: "Link" }]);
    expect(done).toMatchObject({ status: "COMPLETED", completedAt: expect.any(String), evidence: [{ criterion: "Published" }] });
    await expect(pool.query("UPDATE dot_goals SET status='ACTIVE' WHERE goal_id=$1", [goal.goalId])).rejects.toThrow();
    expect(await repo.addSteering(goal.goalId, "late")).toBeNull();
    expect(await repo.openForSession("goals:s1")).toBeNull();
    const second = await repo.create(input);
    expect((await repo.listOpen(10)).map(item => item.goalId)).toEqual([second.goalId]);
    expect((await repo.list("goals:a", orbit!.dotId, "goals:s1")).length).toBe(2);
    await pool.query("INSERT INTO dot_tool_invocations(invocation_id,dot_id,owner_user_id,room_id,session_id,tool_id,source,risk,status,arguments_hash) VALUES ($1,$2,'goals:a','goals:room','goals:s1','goal.status','SPACE_GOAL','READ','COMPLETED',$3)",
      ["dot_tool:goal", orbit!.dotId, `sha256:${"0".repeat(64)}`]);

    // Schedules: proposals are inactive, occurrences are claimed once, finished schedules never reopen.
    const { PostgresDotSchedulesRepository } = await import("../src/dot-schedules-repository.js");
    const schedules = new PostgresDotSchedulesRepository(pool);
    const base = { dotId: orbit!.dotId, ownerUserId: "goals:a", roomId: "goals:room", sessionId: "goals:s1", title: "Daily", prompt: "Summarize",
      recurrence: { kind: "DAILY" as const, time: "09:00" }, timeZone: "Europe/Athens" };
    const proposed = await schedules.create({ ...base, createdBy: "DOT", nextRunAt: null });
    expect(proposed).toMatchObject({ status: "PENDING_CONFIRMATION", nextRunAt: null, createdBy: "DOT" });
    await expect(pool.query("UPDATE dot_schedules SET status='ACTIVE' WHERE schedule_id=$1", [proposed.scheduleId])).rejects.toThrow();
    const due = "2026-10-11T06:00:00.000Z";
    expect((await schedules.setStatus(proposed.scheduleId, ["PENDING_CONFIRMATION"], "ACTIVE", due))).toMatchObject({ status: "ACTIVE", nextRunAt: due });
    expect((await schedules.due("2026-10-11T06:00:01.000Z", 10)).map(item => item.scheduleId)).toEqual([proposed.scheduleId]);
    expect(await schedules.claim(proposed.scheduleId, due, { nextRunAt: "2026-10-12T06:00:00.000Z", status: "ACTIVE", outcome: "Ran", ran: true })).toBe(true);
    expect(await schedules.claim(proposed.scheduleId, due, { nextRunAt: "2026-10-12T06:00:00.000Z", status: "ACTIVE", outcome: "Ran", ran: true })).toBe(false);
    expect(await schedules.get(proposed.scheduleId)).toMatchObject({ lastOutcome: "Ran", lastRunAt: expect.any(String), nextRunAt: "2026-10-12T06:00:00.000Z" });
    await expect(pool.query("UPDATE dot_schedules SET prompt='Delete everything' WHERE schedule_id=$1", [proposed.scheduleId])).rejects.toThrow();
    expect((await schedules.setStatus(proposed.scheduleId, ["ACTIVE"], "CANCELLED", null))!.status).toBe("CANCELLED");
    await expect(schedules.setStatus(proposed.scheduleId, ["CANCELLED"], "ACTIVE", due)).rejects.toThrow(/finished/);
    await expect(schedules.create({ ...base, dotId: nova!.dotId, createdBy: "USER", nextRunAt: due })).rejects.toThrow();
    expect(await schedules.getOwned("goals:b", orbit!.dotId, proposed.scheduleId)).toBeNull();
    expect((await schedules.list("goals:a", orbit!.dotId)).length).toBe(1);

    // Computer: live runs per Dot, its own Browser pane per room, and reconciliation of identical calls.
    const dots = new PostgresDotsRepository(pool);
    // The conversation belongs to the first Dot (Orbit) by default; runs inherit it.
    await pool.query(`INSERT INTO space_agent_messages(message_id,session_id,role,content,status) VALUES
        ('goals:m1','goals:s1','user','Go','COMPLETED'),('goals:m2','goals:s1','assistant','','RUNNING');
      INSERT INTO space_agent_runs(run_id,session_id,pane_id,room_id,workflow_id,status,prompt_message_id,response_message_id,client_request_id,request_fingerprint)
        VALUES ('goals:r1','goals:s1','goals:pane','goals:room','wf:goals:r1','RUNNING','goals:m1','goals:m2','proactive-abc','${"0".repeat(64)}')`);
    expect(await dots.listActiveRuns("goals:a", orbit!.dotId, 10)).toMatchObject([{ runId: "goals:r1", roomName: "Goals", status: "RUNNING", clientRequestId: "proactive-abc" }]);
    expect(await dots.listActiveRuns("goals:b", orbit!.dotId, 10)).toEqual([]);
    await pool.query(`INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('goals:browser','goals:room','Browser','BROWSER','IDLE',1),
      ('goals:chat2','goals:room','Chat 2','CHAT','IDLE',2)`);
    await expect(dots.recordDotBrowserPane("goals:a", orbit!.dotId, "goals:room", "goals:chat2")).rejects.toThrow(/does not match/);
    await expect(dots.recordDotBrowserPane("goals:b", orbit!.dotId, "goals:room", "goals:browser")).rejects.toThrow(/does not match/);
    expect(await dots.recordDotBrowserPane("goals:a", orbit!.dotId, "goals:room", "goals:browser")).toBe("goals:browser");
    expect(await dots.dotBrowserPane(orbit!.dotId, "goals:room")).toBe("goals:browser");
    // A second pane does not replace an open one: the first recorded pane wins.
    await pool.query(`INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('goals:browser2','goals:room','Browser 2','BROWSER','IDLE',3)`);
    expect(await dots.recordDotBrowserPane("goals:a", orbit!.dotId, "goals:room", "goals:browser2")).toBe("goals:browser");
    expect(await dots.listDotBrowserPanes("goals:a", orbit!.dotId)).toEqual([{ roomId: "goals:room", roomName: "Goals", paneId: "goals:browser" }]);
    await pool.query("UPDATE panes SET is_closed=true WHERE id='goals:browser'");
    expect(await dots.dotBrowserPane(orbit!.dotId, "goals:room")).toBeNull();
    expect(await dots.recordDotBrowserPane("goals:a", orbit!.dotId, "goals:room", "goals:browser2")).toBe("goals:browser2");
    // A pane moved to another room no longer counts as the Dot's browser in its old room.
    await pool.query(`INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('goals:room2','Other','goals:trace2','goals:a',1)`);
    await pool.query("UPDATE panes SET room_id='goals:room2' WHERE id='goals:browser2'");
    expect(await dots.dotBrowserPane(orbit!.dotId, "goals:room")).toBeNull();
    expect(await dots.listDotBrowserPanes("goals:a", orbit!.dotId)).toEqual([]);
    const start = (callId: string) => dots.startToolInvocation({ dotId: orbit!.dotId, ownerUserId: "goals:a", roomId: "goals:room", sessionId: "goals:s1",
      runId: null, callId, toolId: "space.execute", source: "SPACE_CONTROL", risk: "WRITE", arguments: { actions: [1] } });
    expect(await dots.unresolvedToolCall("goals:s1", "space.execute", { actions: [1] })).toBeNull();
    const first = await start("c1");
    expect(await dots.unresolvedToolCall("goals:s1", "space.execute", { actions: [1] })).toMatchObject({ state: "RUNNING" });
    await dots.finishToolInvocation(first.invocation.invocationId, { status: "FAILED", statusReason: "Outcome unknown: socket hang up" });
    expect(await dots.unresolvedToolCall("goals:s1", "space.execute", { actions: [1] })).toMatchObject({ state: "UNKNOWN" });
    expect(await dots.unresolvedToolCall("goals:s1", "space.execute", { actions: [2] })).toBeNull();
    const notice = await start("c2");
    await dots.finishToolInvocation(notice.invocation.invocationId, { status: "BLOCKED", statusReason: "Reconcile first: check" });
    expect(await dots.unresolvedToolCall("goals:s1", "space.execute", { actions: [1] })).toBeNull();
    // A pending approval blocks every identical repeat, even after a reconcile notice.
    const parked = await start("c3");
    await dots.requestToolApproval(parked.invocation.invocationId, "goals:s1", { payload: { kind: "control" }, summary: "Do it" });
    const noticeAgain = await start("c4");
    await dots.finishToolInvocation(noticeAgain.invocation.invocationId, { status: "BLOCKED", statusReason: "Reconcile first: waiting" });
    expect(await dots.unresolvedToolCall("goals:s1", "space.execute", { actions: [1] })).toMatchObject({ state: "AWAITING_APPROVAL" });
    await pool.query("INSERT INTO dot_tool_invocations(invocation_id,dot_id,owner_user_id,room_id,session_id,tool_id,source,risk,status,arguments_hash) VALUES ($1,$2,'goals:a','goals:room','goals:s1','computer.browser','SPACE_COMPUTER','WRITE','COMPLETED',$3)",
      ["dot_tool:computer", orbit!.dotId, `sha256:${"1".repeat(64)}`]);
    // An owner-approved native call is a one-time grant, not an unknown outcome.
    const native = await dots.startToolInvocation({ dotId: orbit!.dotId, ownerUserId: "goals:a", roomId: "goals:room", sessionId: "goals:s1",
      runId: null, callId: "n1", toolId: "memory.save", source: "SPACE_NATIVE", risk: "WRITE", arguments: { title: "T" } });
    await dots.requestToolApproval(native.invocation.invocationId, "goals:s1", { payload: { kind: "native", tool: "memory.save" }, summary: "Save" });
    expect(await dots.unresolvedToolCall("goals:s1", "memory.save", { title: "T" })).toMatchObject({ state: "AWAITING_APPROVAL" });
    expect(await dots.consumeApprovedNativeCall("goals:s1", "memory.save", { title: "T" })).toBeNull();
    await dots.decideToolApproval("goals:a", orbit!.dotId, native.invocation.invocationId, "APPROVE", "goals:a");
    await dots.finishToolInvocation(native.invocation.invocationId, { status: "PENDING", statusReason: "Approved" });
    expect(await dots.unresolvedToolCall("goals:s1", "memory.save", { title: "T" })).toBeNull();
    expect(await dots.consumeApprovedNativeCall("goals:s1", "memory.save", { title: "Other" })).toBeNull();
    expect(await dots.consumeApprovedNativeCall("goals:s1", "memory.save", { title: "T" })).toBe(native.invocation.invocationId);
    expect(await dots.consumeApprovedNativeCall("goals:s1", "memory.save", { title: "T" })).toBeNull();

    // Dot memory: per Dot, per project and shared; edits keep identity; deletion is real.
    const { PostgresDotMemoryRepository } = await import("../src/dot-memory-repository.js");
    const memories = new PostgresDotMemoryRepository(pool);
    const own = await memories.create({ ownerUserId: "goals:a", dotId: orbit!.dotId, scope: "DOT", projectKey: null, text: "Prefers short answers",
      source: "USER", sourceRef: null, embedding: [1, 0, 0] });
    const project = await memories.create({ ownerUserId: "goals:a", dotId: orbit!.dotId, scope: "PROJECT", projectKey: "/srv/app", text: "Deploy with npm run ship",
      source: "DOT", sourceRef: "goals:s1", embedding: [0, 1, 0] });
    await memories.create({ ownerUserId: "goals:a", dotId: orbit!.dotId, scope: "PROJECT", projectKey: "/srv/other", text: "Other project secret plan",
      source: "DOT", sourceRef: null, embedding: null });
    const shared = await memories.create({ ownerUserId: "goals:a", dotId: null, scope: "SHARED", projectKey: null, text: "Team uses Europe/Athens time",
      source: "USER", sourceRef: null, embedding: null });
    const novaOwn = await memories.create({ ownerUserId: "goals:a", dotId: nova!.dotId, scope: "DOT", projectKey: null, text: "Nova private note",
      source: "USER", sourceRef: null, embedding: null });
    await expect(memories.create({ ownerUserId: "goals:b", dotId: orbit!.dotId, scope: "DOT", projectKey: null, text: "x", source: "USER", sourceRef: null, embedding: null }))
      .rejects.toThrow(/owner/);
    await expect(pool.query("INSERT INTO dot_memories(memory_id,owner_user_id,dot_id,scope,project_key,text,source) VALUES ($1,'goals:a',NULL,'DOT',NULL,'x','USER')",
      [`dot_memory:${"f".repeat(32)}`])).rejects.toThrow();
    const listed = await memories.list("goals:a", orbit!.dotId, { limit: 50 });
    expect(listed.map(item => item.text)).not.toContain("Nova private note");
    expect(listed.map(item => item.memoryId)).toEqual(expect.arrayContaining([own.memoryId, project.memoryId, shared.memoryId]));
    expect((await memories.list("goals:a", orbit!.dotId, { scope: "SHARED", limit: 50 })).map(item => item.memoryId)).toEqual([shared.memoryId]);
    expect((await memories.list("goals:a", orbit!.dotId, { q: "npm ship", limit: 50 })).map(item => item.memoryId)).toEqual([project.memoryId]);
    expect(await memories.list("goals:b", orbit!.dotId, { limit: 50 })).toEqual([]);
    // Recall: semantic first, text fills in, other projects stay hidden.
    const recalled = await memories.recall("goals:a", orbit!.dotId, "/srv/app", { text: "time zone", embedding: [0, 0.9, 0.1] }, 5);
    expect(recalled[0]!.memoryId).toBe(project.memoryId);
    expect(recalled.map(item => item.text)).not.toContain("Other project secret plan");
    expect(recalled.map(item => item.text)).not.toContain("Nova private note");
    expect((await memories.recall("goals:a", orbit!.dotId, null, { text: "Athens", embedding: null }, 5)).map(item => item.memoryId)).toEqual([shared.memoryId]);
    expect((await memories.update("goals:a", orbit!.dotId, own.memoryId, "Prefers bullet points", null))!.text).toBe("Prefers bullet points");
    // A Dot's edit records the Dot as its source.
    expect(await memories.update("goals:a", orbit!.dotId, shared.memoryId, "Team time zone is UTC", null, { source: "DOT", sourceRef: "goals:s1" }))
      .toMatchObject({ source: "DOT", sourceRef: "goals:s1", text: "Team time zone is UTC" });
    expect(await memories.update("goals:a", nova!.dotId, own.memoryId, "hijack", null)).toBeNull();
    await expect(pool.query("UPDATE dot_memories SET scope='SHARED', dot_id=NULL WHERE memory_id=$1", [own.memoryId])).rejects.toThrow(/keeps/);
    expect(await memories.delete("goals:a", nova!.dotId, own.memoryId)).toBe(false);
    expect(await memories.delete("goals:a", orbit!.dotId, own.memoryId)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM dot_memories WHERE memory_id=$1", [own.memoryId])).rows[0]).toEqual({ count: 0 });
    expect(await memories.get("goals:a", nova!.dotId, novaOwn.memoryId)).toMatchObject({ text: "Nova private note" });

    // Deliverables: consecutive immutable versions per Dot and name; identical content once; numbers never reused.
    const { PostgresDotDeliverablesRepository } = await import("../src/dot-deliverables-repository.js");
    const deliverables = new PostgresDotDeliverablesRepository(pool);
    await pool.query(`INSERT INTO artifacts(id,room_id,kind,mime_type,storage_uri,sha256,byte_size,metadata) VALUES
      ('goals:art1','goals:room','EXPORT','text/markdown','space-artifact://agent-files/a','${"a".repeat(64)}',10,'{}'),
      ('goals:art2','goals:room','EXPORT','text/markdown','space-artifact://agent-files/b','${"b".repeat(64)}',12,'{}'),
      ('goals:art3','goals:room','EXPORT','text/markdown','space-artifact://agent-files/c','${"c".repeat(64)}',12,'{}')`);
    const base2 = { dotId: orbit!.dotId, ownerUserId: "goals:a", roomId: "goals:room", name: "reports/summary.md", mimeType: "text/markdown", publishedBy: "USER" as const };
    const [v1, v2] = await Promise.all([
      deliverables.addVersion({ ...base2, artifactId: "goals:art1", sha256: "a".repeat(64), sourceSha256: "1".repeat(64), byteSize: 10 }),
      deliverables.addVersion({ ...base2, artifactId: "goals:art2", sha256: "b".repeat(64), sourceSha256: "2".repeat(64), byteSize: 12 })]);
    expect([v1!.version, v2!.version].sort()).toEqual([1, 2]);
    // The same workspace content returns the existing version instead of a duplicate.
    const duplicate = await deliverables.addVersion({ ...base2, artifactId: "goals:art3", sha256: "c".repeat(64), sourceSha256: "1".repeat(64), byteSize: 12 });
    expect(duplicate.deliverableId).toBe(v1!.deliverableId);
    expect((await deliverables.bySource(orbit!.dotId, "reports/summary.md", "2".repeat(64)))!.deliverableId).toBe(v2!.deliverableId);
    expect((await deliverables.latest(orbit!.dotId, "reports/summary.md"))!.version).toBe(2);
    await expect(pool.query("UPDATE dot_deliverables SET version=9 WHERE deliverable_id=$1", [v1!.deliverableId])).rejects.toThrow(/immutable/);
    await expect(deliverables.addVersion({ ...base2, ownerUserId: "goals:b", artifactId: "goals:art1", sha256: "a".repeat(64), sourceSha256: "3".repeat(64), byteSize: 10 })).rejects.toThrow(/does not match/);
    // Deleting the Agent File keeps the version number taken; republishing that content makes a new version.
    await pool.query("DELETE FROM artifacts WHERE id='goals:art1'");
    expect((await deliverables.list("goals:a", orbit!.dotId, 10)).map(item => item.version)).toEqual([2]);
    expect(await deliverables.bySource(orbit!.dotId, "reports/summary.md", "1".repeat(64))).toBeNull();
    const v3 = await deliverables.addVersion({ ...base2, artifactId: "goals:art3", sha256: "c".repeat(64), sourceSha256: "1".repeat(64), byteSize: 12 });
    expect(v3.version).toBe(3);

    // Connector accounts: one row per owner, provider and email; reconnecting replaces tokens; deletion is real.
    const { PostgresConnectorAccountsRepository } = await import("../src/connector-accounts-repository.js");
    const connectors = new PostgresConnectorAccountsRepository(pool);
    const sealed = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cccccccc";
    const linked = await connectors.upsert({ ownerUserId: "goals:a", provider: "GOOGLE", email: "Owner@Example.com", scopes: ["a"],
      refreshTokenEncrypted: sealed, accessTokenEncrypted: null, accessExpiresAt: null });
    expect(linked).toMatchObject({ email: "owner@example.com", scopes: ["a"] });
    const again = await connectors.upsert({ ownerUserId: "goals:a", provider: "GOOGLE", email: "owner@example.com", scopes: ["a", "b"],
      refreshTokenEncrypted: `${sealed}2`, accessTokenEncrypted: null, accessExpiresAt: null });
    expect(again.accountId).toBe(linked.accountId);
    expect(again.scopes).toEqual(["a", "b"]);
    await connectors.saveAccessToken(linked.accountId, sealed, "2026-10-11T10:00:00.000Z");
    expect((await connectors.get("goals:a", linked.accountId))!.accessExpiresAt).toBe("2026-10-11T10:00:00.000Z");
    expect(await connectors.get("goals:b", linked.accountId)).toBeNull();
    expect(await connectors.delete("goals:b", linked.accountId)).toBe(false);
    expect(await connectors.delete("goals:a", linked.accountId)).toBe(true);
    expect(await connectors.list("goals:a")).toEqual([]);

    // Delegations: one per Goal, between two different Dots of one owner; each outcome reported once.
    const { PostgresDotDelegationsRepository } = await import("../src/dot-delegations-repository.js");
    const delegationsRepo = new PostgresDotDelegationsRepository(pool);
    await pool.query(`INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,is_active,dot_id)
      VALUES ('goals:nova','goals:chat2','goals:room','READY','Nova',true,$1)`, [nova!.dotId]);
    const childGoal = await repo.create({ ...input, dotId: nova!.dotId, sessionId: "goals:nova" });
    const delegation = await delegationsRepo.create({ ownerUserId: "goals:a", roomId: "goals:room", fromDotId: orbit!.dotId, fromSessionId: "goals:s1",
      toDotId: nova!.dotId, toSessionId: "goals:nova", goalId: childGoal.goalId, paneId: "goals:chat2", task: "Compare quotes" });
    await expect(delegationsRepo.create({ ownerUserId: "goals:b", roomId: "goals:room", fromDotId: orbit!.dotId, fromSessionId: "goals:s1",
      toDotId: nova!.dotId, toSessionId: "goals:nova", goalId: second.goalId, paneId: "goals:chat2", task: "x" })).rejects.toThrow(/does not match/);
    expect(await delegationsRepo.unreported(10)).toEqual([]);
    await repo.transition(childGoal.goalId, ["ACTIVE"], "BLOCKED", "Which currency?");
    expect(await delegationsRepo.unreported(10)).toMatchObject([{ delegationId: delegation.delegationId, goalStatus: "BLOCKED", goalStatusReason: "Which currency?" }]);
    expect(await delegationsRepo.markReported(delegation.delegationId, "BLOCKED")).toBe(true);
    expect(await delegationsRepo.markReported(delegation.delegationId, "BLOCKED")).toBe(false);
    expect(await delegationsRepo.unreported(10)).toEqual([]);
    expect((await delegationsRepo.list("goals:a", orbit!.dotId, 10)).map(item => item.goalStatus)).toEqual(["BLOCKED"]);

    // Stage 7: shadow decisions are read back from the run's execution context, routing facts only.
    const autoRoute = { policyVersion: "auto-route-v1", mode: "SHADOW", decidedAt: new Date().toISOString(), tier: "LIGHT", estimatedInputTokens: 6_010,
      choice: { model: "small", reasoning: "low" }, reasons: ["A short request with no files."], excluded: [],
      actual: { model: null, reasoning: null, source: "RUNTIME_DEFAULT" }, agreesWithActual: null };
    await pool.query(`INSERT INTO space_agent_messages(message_id,session_id,role,content,status) SELECT 'm:'||n,'goals:s1','user','x','COMPLETED'
      FROM generate_series(1,6) AS n`);
    await pool.query(`INSERT INTO space_agent_runs(run_id,session_id,pane_id,room_id,workflow_id,status,prompt_message_id,response_message_id,execution_context)
      VALUES ('goals:auto1','goals:s1','goals:pane','goals:room','wf:auto1','COMPLETED','m:1','m:2',$1::jsonb),
             ('goals:auto2','goals:s1','goals:pane','goals:room','wf:auto2','COMPLETED','m:3','m:4','{"traceId":"t"}'::jsonb),
             ('goals:auto3','goals:s1','goals:pane','goals:room','wf:auto3','COMPLETED','m:5','m:6',$2::jsonb)`,
      [JSON.stringify({ traceId: "t", autoRoute }), JSON.stringify({ traceId: "t", autoRoute: { ...autoRoute, mode: "ACTIVE" } })]);
    const { PostgresAutoRouteShadowRepository } = await import("../src/auto-route-shadow-repository.js");
    const shadow = await new PostgresAutoRouteShadowRepository(pool).recent(new Date(Date.now() - 86_400_000).toISOString(), 10);
    expect(shadow).toEqual([{ autoRoute, status: "COMPLETED", runtimeModelAtStart: null, ledger: null }]);

    // Stage 7: evaluation cases and the receipts rebuilt from their conversations.
    const { PostgresDotEvalsRepository } = await import("../src/dot-evals-repository.js");
    const evals = new PostgresDotEvalsRepository(pool);
    const evalRunId = "dot_eval:0123456789abcdef";
    await evals.createRun({ evalRunId, ownerUserId: "goals:a", dotId: orbit!.dotId, roomId: "goals:room", datasetVersion: "dots-v1", modelConfigId: null,
      runnerId: "api:runner-one", cases: [{ caseId: "mcp-01-room-count-en", status: "PENDING", statusReason: null }, { caseId: "channels-04-slack-en", status: "SKIPPED", statusReason: "Needs channel:slack." }] });
    await expect(evals.createRun({ evalRunId: "dot_eval:bad", ownerUserId: "goals:a", dotId: orbit!.dotId, roomId: "goals:room", datasetVersion: "dots-v1",
      modelConfigId: null, runnerId: "api:runner-one", cases: [{ caseId: "x-01", status: "PENDING", statusReason: null }] })).rejects.toThrow();
    await pool.query(`INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,is_active,dot_id) VALUES ('goals:eval','goals:pane','goals:room','READY','Eval',false,$1)`, [orbit!.dotId]);
    await pool.query(`INSERT INTO space_agent_messages(message_id,session_id,role,content,status,dot_id) VALUES ('m:e1','goals:eval','user','How many?','COMPLETED',$1),
      ('m:e2','goals:eval','assistant','3','COMPLETED',$1)`, [orbit!.dotId]);
    await pool.query(`INSERT INTO space_agent_runs(run_id,session_id,pane_id,room_id,workflow_id,status,prompt_message_id,response_message_id,execution_context,dot_id)
      VALUES ('goals:eval-run','goals:eval','goals:pane','goals:room','wf:eval','COMPLETED','m:e1','m:e2',$1::jsonb,$2)`,
      [JSON.stringify({ traceId: "t", modelConfigId: null, providerId: null, providerName: "Codex", requestedModel: null, requestedReasoning: null,
        attachments: [{ artifactId: "artifact:eval-1", name: "orders.csv", mimeType: "text/csv", byteSize: 10, sha256: "a".repeat(64),
          coverage: { status: "FULL", method: "text", chars: 10, pages: null, truncated: false, reason: null } }] }), orbit!.dotId]);
    await pool.query(`INSERT INTO dot_tool_invocations(invocation_id,dot_id,owner_user_id,room_id,session_id,tool_id,source,risk,status,arguments_hash)
      VALUES ('inv:eval1',$1,'goals:a','goals:room','goals:eval','space.inspect','SPACE_CONTROL','READ','COMPLETED',$2)`, [orbit!.dotId, `sha256:${"b".repeat(64)}`]);
    await evals.update(evalRunId, "mcp-01-room-count-en", { sessionId: "goals:eval", status: "RUNNING" });
    expect(await evals.isRunningSession("goals:eval")).toBe(true);
    expect(await evals.isRunningSession("goals:s1")).toBe(false);
    expect(await evals.receipts("goals:a", evalRunId)).toEqual([]);
    await evals.update(evalRunId, "mcp-01-room-count-en", { status: "DONE", statusReason: null });
    const [evalReceipt] = await evals.receipts("goals:a", evalRunId);
    expect(evalReceipt).toMatchObject({ caseId: "mcp-01-room-count-en", status: "COMPLETED", result: "3", tools: [{ toolId: "space.inspect", status: "COMPLETED" }],
      attachments: [{ name: "orders.csv", coverage: "FULL" }], goal: null, cost: { status: "UNKNOWN", amountUsd: null } });
    expect(await evals.receipts("goals:b", evalRunId)).toEqual([]);
    expect((await evals.list("goals:a", evalRunId)).map((item) => [item.caseId, item.status, item.finishedAt !== null])).toEqual([
      ["mcp-01-room-count-en", "DONE", true], ["channels-04-slack-en", "SKIPPED", false]]);
    expect((await evals.runs("goals:a", orbit!.dotId, 5))[0]).toMatchObject({ evalRunId, counts: { DONE: 1, SKIPPED: 1, RUNNING: 0 } });
    await evals.createRun({ evalRunId: "dot_eval:fedcba9876543210", ownerUserId: "goals:a", dotId: orbit!.dotId, roomId: "goals:room", datasetVersion: "dots-v1",
      modelConfigId: "codex-v1|m|high", runnerId: "api:runner-one", cases: [{ caseId: "mcp-02-model-list-en", status: "PENDING", statusReason: null },
        { caseId: "mcp-03-clipboard-note-en", status: "PENDING", statusReason: null }] });
    // Only cases of a process that is gone are closed; a closed case is never reopened.
    expect(await evals.abandon("api:runner-one", "Restarted.")).toEqual([]);
    expect(await evals.abandon("api:runner-two", "Restarted.")).toEqual([{ ownerUserId: "goals:a", dotId: orbit!.dotId, goalId: null },
      { ownerUserId: "goals:a", dotId: orbit!.dotId, goalId: null }]);
    await evals.update("dot_eval:fedcba9876543210", "mcp-02-model-list-en", { status: "DONE" });
    expect((await evals.list("goals:a", "dot_eval:fedcba9876543210"))[0]!.status).toBe("CANCELLED");
    // A case that ran out of time is a failed receipt, not a missing one.
    await evals.update(evalRunId, "mcp-01-room-count-en", { status: "DONE" });
    await pool.query(`UPDATE dot_eval_cases SET status='FAILED', status_reason='The case did not finish in time.' WHERE case_id='mcp-01-room-count-en'`);
    expect((await evals.receipts("goals:a", evalRunId))[0]).toMatchObject({ caseId: "mcp-01-room-count-en", unfinished: true });

    // Stage 6: Slack and Teams links, threads, deduplicated events and the outbox.
    const { PostgresChannelsRepository } = await import("../src/channels-repository.js");
    const channels = new PostgresChannelsRepository(pool);
    await channels.createLinkCode("goals:a", "ABCD2345", new Date(Date.now() + 600_000).toISOString());
    await channels.createLinkCode("goals:a", "OLDC0DE9", new Date(Date.now() - 1_000).toISOString());
    const linkedIdentity = await channels.linkIdentity("ABCD2345", { provider: "SLACK", tenantId: "T1", externalUserId: "U1", displayName: "Maria", replyAddress: "U1" });
    expect(linkedIdentity).toMatchObject({ ownerUserId: "goals:a", provider: "SLACK", replyAddress: "U1" });
    expect(await channels.linkIdentity("ABCD2345", { provider: "SLACK", tenantId: "T1", externalUserId: "U9", displayName: null, replyAddress: "U9" })).toBeNull();
    expect(await channels.linkIdentity("OLDC0DE9", { provider: "SLACK", tenantId: "T1", externalUserId: "U9", displayName: null, replyAddress: "U9" })).toBeNull();
    // A linked account is never moved to another Space user by a code, and an exposed code can be cancelled.
    await channels.createLinkCode("goals:b", "BBBB2222", new Date(Date.now() + 600_000).toISOString());
    expect(await channels.linkIdentity("BBBB2222", { provider: "SLACK", tenantId: "T1", externalUserId: "U1", displayName: null, replyAddress: "U1" })).toBe("LINKED_ELSEWHERE");
    await channels.burnLinkCode("BBBB2222");
    expect(await channels.linkIdentity("BBBB2222", { provider: "SLACK", tenantId: "T1", externalUserId: "U7", displayName: null, replyAddress: "U7" })).toBeNull();
    expect(await channels.markEvent("SLACK", "Ev1")).toBe(true);
    expect(await channels.markEvent("SLACK", "Ev1")).toBe(false);
    const threadInput = { provider: "SLACK" as const, tenantId: "T1", conversationId: "D1", threadKey: "direct", conversationKind: "DIRECT" as const,
      identityId: linkedIdentity!.identityId, ownerUserId: "goals:a", dotId: orbit!.dotId, sessionId: null, paneId: "goals:pane", serviceUrl: null };
    await expect(channels.createThread({ ...threadInput, ownerUserId: "goals:b" })).rejects.toThrow();
    await expect(channels.createThread({ ...threadInput, dotId: (await new PostgresDotsRepository(pool).list("goals:b"))[0]!.dotId })).rejects.toThrow();
    const channelThread = await channels.createThread(threadInput);
    expect((await channels.createThread(threadInput)).threadId).toBe(channelThread.threadId);
    await pool.query(`UPDATE space_agent_sessions SET dot_id=$1 WHERE session_id='goals:s1'`, [orbit!.dotId]).catch(() => undefined);
    await channels.updateThread(channelThread.threadId, { sessionId: "goals:eval", replyInThread: true, lastDeliveredRunId: "run:1" });
    expect(await channels.threadForSession("goals:eval", "SLACK")).toMatchObject({ threadId: channelThread.threadId, replyInThread: true, lastDeliveredRunId: "run:1" });
    expect(await channels.threadForSession("goals:eval", "TEAMS")).toBeNull();
    const requestKey = `channel-${"c".repeat(40)}`;
    expect(await channels.queueInbox(channelThread.threadId, "Ev2", "later", requestKey)).toBe(true);
    expect(await channels.queueInbox(channelThread.threadId, "Ev2", "later", requestKey)).toBe(false);
    expect(await channels.openInbox(channelThread.threadId)).toEqual([{ eventId: "Ev2", text: "later", requestKey, status: "PENDING" }]);
    await channels.markInbox(channelThread.threadId, "Ev2", "SENT");
    expect((await channels.openInbox(channelThread.threadId))[0]!.status).toBe("SENT");
    await channels.markInbox(channelThread.threadId, "Ev2", "DELIVERED");
    expect(await channels.openInbox(channelThread.threadId)).toEqual([]);
    expect(await channels.enqueue({ threadId: channelThread.threadId, sourceKey: "result:run:1", kind: "RESULT", target: "THREAD", body: "Done" })).toBe(true);
    expect(await channels.enqueue({ threadId: channelThread.threadId, sourceKey: "result:run:1", kind: "RESULT", target: "THREAD", body: "Done" })).toBe(false);
    const [dueOutbox] = await channels.due(10);
    // A claimed row is not handed out again while it is being delivered.
    expect(await channels.due(10)).toEqual([]);
    await pool.query(`UPDATE channel_outbox SET next_attempt_at=now()`);
    await channels.retry(dueOutbox!.outboxId, "rate limited", 2);
    expect(await channels.due(10)).toEqual([]);
    await pool.query(`UPDATE channel_outbox SET next_attempt_at=now()`);
    await channels.retry(dueOutbox!.outboxId, "rate limited", 2);
    expect((await pool.query(`SELECT status, attempts FROM channel_outbox WHERE outbox_id=$1`, [dueOutbox!.outboxId])).rows[0]).toEqual({ status: "FAILED", attempts: 2 });
    expect(await channels.unlink("goals:b", linkedIdentity!.identityId)).toBe(false);
    expect(await channels.unlink("goals:a", linkedIdentity!.identityId)).toBe(true);
    expect(await channels.threads("goals:a")).toEqual([]);
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
