import { describe, expect, it, vi } from "vitest";
import { defaultMarketingCopilotPaneMetadata, type MarketingEvent, type Pane, type Room } from "@space/contracts";
import { InMemoryMarketingCopilotRepository } from "@space/db";
import { createCopilotRunKick } from "../src/copilot-run-kick.js";
import { createMarketingCopilotScheduler } from "../src/marketing-copilot/scheduler.js";
import { createMarketingCopilotService } from "../src/marketing-copilot/service.js";
import { marketingNotificationFor } from "../src/marketing-copilot/wiring.js";
import type { RoomPaneObservation } from "../src/room-pane-control.js";

const owner = "user:operator";
const room = { id: "room:mkt000001", ownerUserId: owner } as Room;
function pane(id: string, paused = false): Pane {
  const metadata = defaultMarketingCopilotPaneMetadata();
  return { id, roomId: room.id, mode: "MARKETING_COPILOT", title: "Marketing Copilot", isClosed: false, marketingCopilotMetadata: { ...metadata, settings: { ...metadata.settings, paused } } } as Pane;
}

async function approvedPost(service: ReturnType<typeof createMarketingCopilotService>, target: Pane, scheduledAt: string | null) {
  const { post } = await service.createPost(owner, target, { channel: "X", kind: "POST", body: "SpaceApp runs your AI coding CLIs side by side.", assets: [], scheduledAt });
  await service.requestReview(owner, target, { postId: post.id });
  return service.decideReview(owner, target, post.id, { decision: "approve" });
}

describe("a post the copilot's own pacing holds (queue item 19)", () => {
  // 27/10 15:44 UTC: one Reddit reply held to 28/10 08:10 by the agent's 5-a-day rule stopped the run; the other approved posts never came up.
  it("keeps its approval, lets space_marketing_next serve the next post, and comes back when its time comes", async () => {
    let at = Date.parse("2026-10-27T15:44:00.000Z");
    const service = createMarketingCopilotService({ repository: new InMemoryMarketingCopilotRepository(), now: () => new Date(at).toISOString() });
    const target = pane("pane:mkt000001");
    await service.startRun(owner, target.id);
    const held = await approvedPost(service, target, null);
    at += 1_000;
    const other = await approvedPost(service, target, null);
    const first = await service.nextItem(owner, target, { waitMs: 0 });
    expect(first).toMatchObject({ kind: "PUBLISH", post: { id: held.id } });
    await expect(service.deferPublish(owner, target, { postId: held.id, until: "2026-10-27T15:00:00.000Z", reason: "past" })).rejects.toThrow("next 14 days");
    expect(await service.deferPublish(owner, target, { postId: held.id, until: "2026-10-28T08:10:00.000Z", reason: "5 Reddit posts a day" }))
      .toMatchObject({ post: { id: held.id, status: "APPROVED", scheduledAt: "2026-10-28T08:10:00.000Z" } });
    expect(await service.nextItem(owner, target, { waitMs: 0 })).toMatchObject({ kind: "PUBLISH", post: { id: other.id } });
    at = Date.parse("2026-10-28T08:11:00.000Z");
    expect((await service.duePosts(owner, target)).map((post) => post.id)).toContain(held.id);
  });
});

