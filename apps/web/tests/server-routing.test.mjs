import { describe, expect, it } from "vitest";
import { resolveLegacyAppRedirect } from "../server-routing.mjs";

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
