import { describe, expect, it, vi } from "vitest";
import { defaultMarketingCopilotPaneMetadata, type MarketingEvent, type Pane, type Room } from "@space/contracts";
import { InMemoryMarketingCopilotRepository } from "@space/db";
import { createMarketingCopilotScheduler } from "../src/marketing-copilot/scheduler.js";
import { createMarketingCopilotService } from "../src/marketing-copilot/service.js";
import { marketingNotificationFor } from "../src/marketing-copilot/wiring.js";

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
