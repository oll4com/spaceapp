import { describe, expect, it } from "vitest";
import {
  canonicalizeUserLinkUrl,
  createUserLinkRequestSchema,
  listUserLinksQuerySchema,
  updateUserLinkRequestSchema,
  userLinkSchema
} from "../src/index.js";

describe("user link contracts", () => {
  it("canonicalizes safe absolute URLs and omits fragments", () => {
    expect(canonicalizeUserLinkUrl(" https://Example.com/path#private ")).toBe("https://example.com/path");
    expect(() => canonicalizeUserLinkUrl("javascript:alert(1)")).toThrow();
    expect(() => canonicalizeUserLinkUrl("https://user:pass@example.com/")).toThrow();
    expect(() => canonicalizeUserLinkUrl("/relative")).toThrow();
  });

  it("requires HTTP links to open in a new tab", () => {
    expect(createUserLinkRequestSchema.parse({ title: "Local", url: "http://example.com", openMode: "NEW_TAB" }).url)
      .toBe("http://example.com/");
    expect(() => createUserLinkRequestSchema.parse({ title: "Local", url: "http://example.com", openMode: "EMBEDDED" })).toThrow();
  });

  it("keeps owner identity out of the public contracts", () => {
    const link = {
      id: "link:one", title: "Status", description: "Service status", url: "https://status.openai.com/",
      openMode: "NEW_TAB", category: "GENERAL", isQuick: false, sortOrder: 3,
      createdAt: "2026-07-16T08:00:00.000Z", updatedAt: "2026-07-16T08:00:00.000Z"
    };
    expect(userLinkSchema.parse(link)).toEqual(link);
    expect(() => userLinkSchema.parse({ ...link, ownerUserId: "user:other" })).toThrow();
  });

  it("validates partial updates and normalized list filters", () => {
    expect(updateUserLinkRequestSchema.parse({ isQuick: true })).toEqual({ isQuick: true });
    expect(() => updateUserLinkRequestSchema.parse({})).toThrow();
    expect(listUserLinksQuerySchema.parse({ q: " status ", category: "MUSIC_LIBRARY", isQuick: "true", page: "2", pageSize: "10" }))
      .toEqual({ q: "status", category: "MUSIC_LIBRARY", isQuick: true, page: 2, pageSize: 10 });
    expect(createUserLinkRequestSchema.parse({ url: "https://status.openai.com/" }).title).toBe("status.openai.com");
  });
});
