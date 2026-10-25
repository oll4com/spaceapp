import { describe, it, expect } from "vitest";
import { buildEffectiveToolPlan, canonicalMcpServerId, claudeCodeRuntimeCapabilities, defaultToolRoutingState, nativeAgentServerDenial, resolveToolRoute, spaceToolPolicies, updateToolRoutingSchema, type ModelCapabilityProfileV1 } from "../src/tool-routing.js";
const evidence = (state: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN") => ({ state, source: "PROBE" as const, evidence: "test runtime", checkedAt: "2026-09-05T10:00:00.000Z" });
const profile: ModelCapabilityProfileV1 = { version: 1, runtimeId: "cli:codex", modelId: "gpt-6-astra", capabilities: { vision: evidence("AVAILABLE"), shell: evidence("AVAILABLE") } };
const vision = spaceToolPolicies.find((entry) => entry.toolId === "mcp:space_vision")!;
describe("capability-first routing", () => {
  it("reports legacy startup accurately outside the Codex canary", () => {
    const state = defaultToolRoutingState();
    expect(buildEffectiveToolPlan(state, { ...profile, runtimeId: "cli:opencode" }).registration).toBe("LEGACY_CONFIG");
    state.enabledRuntimeIds = [];
    expect(buildEffectiveToolPlan(state, profile).registration).toBe("LEGACY_CONFIG");
    expect(updateToolRoutingSchema.safeParse({ expectedRevision: 0, enabledRuntimeIds: ["cli:opencode"], overrides: [] }).success).toBe(false);
  });
  it("starts Claude Code without MCP like Codex, with runtime-verified capabilities", () => {
    const claude: ModelCapabilityProfileV1 = { version: 1, runtimeId: "cli:claude", modelId: "unknown", capabilities: claudeCodeRuntimeCapabilities("2026-10-11T00:00:00.000Z") };
    expect(defaultToolRoutingState().enabledRuntimeIds).toEqual(["cli:codex", "cli:claude"]);
    expect(buildEffectiveToolPlan(defaultToolRoutingState(), claude).registration).toBe("NONE");
    expect(resolveToolRoute(vision, claude, [], { taskNeedsTool: true }).route).toBe("NATIVE");
    expect(updateToolRoutingSchema.safeParse({ expectedRevision: 0, enabledRuntimeIds: ["cli:codex", "cli:claude"], overrides: [] }).success).toBe(true);
    expect(updateToolRoutingSchema.safeParse({ expectedRevision: 0, enabledRuntimeIds: ["cli:claude", "cli:claude"], overrides: [] }).success).toBe(false);
  });
  it("keeps native shell runtimes free of MCP registration independently of model names", () => {
    for (const modelId of ["gpt-6-astra", "unrecognized-model"]) {
      expect(buildEffectiveToolPlan(defaultToolRoutingState(), { ...profile, modelId }).registration).toBe("NONE");
    }
  });
  it("never sends native images to fallback even when fallback is allowed", () => {
    expect(resolveToolRoute(vision, profile, [{ toolId: "*", runtimeId: "*", modelId: "*", mode: "ALLOW_FALLBACK" }], { taskNeedsTool: true }).route).toBe("NATIVE");
  });
  it("allows image fallback only for a verified missing input capability", () => {
    expect(resolveToolRoute(vision, { ...profile, capabilities: {} }, [], { taskNeedsTool: true }).route).toBe("UNAVAILABLE");
    expect(resolveToolRoute(vision, { ...profile, capabilities: { vision: evidence("UNAVAILABLE") } }, [], { taskNeedsTool: true }).route).toBe("ON_DEMAND");
  });
  it("gives the most specific model/runtime/tool override precedence", () => {
    const overrides = [
      { toolId: "*", runtimeId: "*", modelId: "*", mode: "DISABLED" as const },
      { toolId: "mcp:vision", runtimeId: "cli:codex", modelId: "gpt-6-astra", mode: "AUTOMATIC" as const }
    ];
    // The pre-2026-10-13 id of a stored override still names the renamed server.
    expect(resolveToolRoute(vision, profile, overrides).route).toBe("NATIVE");
  });
  it("names every Space server with the space prefix and keeps the old ids as aliases", () => {
    expect(canonicalMcpServerId("vision")).toBe("space_vision");
    expect(canonicalMcpServerId("playwright_pane")).toBe("space_playwright_pane");
    expect(canonicalMcpServerId("capturelab")).toBe("space_capturelab");
    expect(canonicalMcpServerId("devtools")).toBe("devtools");
    expect(nativeAgentServerDenial("vision", "native:dot")).toBeNull();
    expect(nativeAgentServerDenial("playwright_pane", "native:dot")).toMatch(/CLI session that owns the pane/);
    const spaceOwned = spaceToolPolicies.filter((entry) => entry.category === "SPACE_EXCLUSIVE" || entry.toolId === "mcp:space_vision")
      .map((entry) => entry.toolId.slice(4)).filter((id) => !["olla", "mission_control"].includes(id));
    expect(spaceOwned.filter((id) => !id.startsWith("space"))).toEqual([]);
  });
  it("does not infer browser capability from native vision or model name", () => {
    const browser = spaceToolPolicies.find((entry) => entry.toolId === "mcp:devtools")!;
    expect(resolveToolRoute(browser, profile, [], { taskNeedsTool: true }).route).toBe("UNAVAILABLE");
  });
  it("keeps protected Space access on demand without changing backend authorization", () => {
    const ops = spaceToolPolicies.find((entry) => entry.toolId === "mcp:space_ops")!;
    expect(resolveToolRoute(ops, profile, [], { taskNeedsTool: true }).route).toBe("ON_DEMAND");
    expect(resolveToolRoute(ops, profile, [{ toolId: "*", runtimeId: "*", modelId: "*", mode: "NATIVE_ONLY" }], { taskNeedsTool: true }).route).toBe("UNAVAILABLE");
  });
  it("starts Context7 on demand without a native capability, honors operator overrides and keeps it from Native agents", () => {
    const context7 = spaceToolPolicies.find((entry) => entry.toolId === "mcp:context7")!;
    expect(resolveToolRoute(context7, profile, [], { taskNeedsTool: true }).route).toBe("ON_DEMAND");
    expect(resolveToolRoute(context7, { ...profile, capabilities: {} }, [], { taskNeedsTool: true }).route).toBe("ON_DEMAND");
    expect(resolveToolRoute(context7, profile, [{ toolId: "mcp:context7", runtimeId: "*", modelId: "*", mode: "DISABLED" }], { taskNeedsTool: true }).route).toBe("DISABLED");
    expect(resolveToolRoute(context7, profile, [{ toolId: "*", runtimeId: "*", modelId: "*", mode: "NATIVE_ONLY" }], { taskNeedsTool: true }).route).toBe("UNAVAILABLE");
    expect(nativeAgentServerDenial("context7", "native:dot")).toBe("This server is not available to Native agents.");
    expect(nativeAgentServerDenial("context7", "cli:opencode")).toBeNull();
  });
  it("does not force summarization or accept conflicting duplicate overrides", () => {
    const summary = spaceToolPolicies.find((entry) => entry.toolId === "mcp:space_summary_tools")!;
    expect(resolveToolRoute(summary, profile, [], { taskNeedsTool: true }).route).toBe("UNAVAILABLE");
    const override = { toolId: "*", runtimeId: "*", modelId: "*", mode: "DISABLED" };
    expect(updateToolRoutingSchema.safeParse({ expectedRevision: 0, enabledRuntimeIds: [], overrides: [override, override] }).success).toBe(false);
  });
});
