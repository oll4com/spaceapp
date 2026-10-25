import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createSetupCapabilityChecks } from "../src/setup-capability-checks.js";

const at = "2026-10-08T12:00:00.000Z";
const usage = { data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 1 }, source: "fixture", isStale: false, error: null, checkedAt: at };
const health = { sampledAt: at, metrics: [
  { id: "cpu", label: "CPU", group: "cpu", unit: "PERCENT", value: 10, detail: "Owned sample", sampledAt: at },
  { id: "memory", label: "Memory", group: "memory", unit: "BYTES", value: 1024, detail: "Owned sample", sampledAt: at }
], services: [], requests: { windowSeconds: 300, requestCount: 0, errorCount: 0, errorRatePercent: null, p95Ms: null, sampledAt: at }, uptimeSeconds: 60, coreCount: 1 };
describe("remaining setup widgets and health", () => {
  it("reads selected quota sources only during a check and permits an honest empty account list", async () => {
    let reads = 0; let available = true;
    const checks = createSetupCapabilityChecks({ store: new InMemorySpaceStore(), checkSourceControl: async () => undefined,
      readQuotaSources: async () => { reads++; return [{ kind: "codex" as const, snapshot: { ...usage, isStale: !available } }]; } });
    expect(reads).toBe(0);
    // The Token Reminder folded into AI Quota & Usage on dev; its setup check went with it.
    expect(checks["widget:token-reminder" as keyof typeof checks]).toBeUndefined();
    expect(checks["widget:ai-quota"]).toBeDefined();
    await expect(checks["widget:ai-quota"]!("user:owner")).resolves.toBeUndefined();
    expect(reads).toBe(1);
    available = false;
    await expect(checks["widget:ai-quota"]!("user:owner")).rejects.toThrow("quota source");
  });
  it("refuses malformed quota or absent CPU/memory metrics", async () => {
    let current: unknown = health;
    const checks = createSetupCapabilityChecks({ store: new InMemorySpaceStore(), checkSourceControl: async () => undefined,
      readQuotaSources: async () => [{ kind: "codex" as const, snapshot: { ...usage, data: [{ weeklyRemainingPercent: 500 }] } }],
      readSystemHealth: async () => current });
    expect(checks["widget:ai-quota"]).toBeDefined();
    expect(checks["utility:system-health"]).toBeDefined();
    await expect(checks["widget:ai-quota"]!("user:owner")).rejects.toThrow();
    await expect(checks["utility:system-health"]!("user:owner")).resolves.toBeUndefined();
    current = { ...health, metrics: [] };
    await expect(checks["utility:system-health"]!("user:owner")).rejects.toThrow("CPU and memory");
  });
  it("checks local movement and embedded news functions without a provider or notification request", async () => {
    const checks = createSetupCapabilityChecks({ store: new InMemorySpaceStore(), checkSourceControl: async () => undefined });
    expect(checks["widget:pushup-reminder"]).toBeDefined();
    expect(checks["widget:spaceapp-promo"]).toBeDefined();
    await expect(checks["widget:pushup-reminder"]!("user:owner")).resolves.toBeUndefined();
    await expect(checks["widget:spaceapp-promo"]!("user:owner")).resolves.toBeUndefined();
    expect(checks["widget:ai-quota"]).toBeUndefined();
  });
});
