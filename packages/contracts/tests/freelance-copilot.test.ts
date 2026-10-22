import { describe, expect, it } from "vitest";
import {
  cliEgressRouteIdSchema, createPaneInputSchema, defaultFreelanceCopilotPaneMetadata, effectiveFreelanceAutonomy, FREELANCE_CHANNELS, FREELANCE_EGRESS_ROUTES, freelanceChannelEgress,
  freelanceChannelOfSender, freelanceCopilotPaneMetadataSchema, freelanceEgressPac,
  freelanceScamSignals, freelanceUrlMatchesChannel, freelanceWordingIssues, NOTIFICATION_SOURCES, resolveFreelanceCopilotPaneMetadata, roomPaneBatchItemSchema, userSettingsSchema
} from "../src/index.js";

describe("Freelance Copilot contracts", () => {
  it("reads unconfigured panes as fully autonomous with every channel on (operator decision 2026-10-14)", () => {
    const metadata = defaultFreelanceCopilotPaneMetadata();
    expect(metadata.settings).toMatchObject({ autonomy: "FULL", paused: false, rateFloorHourly: 35, followUps: true, browserEgress: "thailand",
      connectsBudget: { perDay: 120, perMonth: 2000 }, notifications: { needsYou: true, clientReady: true, telegram: true } });
    expect(Object.keys(metadata.settings.channels)).toEqual([...FREELANCE_CHANNELS]);
    expect(FREELANCE_CHANNELS.every((channel) => metadata.settings.channels[channel].enabled && metadata.settings.channels[channel].autonomyCap === "FULL")).toBe(true);
    expect(resolveFreelanceCopilotPaneMetadata(null)).toEqual(metadata);
    // Defaults are fresh objects: changing one pane's settings never changes another's.
    metadata.settings.channels.UPWORK.dailyCap = 1;
    expect(defaultFreelanceCopilotPaneMetadata().settings.channels.UPWORK.dailyCap).toBe(20);
  });

  it("validates the metadata strictly and applies the lower of pane and channel autonomy", () => {
    const { settings } = freelanceCopilotPaneMetadataSchema.parse({ version: 1, settings: { autonomy: "RULES", channels: { FIVERR: { enabled: true, autonomyCap: "ASSIST", dailyCap: 5 } } } });
    expect(effectiveFreelanceAutonomy(settings, "UPWORK")).toBe("RULES");
    expect(effectiveFreelanceAutonomy(settings, "FIVERR")).toBe("ASSIST");
    expect(freelanceCopilotPaneMetadataSchema.safeParse({ version: 1, settings: { channels: { FREELANCER: {} } } }).success).toBe(false);
    expect(freelanceCopilotPaneMetadataSchema.safeParse({ version: 1, settings: { browserEgress: "iceland" } }).success).toBe(false);
    expect(freelanceCopilotPaneMetadataSchema.safeParse({ version: 1, settings: {}, agent: { runtimeId: "cli:claude" } }).success).toBe(false);
  });

  it("flags off-platform contact, outside links, unqualified claims and bids under the floor before a contract", () => {
    const base = { channel: "UPWORK" as const, contracted: false };
    expect(freelanceWordingIssues("I built SpaceApp (https://spaceapp.dev) and https://github.com/oll4com/spaceapp; see https://www.upwork.com/freelancers/x.", base)).toEqual([]);
    expect(freelanceWordingIssues("Write me at dev@example.invalid", base)).toContain("email-address");
    expect(freelanceWordingIssues("Call +66 81 234 5678", base)).toContain("phone-number");
    expect(freelanceWordingIssues("Ping me on Telegram", base)).toContain("messenger");
    // "Telegram bot" is the product of offer (a); every way to reach us off the platform stays refused.
    expect(freelanceWordingIssues("A 24/7 agent with a Telegram bot that answers only you; Telegram bots for teams too. Built with @opencode/cli.", base)).toEqual([]);
    expect(freelanceWordingIssues("Message me on Telegram about the Telegram bot", base)).toContain("messenger");
    expect(freelanceWordingIssues("My Telegram bot is @nick_dev42, write there", base)).toContain("messenger-handle");
    expect(freelanceWordingIssues("Telegram bot demo: t.me/nickdev_bot", base)).toContain("messenger-link");
    expect(freelanceWordingIssues("Telegram bot, or call me on WhatsApp", base)).toContain("messenger");
    expect(freelanceWordingIssues("Details at https://example.com/x", base)).toContain("outside-link");
    expect(freelanceWordingIssues("See https://example.invalid/work and https://gist.github.com/x", base)).toEqual([]);
    expect(freelanceWordingIssues("Demo at http://127.0.0.1:4911/x", base)).toContain("outside-link");
    expect(freelanceWordingIssues("A seamless integration", base)).toContain("seamless");
    expect(freelanceWordingIssues("Ping me on Telegram", { ...base, contracted: true })).toEqual([]);
    expect(freelanceWordingIssues("Fixed price, two milestones.", { ...base, bid: { type: "HOURLY", amount: 30 } })).toEqual(["below-rate-floor"]);
    expect(freelanceWordingIssues("Budget $1,500 for 1.2M products and 150 000 calls", { ...base, bid: { type: "FIXED", amount: 20 } })).toEqual([]);
  });

  it("recognises scam signals, platform URLs and the platform a mail comes from", () => {
    expect(freelanceScamSignals("Contact me on WhatsApp. Unpaid test task first.")).toEqual(["move-to-messenger", "unpaid-test"]);
    expect(freelanceScamSignals("We pay in crypto only")).toEqual(["crypto-only"]);
    expect(freelanceScamSignals("Build an MCP server for our Shopify store, $2,000 fixed.")).toEqual([]);
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
    const pac = freelanceEgressPac(settings)!;
    const FindProxyForURL = new Function("dnsDomainIs", `${pac}; return FindProxyForURL;`)((host: string, domain: string) => host.endsWith(domain)) as (url: string, host: string) => string;
    expect(FindProxyForURL("https://www.upwork.com/nx/find-work/", "www.upwork.com")).toBe("SOCKS5 10.254.244.2:1080");
    expect(FindProxyForURL("https://upworkstatic.com/x.js", "upworkstatic.com")).toBe("SOCKS5 10.254.244.2:1080");
    expect(FindProxyForURL("https://notupwork.com/", "notupwork.com")).toBe("DIRECT");
    expect(FindProxyForURL("https://contra.com/", "contra.com")).toBe("DIRECT");
    expect(pac).not.toContain("; DIRECT");
    const thailand = freelanceEgressPac(defaultFreelanceCopilotPaneMetadata().settings)!;
    const viaThailand = new Function("dnsDomainIs", `${thailand}; return FindProxyForURL;`)((host: string, domain: string) => host.endsWith(domain)) as (url: string, host: string) => string;
    expect(viaThailand("https://www.google.com/", "www.google.com")).toBe("SOCKS5 10.254.242.2:1080");
    expect(viaThailand("http://localhost:4911/", "localhost")).toBe("DIRECT");
    expect(freelanceEgressPac({ ...settings, channels: { ...settings.channels, UPWORK: { ...settings.channels.UPWORK, egress: "pane" } } })).toBeNull();
  });
});
