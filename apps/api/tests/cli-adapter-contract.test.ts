import { beforeAll, describe, expect, it } from "vitest";
import { agentRuntimeSchema, type AgentRuntimeRegistry } from "@space/contracts";
import { getApiConfig } from "../src/config.js";
import { discoverAgentRuntimes } from "../src/cli-runtimes.js";

// These expectations distinguish exact identity from a provider's own picker or
// continue flag. Treating either as equivalent would mislead recovery clients.
const expectedResumeModes = [
  ["cli:opencode", ["REFERENCE", "PROVIDER_SELECTION"]],
  ["cli:codex", ["REFERENCE"]],
  ["cli:claude", ["REFERENCE", "PROVIDER_SELECTION"]],
  ["cli:gemini", ["PROVIDER_SELECTION"]],
  ["cli:autohand", []],
  ["cli:qwen", ["PROVIDER_SELECTION"]],
  ["cli:kimi", ["PROVIDER_SELECTION"]],
  ["cli:grok", ["PROVIDER_SELECTION"]],
  ["cli:deepseek", ["REFERENCE"]],
  ["cli:cursor", ["PROVIDER_SELECTION"]],
  ["cli:copilot", ["PROVIDER_SELECTION"]],
  ["cli:hermes", ["PROVIDER_SELECTION"]],
  ["cli:omp", ["PROVIDER_SELECTION"]],
  ["cli:qoder", ["PROVIDER_SELECTION"]],
  ["cli:muse", ["PROVIDER_SELECTION"]],
  ["cli:droid", ["PROVIDER_SELECTION"]]
] as const;

describe("CLI adapter contract negotiation", () => {
  let registry: AgentRuntimeRegistry;
  beforeAll(async () => {
    // Declaration does not require a provider, credentials or execution.
    registry = await discoverAgentRuntimes(getApiConfig({ SPACE_CLI_ENABLED: "false" }));
  });

  it.each(expectedResumeModes)("declares the recovery identity supported by %s", (runtimeId, nativeResumeModes) => {
    const runtime = registry.data.find(item => item.id === runtimeId)!;
    expect(runtime.status).toBe("DISABLED");
    expect(runtime.cliAdapter).toMatchObject({
      contractVersion: 1,
      operations: {
        start: "PTY_SPAWN",
        send: "PTY_INPUT",
        interrupt: "PROCESS_TERMINATE",
        inspect: "HOST_PROCESS",
        events: "PTY_OUTPUT_AND_PROCESS_EXIT",
        reconnect: "LIVE_HOST_PROCESS"
      },
      nativeResumeModes,
      evidence: "DECLARED_ONLY",
      context: { owner: "PROVIDER_NATIVE", spaceCompaction: "NONE", usageReporting: "UNAVAILABLE" }
    });
    // Static declaration must never certify installation or turn opaque cost
    // into measured zero usage.
    expect(runtime.cliAdapter).not.toHaveProperty("installedVersion");
    expect(runtime.cliAdapter).not.toHaveProperty("cost");
  });

  it("distinguishes an observed completion from an exited PTY", () => {
    const completion = Object.fromEntries(registry.data.filter(item => item.cliAdapter)
      .map(item => [item.id, item.cliAdapter!.completion]));
    expect(completion["cli:codex"]).toBe("CODEX_ROLLOUT");
    expect(completion["cli:opencode"]).toBe("OPENCODE_NATIVE_STATUS");
    expect(completion["cli:claude"]).toBe("UNAVAILABLE_FAIL_CLOSED");
    expect(completion["cli:deepseek"]).toBe("UNAVAILABLE_FAIL_CLOSED");
    expect(registry.data.find(item => item.id === "cli:root")?.cliAdapter).toBeUndefined();
    expect(registry.data.find(item => item.id === "web:codex-app-server")?.cliAdapter).toBeUndefined();
  });

  it("rejects an unknown contract version instead of silently stripping negotiation data", () => {
    const runtime = registry.data.find(item => item.id === "cli:opencode")!;
    expect(agentRuntimeSchema.safeParse({ ...runtime, cliAdapter: { ...runtime.cliAdapter, contractVersion: 2 } }).success)
      .toBe(false);
  });

  it("accepts only structured limitations and older declarations without them", () => {
    const runtime = registry.data.find(item => item.id === "cli:autohand")!;
    expect(runtime.cliAdapter?.limitations?.map(item => item.code)).toContain("NATIVE_RESUME_UNSUPPORTED");
    const withLimitation = (limitation: Record<string, string>) =>
      agentRuntimeSchema.safeParse({ ...runtime, cliAdapter: { ...runtime.cliAdapter, limitations: [limitation] } }).success;
    expect(withLimitation({ operation: "start", code: "WORKS_DIFFERENTLY", detail: "free-form claim" })).toBe(false);
    expect(withLimitation({ operation: "teleport", code: "NATIVE_RESUME_UNSUPPORTED", detail: "x" })).toBe(false);
    const { limitations: _limitations, ...older } = runtime.cliAdapter!;
    expect(agentRuntimeSchema.parse({ ...runtime, cliAdapter: older }).cliAdapter).not.toHaveProperty("limitations");
  });

  it("preserves older registry records without inventing capabilities", () => {
    const { cliAdapter: _declaration, ...legacy } = registry.data.find(item => item.id === "cli:opencode")!;
    expect(agentRuntimeSchema.parse(legacy)).not.toHaveProperty("cliAdapter");
  });
});
