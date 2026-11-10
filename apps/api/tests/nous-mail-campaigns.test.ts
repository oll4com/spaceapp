// Nous and Mail Campaigns (plan clipboard:IJ2ovfLg1Lbw step 10): Nous reads campaigns, lists with health, templates and senders, drafts or
// changes a campaign, runs its checks and asks the operator; it has no way to approve (the operator approves in the pane after reading
// every mail), helpers only read, and a Nous decision may only cancel a campaign.
import { describe, expect, it } from "vitest";
import { mailSenderCreateSchema, mailTemplateCreateSchema, type NousDecisionAction, type Room } from "@space/contracts";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import type { MailTransports } from "../src/mail-campaigns/transports.js";
import { copilotActionProblem } from "../src/nous/copilot-actions.js";
import { NOUS_SUBAGENT_EXCLUDED } from "../src/nous/subagents.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { passingDns, stubMailSite } from "./fixtures/mail-campaigns-dns.js";

stubMailSite();

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };

describe("Nous tools for Mail Campaigns", () => {
  it("drafts, checks and asks; never approves", async () => {
    const transports = { for: () => ({ check: async () => "ok", send: async () => ({ providerId: "p" }) }) } as unknown as MailTransports;
    const mail = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(), transports, campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null, dns: passingDns, ownMailboxes: async () => [] } });
    const sender = await mail.createSender(owner, mailSenderCreateSchema.parse({ address: "ntheo@brand.example", displayName: "oll4", footerAddress: "brand.example",
      config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "ntheo@brand.example", vaultKeyId: "vault_key:abcdef12" } }), "t");
    await mail.checkSender(owner, sender.id);
    const { template } = await mail.createTemplate(owner, mailTemplateCreateSchema.parse({ name: "T", language: "en", subject: "For {{domain}}", preheader: "p", text: `${"Real text. ".repeat(30)} {{domain}}`, variables: [{ name: "domain", required: true }] }), { by: "OPERATOR" }, null);
    const list = await mail.createList(owner, { name: "Shops", description: "", source: "CSV", consentBasis: "B2B" });
    await mail.importContacts(owner, list.id, { csv: "email,domain\na@shop-a.gr,shop-a.gr\n" }, "t");
    const nous = createNousTools({ rooms: async () => [{ id: "room:alpha0001", name: "Alpha", kind: "WORKSPACE" } as Room], listPanes: async () => [], mailCampaigns: mail } as unknown as NousToolDeps);

    const drafted = await nous.execute("space_mail_campaign_draft", { name: "oll4 support", template: template.id, sender: sender.id, lists: [list.id], pacing: { perMinute: 1, perDay: 90, intervalSeconds: 360, maxHardBounces: 3 } }, ctx);
    expect(drafted.ok).toBe(true);
    const id = /mcamp:[A-Za-z0-9_-]+/.exec(drafted.result)![0];
    const all = JSON.parse((await nous.execute("space_mail_campaigns", {}, ctx)).result);
    expect(all).toMatchObject({ campaigns: [{ id, status: "DRAFT" }], lists: [{ name: "Shops", consentBasis: "B2B", members: 1, sendable: 1 }], senders: [{ address: "ntheo@brand.example", route: "SMTP", status: "ACTIVE" }] });
    expect(JSON.stringify(all)).not.toContain("a@shop-a.gr");
    expect(JSON.parse((await nous.execute("space_mail_campaign_lab", { campaign: id }, ctx)).result).checks.map((check: { kind: string }) => check.kind)).toEqual(["DNS", "DNSBL", "LINT"]);
    expect((await nous.execute("space_mail_campaign_submit", { campaign: id }, ctx)).result).toContain("waits for the operator");
    const one = JSON.parse((await nous.execute("space_mail_campaigns", { campaign: id }, ctx)).result);
    expect(one).toMatchObject({ campaign: { status: "IN_REVIEW" }, recipients: 1, firstMails: [{ priority: 0, subject: "For shop-a.gr" }] });
    expect((await nous.execute("space_mail_campaign_draft", { name: "x" }, ctx)).ok).toBe(false);

    // Senders (operator 2/11 15:01 BKK): Nous sets caps, warm-up and bulk itself; the lower of caps and stage is the day's most.
    const changed = await nous.execute("space_mail_sender", { sender: sender.id, caps: { perMinute: 1, perDay: 50 }, warmupStage: 1, bulk: false }, ctx);
    expect(changed.ok).toBe(true);
    expect(JSON.parse(changed.result)).toMatchObject({ caps: { perMinute: 1, perDay: 50 }, warmupStage: 1, bulk: false, sendsADayAtMost: 50 });
    expect((await mail.events(owner, {})).map((row) => row.message)).toEqual(expect.arrayContaining(["Warm-up of ntheo@brand.example set to stage 1 by nous.",
      "Bulk turned off for ntheo@brand.example by nous."]));
    expect((await nous.execute("space_mail_sender", { sender: sender.id }, ctx)).ok).toBe(false);
  });

  it("gives helpers the read only, and lets a decision only cancel", () => {
    for (const name of ["space_mail_campaign_draft", "space_mail_campaign_lab", "space_mail_campaign_submit", "space_mail_sender"]) expect(NOUS_SUBAGENT_EXCLUDED.has(name)).toBe(true);
    expect(NOUS_SUBAGENT_EXCLUDED.has("space_mail_campaigns")).toBe(false);
    const action = (decision: string) => ({ type: "COPILOT", copilot: "MAIL", item: "CAMPAIGN", itemId: "mcamp:abcdefgh", decision }) as unknown as NousDecisionAction;
    expect(copilotActionProblem(action("approve"))).toMatch(/use cancel/);
    expect(copilotActionProblem(action("cancel"))).toBeNull();
  });
});
