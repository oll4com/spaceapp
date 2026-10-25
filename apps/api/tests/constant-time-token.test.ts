import { describe, expect, it, vi } from "vitest";
import { secureTokenMatches } from "../src/security/constant-time-token.js";

describe("secureTokenMatches", () => {
  it("accepts only the exact bounded token", () => {
    expect(secureTokenMatches("expected-token", "expected-token")).toBe(true);
    expect(secureTokenMatches("expected-token", "expected-tokeN")).toBe(false);
    expect(secureTokenMatches("expected-token", "expected-token-extra")).toBe(false);
    expect(secureTokenMatches("expected-token", ["expected-token"])).toBe(true);
    expect(secureTokenMatches(null, "expected-token")).toBe(false);
  });

  it("rejects oversized values before allocating comparison buffers", () => {
    const oversized = "a".repeat(513);
    const oversizedUtf8 = "é".repeat(300);
    const bufferFrom = vi.spyOn(Buffer, "from");

    try {
      expect(secureTokenMatches(oversized, oversized)).toBe(false);
      expect(secureTokenMatches("expected-token", oversized)).toBe(false);
      expect(secureTokenMatches("expected-token", oversizedUtf8)).toBe(false);
      expect(
        bufferFrom.mock.calls.some(
          ([value]) =>
            typeof value === "string" && Buffer.byteLength(value, "utf8") > 512
        )
      ).toBe(false);
    } finally {
      bufferFrom.mockRestore();
    }
  });
});
