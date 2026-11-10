// Mail Campaigns address health (plan clipboard:IJ2ovfLg1Lbw step 7): bounces, complaints and replies parsed from raw mail (only ones
// naming our Message-IDs, or a DSN by its failed recipient), their effect on the send, the contact's health and the suppressions, and the periodic DNS look.
import { describe, expect, it } from "vitest";
import { mailCampaignCreateSchema, mailSenderCreateSchema, mailTemplateCreateSchema } from "@space/contracts";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { checkContactHealth, createDomainCheck } from "../src/mail-campaigns/health.js";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import { parseCampaignSignal } from "../src/mail-campaigns/signals.js";
import type { MailTransports } from "../src/mail-campaigns/transports.js";
import { passingDns, stubMailSite } from "./fixtures/mail-campaigns-dns.js";

stubMailSite();

const ours = "<mc.abcdefgh.ijklmnop.qrstuvwx@brand.example>";
const dsn = (status: string) => `From: Mail Delivery System <MAILER-DAEMON@mx.shop.gr>\r\nTo: offers@brand.example\r\nSubject: Undelivered Mail\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n\r\n`
  + `This is a MIME report.\r\n--b\r\nContent-Type: text/plain\r\n\r\nSorry.\r\n--b\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; bob@shop.gr\r\nAction: failed\r\nStatus: ${status}\r\n`
  + `--b\r\nContent-Type: text/rfc822-headers\r\n\r\nMessage-ID: ${ours}\r\nSubject: Offer\r\n--b--\r\n`;
// Gmail's own DSN (stable 6/11, info@eco-led.gr): no Message-ID of ours, only the recipient; a delay first, then (maybe) the final failure.
const gmailDsn = (to: string, action: string, status: string) => `From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\r\nTo: info@example.invalid\r\nSubject: Delivery Status Notification (Delay)\r\n`
  + `Content-Type: multipart/report; boundary="g"; report-type=delivery-status\r\n\r\n--g\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nDelivery incomplete\r\n`
  + `--g\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; googlemail.com\r\nArrival-Date: Thu, 05 Nov 2026 01:02:03 -0800\r\n\r\n`
  + `Final-Recipient: rfc822; ${to}\r\nAction: ${action}\r\nStatus: ${status}\r\nDiagnostic-Code: smtp; 421 4.4.0 try again later\r\n\r\n--g--\r\n`;
const reply = (first: string) => `From: Bob <bob@shop.gr>\r\nTo: offers@brand.example\r\nSubject: Re: Offer\r\nIn-Reply-To: ${ours}\r\nContent-Type: multipart/alternative; boundary="r"\r\n\r\n`
  + `This is a multi-part message in MIME format.\r\n--r\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(`${first}\r\n\r\n> old offer text\r\n`).toString("base64")}\r\n--r\r\nContent-Type: text/html\r\n\r\n<p>${first}</p>\r\n--r--\r\n`;

