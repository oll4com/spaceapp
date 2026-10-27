import { describe, expect, it, vi } from "vitest";
import { defaultMarketingCopilotPaneMetadata, marketingWordingIssues, type MarketingCopilotPaneMetadata, type Pane } from "@space/contracts";
import { InMemoryMarketingCopilotRepository } from "@space/db";
import { createMarketingCopilotService } from "../src/marketing-copilot/service.js";

const owner = "user:operator";

function pane(settings: Partial<MarketingCopilotPaneMetadata["settings"]> = {}): Pane {
  const metadata = defaultMarketingCopilotPaneMetadata();
  return { id: "pane:mkt000001", roomId: "room:mkt000001", mode: "MARKETING_COPILOT", title: "Marketing Copilot 1", marketingCopilotMetadata: { ...metadata, settings: { ...metadata.settings, ...settings } } } as Pane;
}
function setup(start = "2026-10-14T10:00:00.000Z") {
  let clock = Date.parse(start);
  const now = () => new Date(clock).toISOString();
  const repository = new InMemoryMarketingCopilotRepository(now);
  const events: string[] = [];
  const service = createMarketingCopilotService({ repository, now, onEvent: (event) => events.push(event.type) });
  return { service, repository, events, advance: (ms: number) => { clock += ms; } };
}
const body = "SpaceApp runs many AI coding CLIs side by side in rooms you host yourself.";

