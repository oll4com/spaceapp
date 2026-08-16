import { describe, expect, it } from "vitest";
import { createAgentPostToken, verifyAgentPostToken } from "../auth.js";

describe("agent post token", () => {
  it("verifies a valid token for the exact payload", () => {
    const secret = "test-secret-at-least-16-chars";
    const payload = "DeepSeek CLI 19\ncli:deepseek\nκαλημέρα";
    const token = createAgentPostToken(secret, payload);
    expect(token).toBeTruthy();
    expect(verifyAgentPostToken(secret, token, payload)).toBe(true);
  });

  it("rejects tampered payloads and foreign tokens", () => {
    const secret = "test-secret-at-least-16-chars";
    const payload = "DeepSeek CLI 19\ncli:deepseek\nκαλημέρα";
    const token = createAgentPostToken(secret, payload);
    expect(verifyAgentPostToken(secret, token, "DeepSeek CLI 19\ncli:deepseek\nπαραλλαγή")).toBe(false);
    expect(verifyAgentPostToken(secret, "nonsense-token", payload)).toBe(false);
    expect(verifyAgentPostToken("another-secret-value-here", token, payload)).toBe(false);
  });

  it("returns null for a short secret", () => {
    expect(createAgentPostToken("short", "x")).toBeNull();
  });
});