describe("signals from our mail", () => {
  it("reads hard and soft bounces, complaints, opt-out replies (Greek too) and replies, and ignores mail that is not ours", () => {
    expect(parseCampaignSignal(dsn("5.1.1"))).toEqual({ kind: "HARD_BOUNCE", messageIds: [ours], recipient: "bob@shop.gr", status: "5.1.1", noticeId: expect.stringMatching(/^sha256:/) });
    // Action: failed is final even with a 4.x.x status (a delay that gave up): hard.
    expect(parseCampaignSignal(dsn("4.2.2"))).toMatchObject({ kind: "HARD_BOUNCE", status: "4.2.2" });
    expect(parseCampaignSignal(`From: fbl@isp.example\r\nContent-Type: multipart/report; report-type=feedback-report; boundary="f"\r\n\r\n--f\r\nContent-Type: message/feedback-report\r\n\r\nFeedback-Type: abuse\r\n--f\r\nContent-Type: message/rfc822\r\n\r\nMessage-ID: ${ours}\r\n--f--\r\n`))
      .toMatchObject({ kind: "COMPLAINT", messageIds: [ours] });
    expect(parseCampaignSignal(reply("Όχι ευχαριστώ"))).toEqual({ kind: "UNSUBSCRIBE", messageIds: [ours], from: "bob@shop.gr" });
    expect(parseCampaignSignal(reply("Unsubscribe."))).toMatchObject({ kind: "UNSUBSCRIBE" });
    expect(parseCampaignSignal(reply("Ναι, στείλτε μου τιμή για 20 τεμάχια"))).toMatchObject({ kind: "REPLY" });
    expect(parseCampaignSignal(reply("Όχι ακόμα, αλλά στείλτε μου τιμή για 20 τεμάχια και τον χρόνο παράδοσης στην Πάτρα"))).toMatchObject({ kind: "REPLY" });
    expect(parseCampaignSignal("From: someone@x.example\r\nSubject: hello\r\n\r\nNo\r\n")).toBeNull();
    expect(parseCampaignSignal("From: Dan <Dan@Shop.gr>\r\nSubject: unsubscribe\r\n\r\n")).toEqual({ kind: "UNSUBSCRIBE", messageIds: [], from: "dan@shop.gr" });
  });
  it("reads a DSN without our Message-ID by its failed recipient: a delay is soft, a 5.x.x or a final failure is hard", () => {
    expect(parseCampaignSignal(gmailDsn("Info@Eco-Led.gr", "delayed", "4.4.0"))).toEqual({ kind: "SOFT_BOUNCE", messageIds: [], recipient: "info@eco-led.gr", status: "4.4.0", noticeId: expect.stringMatching(/^sha256:/) });
    expect(parseCampaignSignal(`Message-ID: <d1@mx.google.com>\r\n${gmailDsn("info@eco-led.gr", "delayed", "4.4.0")}`)).toMatchObject({ noticeId: "<d1@mx.google.com>" });
    expect(parseCampaignSignal(gmailDsn("info@eco-led.gr", "failed", "4.4.0"))).toMatchObject({ kind: "HARD_BOUNCE", recipient: "info@eco-led.gr", status: "4.4.0" });
    expect(parseCampaignSignal(gmailDsn("nobody@shop.gr", "failed", "5.1.1"))).toMatchObject({ kind: "HARD_BOUNCE", status: "5.1.1" });
    expect(parseCampaignSignal(gmailDsn("bob@shop.gr", "delivered", "2.0.0"))).toBeNull();
    expect(parseCampaignSignal("From: MAILER-DAEMON@mx.example\r\nX-Failed-Recipients: gone@shop.gr\r\nSubject: Mail delivery failed\r\n\r\n550 5.1.1 User unknown\r\n"))
      .toMatchObject({ kind: "HARD_BOUNCE", messageIds: [], recipient: "gone@shop.gr", status: "5.1.1" });
    expect(parseCampaignSignal("From: mailer-daemon@googlemail.com\r\nSubject: Your message was not delivered\r\n\r\nSomething happened\r\n")).toBeNull();
  });
});

describe("periodic health", () => {
  const dns = { txt: async () => [], mx: async (name: string) => (name === "shop.gr" || name === "gmial.com" || name === "mailinator.com" ? ["mx." + name] : name === "nullmx.example" ? ["."] : []),
    a: async (name: string) => name === "aonly.example" ? ["192.0.2.1"] : [], ptr: async () => [] };
  const receives = createDomainCheck(dns);
  const look = (address: string, extra: Partial<{ health: "BOUNCED" | "UNKNOWN"; softBounces: number }> = {}) =>
    checkContactHealth({ address, domain: address.split("@")[1]!, health: extra.health ?? "UNKNOWN", softBounces: extra.softBounces ?? 0, lastEngagedAt: null }, receives);
  it("marks what cannot receive INVALID and what is doubtful RISKY with the reason; what our mail proved stays", async () => {
    expect(await look("alice@shop.gr")).toMatchObject({ health: "VALID" });
    expect(await look("x@aonly.example")).toMatchObject({ health: "VALID" });
    expect(await look("x@nomail.example")).toMatchObject({ health: "INVALID", reasons: ["nomail.example takes no mail (no MX or A record)"] });
    expect(await look("x@nullmx.example")).toMatchObject({ health: "INVALID" });
    expect(await look("noreply@shop.gr")).toMatchObject({ health: "INVALID" });
    expect(await look("info@shop.gr")).toMatchObject({ health: "RISKY", reasons: ["a shared role mailbox (fine for B2B, not for consent lists)"] });
    expect(await look("bob@gmial.com")).toMatchObject({ health: "RISKY", reasons: ["did you mean @gmail.com?"] });
    expect(await look("bob@mailinator.com")).toMatchObject({ health: "RISKY" });
    expect(await look("bob@shop.gr", { softBounces: 1 })).toMatchObject({ health: "RISKY", reasons: ["one delivery delay on our mail"] });
    expect(await look("bob@shop.gr", { softBounces: 2 })).toMatchObject({ health: "INVALID" });
    expect(await look("bob@shop.gr", { health: "BOUNCED" })).toMatchObject({ health: "BOUNCED" });
  });
});

