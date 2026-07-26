import { describe, expect, it } from "vitest";
import {
  localAppSecurityHeaders,
  resolveLegacyAppRedirect
} from "../server-routing.mjs";

describe("resolveLegacyAppRedirect", () => {
  it("redirects legacy app GET and HEAD requests to a fixed same-origin path", () => {
    expect(resolveLegacyAppRedirect("/app", "GET")).toBe("/");
    expect(resolveLegacyAppRedirect("/app/", "HEAD")).toBe("/");
  });

  it("does not reflect attacker-controlled query data into the Location header", () => {
    expect(
      resolveLegacyAppRedirect(
        "/app?next=https://attacker.example/%0d%0aX-Test:injected",
        "GET"
      )
    ).toBe("/");
  });

  it("does not redirect unrelated paths or mutation requests", () => {
    expect(resolveLegacyAppRedirect("/", "GET")).toBeNull();
    expect(resolveLegacyAppRedirect("/app", "POST")).toBeNull();
  });
});

describe("localAppSecurityHeaders", () => {
  it("prevents framing and referrer leakage without requiring HTTPS on loopback", () => {
    const headers = localAppSecurityHeaders();

    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["strict-transport-security"]).toBeUndefined();
  });
});
