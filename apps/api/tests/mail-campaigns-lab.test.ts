// Mail Campaigns deliverability lab (plan clipboard:IJ2ovfLg1Lbw step 6): DNS authentication for the route, blocklists (Spamhaus's
// refusal of public resolvers is UNKNOWN, not clean), content lint, SpamAssassin scores accepted only for the exact MIME handed out,
// seed placement, and a FAIL that keeps a campaign from review.
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { mailCampaignCreateSchema, mailSenderCreateSchema, mailTemplateCreateSchema } from "@space/contracts";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { dnsblCheck, dnsCheck, lintCheck, type LabDns } from "../src/mail-campaigns/lab.js";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import type { MailTransports } from "../src/mail-campaigns/transports.js";
import { mailSite } from "../src/mail-campaigns/site.js";
import { MAIL_SITE, passingDns, stubMailSite } from "./fixtures/mail-campaigns-dns.js";

stubMailSite();

const smtp = { domain: "brand.example", config: { route: "SMTP" as const, host: "smtp.brand.example", port: 465 as const, username: "x@brand.example", vaultKeyId: "vault_key:abcdef12" } };
const gmail = { domain: "example.invalid", config: { route: "GMAIL_DELEGATED" as const, subject: "info@example.invalid", vaultKeyId: "vault_key:abcdef12" } };
const dns = (records: Partial<Record<"txt" | "mx" | "a" | "ptr", Record<string, string[]>>>): LabDns => ({
  txt: async (name) => records.txt?.[name] ?? [], mx: async (name) => records.mx?.[name] ?? [], a: async (name) => records.a?.[name] ?? [], ptr: async (name) => records.ptr?.[name] ?? [] });

describe("lab checks", () => {
  it("passes an authenticated SMTP sender and names every gap of an unauthenticated one", async () => {
    expect(await dnsCheck(passingDns, smtp)).toMatchObject({ kind: "DNS", status: "PASS", score: 100 });
    const bad = await dnsCheck(dns({ txt: { "example.invalid": ["v=spf1 +a +mx ~all"], "_dmarc.example.invalid": ["v=DMARC1; p=quarantine"] }, mx: { "example.invalid": ["aspmx.l.google.com"] } }), gmail);
    expect(bad.status).toBe("FAIL");
    expect(bad.details.findings).toEqual(["SPF does not allow this route (include:_spf.google.com)", "no DKIM key at google._domainkey.example.invalid", "DMARC has no rua (no reports)"]);
    expect(bad.details.fixes[0]).toContain("include:_spf.google.com");
  });
  it("reads a listing, and Spamhaus's refusal of public resolvers as unknown", async () => {
    const reversed = MAIL_SITE.egressIp.split(".").reverse().join(".");
    const listed = await dnsblCheck(dns({ a: { [`${reversed}.bl.spamcop.net`]: ["127.0.0.2"], [`${reversed}.zen.spamhaus.org`]: ["127.255.255.254"], "brand.example.dbl.spamhaus.org": ["127.255.255.254"] } }), smtp, ["brand.example"]);
    expect(listed).toMatchObject({ status: "FAIL", details: { unknown: ["zen.spamhaus.org", "dbl.spamhaus.org"] } });
    expect(listed.details.findings[0]).toBe(`${MAIL_SITE.egressIp} is listed on bl.spamcop.net`);
    expect((await dnsblCheck(dns({}), gmail, ["example.invalid"])).status).toBe("PASS");
  });
  it("with no own mail site set, the SMTP route has no egress address and no own server (review EXT-C-F18 R2)", async () => {
    const site = mailSite({});
    expect([site.egressIp, [...site.smtpHosts], site.heloName]).toEqual(["", [], hostname()]);
    expect([...mailSite({ SPACE_MAIL_SMTP_HOSTS: " a.example , b.example" }).smtpHosts]).toEqual(["a.example", "b.example"]);
    const unset = await dnsCheck(passingDns, smtp, "");
    expect(unset).toMatchObject({ status: "FAIL", details: { findings: ["no egress address is set, so its reverse name is unchecked"] } });
    expect(unset.details.fixes).toEqual(["set SPACE_MAIL_EGRESS_IP to the public address SMTP mail leaves from"]);
    expect((await dnsblCheck(dns({}), smtp, [], "")).status).toBe("PASS");
  });
  it("lints content: hidden text, shorteners and image-only mail fail or warn with fixes", () => {
    const good = lintCheck({ subject: "Κιτ επισκευής 10 σε 1 για τη βιτρίνα σας", preheader: "Τιμή χονδρικής", html: `<p>${"Περιγραφή του προϊόντος. ".repeat(20)}</p><a href="https://example.invalid/p">Δείτε</a>`, text: "Περιγραφή του προϊόντος. ".repeat(20) }, "example.invalid");
    expect(good).toMatchObject({ status: "PASS", details: { linkDomains: ["example.invalid"] } });
    const bad = lintCheck({ subject: "ΔΩΡΕΑΝ ΠΡΟΣΦΟΡΑ ΤΩΡΑ!!!", preheader: "", html: '<img src="https://example.invalid/a.jpg"><a href="https://bit.ly/x">x</a><span style="display:none">hidden</span>', text: "x" }, "example.invalid");
    expect(bad.status).toBe("FAIL");
    expect(bad.details.findings).toEqual(expect.arrayContaining(["link shorteners: bit.ly", "hidden text in the template", "the subject is in capitals", "images without alt text", 'spam-trigger wording ("ΔΩΡΕΑΝ")', "1 image(s) with only 8 characters of text"]));
  });
});

