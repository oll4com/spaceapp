import { afterEach, describe, expect, it, vi } from "vitest";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]> };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/stranded-chat-run-sweep.js", async (orig) => ({ ...await orig<object>(), createStrandedChatRunSweep: rec("sweep", { sweepStrandedChatRuns: "sweep-fn" }) }));
vi.mock("../src/dot-services-wiring.js", async (orig) => ({ ...await orig<object>(), registerDotServices: rec("services", { dotScheduleService: "schedules",
  dotComputerService: "computer", dotDeliverablesService: "deliverables", connectorService: "connectors", dotDelegationService: "delegations" }) }));
vi.mock("../src/dot-channels-proactive-wiring.js", async (orig) => ({ ...await orig<object>(),
  registerDotChannelsAndProactive: rec("channels", { dotChannelService: "channels", dotEvalsRepository: "evals" }) }));
vi.mock("../src/dot-tools-gateway-wiring.js", async (orig) => ({ ...await orig<object>(), registerDotToolGatewayWiring: rec("gateway") }));

const { registerDotRoutes } = await import("../src/dot-routes-wiring.js");

afterEach(() => { Object.assign(captured, { order: [], args: {} }); });

function wire() {
  const mcpCalls: unknown[] = [];
  const app = { app: true };
  const deps = {
    config: { config: true }, store: { store: true }, options: { options: true }, auth: { sessionSecret: "s".repeat(32) }, eventBus: { bus: true }, cookieName: "space_session",
    defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }, dotsAuthenticatedOwner: "dots-owner", dotsRepository: "dots", dotGoalsRepository: "goals",
    dotHomeRepository: "home", dotGoalService: "goal-service", dotMemoryService: "memory", dotAtCapacity: "at-capacity", autoRouteFactsLoader: "auto-route",
    browserSessionManager: "browsers", browserAccountStore: "browser-accounts", youtubeAccountOwner: "youtube-owner", cliRuntimeVisibility: "visibility",
    connectorCrypto: "crypto", connectorServiceRef: { current: null }, connectorStateTools: "state-tools", roomPaneCommands: "pane-commands", spaceAgentAdapter: "agent",
    spaceControl: "space-control", controlUser: "control-user", spaceControlRoutes: "control-routes", vault: "vault", designService: "design", videoService: "video",
    executeMcpToolWithPolicy: async (...args: unknown[]) => { mcpCalls.push(args); return "mcp-result"; }
  };
  const result = registerDotRoutes(app as never, deps as never);
  return { app, result, deps, mcpCalls };
}
const arg = (name: string, index = 1) => captured.args[name]![index] as Record<string, unknown>;

describe("Dot routes wiring (ARCH-001 step 82)", () => {
  it("registers in app.ts's order and returns the sweep and the Dot evaluations repository", () => {
    const { app, result, deps } = wire();
    expect(captured.order).toEqual(["sweep", "services", "channels", "gateway"]);
    for (const name of ["sweep", "services", "channels", "gateway"]) expect(captured.args[name]![0]).toBe(app);
    expect(result).toEqual({ sweepStrandedChatRuns: "sweep-fn", dotEvalsRepository: "evals" });
    expect(arg("sweep")).toEqual({ config: deps.config, store: deps.store, dotsRepository: "dots" });
  });

  it("gives the Dot services their dependencies", () => {
    const { deps } = wire();
    expect(arg("services")).toEqual({ store: deps.store, config: deps.config, options: deps.options, auth: deps.auth, eventBus: deps.eventBus,
      defaultRouteRateLimitOptions: deps.defaultRouteRateLimitOptions, dotsAuthenticatedOwner: "dots-owner", dotsRepository: "dots", dotGoalsRepository: "goals",
      dotGoalService: "goal-service", dotMemoryService: "memory", dotAtCapacity: "at-capacity", autoRouteFactsLoader: "auto-route", browserSessionManager: "browsers",
      browserAccountStore: "browser-accounts", youtubeAccountOwner: "youtube-owner", cliRuntimeVisibility: "visibility", connectorCrypto: "crypto",
      connectorServiceRef: deps.connectorServiceRef, connectorStateTools: "state-tools", roomPaneCommands: "pane-commands", spaceAgentAdapter: "agent" });
  });

  it("hands the services the Dot services made to the channels and proactive notices", () => {
    const { deps } = wire();
    expect(arg("channels")).toEqual({ store: deps.store, config: deps.config, options: deps.options, auth: deps.auth, eventBus: deps.eventBus,
      defaultRouteRateLimitOptions: deps.defaultRouteRateLimitOptions, dotsAuthenticatedOwner: "dots-owner", dotsRepository: "dots", dotGoalsRepository: "goals",
      dotHomeRepository: "home", dotGoalService: "goal-service", dotDelegationService: "delegations", dotScheduleService: "schedules", connectorService: "connectors",
      dotComputerService: "computer", cliRuntimeVisibility: "visibility", roomPaneCommands: "pane-commands", spaceAgentAdapter: "agent", spaceControl: "space-control",
      controlUser: "control-user" });
  });

  it("gives the Dot tool gateway every Dot service and forwards its MCP tool calls to the admin platform's runner", async () => {
    const { deps, mcpCalls } = wire();
    const gateway = arg("gateway");
    expect(gateway).toMatchObject({ store: deps.store, config: deps.config, auth: deps.auth, cookieName: "space_session",
      defaultRouteRateLimitOptions: deps.defaultRouteRateLimitOptions, dotsRepository: "dots", dotHomeRepository: "home", dotEvalsRepository: "evals",
      controlUser: "control-user", spaceControlRoutes: "control-routes", browserSessionManager: "browsers", vault: "vault", spaceAgentAdapter: "agent",
      connectorService: "connectors", dotChannelService: "channels", dotGoalService: "goal-service", dotComputerService: "computer", dotDelegationService: "delegations",
      dotMemoryService: "memory", dotDeliverablesService: "deliverables", dotScheduleService: "schedules", designService: "design", videoService: "video" });
    expect(gateway.executeMcpToolWithPolicy).not.toBe(deps.executeMcpToolWithPolicy);
    const run = gateway.executeMcpToolWithPolicy as (input: unknown, request: unknown) => Promise<unknown>;
    await expect(run({ tool: "space_status" }, { id: "request-1" })).resolves.toBe("mcp-result");
    expect(mcpCalls).toEqual([[{ tool: "space_status" }, { id: "request-1" }]]);
  });
});
