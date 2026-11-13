import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ order: [] as string[], deps: {} as Record<string, Record<string, unknown>>, audits: [] as unknown[][], executorDeps: undefined as unknown }));
const rec = (name: string, result?: unknown) => (_app: unknown, deps: Record<string, unknown>) => { captured.order.push(name); captured.deps[name] = deps; return result; };
vi.mock("../src/streaming-admin-routes.js", async (orig) => ({ ...await orig<object>(), registerStreamingAdminRoutes: rec("streamingAdmin") }));
vi.mock("../src/streaming-bot-routes.js", async (orig) => ({ ...await orig<object>(), registerStreamingBotRoutes: rec("streamingBot") }));
vi.mock("../src/system-analytics-routes.js", async (orig) => ({ ...await orig<object>(), registerSystemAnalyticsRoutes: rec("systemAnalytics") }));
vi.mock("../src/admin-toolbar-routes.js", async (orig) => ({ ...await orig<object>(), registerAdminToolbarRoutes: rec("adminToolbar"), registerProviderSwitchRoutes: rec("providerSwitch") }));
vi.mock("../src/admin-cleanup-routes.js", async (orig) => ({ ...await orig<object>(), registerAdminCleanupRoutes: rec("adminCleanup", { cleanup: "handle" }), registerPanePruneRoute: rec("panePrune") }));
vi.mock("../src/codex-history-purge-routes.js", async (orig) => ({ ...await orig<object>(), registerCodexHistoryPurgeRoutes: rec("codexHistoryPurge") }));
vi.mock("../src/telegram-routes.js", async (orig) => ({ ...await orig<object>(), registerTelegramRoutes: rec("telegram") }));
vi.mock("../src/cli-maintenance-routes.js", async (orig) => ({ ...await orig<object>(), registerCliMaintenanceRoutes: rec("cliMaintenance") }));
vi.mock("../src/maintenance-autopilot-wiring.js", async (orig) => ({ ...await orig<object>(), registerMaintenanceAutopilot: rec("maintenanceAutopilot") }));
vi.mock("../src/cli-auth-handoff-routes.js", async (orig) => ({ ...await orig<object>(), registerCliAuthHandoffRoutes: rec("cliAuthHandoff") }));
vi.mock("../src/release-routes.js", async (orig) => ({ ...await orig<object>(), registerReleaseRoutes: rec("release") }));
vi.mock("../src/source-control-connection-routes.js", async (orig) => ({ ...await orig<object>(), registerSourceControlConnectionRoutes: rec("sourceControl") }));
vi.mock("../src/settings-routes.js", async (orig) => ({ ...await orig<object>(), registerSettingsRoutes: rec("settings") }));
vi.mock("../src/configuration-routes.js", async (orig) => ({ ...await orig<object>(), registerConfigurationRoutes: rec("configuration") }));
vi.mock("../src/transfer-routes.js", async (orig) => ({ ...await orig<object>(), registerTransferRoutes: rec("transfer") }));
vi.mock("../src/provider-routes.js", async (orig) => ({ ...await orig<object>(), registerProviderRoutes: rec("provider") }));
vi.mock("../src/mcp-tool-executor.js", async (orig) => ({ ...await orig<object>(), createMcpToolExecutor: (deps: unknown) => {
  captured.order.push("mcpExecutor"); captured.executorDeps = deps;
  return async (input: unknown, request: unknown) => ({ ran: input, request });
} }));
vi.mock("../src/mcp-routes.js", async (orig) => ({ ...await orig<object>(), registerMcpRoutes: rec("mcp") }));
vi.mock("../src/memory-routes.js", async (orig) => ({ ...await orig<object>(), registerMemoryRoutes: rec("memory") }));
vi.mock("../src/shared-task-routes.js", async (orig) => ({ ...await orig<object>(), registerSharedTaskRoutes: rec("sharedTask") }));
vi.mock("../src/artifact-read-routes.js", async (orig) => ({ ...await orig<object>(), registerArtifactReadRoutes: rec("artifactRead") }));
vi.mock("../src/artifact-routes.js", async (orig) => ({ ...await orig<object>(), registerArtifactRoutes: rec("artifact") }));
vi.mock("../src/browser-evidence-routes.js", async (orig) => ({ ...await orig<object>(), registerBrowserEvidenceRoutes: rec("browserEvidence") }));
vi.mock("../src/review-routes.js", async (orig) => ({ ...await orig<object>(), registerReviewRoutes: rec("review") }));
vi.mock("../src/request-audit.js", async (orig) => ({ ...await orig<object>(), recordAudit: async (...args: unknown[]) => { captured.audits.push(args); } }));

const { registerAdminPlatformRoutes } = await import("../src/admin-platform-routes-wiring.js");

