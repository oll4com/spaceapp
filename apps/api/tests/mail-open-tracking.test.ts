// Mail open tracking (operator orders 22/11: who opened it, from which IP, every time): each recipient's mail has its own token; the
// oll4.com relay posts each pixel fetch and click here; the operator reads each open and click with its IP, ISP, place, device and proxy.
import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { describeClient, mailProxy, trackedMailHtml, trackingRelay, trackingRelays } from "../src/mail-campaigns/open-tracking.js";
import { textToHtml } from "../src/mail-copilot/gmail-mime.js";

vi.setConfig({ testTimeout: 30_000 });
const relayAddress = { remoteAddress: "192.0.2.110" };

describe("mail open tracking", () => {
  it("builds a per-recipient pixel on the relay, leaves the text's links unwrapped, and records the relay's hits for the operator", async () => {
    expect(trackingRelay({ instance: "dev" }, {})).toBe("https://oll4.com/m/?i=dev");
    expect(trackingRelay({ instance: "stable", publicDistribution: true }, {})).toBeNull();
    expect(trackingRelays({ instance: "dev" }, {})).toEqual({ "unboxexpert.com": "https://unboxexpert.com/m/?i=dev" });
    expect(trackingRelays({ instance: "stable" }, { SPACE_MAIL_TRACKING_RELAYS: "a.example=https://a.example/m/, b.example = https://b.example/t/" }))
      .toEqual({ "a.example": "https://a.example/m/?i=stable", "b.example": "https://b.example/t/?i=stable" });
    expect(trackingRelays({ instance: "stable", publicDistribution: true }, {})).toEqual({});
    expect(() => trackingRelays({ instance: "dev" }, { SPACE_MAIL_TRACKING_RELAYS: "a.example=http://a.example/m/" })).toThrow(/domain=https/);

    const repository = new InMemoryMailCampaignsRepository();
    const lookup = vi.fn(async (ip: string) => ip === "66.249.1.1" ? { rdns: "google-proxy-66-249-1-1.google.com", isp: "AS15169 Google LLC", geo: null } : { rdns: null, isp: "AS1241 Forthnet", geo: "Athens, Attica, GR" });
    const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent" }), eventBus: new SpaceEventBus(), jobApplyMailTriage: false,
      marketingCopilotScheduler: false, mailCampaignsRepository: repository, mailOpenLookup: lookup, auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
      const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
      const me = (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json();
      const owner = (me.user ?? me).id as string;

      const relay = "https://oll4.com/m/?i=dev";
      const alice = await trackedMailHtml(repository, relay, { ownerUserId: owner, recipient: "alice@shop.gr", recipientName: "Alice", subject: "Hello", text: "Hi, see https://shop.gr/offer." });
      // Pixel only (operator 22/11 22:16): the text's link stays as written, nothing points at the relay but the pixel.
      expect(alice.html.startsWith(textToHtml("Hi, see https://shop.gr/offer."))).toBe(true);
      expect([alice.html.includes("&c="), alice.html.split("oll4.com").length - 1]).toEqual([false, 1]);
      expect(alice.html).toMatch(new RegExp(`<img src="https://oll4\\.com/m/\\?i=dev&o=${alice.token}" width="1"`));
      const bob = await trackedMailHtml(repository, relay, { ownerUserId: owner, recipient: "bob@shop.gr", recipientName: "", subject: "Hello", text: "No link." });
      expect(bob.token === alice.token).toBe(false);
      // A mail sent before pixel-only kept its wrapped link; its clicks still redirect.
      const earlier = "e".repeat(32);
      await repository.trackMessage({ token: earlier, ownerUserId: owner, recipient: "carol@shop.gr", recipientName: "Carol", subject: "Earlier", links: ["https://shop.gr/offer"] });

      const hit = (payload: object, extra = relayAddress) => app.inject({ method: "POST", url: "/api/public/mail/hit", ...extra, payload });
      // Only the relay posts hits; a bad body is refused and stores nothing.
      expect((await hit({ token: alice.token, kind: "open", ip: "1.2.3.4" }, { remoteAddress: "203.0.113.9" })).statusCode).toBe(403);
      expect((await hit({ token: "short", kind: "open" })).statusCode).toBe(400);
      expect((await hit({ token: alice.token, kind: "click" })).statusCode).toBe(400);
      expect((await hit({ token: alice.token, kind: "open", ip: "66.249.1.1", userAgent: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)", country: "US" })).json()).toEqual({ url: null });
      const click = await hit({ token: earlier, kind: "click", n: 0, ip: "94.65.1.2", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", country: "GR" });
      expect(click.json()).toEqual({ url: "https://shop.gr/offer" });
      // A pixel-only mail, a link the mail did not carry and an unknown token redirect nowhere.
      expect((await hit({ token: alice.token, kind: "click", n: 0, ip: "94.65.1.2" })).json()).toEqual({ url: null });
      expect((await hit({ token: earlier, kind: "click", n: 1, ip: "94.65.1.2" })).json()).toEqual({ url: null });
      expect((await hit({ token: "x".repeat(32), kind: "open", ip: "94.65.1.2" })).json()).toEqual({ url: null });
      await vi.waitFor(async () => expect((await repository.trackedMessages(owner)).find((message) => message.recipient === "carol@shop.gr")?.clicks[0]?.isp).toBe("AS1241 Forthnet"));

      expect((await app.inject({ method: "GET", url: "/api/mail-campaigns/opens" })).statusCode).toBe(401);
      const listed = (await app.inject({ method: "GET", url: "/api/mail-campaigns/opens", headers: { cookie } })).json().messages;
      expect(listed).toHaveLength(3);
      const opened = listed.find((message: { recipient: string }) => message.recipient === "alice@shop.gr");
      expect(opened).toMatchObject({ recipientName: "Alice", links: [], count: 1, clicks: [], firstOpenedAt: opened.opens[0].at });
      expect(opened.opens[0]).toMatchObject({ kind: "OPEN", ip: "66.249.1.1", client: "Gmail", proxy: "Google Image Proxy", isp: "AS15169 Google LLC", geo: "US", url: null });
      expect(listed.find((message: { recipient: string }) => message.recipient === "carol@shop.gr").clicks[0]).toMatchObject({ kind: "CLICK", ip: "94.65.1.2", client: "Safari", device: "iPhone", proxy: null, geo: "Athens, Attica, GR", url: "https://shop.gr/offer" });
      expect(listed.find((message: { recipient: string }) => message.recipient === "bob@shop.gr")).toMatchObject({ count: 0, opens: [], clicks: [] });

      // A campaign's tracked mails are named after it; the route filters by campaign and gives each campaign's totals (plan ES4AQEtVuDon step 2).
      const campaign = await repository.createCampaign({ ownerUserId: owner, paneId: null, name: "Kits offer", goal: "", templateId: "mtpl:abcdefgh", templateVersion: 1, senderId: "msender:abcdefgh",
        listIds: ["mlist:abcdefgh"], schedule: { startAt: null, timeZone: "Europe/Athens", days: [1], fromHour: 9, toHour: 18 }, pacing: { perMinute: 1, perDay: 300 }, testSeeds: [], track: true, createdBy: "test" });
      await repository.trackMessage({ token: "d".repeat(32), ownerUserId: owner, recipient: "dave@shop.gr", recipientName: "Dave", subject: "Kits", links: [], campaignId: campaign.id, contactId: "mcontact:dave1234" });
      const all = (await app.inject({ method: "GET", url: "/api/mail-campaigns/opens", headers: { cookie } })).json();
      expect([all.messages.length, all.messages.filter((message: { campaignId: string | null }) => message.campaignId === null).length]).toEqual([4, 3]);
      expect(all.campaigns).toMatchObject([{ id: campaign.id, name: "Kits offer", status: "DRAFT", stats: { unsubscribed: 0 } }]);
      const one = (await app.inject({ method: "GET", url: `/api/mail-campaigns/opens?campaignId=${campaign.id}`, headers: { cookie } })).json();
      expect(one.messages.map((message: { recipient: string }) => message.recipient)).toEqual(["dave@shop.gr"]);
      expect((await app.inject({ method: "GET", url: "/api/mail-campaigns/opens?campaignId=nope", headers: { cookie } })).statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });

  it("names the mail client, device and proxy a hit comes through", () => {
    expect(describeClient("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")).toEqual({ client: "Chrome", device: "Android" });
    expect(describeClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toEqual({ client: "Apple Mail", device: "Mac" });
    expect(describeClient(null)).toEqual({ client: null, device: null });
    expect(mailProxy("Mozilla/5.0", null, null)).toBe("Apple Mail Privacy");
    expect(mailProxy("x", "mail-sor-f41.outlook.com", null)).toBe("Outlook proxy");
    expect(mailProxy("Mozilla/5.0 (iPhone)", "ppp.forthnet.gr", "AS1241 Forthnet")).toBeNull();
  });
});
