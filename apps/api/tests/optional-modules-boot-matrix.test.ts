import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig, optionalModuleIds, type OptionalModuleId } from "../src/config.js";

// ARCH-003: optional modules must not depend on each other. The API boots with no module, with every module and
// with every module but one; each time the core workspace answers, every enabled module's routes are registered and
// a disabled module's are not. A route counts as registered when Fastify does not answer "Route ... not found".
const probes: Record<Exclude<OptionalModuleId, "channels">, { method: "GET" | "POST"; url: string }> = {
  games: { method: "GET", url: "/api/benchmark/leaderboard" },
  "job-copilot": { method: "GET", url: "/api/job-apply/applications" },
  "mail-copilot": { method: "GET", url: "/api/mail-copilot/rules" },
  "marketing-copilot": { method: "GET", url: "/api/marketing-copilot/posts" },
  "freelance-copilot": { method: "GET", url: "/api/freelance-copilot/leads" },
  design: { method: "GET", url: "/api/design/formats" },
  "app-studio": { method: "GET", url: "/api/panes/pane%3Amatrix0001/app-studio/settings" },
  video: { method: "GET", url: "/api/video/formats" },
  "security-copilot": { method: "GET", url: "/api/panes/pane%3Amatrix0001/security-copilot/state" },
  "monitoring-copilot": { method: "GET", url: "/api/panes/pane%3Amatrix0001/monitoring-copilot/state" },
  telegram: { method: "GET", url: "/api/integrations/telegram" },
  waitlist: { method: "POST", url: "/api/public/waitlist" },
  "desktop-updates": { method: "GET", url: "/api/desktop/latest" }
};

async function boot(modules: readonly OptionalModuleId[]) {
  const app = await createApp({
    store: new InMemorySpaceStore(),
    config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_OPTIONAL_MODULES: modules.length ? modules.join(",") : "none" }),
    auth: { sessionSecret: "optional-modules-matrix-secret", devLogin: true, secureCookies: false }
  });
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
    const rooms = (await app.inject({ method: "GET", url: "/api/rooms", headers: { cookie } })).statusCode;
    const registered: Partial<Record<OptionalModuleId, boolean>> = {};
    for (const [id, probe] of Object.entries(probes) as Array<[OptionalModuleId, { method: "GET" | "POST"; url: string }]>) {
      const response = await app.inject({ method: probe.method, url: probe.url, headers: { cookie, "x-space-csrf-token": csrf },
        ...(probe.method === "POST" ? { payload: {} } : {}) });
      registered[id] = !(response.statusCode === 404 && /^Route (GET|POST):.* not found$/.test(String(response.json()?.message ?? "")));
    }
    // Channels keeps its routes and answers 503 without its service, which also needs PostgreSQL repositories.
    const channels = await app.inject({ method: "GET", url: "/api/channels", headers: { cookie } });
    return { rooms, registered, channelsCode: channels.json()?.error?.code ?? null };
  } finally {
    await app.close();
  }
}

const expected = (enabled: readonly OptionalModuleId[]) =>
  Object.fromEntries(Object.keys(probes).map((id) => [id, enabled.includes(id as OptionalModuleId)]));

describe("optional module boot matrix (ARCH-003)", () => {
  it("covers every optional module", () => {
    expect([...Object.keys(probes), "channels"].sort()).toEqual([...optionalModuleIds].sort());
  });

  it("boots with no module and with every module", async () => {
    const none = await boot([]);
    expect(none).toEqual({ rooms: 200, registered: expected([]), channelsCode: "CHANNELS_UNAVAILABLE" });
    const all = await boot(optionalModuleIds);
    expect(all.rooms).toBe(200);
    expect(all.registered).toEqual(expected(optionalModuleIds));
  }, 120_000);

  it("boots with every module but one, and the others keep their routes", async () => {
    const failures: string[] = [];
    for (const left of optionalModuleIds) {
      const enabled = optionalModuleIds.filter((id) => id !== left);
      const result = await boot(enabled);
      if (result.rooms !== 200) failures.push(`${left} off: core answered ${result.rooms}`);
      for (const [id, isRegistered] of Object.entries(result.registered)) {
        if (isRegistered !== enabled.includes(id as OptionalModuleId)) failures.push(`${left} off: ${id} registered=${isRegistered}`);
      }
      if (left === "channels" && result.channelsCode !== "CHANNELS_UNAVAILABLE") failures.push("channels off: channels service answered");
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
