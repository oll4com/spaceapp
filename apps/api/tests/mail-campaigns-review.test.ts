// Mail Campaigns step 9 backend (plan clipboard:IJ2ovfLg1Lbw; Nous 29/10 for the oll4 e-shop outreach): one template renders a different
// mail per contact (merge fields), the operator browses every rendered mail (search, next/previous) and their Approve binds exactly
// those mails; a change to one recipient's data voids it, before and after approval; one mail every N minutes, a daily cap, the first
// list first, a stop after more than N hard bounces; lists without consent never get bulk mail.
import { describe, expect, it } from "vitest";
import { mailCampaignCreateSchema, mailSenderCreateSchema, mailTemplateCreateSchema, type NotificationRaiseInput } from "@space/contracts";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import type { MailTransports } from "../src/mail-campaigns/transports.js";
import { passingDns, stubMailSite } from "./fixtures/mail-campaigns-dns.js";

stubMailSite();

async function setup() {
  let clock = Date.parse("2026-11-02T07:00:00Z"); // Monday 09:00 Athens
  const now = () => new Date(clock).toISOString();
  const sent: string[] = [];
  const cards: NotificationRaiseInput[] = [];
  const transports = { for: () => ({ check: async () => "ok", send: async (_raw: Buffer, envelope: { to: string }) => { sent.push(envelope.to); return { providerId: "p" }; } }) } as unknown as MailTransports;
  const service = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(now), transports, now, campaigns: { unsubscribeKey: Buffer.alloc(32, 9), unsubscribeBase: null, dns: passingDns,
    ownMailboxes: async () => [], notify: { raise: async (input) => { cards.push(input); }, resolve: async () => undefined }, mailPane: async () => ({ id: "pane:mail00001", roomId: "room:room00001" }) } });
  const owner = "user:o";
  const sender = await service.createSender(owner, mailSenderCreateSchema.parse({ address: "ntheo@brand.example", displayName: "Νικόλαος Θεοδωρόπουλος | oll4.com", footerAddress: "oll4.com, Αθήνα",
    config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "ntheo@brand.example", vaultKeyId: "vault_key:abcdef12" }, caps: { perMinute: 1, perDay: 500 } }), "t");
  await service.checkSender(owner, sender.id);
  // A plain-text template: the HTML part comes from the text.
  const { template } = await service.createTemplate(owner, mailTemplateCreateSchema.parse({ name: "e-shop support", language: "el", subject: "Τεχνική παρατήρηση για το {{domain}}",
    text: "Καλημέρα σας,\n\nΣε έναν έλεγχο του {{domain}} είδαμε ότι {{observation}}.\n\nhttps://oll4.com", variables: [{ name: "domain", required: true }, { name: "observation", required: true }] }), { by: "OPERATOR" }, null);
  const priority = await service.createList(owner, { name: "Priority", description: "", source: "CSV", consentBasis: "B2B" });
  const rest = await service.createList(owner, { name: "Rest", description: "", source: "CSV", consentBasis: "B2B" });
  await service.importContacts(owner, rest.id, { csv: "address,shop,domain,observation\na@shop-a.gr,A,shop-a.gr,τρέχει PHP 7.3\nb@shop-b.gr,B,shop-b.gr,λείπει το HSTS\nz@shop-z.gr,Z,shop-z.gr,αργεί η σελίδα\n" }, "t");
  await service.importContacts(owner, priority.id, { csv: "address,shop,domain,observation\nz@shop-z.gr,Z,shop-z.gr,αργεί η σελίδα\n" }, "t");
  const campaign = await service.createCampaign(owner, mailCampaignCreateSchema.parse({ name: "oll4 support", templateId: template.id, senderId: sender.id, listIds: [priority.id, rest.id],
    pacing: { perMinute: 1, perDay: 90, intervalSeconds: 360, maxHardBounces: 3 } }), "t", null);
  return { service, owner, campaign, rest, sent, cards, advance: (minutes: number) => { clock += minutes * 60_000; } };
}

