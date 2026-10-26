import { describe, expect, it } from "vitest";
import { buildBrowserEvidenceTargetUrl } from "../src/browser-evidence.js";

describe("browser evidence target origin", () => {
  it("allows the canonical Space hostname and strips path/query/hash/userinfo", () => {
    // One host constant, so the public export rewrites the input and the expectation the same way (review F18).
    const spaceHost = "spaceapp.example";
    expect(buildBrowserEvidenceTargetUrl(`https://user:pw@${spaceHost}:4911/room?q=raw#frag`)).toBe(`https://${spaceHost}:4911/`);
  });

  it("rejects arbitrary non-Space hosts", () => {
    expect(() => buildBrowserEvidenceTargetUrl("https://example.com/")).toThrow(/BROWSER_TARGET_BLOCKED|restricted/i);
  });
});
