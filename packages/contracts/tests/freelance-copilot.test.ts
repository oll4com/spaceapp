import { describe, expect, it } from "vitest";
import {
  cliEgressRouteIdSchema, createPaneInputSchema, defaultFreelanceCopilotPaneMetadata, effectiveFreelanceAutonomy, FREELANCE_CHANNEL_LOGIN_URLS, FREELANCE_CHANNELS, FREELANCE_EGRESS_ROUTES, FREELANCE_SETTINGS_CHANNELS, freelanceChannelEgress,
  freelanceChannelSchema, freelanceChannelSettings,
  freelanceChannelOfSender, freelanceCopilotPaneMetadataSchema, freelanceEgressPac, browserRoutePac,
  freelanceOffPlatformIssues, freelanceScamSignals, freelanceUrlMatchesChannel, freelanceWordingIssues, NOTIFICATION_SOURCES, resolveFreelanceCopilotPaneMetadata, roomPaneBatchItemSchema, userSettingsSchema
} from "../src/index.js";

describe("Freelance Copilot contracts", () => {
  it("reads unconfigured panes as fully autonomous with every channel on (operator decision 2026-10-14)", () => {
    const metadata = defaultFreelanceCopilotPaneMetadata();
    expect(metadata.settings).toMatchObject({ autonomy: "FULL", paused: false, rateFloorHourly: 20, followUps: true, browserEgress: "thailand",
      connectsBudget: { perDay: 120, perMonth: 2000 }, notifications: { needsYou: true, clientReady: true, telegram: true } });
    expect(Object.keys(metadata.settings.channels)).toEqual([...FREELANCE_SETTINGS_CHANNELS]);
    expect(FREELANCE_CHANNELS.every((channel) => freelanceChannelSettings(metadata.settings, channel).enabled && freelanceChannelSettings(metadata.settings, channel).autonomyCap === "FULL")).toBe(true);
    expect(resolveFreelanceCopilotPaneMetadata(null)).toEqual(metadata);
    // Defaults are fresh objects: changing one pane's settings never changes another's.
    metadata.settings.channels.UPWORK.dailyCap = 1;
    expect(defaultFreelanceCopilotPaneMetadata().settings.channels.UPWORK.dailyCap).toBe(20);
  });

  it("takes Guru and PeoplePerHour as channels on their defaults (2/11, Cleo/Dana's GURU lead was refused)", () => {
    expect(freelanceChannelSchema.parse("GURU")).toBe("GURU");
    expect(freelanceChannelSchema.parse("PEOPLEPERHOUR")).toBe("PEOPLEPERHOUR");
    const { settings } = defaultFreelanceCopilotPaneMetadata();
    expect(freelanceChannelSettings(settings, "GURU")).toMatchObject({ enabled: true, autonomyCap: "FULL" });
    expect(effectiveFreelanceAutonomy(settings, "PEOPLEPERHOUR")).toBe("FULL");
    expect(freelanceUrlMatchesChannel("https://www.guru.com/work/detail/123", "GURU")).toBe(true);
  });

  it("takes the remote job boards as channels with labels, sign-in pages and hosts (23/11, Dana's leads were refused)", () => {
    const { settings } = defaultFreelanceCopilotPaneMetadata();
    for (const channel of ["WELLFOUND", "WEWORKREMOTELY", "REMOTEOK", "WORKINGNOMADS", "SUPERTEAM", "CRYPTOJOBSLIST"] as const) {
      expect(freelanceChannelSchema.parse(channel)).toBe(channel);
      expect(freelanceChannelSettings(settings, channel)).toMatchObject({ enabled: true, autonomyCap: "FULL" });
      expect(freelanceUrlMatchesChannel(FREELANCE_CHANNEL_LOGIN_URLS[channel], channel)).toBe(true);
    }
    expect(freelanceUrlMatchesChannel("https://earn.superteam.fun/listing/1", "SUPERTEAM")).toBe(true);
    expect(freelanceChannelOfSender("jobs@angel.co")).toBe("WELLFOUND");
  });

  it("validates the metadata strictly and applies the lower of pane and channel autonomy", () => {
    const { settings } = freelanceCopilotPaneMetadataSchema.parse({ version: 1, settings: { autonomy: "RULES", channels: { FIVERR: { enabled: true, autonomyCap: "ASSIST", dailyCap: 5 } } } });
    expect(effectiveFreelanceAutonomy(settings, "UPWORK")).toBe("RULES");
    expect(effectiveFreelanceAutonomy(settings, "FIVERR")).toBe("ASSIST");
    expect(freelanceCopilotPaneMetadataSchema.safeParse({ version: 1, settings: { channels: { FREELANCER: {} } } }).success).toBe(false);
    expect(freelanceCopilotPaneMetadataSchema.safeParse({ version: 1, settings: { browserEgress: "iceland" } }).success).toBe(false);
    expect(freelanceCopilotPaneMetadataSchema.safeParse({ version: 1, settings: {}, agent: { runtimeId: "cli:claude" } }).success).toBe(false);
  });

  it("flags off-platform contact, outside links, unqualified claims and bids under the floor", () => {
    const base = { channel: "UPWORK" as const };
    expect(freelanceWordingIssues("I built SpaceApp, an agent workspace in Node.js and ASP.NET; see https://www.upwork.com/freelancers/x and upwork.com/jobs/~01.", base)).toEqual([]);
    expect(freelanceWordingIssues("Write me at dev@brand.example", base)).toContain("email-address");
    expect(freelanceWordingIssues("Call +66 81 234 5678", base)).toContain("phone-number");
    expect(freelanceWordingIssues("Ping me on Telegram", base)).toContain("messenger");
    // "Telegram bot" is the product of offer (a); every way to reach us off the platform stays refused.
    expect(freelanceWordingIssues("A 24/7 agent with a Telegram bot that answers only you; Telegram bots for teams too. Built with @opencode/cli.", base)).toEqual([]);
    expect(freelanceWordingIssues("Message me on Telegram about the Telegram bot", base)).toContain("messenger");
    expect(freelanceWordingIssues("My Telegram bot is @nick_dev42, write there", base)).toContain("messenger-handle");
    expect(freelanceWordingIssues("Telegram bot demo: t.me/nickdev_bot", base)).toContain("messenger-link");
    expect(freelanceWordingIssues("Telegram bot, or call me on WhatsApp", base)).toContain("messenger");
    expect(freelanceWordingIssues("Details at https://example.com/x", base)).toContain("outside-link");
    expect(freelanceWordingIssues("A seamless integration", base)).toContain("seamless");
    expect(freelanceWordingIssues("I built a WhatsApp bot and a Discord bot like this.", base)).toEqual([]);
    expect(freelanceWordingIssues("Ping me on Telegram", base)).toContain("messenger");
    // Operator 14/11: the default floor is $20/h (volume until the first reviews); a pane's own floor still applies.
    expect(freelanceWordingIssues("Fixed price, two milestones.", { ...base, bid: { type: "HOURLY", amount: 19 } })).toEqual(["below-rate-floor"]);
    expect(freelanceWordingIssues("Fixed price, two milestones.", { ...base, bid: { type: "HOURLY", amount: 20 } })).toEqual([]);
    expect(freelanceWordingIssues("Fixed price, two milestones.", { ...base, bid: { type: "HOURLY", amount: 30 }, rateFloorHourly: 35 })).toEqual(["below-rate-floor"]);
    expect(freelanceWordingIssues("Budget $1,500 for 1.2M products and 150 000 calls", { ...base, bid: { type: "FIXED", amount: 20 } })).toEqual([]);
  });

  it("refuses every off-platform link and contact detail, bare or not (operator 2026-11-26, Upwork Policy Warning)", () => {
    // The 26/11 reply: LinkedIn, the owner's site, spaceapp.dev and GitHub, before any contract.
    const warned = "Profile: linkedin.com/in/nikolaos-x, site https://oll4.com, SpaceApp (spaceapp.dev), code github.com/oll4com/spaceapp.";
    expect(freelanceOffPlatformIssues(warned, "UPWORK")).toEqual(["outside-link"]);
    for (const link of ["www.loom.com/share/1", "https://npmjs.com/package/x", "gist.github.com/x", "SpaceApp.dev.", "https://space.brand.example:4911/x"])
      expect(freelanceOffPlatformIssues(`See ${link}`, "UPWORK"), link).toContain("outside-link");
    expect(freelanceOffPlatformIssues("Write me at dev@gmail.com or +30 694 123 4567", "FIVERR")).toEqual(expect.arrayContaining(["email-address", "phone-number", "outside-link"]));
    // Only the platform's own pages: an Upwork link is fine on Upwork, not on Fiverr.
    expect(freelanceOffPlatformIssues("My profile: https://www.upwork.com/freelancers/~01", "UPWORK")).toEqual([]);
    expect(freelanceOffPlatformIssues("My profile: https://www.upwork.com/freelancers/~01", "FIVERR")).toEqual(["outside-link"]);
    expect(freelanceOffPlatformIssues("Built with Node.js, Next.js, ASP.NET and Socket.IO; e.g. a CS-Cart store.", "UPWORK")).toEqual([]);
  });

  it("recognises scam signals, platform URLs and the platform a mail comes from", () => {
    expect(freelanceScamSignals("Contact me on WhatsApp. Unpaid test task first.")).toEqual(["move-to-messenger", "unpaid-test"]);
    expect(freelanceScamSignals("We pay in crypto only")).toEqual(["crypto-only"]);
    expect(freelanceScamSignals("Build an MCP server for our Shopify store, $2,000 fixed.")).toEqual([]);
    // Operator 14/11: a messenger as the product to build is no scam signal; a messenger as the way to talk still is.
    for (const post of ["Build a Telegram bot for our shop", "WhatsApp Business API integration with HubSpot", "Telegram mini app in React", "Need a WhatsApp chatbot (Twilio)", "telegram-bot developer"])
      expect(freelanceScamSignals(post), post).toEqual([]);
    expect(freelanceScamSignals("Build a Telegram bot. Send your portfolio on Telegram.")).toEqual(["move-to-messenger"]);
    expect(freelanceScamSignals("Add me on WhatsApp: details there")).toEqual(["move-to-messenger"]);
    expect(freelanceUrlMatchesChannel("https://www.upwork.com/nx/proposals/123", "UPWORK")).toBe(true);
    expect(freelanceUrlMatchesChannel("http://www.upwork.com/nx/proposals/123", "UPWORK")).toBe(false);
    expect(freelanceUrlMatchesChannel("https://upwork.com.evil.example/x", "UPWORK")).toBe(false);
    expect(freelanceUrlMatchesChannel("https://app.usebraintrust.com/jobs/1", "BRAINTRUST")).toBe(true);
    expect(freelanceChannelOfSender("donotreply@upwork.com")).toBe("UPWORK");
    expect(freelanceChannelOfSender("Fiverr <noreply@e.fiverr.com>")).toBe("FIVERR");
    expect(freelanceChannelOfSender("someone@example.com")).toBeNull();
  });

  it("creates FREELANCE_COPILOT panes with a CLI runtime and an account, and notifies as its own source", () => {
    expect(createPaneInputSchema.parse({ roomId: "room:test-1", title: "Freelance Copilot", mode: "FREELANCE_COPILOT", terminalRuntimeId: "cli:claude" }).terminalRuntimeId).toBe("cli:claude");
    expect(roomPaneBatchItemSchema.parse({ mode: "FREELANCE_COPILOT", terminalRuntimeId: "cli:codex" })).toEqual({ mode: "FREELANCE_COPILOT", terminalRuntimeId: "cli:codex" });
    expect(userSettingsSchema.parse({ freelanceCopilot: null }).freelanceCopilot).toBeNull();
    expect(NOTIFICATION_SOURCES).toContain("FREELANCE_COPILOT");
  });

  it("routes each platform through its VPN route by PAC, the rest through the pane's route, never falling back to direct", () => {
    expect([...FREELANCE_EGRESS_ROUTES]).toEqual(cliEgressRouteIdSchema.options);
    const { settings } = freelanceCopilotPaneMetadataSchema.parse({ version: 1, settings: { browserEgress: "direct", channels: { UPWORK: { enabled: true, egress: "nord", autonomyCap: "FULL", dailyCap: 5 } } } });
    expect(freelanceChannelEgress(settings, "UPWORK")).toBe("nord");
    expect(freelanceChannelEgress(settings, "CONTRA")).toBe("direct");
    const proxies = { greece: "10.20.1.2:1080", thailand: "10.20.2.2:1080", nord: "10.20.4.2:1080" };
    const pac = freelanceEgressPac(settings, proxies)!;
    const FindProxyForURL = new Function("dnsDomainIs", `${pac}; return FindProxyForURL;`)((host: string, domain: string) => host.endsWith(domain)) as (url: string, host: string) => string;
    expect(FindProxyForURL("https://www.upwork.com/nx/find-work/", "www.upwork.com")).toBe("SOCKS5 10.20.4.2:1080");
    expect(FindProxyForURL("https://upworkstatic.com/x.js", "upworkstatic.com")).toBe("SOCKS5 10.20.4.2:1080");
    expect(FindProxyForURL("https://notupwork.com/", "notupwork.com")).toBe("DIRECT");
    expect(FindProxyForURL("https://contra.com/", "contra.com")).toBe("DIRECT");
    expect(pac).not.toContain("; DIRECT");
    const thailand = freelanceEgressPac(defaultFreelanceCopilotPaneMetadata().settings, proxies)!;
    const viaThailand = new Function("dnsDomainIs", `${thailand}; return FindProxyForURL;`)((host: string, domain: string) => host.endsWith(domain)) as (url: string, host: string) => string;
    expect(viaThailand("https://www.google.com/", "www.google.com")).toBe("SOCKS5 10.20.2.2:1080");
    expect(viaThailand("http://localhost:4911/", "localhost")).toBe("DIRECT");
    expect(freelanceEgressPac({ ...settings, channels: { ...settings.channels, UPWORK: { ...settings.channels.UPWORK, egress: "pane" } } }, proxies)).toBeNull();
    // A route without a configured proxy fails closed instead of leaving from this server.
    expect(() => freelanceEgressPac(settings, {})).toThrow(/nord route has no SOCKS5 proxy/);
    expect(() => browserRoutePac("mullvad", proxies)).toThrow(/SPACE_VPN_SOCKS_PROXIES/);
    expect(browserRoutePac("direct", {})).toBeNull();
  });
});
