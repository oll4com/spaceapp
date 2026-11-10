// Mail Campaigns (plan clipboard:IJ2ovfLg1Lbw, step 3): templates (cleaned for sending, versioned, fingerprinted), lists, contacts, imports
// and suppressions through the operator routes and every CLI pane's bridge; only a person lifts a suppression or relabels a list's consent.
import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { InMemoryMailCampaignsRepository } from "@space/db";
import Fastify from "fastify";
import { createApp } from "../src/app.js";
import { registerMailCampaignsAgentRoutes } from "../src/mail-campaigns/routes.js";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { contactsFromCsv, contactsFromText, parseCsv } from "../src/mail-campaigns/import.js";
import { sanitizeTemplateHtml } from "../src/mail-campaigns/template-html.js";

vi.setConfig({ testTimeout: 30_000 });

describe("template HTML and imports", () => {
  it("keeps e-mail structure and drops what loads or runs anything", () => {
    const html = sanitizeTemplateHtml(`<table width="600" style="background:#fff"><tr><td style="color:red; background:url(http://x.example/a.png); width: expression(alert(1))">Hi {{firstName}}</td></tr></table>
      <script>alert(1)</script><a href="javascript:alert(1)">x</a><a href="https://example.invalid/?utm=1">Shop</a><img src="https://example.invalid/p.jpg" width="300"><img src="https://t.example/o.gif" width="1" height="1">
      <img src="http://example.invalid/insecure.jpg"><form><input></form><iframe src="https://x.example"></iframe><div onclick="x()" style="display:block">ok</div>`);
    expect(html).toContain("Hi {{firstName}}");
    expect(html).toContain('style="color:red"');
    expect(html).not.toMatch(/script|javascript:|expression|url\(|onclick|iframe|<form|<input|t\.example|insecure/);
    expect(html).toContain('<a href="https://example.invalid/?utm=1" target="_blank">Shop</a>');
    expect(html).toContain('<img src="https://example.invalid/p.jpg" width="300" />');
  });
  it("reads CSV with a header, quotes and semicolons, free text and refuses what is not an address", () => {
    expect(parseCsv('a;"b ""c""";d\r\n1;"line\nbreak";3\n')).toEqual([["a", "b \"c\"", "d"], ["1", "line\nbreak", "3"]]);
    const parsed = contactsFromCsv("Email;First name;Last name;City\nAlice@Shop.gr;Alice;A;Athens\nbad;X;Y;Z\nalice@shop.gr;dup;;\nbob@shop.gr;;;Patra\n");
    expect(parsed).toEqual({ invalid: 1, duplicates: 1, contacts: [
      { address: "alice@shop.gr", name: "Alice A", attributes: { city: "Athens" } }, { address: "bob@shop.gr", name: "", attributes: { city: "Patra" } }] });
    expect(contactsFromCsv("x@shop.gr,X\ny@shop.gr,Y\n").contacts.map((row) => row.address)).toEqual(["x@shop.gr", "y@shop.gr"]);
    expect(() => contactsFromCsv("name,city\nA,B\n")).toThrow(/e-mail column/);
    expect(contactsFromText('Write to "Info Desk" <info@example.invalid>, sales@example.invalid. or nobody@').contacts).toEqual([
      { address: "info@example.invalid", name: "Info Desk", attributes: {} }, { address: "sales@example.invalid", name: "", attributes: {} }]);
  });
});

async function fixture() {
  const config = getApiConfig({ SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-mail-campaigns-tests", SPACE_LOG_LEVEL: "silent" });
  const store = new InMemorySpaceStore();
  const repository = new InMemoryMailCampaignsRepository();
  const app = await createApp({ store, config, eventBus: new SpaceEventBus(), jobApplyMailTriage: false, marketingCopilotScheduler: false, mailCampaignsRepository: repository,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Mail", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const agent = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: session.sessionId })!, "content-type": "application/json" };
  return { app, headers, agent, repository, pane, store };
}

/** An approved campaign the sender job paused (no sender or list needed: resume only flips the state). */
async function pausedCampaign(repository: InMemoryMailCampaignsRepository, owner: string) {
  const row = await repository.createCampaign({ ownerUserId: owner, paneId: null, name: "Wave 2", goal: "", templateId: "mtpl:aaaaaaaa", templateVersion: 1, senderId: "msender:aaaaaaaa",
    listIds: [], schedule: { startAt: null, timeZone: "Europe/Athens", days: [1, 2, 3, 4, 5], fromHour: 9, toHour: 18 }, pacing: { perMinute: 1, perDay: 90 }, testSeeds: [], createdBy: "test" });
  await repository.updateCampaign(owner, row.id, { status: "PAUSED", pauseReason: "the sender job failed: timeout exceeded when trying to connect",
    approval: { fingerprint: "f".repeat(64), at: new Date().toISOString(), by: owner, via: "RAIL", decisionId: null } });
  return row.id;
}

describe("Mail Campaigns routes", () => {
  it("serves templates, lists, imports and suppressions to the operator and to every CLI pane", async () => {
    const { app, headers, agent, pane } = await fixture();
    try {
      const api = "/api/mail-campaigns";
      const cli = "/api/cli/mail-campaigns";
      expect((await app.inject({ method: "GET", url: `${api}/lists` })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: `${cli}/lists` })).statusCode).toBe(401);

      // An agent's template: cleaned, fingerprinted, made by the agent; an undeclared variable is refused.
      const refused = await app.inject({ method: "POST", url: `${cli}/templates`, headers: agent, payload: { name: "Kits", language: "el", subject: "Γεια {{firstName}}", html: "<p>Hi</p>", text: "Hi", madeByModel: "claude-opus-5-5" } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain("{{firstName}}");
      const created = (await app.inject({ method: "POST", url: `${cli}/templates`, headers: agent, payload: { name: "Kits", language: "el", subject: "Γεια {{firstName}}",
        html: "<p>Hi {{firstName}}</p><script>x</script>", text: "Hi {{firstName}}", variables: [{ name: "firstName", default: "φίλε" }], madeByModel: "claude-opus-5-5" } })).json();
      expect(created.version).toMatchObject({ version: 1, html: "<p>Hi {{firstName}}</p>", madeBy: { by: "AGENT", runtime: "cli:codex", model: "claude-opus-5-5", paneId: pane.id } });
      expect(created.version.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      const templateUrl = `${api}/templates/${encodeURIComponent(created.template.id)}`;
      // The same content is no new version; a change is.
      expect((await app.inject({ method: "PATCH", url: templateUrl, headers, payload: { text: "Hi {{firstName}}" } })).json().version.version).toBe(1);
      const changed = (await app.inject({ method: "PATCH", url: templateUrl, headers, payload: { text: "Hello {{firstName}}" } })).json();
      expect(changed.version).toMatchObject({ version: 2, madeBy: { by: "OPERATOR" } });
      expect(changed.versions.map((row: { version: number }) => row.version)).toEqual([2, 1]);
      expect((await app.inject({ method: "POST", url: `${templateUrl}/preview`, headers, payload: { version: 1, values: {} } })).json()).toMatchObject({ subject: "Γεια φίλε", text: "Hi φίλε" });

      // Lists: an agent sets the consent basis once; only a person changes it.
      const list = (await app.inject({ method: "POST", url: `${cli}/lists`, headers: agent, payload: { name: "Buyers", consentBasis: "IMPORTED" } })).json().list;
      expect((await app.inject({ method: "POST", url: `${api}/lists`, headers, payload: { name: "buyers", consentBasis: "CONSENT" } })).statusCode).toBe(409);
      const listCli = `${cli}/lists/${encodeURIComponent(list.id)}`;
      const listApi = `${api}/lists/${encodeURIComponent(list.id)}`;
      expect((await app.inject({ method: "PATCH", url: listCli, headers: agent, payload: { consentBasis: "CONSENT" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "PATCH", url: listApi, headers, payload: { consentBasis: "CUSTOMER" } })).json().list.consentBasis).toBe("CUSTOMER");

      // Suppressions apply on import; invalid and duplicate rows are counted.
      expect((await app.inject({ method: "POST", url: `${cli}/suppressions`, headers: agent, payload: { source: "kits-suppression.csv", items: [{ pattern: "@blocked.gr", reason: "DO_NOT_CONTACT" }, { pattern: "nope", reason: "MANUAL" }] } })).json())
        .toEqual({ added: 1, alreadySuppressed: 0, invalid: 1 });
      const imported = (await app.inject({ method: "POST", url: `${listCli}/import`, headers: agent, payload: { csv: "email,name\nalice@shop.gr,Alice\nbob@blocked.gr,Bob\nbad,X\nalice@shop.gr,again\ncarol@shop.gr,\n" } })).json();
      expect(imported).toEqual({ received: 5, invalid: 1, duplicates: 1, suppressed: 1, added: 2, alreadyMembers: 0 });
      expect((await app.inject({ method: "POST", url: `${listCli}/import`, headers: agent, payload: { text: "alice@shop.gr dave@shop.gr" } })).json()).toMatchObject({ added: 1, alreadyMembers: 1 });
      const health = (await app.inject({ method: "GET", url: listApi, headers })).json().health;
      expect(health).toMatchObject({ members: 3, byHealth: { UNKNOWN: 3 }, suppressed: 0, sendable: 3 });
      const members = (await app.inject({ method: "GET", url: `${listCli}/contacts?health=UNKNOWN&limit=2`, headers: agent })).json().contacts;
      expect(members.map((row: { address: string }) => row.address)).toEqual(["alice@shop.gr", "carol@shop.gr"]);
      expect((await app.inject({ method: "GET", url: `${cli}/contacts/${encodeURIComponent("Alice@Shop.gr")}`, headers: agent })).json()).toMatchObject({ contact: { name: "Alice" }, suppressed: false, lastMailedAt: null });

      // Only a person lifts a suppression (no bridge route; proof sessions are refused by the person check).
      expect((await app.inject({ method: "DELETE", url: `${cli}/suppressions`, headers: agent, payload: { pattern: "@blocked.gr" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `${api}/suppressions`, headers, payload: { pattern: "@Blocked.gr" } })).json()).toEqual({ removed: true });
      // Warm-up stage and bulk: every agent sets them too (operator 2/11 15:01 BKK), and the sender's activity names who did.
      const sender = (await app.inject({ method: "POST", url: `${cli}/senders`, headers: agent, payload: { address: "someone@gmail.com", displayName: "Someone",
        footerAddress: "Someone, Athens", config: { route: "GMAIL_CONNECTOR", account: "someone@gmail.com" } } })).json().sender;
      expect(sender).toMatchObject({ bulk: false, warmup: { stage: 0 } });
      const senderCli = `${cli}/senders/${encodeURIComponent(sender.id)}`;
      expect((await app.inject({ method: "POST", url: `${senderCli}/warmup`, headers: agent, payload: { stage: 2 } })).json().sender.warmup.stage).toBe(2);
      expect((await app.inject({ method: "POST", url: `${senderCli}/bulk`, headers: agent, payload: { bulk: true } })).json().sender.bulk).toBe(true);
      expect((await app.inject({ method: "POST", url: `${api}/senders/${encodeURIComponent(sender.id)}/warmup`, headers, payload: { stage: 1 } })).json().sender.warmup.stage).toBe(1);
      const senderNotes = (await app.inject({ method: "GET", url: `${cli}/events?limit=50`, headers: agent })).json().events.map((row: { message: string }) => row.message);
      expect(senderNotes).toEqual(expect.arrayContaining([`Warm-up of someone@gmail.com set to stage 2 by pane:${pane.id}.`, `Bulk allowed for someone@gmail.com by pane:${pane.id}.`,
        "Warm-up of someone@gmail.com set to stage 1 by operator."]));

      const events = (await app.inject({ method: "GET", url: `${cli}/events?limit=20`, headers: agent })).json().events.map((row: { type: string }) => row.type);
      expect(events).toEqual(expect.arrayContaining(["IMPORT", "SUPPRESSION", "LIST", "NOTE"]));
    } finally { await app.close(); }
  });

  it("resumes a paused campaign for the operator; an agent only while \"May send to third parties\" is on (operator 2/11 15:01 BKK)", async () => {
    const { app, headers, agent, repository, pane, store } = await fixture();
    try {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      const id = await pausedCampaign(repository, owner);
      // Nous is off in this app, so the allowance does not cover it: the agent is refused and nothing moves.
      const refused = await app.inject({ method: "POST", url: `/api/cli/mail-campaigns/campaigns/${encodeURIComponent(id)}/resume`, headers: agent, payload: {} });
      expect(refused.statusCode).toBe(403);
      expect((await repository.getCampaign(owner, id))?.status).toBe("PAUSED");
      const resumed = await app.inject({ method: "POST", url: `/api/mail-campaigns/campaigns/${encodeURIComponent(id)}/resume`, headers, payload: {} });
      expect(resumed.json().campaign).toMatchObject({ status: "APPROVED", pauseReason: null });
      expect((await repository.listEvents(owner, { campaignId: id })).map((row) => row.message)).toContain("\"Wave 2\" resumed by the operator.");
    } finally { await app.close(); }
  });

  it("lets an agent's bridge resume a paused campaign while the allowance covers it, naming the pane", async () => {
    const owner = "user:operator";
    const repository = new InMemoryMailCampaignsRepository();
    const service = createMailCampaignsService({ repository, transports: null, campaigns: { unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null } } as never);
    const app = Fastify();
    let covers = true;
    const audits: unknown[] = [];
    registerMailCampaignsAgentRoutes(app, service, { routeOptions: {}, parseBody: (schema, body) => schema.parse(body), parseQuery: (schema, query) => schema.parse(query),
      store: { getRoom: async () => ({ id: "room:aaaaaaaa", ownerUserId: owner }), getPane: async () => ({ id: "pane:agentpane1" }) } as never,
      requireBridge: async () => ({ claims: { roomId: "room:aaaaaaaa", paneId: "pane:agentpane1" } as never, runtimeId: "cli:claude" }),
      audit: async (_request, action, targetId, metadata) => { audits.push({ action, targetId, metadata }); }, coversApproval: async () => covers });
    try {
      const id = await pausedCampaign(repository, owner);
      const url = `/api/cli/mail-campaigns/campaigns/${encodeURIComponent(id)}/resume`;
      covers = false;
      expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(403);
      covers = true;
      expect((await app.inject({ method: "POST", url, payload: {} })).json().campaign).toMatchObject({ status: "APPROVED" });
      expect(audits).toEqual([{ action: "mail_campaigns.campaign.resume", targetId: id, metadata: { by: "pane:agentpane1" } }]);
      expect((await repository.listEvents(owner, { campaignId: id }))[0]).toMatchObject({ type: "RESUMED", message: "\"Wave 2\" resumed by pane:agentpane1.",
        payload: { by: "pane:agentpane1", pauseReason: "the sender job failed: timeout exceeded when trying to connect" } });
    } finally { await app.close(); }
  });
});
