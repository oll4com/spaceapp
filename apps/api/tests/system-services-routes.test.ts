import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";

// The real reset runs sudo systemctl; the route test only checks what reaches it.
const resetFailedSystemUnits = vi.hoisted(() => vi.fn(async (unit?: string) => ({ success: true, reset: unit ?? "space-*" })));
vi.mock("../src/service-services.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service-services.js")>(),
  resetFailedSystemUnits
}));

const { createApp } = await import("../src/app.js");
const { createCsrfToken, signSession } = await import("../src/auth.js");
const { getApiConfig } = await import("../src/config.js");

// GET /api/system/services and POST /api/system/services/reset-failed left app.ts (ARCH-001 step 40); this pins what they answer.
describe("system services routes", () => {
  const sessionSecret = "system-services-route-secret";
  const session = signSession({ id: "user:admin", email: "admin@space.local", role: "ADMIN" }, sessionSecret);
  const headers = { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
  const services = {
    units: [{ unit: "space-api.service", description: "Space API", type: "service" as const, loadState: "loaded", activeState: "active",
      subState: "running", unitFileState: "enabled", timerActivates: null, timerNextElapse: null, timerLastTrigger: null }],
    summary: { total: 1, active: 1, inactive: 0, failed: 0, services: 1, timers: 0, enabled: 1, disabled: 0 },
    sampledAt: "2026-10-31T12:00:00.000Z"
  };

  it("lists the provider's units and passes a trimmed unit to reset-failed", async () => {
    const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false }, systemServicesProvider: async () => services });
    try {
      const listed = await app.inject({ method: "GET", url: "/api/system/services", headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual(services);

      const one = await app.inject({ method: "POST", url: "/api/system/services/reset-failed", headers, payload: { unit: " space-api.service " } });
      expect(one.json()).toEqual({ success: true, reset: "space-api.service" });
      const all = await app.inject({ method: "POST", url: "/api/system/services/reset-failed", headers, payload: {} });
      expect(all.json()).toEqual({ success: true, reset: "space-*" });
      expect(resetFailedSystemUnits.mock.calls).toEqual([["space-api.service"], [undefined]]);

      expect((await app.inject({ method: "GET", url: "/api/system/services" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
