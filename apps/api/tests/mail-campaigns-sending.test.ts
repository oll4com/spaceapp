// Mail Campaigns step 5 (plan clipboard:IJ2ovfLg1Lbw): the message every recipient gets (RFC 8058 headers, footer, 76-column base64),
// unsubscribe tokens, and the gate: test copies only to own seeds, a review card a person answers, any change sends it back, approval
// freezes the audience, the sender job paces, never mails twice, re-checks suppression and health, treats a lost answer as UNKNOWN,
// retries transient errors, marks refused recipients INVALID, pauses on bounces, and an untouched approval goes stale.
import { describe, expect, it } from "vitest";
import { mailCampaignCreateSchema, mailSenderCreateSchema, mailSuppressionInputSchema, mailTemplateCreateSchema, nousDecisionKind, type NotificationRaiseInput } from "@space/contracts";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { inSendWindow } from "../src/mail-campaigns/campaigns.js";
import { buildCampaignMime, readUnsubscribeToken, unsubscribeToken } from "../src/mail-campaigns/mime.js";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import { SmtpError } from "../src/mail-campaigns/smtp.js";
import type { MailTransports } from "../src/mail-campaigns/transports.js";
import { passingDns, stubMailSite } from "./fixtures/mail-campaigns-dns.js";
import { COPILOT_ACTION_DECISIONS } from "../src/nous/copilot-actions.js";

stubMailSite();

const key = Buffer.alloc(32, 7);
const decode = (raw: Buffer) => raw.toString("utf8");
const part = (raw: Buffer, type: string) => {
  const text = decode(raw);
  const start = text.indexOf(`Content-Type: ${type}; charset=UTF-8`);
  const body = text.slice(text.indexOf("\r\n\r\n", start) + 4, text.indexOf("\r\n--", start));
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
};

describe("campaign messages", () => {
  const base = { from: "offers@brand.example", fromName: "oll4", to: "a@shop.example", replyTo: null, subject: "Νέα προσφορά", preheader: "Only this week", html: "<html><body><p>Hi</p></body></html>",
    text: "Hi", language: "en" as const, campaignId: "mcamp:abcdefgh", contactId: "mcontact:ijklmnop", senderDomain: "brand.example", footerAddress: "oll4.com, Athens" };
  it("carries one-click unsubscribe, the sender's domain Message-ID, a footer and 76-column base64", () => {
    const { raw, messageId } = buildCampaignMime({ ...base, unsubscribeUrl: "https://oll4.com/u/tok" });
    const text = decode(raw);
    expect(messageId).toMatch(/^<mc\.abcdefgh\.ijklmnop\.[A-Za-z0-9_-]+@brand\.example>$/);
    expect(text).toContain("List-Unsubscribe: <https://oll4.com/u/tok>, <mailto:offers@brand.example?subject=unsubscribe>\r\n");
    expect(text).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n");
    expect(text).toContain("Subject: =?UTF-8?B?");
    expect(text).toMatch(/Feedback-ID: abcdefgh:brand\.example:mailcampaigns/);
    expect(text.split("\r\n").every((line) => line.length <= 998)).toBe(true);
    expect(text.split("\r\n").filter((line) => /^[A-Za-z0-9+/=]{60,}$/.test(line)).every((line) => line.length <= 76)).toBe(true);
    const html = part(raw, "text/html");
    expect(html).toMatch(/^<html><body><div style="display:none[^"]*">Only this week<\/div><p>Hi<\/p><div style="margin-top/);
    expect(html).toContain('<a href="https://oll4.com/u/tok" style="color:#666">Unsubscribe</a>');
    expect(part(raw, "text/plain")).toContain("Unsubscribe: https://oll4.com/u/tok");
  });
  it("without a public endpoint offers mailto only and no one-click POST", () => {
    const text = decode(buildCampaignMime({ ...base, unsubscribeUrl: null, test: true }).raw);
    expect(text).not.toContain("List-Unsubscribe-Post");
    expect(text).toContain("List-Unsubscribe: <mailto:offers@brand.example?subject=unsubscribe>");
    expect(text).toContain(`Subject: =?UTF-8?B?${Buffer.from("[TEST] Νέα προσφορά").toString("base64")}?=`);
  });
  it("signs unsubscribe tokens; a changed one does nothing", () => {
    const token = unsubscribeToken(key, "mcamp:abcdefgh", "mcontact:ijklmnop");
    expect(readUnsubscribeToken(key, token)).toEqual({ campaignId: "mcamp:abcdefgh", contactId: "mcontact:ijklmnop" });
    expect(readUnsubscribeToken(Buffer.alloc(32, 8), token)).toBeNull();
    expect(readUnsubscribeToken(key, token.replace(/^./, (c) => c === "b" ? "c" : "b"))).toBeNull();
    expect(readUnsubscribeToken(key, "a.b")).toBeNull();
  });
  it("sends only in the campaign's hours and days", () => {
    const schedule = { startAt: null, timeZone: "Europe/Athens", days: [1, 2, 3, 4, 5], fromHour: 9, toHour: 18 };
    expect(inSendWindow(schedule, new Date("2026-10-27T08:00:00Z"))).toBe(true); // Tuesday 10:00 Athens
    expect(inSendWindow(schedule, new Date("2026-10-27T16:30:00Z"))).toBe(false); // 18:30
    expect(inSendWindow(schedule, new Date("2026-11-01T08:00:00Z"))).toBe(false); // Sunday
    expect(inSendWindow({ ...schedule, startAt: "2026-10-28T00:00:00Z" }, new Date("2026-10-27T08:00:00Z"))).toBe(false);
  });
  it("lets no decision kind 'Always approve' a mail campaign", () => {
    expect(nousDecisionKind({ type: "COPILOT", copilot: "MAIL", item: "CAMPAIGN", itemId: "mcamp:abcdefgh", decision: "approve" } as never)).toBeNull();
    expect(COPILOT_ACTION_DECISIONS["MAIL:CAMPAIGN"]).toEqual(["cancel"]); // approve only in the pane, with what the operator read
  });
});

