import { describe, expect, it } from "vitest";
import { defaultFreelanceCopilotPaneMetadata, type FreelanceCopilotPaneMetadata, type Pane } from "@space/contracts";
import { InMemoryFreelanceCopilotRepository } from "@space/db";
import { createFreelanceCopilotService } from "../src/freelance-copilot/service.js";
import type { MailboxFactory, MailboxMessageSummary } from "../src/job-apply/mailbox.js";

const owner = "user:operator";
const crypto = { seal: (plain: string) => `sealed:${plain}`, open: (sealed: string) => sealed.replace(/^sealed:/, "") };

function pane(settings: Partial<FreelanceCopilotPaneMetadata["settings"]> = {}): Pane {
  const metadata = defaultFreelanceCopilotPaneMetadata();
  return { id: "pane:fl0000001", roomId: "room:fl0000001", mode: "FREELANCE_COPILOT", title: "Freelance Copilot 1", freelanceCopilotMetadata: { ...metadata, settings: { ...metadata.settings, ...settings } } } as Pane;
}
function setup(mail: Array<MailboxMessageSummary & { text: string }> = [], start = "2026-10-14T10:00:00.000Z") {
  let clock = Date.parse(start);
  const now = () => new Date(clock).toISOString();
  const repository = new InMemoryFreelanceCopilotRepository(now);
  const events: string[] = [];
  const opened: string[] = [];
  const mailboxes: MailboxFactory = {
    async open(_config, password) {
      opened.push(password);
      if (password === "wrong") throw new Error("Authentication failed");
      return { recent: async () => mail.map(({ text: _text, ...summary }) => summary), texts: async () => mail, close: async () => undefined };
    }
  };
  const service = createFreelanceCopilotService({ repository, crypto, mailboxes, now, onEvent: (event) => events.push(event.type) });
  return { service, repository, events, opened, advance: (ms: number) => { clock += ms; } };
}
const job = { channel: "UPWORK" as const, url: "https://www.upwork.com/jobs/~021", externalId: "~021", title: "Build an MCP server for our Shopify store", budget: "$2,000 fixed", status: "QUALIFIED" as const, facts: { paymentVerified: true } };
const proposal = "You need your Shopify catalog reachable by an AI agent. I built SpaceApp (https://spaceapp.dev), an MCP-based agent workspace. First milestone: read-only product tools, $800.";

