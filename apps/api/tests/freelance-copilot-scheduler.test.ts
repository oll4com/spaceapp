import { describe, expect, it, vi } from "vitest";
import { defaultFreelanceCopilotPaneMetadata, type FreelanceEvent, type Pane, type Room } from "@space/contracts";
import { InMemoryFreelanceCopilotRepository } from "@space/db";
import { createFreelanceCopilotScheduler } from "../src/freelance-copilot/scheduler.js";
import { createFreelanceCopilotService } from "../src/freelance-copilot/service.js";
import { freelanceNotificationFor } from "../src/freelance-copilot/wiring.js";
import type { MailboxFactory } from "../src/job-apply/mailbox.js";

const owner = "user:operator";
const room = { id: "room:fl0000001", ownerUserId: owner } as Room;
const crypto = { seal: (plain: string) => plain, open: (sealed: string) => sealed };
function pane(id: string, paused = false): Pane {
  const metadata = defaultFreelanceCopilotPaneMetadata();
  return { id, roomId: room.id, mode: "FREELANCE_COPILOT", title: "Freelance Copilot", isClosed: false, freelanceCopilotMetadata: { ...metadata, settings: { ...metadata.settings, paused } } } as Pane;
}

describe("freelance copilot scheduler", () => {
  it("turns new mail into work, starts a run where the agent runs, notifies elsewhere, and leaves paused panes alone", async () => {
    const inbox = [{ uid: 1, from: "donotreply@upwork.com", subject: "Old", receivedAt: new Date().toISOString(), snippet: "", text: "" }];
    const mailboxes: MailboxFactory = { async open() { return { recent: async () => inbox, texts: async () => inbox.map((entry) => ({ ...entry })), close: async () => undefined }; } };
    const service = createFreelanceCopilotService({ repository: new InMemoryFreelanceCopilotRepository(), crypto, mailboxes });
    await service.connectMailbox(owner, { host: "example.invalid", port: 993, secure: true, user: "work@example.invalid", password: "p" });
    const withAgent = pane("pane:fl0000001");
    const withoutAgent = pane("pane:fl0000002");
    const paused = pane("pane:fl0000003", true);
    const started: string[] = [];
    const notified: Array<{ paneId: string; backlog: number }> = [];
    const scheduler = createFreelanceCopilotScheduler({
      service, log: { warn: vi.fn() },
      store: { listRooms: () => [room], listPanes: () => [withAgent, withoutAgent, paused, { ...pane("pane:closed01"), isClosed: true }] },
      hasAgent: async (target) => target.id === withAgent.id,
      hasActiveRun: async (target) => Boolean(await service.activeRun(target.id)),
      startRun: async (_owner, target) => { await service.startRun(owner, target.id); started.push(target.id); },
      notifyBacklog: async (_owner, _room, target, backlog) => { notified.push({ paneId: target.id, backlog }); }
    });
    // The first tick only sets the mailbox cursor: nothing waits yet.
    expect(await scheduler.tick()).toEqual({ started: 0, notified: 0, mails: 0 });
    inbox.push({ uid: 2, from: "donotreply@upwork.com", subject: "New message from Acme", receivedAt: new Date().toISOString(), snippet: "Hi", text: "Hi" });
    expect(await scheduler.tick()).toEqual({ started: 1, notified: 1, mails: 1 });
    expect(started).toEqual([withAgent.id]);
    expect(notified).toEqual([{ paneId: withoutAgent.id, backlog: 1 }]);
    // The started run is active: the next tick leaves that pane alone and reads no mail twice.
    expect(await scheduler.tick()).toEqual({ started: 0, notified: 1, mails: 0 });
  });

  it("pairs every needs-you notification with the decision that resolves it, the client handoff first", () => {
    const event = (type: FreelanceEvent["type"]) => ({ id: "flevt:abc123", type, leadId: "fllead:l1", messageId: "flmsg:m1", payload: { questionId: "flq:q1", ruleId: "flrule:r1" } }) as FreelanceEvent;
    expect(freelanceNotificationFor(event("CLIENT_READY"))).toEqual({ action: "clientReady", key: "client-ready:fllead:l1" });
    expect(freelanceNotificationFor(event("LEAD_DECIDED"))).toEqual({ action: "resolve", key: "client-ready:fllead:l1" });
    expect(freelanceNotificationFor(event("REVIEW_REQUESTED"))).toEqual({ action: "raise", key: "review:flmsg:m1" });
    expect(freelanceNotificationFor(event("REVIEW_DECIDED"))).toEqual({ action: "resolve", key: "review:flmsg:m1" });
    expect(freelanceNotificationFor(event("SEND_FAILED"))).toEqual({ action: "raise", key: "failed:flmsg:m1" });
    expect(freelanceNotificationFor(event("SENDING"))).toEqual({ action: "resolve", key: "failed:flmsg:m1" });
    expect(freelanceNotificationFor(event("SENT"))).toBeNull();
  });
});