describe("Marketing Copilot publication gate", () => {
  it("publishes under Assist only what the operator approved, and records the URL as evidence", async () => {
    const { service, events } = setup();
    const target = pane();
    const { post } = await service.createPost(owner, target, { channel: "X", kind: "POST", body, assets: [] });
    await expect(service.beginPublish(owner, target, post.id)).rejects.toThrow(/MARKETING_NEEDS_REVIEW: autonomy on X is Assist/);
    await service.requestReview(owner, target, { postId: post.id });
    expect((await service.pendingItems(owner, target.id)).map((item) => item.kind)).toEqual(["REVIEW"]);
    await service.decideReview(owner, target, post.id, { decision: "approve" });
    const publishing = await service.beginPublish(owner, target, post.id);
    expect(publishing.status).toBe("PUBLISHING");
    await expect(service.finishPublish(owner, target, { postId: post.id, url: "https://evil.example/x.com/status/1" })).rejects.toThrow(/MARKETING_EVIDENCE/);
    await expect(service.finishPublish(owner, target, { postId: post.id, url: "http://x.com/space/status/1" })).rejects.toThrow(/MARKETING_EVIDENCE/);
    const published = await service.finishPublish(owner, target, { postId: post.id, url: "https://x.com/spaceapp/status/1846" });
    expect(published).toMatchObject({ status: "PUBLISHED", publishedUrl: "https://x.com/spaceapp/status/1846" });
    expect(events).toEqual(expect.arrayContaining(["POST_DRAFTED", "REVIEW_REQUESTED", "REVIEW_DECIDED", "PUBLISHING", "PUBLISHED"]));
    await expect(service.finishPublish(owner, target, { postId: post.id, url: "https://x.com/spaceapp/status/1846" })).rejects.toThrow(/Begin the publication first/);
  });

  it("keeps Hacker News, Reddit and Product Hunt reviewed even under Full, and lets Full publish elsewhere", async () => {
    const { service } = setup();
    const target = pane({ autonomy: "FULL" });
    const hn = (await service.createPost(owner, target, { channel: "HACKER_NEWS", kind: "LAUNCH", title: "Show HN: SpaceApp", body, assets: [] })).post;
    await expect(service.beginPublish(owner, target, hn.id)).rejects.toThrow(/autonomy on Hacker News is Assist/);
    const linkedin = (await service.createPost(owner, target, { channel: "LINKEDIN", kind: "POST", body, assets: [] })).post;
    expect((await service.beginPublish(owner, target, linkedin.id)).status).toBe("PUBLISHING");
  });

  it("publishes under Rules only a post an approved rule covers, and counts the rule's use", async () => {
    const { service, repository } = setup();
    const target = pane({ autonomy: "RULES" });
    const { post } = await service.createPost(owner, target, { channel: "GITHUB", kind: "RELEASE_NOTE", body, assets: [] });
    await expect(service.beginPublish(owner, target, post.id)).rejects.toThrow(/no approved rule covers this post/);
    const proposed = await service.proposeRule(owner, target, { name: "Release notes on GitHub", channel: "GITHUB", kinds: ["RELEASE_NOTE"], evidence: [] }, "AGENT");
    await expect(service.beginPublish(owner, target, post.id)).rejects.toThrow(/no approved rule/);
    await service.decideRule(owner, target, proposed.id, "approve");
    expect((await service.beginPublish(owner, target, post.id)).ruleId).toBe(proposed.id);
    expect((await repository.getRule(owner, proposed.id))?.appliedCount).toBe(1);
  });

  it("holds every channel to its limit, the pane's pause and its on/off switch", async () => {
    const { service, advance } = setup();
    const target = pane({ autonomy: "FULL" });
    const publish = async () => {
      const { post } = await service.createPost(owner, target, { channel: "LINKEDIN", kind: "POST", body, assets: [] });
      await service.beginPublish(owner, target, post.id);
      return service.finishPublish(owner, target, { postId: post.id, url: "https://www.linkedin.com/feed/update/urn:li:activity:1" });
    };
    await publish();
    await expect(publish()).rejects.toThrow(/MARKETING_LIMIT: LinkedIn allows 1 post\(s\) per 1 day\(s\); the next slot opens at 2026-10-15T10:00:00.000Z/);
    advance(86_400_000 + 1);
    expect((await publish()).status).toBe("PUBLISHED");
    const off = pane({ autonomy: "FULL", channels: { ...defaultMarketingCopilotPaneMetadata().settings.channels, X: { enabled: false, autonomyCap: "FULL", posts: 3, perDays: 1 } } });
    const x = (await service.createPost(owner, off, { channel: "X", kind: "POST", body, assets: [] })).post;
    await expect(service.beginPublish(owner, off, x.id)).rejects.toThrow(/MARKETING_CHANNEL_OFF/);
    await expect(service.beginPublish(owner, pane({ autonomy: "FULL", paused: true }), x.id)).rejects.toThrow(/MARKETING_PAUSED/);
  });

  it("never lets unqualified absolute claims out without the operator's approval", async () => {
    const { service } = setup();
    const target = pane({ autonomy: "FULL" });
    expect(marketingWordingIssues("Seamless, instant room switching with zero downtime.")).toEqual(["instant", "zero-downtime", "seamless"]);
    expect(marketingWordingIssues("Room switches open in 200 ms.")).toEqual(["latency-number"]);
    expect(marketingWordingIssues("Room switches open in 200 ms (target, not benchmarked).")).toEqual([]);
    expect(marketingWordingIssues("There is no guarantee of exactly-once delivery.")).toEqual([]);
    const { post, wordingIssues } = await service.createPost(owner, target, { channel: "X", kind: "POST", body: "The fastest, seamless agent workspace.", assets: [] });
    expect(wordingIssues).toEqual(["seamless"]);
    await expect(service.beginPublish(owner, target, post.id)).rejects.toThrow(/unqualified claims \(seamless\)/);
    await service.requestReview(owner, target, { postId: post.id });
    await service.decideReview(owner, target, post.id, { decision: "approve" });
    expect((await service.beginPublish(owner, target, post.id)).status).toBe("PUBLISHING");
  });
});

