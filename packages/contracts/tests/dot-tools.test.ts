import { describe, expect, it } from "vitest";
import {
  buildDotToolCatalog,
  classifyDotControlAction,
  needsDotApproval,
  dotForbiddenResourceOperations,
  dotToolEntrySchema,
  isNativeAgentRuntime,
  nativeAgentServerDenial,
  searchDotTools,
  type DotToolCatalogContext
} from "../src/index.js";

const context = (overrides: Partial<DotToolCatalogContext> = {}): DotToolCatalogContext => ({
  role: "USER", browserSessionsEnabled: true, browserPaneIds: [],
  mcpTools: [
    { toolId: "space-readonly:space_status", serverName: "Space readonly", name: "space_status", available: true, approvalRequired: false, statusReason: null },
    { toolId: "space-readonly:space_authenticated_ui_proof", serverName: "Space readonly", name: "space_authenticated_ui_proof", available: true, approvalRequired: true, statusReason: null }
  ],
  installedMcpServers: [{ serverId: "space_ops", description: "Ops" }, { serverId: "playwright", description: "Browser automation" }],
  ...overrides
});

describe("Space Dots tool catalog", () => {
  it("describes every Control tool and resource with real schemas and never offers tests, deploys or CLI grants", () => {
    const catalog = buildDotToolCatalog(context());
    for (const entry of catalog) expect(dotToolEntrySchema.safeParse(entry).success).toBe(true);
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(catalog.length);
    const execute = catalog.find((entry) => entry.id === "space.execute")!;
    expect(execute.availability).toBe("AVAILABLE");
    expect(Object.keys(execute.inputSchema.properties as object)).toContain("actions");
    expect(Object.keys(execute.inputSchema.properties as object)).not.toContain("userExplicitlyAuthorized");
    for (const operation of dotForbiddenResourceOperations) {
      expect(catalog.find((entry) => entry.id === `resource.${operation}`)?.availability).toBe("FORBIDDEN");
    }
    expect(catalog.find((entry) => entry.id === "installed.space_ops")?.availability).toBe("FORBIDDEN");
    expect(catalog.find((entry) => entry.id === "installed.playwright")).toMatchObject({ availability: "AVAILABLE", invocation: "DISPATCHER" });
    expect(catalog.find((entry) => entry.id === "space.screenshot")).toMatchObject({ availability: "AVAILABLE", risk: "READ" });
  });

  it("derives role, risk and availability from the current context", () => {
    const user = buildDotToolCatalog(context());
    const admin = buildDotToolCatalog(context({ role: "ADMIN", browserPaneIds: ["pane:browser"] }));
    expect(user.find((entry) => entry.id === "resource.settings.update")).toMatchObject({ availability: "FORBIDDEN", requiredRole: "ADMIN" });
    expect(admin.find((entry) => entry.id === "resource.settings.update")?.availability).toBe("AVAILABLE");
    expect(user.find((entry) => entry.id === "resource.tasks.delete")?.risk).toBe("DESTRUCTIVE");
    expect(user.find((entry) => entry.id === "resource.tasks.list")?.risk).toBe("READ");
    // Without a Browser pane the Dot opens its own with computer.browser; browser tools default to it.
    expect(user.find((entry) => entry.id === "browser.navigate")).toMatchObject({ availability: "AVAILABLE" });
    expect(user.find((entry) => entry.id === "computer.browser")).toMatchObject({ source: "SPACE_COMPUTER", risk: "WRITE", availability: "AVAILABLE" });
    const navigate = admin.find((entry) => entry.id === "browser.navigate")!;
    expect(navigate.availability).toBe("AVAILABLE");
    expect(navigate.inputSchema.required).toEqual(["url"]);
    expect(JSON.stringify(navigate.inputSchema.properties)).toContain("pane:browser");
    // Email and calendar: unavailable without a provider, needs a connection, then available per granted permission.
    expect(user.find((entry) => entry.id === "mail.search")).toMatchObject({ source: "CONNECTOR", availability: "UNAVAILABLE" });
    const providers = { connectorProviders: { google: true, microsoft: false } };
    expect(buildDotToolCatalog(context(providers)).find((entry) => entry.id === "mail.search")?.availability).toBe("NEEDS_CONNECTION");
    const reader = buildDotToolCatalog(context({ ...providers, connectorAccounts: [{ provider: "GOOGLE", email: "a@example.com", capabilities: ["MAIL_READ"] }] }));
    expect(reader.find((entry) => entry.id === "mail.read")?.availability).toBe("AVAILABLE");
    expect(reader.find((entry) => entry.id === "mail.send")?.availability).toBe("NEEDS_CONNECTION");
    const disabled = buildDotToolCatalog(context({ browserSessionsEnabled: false }));
    expect(disabled.find((entry) => entry.id === "computer.browser")?.availability).toBe("UNAVAILABLE");
    expect(disabled.find((entry) => entry.id === "browser.navigate")?.availability).toBe("UNAVAILABLE");
    expect(user.find((entry) => entry.id === "mcp.space-readonly.space_status")?.availability).toBe("AVAILABLE");
    expect(user.find((entry) => entry.id === "mcp.space-readonly.space_authenticated_ui_proof")?.availability).toBe("UNAVAILABLE");
  });

  it("exposes native tool schemas without the internal discriminator", () => {
    const catalog = buildDotToolCatalog(context());
    const search = catalog.find((entry) => entry.id === "memory.search")!;
    expect(search.inputSchema.required).toEqual(["q"]);
    expect(Object.keys(search.inputSchema.properties as object)).not.toContain("type");
    expect(catalog.find((entry) => entry.id === "clipboard.save_plan")?.inputSchema.required).toEqual(expect.arrayContaining(["text", "minimumModel"]));
  });

  it("searches available tools by id and description, hiding unavailable ones by default", () => {
    const catalog = buildDotToolCatalog(context());
    expect(searchDotTools(catalog, { query: "memory" }).map((entry) => entry.id)).toEqual(["dot_memory.forget", "dot_memory.recall", "dot_memory.remember",
      "dot_memory.update", "memory.save", "memory.search"]);
    expect(searchDotTools(catalog, { source: "SPACE_MEMORY" }).every((entry) => entry.id.startsWith("dot_memory."))).toBe(true);
    expect(searchDotTools(catalog, { query: "deploy" })).toEqual([]);
    expect(searchDotTools(catalog, { query: "deploy", includeUnavailable: true }).map((entry) => entry.id)).toContain("resource.ops.deploy");
    expect(searchDotTools(catalog, { source: "SPACE_CONTROL" }).every((entry) => entry.source === "SPACE_CONTROL")).toBe(true);
    expect(searchDotTools(catalog, { limit: 3 })).toHaveLength(3);
    expect(searchDotTools(catalog, { query: "close pane" }).map((entry) => entry.id)).toContain("space.execute");
    expect("inputSchema" in searchDotTools(catalog, { query: "memory" })[0]!).toBe(false);
  });

  it("denies protected dispatcher servers only to native runtimes", () => {
    expect(isNativeAgentRuntime("native:dot")).toBe(true);
    expect(isNativeAgentRuntime("cli:codex")).toBe(false);
    expect(isNativeAgentRuntime(undefined)).toBe(false);
    expect(nativeAgentServerDenial("space_ops", "native:dot")).toMatch(/never available/);
    expect(nativeAgentServerDenial("space-control", "native:dot")).toMatch(/gateway/);
    expect(nativeAgentServerDenial("playwright", "native:dot")).toBeNull();
    expect(nativeAgentServerDenial("space_ops", "cli:codex")).toBeNull();
    expect(nativeAgentServerDenial("space_ops", "unknown")).toBeNull();
    for (const id of ["olla", "mission_control", "space_browser", "space_services", "unregistered"]) expect(nativeAgentServerDenial(id, "native:dot")).not.toBeNull();
    for (const id of ["devtools", "playwright", "scrapling", "space_summary_tools", "space_capturelab", "space_vision", "summary_tools", "capturelab", "vision"]) expect(nativeAgentServerDenial(id, "native:dot")).toBeNull();
  });

  it("classifies actions so instructions to agents, stops and deletions wait for the user", () => {
    const ctx = { role: "USER", dotPaneId: "pane:dot" };
    const pane = (operation: string, paneIds = ["pane:other"]) => ({ kind: "pane", operation, target: { paneIds, state: "ALL" }, when: "AFTER_TURN" }) as never;
    expect(classifyDotControlAction(pane("minimize"), ctx)).toEqual({ risk: "WRITE", forbidden: null });
    for (const operation of ["prompt", "continue", "close", "stop", "restart"]) expect(classifyDotControlAction(pane(operation), ctx).risk).toBe("SENSITIVE");
    expect(classifyDotControlAction(pane("prompt", ["pane:dot"]), ctx).forbidden).toMatch(/own pane/);
    expect(classifyDotControlAction(pane("visual_audit"), ctx).risk).toBe("READ");
    expect(classifyDotControlAction({ kind: "native_command", target: { paneIds: ["pane:x"], state: "ALL" }, command: "/model", when: "NOW" } as never, ctx).risk).toBe("SENSITIVE");
    expect(classifyDotControlAction({ kind: "vpn", operation: "set" } as never, ctx).forbidden).toMatch(/administrator/);
    expect(classifyDotControlAction({ kind: "resource", operation: "settings.update", input: {} } as never, { ...ctx, role: "ADMIN" }).risk).toBe("WRITE");
    // Changing the user's Browser panes always needs approval; the Dot's own browser follows the mode.
    for (const operation of ["browser.navigate", "browser.back", "browser.forward", "browser.reload"]) {
      expect(classifyDotControlAction({ kind: "resource", operation, id: "pane:user", input: {} } as never, ctx).risk).toBe("SENSITIVE");
      expect(classifyDotControlAction({ kind: "resource", operation, id: "pane:own", input: {} } as never, { ...ctx, dotBrowserPaneId: "pane:own" }).risk).toBe("WRITE");
    }
    expect(classifyDotControlAction({ kind: "resource", operation: "browser.content", id: "pane:user", input: {} } as never, ctx).risk).toBe("READ");
    // A snapshot moves the rollback pointer, so it is not a read.
    expect(classifyDotControlAction({ kind: "resource", operation: "settings.snapshot", input: {} } as never, { ...ctx, role: "ADMIN" }).risk).toBe("WRITE");
    expect(needsDotApproval("SENSITIVE", "full_access")).toBe(true);
    expect(needsDotApproval("WRITE", "full_access")).toBe(false);
    expect(needsDotApproval("WRITE", "ask_for_approval")).toBe(true);
    expect(needsDotApproval("READ", "ask_for_approval")).toBe(false);
  });

  it("never lets one MCP tool shadow another or exposes protected registry servers", () => {
    const catalog = buildDotToolCatalog(context({ mcpTools: [
      { toolId: "srv:a.b", serverName: "S", name: "a.b", available: true, approvalRequired: false, statusReason: null },
      { toolId: "srv:a_b", serverName: "S", name: "a_b", available: true, approvalRequired: false, statusReason: null },
      { toolId: "space_ops:space_deploy_commit", serverName: "Ops", name: "deploy", available: true, approvalRequired: false, statusReason: null }
    ] }));
    expect(catalog.filter((entry) => entry.source === "MCP")).toEqual([]);
  });
});
