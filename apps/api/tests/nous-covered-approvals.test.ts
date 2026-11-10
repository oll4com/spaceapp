// Operator 2/11 15:08 BKK «σου εχω πει να μην φτανει σε εμενα το aprove και να το κανεις παντα ΕΣΥ ΑΠΟ ΤΗΝ ΣΤΙΓΜΉ ΠΟΥ ΕΙΝΣΑΙ ενεργοποιημενο!!
// αλλιως φυσικα να ζηταει απο εμενα aprove !!!» (Cleo/Kate showed "1 needs you" and Approve for mktpost:8GLHGsG9nGfa while it was held for Nous):
// with Nous on and "May send to third parties" on, a copilot review or a Mail campaign is Nous's on every surface, with no time limit;
// with either off it reaches the operator as before.
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { eventSchema, heldForNous, isNousApproval, mailCopilotEventSchema, mailSenderCreateSchema, mailTemplateCreateSchema, type NotificationRaiseInput, type Pane, type Room } from "@space/contracts";
import { InMemoryFreelanceCopilotRepository, InMemoryMailCampaignsRepository, InMemoryMarketingCopilotRepository, InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore, makeSpaceId, SpaceEventBus } from "@space/runtime";
import { registerFreelanceCopilot } from "../src/freelance-copilot/wiring.js";
import { notifyMailCopilotEvent } from "../src/mail-copilot/notify.js";
import { registerMarketingCopilot } from "../src/marketing-copilot/wiring.js";
import { createNotificationService } from "../src/notifications/service.js";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import type { MailTransports } from "../src/mail-campaigns/transports.js";
import { maySendKind } from "../src/nous/allowances.js";
import { heldForNousNote, heldReviewItem, NOUS_APPROVAL_REWAKE_MS, sweepCopilotQuestions } from "../src/nous/copilot-questions.js";
import { itemActed } from "../src/nous/turn-items.js";
import { boardPanes, type PaneBoardSnapshot } from "../src/nous/pane-board.js";
import { createNousPaneNotices } from "../src/nous/pane-notices.js";
import { NOUS_SUBAGENT_EXCLUDED } from "../src/nous/subagents.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { passingDns, stubMailSite } from "./fixtures/mail-campaigns-dns.js";

stubMailSite();

const owner = "user:operator";
const room = { id: "room:cleo00001", name: "Cleo", kind: "WORKSPACE", order: 0, ownerUserId: owner, archivedAt: null } as unknown as Room;
const kate = { id: "pane:AiHbWcLWyXD7", roomId: room.id, paneName: "Kate", title: "Kate", mode: "MARKETING_COPILOT", isClosed: false } as unknown as Pane;
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };

function fixture(start = Date.parse("2026-11-02T08:00:00.000Z")) {
  let at = start;
  let covers = true;
  const raised: string[] = [];
  const telegramSend = vi.fn(async () => true);
  const repository = new InMemorySpaceNotificationsRepository(() => new Date(at).toISOString(), true);
  const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never, now: () => new Date(at).toISOString(),
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date(at).toISOString() }),
    // Copilot questions are not held (that switch off): what holds a review is the allowance alone.
    nous: { held: async () => false, raised: (item) => raised.push(item.id), holdsCopilotQuestions: async () => false, coversApproval: async () => covers } });
  const review = (over: Partial<NotificationRaiseInput> = {}) => service.raise({ ownerUserId: owner, roomId: room.id, paneId: kate.id, source: "MARKETING_COPILOT",
    kind: "REVIEW_REQUESTED", severity: "ATTENTION", title: "Review a Reddit post (Kate)", body: "Art 10 for r/selfhosted", link: { target: "review:mktpost:8GLHGsG9nGfa" },
    dedupeKey: "marketing-copilot:review:mktpost:8GLHGsG9nGfa", payload: { review: { id: "mktpost:8GLHGsG9nGfa", channel: "REDDIT", text: "Art 10" } }, telegram: true, ...over }, { telegramSend });
  const needsYou = async () => (await service.list(owner, { status: "NEEDS_YOU", limit: 50 })).map((item) => item.id);
  const sweep = () => sweepCopilotQuestions({ notifications: service, sources: ["MARKETING_COPILOT", "MAIL_COPILOT"], holds: async () => false, covers: async () => covers,
    now: () => at, missingSince: new Map(), openItemIds: async () => new Set(["mktpost:8GLHGsG9nGfa"]), paneOpen: async () => true, rewake: async () => {} });
  return { service, repository, review, needsYou, sweep, raised, telegramSend, tick: (ms: number) => { at += ms; }, now: () => at, setCovers: (value: boolean) => { covers = value; } };
}