async function fixture(options: { fail?: (to: string) => Error | null; covers?: () => boolean; checkFails?: () => boolean;
  seedMessage?: (owner: string, account: string, messageId: string) => Promise<{ labels: string[]; headers: Array<{ name: string; value: string }> } | null> } = {}) {
  let clock = Date.parse("2026-10-27T08:00:00Z");
  const now = () => new Date(clock).toISOString();
  const sent: Array<{ to: string; raw: string }> = [];
  const cards: NotificationRaiseInput[] = [];
  const resolved: string[] = [];
  const checks: string[] = [];
  const transports = { for: () => ({ check: async () => { checks.push(now()); if (options.checkFails?.()) throw new Error("connect ETIMEDOUT"); return "ok"; }, send: async (raw: Buffer, envelope: { to: string }) => {
    const failure = options.fail?.(envelope.to);
    if (failure) throw failure;
    sent.push({ to: envelope.to, raw: raw.toString() });
    return { providerId: `id-${sent.length}` };
  } }) } as unknown as MailTransports;
  const repository = new InMemoryMailCampaignsRepository(now);
  const service = createMailCampaignsService({ repository, transports, now, campaigns: {
    notify: { raise: async (input) => { cards.push(input); }, resolve: async (_owner, keyName) => { resolved.push(keyName); } },
    mailPane: async () => ({ id: "pane:mailpane1", roomId: "room:mailroom1" }), ownMailboxes: async () => ["operator@gmail.com"], unsubscribeKey: key, unsubscribeBase: null, dns: passingDns, seedMessage: options.seedMessage,
    ...(options.covers ? { coversApproval: async () => options.covers!() } : {}) } });
  const owner = "user:o";
  const sender = await service.createSender(owner, mailSenderCreateSchema.parse({ address: "offers@brand.example", displayName: "oll4", footerAddress: "oll4.com, Athens",
    config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "offers@brand.example", vaultKeyId: "vault_key:abcdef12" }, caps: { perMinute: 2, perDay: 500 } }), "test");
  await service.checkSender(owner, sender.id);
  const { template } = await service.createTemplate(owner, mailTemplateCreateSchema.parse({ name: "Kits", language: "el", subject: "Γεια {{firstName}}", html: "<p>Γεια {{firstName}}</p>",
    text: "Γεια {{firstName}}", variables: [{ name: "firstName", default: "σας" }] }), { by: "OPERATOR" }, null);
  const list = await service.createList(owner, { name: "Buyers", description: "", source: "CSV", consentBasis: "CUSTOMER" });
  await service.importContacts(owner, list.id, { csv: "email,name\nalice@shop.gr,Alice A\nbob@shop.gr,\ncarol@shop.gr,Carol\ndave@shop.gr,Dave\n" }, "test");
  const campaign = await service.createCampaign(owner, mailCampaignCreateSchema.parse({ name: "Kits offer", templateId: template.id, senderId: sender.id, listIds: [list.id],
    pacing: { perMinute: 2, perDay: 300 }, testSeeds: ["operator@gmail.com"] }), "test", null);
  return { service, repository, owner, sender, list, campaign, sent, cards, resolved, checks, tick: async (minutes = 1) => { clock += minutes * 60_000; await service.tick(); }, setClock: (iso: string) => { clock = Date.parse(iso); } };
}

