import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedSystemAnalytics } from "./owned-system-analytics.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

const ownedRoots: string[] = [];
const openApps: Array<Awaited<ReturnType<typeof createApp>>> = [];

async function publicApp(store = new InMemorySpaceStore(), config?: ReturnType<typeof getApiConfig>) {
  const analyticsRoot = await mkdtemp(join(tmpdir(), "space-waitlist-analytics-"));
  ownedRoots.push(analyticsRoot);
  const app = await createApp({
    systemAnalyticsService: ownedSystemAnalytics(store, analyticsRoot),
    store,
    ...(config ? { config } : {}),
    auth: {
      sessionSecret: "public-waitlist-test-secret",
      devLogin: false,
      secureCookies: false
    }
  });
  openApps.push(app);
  return { app, store };
}

afterEach(async () => {
  try {
    await Promise.all(openApps.splice(0).map((app) => app.close()));
  } finally {
    await Promise.all(ownedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
});

describe("POST /api/public/waitlist", () => {
  it("is explicitly public, normalizes input, and gives created and duplicate the same response", async () => {
    const { app, store } = await publicApp();
    const upsert = vi.spyOn(store, "upsertPublicWaitlistSignup");

    const created = await app.inject({
      method: "POST",
      url: "/api/public/waitlist",
      payload: { email: "  Person@Example.COM  ", consent: true }
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/public/waitlist",
      payload: { email: "person@example.com", consent: true, source: "HOMEPAGE" }
    });

    expect(created.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(created.json()).toEqual({ status: "ACCEPTED" });
    expect(duplicate.json()).toEqual({ status: "ACCEPTED" });
    expect(upsert).toHaveBeenNthCalledWith(1, { email: "person@example.com", source: "HOMEPAGE" });
    expect(upsert.mock.results.map((result) => result.value)).toEqual(["CREATED", "DUPLICATE"]);
  });

  it("accepts honeypot submissions generically without storing them", async () => {
    const { app, store } = await publicApp();
    const upsert = vi.spyOn(store, "upsertPublicWaitlistSignup");

    const response = await app.inject({
      method: "POST",
      url: "/api/public/waitlist",
      payload: {
        email: "bot@example.com",
        consent: true,
        website: "https://spam.example"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "ACCEPTED" });

    const maximumEmail = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    const boundaryResponse = await app.inject({
      method: "POST",
      url: "/api/public/waitlist",
      payload: {
        email: maximumEmail,
        consent: true,
        website: "\u0000".repeat(200)
      }
    });
    expect(maximumEmail).toHaveLength(254);
    expect(boundaryResponse.statusCode).toBe(202);
    expect(boundaryResponse.json()).toEqual({ status: "ACCEPTED" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("uses the existing structured 422 response for invalid requests", async () => {
    const { app } = await publicApp();

    for (const payload of [
      { email: "invalid", consent: true },
      { email: "person@example.com", consent: false },
      { email: "person@example.com", consent: true, extra: "forged" }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/public/waitlist", payload });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request data.",
          requestId: expect.stringMatching(/^req:/)
        }
      });
    }
  });

  it("rejects oversized request bodies before validation or persistence", async () => {
    const { app, store } = await publicApp();
    const upsert = vi.spyOn(store, "upsertPublicWaitlistSignup");
    const response = await app.inject({
      method: "POST",
      url: "/api/public/waitlist",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        email: "oversized@example.com",
        consent: true,
        website: "x".repeat(2_048)
      })
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: {
        code: "HTTP_ERROR",
        requestId: expect.stringMatching(/^req:/)
      }
    });
    expect(response.body).not.toContain("oversized@example.com");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("sanitizes persistence failures and emits only a bounded failure outcome", async () => {
    const { app, store } = await publicApp();
    const rawEmail = "private-failure@example.com";
    vi.spyOn(store, "upsertPublicWaitlistSignup").mockRejectedValue(
      new Error(`database failure for ${rawEmail}`)
    );
    const warn = vi.fn();
    const error = vi.fn();
    app.addHook("preHandler", async (request) => {
      request.log.warn = warn;
      request.log.error = error;
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/public/waitlist",
      payload: { email: rawEmail, consent: true }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        requestId: expect.stringMatching(/^req:/)
      }
    });
    expect(response.body).not.toContain(rawEmail);
    expect(warn).toHaveBeenCalledWith(
      { event: "public.waitlist.submission", outcome: "FAILED" },
      "Public waitlist submission failed."
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(rawEmail);
    expect(error).not.toHaveBeenCalled();
  });

  it("rate limits each client IP to five attempts per hour", async () => {
    const { app } = await publicApp();
    const responses = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/api/public/waitlist",
        headers: { "x-forwarded-for": "198.51.100.40" },
        payload: { email: "person@example.com", consent: true }
      }));
    }

    expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 202, 202, 202, 429]);

    const separateClient = await app.inject({
      method: "POST",
      url: "/api/public/waitlist",
      headers: { "x-forwarded-for": "198.51.100.41" },
      payload: { email: "other@example.com", consent: true }
    });
    expect(separateClient.statusCode).toBe(202);
  });

  it("trusts forwarded client IPs only through the proxies in SPACE_TRUSTED_PROXIES", async () => {
    const { app: proxiedApp } = await publicApp(undefined, getApiConfig({ SPACE_TRUSTED_PROXIES: "198.51.100.2" }));
    const proxiedResponses = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      proxiedResponses.push(await proxiedApp.inject({
        method: "POST",
        url: "/api/public/waitlist",
        remoteAddress: "198.51.100.2",
        headers: { "x-forwarded-for": `198.51.100.${40 + attempt}` },
        payload: { email: `proxied-${attempt}@example.com`, consent: true }
      }));
    }

    expect(proxiedResponses.map((response) => response.statusCode)).toEqual([202, 202, 202, 202, 202, 202]);

    const { app: untrustedApp } = await publicApp();
    const spoofedResponses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      spoofedResponses.push(await untrustedApp.inject({
        method: "POST",
        url: "/api/public/waitlist",
        remoteAddress: "198.51.100.200",
        headers: { "x-forwarded-for": `203.0.113.${40 + attempt}` },
        payload: { email: `spoofed-${attempt}@example.com`, consent: true }
      }));
    }

    expect(spoofedResponses.map((response) => response.statusCode)).toEqual([202, 202, 202, 202, 202, 429]);
  });
});
