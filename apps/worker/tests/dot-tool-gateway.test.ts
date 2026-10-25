import { describe, expect, it, vi } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import {
  dotGatewayDeveloperInstructions,
  dotGatewayDynamicTools,
  handleDotToolCall,
  nativeChatThreadConfig,
  type DotToolCallContext
} from "../src/dot-tool-gateway.js";

const dotId = `dot:${"c".repeat(32)}`;
function setup(entry: Record<string, unknown> = {}) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Dots gateway", initialPaneCount: 1 }, "trace:room");
  const pane = store.listPanes(room.id)[0]!;
  store.upsertClipboardItem({ ownerUserId: "user:owner", text: "Owner clip", source: "MANUAL_NOTE" });
  const turnInput = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt: "Use Space tools.",
    agentSessionId: "agent_session:dot", agentAssistantMessageId: "agent_msg:a", agentRunId: "agent_run:dot",
    operatorUserId: "user:owner", dotId, toolGateway: "space-dot-tools-v1", traceId: "trace:dot" });
  const invocations = new Map<string, { status: string; statusReason: string | null; resultSummary: string | null }>();
  const repository = {
    startToolInvocation: vi.fn(async (input: { callId: string | null }) => {
      const existing = input.callId ? invocations.get(input.callId) : undefined;
      if (existing) return { created: false, running: existing.status === "RUNNING",
        invocation: { invocationId: "dot_tool:existing", status: existing.status, statusReason: existing.statusReason, resultSummary: existing.resultSummary } };
      if (input.callId) invocations.set(input.callId, { status: "RUNNING", statusReason: null, resultSummary: null });
      return { created: true, running: true, invocation: { invocationId: `dot_tool:${input.callId}` } };
    }),
    finishToolInvocation: vi.fn(async (id: string, result: { status: string; statusReason?: string | null; resultSummary?: string | null }) => {
      invocations.set(id.slice("dot_tool:".length), { status: result.status, statusReason: result.statusReason ?? null, resultSummary: result.resultSummary ?? null });
      return null;
    })
  };
  const tool = { id: "clipboard.list", title: "List clipboard", description: "List", source: "SPACE_NATIVE", risk: "READ", requiredRole: "USER",
    availability: "AVAILABLE", statusReason: null, invocation: "GATEWAY", inputSchema: { type: "object" }, ...entry };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/catalog") && body.describe) return Response.json({ tool: { ...tool, id: body.describe.toolId } });
    if (url.endsWith("/catalog")) return Response.json({ tools: [tool], total: 80, available: 50 });
    return Response.json({ status: "COMPLETED", statusReason: null, toolId: body.toolId, result: { ok: true } });
  });
  const context: DotToolCallContext = { turnInput, config: { internalApiBaseUrl: "http://api.test", internalApiToken: "internal-token" },
    store, repository: repository as never, fetchImpl: fetchImpl as unknown as typeof fetch };
  return { context, fetchImpl, repository, store };
}
const request = (tool: string, args: Record<string, unknown>, callId = "call-1") => ({ id: 7, method: "item/tool/call", params: { tool, callId, arguments: args } });
const text = (response: { contentItems: Array<{ text: string }> }) => JSON.parse(response.contentItems[0]!.text);

