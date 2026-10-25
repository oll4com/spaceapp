import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@space/contracts";
import { cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import {
  checkCliRuntimeCredential,
  credentialSmokeTimeoutForRuntime,
  observeCliRuntimeCredential
} from "../src/cli-runtimes.js";

function runtime(id: string): AgentRuntime {
  const descriptor = cliRuntimeDescriptors.find((candidate) => candidate.id === id)!;
  return {
    id,
    providerId: descriptor.providerId,
    providerName: descriptor.providerName,
    agentId: descriptor.key,
    agentName: descriptor.agentName,
    displayName: descriptor.agentName,
    capabilities: ["CLI"],
    adapterStatus: "ENABLED",
    authMode: descriptor.authMode,
    authState: "READY",
    authReason: "Credential material is present.",
    canStartLogin: false,
    status: "ENABLED",
    statusReason: "Credential material is present.",
    commandName: descriptor.commandName,
    detectedCommandPath: `/controlled/${descriptor.commandName}`,
    defaultModelId: descriptor.defaultModelId,
    supportedReasoningEfforts: [],
    checkedAt: "2026-07-29T09:00:00.000Z"
  };
}

describe("setup credential check runtime", () => {
  it("observes the login through the given executor (the public credential host) and locally without one", async () => {
    const execute = vi.fn(async () => ({ stdout: `OBSERVATION:${"b".repeat(64)}\n` }));
    await expect(observeCliRuntimeCredential(runtime("cli:opencode"), execute)).resolves.toBe("b".repeat(64));
    expect(execute).toHaveBeenCalledWith("/controlled/opencode-vscode-parity", ["credential-observation"], expect.objectContaining({ maxBuffer: 256 }));

    // Space itself (no credential host): the wrapper runs here, as before.
    const wrapper = join(await mkdtemp(join(tmpdir(), "space-observe-")), "wrapper");
    await writeFile(wrapper, `#!/bin/sh\n[ "$1" = credential-observation ] && printf 'OBSERVATION:${"c".repeat(64)}\\n'\n`);
    await chmod(wrapper, 0o755);
    await expect(observeCliRuntimeCredential({ ...runtime("cli:opencode"), detectedCommandPath: wrapper }, undefined)).resolves.toBe("c".repeat(64));
  });

  it("allows 180-second Codex wrappers to finish instead of timing out at 155 seconds", async () => {
    expect(credentialSmokeTimeoutForRuntime("cli:codex")).toBe(190_000);
    expect(credentialSmokeTimeoutForRuntime("cli:kimi")).toBe(190_000);
    expect(credentialSmokeTimeoutForRuntime("cli:gemini")).toBe(130_000);

    const execute = vi.fn(async (
      _commandPath: string,
      _args: readonly string[],
      options: { timeout: number }
    ) => {
      expect(options.timeout).toBe(190_000);
      return { stdout: "SPACE_CODEX_OK\n" };
    });
    await expect(checkCliRuntimeCredential(runtime("cli:codex"), execute)).resolves.toEqual({
      outcome: "VERIFIED"
    });
  });

  it("uses the same home and CLI credential paths as the terminal runtime", async () => {
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    await expect(checkCliRuntimeCredential(
      runtime("cli:qwen"),
      async (_commandPath, _args, options) => {
        childEnvironment = options.env;
        return { stdout: "SPACE_QWEN_OK\n" };
      }
    )).resolves.toEqual({ outcome: "VERIFIED" });

    expect(childEnvironment?.HOME).toBe(process.env.HOME ?? "/var/lib/spaceapp-user");
    expect(childEnvironment?.QWEN_HOME).toBe("/var/lib/spaceapp-user/.codex/space-qwen");
    expect(childEnvironment?.QWEN_RUNTIME_DIR).toBe("/var/lib/spaceapp-user/.codex/space-qwen/runtime");
  });

  it("recognizes only the bounded quota marker as quota limited", async () => {
    await expect(checkCliRuntimeCredential(
      runtime("cli:kimi"),
      async () => ({ stdout: "SPACE_KIMI_QUOTA_LIMITED\n" })
    )).resolves.toEqual({ outcome: "QUOTA_LIMITED" });

    await expect(checkCliRuntimeCredential(
      runtime("cli:kimi"),
      async () => ({ stdout: "quota-ish provider prose\n" })
    )).resolves.toEqual({ outcome: "PROVIDER_FAILED" });
  });

  it("keeps process timeouts distinct from provider failures", async () => {
    await expect(checkCliRuntimeCredential(
      runtime("cli:codex"),
      async () => {
        throw Object.assign(new Error("command timed out"), {
          code: "ETIMEDOUT",
          killed: true,
          signal: "SIGTERM"
        });
      }
    )).resolves.toEqual({ outcome: "TIMED_OUT" });

    await expect(checkCliRuntimeCredential(
      runtime("cli:codex"),
      async () => {
        throw Object.assign(new Error("provider rejected request"), {
          code: 64,
          killed: false,
          signal: null
        });
      }
    )).resolves.toEqual({ outcome: "PROVIDER_FAILED" });
  });
});
