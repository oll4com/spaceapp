import { describe, expect, it, vi } from "vitest";
import { defaultFreelanceCopilotPaneMetadata, type FreelanceEvent, type Pane, type Room } from "@space/contracts";
import { InMemoryFreelanceCopilotRepository } from "@space/db";
import { SpaceNotFoundError } from "@space/runtime";
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

describe("a closed Freelance pane with follow-ups due (queue item 44)", () => {
  it("reopens the owner's newest closed pane when follow-ups or approved messages are due and none is open; a refused reopen notifies", async () => {
    const closed = { ...pane("pane:flclose01"), paneName: "Leo", isClosed: true, updatedAt: "2026-10-28T03:00:00.000Z" } as Pane;
    let due = 1;
    let refuse = false;
    const reopened: string[] = [];
    const notified: string[] = [];
    const service = { settingsOf: (target: Pane) => ({ paused: Boolean(target.freelanceCopilotMetadata?.settings.paused) }), pollMail: async () => 0, weeklyDigest: async () => undefined,
      runView: async () => ({ backlog: 0 }), queueHunt: async () => null, followUpsDue: async () => Array.from({ length: due }, () => ({})), approvedDue: async () => [] } as never;
    let panes: Pane[] = [closed];
    let at = Date.parse("2026-10-28T06:00:00.000Z");
    const scheduler = createFreelanceCopilotScheduler({ service, log: { warn: vi.fn() }, // Like the real store: closed panes only when asked (28/10 Cleo/Bob was never reopened: the scheduler did not ask).
      store: { listRooms: () => [{ ...room, name: "Bruno" } as Room], listPanes: (_roomId: string, includeClosed = false) => includeClosed ? panes : panes.filter((entry) => !entry.isClosed) },
      hasAgent: async () => true, hasActiveRun: async () => false, startRun: vi.fn(async () => {}), notifyBacklog: async (_owner, _room, target) => { notified.push(target.id); },
      reopen: { reopen: async (_owner, target) => { if (refuse) throw new Error("refused"); reopened.push(target.id); }, now: () => at } });
    await scheduler.tick();
    expect(reopened).toEqual([closed.id]);
    // Nothing due, or an open Freelance pane: it stays closed.
    due = 0; at += 11 * 60_000; await scheduler.tick();
    due = 1; panes = [closed, pane("pane:flopen001")]; at += 11 * 60_000; await scheduler.tick();
    expect(reopened).toEqual([closed.id]);
    panes = [closed]; refuse = true; at += 11 * 60_000; await scheduler.tick();
    expect(notified).toEqual([closed.id]);
  });
});

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
    // The first tick only sets the mailbox cursor: no mail waits yet, so the pane whose agent runs starts a job hunt (operator 14/11).
    expect(await scheduler.tick()).toEqual({ started: 1, notified: 0, mails: 0 });
    expect(started).toEqual([withAgent.id]);
    await service.stopRun(owner, withAgent.id);
    inbox.push({ uid: 2, from: "donotreply@upwork.com", subject: "New message from Acme", receivedAt: new Date().toISOString(), snippet: "Hi", text: "Hi" });
    expect(await scheduler.tick()).toEqual({ started: 1, notified: 1, mails: 1 });
    expect(started).toEqual([withAgent.id, withAgent.id]);
    expect(notified).toEqual([{ paneId: withoutAgent.id, backlog: 1 }]);
    // The started run is active: the next tick leaves that pane alone and reads no mail twice.
    expect(await scheduler.tick()).toEqual({ started: 0, notified: 1, mails: 0 });
  });

  it("gives an idle pane one job-hunt brief and a run; none while a hunt is recent or open, none when paused or without an agent (operator 14/11)", async () => {
    let at = Date.parse("2026-11-14T05:00:00.000Z");
    const clock = () => new Date(at).toISOString();
    const service = createFreelanceCopilotService({ repository: new InMemoryFreelanceCopilotRepository(clock), crypto, mailboxes: { open: async () => { throw new Error("no mailbox"); } }, now: clock });
    const idle = pane("pane:flhunt001");
    const paused = pane("pane:flhunt002", true);
    const noAgent = pane("pane:flhunt003");
    const started: string[] = [];
    const scheduler = createFreelanceCopilotScheduler({
      service, log: { warn: vi.fn() }, store: { listRooms: () => [room], listPanes: () => [idle, paused, noAgent] },
      hasAgent: async (target) => target.id !== noAgent.id, hasActiveRun: async (target) => Boolean(await service.activeRun(target.id)),
      startRun: async (_owner, target) => { await service.startRun(owner, target.id); started.push(target.id); }, notifyBacklog: vi.fn(async () => {})
    });
    const hunts = async () => (await service.listEvents(owner, { types: ["BRIEF"] })).filter((brief) => brief.payload.hunt === true);
    expect((await scheduler.tick()).started).toBe(1);
    expect(started).toEqual([idle.id]);
    expect((await hunts()).map((hunt) => [hunt.paneId, hunt.status])).toEqual([[idle.id, "PENDING"]]);
    // The agent does the hunt and the run finishes: a hunt 10 min old waits, one 21 min old is followed by the next.
    const next = await service.nextItem(owner, idle, { waitMs: 0 });
    if (next.done || !("item" in next)) throw new Error("the hunt was not handed out");
    await service.reportItem(owner, idle, { eventId: next.item.id, outcome: "done", summary: "Applied to 6 jobs" });
    expect((await service.nextItem(owner, idle, { waitMs: 0 })).done).toBe(true);
    at += 10 * 60_000;
    expect((await scheduler.tick()).started).toBe(0);
    at += 11 * 60_000;
    expect((await scheduler.tick()).started).toBe(1);
    expect(await hunts()).toHaveLength(2);
    // A hunt taken and never reported (a crashed CLI) blocks the next one: one open hunt at a time.
    await service.nextItem(owner, idle, { waitMs: 0 });
    await service.stopRun(owner, idle.id);
    at += 25 * 60_000;
    expect((await scheduler.tick()).started).toBe(0);
    expect(await hunts()).toHaveLength(2);
  });

  it("backs off hunts that keep ending without a job (a standing block), tells Nous once, and hunts again on a new mail or 3 h later (21/11, Dana)", async () => {
    let at = Date.parse("2026-11-21T07:00:00.000Z");
    const clock = () => new Date(at).toISOString();
    const repository = new InMemoryFreelanceCopilotRepository(clock);
    const notice = vi.fn();
    const service = createFreelanceCopilotService({ repository, crypto, mailboxes: { open: async () => { throw new Error("no mailbox"); } }, now: clock, notice });
    const dana = pane("pane:flblock01");
    const hunt = async (outcome: "done" | "skipped") => {
      at += 21 * 60_000;
      if (!(await service.queueHunt(owner, dana))) return false;
      await service.startRun(owner, dana.id);
      const next = await service.nextItem(owner, dana, { waitMs: 0 });
      if (next.done || !("item" in next)) throw new Error("the hunt was not handed out");
      await service.reportItem(owner, dana, { eventId: next.item.id, outcome, summary: outcome === "done" ? "Applied to 2 jobs" : "No application. Upwork: Connects 0 (10 needed, not buying)" });
      await service.stopRun(owner, dana.id);
      return true;
    };
    expect(await hunt("done")).toBe(true);
    expect(await hunt("skipped")).toBe(true);
    expect(await hunt("skipped")).toBe(true);
    // Two hunts in a row closed without a job: the next waits, and Nous hears of the block once.
    expect(await hunt("skipped")).toBe(false);
    expect(await hunt("skipped")).toBe(false);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]![2]).toContain("Connects 0");
    // A new job-alert mail lets the next hunt run; it is skipped again and the block is not told twice.
    await repository.createEvent({ ownerUserId: owner, paneId: dana.id, runId: null, leadId: null, messageId: null, type: "MAIL", status: "DONE", message: "Mail from Upwork: New job alert", payload: { channel: "upwork" } });
    expect(await hunt("skipped")).toBe(true);
    expect(await hunt("skipped")).toBe(false);
    at += 3 * 60 * 60_000;
    expect(await hunt("skipped")).toBe(true);
    expect(notice).toHaveBeenCalledTimes(1);
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

  it("skips a room deleted between listRooms and listPanes without aborting the tick for remaining rooms", async () => {
    const gone = { id: "room:proofgone1", ownerUserId: owner } as Room;
    const service = createFreelanceCopilotService({ repository: new InMemoryFreelanceCopilotRepository(), crypto, mailboxes: { open: async () => { throw new Error("no mailbox"); } } });
    const livePane = pane("pane:flsurvive1");
    const started: string[] = [];
    const warn = vi.fn();
    const scheduler = createFreelanceCopilotScheduler({
      service, log: { warn },
      store: {
        listRooms: () => [gone, room],
        listPanes: (roomId) => {
          if (roomId === gone.id) throw new SpaceNotFoundError(`Room ${roomId} was not found.`);
          return [livePane];
        }
      },
      hasAgent: async () => true, hasActiveRun: async () => false,
      startRun: async (_owner, target) => { started.push(target.id); },
      notifyBacklog: vi.fn(async () => {})
    });
    expect((await scheduler.tick()).started).toBe(1);
    expect(started).toEqual([livePane.id]);
    expect(warn).not.toHaveBeenCalled();
  });
});
