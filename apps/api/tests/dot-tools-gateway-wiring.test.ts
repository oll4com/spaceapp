import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn(async (path: string) => {
    if (!files.has(path)) throw new Error("ENOENT");
    return files.get(path);
  })
}));
const captured = vi.hoisted(() => ({ deps: undefined as unknown, options: undefined as unknown }));
vi.mock("../src/dot-tools-gateway.js", () => ({
  registerDotToolGatewayRoutes: (_app: unknown, deps: unknown, options: unknown) => { captured.deps = deps; captured.options = options; }
}));

const { registerDotToolGatewayWiring } = await import("../src/dot-tools-gateway-wiring.js");

type Deps = Record<string, (...args: never[]) => Promise<unknown>>;
const root = "/evidence";
const registry = "/opt/spaceapp/bin/tool-routing-current/mcp-registry.json";

function wire(overrides: Record<string, unknown> = {}) {
  const sendMessage = vi.fn(async () => undefined);
  const action = vi.fn();
  registerDotToolGatewayWiring({} as never, {
    store: {
      listMcpServers: async () => [{ id: "srv:1", displayName: "One", status: "VERIFIED" }],
      listMcpTools: async () => [{ id: "tool:1", serverId: "srv:1", name: "t", status: "VERIFIED", approvalRequired: false, statusReason: null }],
      listActivePaneBrowserSessions: async () => [{ paneId: "pane:browser" }],
      getPane: async (id: string) => ({ id, roomId: "room:other", mode: "BROWSER" }),
      getActiveSpaceAgentSession: async () => ({ sessionId: "agent:live" })
    } as never,
    config: { browserEvidenceArtifactRoot: root, mcpToolBridgeEnabled: true, browserSessionsEnabled: true, browserToolBridgeEnabled: true } as never,
    auth: { sessionSecret: "secret" },
    cookieName: "space_session",
    defaultRouteRateLimitOptions: {},
    dotsRepository: {} as never,
    dotHomeRepository: null,
    dotEvalsRepository: null,
    controlUser: vi.fn() as never,
    spaceControlRoutes: { call: vi.fn() },
    executeMcpToolWithPolicy: (async () => ({ status: "DONE", message: "ok", artifact: { metadata: { localPath: `${root}/mcp-executions/r.json` } } })) as never,
    browserSessionManager: { action } as never,
    vault: { protection: { ownerOf: async () => null, release: async () => true } },
    spaceAgentAdapter: { sendMessage } as never,
    connectorService: { client: (provider: string) => (provider === "GOOGLE" ? {} : null), catalog: async () => { throw new Error("down"); } } as never,
    dotChannelService: {
      status: async () => ({ providers: [{ provider: "TELEGRAM", configured: true }, { provider: "SLACK", configured: false }], identities: [{ provider: "TELEGRAM" }] }),
      toolSend: async () => { throw new Error("chat not found"); }
    } as never,
    dotGoalService: null, dotComputerService: null, dotDelegationService: null, dotMemoryService: null, dotDeliverablesService: null, dotScheduleService: null,
    designService: undefined, videoService: undefined,
    ...overrides
  } as never);
  return { deps: captured.deps as Deps, options: captured.options as { authenticatedOwner(request: unknown): Promise<string> }, sendMessage, action };
}

describe("Dot tool gateway wiring", () => {
  beforeEach(() => { files.clear(); captured.deps = undefined; });

  it("answers unavailable without Dots storage and refuses an unauthenticated owner", async () => {
    const { deps, options } = wire({ dotsRepository: null });
    expect(deps).toBeNull();
    await expect(options.authenticatedOwner({ user: undefined, cookies: {} })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(options.authenticatedOwner({ user: { id: "u" }, cookies: { space_session: "forged" } })).rejects.toThrow("Sign in to use Dots.");
  });

  it("builds the catalog context: linked channels, connector fallback, tool availability and the installed servers", async () => {
    files.set(registry, JSON.stringify({ servers: [{ id: "space_vision", description: "Vision" }, { id: 7 }] }));
    const context = await wire().deps.catalogContext({ roomId: "room:one", role: "OWNER", ownerUserId: "user:1" } as never) as Record<string, unknown>;
    expect(context).toMatchObject({
      channels: [{ provider: "TELEGRAM", configured: true, linked: true }, { provider: "SLACK", configured: false, linked: false }],
      connectorAccounts: [], connectorProviders: { google: true, microsoft: false },
      browserPaneIds: ["pane:browser"],
      mcpTools: [{ toolId: "tool:1", serverName: "One", available: true }],
      installedMcpServers: [{ serverId: "space_vision", description: "Vision" }]
    });
    files.clear();
    const off = wire({ config: { browserEvidenceArtifactRoot: root, mcpToolBridgeEnabled: false } });
    const closed = await off.deps.catalogContext({ roomId: "room:one", role: "OWNER" } as never) as Record<string, unknown>;
    expect(closed).toMatchObject({ mcpTools: [{ available: false, statusReason: "The Space MCP tool bridge is disabled." }], installedMcpServers: [] });
    expect(closed).not.toHaveProperty("channels");
  });

  it("runs MCP tools only with the bridge on and reads results only under the MCP root", async () => {
    const { deps } = wire();
    expect(await deps.executeMcp({} as never, {} as never)).toEqual({ status: "DONE", message: "ok", artifactLocalPath: `${root}/mcp-executions/r.json` });
    const off = wire({ config: { browserEvidenceArtifactRoot: root, mcpToolBridgeEnabled: false } });
    expect(await off.deps.executeMcp({} as never, {} as never)).toMatchObject({ status: "BLOCKED", artifactLocalPath: null });
    expect(await deps.readMcpResult("/etc/passwd" as never)).toEqual({ message: "The MCP result is stored as a Space artifact." });
    files.set(`${root}/mcp-executions/r.json`, JSON.stringify({ result: { rows: 2 } }));
    expect(await deps.readMcpResult(`${root}/mcp-executions/../mcp-executions/r.json` as never)).toEqual({ rows: 2 });
  });

  it("refuses browser actions when the bridge is off or the pane is in another room", async () => {
    const off = wire({ config: { browserEvidenceArtifactRoot: root, browserSessionsEnabled: true, browserToolBridgeEnabled: false } });
    await expect(off.deps.executeBrowser({} as never, {} as never)).rejects.toThrow("Managed browser tools are disabled.");
    const { deps, action } = wire();
    await expect(deps.executeBrowser({ roomId: "room:one", targetPaneId: "pane:browser", agentSessionId: "a", action: { type: "extract_text" } } as never, {} as never))
      .rejects.toThrow("was not found in room room:one");
    expect(action).not.toHaveBeenCalled();
  });

  it("turns a failed channel send into BLOCKED and continues only the pane's live agent session", async () => {
    const { deps, sendMessage } = wire();
    expect(await deps.channelTool({} as never, "user:1" as never, "send" as never, {} as never)).toEqual({ status: "BLOCKED", statusReason: "Sending failed: chat not found" });
    const input = { sessionId: "agent:old", paneId: "pane:browser", ownerUserId: "user:1", content: "go", requestKey: "k" };
    expect(await deps.continueAfterApproval(input as never)).toBe(false);
    expect(await deps.continueAfterApproval({ ...input, sessionId: "agent:live" } as never)).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(await deps.confirmExternalActions("user:1" as never)).toBe(true);
    expect(deps.goalTool).toBeUndefined();
  });
});