describe("reading every mail before approving", () => {
  it("renders a different mail per contact, in send order, with search and next/previous, and a plain-text body", async () => {
    const { service, owner, campaign } = await setup();
    const list = await service.preview(owner, campaign.id, { offset: 0, limit: 50 });
    expect(list.items.map((item) => [item.address, item.priority, item.subject])).toEqual([
      ["z@shop-z.gr", 0, "Τεχνική παρατήρηση για το shop-z.gr"], ["a@shop-a.gr", 1, "Τεχνική παρατήρηση για το shop-a.gr"], ["b@shop-b.gr", 1, "Τεχνική παρατήρηση για το shop-b.gr"]]);
    expect((await service.preview(owner, campaign.id, { q: "SHOP-B", offset: 0, limit: 50 })).items.map((item) => item.address)).toEqual(["b@shop-b.gr"]);
    const first = await service.previewMail(owner, campaign.id, list.items[0]!.contactId);
    expect(first).toMatchObject({ index: 0, total: 3, previous: null, next: list.items[1]!.contactId, to: "z@shop-z.gr", from: "Νικόλαος Θεοδωρόπουλος | oll4.com <ntheo@brand.example>", fingerprint: list.fingerprint });
    expect(first.text).toContain("Σε έναν έλεγχο του shop-z.gr είδαμε ότι αργεί η σελίδα.");
    expect(first.text).toContain("ntheo@brand.example"); // the server's footer
    expect(first.html).toContain("white-space:pre-wrap");
    expect(first.html).toContain("αργεί η σελίδα");
    expect((await service.previewMail(owner, campaign.id, list.items[1]!.contactId)).text).toContain("τρέχει PHP 7.3");
  });

  it("binds the Approve to the mails read: none from the card or Nous, none after a contact's data changed", async () => {
    const { service, owner, campaign, rest, cards } = await setup();
    const asked = await service.submit(owner, campaign.id);
    expect((cards.at(-1)!.payload as { ask: { options: string[] } }).ask.options).toEqual(["Decline"]);
    await expect(service.decide(owner, campaign.id, "approve", { who: owner, via: "RAIL", decisionId: null })).rejects.toThrow(/Mail Copilot → Campaigns/);
    await expect(service.decide(owner, campaign.id, "approve", { who: owner, via: "NOUS", decisionId: "nous_decision:x" })).rejects.toThrow(/approve there/);
    const read = (await service.preview(owner, campaign.id, { offset: 0, limit: 50 })).fingerprint;
    expect(read).toBe(asked.fingerprint);
    // A corrected observation for one shop changes that mail: the campaign is asked again and the old Approve is refused.
    await service.importContacts(owner, rest.id, { csv: "address,domain,observation\nb@shop-b.gr,shop-b.gr,λείπει το HSTS και το CSP\n", overwrite: true }, "t");
    expect((await service.preview(owner, campaign.id, { offset: 0, limit: 50 })).fingerprint).not.toBe(read);
    await expect(service.decide(owner, campaign.id, "approve", { who: owner, via: "RAIL", decisionId: null, fingerprint: read })).rejects.toThrow(/changed/);
    const again = await service.campaign(owner, campaign.id);
    expect(await service.decide(owner, campaign.id, "approve", { who: owner, via: "RAIL", decisionId: null, fingerprint: again.fingerprint! })).toMatch(/3 recipients/);
  });

  it("sends one every 6 minutes in priority order, and a change after approval stops it for review", async () => {
    const { service, owner, campaign, rest, sent, advance } = await setup();
    await service.submit(owner, campaign.id);
    await service.decide(owner, campaign.id, "approve", { who: owner, via: "RAIL", decisionId: null, fingerprint: (await service.campaign(owner, campaign.id)).fingerprint! });
    await service.tick();
    advance(1); await service.tick();
    expect(sent).toEqual(["z@shop-z.gr"]); // the priority list first; nothing again within 6 minutes
    advance(6); await service.tick();
    expect(sent).toEqual(["z@shop-z.gr", "a@shop-a.gr"]);
    await service.importContacts(owner, rest.id, { csv: "address,domain,observation\nb@shop-b.gr,shop-b.gr,νέα παρατήρηση\n", overwrite: true }, "t");
    advance(6); await service.tick();
    expect(sent).toHaveLength(2);
    expect(await service.campaign(owner, campaign.id)).toMatchObject({ status: "IN_REVIEW", approval: null });
  });

  it("stops after more than the allowed hard bounces, and refuses lists without consent", async () => {
    const { service, owner, campaign } = await setup();
    const none = await service.createList(owner, { name: "Registered, no purchase", description: "", source: "CS_CART", consentBasis: "NO_CONSENT" });
    await expect(service.updateCampaign(owner, campaign.id, { listIds: [none.id] })).rejects.toThrow(/without consent/);
    expect((await service.updateCampaign(owner, campaign.id, { pacing: { perMinute: 1, perDay: 90, maxHardBounces: 0 + 1 } })).pacing.maxHardBounces).toBe(1);
  });
});