describe("Marketing Copilot reviews, briefs and runs", () => {
  it("learns from edits and rejections and sends revisions back to the agent as briefs", async () => {
    const { service, repository } = setup();
    const target = pane();
    const first = (await service.createPost(owner, target, { channel: "REDDIT", kind: "POST", target: "r/selfhosted", body, assets: [] })).post;
    await service.requestReview(owner, target, { postId: first.id });
    const edited = await service.decideReview(owner, target, first.id, { decision: "edit", body: "I built SpaceApp, a self-hosted workspace for AI coding CLIs. Feedback welcome." });
    expect(edited).toMatchObject({ status: "APPROVED", body: expect.stringContaining("I built SpaceApp") });
    const second = (await service.createPost(owner, target, { channel: "X", kind: "THREAD", body, assets: [] })).post;
    await service.requestReview(owner, target, { postId: second.id });
    expect((await service.decideReview(owner, target, second.id, { decision: "revise", note: "Lead with the install command." })).status).toBe("DRAFT");
    const third = (await service.createPost(owner, target, { channel: "X", kind: "POST", body, assets: [] })).post;
    await service.requestReview(owner, target, { postId: third.id });
    expect((await service.decideReview(owner, target, third.id, { decision: "reject", note: "Too salesy." })).status).toBe("REJECTED");
    const lessons = await repository.listMemory(owner, { kinds: ["LESSON"], limit: 10 });
    expect(lessons.map((memory) => memory.tags[0]).sort()).toEqual(["review-edit", "review-reject"]);
    const briefs = await repository.listEvents(owner, { types: ["BRIEF"], status: ["PENDING"], limit: 10 });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ postId: second.id, message: expect.stringContaining("Lead with the install command.") });
    await expect(service.decideReview(owner, target, third.id, { decision: "approve" })).rejects.toThrow(/no longer waiting/);
  });

  it("serves briefs first, then approved posts that are due, and finishes when nothing is left", async () => {
    const { service, advance } = setup();
    const target = pane();
    expect(await service.nextItem(owner, target, { waitMs: 0 })).toEqual({ done: true, reason: "NO_RUN" });
    await service.startRun(owner, target.id);
    await service.createBrief(owner, target, { text: "A launch thread for 0.2.5 on X" });
    const later = (await service.createPost(owner, target, { channel: "X", kind: "POST", body, assets: [], scheduledAt: "2026-10-14T12:00:00.000Z" })).post;
    await service.requestReview(owner, target, { postId: later.id });
    await service.decideReview(owner, target, later.id, { decision: "approve" });
    const brief = await service.nextItem(owner, target, { waitMs: 0 });
    expect(brief).toMatchObject({ done: false, kind: "BRIEF", item: { message: "A launch thread for 0.2.5 on X", status: "TAKEN" } });
    await service.reportBrief(owner, target, { eventId: (brief as { item: { id: string } }).item.id, outcome: "drafted", summary: "Drafted a 4-post thread" });
    // The approved post is not due yet: the run finishes.
    expect(await service.nextItem(owner, target, { waitMs: 0 })).toEqual({ done: true, reason: "QUEUE_EMPTY" });
    advance(3 * 3_600_000);
    await service.startRun(owner, target.id);
    expect(await service.nextItem(owner, target, { waitMs: 0 })).toMatchObject({ done: false, kind: "PUBLISH", post: { id: later.id } });
    expect((await service.runView(owner, target)).backlog).toBe(1);
  });

  // Stable 2026-10-23: the briefs Nous gave Bruno's Marketing pane (12:09-17:21 UTC) were taken by Dino's: one queue per owner.
  it("gives a brief to the pane it names, a brief without a pane to any, and serves both before a due post", async () => {
    const { service } = setup();
    const mine = pane();
    const other = { ...pane(), id: "pane:mkt000002", title: "Marketing Copilot 2" } as Pane;
    for (const target of [mine, other]) await service.startRun(owner, target.id);
    const due = (await service.createPost(owner, other, { channel: "X", kind: "POST", body, assets: [] })).post;
    await service.requestReview(owner, other, { postId: due.id });
    await service.decideReview(owner, other, due.id, { decision: "approve" });
    await service.createBrief(owner, mine, { text: "For Marketing Copilot 1" });
    await service.createBrief(owner, null, { text: "For any pane" });
    await service.createBrief(owner, other, { text: "For Marketing Copilot 2" });
    expect((await service.runView(owner, other)).backlog).toBe(3);
    expect(await service.nextItem(owner, other, { waitMs: 0 })).toMatchObject({ kind: "BRIEF", item: { message: "For any pane" } });
    expect(await service.nextItem(owner, other, { waitMs: 0 })).toMatchObject({ kind: "BRIEF", item: { message: "For Marketing Copilot 2", payload: { takenByPaneId: other.id } } });
    expect(await service.nextItem(owner, other, { waitMs: 0 })).toMatchObject({ kind: "PUBLISH", post: { id: due.id } });
    expect(await service.nextItem(owner, mine, { waitMs: 0 })).toMatchObject({ kind: "BRIEF", item: { message: "For Marketing Copilot 1", payload: { takenByPaneId: mine.id } } });
  });

  it("asks the operator, remembers the answer, and keeps proposed campaigns waiting for approval", async () => {
    const { service, repository } = setup();
    const target = pane();
    const { questionId } = await service.askQuestion(owner, target, { question: "Which subreddit allows self-promotion on Saturdays?" });
    expect((await service.pendingItems(owner, target.id)).map((item) => item.kind)).toEqual(["QUESTION"]);
    await service.answerQuestion(owner, target, { questionId, answer: "r/selfhosted" });
    expect(await service.waitForAnswer(owner, { questionId, waitMs: 0 })).toEqual({ answered: true, answer: "r/selfhosted" });
    const campaign = await service.createCampaign(owner, target, { name: "0.2.5 release", channels: ["X", "GITHUB"] }, "AGENT");
    expect(campaign.status).toBe("PROPOSED");
    expect((await service.pendingItems(owner, target.id)).map((item) => item.kind)).toEqual(["CAMPAIGN"]);
    expect((await service.decideCampaign(owner, target, campaign.id, "approve")).status).toBe("ACTIVE");
    expect((await repository.listEvents(owner, { types: ["BRIEF"], limit: 5 }))[0]).toMatchObject({ campaignId: campaign.id, status: "PENDING" });
    expect((await service.recallMemory(owner, { query: "subreddit saturdays", limit: 5 }))[0]?.text).toBe("r/selfhosted");
  });
});