describe("signals applied to a sent campaign", () => {
  it("bounces suppress and mark BOUNCED, an opt-out reply suppresses, a reply marks engagement, all lists see it", async () => {
    const transports = { for: () => ({ check: async () => "ok", send: async () => ({ providerId: "p" }) }) } as unknown as MailTransports;
    const clock = Date.parse("2026-10-27T08:00:00Z");
    const service = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(() => new Date(clock).toISOString()), transports, now: () => new Date(clock).toISOString(),
      campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null, dns: passingDns, ownMailboxes: async () => [] } });
    const owner = "user:o";
    const sender = await service.createSender(owner, mailSenderCreateSchema.parse({ address: "offers@brand.example", displayName: "oll4", footerAddress: "brand.example",
      config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "offers@brand.example", vaultKeyId: "vault_key:abcdef12" }, caps: { perMinute: 5, perDay: 500 } }), "t");
    await service.checkSender(owner, sender.id);
    const { template } = await service.createTemplate(owner, mailTemplateCreateSchema.parse({ name: "T", language: "en", subject: "Offer", preheader: "p", html: `<p>${"text ".repeat(60)}</p>`, text: "text ".repeat(60) }), { by: "OPERATOR" }, null);
    const list = await service.createList(owner, { name: "L", description: "", source: "MANUAL", consentBasis: "CONSENT" });
    const other = await service.createList(owner, { name: "Other", description: "", source: "MANUAL", consentBasis: "CONSENT" });
    await service.importContacts(owner, list.id, { text: "alice@shop.gr bob@shop.gr carol@shop.gr" }, "t");
    await service.importContacts(owner, other.id, { text: "bob@shop.gr" }, "t");
    const campaign = await service.createCampaign(owner, mailCampaignCreateSchema.parse({ name: "C", templateId: template.id, senderId: sender.id, listIds: [list.id], pacing: { perMinute: 5, perDay: 300 } }), "t", null);
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: owner, via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    await service.tick();
    const sends = (await service.results(owner, campaign.id)).recent;
    const idOf = (address: string) => sends.find((send) => send.address === address)!.messageId!;
    const swap = (raw: string, address: string) => raw.split(ours).join(idOf(address));
    expect(await service.signals(owner, [Buffer.from(swap(dsn("5.1.1"), "bob@shop.gr")), Buffer.from(swap(reply("Όχι"), "alice@shop.gr")), Buffer.from(swap(reply("Ναι, ενδιαφέρομαι"), "carol@shop.gr")),
      Buffer.from("From: x@y.example\r\n\r\nhello\r\n")], "test")).toEqual({ read: 4, ours: 3, applied: 3 });
    expect(await service.contact(owner, "bob@shop.gr")).toMatchObject({ suppressed: true, contact: { health: "BOUNCED" } });
    expect(await service.contact(owner, "alice@shop.gr")).toMatchObject({ suppressed: true, contact: { health: "UNSUBSCRIBED" } });
    expect(await service.contact(owner, "carol@shop.gr")).toMatchObject({ suppressed: false, contact: { health: "VALID" } });
    expect((await service.list(owner, other.id)).health).toMatchObject({ members: 1, byHealth: { BOUNCED: 1 }, sendable: 0 });
    expect((await service.results(owner, campaign.id)).stats).toMatchObject({ bounced: { hard: 1, soft: 0 }, unsubscribed: 1, replied: 2 });

    // Bounces naming none of our sends (mail sent outside a campaign) apply by recipient, to known contacts only, once.
    const third = await service.createList(owner, { name: "Third", description: "", source: "MANUAL", consentBasis: "CONSENT" });
    await service.importContacts(owner, third.id, { text: "dave@shop.gr erin@shop.gr fay@shop.gr" }, "t");
    const outside = [gmailDsn("dave@shop.gr", "failed", "5.1.1"), gmailDsn("erin@shop.gr", "delayed", "4.4.0"), gmailDsn("fay@shop.gr", "failed", "5.7.7"),
      gmailDsn("stranger@else.example", "failed", "5.1.1")].map((raw) => Buffer.from(raw));
    expect(await service.signals(owner, outside, "mailbox info@example.invalid")).toEqual({ read: 4, ours: 4, applied: 3 });
    expect(await service.signals(owner, outside, "mailbox info@example.invalid")).toMatchObject({ applied: 0 });
    expect(await service.contact(owner, "dave@shop.gr")).toMatchObject({ suppressed: true, contact: { health: "BOUNCED" } });
    expect(await service.contact(owner, "erin@shop.gr")).toMatchObject({ suppressed: false, contact: { health: "RISKY", healthReasons: ["delivery delayed 4.4.0"] } });
    expect(await service.contact(owner, "fay@shop.gr")).toMatchObject({ suppressed: false, contact: { health: "RISKY", healthReasons: ["rejected by policy 5.7.7"] } });
    await expect(service.contact(owner, "stranger@else.example")).rejects.toThrow(/not found/);
  });

  it("counts a delay once by the notice's own id, also after a restart, and a second distinct delay makes the contact INVALID", async () => {
    const repository = new InMemoryMailCampaignsRepository();
    const start = () => createMailCampaignsService({ repository, campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null } });
    const owner = "user:o";
    const list = await start().createList(owner, { name: "Lots", description: "", source: "MANUAL", consentBasis: "CONSENT" });
    await start().importContacts(owner, list.id, { text: "info@eco-led.gr" }, "t");
    const notice = (id: string) => Buffer.from(`Message-ID: <${id}@mx.google.com>\r\n${gmailDsn("info@eco-led.gr", "delayed", "4.4.0")}`);
    expect(await start().signals(owner, [notice("d1")], "mailbox info@example.invalid")).toMatchObject({ applied: 1 });
    // A restart: a new service reads the whole mailbox again (the same notice), and nothing is counted twice.
    expect(await start().signals(owner, [notice("d1")], "mailbox info@example.invalid")).toMatchObject({ applied: 0 });
    expect(await start().contact(owner, "info@eco-led.gr")).toMatchObject({ contact: { health: "RISKY", softBounces: 1 } });
    expect(await start().signals(owner, [notice("d1"), notice("d2")], "mailbox info@example.invalid")).toMatchObject({ applied: 1 });
    expect(await start().contact(owner, "info@eco-led.gr")).toMatchObject({ contact: { health: "INVALID", softBounces: 2, healthReasons: ["2 delivery delays, last 4.4.0"] } });
  });
});

