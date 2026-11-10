import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayAccountRecord } from "@space/db";
import { emailsOutOfRotation } from "../src/gateway/account-rotation.js";
import {
  antigravityUserAgent,
  extractEmailFromIdToken,
  parseAntigravityQuotaSummary,
  createAntigravityUsageAccountProvider
} from "../src/antigravity-usage-services.js";

describe("antigravity usage services", () => {
  it("extracts email safely from jwt id_token or Antigravity 1.5.x id_token_email", () => {
    const claims = { email: "user@example.com", sub: "12345" };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const fakeJwt = `header.${payload}.sig`;
    expect(extractEmailFromIdToken(fakeJwt)).toBe("user@example.com");
    expect(extractEmailFromIdToken("invalid.token")).toBe(null);
    expect(extractEmailFromIdToken(null)).toBe(null);
    expect(extractEmailFromIdToken(undefined, "ntheogr@gmail.com")).toBe("ntheogr@gmail.com");
    expect(extractEmailFromIdToken("invalid.token", "mesgnud@gmail.com")).toBe("mesgnud@gmail.com");
  });

  it("parses quota summary into Gemini and Claude model groups", () => {
    const mockSummary = {
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-09-22T10:00:00Z",
              remainingFraction: 0.954
            },
            {
              bucketId: "gemini-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "2026-09-15T15:00:00Z",
              remainingFraction: 0.751
            }
          ]
        },
        {
          displayName: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              bucketId: "3p-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-09-22T11:00:00Z",
              remainingFraction: 1.0
            },
            {
              bucketId: "3p-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "2026-09-15T16:00:00Z",
              remainingFraction: 1.0
            }
          ]
        }
      ]
    };

    const parsed = parseAntigravityQuotaSummary(mockSummary);
    expect(parsed.gemini).toEqual({
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      fiveHourRemainingPercent: 75.1,
      fiveHourResetAt: "2026-09-15T15:00:00Z",
      weeklyRemainingPercent: 95.4,
      weeklyResetAt: "2026-09-22T10:00:00Z"
    });
    expect(parsed.claude).toEqual({
      displayName: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      fiveHourRemainingPercent: 100,
      fiveHourResetAt: "2026-09-15T16:00:00Z",
      weeklyRemainingPercent: 100,
      weeklyResetAt: "2026-09-22T11:00:00Z"
    });

    const nowMs = Date.parse("2026-11-08T06:00:00Z");
    const proFallback = parseAntigravityQuotaSummary(
      { groups: [mockSummary.groups[1]] },
      { buckets: [{ modelId: "gemini-3.8-flash-tiered", remainingFraction: 0.962, resetTime: "2026-11-08T09:55:53Z" }] },
      nowMs
    );
    expect(proFallback.gemini.fiveHourRemainingPercent).toBe(96.2);
    expect(proFallback.gemini.fiveHourResetAt).toBe("2026-11-08T09:55:53Z");
    expect(proFallback.gemini.weeklyRemainingPercent).toBeNull();

    const freeFallback = parseAntigravityQuotaSummary(
      { groups: [{ displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0 }] }] },
      { buckets: [{ modelId: "gemini-2.5-flash", remainingFraction: 0, resetTime: "2026-11-14T14:54:03Z" }] },
      nowMs
    );
    expect(freeFallback.gemini.weeklyRemainingPercent).toBe(0);
    expect(freeFallback.gemini.weeklyResetAt).toBe("2026-11-14T14:54:03Z");
  });

  async function collectOne(loadCodeAssist: Record<string, unknown>, check: (acc: Awaited<ReturnType<ReturnType<typeof createAntigravityUsageAccountProvider>>>["data"][number]) => void,
    hiddenEmails?: () => Promise<Set<string>>) {
    const tempDir = await mkdtemp(join(tmpdir(), "space-test-gemini-"));
    try {
      const p1Dir = join(tempDir, "space-gemini", "profiles", "in1", "home", ".gemini", "antigravity-cli");
      await mkdir(p1Dir, { recursive: true });

      await writeFile(
        join(p1Dir, "antigravity-oauth-token"),
        JSON.stringify({
          token: {
            access_token: "mock-valid-token",
            expiry: new Date(Date.now() + 3600_000).toISOString(),
            refresh_token: "mock-refresh"
          },
          auth_method: "GOOGLE_LOGIN",
          id_token_email: "indgmopai1@gmail.com"
        }),
        "utf8"
      );

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("loadCodeAssist")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ...loadCodeAssist, cloudaicompanionProject: "aicode-consumers" })
          } as Response;
        }
        if (u.includes("retrieveUserQuotaSummary")) {
          // Verify the project is passed in the body
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const body = bodyStr ? JSON.parse(bodyStr) : {};
          expect(body.project).toBe("aicode-consumers");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              groups: [
                {
                  displayName: "Gemini Models",
                  buckets: [
                    { window: "5h", remainingFraction: 0.9987, resetTime: "2026-09-15T16:00:00Z" },
                    { window: "weekly", remainingFraction: 0.9998, resetTime: "2026-09-22T12:00:00Z" }
                  ]
                },
                {
                  displayName: "Claude and GPT models",
                  buckets: [
                    { window: "5h", remainingFraction: 1.0, resetTime: "2026-09-15T16:00:00Z" },
                    { window: "weekly", remainingFraction: 1.0, resetTime: "2026-09-22T12:00:00Z" }
                  ]
                }
              ]
            })
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });

      const provider = createAntigravityUsageAccountProvider({
        codexHome: tempDir,
        fetchImpl: mockFetch as unknown as typeof fetch,
        profileLabels: async () => new Map([["in1", "Indgmopai 1"]]),
        hiddenEmails
      });

      const result = await provider();
      if (hiddenEmails) {
        check(result.data[0]!);
        return;
      }
      expect(result.data).toHaveLength(1);
      check(result.data[0]!);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  it("lists every group Google reports by its bucket id, Argon apart from Gemini, a disabled bucket as no limit", () => {
    const bucket = (bucketId: string, window: string, remainingFraction: number, extra = {}) =>
      ({ bucketId, window, remainingFraction, resetTime: "2026-11-15T06:00:00Z", ...extra });
    const parsed = parseAntigravityQuotaSummary({
      groups: [
        { displayName: "Gemini 4 Argon", buckets: [bucket("gemini-argon-wtu-weekly", "weekly", 0.4)] },
        { displayName: "Gemini Models", buckets: [bucket("gemini-weekly", "weekly", 0.9), bucket("gemini-5h", "5h", 0.5)] },
        { displayName: "Claude and GPT models", buckets: [bucket("3p-weekly", "weekly", 0), bucket("3p-5h", "5h", 1, { disabled: true })] }
      ]
    });
    expect(parsed.groups.map((g) => [g.id, g.displayName, g.fiveHourRemainingPercent, g.weeklyRemainingPercent])).toEqual([
      ["gemini-argon-wtu", "Gemini 4 Argon", null, 40],
      ["gemini", "Gemini Models", 50, 90],
      ["claude", "Claude and GPT models", null, 0]
    ]);
    expect(parsed.gemini.weeklyRemainingPercent).toBe(90);
    expect(parseAntigravityQuotaSummary({ groups: [] }).groups).toEqual([]);
  });

  it("names the installed Antigravity CLI version as the client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-ua-"));
    try {
      expect(await antigravityUserAgent(dir)).toBe("antigravity/cli/1.5.3");
      await symlink("1.6.0", join(dir, "current"));
      expect(await antigravityUserAgent(dir)).toBe("antigravity/cli/1.6.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers profiles and collects usage with mock fetch", async () => {
    await collectOne({
      currentTier: { id: "free-tier", name: "Antigravity" },
      paidTier: { id: "g1-pro-tier", name: "Google AI Pro" }
    }, (acc) => {
      expect(acc.id).toBe("in1");
      expect(acc.label).toBe("Indgmopai 1");
      expect(acc.email).toBe("indgmopai1@gmail.com");
      expect(acc.status).toBe("CONNECTED");
      expect(acc.tier).toBe("Google AI Pro");
      expect(acc.gemini.fiveHourRemainingPercent).toBe(99.9);
      expect(acc.gemini.weeklyRemainingPercent).toBe(100);
      expect(acc.claude.fiveHourRemainingPercent).toBe(100);
      expect(acc.claude.weeklyRemainingPercent).toBe(100);
    });
  });

  it("bounds a stalled upstream profile check", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "space-test-gemini-timeout-"));
    try {
      const profileDir = join(tempDir, "space-gemini", "profiles", "in1", "home", ".gemini", "antigravity-cli");
      await mkdir(profileDir, { recursive: true });
      const payload = Buffer.from(JSON.stringify({ email: "timeout@example.com" })).toString("base64url");
      await writeFile(join(profileDir, "antigravity-oauth-token"), JSON.stringify({
        token: { access_token: "mock-valid-token", expiry: new Date(Date.now() + 3600_000).toISOString() },
        id_token: `header.${payload}.sig`
      }), "utf8");

      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new Error("upstream aborted"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      }));
      const provider = createAntigravityUsageAccountProvider({
        codexHome: tempDir,
        fetchImpl: mockFetch as unknown as typeof fetch,
        fetchTimeoutMs: 10
      });

      const startedAt = Date.now();
      const result = await provider();
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.status).toBe("ERROR");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves out a profile whose account Space Gateway keeps out of rotation, at once and only that one", async () => {
    let paused = new Set(["INDGMOPAI1@gmail.com".toLowerCase()]);
    await collectOne({ currentTier: { id: "free-tier", name: "Antigravity" } }, (acc) => expect(acc).toBeUndefined(), async () => paused);
    paused = new Set(["someone-else@example.com"]);
    await collectOne({ currentTier: { id: "free-tier", name: "Antigravity" } }, (acc) => expect(acc?.email).toBe("indgmopai1@gmail.com"), async () => paused);
  });

  it("labels an account without a paid tier as Free", async () => {
    await collectOne({ currentTier: { id: "free-tier", name: "Antigravity" } }, (acc) => {
      expect(acc.tier).toBe("Free");
    });
  });

  it("names the emails Space Gateway does not use, unless the same email also has an account in rotation", () => {
    const account = (email: string, status: GatewayAccountRecord["status"], provider: GatewayAccountRecord["provider"] = "ANTIGRAVITY") =>
      ({ email, status, provider, credentialsExpiresAt: null }) as GatewayAccountRecord;
    const hidden = emailsOutOfRotation([account("Paused@gmail.com", "PAUSED"), account("both@gmail.com", "PAUSED"), account("both@gmail.com", "ACTIVE"),
      account("codex@gmail.com", "PAUSED", "CODEX"), account("gone@gmail.com", "DEACTIVATED")], "ANTIGRAVITY", Date.now());
    expect([...hidden].sort()).toEqual(["gone@gmail.com", "paused@gmail.com"]);
  });
});