describe("Marketing Copilot bookmarks", () => {
  it("keeps the owner's bookmarks with their Google account and opens one through the pane browser", async () => {
    const repository = new InMemoryMarketingCopilotRepository();
    const openInBrowser = vi.fn(async () => ({ activePageId: "page:new" }));
    const service = createMarketingCopilotService({ repository, openInBrowser });
    const x = await service.createBookmark(owner, { url: "https://www.x.com/home", profileId: "google_account:dev", accountLabel: "spaceappdv@gmail.com" });
    expect(x).toMatchObject({ title: "x.com", profileId: "google_account:dev", accountLabel: "spaceappdv@gmail.com" });
    // A bookmark in the pane's own account names no account.
    const hn = await service.createBookmark(owner, { url: "https://news.ycombinator.com/", title: "HN", profileId: null, accountLabel: "ignored" });
    expect(hn.accountLabel).toBeNull();
    expect((await service.listBookmarks(owner)).map((bookmark) => bookmark.id)).toEqual([x.id, hn.id]);
    expect(await service.listBookmarks("user:other")).toEqual([]);

    const target = pane();
    const actor = { holderType: "AGENT" as const, holderId: "cli:session" };
    expect(await service.openBookmark(owner, target, x.id, "trace", actor)).toEqual({ bookmark: x, pages: { activePageId: "page:new" } });
    expect(openInBrowser).toHaveBeenCalledWith(owner, target, x, "trace", actor);
    await expect(service.openBookmark("user:other", target, x.id, "trace", actor)).rejects.toThrow(/was not found/);
    expect(await service.deleteBookmark("user:other", x.id)).toBe(false);
    expect(await service.deleteBookmark(owner, x.id)).toBe(true);
    expect((await service.listBookmarks(owner)).map((bookmark) => bookmark.id)).toEqual([hn.id]);
  });
});