describe("mailbox correspondents", () => {
  it("go only into a CONTACT list, without our own addresses", async () => {
    const service = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(), campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null },
      mailboxCorrespondents: async () => [{ name: "Bob", address: "bob@shop.gr" }, { name: "Me", address: "info@example.invalid" }, { name: "", address: "not-mail" }] });
    const owner = "user:o";
    const contacts = await service.createList(owner, { name: "Correspondents", description: "", source: "MAILBOX", consentBasis: "CONTACT" });
    const consent = await service.createList(owner, { name: "Subscribers", description: "", source: "MANUAL", consentBasis: "CONSENT" });
    await expect(service.importMailbox(owner, consent.id, { account: "info@example.invalid", days: 30 }, "t")).rejects.toThrow(/only into a CONTACT list/);
    expect(await service.importMailbox(owner, contacts.id, { account: "info@example.invalid", days: 30 }, "t")).toMatchObject({ added: 1, invalid: 1 });
    expect((await service.contacts(owner, { listId: contacts.id, limit: 10 })).map((row) => row.address)).toEqual(["bob@shop.gr"]);
  });
});

describe("the health job's mailbox pass", () => {
  it("reads every bounce the mailbox ever got on its first pass, then only the 3-day window", async () => {
    const queries: string[] = [];
    const gmail = { listThreads: async ({ q }: { q: string }) => { queries.push(q); return { ids: q.includes("mailer-daemon") ? ["t1"] : [], nextPageToken: null }; },
      thread: async () => ({ messages: [{ id: "m1" }] }), message: async () => ({ raw: Buffer.from(gmailDsn("old@shop.gr", "failed", "5.1.1")).toString("base64url") }) };
    const transports = { for: () => ({ check: async () => "ok", send: async () => ({ providerId: "p" }) }), gmailFor: async () => gmail } as unknown as MailTransports;
    const service = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(), transports, campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null, dns: passingDns } });
    const owner = "user:o";
    await service.createSender(owner, mailSenderCreateSchema.parse({ address: "offers@brand.example", displayName: "oll4", footerAddress: "brand.example",
      config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "offers@brand.example", vaultKeyId: "vault_key:abcdef12" }, caps: { perMinute: 5, perDay: 500 } }), "t");
    const list = await service.createList(owner, { name: "L", description: "", source: "MANUAL", consentBasis: "CONSENT" });
    await service.importContacts(owner, list.id, { text: "old@shop.gr" }, "t");
    await service.healthTick();
    await service.healthTick();
    expect(queries).toEqual(["in:anywhere (from:mailer-daemon OR from:postmaster)", "newer_than:3d -in:sent -in:drafts", "newer_than:3d -in:sent -in:drafts"]);
    expect(await service.contact(owner, "old@shop.gr")).toMatchObject({ suppressed: true, contact: { health: "BOUNCED" } });
  });
});