describe("Dot tool gateway in the worker", () => {
  it("declares three schema-validated native functions and the native dispatcher identity", () => {
    expect(dotGatewayDynamicTools().map((tool) => tool.name)).toEqual(["space_search_tools", "space_describe_tool", "space_call_tool"]);
    expect(nativeChatThreadConfig("/opt/spaceapp/bin/space-mcp-dispatcher.mjs", { codexConfigToml: "" })).toEqual({
      "mcp_servers.space_dispatcher.command": "/usr/bin/node", "mcp_servers.space_dispatcher.args": ["/opt/spaceapp/bin/space-mcp-dispatcher.mjs"],
      "mcp_servers.space_dispatcher.env.SPACE_AGENT_RUNTIME_ID": "native:dot", "shell_environment_policy.set.SPACE_AGENT_RUNTIME_ID": "native:dot" });
    // Installations without the dispatcher never receive a partial server definition.
    expect(nativeChatThreadConfig(null)).toEqual({ "shell_environment_policy.set.SPACE_AGENT_RUNTIME_ID": "native:dot" });
    expect(dotGatewayDeveloperInstructions("You are Luna.")).toMatch(/^You are Luna\.[\s\S]*space_search_tools/);
  });

  it("restricts the dispatcher under every name the Codex config declares", () => {
    // A Codex config from before the 2026-10-13 rename declares mcp_dispatcher; an unrestricted
    // second dispatcher would bypass the Native agent checks.
    const legacy = nativeChatThreadConfig("/d.mjs", { codexConfigToml: "[mcp_servers.mcp_dispatcher]\ncommand = \"node\"\n" });
    expect(legacy).toMatchObject({ "mcp_servers.mcp_dispatcher.env.SPACE_AGENT_RUNTIME_ID": "native:dot" });
    expect(legacy).not.toHaveProperty("mcp_servers.space_dispatcher.command");
    const both = nativeChatThreadConfig("/d.mjs", { codexConfigToml: "[mcp_servers.space_dispatcher]\n[mcp_servers.mcp_dispatcher.env]\n" });
    expect(both).toMatchObject({ "mcp_servers.space_dispatcher.env.SPACE_AGENT_RUNTIME_ID": "native:dot",
      "mcp_servers.mcp_dispatcher.env.SPACE_AGENT_RUNTIME_ID": "native:dot" });
  });

  it("keeps the Dot workspace writable and limits proactive work to dispatcher discovery", () => {
    expect(nativeChatThreadConfig("/d.mjs", { writableRoots: ["/opt/spaceapp/var/dots/workspaces/abc"], proactive: true, codexConfigToml: "" })).toMatchObject({
      "sandbox_workspace_write.writable_roots": ["/opt/spaceapp/var/dots/workspaces/abc"],
      "mcp_servers.space_dispatcher.enabled_tools": ["space_list_mcp_servers", "space_mcp_server_info", "space_list_skills", "space_get_skill",
        "list_mcp_servers", "mcp_server_info", "list_skills", "get_skill"] });
    expect(nativeChatThreadConfig("/d.mjs", { codexConfigToml: "" })).not.toHaveProperty("mcp_servers.space_dispatcher.enabled_tools");
    expect(nativeChatThreadConfig("/d.mjs", { writableRoots: [] })).not.toHaveProperty("sandbox_workspace_write.writable_roots");
  });

  it("searches and describes through the authorized internal API identity", async () => {
    const { context, fetchImpl } = setup();
    const searched = await handleDotToolCall(context, request("space_search_tools", { query: "clipboard" }));
    expect(searched.success).toBe(true);
    expect(text(searched).tools[0].id).toBe("clipboard.list");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/internal/dots/tools/catalog");
    expect((init!.headers as Record<string, string>)["x-space-internal-token"]).toBe("internal-token");
    expect(JSON.parse(String(init!.body)).identity).toMatchObject({ dotId, agentSessionId: "agent_session:dot", operatorUserId: "user:owner",
      workflowId: expect.stringMatching(/^workflow:codex-app-server:/) });
    expect(text(await handleDotToolCall(context, request("space_describe_tool", { toolId: "memory.search" }))).id).toBe("memory.search");
  });

  it("runs native tools through the existing bridge and records one receipt per call", async () => {
    const { context, repository } = setup();
    const result = await handleDotToolCall(context, request("space_call_tool", { toolId: "clipboard.list", arguments: { pageSize: 5 } }));
    expect(result.success).toBe(true);
    expect(text(result)).toMatchObject({ status: "COMPLETED", toolId: "clipboard.list", receipt: "dot_tool:call-1" });
    expect(text(result).result).toContain("Owner clip");
    expect(repository.startToolInvocation).toHaveBeenCalledWith(expect.objectContaining({ dotId, runId: "agent_run:dot", callId: "call-1",
      toolId: "clipboard.list", source: "SPACE_NATIVE", risk: "READ" }));
    expect(repository.finishToolInvocation).toHaveBeenCalledWith("dot_tool:call-1", expect.objectContaining({ status: "COMPLETED" }));
  });

  it("never repeats a retried call and reports an unknown outcome instead of guessing", async () => {
    const { context, fetchImpl } = setup({ id: "space.execute", source: "SPACE_CONTROL", risk: "WRITE" });
    await handleDotToolCall(context, request("space_call_tool", { toolId: "space.execute", arguments: { actions: [] } }));
    const replay = await handleDotToolCall(context, request("space_call_tool", { toolId: "space.execute", arguments: { actions: [] } }));
    expect(text(replay).note).toMatch(/not repeated/);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/call"))).toHaveLength(1);
    const { context: crashed, repository } = setup({ id: "space.execute", source: "SPACE_CONTROL" });
    repository.startToolInvocation.mockResolvedValueOnce({ created: false, running: true, invocation: { invocationId: "dot_tool:x" } } as never);
    expect(text(await handleDotToolCall(crashed, request("space_call_tool", { toolId: "space.execute", arguments: {} }))).status).toBe("UNKNOWN");
  });

  it("passes its receipt id so the API can park a sensitive call, and reports it as a successful wait", async () => {
    const { context, fetchImpl } = setup({ id: "space.execute", source: "SPACE_CONTROL", risk: "WRITE" });
    fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/catalog")) return Response.json({ tool: { id: body.describe.toolId, source: "SPACE_CONTROL", risk: "WRITE", availability: "AVAILABLE" } });
      return Response.json({ status: "APPROVAL_REQUIRED", statusReason: "Waiting for the user's approval: close pane:x", toolId: body.toolId, invocationId: body.invocationId });
    });
    const result = await handleDotToolCall(context, request("space_call_tool", { toolId: "space.execute", arguments: { actions: [] } }));
    expect(result.success).toBe(true);
    expect(text(result)).toMatchObject({ status: "APPROVAL_REQUIRED", next: expect.stringMatching(/end your turn/) });
    expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)![1]!.body)).invocationId).toBe("dot_tool:call-1");
  });

  it("runs a native change that needs approval only on an unused approval of the same call", async () => {
    const { context, repository, fetchImpl, store } = setup({ id: "clipboard.save", risk: "WRITE" });
    context.turnInput = { ...context.turnInput, permissionMode: "ask_for_approval" };
    const grants = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("dot_tool:approved");
    Object.assign(repository, { consumeApprovedNativeCall: grants });
    // No approval yet: the API parks the request for the owner and nothing is saved.
    fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/catalog")) return Response.json({ tool: { id: body.describe.toolId, source: "SPACE_NATIVE", risk: "WRITE", availability: "AVAILABLE" } });
      return Response.json({ status: "APPROVAL_REQUIRED", statusReason: "Waiting for the user's approval: Save to your clipboard", toolId: body.toolId });
    });
    const args = { toolId: "clipboard.save", arguments: { text: "Approved note" } };
    expect(text(await handleDotToolCall(context, request("space_call_tool", args, "call-1")))).toMatchObject({ status: "APPROVAL_REQUIRED" });
    expect(store.listClipboardItems({ ownerUserId: "user:owner" }).items.map((item) => item.text)).not.toContain("Approved note");
    // After the owner approves, the same call runs once in the worker.
    expect(text(await handleDotToolCall(context, request("space_call_tool", args, "call-2")))).toMatchObject({ status: "COMPLETED" });
    expect(grants).toHaveBeenLastCalledWith("agent_session:dot", "clipboard.save", { text: "Approved note" });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/call"))).toHaveLength(1);
  });

  it("keeps proactive work read-only in the worker too", async () => {
    const { context, repository, fetchImpl } = setup({ id: "clipboard.save", risk: "WRITE" });
    context.turnInput = { ...context.turnInput, dotWorkMode: "PROACTIVE" };
    const result = await handleDotToolCall(context, request("space_call_tool", { toolId: "clipboard.save", arguments: { text: "x" } }));
    expect(text(result)).toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/read-only/) });
    expect(repository.startToolInvocation).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/call"))).toHaveLength(0);
    const mcp = setup({ id: "mcp.space-readonly.space_status", source: "MCP", risk: "READ" });
    mcp.context.turnInput = { ...mcp.context.turnInput, dotWorkMode: "PROACTIVE" };
    expect(text(await handleDotToolCall(mcp.context, request("space_call_tool", { toolId: "mcp.space-readonly.space_status", arguments: {} }))))
      .toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/read-only/) });
  });

  it("reconciles before repeating an identical change whose outcome is unknown, then lets the next attempt run", async () => {
    const { context, repository, fetchImpl } = setup({ id: "space.execute", source: "SPACE_CONTROL", risk: "WRITE" });
    const unresolved = vi.fn().mockResolvedValueOnce({ state: "UNKNOWN", startedAt: "2026-10-10T10:00:00.000Z" })
      .mockResolvedValueOnce({ state: "AWAITING_APPROVAL", startedAt: "2026-10-10T10:00:00.000Z" }).mockResolvedValue(null);
    Object.assign(repository, { unresolvedToolCall: unresolved });
    const args = { toolId: "space.execute", arguments: { actions: [] } };
    const first = await handleDotToolCall(context, request("space_call_tool", args, "call-a"));
    expect(text(first)).toMatchObject({ status: "UNKNOWN", statusReason: expect.stringMatching(/^Reconcile first: .*unknown outcome/) });
    expect(repository.finishToolInvocation).toHaveBeenCalledWith("dot_tool:call-a", expect.objectContaining({ status: "BLOCKED" }));
    const second = await handleDotToolCall(context, request("space_call_tool", args, "call-b"));
    expect(text(second).statusReason).toMatch(/already waiting for the user's approval/);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/call"))).toHaveLength(0);
    expect(text(await handleDotToolCall(context, request("space_call_tool", args, "call-c")))).toMatchObject({ status: "COMPLETED" });
    expect(unresolved).toHaveBeenCalledWith("agent_session:dot", "space.execute", { actions: [] });
    // Reads never wait for reconciliation.
    const read = setup({ id: "space.inspect", source: "SPACE_CONTROL", risk: "READ" });
    const readCheck = vi.fn(async () => ({ state: "UNKNOWN", startedAt: "x" }));
    Object.assign(read.repository, { unresolvedToolCall: readCheck });
    expect(text(await handleDotToolCall(read.context, request("space_call_tool", { toolId: "space.inspect", arguments: {} })))).toMatchObject({ status: "COMPLETED" });
    expect(readCheck).not.toHaveBeenCalled();
  });

  it("blocks unavailable tools before recording or executing them", async () => {
    const { context, repository } = setup({ availability: "FORBIDDEN", statusReason: "Tests and deploys are never available to Native agents." });
    const result = await handleDotToolCall(context, request("space_call_tool", { toolId: "resource.ops.deploy", arguments: {} }));
    expect(result.success).toBe(false);
    expect(text(result)).toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/never available/) });
    expect(repository.startToolInvocation).not.toHaveBeenCalled();
  });

  it("returns a failed tool result instead of throwing when the API fails or the identity is incomplete", async () => {
    const { context } = setup({ id: "space.inspect", source: "SPACE_CONTROL" });
    context.fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/catalog")) return Response.json({ tool: { id: body.describe.toolId, source: "SPACE_CONTROL", risk: "READ", availability: "AVAILABLE" } });
      throw Error("connection refused");
    }) as unknown as typeof fetch;
    const failed = await handleDotToolCall(context, request("space_call_tool", { toolId: "space.inspect", arguments: {} }));
    // The request may have reached Space, so the outcome is recorded as unknown, never as "did not happen".
    expect(text(failed)).toMatchObject({ status: "FAILED", statusReason: "Outcome unknown: connection refused" });
    const anonymous = { ...context, turnInput: { ...context.turnInput, dotId: undefined } };
    expect(text(await handleDotToolCall(anonymous, request("space_search_tools", {})))).toMatchObject({ status: "BLOCKED" });
    expect(text(await handleDotToolCall(context, request("unexpected_tool", {})))).toMatchObject({ status: "FAILED" });
  });
});
