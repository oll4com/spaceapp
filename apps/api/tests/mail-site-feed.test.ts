// The UnboxExpert admin's read-only Mail Campaigns window (operator 23/11): only public-host with the site key reads it, and it changes nothing.
import { hkdfSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { mailSiteFeedKey } from "../src/mail-campaigns/site-feed.js";
import { unsubscribeToken } from "../src/mail-campaigns/mime.js";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import { mailDeliveryReportSchema } from "@space/contracts";

vi.setConfig({ testTimeout: 30_000 });
// The feed key derives from the connector key (unsubscribe secret); a test file of its own.
const secret = "connector-key-of-the-test-with-enough-length";
const keyFile = join(mkdtempSync(join(tmpdir(), "mail-site-feed-")), "connector.key");
writeFileSync(keyFile, secret);

describe("mail site feed", () => {
  it("answers public-host with the site key only, scoped to the site: its senders without config, their campaigns, lists, templates and opens, and members in pages", async () => {
    const repository = new InMemoryMailCampaignsRepository();
    const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }), eventBus: new SpaceEventBus(), jobApplyMailTriage: false,
      marketingCopilotScheduler: false, mailCampaignsRepository: repository, auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
    try {
      const owner = "user:operator";
      const feed = (headers: Record<string, string>, query = "", remoteAddress = "192.0.2.110") => app.inject({ method: "GET", url: `/api/public/mail/site-feed${query}`, remoteAddress, headers });
      const key = { "x-space-site-key": mailSiteFeedKey(secret) };
      expect((await feed(key, "", "192.0.2.111")).statusCode).toBe(403);
      expect((await feed({ "x-space-site-key": mailSiteFeedKey("another-secret-of-enough-length") })).statusCode).toBe(401);
      expect((await feed({})).statusCode).toBe(401);

      const list = await repository.createList({ ownerUserId: owner, name: "example.invalid customers", description: "", source: "CSV", consentBasis: "CUSTOMER" });
      const contacts = await repository.upsertContacts(owner, Array.from({ length: 205 }, (_, index) => ({ address: `buyer${index}@shop.gr`, name: "", attributes: {} })));
      await repository.addMembers(owner, list.id, contacts.map((row) => row.id), "test");
      // No sender writes from unboxexpert.com yet: nothing to show.
      expect((await feed(key)).statusCode).toBe(404);
      await repository.createSender({ ownerUserId: owner, address: "info@unboxexpert.com", displayName: "UnboxExpert", domain: "unboxexpert.com",
        config: { route: "GMAIL_DELEGATED", subject: "info@unboxexpert.com", vaultKeyId: "vault_key:delegation1" }, replyTo: null, footerAddress: "UnboxExpert",
        status: "SETUP", warmup: { stage: 0, since: "2026-11-23T00:00:00.000Z" }, caps: { perMinute: 1, perDay: 500 }, bulk: true, bulkNote: null, createdBy: "test" });

      const overview = (await feed(key)).json();
      expect(overview.senders).toHaveLength(1);
      expect(overview.senders[0]).toMatchObject({ address: "info@unboxexpert.com" });
      expect("config" in overview.senders[0]).toBe(false);
      expect(overview.lists).toMatchObject([{ id: list.id, consentBasis: "CUSTOMER" }]);
      expect(overview).toMatchObject({ campaigns: [], templates: [], opens: [] });

      // Scope (plan ES4AQEtVuDon step 3): public-host hosts other sites, so the owner's other senders, their campaigns, lists, templates and
      // opens, and Mail Copilot's single-mail opens never reach the feed.
      const site = (await repository.listSenders(owner))[0]!;
      const other = await repository.createSender({ ownerUserId: owner, address: "work@example.invalid", displayName: "oll4", domain: "oll4.com",
        config: { route: "GMAIL_DELEGATED", subject: "work@example.invalid", vaultKeyId: "vault_key:delegation2" }, replyTo: null, footerAddress: "oll4",
        status: "ACTIVE", warmup: { stage: 0, since: "2026-11-23T00:00:00.000Z" }, caps: { perMinute: 1, perDay: 500 }, bulk: true, bulkNote: null, createdBy: "test" });
      const template = async (name: string) => (await repository.createTemplate({ ownerUserId: owner, name, language: "en", paneId: null, fingerprint: name, madeBy: { by: "OPERATOR" },
        content: { subject: name, preheader: "", html: "", text: name, variables: [], attachments: [] } })).template;
      const campaign = async (name: string, senderId: string, listId: string, templateId: string) => repository.createCampaign({ ownerUserId: owner, paneId: null, name, goal: "", templateId,
        templateVersion: 1, senderId, listIds: [listId], schedule: { startAt: null, timeZone: "Europe/Athens", days: [1], fromHour: 9, toHour: 18 }, pacing: { perMinute: 1, perDay: 300 },
        testSeeds: [], track: true, createdBy: "test" });
      const siteList = await repository.createList({ ownerUserId: owner, name: "Fav alerts chain", description: "", source: "CSV", consentBasis: "CONSENT" });
      const otherList = await repository.createList({ ownerUserId: owner, name: "oll4 outreach", description: "", source: "CSV", consentBasis: "B2B" });
      await repository.addMembers(owner, otherList.id, [contacts[0]!.id], "test");
      const siteTemplate = await template("Site offer");
      const siteCampaign = await campaign("Site offer", site.id, siteList.id, siteTemplate.id);
      const otherCampaign = await campaign("oll4 pitch", other.id, otherList.id, (await template("oll4 pitch")).id);
      const opened = (token: string, campaignId?: string) => repository.trackMessage({ token: token.repeat(32), ownerUserId: owner, recipient: `${token}@shop.gr`, recipientName: "",
        subject: "s", links: [], ...(campaignId ? { campaignId, contactId: contacts[0]!.id } : {}) });
      await opened("a", siteCampaign.id); await opened("b", otherCampaign.id); await opened("c");

      const scoped = (await feed(key)).json();
      expect(scoped.senders.map((row: { id: string }) => row.id)).toEqual([site.id]);
      expect(scoped.campaigns.map((row: { id: string }) => row.id)).toEqual([siteCampaign.id]);
      expect(scoped.templates.map((row: { id: string }) => row.id)).toEqual([siteTemplate.id]);
      expect(scoped.lists.map((row: { id: string }) => row.id).sort()).toEqual([list.id, siteList.id].sort());
      expect(scoped.opens.map((row: { recipient: string }) => row.recipient)).toEqual(["a@shop.gr"]);
      // Inbox or spam: the latest seed placement, its raw verdict headers left out.
      expect(scoped.campaigns[0].seeds).toBeNull();
      await repository.addCheck({ ownerUserId: owner, campaignId: siteCampaign.id, senderId: site.id, kind: "SEED", status: "PASS", score: 100, fingerprint: null,
        details: { placements: [{ seed: "seed@gmail.com", kind: "TEST", messageId: "<m1>", where: "PROMOTIONS", auth: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: [{ name: "Authentication-Results", value: "x" }] }] } });
      expect((await feed(key)).json().campaigns[0].seeds).toMatchObject({ status: "PASS", score: 100,
        placements: [{ seed: "seed@gmail.com", kind: "TEST", where: "PROMOTIONS", auth: { spf: "pass", dkim: "pass", dmarc: "pass" } }] });
      expect("headers" in (await feed(key)).json().campaigns[0].seeds.placements[0]).toBe(false);
      // Delivery (plan vxtgxdSGE586 step 6a/6b): DMARC and TLS-RPT reports as space-mail-dmarc.mjs --save hands them over, each kept once; the feed
      // carries only those about unboxexpert.com.
      const reports = [
        { kind: "dmarc", org: "google.com", id: "r1", domain: "unboxexpert.com", begin: 1794096000, end: 1794182399, records: [
          { ip: "192.0.2.110", count: 5, disposition: "none", dkim: "pass", spf: "pass", headerFrom: "unboxexpert.com" },
          { ip: "203.0.113.9", count: 2, disposition: "quarantine", dkim: "fail", spf: "fail", headerFrom: "unboxexpert.com" }] },
        { kind: "dmarc", org: "yahoo.com", id: "r2", domain: "oll4.com", begin: 1794096000, end: 1794182399, records: [{ ip: "192.0.2.110", count: 1, disposition: "none", dkim: "pass", spf: "fail", headerFrom: "oll4.com" }] },
        { kind: "tls", org: "Google Inc.", id: "t1", policies: [{ domain: "unboxexpert.com", ok: 9, failed: 0, failures: [] }] }
      ].map((report) => mailDeliveryReportSchema.parse(report));
      expect(() => mailDeliveryReportSchema.parse({ ...reports[0], id: "" })).toThrow();
      const service = createMailCampaignsService({ repository, campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null } });
      expect(await service.deliveryReports(owner, reports)).toEqual({ received: 3, stored: 3 });
      expect(await service.deliveryReports(owner, reports.slice(0, 1))).toEqual({ received: 1, stored: 0 });
      const delivery = (await feed(key)).json().deliveryReports;
      expect(delivery.map((row: { kind: string; id: string }) => `${row.kind}:${row.id}`).sort()).toEqual(["DMARC_REPORT:r1", "TLS_REPORT:t1"]);
      expect(delivery.find((row: { id: string }) => row.id === "r1")).toMatchObject({ status: "FAIL", score: 71, org: "google.com", records: [{ ip: "192.0.2.110", count: 5 }, { ip: "203.0.113.9", disposition: "quarantine" }] });
      expect(delivery.find((row: { id: string }) => row.id === "t1")).toMatchObject({ status: "PASS", score: 100 });
      expect((await feed(key, `?listId=${encodeURIComponent(otherList.id)}`)).statusCode).toBe(404);

      const first = (await feed(key, `?listId=${encodeURIComponent(list.id)}`)).json();
      expect([first.contacts.length, first.pageSize]).toEqual([200, 200]);
      expect(Object.keys(first.contacts[0]).sort()).toEqual(["address", "createdAt", "health", "id", "name"]);
      expect((await feed(key, `?listId=${encodeURIComponent(list.id)}&offset=200`)).json().contacts).toHaveLength(5);

      // Newsletter archive and admin preview (plan vxtgxdSGE586 step 4): the mail for nobody in particular, defaults only, no footer or token;
      // the archive lists DONE campaigns whose mail needs no recipient's values; another sender's campaign stays out.
      const deal = (await repository.createTemplate({ ownerUserId: owner, name: "Deals", language: "el", paneId: null, fingerprint: "deals", madeBy: { by: "OPERATOR" },
        content: { subject: "Deals for {{name}}", preheader: "p", html: "<p>Hi {{name}}</p>", text: "Hi {{name}}", variables: [{ name: "name", default: "friend", required: false }], attachments: [] } })).template;
      const personal = (await repository.createTemplate({ ownerUserId: owner, name: "Personal", language: "el", paneId: null, fingerprint: "personal", madeBy: { by: "OPERATOR" },
        content: { subject: "For {{name}}", preheader: "", html: "<p>{{name}}</p>", text: "{{name}}", variables: [{ name: "name", default: null, required: true }], attachments: [] } })).template;
      const sent = await campaign("Deals", site.id, siteList.id, deal.id);
      const sentPersonal = await campaign("Personal", site.id, siteList.id, personal.id);
      for (const id of [sent.id, sentPersonal.id, otherCampaign.id]) await repository.updateCampaign(owner, id, { status: "DONE" });
      const archive = (await feed(key, "?archive=1")).json();
      expect(archive.campaigns).toEqual([{ id: sent.id, doneAt: expect.any(String), subject: "Deals for friend", preheader: "p", language: "el" }]);
      const html = (id: string) => feed(key, `?html=${encodeURIComponent(id)}`);
      expect((await html(sent.id)).json()).toMatchObject({ id: sent.id, status: "DONE", subject: "Deals for friend", html: "<p>Hi friend</p>" });
      expect((await html(siteCampaign.id)).json()).toMatchObject({ status: "DRAFT", doneAt: null });
      expect((await html(sentPersonal.id)).statusCode).toBe(404);
      expect((await html(otherCampaign.id)).statusCode).toBe(404);
      expect((await feed(key, "?archive=1", "192.0.2.111")).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("unsubscribes at once what a site's /u/ page passes on: public-host only, a token of this instance only, a repeat is fine (plan 16ji8NSSApw0 step 3)", async () => {
    const repository = new InMemoryMailCampaignsRepository();
    const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CONNECTOR_KEY_FILE: keyFile }), eventBus: new SpaceEventBus(), jobApplyMailTriage: false,
      marketingCopilotScheduler: false, mailCampaignsRepository: repository, auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
    try {
      const owner = "user:operator";
      const [contact] = await repository.upsertContacts(owner, [{ address: "reader@shop.gr", name: "", attributes: {} }]);
      const sender = await repository.createSender({ ownerUserId: owner, address: "info@unboxexpert.com", displayName: "UnboxExpert", domain: "unboxexpert.com",
        config: { route: "GMAIL_DELEGATED", subject: "info@unboxexpert.com", vaultKeyId: "vault_key:delegation1" }, replyTo: null, footerAddress: "UnboxExpert",
        status: "ACTIVE", warmup: { stage: 0, since: "2026-11-23T00:00:00.000Z" }, caps: { perMinute: 1, perDay: 500 }, bulk: true, bulkNote: null, createdBy: "test" });
      const template = (await repository.createTemplate({ ownerUserId: owner, name: "t", language: "el", paneId: null, fingerprint: "t", madeBy: { by: "OPERATOR" },
        content: { subject: "t", preheader: "", html: "", text: "t", variables: [], attachments: [] } })).template;
      const list = await repository.createList({ ownerUserId: owner, name: "UnboxExpert alerts", description: "", source: "CSV", consentBasis: "CONSENT" });
      const campaign = await repository.createCampaign({ ownerUserId: owner, paneId: null, name: "c", goal: "", templateId: template.id, templateVersion: 1, senderId: sender.id,
        listIds: [list.id], schedule: { startAt: null, timeZone: "Europe/Athens", days: [1], fromHour: 9, toHour: 18 }, pacing: { perMinute: 1, perDay: 300 }, testSeeds: [], track: false, createdBy: "test" });
      // The key wiring.ts derives from the connector key.
      const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("space-mail-campaigns"), Buffer.from("unsubscribe-token"), 32));
      const token = unsubscribeToken(key, campaign.id, contact!.id);
      const post = (payload: unknown, remoteAddress = "192.0.2.110") => app.inject({ method: "POST", url: "/api/public/mail/unsubscribe", remoteAddress, payload: payload as object });
      expect((await post({ token }, "192.0.2.111")).statusCode).toBe(403);
      expect(await repository.suppressedAmong(owner, ["reader@shop.gr"])).toEqual(new Set());
      expect((await post({ token: unsubscribeToken(Buffer.alloc(32, 1), campaign.id, contact!.id) })).statusCode).toBe(400);
      expect((await post({ token: 42 })).statusCode).toBe(400);
      const done = await post({ token });
      expect([done.statusCode, done.json()]).toEqual([200, { ok: true }]);
      expect((await repository.suppressedAmong(owner, ["reader@shop.gr"])).size).toBe(1);
      expect((await repository.getContact(owner, contact!.id))!.health).toBe("UNSUBSCRIBED");
      expect((await post({ token })).json()).toEqual({ ok: true });
      // "View in browser" (plan 2wiBJQwRzN8X step 4): public-host only, the mail of a SENT send only, never cached or indexed.
      const web = (value: string, remoteAddress = "192.0.2.110") => app.inject({ method: "GET", url: `/api/public/mail/web?token=${encodeURIComponent(value)}`, remoteAddress });
      expect((await web(token, "192.0.2.111")).statusCode).toBe(403);
      expect((await web("short")).statusCode).toBe(400);
      expect((await web(token)).statusCode).toBe(404);
      await repository.freezeAudience(owner, campaign.id, [{ contactId: contact!.id, address: contact!.address }]);
      await repository.updateSend(owner, campaign.id, contact!.id, { status: "SENT", sentAt: "2026-11-23T10:00:00.000Z" });
      const page = await web(token);
      expect([page.statusCode, page.headers["cache-control"], page.headers["x-robots-tag"], page.headers["content-type"]]).toEqual([200, "no-store", "noindex", "text/html; charset=utf-8"]);
      expect(page.body).toContain("https://unboxexpert.com/m/v/");
      expect(page.body).not.toContain("oll4.com");
    } finally {
      await app.close();
    }
  });
});
