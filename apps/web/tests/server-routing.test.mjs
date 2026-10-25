import { describe, expect, it } from "vitest";
import {
  localAppSecurityHeadersForRoute,
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

describe("localAppSecurityHeadersForRoute", () => {
  it("applies the complete loopback-safe contract to non-homepage HTML routes", () => {
    const headers = localAppSecurityHeadersForRoute("/rooms/example", ".html");

    expect(headers["content-security-policy"]).toBe(
      "base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
    );
    expect(headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["strict-transport-security"]).toBeUndefined();
  });
});
