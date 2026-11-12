import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { googleRedirectUriFor } from "../src/auth.js";

const configured = "http://127.0.0.1:4911/api/auth/google/callback";
const auth = { googleRedirectUri: configured, secureCookies: true as const };
const request = (host: string) => ({ headers: { "x-forwarded-proto": "https", "x-forwarded-host": host, host: "127.0.0.1:4911" }, log: { warn: vi.fn() } });

describe("Google redirect URI follows the host the browser is on", () => {
  it("a clone with the main's copied URI returns to the clone, and warns once naming both", () => {
    const req = request("example.invalid");
    expect(googleRedirectUriFor(req as never, auth, 4911)).toBe("https://example.invalid/api/auth/google/callback");
    expect(req.log.warn).toHaveBeenCalledTimes(1);
    expect(req.log.warn.mock.calls[0]![0]).toEqual({ configuredOrigin: "http://127.0.0.1:4911", requestOrigin: "https://example.invalid" });
  });

  it("the configured host keeps its configured URI on any port (stable's :4911 and :443)", () => {
    for (const host of ["spaceapp.example", "spaceapp.example:4911"]) {
      const req = request(host);
      expect(googleRedirectUriFor(req as never, auth, 4911)).toBe(configured);
      expect(req.log.warn).not.toHaveBeenCalled();
    }
  });

  it("unset falls back to the request's origin", () => {
    expect(googleRedirectUriFor(request("example.invalid") as never, { secureCookies: true }, 4911)).toBe("https://example.invalid/api/auth/google/callback");
  });

  it("start and callback send Google the same URI", async () => {
    const app = await createApp({
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }),
      store: new InMemorySpaceStore(),
      auth: { sessionSecret: "test-secret-with-enough-length-123456", devLogin: false, googleClientId: "id", googleClientSecret: "secret", secureCookies: false, googleRedirectUri: configured }
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 400 }));
    try {
      const headers = { "x-forwarded-proto": "https", "x-forwarded-host": "example.invalid" };
      const start = await app.inject({ method: "GET", url: "/api/auth/google/start", headers });
      expect(start.statusCode).toBe(302);
      const startUri = new URL(start.headers.location as string).searchParams.get("redirect_uri");
      expect(startUri).toBe("https://example.invalid/api/auth/google/callback");
      const state = start.cookies.find((c) => c.name === "space_oauth_state")!.value;
      const pkce = start.cookies.find((c) => c.name === "space_oauth_pkce")!.value;
      await app.inject({ method: "GET", url: `/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
        headers: { ...headers, cookie: `space_oauth_state=${state}; space_oauth_pkce=${pkce}` } });
      const tokenCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("oauth2.googleapis.com/token"));
      expect(tokenCall, "the callback reached Google's token exchange").toBeDefined();
      expect(new URLSearchParams(String(tokenCall![1]!.body)).get("redirect_uri")).toBe(startUri);
    } finally {
      fetchSpy.mockRestore();
      await app.close();
    }
  }, 30_000);
});