describe("marketing copilot scheduler", () => {
  it("starts a run for due posts when the pane's agent runs, else notifies once per pane; paused, busy and not-due panes wait", async () => {
    const service = createMarketingCopilotService({ repository: new InMemoryMarketingCopilotRepository() });
    const withAgent = pane("pane:mkt000001");
    const withoutAgent = pane("pane:mkt000002");
    const paused = pane("pane:mkt000003", true);
    await approvedPost(service, withAgent, null);
    await approvedPost(service, paused, null);
    const started: string[] = [];
    const notified: Array<{ paneId: string; count: number }> = [];
    const scheduler = createMarketingCopilotScheduler({
      service, log: { warn: vi.fn() },
      store: { listRooms: () => [room], listPanes: () => [withAgent, withoutAgent, paused, { ...pane("pane:closed01"), isClosed: true }] },
      hasAgent: async (target) => target.id === withAgent.id,
      hasActiveRun: async (target) => Boolean(await service.activeRun(target.id)),
      startRun: async (_owner, target) => { await service.startRun(owner, target.id); started.push(target.id); },
      notifyDue: async (_owner, _room, target, due) => { notified.push({ paneId: target.id, count: due.length }); }
    });
    // Posts are owner-wide: the pane without an agent sees the same due post and only notifies.
    expect(await scheduler.tick()).toEqual({ started: 1, notified: 1 });
    expect(started).toEqual([withAgent.id]);
    expect(notified).toEqual([{ paneId: withoutAgent.id, count: 2 }]);
    // The started run is active: the next tick leaves that pane alone.
    expect(await scheduler.tick()).toEqual({ started: 0, notified: 1 });
  });

  // Daily upgrade 2026-10-27 (plan clipboard:1NF6u6gcCwtj step 4): four Reddit replies approved in the rail at 11:53 UTC with no schedule waited 3 hours.
  it("treats a post approved with no schedule as due now: the run starts at an empty prompt, a stalled RUNNING run is kicked for it, nothing waits on the operator", async () => {
    const service = createMarketingCopilotService({ repository: new InMemoryMarketingCopilotRepository() });
    const target = pane("pane:mkt000001");
    const approved = await approvedPost(service, target, null);
    expect(approved.status).toBe("APPROVED");
    expect((await service.duePosts(owner, target)).map((post) => post.id)).toEqual([approved.id]);
    // The rail's decision leaves no item for the operator (the pane board's copilotItems), only work for the copilot.
    expect(await service.pendingItems(owner, null)).toEqual([]);
    expect(await service.runView(owner, target)).toMatchObject({ run: null, backlog: 1 });
    let ready = false;
    const startRun = vi.fn(async () => { await service.startRun(owner, target.id); });
    const scheduler = createMarketingCopilotScheduler({ service, log: { warn: vi.fn() }, store: { listRooms: () => [room], listPanes: () => [target] },
      hasAgent: async () => true, ready: async () => ready, hasActiveRun: async (candidate) => Boolean(await service.activeRun(candidate.id)), startRun, notifyDue: vi.fn() });
    expect(await scheduler.tick()).toEqual({ started: 0, notified: 0 }); // the CLI is busy or holds a draft: a later tick starts it
    ready = true;
    expect(await scheduler.tick()).toEqual({ started: 1, notified: 0 });
    // The agent left its loop with the post still due: the RUNNING run is kicked for it (copilot-run-kick reads the same backlog).
    const kickoff = vi.fn(async () => undefined);
    const kick = createCopilotRunKick({ mode: "MARKETING_COPILOT", store: { listRooms: () => [room], listPanes: () => [target] }, log: { warn: vi.fn() },
      paused: (candidate) => service.settingsOf(candidate).paused, runView: (_owner, candidate) => service.runView(owner, candidate), kickoff,
      inspect: async () => ({ sessionId: "cli_session:1", promptFingerprint: "f", state: "IDLE", usageLimited: false, text: "✻ Done.\n────\n❯ \n────" }) as RoomPaneObservation });
    expect(await kick.tick()).toBe(1);
    expect(kickoff).toHaveBeenCalledWith(target, expect.objectContaining({ status: "RUNNING" }));
  });

  // Nous 27/10: dev.to mktpost:bdo_CFnR9I1O (approved 26/10, old licence text) and LinkedIn mktpost:y1xeNDFbp5pX (placeholders) nearly went out.
  it("publishes an unscheduled approval at once only within 24 hours and unchanged since; an older or changed one goes back to review", async () => {
    let clock = Date.parse("2026-10-26T09:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const repository = new InMemoryMarketingCopilotRepository(now);
    const service = createMarketingCopilotService({ repository, now });
    const target = pane("pane:mkt000001");
    const fresh = await approvedPost(service, target, null);
    clock += 23 * 3_600_000;
    expect((await service.duePosts(owner, target)).map((post) => post.id)).toEqual([fresh.id]);
    clock += 2 * 3_600_000; // 25 hours after the approval
    expect(await service.duePosts(owner, target)).toEqual([]);
    expect((await repository.getPost(owner, fresh.id))!.status).toBe("IN_REVIEW");
    const [back] = await repository.listEvents(owner, { postId: fresh.id, types: ["REVIEW_REQUESTED"], limit: 1 });
    expect(back!.payload.staleApproval).toBe("it was approved 2026-10-26 09:00 UTC, more than 24 hours ago");
    expect((await service.pendingItems(owner, null)).map((item) => [item.kind, item.id])).toEqual([["REVIEW", fresh.id]]);
    // Approved again, it is due again; the publish gate sends a post changed after its approval back too.
    await service.decideReview(owner, target, fresh.id, { decision: "approve" });
    expect((await service.duePosts(owner, target)).map((post) => post.id)).toEqual([fresh.id]);
    clock += 5_000;
    await repository.updatePost(owner, fresh.id, { assets: [{ path: "/tmp/card.png", label: "Card", kind: "IMAGE" }] }, ["APPROVED"]);
    await expect(service.beginPublish(owner, target, fresh.id)).rejects.toThrow(/MARKETING_NEEDS_REVIEW/);
    expect((await repository.getPost(owner, fresh.id))!.status).toBe("IN_REVIEW");
    // A scheduled approval keeps its slot, however old.
    const scheduled = await approvedPost(service, target, new Date(clock + 3_600_000).toISOString());
    clock += 50 * 3_600_000;
    expect((await service.duePosts(owner, target)).map((post) => post.id)).toEqual([scheduled.id]);
  });

  it("does nothing while nothing is due", async () => {
    const service = createMarketingCopilotService({ repository: new InMemoryMarketingCopilotRepository() });
    const target = pane("pane:mkt000001");
    await approvedPost(service, target, new Date(Date.now() + 3_600_000).toISOString());
    const startRun = vi.fn();
    const scheduler = createMarketingCopilotScheduler({ service, log: { warn: vi.fn() }, store: { listRooms: () => [room], listPanes: () => [target] },
      hasAgent: async () => true, hasActiveRun: async () => false, startRun, notifyDue: vi.fn() });
    expect(await scheduler.tick()).toEqual({ started: 0, notified: 0 });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("pairs every needs-you notification with the decision that resolves it", () => {
    const event = (type: MarketingEvent["type"], extra: Partial<MarketingEvent> = {}) => ({ id: "mktevt:abc123", type, postId: "mktpost:p1", campaignId: "mktcamp:c1", payload: { questionId: "mktq:q1", ruleId: "mktrule:r1" }, ...extra }) as MarketingEvent;
    expect(marketingNotificationFor(event("REVIEW_REQUESTED"))).toEqual({ action: "raise", key: "review:mktpost:p1" });
    expect(marketingNotificationFor(event("REVIEW_DECIDED"))).toEqual({ action: "resolve", key: "review:mktpost:p1" });
    expect(marketingNotificationFor(event("QUESTION"))).toEqual({ action: "raise", key: "question:mktq:q1" });
    expect(marketingNotificationFor(event("ANSWERED"))).toEqual({ action: "resolve", key: "question:mktq:q1" });
    expect(marketingNotificationFor(event("PUBLISH_FAILED"))).toEqual({ action: "raise", key: "failed:mktpost:p1" });
    expect(marketingNotificationFor(event("PUBLISHING"))).toEqual({ action: "resolve", key: "failed:mktpost:p1" });
    expect(marketingNotificationFor(event("PUBLISHED"))).toEqual({ action: "published", key: "published:mktpost:p1" });
    expect(marketingNotificationFor(event("POST_DRAFTED"))).toBeNull();
  });
});
