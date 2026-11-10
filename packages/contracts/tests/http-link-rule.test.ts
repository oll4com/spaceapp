import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "an HTTP link opens only in a new tab" is one business rule that the stored link and the create request
// share. This pins what each answers per scheme and open mode (message and path), so moving the rule changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const at = "2026-10-28T12:00:00.000Z";
const cases = [
  { name: "userLinkSchema", schema: contracts.userLinkSchema as Parse, base: { id: "link:link0001", title: "Docs", description: "", category: "GENERAL", isQuick: false, sortOrder: 0, createdAt: at, updatedAt: at } },
  { name: "createUserLinkRequestSchema", schema: contracts.createUserLinkRequestSchema as Parse, base: {} }
];

describe("links whose HTTP address opens only in a new tab", () => {
  for (const item of cases) {
    it(`${item.name}: an embedded HTTP link is refused at openMode, HTTPS and new-tab HTTP pass`, () => {
      const issues = (url: string, openMode: string) => item.schema.safeParse({ ...item.base, url, openMode }).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
      expect(issues("http://example.com/", "EMBEDDED")).toEqual([["HTTP links can only open in a new tab.", ["openMode"]]]);
      expect(issues("http://example.com/", "NEW_TAB")).toEqual([]);
      expect(issues("https://example.com/", "EMBEDDED")).toEqual([]);
    });
  }
  it("createUserLinkRequestSchema: an HTTP link without an open mode takes EMBEDDED and is refused", () => {
    expect(contracts.createUserLinkRequestSchema.safeParse({ url: "http://example.com/" }).error?.issues.map((issue) => [issue.message, issue.path])).toEqual([["HTTP links can only open in a new tab.", ["openMode"]]]);
  });
});
