import { afterEach, describe, expect, it, vi } from "vitest";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]> };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/admin-ops-routes.js", async (orig) => ({ ...await orig<object>(), registerAdminIntegrationRoutes: rec("integration"),
  registerAdminOperationsRoutes: rec("operations") }));
vi.mock("../src/memory-graph-routes.js", async (orig) => ({ ...await orig<object>(), registerMemoryGraphRoutes: rec("memoryGraph") }));

const { registerAdminRoutes } = await import("../src/admin-routes-wiring.js");

afterEach(() => { Object.assign(captured, { order: [], args: {} }); });

function wire() {
  const audits: unknown[] = [];
  const app = { app: true };
  const deps = {
    config: { config: true }, defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }, spaceCapabilityInventoryCollector: "inventory",
    store: { upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` }), recordAuditEvent: async (event: unknown) => { audits.push(event); } },
    memoryGraphService: "graph", memoryConsolidationCoordinator: "consolidation", memoryMutationCoordinator: "mutation", apiStartedAt: "2026-11-01T00:00:00Z",
    auth: { sessionSecret: "s".repeat(32) }, observability: "observability", workerReadinessChecker: "worker-ready", storageReadinessChecker: "storage-ready",
    cliRuntimeVisibility: "visibility", healthMonitor: "health", systemTopologyService: "topology", serviceRestarter: "restarter",
    serviceRestartCooldownPath: "/var/space/restart-cooldown.json"
  };
  const result = registerAdminRoutes(app as never, deps as never);
  return { app, result, deps, audits };
}
const arg = (name: string) => captured.args[name]![1] as Record<string, unknown>;

describe("admin routes wiring (ARCH-001 step 83)", () => {
  it("registers in app.ts's order on the same app", () => {
    const { app, result } = wire();
    expect(captured.order).toEqual(["integration", "memoryGraph", "operations"]);
    for (const name of captured.order) expect(captured.args[name]![0]).toBe(app);
    expect(result).toBeUndefined();
  });

  it("passes the admin integration and admin operations routes their dependencies", () => {
    const { deps } = wire();
    expect(arg("integration")).toEqual({ config: deps.config, store: deps.store, spaceCapabilityInventoryCollector: "inventory",
      routeOptions: deps.defaultRouteRateLimitOptions });
    expect(arg("operations")).toEqual({ apiStartedAt: "2026-11-01T00:00:00Z", config: deps.config, auth: deps.auth, store: deps.store, observability: "observability",
      workerReadinessChecker: "worker-ready", storageReadinessChecker: "storage-ready", cliRuntimeVisibility: "visibility", healthMonitor: "health",
      systemTopologyService: "topology", serviceRestarter: "restarter", serviceRestartCooldownPath: "/var/space/restart-cooldown.json",
      routeOptions: deps.defaultRouteRateLimitOptions });
  });

  it("gives the memory graph routes the graph service, its coordinators and an audit in the caller's account", async () => {
    const { deps, audits } = wire();
    const graph = arg("memoryGraph");
    expect(graph).toMatchObject({ config: deps.config, service: "graph", store: deps.store, consolidationCoordinator: "consolidation", mutationCoordinator: "mutation" });
    const recordAudit = graph.recordAudit as (request: unknown, input: unknown) => Promise<void>;
    await recordAudit({ user: { id: "user:admin01" }, requestIdForSpace: "trace:graph01" }, { action: "memory.graph.merge", targetType: "memory", targetId: "m1" });
    expect(audits).toEqual([expect.objectContaining({ actorUserId: "user:admin01:stored", traceId: "trace:graph01", action: "memory.graph.merge", targetType: "memory",
      targetId: "m1" })]);
  });
});
