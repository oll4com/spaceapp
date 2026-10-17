import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const blockedHeavyStorage = {
  id: "space-storage" as const,
  status: "BLOCKED" as const,
  statusReason:
    "Dedicated /opt/spaceapp volume is not detected; production/browser-heavy launch requires isolated 150-250GB app storage.",
  root: {
    path: "/",
    deviceId: "root-device",
    sizeBytes: 40 * 1024 ** 3,
    availableBytes: 30 * 1024 ** 3,
    usedPercent: 25
  },
  app: {
    path: "/opt/spaceapp",
    deviceId: "root-device",
    sizeBytes: 40 * 1024 ** 3,
    availableBytes: 30 * 1024 ** 3,
    usedPercent: 25
  },
  dedicatedAppVolume: false,
  minimumRecommendedFreeBytes: 150 * 1024 ** 3,
  checkedAt: "2026-07-26T02:00:00.000Z"
};

async function loginCookie(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "space@space.local",
      password: "space-dev"
    }
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((candidate) => candidate.name === "space_session");
  expect(cookie).toBeDefined();
  return `${cookie!.name}=${cookie!.value}`;
}

// Each test starts and closes the whole API. On loaded hosts (2026-10-11)
// createApp took up to 15 s and app.close() 11-38 s, so the default 5 s limit
// says nothing about correctness.
const APP_TEST_TIMEOUT_MS = 60_000;

describe("public profile storage warning", () => {
  it("default storage collection uses the configured existing checkout without inventing dedicated-volume readiness", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "space-source-storage-"));
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      app = await createApp({
        config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_INSTALL_ROOT: fixture }),
        auth: { sessionSecret: "source-storage-test-session-secret", devLogin: true, secureCookies: false }
        // Deliberately no injected storageReadinessChecker: exercise the failing default.
      });
      const cookie = await loginCookie(app);
      const admin = await app.inject({ method: "GET", url: "/api/admin", headers: { cookie } });
      expect(admin.statusCode).toBe(200);
      expect(admin.json()).toMatchObject({ status: "ok", storageWarning: "" });
      const storage = await app.inject({ method: "GET", url: "/api/admin/storage", headers: { cookie } });
      expect(storage.statusCode).toBe(200);
      const value = storage.json();
      expect(value.app.path).toBe(fixture);
      expect(value.root.path).toBe("/");
      expect(value.minimumRecommendedFreeBytes).toBe(20 * 1024 ** 3);
      expect(value.dedicatedAppVolume).toBe(value.root.deviceId !== value.app.deviceId);
      const expected = !value.dedicatedAppVolume || value.app.availableBytes < value.minimumRecommendedFreeBytes
        ? "BLOCKED" : value.root.usedPercent >= 80 ? "WARN" : "VERIFIED";
      expect(value.status).toBe(expected);
      if (!value.dedicatedAppVolume) expect(value.statusReason).toContain(fixture);
    } finally {
      try { await app?.close(); } finally { await rm(fixture, { recursive: true, force: true }); }
    }
  }, APP_TEST_TIMEOUT_MS);

  it("default storage collection retains a real missing-root failure without creating the configured path", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "space-source-missing-storage-"));
    const missing = join(fixture, "absent");
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      app = await createApp({
        config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_INSTALL_ROOT: missing }),
        auth: { sessionSecret: "source-storage-test-session-secret", devLogin: true, secureCookies: false }
      });
      const cookie = await loginCookie(app);
      for (const url of ["/api/admin", "/api/admin/storage"]) {
        const response = await app.inject({ method: "GET", url, headers: { cookie } });
        expect(response.statusCode).toBe(500);
      }
      await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      try { await app?.close(); } finally { await rm(fixture, { recursive: true, force: true }); }
    }
  }, APP_TEST_TIMEOUT_MS);

  it("does not show the browser-heavy storage banner when browser sessions are disabled", async () => {
    const app = await createApp({
      config: getApiConfig({
        SPACE_BROWSER_SESSIONS_ENABLED: "false"
      }),
      auth: {
        sessionSecret: "storage-warning-test-session-secret",
        devLogin: true,
        secureCookies: false
      },
      storageReadinessChecker: async () => blockedHeavyStorage
    });

    try {
      const admin = await app.inject({
        method: "GET",
        url: "/api/admin",
        headers: {
          cookie: await loginCookie(app)
        }
      });

      expect(admin.statusCode).toBe(200);
      expect(admin.json()).toMatchObject({
        storageWarning: ""
      });
    } finally {
      await app.close();
    }
  }, APP_TEST_TIMEOUT_MS);

  it("keeps the browser-heavy storage banner when browser sessions are enabled", async () => {
    const app = await createApp({
      config: getApiConfig({
        SPACE_BROWSER_SESSIONS_ENABLED: "true"
      }),
      auth: {
        sessionSecret: "storage-warning-test-session-secret",
        devLogin: true,
        secureCookies: false
      },
      storageReadinessChecker: async () => blockedHeavyStorage
    });

    try {
      const admin = await app.inject({
        method: "GET",
        url: "/api/admin",
        headers: {
          cookie: await loginCookie(app)
        }
      });

      expect(admin.statusCode).toBe(200);
      expect(admin.json()).toMatchObject({
        storageWarning: blockedHeavyStorage.statusReason
      });
    } finally {
      await app.close();
    }
  }, APP_TEST_TIMEOUT_MS);
});
