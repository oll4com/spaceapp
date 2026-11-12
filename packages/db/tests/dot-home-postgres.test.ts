import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("serves one feed per Dot across rooms, with events, notices, read marker, context and owner-only settings", async () => {
  const migrations = await loadMigrations();
  expect(migrations.some(item => item.id === "0168_dot_home"), "Stage 8 migration must exist").toBe(true);
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-dot-home-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 6 });
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
    for (const item of migrations) await pool.query(item.sql);
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('home:a','a@home.test','USER'),('home:b','b@home.test','USER');
      INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('home:r1','One','home:t1','home:a',1),('home:r2','Two','home:t2','home:a',2);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('home:p1','home:r1','Chat','CHAT','IDLE',0),('home:p2','home:r2','Chat','CHAT','IDLE',0);`);
    const { PostgresDotsRepository } = await import("../src/dots-repository.js");
    const { PostgresDotHomeRepository } = await import("../src/dot-home-repository.js");
    const dots = await new PostgresDotsRepository(pool).list("home:a");
    const [orbit, nova] = [dots[0]!.dotId, dots[1]!.dotId];
    const otherOrbit = (await new PostgresDotsRepository(pool).list("home:b"))[0]!.dotId;
    await pool.query(`INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,is_active,dot_id) VALUES
      ('home:s1','home:p1','home:r1','READY','One',false,$1),('home:s2','home:p2','home:r2','READY','Two',true,$1),('home:s3','home:p1','home:r1','READY','Nova',true,$2)`, [orbit, nova]);
    const message = (id: string, session: string, role: string, content: string, minute: number, status = "COMPLETED") =>
      pool.query(`INSERT INTO space_agent_messages(message_id,session_id,role,content,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [id, session, role, content, status, new Date(Date.UTC(2026, 9, 12, 8, minute)).toISOString()]);
    const run = (id: string, session: string, pane: string, room: string, prompt: string, answer: string, key: string | null) =>
      pool.query(`INSERT INTO space_agent_runs(run_id,session_id,pane_id,room_id,workflow_id,status,prompt_message_id,response_message_id,client_request_id,request_fingerprint)
        VALUES ($1,$2,$3,$4,$5,'COMPLETED',$6,$7,$8,$9)`, [id, session, pane, room, `wf:${id}`, prompt, answer, key, key ? "a".repeat(64) : null]);
    await message("home:m1", "home:s1", "user", "Plan my week", 1);
    await message("home:m2", "home:s1", "assistant", "Here is your week.", 2);
    await run("home:run1", "home:s1", "home:p1", "home:r1", "home:m1", "home:m2", "4f1d2c90-1111-4222-8333-944445555666");
    await message("home:m3", "home:s2", "user", "Approved: Create the event “Test”\nResult: COMPLETED\nDetails: {\"x\":1}\nContinue the task.", 3);
    await message("home:m4", "home:s2", "assistant", "Created.\n```space-memory-actions\n{}\n```", 4);
    await run("home:run2", "home:s2", "home:p2", "home:r2", "home:m3", "home:m4", "approval-0123456789abcdef");
    await message("home:m5", "home:s2", "user", "Evaluation case", 5);
    await message("home:m6", "home:s2", "assistant", "Evaluation answer", 6);
    await run("home:run3", "home:s2", "home:p2", "home:r2", "home:m5", "home:m6", "eval-run-case-0001");
    await message("home:m7", "home:s2", "assistant", "", 7, "RUNNING");
    await message("home:n1", "home:s3", "user", "Nova only", 8);
    // A photo sent without text: the feed keeps it with the file names from its run receipt.
    await message("home:i1", "home:s3", "user", "", 9);
    await message("home:i2", "home:s3", "assistant", "It is a receipt.", 10);
    await run("home:run4", "home:s3", "home:p1", "home:r1", "home:i1", "home:i2", "5f1d2c90-1111-4222-8333-944445555666");
    await pool.query(`UPDATE space_agent_runs SET execution_context=$1::jsonb WHERE run_id='home:run4'`,
      [JSON.stringify({ attachments: [{ artifactId: "artifact:1", name: "receipt.png", mimeType: "image/png", byteSize: 10, sha256: "a".repeat(64) }] })]);

    const home = new PostgresDotHomeRepository(pool);
    expect(await home.feed("home:b", orbit, { limit: 10 })).toBeNull();
    const all = (await home.feed("home:a", orbit, { limit: 10 }))!;
    expect(all.items.map(item => [item.id, item.kind, item.origin, item.conversationStart])).toEqual([
      ["home:m1", "MESSAGE", "USER", true], ["home:m2", "MESSAGE", "USER", false],
      ["home:m3", "EVENT", "APPROVAL", true], ["home:m4", "MESSAGE", "APPROVAL", false]]);
    expect(all.items[0]!.attachments).toEqual([]);
    const novaFeed = (await home.feed("home:a", nova, { limit: 10 }))!;
    expect(novaFeed.items.map(item => item.id)).toEqual(["home:n1", "home:i1", "home:i2"]);
    expect(novaFeed.items[1]).toMatchObject({ author: "USER", content: "", attachments: [{ name: "receipt.png", mimeType: "image/png" }] });
    expect(all.items[2]!.summary).toBe("Approved: Create the event “Test”");
    expect(all.items[3]!.content).toBe("Created.");
    expect(all.items.map(item => item.roomId)).toEqual(["home:r1", "home:r1", "home:r2", "home:r2"]);
    expect(all.nextBefore).toBeNull();
    expect(all.unread).toBe(0);
    expect(all.lastActiveAt).not.toBeNull();

    // Hidden rows (evaluation, empty placeholder) still advance the cursor, so a page may be empty while older items remain.
    const latest = (await home.feed("home:a", orbit, { limit: 3 }))!;
    expect(latest.items).toEqual([]);
    expect(latest.nextBefore).not.toBeNull();
    const older = (await home.feed("home:a", orbit, { limit: 3, before: latest.nextBefore! }))!;
    expect(older.items.map(item => item.id)).toEqual(["home:m2", "home:m3", "home:m4"]);
    const oldest = (await home.feed("home:a", orbit, { limit: 3, before: older.nextBefore! }))!;
    expect(oldest.items.map(item => item.id)).toEqual(["home:m1"]);
    expect(oldest.nextBefore).toBeNull();

    // A notice the Dot sent on its own joins the feed once per source and counts as unread.
    await home.markRead("home:a", orbit, latest.latestCursor!);
    const hash = "b".repeat(64);
    expect(await home.addNotice({ dotId: orbit, content: "Security notice", link: { label: "Open email", url: "https://mail.google.com/m/1" }, sourceHash: hash })).toBe(true);
    expect(await home.addNotice({ dotId: orbit, content: "Security notice again", link: null, sourceHash: hash })).toBe(false);
    const newer = (await home.feed("home:a", orbit, { limit: 10, after: latest.latestCursor! }))!;
    expect(newer.items).toEqual([expect.objectContaining({ kind: "NOTICE", author: "DOT", origin: "PROACTIVE", content: "Security notice",
      link: { label: "Open email", url: "https://mail.google.com/m/1" } })]);
    expect(newer.unread).toBe(1);
    expect((await home.markRead("home:a", orbit, newer.latestCursor!))?.unread).toBe(0);
    expect(await home.markRead("home:b", orbit, newer.latestCursor!)).toBeNull();

    // A turn in room two learns what was said in room one after it last spoke, and the undelivered notice.
    const context = await home.conversationContext("home:a", orbit, "home:s2");
    expect(context.messages).toEqual([]);
    const fresh = await home.conversationContext("home:a", orbit, "home:s-new");
    expect(fresh.messages.map(item => item.content)).toEqual(["Plan my week", "Here is your week.", "Created."]);
    expect(fresh.notices.map(item => item.content)).toEqual(["Security notice"]);
    await home.markNoticesDelivered(orbit, fresh.notices.map(item => item.entryId));
    expect((await home.conversationContext("home:a", orbit, "home:s2")).notices).toEqual([]);
    expect((await home.conversationContext("home:b", orbit, "home:s2"))).toEqual({ messages: [], notices: [] });

    // An Agent Proof room sees only itself, never moves the real read marker, and stays out of the real feed and context.
    await pool.query(`INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order,kind) VALUES ('home:proof','Proof','home:tp','home:a',3,'AGENT_PROOF');
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('home:pp','home:proof','Chat','CHAT','IDLE',0);
      INSERT INTO space_agent_sessions(session_id,pane_id,room_id,status,title,is_active,dot_id) VALUES ('home:sp','home:pp','home:proof','READY','Proof',true,'${orbit}');`);
    await message("home:p1", "home:sp", "user", "Proof prompt", 30);
    await message("home:p2", "home:sp", "assistant", "Proof reply", 31);
    const proofFeed = (await home.feed("home:a", orbit, { limit: 10, roomId: "home:proof" }))!;
    expect(proofFeed.scope).toBe("ROOM");
    expect(proofFeed.items.map(item => item.id)).toEqual(["home:p1", "home:p2"]);
    expect(proofFeed.unread).toBe(0);
    const realFeed = (await home.feed("home:a", orbit, { limit: 10, roomId: "home:r1" }))!;
    expect(realFeed.scope).toBe("DOT");
    expect(realFeed.items.map(item => item.id)).not.toContain("home:p1");
    expect(realFeed.items.some(item => item.kind === "NOTICE")).toBe(true);
    expect(await home.markRead("home:a", orbit, "2099-01-01T00:00:00.000Z|home:p2", "home:proof")).toEqual({ unread: 0 });
    expect((await pool.query("SELECT last_read_at FROM dot_feed_state WHERE dot_id=$1", [orbit])).rows[0].last_read_at.toISOString() < "2099").toBe(true);
    expect(await home.conversationContext("home:a", orbit, "home:sp")).toEqual({ messages: [], notices: [] });
    expect((await home.conversationContext("home:a", orbit, "home:s-new2")).messages.map(item => item.content)).not.toContain("Proof prompt");
    // Another user's proof room is not a scope for this owner.
    expect((await home.feed("home:a", orbit, { limit: 10, roomId: "home:other-owner" }))!.scope).toBe("DOT");

    // Settings: defaults, owner-only Dots, proactive merged field by field.
    expect((await home.settings("home:a")).confirmExternalActions).toBe(true);
    expect(await home.updateSettings("home:a", { defaultDotId: otherOrbit })).toBeNull();
    expect(await home.updateSettings("home:a", { proactive: { dotId: otherOrbit } })).toBeNull();
    await home.updateSettings("home:a", { defaultDotId: nova, confirmExternalActions: false, proactive: { enabled: false } });
    const saved = await home.updateSettings("home:a", { proactive: { maxPerDay: 3 }, defaultPermissionMode: "approve_for_me" });
    expect(saved).toMatchObject({ defaultDotId: nova, confirmExternalActions: false, defaultPermissionMode: "approve_for_me",
      proactive: { enabled: false, maxPerDay: 3, intervalMinutes: 60 } });
    expect((await home.settings("home:b")).defaultDotId).toBeNull();

    // Proactive checks: only owners with a connected account, not turned off, claimed once.
    const soon = "2026-10-12T10:00:00.000Z";
    expect(await home.dueProactiveOwners(soon, 10)).toEqual([]);
    await pool.query(`INSERT INTO connector_accounts(account_id,owner_user_id,provider,email,refresh_token_encrypted) VALUES
      ('connector:${"a".repeat(32)}','home:a','GOOGLE','a@home.test','${"x".repeat(20)}'),('connector:${"b".repeat(32)}','home:b','GOOGLE','b@home.test','${"x".repeat(20)}')`);
    await home.updateSettings("home:b", { proactive: { enabled: false } });
    expect(await home.dueProactiveOwners(soon, 10)).toEqual([]);
    await home.updateSettings("home:a", { proactive: { enabled: true } });
    expect(await home.dueProactiveOwners(soon, 10)).toEqual([{ owner: "home:a", nextCheckAt: null }]);
    const [claimA, claimB] = await Promise.all([home.claimProactive("home:a", null, "2026-10-12T11:00:00.000Z"),
      new PostgresDotHomeRepository(pool).claimProactive("home:a", null, "2026-10-12T11:00:00.000Z")]);
    expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
    expect(await home.dueProactiveOwners(soon, 10)).toEqual([]);
    expect(await home.dueProactiveOwners("2026-10-12T11:00:00.000Z", 10)).toEqual([{ owner: "home:a", nextCheckAt: "2026-10-12T11:00:00.000Z" }]);
    expect(await home.claimProactive("home:a", null, "2026-10-12T12:00:00.000Z")).toBe(false);
    await home.saveProactiveState("home:a", { cursors: { "mail:a": soon }, noticesDay: "2026-10-12", noticesToday: 2, lastCheckedAt: soon, lastError: null });
    expect(await home.proactiveState("home:a")).toEqual({ nextCheckAt: "2026-10-12T11:00:00.000Z", cursors: { "mail:a": soon }, noticesDay: "2026-10-12",
      noticesToday: 2, lastCheckedAt: soon, lastError: null });
    expect(await home.noticedSources(orbit, [hash, "c".repeat(64)])).toEqual(new Set([hash]));

    // Proactive model calls: recorded per owner with the Stage 7 shapes, totalled over a window (0181_dot_proactive_usage).
    const measured = { status: "MEASURED" as const, inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100, reasoningOutputTokens: 20, totalTokens: 1100,
      source: "Space Gateway chat/completions usage", observedAt: "2026-10-12T10:00:00.000Z", model: "gpt-5.6-sol" };
    await home.addProactiveUsage("home:a", { calledAt: "2026-10-12T10:00:00.000Z", dotId: orbit, model: "gpt-5.6-sol", status: "COMPLETED", candidates: 4, notices: 2,
      usage: measured, cost: { status: "ESTIMATED", reason: null, amountUsd: 0.0021, source: "tokens × p1", observedAt: "2026-10-12T10:00:00.000Z", priceCatalogVersion: "p1" } });
    await home.addProactiveUsage("home:a", { calledAt: "2026-10-12T11:00:00.000Z", dotId: orbit, model: "gpt-5.6-sol", status: "FAILED", candidates: 1, notices: 0,
      usage: { status: "UNKNOWN", reason: "The call failed before the model gateway reported usage." },
      cost: { status: "UNKNOWN", amountUsd: null, source: null, observedAt: null, priceCatalogVersion: null, reason: "No usage was reported, so no price applies." } });
    // Usage rows are never deleted, however old (Record Retention Invariant 2026-10-20).
    await home.addProactiveUsage("home:b", { calledAt: "2025-01-01T10:00:00.000Z", dotId: otherOrbit, model: "gpt-5.6-sol", status: "COMPLETED", candidates: 1, notices: 0,
      usage: measured, cost: { status: "UNKNOWN", amountUsd: null, source: null, observedAt: null, priceCatalogVersion: null, reason: "No price catalog is configured." } });
    await home.addProactiveUsage("home:b", { calledAt: "2026-10-12T10:30:00.000Z", dotId: otherOrbit, model: "gpt-5.6-sol", status: "COMPLETED", candidates: 1, notices: 1,
      usage: measured, cost: { status: "UNKNOWN", amountUsd: null, source: null, observedAt: null, priceCatalogVersion: null, reason: "No price catalog is configured." } });
    expect(await home.proactiveUsage("home:a", 7, "2026-10-12T12:00:00.000Z")).toMatchObject({ kind: "PROACTIVE", days: 7, calls: 2, failedCalls: 1,
      notices: 2, measuredCalls: 1, totalTokens: 1100, estimatedCostUsd: 0.0021, estimatedCalls: 1, unknownCostCalls: 1, lastCallAt: "2026-10-12T11:00:00.000Z" });
    // The window ends at `now` and holds whole days back from it.
    expect((await home.proactiveUsage("home:a", 1, "2026-10-13T10:30:00.000Z")).calls).toBe(1);
    expect((await home.proactiveUsage("home:b", 7, "2026-10-12T12:00:00.000Z")).calls).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM dot_proactive_usage WHERE owner_user_id = 'home:b'")).rows[0].n).toBe(2);
    await expect(home.addProactiveUsage("home:a", { calledAt: "2026-10-12T12:00:00.000Z", dotId: orbit, model: "m", status: "COMPLETED", candidates: 1, notices: 0,
      usage: { status: "BOGUS" } as never, cost: measured as never })).rejects.toThrow();

    // A Dot's own message also goes to the owner's linked Slack account, which may have no thread (0180_channel_outbox_direct).
    const { PostgresChannelsRepository } = await import("../src/channels-repository.js");
    const channels = new PostgresChannelsRepository(pool);
    await channels.createLinkCode("home:a", "HOME2345", new Date(Date.now() + 600_000).toISOString());
    const slack = await channels.linkIdentity("HOME2345", { provider: "SLACK", tenantId: "T1", externalUserId: "U1", displayName: null, replyAddress: "U1" });
    if (!slack || slack === "LINKED_ELSEWHERE") throw Error("The Slack account did not link.");
    const direct = { threadId: null, identityId: slack.identityId, sourceKey: `dot-notice:${orbit}:${hash}`, kind: "NOTICE" as const, target: "DIRECT" as const, body: "Orbit: hi" };
    expect(await channels.enqueue(direct)).toBe(true);
    expect(await channels.enqueue(direct)).toBe(false);
    expect(await channels.due(10)).toEqual([{ outboxId: expect.stringMatching(/^channel_out:/), threadId: null, identityId: slack.identityId,
      sourceKey: direct.sourceKey, kind: "NOTICE", target: "DIRECT", body: "Orbit: hi", attempts: 0 }]);
    // Without a thread a row must name an account and be a direct message.
    await expect(channels.enqueue({ ...direct, sourceKey: "dot-notice:x", target: "THREAD" })).rejects.toThrow();
    await expect(channels.enqueue({ ...direct, sourceKey: "dot-notice:y", identityId: null })).rejects.toThrow();
    // Unlinking the account removes what was waiting for it.
    expect(await channels.unlink("home:a", slack.identityId)).toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS n FROM channel_outbox`)).rows[0]).toEqual({ n: 0 });
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