describe("approvals \"May send\" covers are Nous's, never the operator's (operator 2/11 15:08 BKK)", () => {
  it("names the approvals it covers: Mail, Marketing, Freelance and Job reviews and Mail campaigns; never Security, Monitoring or questions", () => {
    for (const source of ["MAIL_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "JOB_COPILOT"] as const) expect(isNousApproval({ source, kind: "REVIEW_REQUESTED" })).toBe(true);
    expect(isNousApproval({ source: "MAIL_COPILOT", kind: "CAMPAIGN_REVIEW" })).toBe(true);
    expect(isNousApproval({ source: "SECURITY_COPILOT", kind: "REVIEW_REQUESTED" })).toBe(false);
    expect(isNousApproval({ source: "MONITORING_COPILOT", kind: "MONITORING_REVIEW" })).toBe(false);
    expect(isNousApproval({ source: "MARKETING_COPILOT", kind: "QUESTION" })).toBe(false);
    // Held under the allowance it stays held past its hour (the hour is only Nous's re-wake).
    expect(heldForNous({ payload: { heldForNous: { until: "2026-11-02T08:00:00.000Z", allowance: "maySend" } } }, Date.parse("2026-11-03T00:00:00.000Z"))).toBe(true);
    expect(heldForNous({ payload: { heldForNous: { until: "2026-11-02T08:00:00.000Z" } } }, Date.parse("2026-11-03T00:00:00.000Z"))).toBe(false);
  });

  it("takes over an approval held before the rule or already in Needs you once the allowance covers it; with it off nothing moves", async () => {
    const f = fixture();
    f.setCovers(false);
    const shown = await f.review();
    const old = await f.review({ dedupeKey: "marketing-copilot:review:mktpost:zJzIMjVN823D", link: { target: "review:mktpost:zJzIMjVN823D" } });
    // The 60-minute hold of copilot questions, as stable wrote it before 2/11 15:08 BKK.
    await f.service.addPayload(owner, old.id, { heldForNous: { until: "2026-11-02T09:00:00.000Z" } });
    // Off: the old hold ends as before (questions are not held in this fixture) and both are the operator's.
    expect(await f.sweep()).toMatchObject({ released: 1 });
    expect((await f.needsYou()).sort()).toEqual([shown.id, old.id].sort());
    f.setCovers(true);
    expect(await f.sweep()).toMatchObject({ rewoken: 2 });
    expect(await f.needsYou()).toEqual([]);
    expect((await f.service.get(owner, old.id))?.payload.heldForNous).toMatchObject({ allowance: "maySend" });
    f.tick(2 * 60 * 60_000);
    await f.sweep();
    expect(await f.needsYou()).toEqual([]);
  });

  it("ON: the review is held for Nous with no Needs you, pane dot, Telegram or push, and wakes Nous at once; OFF: the operator gets it as before", async () => {
    const f = fixture();
    const card = await f.review();
    expect(card.payload.heldForNous).toEqual({ until: "2026-11-02T09:00:00.000Z", allowance: "maySend" });
    expect(f.raised).toEqual([card.id]);
    expect(f.telegramSend).not.toHaveBeenCalled();
    expect(f.repository.telegram).toEqual([]);
    expect(await f.needsYou()).toEqual([]);
    // The pane's "needs you" dot, the room's "Needs attention" and the bell count read pending: a held card counts nowhere.
    expect(await f.service.pending(owner)).toMatchObject({ total: 0, byRoom: {}, byPane: {} });
    // Nous's line: the review is its own, never the operator's.
    expect(heldForNousNote(card)).toContain("never goes to the operator");
    expect(heldForNousNote(card)).not.toContain("after the hour it goes to the operator");

    f.setCovers(false);
    const off = await f.review({ dedupeKey: "marketing-copilot:review:mktpost:zJzIMjVN823D", payload: { review: { id: "mktpost:zJzIMjVN823D", channel: "REDDIT", text: "Art 9" } } });
    expect(off.payload.heldForNous).toBeUndefined();
    expect(await f.needsYou()).toEqual([off.id]);
    expect((await f.service.pending(owner)).byPane).toEqual({ [kate.id]: 1 });
    expect(f.telegramSend).toHaveBeenCalledOnce();
  });

  it("holds a Mail campaign's review for Nous too, and never a Security review or an URGENT card", async () => {
    const f = fixture();
    const campaign = await f.review({ source: "MAIL_COPILOT", kind: "CAMPAIGN_REVIEW", title: "Mail campaign \"oll4 support\" waits for approval", dedupeKey: "mail-campaign:review:mcamp:abcdefgh",
      link: {}, payload: { campaignId: "mcamp:abcdefgh" }, telegram: null });
    expect(campaign.payload.heldForNous).toMatchObject({ allowance: "maySend" });
    expect(heldForNousNote(campaign)).toContain("space_mail_campaign_approve");
    const security = await f.review({ source: "SECURITY_COPILOT", kind: "SECURITY_REVIEW", dedupeKey: "security:review:x", payload: {}, telegram: null });
    expect(security.payload.heldForNous).toBeUndefined();
    const urgent = await f.review({ severity: "URGENT", dedupeKey: "marketing-copilot:review:urgent", payload: {}, telegram: null });
    expect(urgent.payload.heldForNous).toBeUndefined();
  });

  it("holds a paused campaign's card for Nous, any cause, with the resume call; OFF the operator gets it (operator 3/11 18:28 BKK)", async () => {
    const f = fixture();
    const paused = (key: string) => f.review({ source: "MAIL_COPILOT", kind: "CAMPAIGN_PAUSED", title: "Mail campaign \"example.invalid kits wave 2 (EL)\" paused",
      body: "3 hard bounces and 0 complaints in 40 sent", dedupeKey: `mail-campaign:paused:${key}`, link: {}, payload: { campaignId: key }, telegram: null });
    const card = await paused("mcamp:vNAfjtWlOyXu");
    expect(card.payload.heldForNous).toMatchObject({ allowance: "maySend" });
    expect(f.raised).toEqual([card.id]);
    expect(await f.service.pending(owner)).toMatchObject({ total: 0, byPane: {} });
    expect(heldForNousNote(card)).toContain('space_mail_campaign_resume {"campaign":"mcamp:vNAfjtWlOyXu"}');
    expect(heldForNousNote(card)).toContain("Never ask the operator to resume");
    // Nous's turn keeps it until Nous resumes it or resolves the card.
    expect(heldReviewItem(card, "line")).toMatchObject({ kind: "REVIEW", review: "mcamp:vNAfjtWlOyXu", notification: card.id });
    expect(itemActed(heldReviewItem(card, "line")!, [{ name: "space_mail_campaign_resume", ok: true, args: { campaign: "mcamp:vNAfjtWlOyXu" } } as never])).toBe(true);
    f.setCovers(false);
    const off = await paused("mcamp:offoffoff1");
    expect(off.payload.heldForNous).toBeUndefined();
    expect((await f.service.pending(owner)).byPane).toEqual({ [kate.id]: 1 });
  });

  it("past its hour the sweep wakes Nous again and keeps it held; with the allowance off it goes to the operator", async () => {
    const f = fixture();
    const card = await f.review();
    expect(await f.sweep()).toEqual({ resolved: 0, released: 0 });
    f.tick(61 * 60_000);
    expect(await f.sweep()).toEqual({ resolved: 0, released: 0, rewoken: 1 });
    const still = (await f.service.get(owner, card.id))!;
    expect(still.payload.heldForNous).toEqual({ until: new Date(f.now() + NOUS_APPROVAL_REWAKE_MS).toISOString(), allowance: "maySend" });
    // A day later, many wakes on: still Nous's.
    f.tick(24 * 60 * 60_000);
    expect(await f.sweep()).toMatchObject({ released: 0, rewoken: 1 });
    expect(await f.needsYou()).toEqual([]);
    // The operator turns "May send" off: the review is his at once, as before.
    f.setCovers(false);
    expect(await f.sweep()).toEqual({ resolved: 0, released: 1 });
    expect(await f.needsYou()).toEqual([card.id]);
    expect((await f.service.get(owner, card.id))!.payload.heldForNous).toBeUndefined();
  });

  it("refuses Nous's card that would forward a covered review to the operator", async () => {
    const f = fixture();
    const card = await f.review();
    const notices = createNousPaneNotices({ notifications: f.service });
    const answer = await notices.notify(owner, room, kate, { room: room.name, pane: "Kate", title: "Approve the Reddit post?", items: [{ text: "Approve Art 10?", ref: card.id }],
      checked: ["The post text: facts match the public SpaceApp page"] });
    expect(answer).toMatchObject({ ok: false, refused: true });
    expect(answer.result).toContain("decide it yourself");
    expect((await f.service.list(owner, { status: "OPEN", source: "NOUS", limit: 5 }))).toEqual([]);
  });

  it("runs Nous's decision on a review or a campaign cancel under May send, whatever its category or sendKind", () => {
    const review = (copilot: string, decision: string, item = "REVIEW") => ({ category: "DIRECTION" as const, refs: {},
      action: { type: "COPILOT", copilot, item, itemId: "mktpost:8GLHGsG9nGfa", paneId: null, decision } as never });
    expect(maySendKind(review("MARKETING", "approve"))).toBe("marketing-review");
    expect(maySendKind(review("JOB", "edit"))).toBe("job-review");
    expect(maySendKind(review("MAIL", "cancel", "CAMPAIGN"))).toBe("mail-review-back");
    expect(maySendKind(review("SECURITY", "approve"))).toBeNull();
    expect(maySendKind(review("MARKETING", "approve", "RULE"))).toBeNull();
  });

  it("keeps a covered review off the pane board's operator wait", () => {
    const f = { heldCard: { id: "n1", paneId: kate.id, status: "OPEN", severity: "ATTENTION", source: "MARKETING_COPILOT", kind: "REVIEW_REQUESTED",
      payload: { heldForNous: { until: "2026-11-02T09:00:00.000Z", allowance: "maySend" } } } };
    const snapshot = (nousApprovals: boolean): PaneBoardSnapshot => ({
      rooms: [{ room, sample: { data: [kate], activity: {}, details: {} } as never }], reports: [], decisions: [], plans: [], checks: [],
      notifications: [f.heldCard as never], copilotItems: [{ copilot: "MARKETING", kind: "REVIEW", id: "mktpost:8GLHGsG9nGfa", paneId: kate.id, title: "Art 10", detail: "" }], nousApprovals });
    const [on] = boardPanes(snapshot(true), { showClosed: false });
    expect(on).toMatchObject({ notifications: [], copilotItems: [] });
    const [off] = boardPanes(snapshot(false), { showClosed: false });
    expect(off!.copilotItems).toHaveLength(1);
  });

  it("lets Nous read every mail of a campaign and approve it only while May send is on", async () => {
    const transports = { for: () => ({ check: async () => "ok", send: async () => ({ providerId: "p" }) }) } as unknown as MailTransports;
    const mail = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(), transports, campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null, dns: passingDns, ownMailboxes: async () => [] } });
    const sender = await mail.createSender(owner, mailSenderCreateSchema.parse({ address: "ntheo@brand.example", displayName: "oll4", footerAddress: "brand.example",
      config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "ntheo@brand.example", vaultKeyId: "vault_key:abcdef12" } }), "t");
    await mail.checkSender(owner, sender.id);
    const { template } = await mail.createTemplate(owner, mailTemplateCreateSchema.parse({ name: "T", language: "en", subject: "For {{domain}}", preheader: "p", text: `${"Real text. ".repeat(30)} {{domain}}`, variables: [{ name: "domain", required: true }] }), { by: "OPERATOR" }, null);
    const list = await mail.createList(owner, { name: "Shops", description: "", source: "CSV", consentBasis: "B2B" });
    await mail.importContacts(owner, list.id, { csv: "email,domain\na@shop-a.gr,shop-a.gr\nb@shop-b.gr,shop-b.gr\n" }, "t");
    let covered = false;
    const nous = createNousTools({ rooms: async () => [room], listPanes: async () => [], mailCampaigns: mail, coversApproval: async () => covered } as unknown as NousToolDeps);
    const id = /mcamp:[A-Za-z0-9_-]+/.exec((await nous.execute("space_mail_campaign_draft", { name: "oll4 support", template: template.id, sender: sender.id, lists: [list.id],
      pacing: { perMinute: 1, perDay: 90, intervalSeconds: 360, maxHardBounces: 3 } }, ctx)).result)![0];
    await nous.execute("space_mail_campaign_lab", { campaign: id }, ctx);
    expect((await nous.execute("space_mail_campaign_submit", { campaign: id }, ctx)).result).toContain("waits for the operator");
    const page = JSON.parse((await nous.execute("space_mail_campaigns", { campaign: id, offset: 0 }, ctx)).result.split("\n")[0]!);
    expect(page).toMatchObject({ status: "IN_REVIEW", total: 2, items: [{ index: 0, subject: "For shop-a.gr" }, { index: 1, subject: "For shop-b.gr" }] });
    expect(page.items[0].text).toContain("Real text.");
    const refused = await nous.execute("space_mail_campaign_approve", { campaign: id, fingerprint: page.fingerprint }, ctx);
    expect(refused.ok).toBe(false);
    expect((await mail.results(owner, id)).campaign.status).toBe("IN_REVIEW");
    covered = true;
    expect((await nous.execute("space_mail_campaign_approve", { campaign: id, fingerprint: "wrong-fingerprint" }, ctx)).ok).toBe(false);
    expect((await nous.execute("space_mail_campaign_approve", { campaign: id, fingerprint: page.fingerprint }, ctx)).ok).toBe(true);
    expect((await mail.results(owner, id)).campaign).toMatchObject({ status: "APPROVED", approval: { via: "NOUS" } });
    expect(NOUS_SUBAGENT_EXCLUDED.has("space_mail_campaign_approve")).toBe(true);
    // Operator 2/11 15:01 BKK: a paused campaign is Nous's to resume under the same allowance; with it off only the operator resumes.
    await mail.pause(owner, id, "t");
    covered = false;
    expect(await nous.execute("space_mail_campaign_resume", { campaign: id }, ctx)).toMatchObject({ ok: false, refused: true });
    expect((await mail.results(owner, id)).campaign.status).toBe("PAUSED");
    covered = true;
    expect((await nous.execute("space_mail_campaign_resume", { campaign: id }, ctx)).ok).toBe(true);
    expect((await mail.results(owner, id)).campaign).toMatchObject({ status: "APPROVED", pauseReason: null });
    expect((await mail.events(owner, { campaignId: id })).map((row) => row.message)).toContain("\"oll4 support\" resumed by Nous.");
    expect(NOUS_SUBAGENT_EXCLUDED.has("space_mail_campaign_resume")).toBe(true);
  });
});

