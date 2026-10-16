import { afterEach, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

// 1.1.5 internal review (2026-10-16): /readyz raced each dependency check against a timeout but never
// cancelled it, so every probe against a stalled dependency left one more unfinished check behind.
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

it("keeps one pending check per stalled dependency across readiness probes", async () => {
  const store = new InMemorySpaceStore();
  const checkReadiness = vi.fn(() => new Promise<void>(() => {}));
  Object.assign(store, { checkReadiness });
  const workerReadinessChecker = vi.fn(() => new Promise<never>(() => {}));
  app = await createApp({
    store,
    config: getApiConfig({ SPACE_LOG_LEVEL: "silent" }),
    auth: { sessionSecret: "readyz-single-flight-secret", devLogin: false, secureCookies: false },
    workerReadinessChecker
  } as Parameters<typeof createApp>[0]);
  const probes = await Promise.all([1, 2, 3].map(() => app!.inject({ method: "GET", url: "/readyz" })));
  for (const probe of probes) expect(probe.json().dependencies.database).toBe("UNAVAILABLE");
  const later = await app.inject({ method: "GET", url: "/readyz" });
  expect(later.json().dependencies.database).toBe("UNAVAILABLE");
  expect(checkReadiness).toHaveBeenCalledTimes(1);
  expect(workerReadinessChecker).toHaveBeenCalledTimes(1);
}, 30_000);
