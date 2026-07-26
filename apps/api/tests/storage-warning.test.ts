import { describe, expect, it } from "vitest";
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

describe("public profile storage warning", () => {
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
  });

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
  });
});