// Brief 20261103-covered-approvals-hold-gap (plan clipboard:USQ6ktIIN_1D): each producer's own card is held at creation while "May send" covers it,
// and reaches the operator when it does not; the minute sweep stays the backstop.
describe("every producer's approval card is held at creation under May send", () => {
  const routeDeps = { routeOptions: {}, authenticatedOwner: async () => owner, assertPaneAccess: async () => {}, parseBody: (schema: { parse(v: unknown): unknown }, body: unknown) => schema.parse(body),
    parseQuery: (schema: { parse(v: unknown): unknown }, query: unknown) => schema.parse(query), audit: async () => {}, log: { warn: () => {} }, scheduler: false, databaseUrl: null } as never;
  const terminal = { runSerializedTerminalMutation: async () => undefined, sendInput: async () => undefined, observeRoomScreenUndimmed: async () => null, ensurePaneControlReady: async () => undefined } as never;
  const copilotPane = (mode: Pane["mode"]) => {
    const store = new InMemorySpaceStore();
    const space = store.createRoom({ name: "Cleo", initialPaneCount: 0 }) as Room;
    return { store, pane: store.createPane({ roomId: space.id, title: "Kate", mode, terminalRuntimeId: "cli:claude" }) as Pane };
  };
  /** ON: held for Nous (out of Needs you, no Telegram); OFF: the operator's, as before. */
  async function heldOnShownOff(f: ReturnType<typeof fixture>, produce: (n: number) => Promise<unknown>) {
    await produce(1);
    const [on] = await vi.waitFor(async () => { const all = await f.service.list(owner, { status: "ALL", limit: 50 }); expect(all).toHaveLength(1); return all; });
    expect(isNousApproval(on!)).toBe(true);
    expect(on!.payload.heldForNous).toMatchObject({ allowance: "maySend" });
    expect(await f.needsYou()).toEqual([]);
    expect(f.repository.telegram).toEqual([]);
    f.setCovers(false);
    await produce(2);
    const off = await vi.waitFor(async () => { const ids = await f.needsYou(); expect(ids).toHaveLength(1); return ids[0]; });
    expect((await f.service.get(owner, off!))!.payload.heldForNous).toBeUndefined();
  }

  it("Marketing review (registerMarketingCopilot's notify)", async () => {
    const f = fixture();
    const { store, pane } = copilotPane("MARKETING_COPILOT");
    const app = Fastify();
    const service = registerMarketingCopilot(app, { ...routeDeps, store, eventBus: new SpaceEventBus(), repository: new InMemoryMarketingCopilotRepository(), terminal, notifications: f.service,
      roomOwner: async () => owner, artifactRoot: "/nonexistent", paneBrowserAccounts: { current: null }, metrics: false });
    await heldOnShownOff(f, async (n) => {
      const { post } = await service.createPost(owner, pane, { channel: "X", kind: "POST", body: `Run every CLI side by side, take ${n}.`, assets: [] });
      await service.requestReview(owner, pane, { postId: post.id });
    });
    await app.close();
  });

  it("Freelance review (registerFreelanceCopilot's notify)", async () => {
    const f = fixture();
    const { store, pane } = copilotPane("FREELANCE_COPILOT");
    const app = Fastify();
    const service = registerFreelanceCopilot(app, { ...routeDeps, store, eventBus: new SpaceEventBus(), repository: new InMemoryFreelanceCopilotRepository(), terminal, notifications: f.service,
      roomOwner: async () => owner, crypto: {} as never, mailboxes: {} as never });
    await heldOnShownOff(f, async (n) => {
      const { lead } = await service.addLead(owner, pane, { channel: "UPWORK", title: `Build a dashboard ${n}`, status: "QUALIFIED", facts: {} });
      const { message } = await service.createMessage(owner, pane, { leadId: lead.id, kind: "PROPOSAL", body: "Hello, I build dashboards like this one." });
      await service.requestReview(owner, pane, { messageId: message.id });
    });
    await app.close();
  });

  it("Mail review (notifyMailCopilotEvent)", async () => {
    const f = fixture();
    const { pane } = copilotPane("MAIL_COPILOT");
    await heldOnShownOff(f, (n) => notifyMailCopilotEvent(mailCopilotEventSchema.parse({ id: `mailevt:review00000${n}`, ownerUserId: owner, paneId: pane.id, runId: null,
      accountEmail: "ops@brand.example", threadId: `thread${n}`, messageId: null, type: "REVIEW_REQUESTED", status: "PENDING", message: "Review a reply to the accountant",
      payload: { reviewId: `mailrev:review00000${n}` }, createdAt: "2026-11-02T08:00:00.000Z" }), { roomId: pane.roomId, pane, owner, notifications: f.service }));
  });

  it("Mail campaign review (the campaigns service's submit)", async () => {
    const f = fixture();
    const transports = { for: () => ({ check: async () => "ok", send: async () => ({ providerId: "p" }) }) } as unknown as MailTransports;
    const mail = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(), transports, campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null, dns: passingDns,
      ownMailboxes: async () => [], notify: f.service, mailPane: async () => ({ id: kate.id, roomId: room.id }) } as never });
    const sender = await mail.createSender(owner, mailSenderCreateSchema.parse({ address: "ntheo@brand.example", displayName: "oll4", footerAddress: "brand.example",
      config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "ntheo@brand.example", vaultKeyId: "vault_key:abcdef12" } }), "t");
    await mail.checkSender(owner, sender.id);
    const { template } = await mail.createTemplate(owner, mailTemplateCreateSchema.parse({ name: "T", language: "en", subject: "For {{domain}}", preheader: "p", text: `${"Real text. ".repeat(30)} {{domain}}`, variables: [{ name: "domain", required: true }] }), { by: "OPERATOR" }, null);
    const list = await mail.createList(owner, { name: "Shops", description: "", source: "CSV", consentBasis: "B2B" });
    await mail.importContacts(owner, list.id, { csv: "email,domain\na@shop-a.gr,shop-a.gr\n" }, "t");
    const nous = createNousTools({ rooms: async () => [room], listPanes: async () => [], mailCampaigns: mail, coversApproval: async () => false } as unknown as NousToolDeps);
    await heldOnShownOff(f, async (n) => {
      const id = /mcamp:[A-Za-z0-9_-]+/.exec((await nous.execute("space_mail_campaign_draft", { name: `oll4 support ${n}`, template: template.id, sender: sender.id, lists: [list.id],
        pacing: { perMinute: 1, perDay: 90, intervalSeconds: 360, maxHardBounces: 3 } }, ctx)).result)![0];
      await nous.execute("space_mail_campaign_lab", { campaign: id }, ctx);
      await nous.execute("space_mail_campaign_submit", { campaign: id }, ctx);
    });
  });

  it("backstop: the sweep still holds a covered approval while the copilot items cannot be read, and resolves nothing", async () => {
    const f = fixture();
    f.setCovers(false);
    const card = await f.review();
    f.setCovers(true);
    const sweep = () => sweepCopilotQuestions({ notifications: f.service, sources: ["MARKETING_COPILOT"], holds: async () => false, covers: async () => true, now: f.now, missingSince: new Map(),
      openItemIds: async () => { throw new Error("rail unreadable"); }, paneOpen: async () => true, rewake: async () => {} });
    expect(await sweep()).toEqual({ resolved: 0, released: 0, rewoken: 1 });
    expect((await f.service.get(owner, card.id))!.payload.heldForNous).toMatchObject({ allowance: "maySend" });
    expect(await f.needsYou()).toEqual([]);
  });
});