describe("the lab on a campaign", () => {
  async function setup(labDns: LabDns, labels: string[] | null = ["INBOX"]) {
    const transports = { for: () => ({ check: async () => "ok", send: async () => ({ providerId: "p" }) }) } as unknown as MailTransports;
    const service = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(), transports, campaigns: { unsubscribeKey: Buffer.alloc(32, 3), unsubscribeBase: null, dns: labDns,
      ownMailboxes: async () => ["operator@gmail.com"], seedMessage: async () => labels && { labels, headers: [] } } });
    const owner = "user:o";
    const sender = await service.createSender(owner, mailSenderCreateSchema.parse({ address: "offers@brand.example", displayName: "oll4", footerAddress: "oll4.com, Athens",
      config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "offers@brand.example", vaultKeyId: "vault_key:abcdef12" } }), "t");
    await service.checkSender(owner, sender.id);
    const { template } = await service.createTemplate(owner, mailTemplateCreateSchema.parse({ name: "T", language: "en", subject: "Hello", preheader: "Hi", html: `<p>${"Real text. ".repeat(30)}</p>`, text: "Real text. ".repeat(30) }), { by: "OPERATOR" }, null);
    const list = await service.createList(owner, { name: "L", description: "", source: "MANUAL", consentBasis: "CONSENT" });
    await service.importContacts(owner, list.id, { text: "a@shop.example" }, "t");
    const campaign = await service.createCampaign(owner, mailCampaignCreateSchema.parse({ name: "C", templateId: template.id, senderId: sender.id, listIds: [list.id], testSeeds: ["operator@gmail.com"] }), "t", null);
    return { service, owner, campaign };
  }
  it("keeps a campaign whose sender is not authenticated out of review, with the fixes", async () => {
    const { service, owner, campaign } = await setup(dns({}));
    await expect(service.submit(owner, campaign.id)).rejects.toThrow(/Fix the failed checks first: DNS/);
    const results = await service.labResults(owner, campaign.id);
    expect(results.current.map((check) => `${check.kind}:${check.status}`).sort()).toEqual(["DNS:FAIL", "DNSBL:PASS", "LINT:PASS"]);
  });
  it("accepts a SpamAssassin score only for the MIME it handed out, and reads seed placement", async () => {
    const { service, owner, campaign } = await setup(passingDns, ["INBOX", "CATEGORY_PROMOTIONS"]);
    const { sha256, mime } = await service.labMime(owner, campaign.id);
    expect(Buffer.from(mime, "base64").toString()).toContain("To: a@shop.example");
    await expect(service.recordLab(owner, campaign.id, { kind: "SPAMASSASSIN", sha256: "0".repeat(64), score: 0, rules: [] })).rejects.toThrow(/handed out/);
    expect(await service.recordLab(owner, campaign.id, { kind: "SPAMASSASSIN", sha256, score: 5.2, rules: ["HTML_IMAGE_ONLY_08"] })).toMatchObject({ kind: "SPAMASSASSIN", status: "FAIL", score: 5.2 });
    await expect(service.submit(owner, campaign.id)).rejects.toThrow(/SPAMASSASSIN/);
    // A changed campaign has a new fingerprint: the old score no longer counts, and a MIME handed out before the change is refused.
    await service.updateCampaign(owner, campaign.id, { pacing: { perMinute: 1, perDay: 200 } });
    await expect(service.recordLab(owner, campaign.id, { kind: "SPAMASSASSIN", sha256, score: 0, rules: [] })).rejects.toThrow(/changed/);
    await service.testCampaign(owner, campaign.id);
    expect(await service.seedPlacement(owner, campaign.id)).toMatchObject({ kind: "SEED", status: "PASS", details: { placements: [{ seed: "operator@gmail.com", where: "PROMOTIONS" }] } });
    expect((await service.submit(owner, campaign.id)).status).toBe("IN_REVIEW");
  });
  it("fails the seed check when a copy lands in spam", async () => {
    const { service, owner, campaign } = await setup(passingDns, ["SPAM"]);
    await service.testCampaign(owner, campaign.id);
    expect((await service.seedPlacement(owner, campaign.id)).status).toBe("FAIL");
  });
});