describe("Freelance Copilot send gate", () => {
  it("sends a clean proposal under Full autonomy, demands the platform URL and starts the follow-up clock", async () => {
    const { service, repository, events } = setup();
    const target = pane();
    const { lead, duplicate } = await service.addLead(owner, target, { ...job, client: null, description: null, score: 80, notes: null }, "AGENT");
    expect(duplicate).toBe(false);
    expect((await service.addLead(owner, target, { ...job, client: null, description: null, score: null, notes: null }, "AGENT")).duplicate).toBe(true);
    const { message, wordingIssues } = await service.createMessage(owner, target, { leadId: lead.id, kind: "PROPOSAL", body: proposal, bid: { type: "FIXED", amount: 2000 }, connects: 16 });
    expect(wordingIssues).toEqual([]);
    expect((await service.beginSend(owner, target, message.id)).status).toBe("SENDING");
    await expect(service.finishSend(owner, target, { messageId: message.id, url: "https://evil.example/upwork.com" })).rejects.toThrow(/FREELANCE_EVIDENCE/);
    const sent = await service.finishSend(owner, target, { messageId: message.id, url: "https://www.upwork.com/nx/proposals/1" });
    expect(sent).toMatchObject({ status: "SENT", sentUrl: "https://www.upwork.com/nx/proposals/1" });
    const after = (await repository.getLead(owner, lead.id))!;
    expect(after.status).toBe("PROPOSED");
    expect(after.nextActionAt).toBe("2026-10-17T10:00:00.000Z");
    expect(events).toEqual(expect.arrayContaining(["LEAD_ADDED", "MESSAGE_DRAFTED", "SENDING", "SENT"]));
  });

  it("refuses off-platform contact, scam leads, Assist channels, caps and the Connects budget", async () => {
    const { service } = setup();
    const target = pane({ connectsBudget: { perDay: 20, perMonth: 2000 }, channels: { ...defaultFreelanceCopilotPaneMetadata().settings.channels, FIVERR: { enabled: true, autonomyCap: "ASSIST", dailyCap: 20 }, CONTRA: { enabled: true, autonomyCap: "FULL", dailyCap: 1 } } });
    const { lead } = await service.addLead(owner, target, { ...job, client: null, description: null, score: null, notes: null }, "AGENT");
    const contact = (await service.createMessage(owner, target, { leadId: lead.id, kind: "PROPOSAL", body: "Message me on WhatsApp", bid: null, connects: null })).message;
    await expect(service.beginSend(owner, target, contact.id)).rejects.toThrow(/FREELANCE_NEEDS_REVIEW: messenger/);
    const first = (await service.createMessage(owner, target, { leadId: lead.id, kind: "PROPOSAL", body: proposal, bid: null, connects: 16 })).message;
    await service.beginSend(owner, target, first.id);
    const second = (await service.createMessage(owner, target, { leadId: lead.id, kind: "MESSAGE", body: proposal, bid: null, connects: 8 })).message;
    await expect(service.beginSend(owner, target, second.id)).rejects.toThrow(/FREELANCE_CONNECTS: the daily Connects budget \(20\)/);
    const scam = (await service.addLead(owner, target, { ...job, externalId: "~022", url: null, description: "Unpaid test task first, then Telegram.", client: null, score: null, notes: null }, "AGENT"));
    expect(scam.scamSignals).toEqual(["move-to-messenger", "unpaid-test"]);
    const scamProposal = (await service.createMessage(owner, target, { leadId: scam.lead.id, kind: "PROPOSAL", body: proposal, bid: null, connects: null })).message;
    await expect(service.beginSend(owner, target, scamProposal.id)).rejects.toThrow(/scam-signals/);
    const fiverr = (await service.addLead(owner, target, { ...job, channel: "FIVERR", externalId: "f1", url: null, client: null, description: null, score: null, notes: null }, "AGENT")).lead;
    const fiverrMessage = (await service.createMessage(owner, target, { leadId: fiverr.id, kind: "MESSAGE", body: "Happy to help with the integration.", bid: null, connects: null })).message;
    await expect(service.beginSend(owner, target, fiverrMessage.id)).rejects.toThrow(/autonomy on Fiverr is Assist/);
    await service.requestReview(owner, target, { messageId: fiverrMessage.id });
    await service.decideReview(owner, target, fiverrMessage.id, { decision: "approve" });
    expect((await service.beginSend(owner, target, fiverrMessage.id)).status).toBe("SENDING");
    const contra = (await service.addLead(owner, target, { ...job, channel: "CONTRA", externalId: "c1", url: null, client: null, description: null, score: null, notes: null }, "AGENT")).lead;
    const c1 = (await service.createMessage(owner, target, { leadId: contra.id, kind: "PROPOSAL", body: proposal, bid: null, connects: null })).message;
    await service.beginSend(owner, target, c1.id);
    const c2 = (await service.createMessage(owner, target, { leadId: contra.id, kind: "FOLLOW_UP", body: proposal, bid: null, connects: null })).message;
    await expect(service.beginSend(owner, target, c2.id)).rejects.toThrow(/FREELANCE_LIMIT: Contra allows 1/);
    await expect(service.beginSend(owner, pane({ paused: true }), c2.id)).rejects.toThrow(/FREELANCE_PAUSED/);
  });

  it("hands a ready client to the operator, stops the agent's own sends there, and learns from the outcome", async () => {
    const { service, repository } = setup();
    const target = pane();
    const { lead } = await service.addLead(owner, target, { ...job, client: "Acme", description: null, score: null, notes: null }, "AGENT");
    await service.recordIncoming(owner, target, { leadId: lead.id, body: "Looks good, can we start next week? I will send an offer." });
    expect((await repository.getLead(owner, lead.id))!.status).toBe("TALKING");
    await service.clientReady(owner, target, { leadId: lead.id, summary: "Offer coming: MCP server, $2,000 fixed, start next week." });
    expect((await service.pendingItems(owner, target.id)).map((item) => item.kind)).toEqual(["CLIENT_READY"]);
    const reply = (await service.createMessage(owner, target, { leadId: lead.id, kind: "MESSAGE", body: "Great, thanks.", bid: null, connects: null })).message;
    await expect(service.beginSend(owner, target, reply.id)).rejects.toThrow(/operator has taken over/);
    await expect(service.updateLead(owner, target, lead.id, { status: "LOST" })).rejects.toThrow(/only the operator/);
    const won = await service.decideLead(owner, target, lead.id, { decision: "won", contractValue: 2000 });
    expect(won).toMatchObject({ status: "WON", contractValue: 2000 });
    expect((await service.funnel(owner)).revenue).toBe(2000);
    expect((await service.listMemory(owner, { kinds: ["LESSON"], limit: 10 })).map((memory) => memory.text)).toEqual([expect.stringContaining("Won on Upwork")]);
  });

  it("runs briefs and mails first, then approved messages, then due follow-ups, and stops when the queue is empty", async () => {
    const mail = [{ uid: 7, from: "donotreply@upwork.com", subject: "New job: MCP server", receivedAt: "2026-10-14T09:59:00.000Z", snippet: "A new job matches", text: "A new job matches your search" }];
    const { service, repository, advance, opened } = setup(mail);
    const target = pane();
    await expect(service.connectMailbox(owner, { host: "example.invalid", port: 993, secure: true, user: "work@example.invalid", password: "wrong" })).rejects.toThrow(/did not accept the sign-in/);
    await service.connectMailbox(owner, { host: "example.invalid", port: 993, secure: true, user: "work@example.invalid", password: "secret" });
    expect((await repository.getMailbox(owner))!.passwordSealed).toBe("sealed:secret");
    // The first poll only sets the cursor; a newer mail becomes a work item.
    expect(await service.pollMail(owner, target)).toBe(0);
    mail.push({ uid: 8, from: "donotreply@upwork.com", subject: "New message from Acme", receivedAt: "2026-10-14T10:01:00.000Z", snippet: "Hi", text: "Hi, are you available?" });
    expect(await service.pollMail(owner, target)).toBe(1);
    expect(opened.every((password) => password !== "sealed:secret")).toBe(true);
    await service.startRun(owner, target.id);
    const first = await service.nextItem(owner, target, { waitMs: 0 });
    expect(first).toMatchObject({ done: false, kind: "MAIL", item: { payload: { uid: 8, channel: "UPWORK" } } });
    await service.reportItem(owner, target, { eventId: (first as { item: { id: string } }).item.id, outcome: "done", summary: "Answered Acme" });
    const { lead } = await service.addLead(owner, target, { ...job, client: null, description: null, score: null, notes: null }, "AGENT");
    const draft = (await service.createMessage(owner, target, { leadId: lead.id, kind: "PROPOSAL", body: proposal, bid: null, connects: null })).message;
    await service.requestReview(owner, target, { messageId: draft.id });
    await service.decideReview(owner, target, draft.id, { decision: "approve" });
    expect(await service.nextItem(owner, target, { waitMs: 0 })).toMatchObject({ kind: "SEND", message: { id: draft.id } });
    await service.beginSend(owner, target, draft.id);
    await service.finishSend(owner, target, { messageId: draft.id, url: "https://www.upwork.com/nx/proposals/2" });
    advance(3 * 86_400_000 + 1000);
    expect(await service.nextItem(owner, target, { waitMs: 0 })).toMatchObject({ kind: "FOLLOW_UP", lead: { id: lead.id } });
    expect(await service.nextItem(owner, target, { waitMs: 0 })).toEqual({ done: true, reason: "QUEUE_EMPTY" });
    expect(await service.waitForCode(owner, { pattern: "available", timeoutMs: 0 })).toMatchObject({ code: "available", subject: "New message from Acme" });
  });
});