describe("the campaign gate and the sender job", () => {
  it("sends a marked test copy to port25's automatic checker, and to no other outside address", async () => {
    const { service, owner, campaign, sent } = await fixture();
    expect((await service.testCampaign(owner, campaign.id, ["check-auth@verifier.port25.com"])).sent).toHaveLength(1);
    expect(sent.map((mail) => mail.to)).toEqual(["check-auth@verifier.port25.com"]);
    await expect(service.testCampaign(owner, campaign.id, ["check-auth@verifier.port25.example"])).rejects.toThrow(/own mailboxes/);
  });
  it("fills a test copy with the first recipient's list fields and sends it from the campaign's sender (step 11, 2/11)", async () => {
    const { service, owner, campaign, sent } = await fixture();
    const { sent: results } = await service.testCampaign(owner, campaign.id);
    expect(results[0]).toMatchObject({ seed: "operator@gmail.com", asRecipient: "alice@shop.gr" });
    const raw = Buffer.from(sent[0]!.raw);
    expect(sent[0]!.raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("[ΔΟΚΙΜΗ] Γεια Alice").toString("base64")}?=`);
    expect(part(raw, "text/plain")).toContain("Γεια Alice");
    expect(part(raw, "text/plain")).not.toMatch(/\[firstName\]|Γεια σας/);
    expect(sent[0]!.raw).toMatch(/^From: .*<offers@brand\.example>\r$/m);
    expect(sent[0]!.raw).toMatch(/^To: operator@gmail\.com\r$/m);
  });
  it("reads where its own mail to the operator's Gmail landed, keeping only Gmail's verdict headers (step 11, 2/11)", async () => {
    const asked: Array<[string, string]> = [];
    const { service, owner, list, campaign, tick } = await fixture({ seedMessage: async (_owner, account, messageId) => {
      asked.push([account, messageId]);
      return { labels: ["UNREAD", "CATEGORY_PERSONAL", "SPAM"], headers: [
        { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@brand.example header.s=default; spf=pass (google.com: domain of offers@brand.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=offers@brand.example; dmarc=pass (p=QUARANTINE sp=NONE dis=NONE) header.from=brand.example" },
        { name: "ARC-Authentication-Results", value: "i=1; mx.google.com; dkim=pass" }, { name: "Subject", value: "Γεια Alice" },
        { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; d=brand.example" }, { name: "X-Spam-Flag", value: "NO" }] };
    } });
    await service.importContacts(owner, list.id, { text: "operator+seed@gmail.com" }, "test");
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    for (let minute = 0; minute < 3; minute++) await tick(1);
    const check = await service.seedPlacement(owner, campaign.id);
    // Only the plus-address of an own mailbox is looked up, in that mailbox; the customers' mail never is.
    expect(asked).toEqual([["operator@gmail.com", expect.stringMatching(/^<mc\./)]]);
    expect(check).toMatchObject({ kind: "SEED", status: "FAIL", details: { findings: ["operator+seed@gmail.com: SPAM (spf=pass dkim=pass dmarc=pass)"],
      placements: [{ seed: "operator+seed@gmail.com", kind: "SENT", where: "SPAM", auth: { by: "mx.google.com", spf: "pass", dkim: "pass", dmarc: "pass" } }] } });
    expect((check.details.placements as Array<{ headers: Array<{ name: string }> }>)[0]!.headers.map((entry) => entry.name)).toEqual(["Authentication-Results", "ARC-Authentication-Results", "X-Spam-Flag"]);
  });
  it("tests only to own seeds, asks a person, goes back to review on any change and approves the exact fingerprint", async () => {
    const { service, owner, campaign, sent, cards, resolved } = await fixture();
    await expect(service.testCampaign(owner, campaign.id, ["customer@shop.gr"])).rejects.toThrow(/own mailboxes/);
    expect((await service.testCampaign(owner, campaign.id)).sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("operator@gmail.com");
    expect((await service.campaign(owner, campaign.id)).status).toBe("TESTING");
    await expect(service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! })).rejects.toThrow(/not waiting/);
    const asked = await service.submit(owner, campaign.id);
    expect(asked.status).toBe("IN_REVIEW");
    expect(cards.at(-1)).toMatchObject({ source: "MAIL_COPILOT", kind: "CAMPAIGN_REVIEW", severity: "ATTENTION", paneId: "pane:mailpane1", dedupeKey: `mail-copilot:campaign:${campaign.id}`,
      payload: { ask: { answer: { kind: "COPILOT_DECISION", copilot: "MAIL", item: "CAMPAIGN", itemId: campaign.id }, options: ["Decline"] } } });
    expect((cards.at(-1)!.payload as { ask: { recommended?: string } }).ask.recommended).toBeUndefined();
    expect(cards.at(-1)!.body).toMatch(/Recipients: 4[\s\S]*Unsubscribe: mailto only/);
    // A change while asked: a new card with the new fingerprint.
    const changed = await service.updateCampaign(owner, campaign.id, { pacing: { perMinute: 1, perDay: 300 } });
    expect(changed.status).toBe("IN_REVIEW");
    expect(changed.fingerprint).not.toBe(asked.fingerprint);
    expect(resolved).toContain(`mail-copilot:campaign:${campaign.id}`);
    expect(await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! })).toMatch(/4 recipients/);
    const approved = await service.campaign(owner, campaign.id);
    expect(approved).toMatchObject({ status: "APPROVED", approval: { fingerprint: changed.fingerprint, via: "RAIL" }, audience: { eligible: 4 } });
    // A change after approval: back to review, the approval gone.
    const again = await service.updateCampaign(owner, campaign.id, { pacing: { perMinute: 2, perDay: 300 } });
    expect(again).toMatchObject({ status: "IN_REVIEW", approval: null });
    expect(await service.decide(owner, campaign.id, "decline", { who: "user:o", via: "NOUS", decisionId: "nous_decision:x", note: "not now" })).toMatch(/draft/);
  });

  it("paces, never mails twice, re-checks suppression at send time and finishes", async () => {
    const { service, repository, owner, campaign, list, sent, cards, tick } = await fixture();
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    // A suppression after approval wins at send time; a list growing after approval adds nobody.
    await service.addSuppressions(owner, [mailSuppressionInputSchema.parse({ pattern: "dave@shop.gr", reason: "UNSUBSCRIBE", source: "reply" })]);
    await service.importContacts(owner, list.id, { text: "erin@shop.gr" }, "test");
    await tick(0);
    expect(sent.map((mail) => mail.to)).toEqual(["alice@shop.gr", "bob@shop.gr"]);
    expect((await service.campaign(owner, campaign.id)).status).toBe("SENDING");
    expect(sent[0]!.raw).toContain(`To: alice@shop.gr`);
    expect(Buffer.from(sent[0]!.raw.split("\r\n\r\n")[2]!.split("\r\n--")[0]!.replace(/\r\n/g, ""), "base64").toString()).toContain("Γεια Alice");
    await tick(0);
    expect(sent).toHaveLength(2); // two a minute
    for (let minute = 0; minute < 5; minute++) await tick(1);
    expect(sent.map((mail) => mail.to).sort()).toEqual(["alice@shop.gr", "bob@shop.gr", "carol@shop.gr"]);
    const result = await service.results(owner, campaign.id);
    expect(result.campaign.status).toBe("DONE");
    expect(result.stats.byStatus).toEqual({ SENT: 3, SKIPPED: 1 });
    expect((await repository.listSends(owner, campaign.id, { status: ["SKIPPED"], limit: 5 }))[0]!.skipReason).toBe("suppressed");
    expect(cards.at(-1)).toMatchObject({ kind: "CAMPAIGN_DONE", severity: "INFO" });
    // A second campaign to the same people within 72 h skips them.
    const second = await service.createCampaign(owner, { ...mailCampaignCreateSchema.parse({ name: "Again", templateId: campaign.templateId, senderId: campaign.senderId, listIds: campaign.listIds }) }, "test", null);
    await service.submit(owner, second.id);
    await service.decide(owner, second.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, second.id)).fingerprint! });
    for (let minute = 0; minute < 4; minute++) await tick(1);
    expect(sent.filter((mail) => mail.to === "alice@shop.gr")).toHaveLength(1);
    expect((await service.results(owner, second.id)).stats.byStatus.SENT).toBe(1); // erin only
  });

  it("waits outside its hours, retries a busy server, marks a refused address INVALID and never resends a lost answer", async () => {
    let busy = true;
    const { service, repository, owner, campaign, sent, setClock, tick } = await fixture({ fail: (to) => to === "bob@shop.gr" ? new SmtpError(550, "RCPT TO: 550 5.1.1 no such user", "RCPT TO")
      : to === "carol@shop.gr" && busy ? new SmtpError(451, "MESSAGE: 451 try later", "MESSAGE") : null });
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    setClock("2026-11-01T08:00:00Z"); // Sunday
    await tick(0);
    expect(sent).toHaveLength(0);
    expect((await service.campaign(owner, campaign.id)).status).toBe("APPROVED");
    setClock("2026-11-02T08:00:00Z"); // Monday 10:00 Athens
    for (let minute = 0; minute < 3; minute++) await tick(1);
    expect((await service.contact(owner, "bob@shop.gr")).contact.health).toBe("INVALID");
    const carol = (await repository.listSends(owner, campaign.id, { limit: 10 })).find((send) => send.address === "carol@shop.gr")!;
    expect(carol).toMatchObject({ status: "PENDING", attempts: 1 });
    busy = false;
    for (let minute = 0; minute < 4; minute++) await tick(1);
    expect(sent.map((mail) => mail.to).sort()).toEqual(["alice@shop.gr", "carol@shop.gr", "dave@shop.gr"]);
    // A SENDING row whose answer was lost (a crash) becomes UNKNOWN and is never mailed again.
    const lost = await service.createCampaign(owner, mailCampaignCreateSchema.parse({ name: "Lost", templateId: campaign.templateId, senderId: campaign.senderId, listIds: campaign.listIds }), "test", null);
    await repository.freezeAudience(owner, lost.id, [{ contactId: (await service.contact(owner, "alice@shop.gr")).contact.id, address: "alice@shop.gr" }]);
    await repository.takeNextSend(owner, lost.id);
    await repository.markStaleSending("2027-01-01T00:00:00.000Z");
    expect((await repository.listSends(owner, lost.id, { limit: 1 }))[0]!.status).toBe("UNKNOWN");
    expect(await repository.takeNextSend(owner, lost.id)).toBeNull();
  });

  it("skips a pass the database cannot serve instead of pausing, and pauses on any other job error (stable 3/11 08:15 UTC)", async () => {
    const { service, repository, owner, campaign, sent, cards, tick } = await fixture();
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    const take = repository.takeNextSend.bind(repository);
    let failure: Error | null = new Error("timeout exceeded when trying to connect");
    repository.takeNextSend = async (...args) => { if (failure) throw failure; return take(...args); };
    await expect(tick(0)).rejects.toThrow(/timeout exceeded/);
    expect((await service.campaign(owner, campaign.id)).status).toBe("SENDING");
    expect(cards.filter((card) => card.kind === "CAMPAIGN_PAUSED")).toHaveLength(0);
    failure = null;
    await tick(1);
    expect(sent.map((mail) => mail.to)).toEqual(["alice@shop.gr", "bob@shop.gr"]);
    failure = new Error("unexpected state");
    await tick(1);
    expect(await service.campaign(owner, campaign.id)).toMatchObject({ status: "PAUSED", pauseReason: "the sender job failed: unexpected state" });
  });

  it("resumes an outage's pause by itself once the cause is gone, only while \"May send\" covers it, never a bounce pause (operator 3/11 18:28 BKK)", async () => {
    let covers = false;
    let down = false;
    let refuse = true;
    const { service, repository, owner, campaign, sent, checks, resolved, tick } = await fixture({ covers: () => covers, checkFails: () => down,
      fail: () => refuse ? new SmtpError(421, "GREETING: 421 service not available", "GREETING") : null });
    down = true; // the mail server goes down after the sender's first check
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    await tick(0);
    expect(await service.campaign(owner, campaign.id)).toMatchObject({ status: "PAUSED", pauseReason: expect.stringMatching(/^the route of offers@brand\.example failed;/) });
    const checksBefore = checks.length;
    await tick(15);
    expect(checks).toHaveLength(checksBefore); // allowance off: the operator resumes, the server leaves it
    covers = true;
    await tick(1);
    expect(checks).toHaveLength(checksBefore + 1);
    expect((await service.campaign(owner, campaign.id)).status).toBe("PAUSED"); // the route still fails
    await tick(1);
    expect(checks).toHaveLength(checksBefore + 1); // one route check per sender every 10 minutes
    down = false;
    refuse = false;
    await tick(10);
    expect(sent.map((mail) => mail.to)).toEqual(["alice@shop.gr", "bob@shop.gr"]);
    expect(resolved).toContain(`mail-copilot:campaign-paused:${campaign.id}`);
    expect((await service.events(owner, { campaignId: campaign.id })).map((row) => row.message))
      .toContain("\"Kits offer\" resumed by the server, after its sender's route failure cleared.");
    // A database outage's pause from before such passes were skipped resumes at once; a bad signal never does.
    await repository.updateCampaign(owner, campaign.id, { status: "PAUSED", pauseReason: "the sender job failed: timeout exceeded when trying to connect" });
    await tick(1);
    expect((await service.campaign(owner, campaign.id)).status).not.toBe("PAUSED");
    await repository.updateCampaign(owner, campaign.id, { status: "PAUSED", pauseReason: "4 hard bounces and 0 complaints in 40 sent: check the list's health before resuming" });
    await tick(30);
    expect((await service.campaign(owner, campaign.id)).status).toBe("PAUSED");
  });

  it("climbs a warm-up stage only after two days of sending, not two days after the sender was made", async () => {
    const { service, owner, campaign, sent, setClock, tick } = await fixture(); // sender made Tue 27/10
    await service.updateCampaign(owner, campaign.id, { pacing: { perMinute: 2, perDay: 1 } });
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    setClock("2026-10-30T08:00:00Z"); // Fri: its first mail, three days after it was made
    await tick(0);
    expect(sent).toHaveLength(1);
    expect((await service.senders(owner))[0]!.warmup.stage).toBe(0);
    setClock("2026-11-01T07:59:00Z"); // Sun, under two days of sending
    await tick(0);
    expect((await service.senders(owner))[0]!.warmup.stage).toBe(0);
    setClock("2026-11-02T08:00:00Z"); // Mon
    await tick(0);
    expect((await service.senders(owner))[0]!.warmup.stage).toBe(1);
  });

  it("pauses on the hard bounce past maxHardBounces that Postfix's DSNs bring back", async () => {
    const { service, owner, campaign, sent, cards, tick } = await fixture();
    await service.updateCampaign(owner, campaign.id, { pacing: { perMinute: 2, perDay: 300, maxHardBounces: 1 } });
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    await tick(0);
    expect(sent).toHaveLength(2);
    // The layout of a real public-host Postfix DSN (stable 2/11): multipart/report with the original headers as text/rfc822-headers.
    const dsn = (to: string, messageId: string) => Buffer.from(`From: MAILER-DAEMON@almalinux8-plesk.local (Mail Delivery System)\r\nTo: offers@brand.example\r\n`
      + `Subject: Undelivered Mail Returned to Sender\r\nContent-Type: multipart/report; report-type=delivery-status;\r\n\tboundary="Q.1/almalinux8-plesk.local"\r\n\r\n`
      + `--Q.1/almalinux8-plesk.local\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\nI'm sorry to have to inform you that your message could not be delivered.\r\n\r\n`
      + `--Q.1/almalinux8-plesk.local\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; almalinux8-plesk.local\r\n\r\nFinal-Recipient: rfc822; ${to}\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n`
      + `--Q.1/almalinux8-plesk.local\r\nContent-Type: text/rfc822-headers\r\n\r\nFrom: oll4 <offers@brand.example>\r\nTo: ${to}\r\nMessage-ID: ${messageId}\r\n\r\n--Q.1/almalinux8-plesk.local--\r\n`);
    const sends = (await service.results(owner, campaign.id)).recent.filter((send) => send.status === "SENT");
    expect(await service.signals(owner, sends.map((send) => dsn(send.address, send.messageId!)), "public-host ntheo@example.invalid")).toEqual({ read: 2, ours: 2, applied: 2 });
    await tick(1);
    expect(await service.campaign(owner, campaign.id)).toMatchObject({ status: "PAUSED" });
    expect(cards.at(-1)).toMatchObject({ kind: "CAMPAIGN_PAUSED", severity: "ATTENTION" });
    expect(sent).toHaveLength(2);
  });

  it("pauses on hard bounces with a card and a lower warm-up stage, and an approval that never started goes stale", async () => {
    const { service, repository, owner, campaign, sender, cards, setClock, tick } = await fixture();
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    // 31 sent with 2 hard bounces is over 3 %.
    const sends = await repository.listSends(owner, campaign.id, { limit: 10 });
    for (const send of sends) await repository.updateSend(owner, campaign.id, send.contactId, { status: "SENT", sentAt: "2026-10-27T07:00:00.000Z" });
    await repository.updateSend(owner, campaign.id, sends[0]!.contactId, { bounce: { at: "2026-10-27T07:30:00.000Z", kind: "HARD", code: "5.1.1" } });
    const statsBefore = await repository.campaignStats(owner, campaign.id);
    expect(statsBefore.byStatus.SENT).toBe(4);
    await repository.updateSender(owner, sender.id, { warmup: { stage: 2, since: "2026-10-27T00:00:00.000Z" } });
    // Below 30 sent nothing pauses; pretend 30 more went out through a bigger list.
    const many = Array.from({ length: 30 }, (_, index) => ({ address: `x${index}@shop.gr` }));
    const extra = await repository.upsertContacts(owner, many.map((row) => ({ ...row, name: "", attributes: {} })));
    await repository.freezeAudience(owner, campaign.id, [...sends.map((send) => ({ contactId: send.contactId, address: send.address })), ...extra.map((row) => ({ contactId: row.id, address: row.address }))]);
    for (const row of extra) { await repository.takeNextSend(owner, campaign.id); await repository.updateSend(owner, campaign.id, row.id, { status: "SENT", sentAt: "2026-10-27T07:00:00.000Z" }); }
    await repository.updateSend(owner, campaign.id, extra[0]!.id, { bounce: { at: "2026-10-27T07:30:00.000Z", kind: "HARD", code: "5.1.1" } });
    await tick(0);
    expect((await service.campaign(owner, campaign.id))).toMatchObject({ status: "PAUSED" });
    expect(cards.at(-1)).toMatchObject({ kind: "CAMPAIGN_PAUSED", severity: "ATTENTION" });
    expect((await service.senders(owner))[0]!.warmup.stage).toBe(1);
    // A fresh approval that never sends within 7 days goes back to review.
    const idle = await service.createCampaign(owner, mailCampaignCreateSchema.parse({ name: "Idle", templateId: campaign.templateId, senderId: campaign.senderId, listIds: campaign.listIds,
      schedule: { days: [6] } }), "test", null);
    await service.submit(owner, idle.id);
    await service.decide(owner, idle.id, "approve", { who: "user:o", via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, idle.id)).fingerprint! });
    setClock("2026-11-05T08:00:00Z");
    await tick(0);
    expect((await service.campaign(owner, idle.id))).toMatchObject({ status: "IN_REVIEW", approval: null });
    expect((await service.events(owner, { campaignId: idle.id, limit: 5 })).map((event) => event.type)).toContain("BACK_TO_REVIEW");
  });

  it("an unsubscribe token suppresses the address everywhere; a forged one does nothing", async () => {
    const { service, owner, campaign } = await fixture();
    const alice = (await service.contact(owner, "alice@shop.gr")).contact;
    expect(await service.unsubscribe([unsubscribeToken(key, campaign.id, alice.id), "forged.token.value", unsubscribeToken(Buffer.alloc(32, 1), campaign.id, alice.id)], "oll4.com/u"))
      .toEqual({ unsubscribed: 1, ignored: 2 });
    expect(await service.contact(owner, "alice@shop.gr")).toMatchObject({ suppressed: true, contact: { health: "UNSUBSCRIBED" } });
  });
});
