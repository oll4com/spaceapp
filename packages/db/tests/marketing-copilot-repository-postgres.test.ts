// Marketing Copilot tables on a real, disposable PostgreSQL: migrations 0190-0191 apply on top of the full
// chain, and the repository round-trips campaigns, posts (guarded status transitions, the publication count),
// memory (keyed upserts per channel, full-text recall), briefs as work items, runs and rules.
// Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMarketingCopilotRepository } from "../src/marketing-copilot-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:marketing";

describe.skipIf(unavailable !== null)(`marketing copilot repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresMarketingCopilotRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("marketing");
    await server.createDatabase("space_marketing");
    pool = server.pool("space_marketing", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [owner, "marketing@space.local"]);
    repository = new PostgresMarketingCopilotRepository(pool as unknown as ConstructorParameters<typeof PostgresMarketingCopilotRepository>[0]);
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("round-trips campaigns and posts with guarded status transitions and the publication count", async () => {
    const campaign = await repository.createCampaign({ ownerUserId: owner, name: "0.2.5 release", goal: null, channels: ["X", "GITHUB"], status: "PROPOSED", startsAt: null, endsAt: null, proposedBy: "AGENT", payload: { version: "0.2.5" } });
    expect(campaign).toMatchObject({ channels: ["X", "GITHUB"], payload: { version: "0.2.5" }, status: "PROPOSED" });
    expect((await repository.updateCampaign(owner, campaign.id, { status: "ACTIVE" }))?.status).toBe("ACTIVE");
    expect(await repository.listCampaigns(owner, ["ACTIVE"])).toHaveLength(1);
    const post = await repository.createPost({ ownerUserId: owner, paneId: "pane:mkt000001", campaignId: campaign.id, channel: "X", kind: "THREAD", target: null, title: null, body: "Hello",
      assets: [{ path: "var/artifacts/marketing-copilot/a.png", label: "Banner", kind: "IMAGE" }], status: "DRAFT", scheduledAt: null, reviewNote: null, ruleId: null, publishedUrl: null, publishedAt: null, evidence: {}, metrics: {} });
    expect(post.assets).toHaveLength(1);
    expect(await repository.updatePost(owner, post.id, { status: "PUBLISHING" }, ["APPROVED"])).toBeNull();
    expect((await repository.updatePost(owner, post.id, { status: "APPROVED", scheduledAt: "2026-10-14T12:00:00.000Z" }, ["DRAFT", "IN_REVIEW"]))?.scheduledAt).toBe("2026-10-14T12:00:00.000Z");
    expect(await repository.countPublications(owner, "X", "2026-01-01T00:00:00.000Z")).toBe(0);
    await repository.updatePost(owner, post.id, { status: "PUBLISHED", publishedAt: new Date().toISOString(), publishedUrl: "https://x.com/s/1", evidence: { url: "https://x.com/s/1" } }, ["APPROVED"]);
    expect(await repository.countPublications(owner, "X", new Date(Date.now() - 3_600_000).toISOString())).toBe(1);
    expect(await repository.countPublications(owner, "X", new Date(Date.now() + 3_600_000).toISOString())).toBe(0);
    const reply = await repository.createPost({ ...post, ownerUserId: owner, kind: "REPLY", status: "PUBLISHED", publishedAt: new Date().toISOString() });
    expect(await repository.countPublications(owner, "X", new Date(Date.now() - 3_600_000).toISOString())).toBe(1);
    expect((await repository.listPosts(owner, { status: ["PUBLISHED"], channel: "X", excludeKinds: ["REPLY"] })).map((row) => row.id)).not.toContain(reply.id);
    expect((await repository.listPosts(owner, { status: ["PUBLISHED"], channel: "X", campaignId: campaign.id, limit: 10 }))[0]?.evidence).toEqual({ url: "https://x.com/s/1" });
  });

  it("upserts memory per kind, key and channel and recalls it by text", async () => {
    const first = await repository.upsertMemory({ ownerUserId: owner, kind: "CHANNEL_RULE", key: "r/selfhosted", text: "Self-promotion only on Saturdays", channel: "REDDIT", tags: [], source: "USER", pinned: false });
    const again = await repository.upsertMemory({ ownerUserId: owner, kind: "CHANNEL_RULE", key: "r/selfhosted", text: "Self-promotion only on Saturdays, with a disclosure", channel: "REDDIT", tags: ["rules"], source: "USER", pinned: false });
    expect(again.id).toBe(first.id);
    const other = await repository.upsertMemory({ ownerUserId: owner, kind: "CHANNEL_RULE", key: "r/selfhosted", text: "Global key", channel: null, tags: [], source: "AGENT", pinned: true });
    expect(other.id).not.toBe(first.id);
    expect((await repository.listMemory(owner, { query: "saturdays disclosure", limit: 10 })).map((memory) => memory.id)).toEqual([first.id]);
    expect((await repository.updateMemory(owner, first.id, { pinned: true }))?.pinned).toBe(true);
    await repository.touchMemories(owner, [first.id]);
    expect((await repository.listMemory(owner, { channel: "REDDIT", limit: 10 })).find((memory) => memory.id === first.id)?.uses).toBe(1);
    expect(await repository.deleteMemory(owner, other.id)).toBe(true);
  });

  it("hands out briefs once, runs one active run per pane and counts rule uses", async () => {
    const brief = await repository.createEvent({ ownerUserId: owner, paneId: "pane:mkt000001", runId: null, postId: null, campaignId: null, type: "BRIEF", status: "PENDING", message: "A thread", payload: { text: "A thread" } });
    const taken = await repository.takeNextBrief(owner, "pane:mkt000001", 60_000);
    expect(taken).toMatchObject({ id: brief.id, status: "TAKEN", payload: { text: "A thread", takenByPaneId: "pane:mkt000001" } });
    expect(await repository.takeNextBrief(owner, "pane:mkt000001", 60_000)).toBeNull();
    // A brief given to one pane is that pane's alone; one without a pane is any pane's.
    await repository.createEvent({ ownerUserId: owner, paneId: "pane:mkt000002", runId: null, postId: null, campaignId: null, type: "BRIEF", status: "PENDING", message: "For pane 2", payload: {} });
    expect(await repository.takeNextBrief(owner, "pane:mkt000001", 60_000)).toBeNull();
    const shared = await repository.createEvent({ ownerUserId: owner, paneId: null, runId: null, postId: null, campaignId: null, type: "BRIEF", status: "PENDING", message: "For any pane", payload: {} });
    expect(await repository.takeNextBrief(owner, "pane:mkt000001", 60_000)).toMatchObject({ id: shared.id, payload: { takenByPaneId: "pane:mkt000001" } });
    expect(await repository.takeNextBrief(owner, "pane:mkt000002", 60_000)).toMatchObject({ message: "For pane 2", payload: { takenByPaneId: "pane:mkt000002" } });
    expect((await repository.setEventStatus(owner, brief.id, "DONE"))?.status).toBe("DONE");
    const run = await repository.createRun({ ownerUserId: owner, paneId: "pane:mkt000001" });
    await expect(repository.createRun({ ownerUserId: owner, paneId: "pane:mkt000001" })).rejects.toThrow();
    expect((await repository.updateRun(owner, run.id, { counters: { ...run.counters, drafted: 2 }, kickoffSentAt: new Date().toISOString() }))?.counters.drafted).toBe(2);
    expect((await repository.getActiveRun("pane:mkt000001"))?.id).toBe(run.id);
    const rule = await repository.createRule({ ownerUserId: owner, name: "Release notes", channel: "GITHUB", kinds: ["RELEASE_NOTE"], campaignId: null, status: "APPROVED", evidence: ["Approved twice"], proposedBy: "USER" });
    expect(rule).toMatchObject({ kinds: ["RELEASE_NOTE"], evidence: ["Approved twice"], appliedCount: 0 });
    expect(rule.decidedAt).not.toBeNull();
    expect((await repository.updateRule(owner, rule.id, { appliedCount: 1, lastAppliedAt: new Date().toISOString() }))?.appliedCount).toBe(1);
    expect(await repository.listRules(owner, ["APPROVED"])).toHaveLength(1);
  });

  it("keeps one value per day, source and key and reads days as written", async () => {
    await repository.recordMetrics(owner, [{ day: "2026-10-13", source: "GITHUB", key: "stars", value: 100 }, { day: "2026-10-14", source: "GITHUB", key: "stars", value: 105 }]);
    await repository.recordMetrics(owner, [{ day: "2026-10-14", source: "GITHUB", key: "stars", value: 107 }]);
    expect(await repository.listMetrics(owner, "2026-10-13")).toEqual([{ day: "2026-10-13", source: "GITHUB", key: "stars", value: 100 }, { day: "2026-10-14", source: "GITHUB", key: "stars", value: 107 }]);
    expect(await repository.listMetrics(owner, "2026-10-14")).toHaveLength(1);
    // Analytics reads every recorded value with no lower bound (a "0000-01-01" floor made Postgres answer 22008, 9/11).
    expect(await repository.listMetrics(owner)).toEqual(await repository.listMetrics(owner, "2026-10-13"));
  });

  it("keeps bookmarks per owner in the order they were added (migration 0207)", async () => {
    const x = await repository.createBookmark({ ownerUserId: owner, title: "x.com", url: "https://x.com/home", profileId: "google_account:dev", accountLabel: "spaceappdv@gmail.com" });
    const hn = await repository.createBookmark({ ownerUserId: owner, title: "HN", url: "https://news.ycombinator.com/", profileId: null, accountLabel: null });
    expect(x).toMatchObject({ id: expect.stringMatching(/^mktbm:/), profileId: "google_account:dev", accountLabel: "spaceappdv@gmail.com", createdAt: expect.any(String) });
    expect((await repository.listBookmarks(owner)).map((bookmark) => bookmark.id)).toEqual([x.id, hn.id]);
    expect(await repository.getBookmark("user:other", x.id)).toBeNull();
    expect(await repository.deleteBookmark(owner, x.id)).toBe(true);
    expect(await repository.getBookmark(owner, x.id)).toBeNull();
  });

  it("migration 0192 lets Marketing Copilot raise Space notifications", async () => {
    await pool.query("INSERT INTO space_notifications(id, owner_user_id, source, kind, severity, title) VALUES ('notification:mkt000001', $1, 'MARKETING_COPILOT', 'REVIEW_REQUESTED', 'ATTENTION', 'Marketing Copilot needs you')", [owner]);
    await expect(pool.query("INSERT INTO space_notifications(id, owner_user_id, source, kind, severity, title) VALUES ('notification:mkt000002', $1, 'NOT_A_SOURCE', 'X', 'INFO', 'x')", [owner])).rejects.toThrow();
  });
});
