import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

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
  it("inspects the configured installation root without requiring /opt/spaceapp", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "space-dev-storage-"));
    expect(getApiConfig({}).installRoot).toBe("/opt/spaceapp");
    const app = await createApp({
      config: getApiConfig({ SPACE_INSTALL_ROOT: installRoot, SPACE_BROWSER_SESSIONS_ENABLED: "false" }),
      auth: { sessionSecret: "storage-path-test-session-secret", devLogin: true, secureCookies: false }
    });
    try {
      const headers = { cookie: await loginCookie(app) };
      const storage = await app.inject({ method: "GET", url: "/api/admin/storage", headers });
      expect(storage.statusCode).toBe(200);
      expect(storage.json()).toMatchObject({ app: { path: installRoot }, minimumRecommendedFreeBytes: 20 * 1024 ** 3 });
      expect(storage.json().dedicatedAppVolume).toBe(storage.json().root.deviceId !== storage.json().app.deviceId);
      const admin = await app.inject({ method: "GET", url: "/api/admin", headers });
      expect(admin.statusCode).toBe(200);
      expect(admin.json().storageWarning).toBe("");
    } finally {
      await app.close();
      await rm(installRoot, { recursive: true, force: true });
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