afterEach(() => { Object.assign(captured, { order: [], deps: {}, audits: [], executorDeps: undefined }); });

function wire(input: { modules?: string[]; models?: unknown[] } = {}) {
  const gets: Record<string, () => Promise<unknown>> = {};
  const app = { get: (path: string, _options: unknown, handler: () => Promise<unknown>) => { captured.order.push(`GET ${path}`); gets[path] = handler; } };
  const store = { listModels: async () => input.models ?? [] };
  const deps = {
    store, config: { optionalModules: new Set(input.modules ?? []), browserEvidenceArtifactRoot: "/artifacts" }, eventBus: { bus: true },
    options: { maintenanceAutopilot: { autopilot: true }, cliRecoveryLoginOpener: vi.fn(), agentFileDocxNormalizer: vi.fn() },
    telegramIntegrationManager: { telegram: true }, notificationService: { notifications: true }, cliRuntimeRegistryCache: { runtimes: true },
    publicCredentialHost: { credentialHost: true }, dotMemoryRepository: { dotMemory: true }, defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }
  };
  const result = registerAdminPlatformRoutes(app as never, deps as never);
  return { result, gets, deps, store };
}

describe("admin and platform routes wiring", () => {
  it("registers every route group in app.ts's order, Telegram only with its module", () => {
    wire();
    const withoutTelegram = ["streamingAdmin", "streamingBot", "systemAnalytics", "adminToolbar", "adminCleanup", "codexHistoryPurge", "providerSwitch",
      "cliMaintenance", "maintenanceAutopilot", "cliAuthHandoff", "panePrune", "release", "sourceControl", "settings", "configuration", "transfer", "provider",
      "GET /api/models", "mcpExecutor", "mcp", "memory", "sharedTask", "artifactRead", "artifact", "browserEvidence", "review"];
    expect(captured.order).toEqual(withoutTelegram);
    captured.order = [];
    wire({ modules: ["telegram"] });
    expect(captured.order).toEqual([...withoutTelegram.slice(0, 7), "telegram", ...withoutTelegram.slice(7)]);
    expect(captured.deps.telegram).toMatchObject({ manager: { telegram: true } });
  });

  it("returns the MCP tool executor, gives it to the MCP routes and lets the streaming bot reach it lazily", async () => {
    const { result } = wire();
    expect(captured.deps.mcp?.executeMcpToolWithPolicy).toBe(result.executeMcpToolWithPolicy);
    expect(captured.executorDeps).toMatchObject({ eventBus: { bus: true } });
    const viaBot = captured.deps.streamingBot?.executeMcpToolWithPolicy as (input: unknown, request: unknown) => Promise<unknown>;
    await expect(viaBot({ tool: "x" }, { id: "req" })).resolves.toEqual({ ran: { tool: "x" }, request: { id: "req" } });
  });

  it("hands the cleanup routes' handle and the options' autopilot to the maintenance autopilot", () => {
    wire();
    expect(captured.deps.maintenanceAutopilot).toMatchObject({ toolbarCleanup: { cleanup: "handle" }, maintenanceAutopilot: { autopilot: true } });
  });

  it("passes the renamed services under the names each route group takes", () => {
    const { deps } = wire();
    expect(captured.deps.cliMaintenance?.notifications).toBe(deps.notificationService);
    expect(captured.deps.configuration).toMatchObject({ runtimes: deps.cliRuntimeRegistryCache, credentialHost: deps.publicCredentialHost, routeOptions: deps.defaultRouteRateLimitOptions });
    expect(captured.deps.memory?.dotMemoryEmbeddings).toBe(deps.dotMemoryRepository);
    expect(captured.deps.artifactRead).toMatchObject({ artifactRoot: "/artifacts" });
    expect(captured.deps.cliAuthHandoff?.options).toBe(deps.options);
  });

  it("binds the store to every audit it records", async () => {
    const { store } = wire({ modules: ["telegram"] });
    for (const name of ["streamingAdmin", "streamingBot", "telegram", "cliMaintenance", "configuration", "provider", "review"]) {
      await (captured.deps[name]?.recordAudit as (request: unknown, input: unknown) => Promise<void>)({ id: name }, { action: name });
    }
    expect(captured.audits).toHaveLength(7);
    expect(captured.audits.every(([bound]) => bound === store)).toBe(true);
    expect(captured.audits.map(([, request]) => (request as { id: string }).id)).toContain("review");
  });

  it("answers the model list with one page, or none when there are no models", async () => {
    expect(await wire().gets["/api/models"]?.()).toEqual({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } });
    captured.order = [];
    const models = [{ id: "model:a" }, { id: "model:b" }];
    expect(await wire({ models }).gets["/api/models"]?.()).toEqual({ data: models, pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 } });
  });
});
