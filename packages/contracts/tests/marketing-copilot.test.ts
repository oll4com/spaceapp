import { describe, expect, it } from "vitest";
import {
  createPaneInputSchema, defaultMarketingCopilotPaneMetadata, effectiveMarketingAutonomy, MARKETING_CHANNELS, marketingCopilotPaneMetadataSchema,
  marketingUrlMatchesChannel, resolveMarketingCopilotPaneMetadata, roomPaneBatchItemSchema, userSettingsSchema
} from "../src/index.js";

describe("Marketing Copilot contracts", () => {
  it("reads unconfigured panes as Assist with every channel on and the self-promotion-sensitive ones capped", () => {
    const metadata = defaultMarketingCopilotPaneMetadata();
    expect(metadata.settings).toMatchObject({ autonomy: "ASSIST", paused: false, releaseCampaigns: true, notifications: { needsYou: true, published: true, telegram: false } });
    expect(Object.keys(metadata.settings.channels)).toEqual([...MARKETING_CHANNELS]);
    expect(MARKETING_CHANNELS.filter((channel) => metadata.settings.channels[channel].autonomyCap === "ASSIST")).toEqual(["REDDIT", "HACKER_NEWS", "PRODUCT_HUNT"]);
    expect(resolveMarketingCopilotPaneMetadata(null)).toEqual(metadata);
    // Defaults are fresh objects: changing one pane's settings never changes another's.
    metadata.settings.channels.X.posts = 9;
    expect(defaultMarketingCopilotPaneMetadata().settings.channels.X.posts).toBe(3);
  });

  it("validates channels, caps and limits, and keeps the CLI account out of the row", () => {
    const parsed = marketingCopilotPaneMetadataSchema.parse({ version: 1, settings: { autonomy: "FULL", channels: { X: { enabled: false, autonomyCap: "RULES", posts: 5, perDays: 2 } } },
      view: { postId: "mktpost:abc123", updatedAt: "2026-10-14T10:00:00.000Z" } });
    expect(parsed.settings.channels.X).toEqual({ enabled: false, autonomyCap: "RULES", posts: 5, perDays: 2 });
    expect(parsed.settings.channels.LINKEDIN.enabled).toBe(true);
    expect(parsed.view).toMatchObject({ campaignId: null, postId: "mktpost:abc123" });
    expect(marketingCopilotPaneMetadataSchema.safeParse({ version: 1, settings: { channels: { MASTODON: {} } } }).success).toBe(false);
    expect(marketingCopilotPaneMetadataSchema.safeParse({ version: 1, settings: { channels: { X: { enabled: true, autonomyCap: "FULL", posts: 99, perDays: 1 } } } }).success).toBe(false);
    expect(marketingCopilotPaneMetadataSchema.safeParse({ version: 1, settings: {}, agent: { runtimeId: "cli:claude" } }).success).toBe(false);
    expect(marketingCopilotPaneMetadataSchema.safeParse({ version: 2, settings: {} }).success).toBe(false);
  });

  it("applies the lower of the pane's autonomy and the channel's cap", () => {
    const { settings } = marketingCopilotPaneMetadataSchema.parse({ version: 1, settings: { autonomy: "FULL", channels: { GITHUB: { enabled: true, autonomyCap: "RULES", posts: 3, perDays: 7 } } } });
    expect(effectiveMarketingAutonomy(settings, "X")).toBe("FULL");
    expect(effectiveMarketingAutonomy(settings, "GITHUB")).toBe("RULES");
    expect(effectiveMarketingAutonomy(settings, "HACKER_NEWS")).toBe("ASSIST");
    expect(effectiveMarketingAutonomy({ ...settings, autonomy: "ASSIST" }, "X")).toBe("ASSIST");
  });

  it("creates MARKETING_COPILOT panes with a CLI runtime and an account, like the other copilots", () => {
    expect(createPaneInputSchema.parse({ roomId: "room:test-1", title: "Marketing Copilot", mode: "MARKETING_COPILOT", terminalRuntimeId: "cli:claude" }).terminalRuntimeId).toBe("cli:claude");
    expect(roomPaneBatchItemSchema.parse({ mode: "MARKETING_COPILOT", terminalRuntimeId: "cli:claude", accountProfileId: "space-gateway" }))
      .toEqual({ mode: "MARKETING_COPILOT", terminalRuntimeId: "cli:claude", accountProfileId: "space-gateway" });
    expect(roomPaneBatchItemSchema.safeParse({ mode: "MARKETING_COPILOT", cwd: "/root" }).success).toBe(false);
    expect(userSettingsSchema.parse({ marketingCopilot: { runtimeId: "cli:codex" } }).marketingCopilot).toEqual({ runtimeId: "cli:codex", accountProfileId: null, askOnLaunch: false });
  });
});

describe("Marketing Copilot evidence and wording", () => {
  it("accepts only https pages of the post's channel as publication evidence", () => {
    expect(marketingUrlMatchesChannel("https://old.reddit.com/r/selfhosted/comments/abc", "REDDIT")).toBe(true);
    expect(marketingUrlMatchesChannel("https://twitter.com/spaceapp/status/1", "X")).toBe(true);
    expect(marketingUrlMatchesChannel("https://news.ycombinator.com/item?id=1", "HACKER_NEWS")).toBe(true);
    expect(marketingUrlMatchesChannel("https://reddit.com.evil.io/r/x", "REDDIT")).toBe(false);
    expect(marketingUrlMatchesChannel("https://user:pass@github.com/oll4com/spaceapp", "GITHUB")).toBe(false);
    expect(marketingUrlMatchesChannel("http://dev.to/spaceapp/post", "DEVTO")).toBe(false);
    expect(marketingUrlMatchesChannel("not a url", "X")).toBe(false);
  });

  // The same wording rules as scripts/check-public-claims.mjs (not in the public tree): marketing-claims-parity.test.ts.
});
