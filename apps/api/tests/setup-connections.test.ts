import { describe, expect, it } from "vitest";
import {
  agentRuntimeRegistrySchema,
  type AgentRuntime,
  type AgentRuntimeRegistry,
  type SetupConnection
} from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createSetupConnectionsService } from "../src/setup-connections.js";

function runtime(
  id: string,
  input: Partial<AgentRuntime> = {}
): AgentRuntime {
  const key = id.replace("cli:", "");
  return {
    id,
    providerId: key,
    providerName: key,
    agentId: key,
    agentName: `${key} CLI`,
    displayName: `${key} CLI`,
    capabilities: ["CLI"],
    adapterStatus: "ENABLED",
    authMode: "DEVICE_CODE",
    authState: "LOGIN_REQUIRED",
    authReason: "Login is required.",
    canStartLogin: true,
    status: "NOT_CONNECTED",
    statusReason: "Login is required.",
    commandName: `${key}-vscode-parity`,
    detectedCommandPath: `/controlled/${key}-vscode-parity`,
    defaultModelId: null,
    supportedReasoningEfforts: [],
    checkedAt: "2026-07-29T09:00:00.000Z",
    ...input
  };
}

describe("setup connection verification", () => {
  it("requires a matching credential fingerprint and a real smoke before reporting live verification", async () => {
    const store = new InMemorySpaceStore();
    let geminiFingerprint: string | null = "a".repeat(64);
    let smokeSucceeds = true;
    const registry: AgentRuntimeRegistry = agentRuntimeRegistrySchema.parse({
      data: [
        runtime("cli:codex"),
        runtime("cli:claude", {
          authMode: "MANAGED",
          authState: "READY",
          authReason: "Managed credential material is present.",
          canStartLogin: false,
          status: "ENABLED",
          statusReason: "Managed credential material is present."
        }),
        runtime("cli:gemini", {
          authState: "READY",
          authReason: "Credential material is present.",
          canStartLogin: false,
          status: "ENABLED",
          statusReason: "Credential material is present."
        }),
        runtime("cli:qwen", {
          adapterStatus: "ERROR",
          authState: "UNAVAILABLE",
          authReason: "The CLI executable is unavailable.",
          canStartLogin: false,
          status: "ERROR",
          statusReason: "The CLI executable is unavailable.",
          detectedCommandPath: null
        })
      ],
      checkedAt: "2026-07-29T09:00:00.000Z"
    });
    const service = createSetupConnectionsService({
      store,
      discoverRuntimes: async () => registry,
      observeCredential: async (candidate) =>
        candidate.id === "cli:gemini"
          ? geminiFingerprint
          : candidate.id === "cli:claude"
            ? "e".repeat(64)
            : null,
      smokeCredential: async (candidate) =>
        candidate.id === "cli:gemini" && smokeSucceeds,
      now: () => "2026-07-29T09:30:00.000Z"
    });

    const initial = await service.overview();
    expect(initial.find((connection) => connection.id === "cli:codex")).toMatchObject({
      state: "NEEDS_SETUP",
      reasonCode: "CREDENTIAL_REQUIRED",
      actions: ["OPEN_LOGIN_PANE", "VERIFY"]
    });
    expect(initial.find((connection) => connection.id === "cli:gemini")).toMatchObject({
      state: "CONNECTED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "NOT_CHECKED",
      reasonCode: "NOT_VERIFIED",
      actions: ["VERIFY"]
    });
    expect(initial.find((connection) => connection.id === "cli:claude")).toMatchObject({
      state: "CONNECTED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "NOT_CHECKED",
      reasonCode: "NOT_VERIFIED",
      actions: ["VERIFY"]
    });
    expect(initial.find((connection) => connection.id === "cli:qwen")).toMatchObject({
      state: "UNAVAILABLE",
      reasonCode: "CLI_RUNTIME_UNAVAILABLE"
    });

    const verified = await service.verify("cli:gemini");
    expect(verified).toMatchObject({
      id: "cli:gemini",
      state: "CONNECTED",
      reasonCode: null,
      verifiedAt: "2026-07-29T09:30:00.000Z"
    });
    expect(verified.staleAt).toBe("2026-08-28T09:30:00.000Z");
    expect(await store.getSetupConnectionVerification("cli:gemini")).toEqual({
      connectionId: "cli:gemini",
      state: "CONNECTED",
      reasonCode: null,
      fingerprintHash: "a".repeat(64),
      verifiedAt: "2026-07-29T09:30:00.000Z",
      updatedAt: "2026-07-29T09:30:00.000Z"
    });

    expect(await service.overview()).toContainEqual(verified);

    geminiFingerprint = "b".repeat(64);
    expect(await service.overview()).toContainEqual(
      expect.objectContaining({
        id: "cli:gemini",
        state: "CONNECTED",
        functionalState: "FUNCTIONAL",
        liveVerificationState: "CREDENTIAL_CHANGED",
        reasonCode: "CREDENTIAL_CHANGED"
      })
    );

    smokeSucceeds = false;
    const failed = await service.verify("cli:gemini");
    expect(failed).toMatchObject({
      state: "CONNECTED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "PROVIDER_FAILED",
      reasonCode: "PROVIDER_CHECK_FAILED",
      verifiedAt: null
    });
    expect((await store.getSetupConnectionVerification("cli:gemini"))?.state).toBe("CONNECTED");
  });

  it("fails closed for unknown connection ids and verifies available connections in bulk", async () => {
    const store = new InMemorySpaceStore();
    let discoveryCalls = 0;
    const completedConnectionIds: string[] = [];
    const registry: AgentRuntimeRegistry = agentRuntimeRegistrySchema.parse({
      data: [runtime("cli:codex")],
      checkedAt: "2026-07-29T09:00:00.000Z"
    });
    const service = createSetupConnectionsService({
      store,
      discoverRuntimes: async () => {
        discoveryCalls += 1;
        return registry;
      },
      observeCredential: async () => "c".repeat(64),
      smokeCredential: async () => true,
      now: () => "2026-07-29T10:00:00.000Z"
    });

    await expect(service.verify("cli:not-real")).rejects.toThrow("was not found");
    const connections = await service.verifyAll(undefined, async (connectionId, connection) => {
      expect(connection).not.toBeNull();
      completedConnectionIds.push(connectionId);
    });
    expect(connections.find((connection) => connection.id === "cli:codex")).toMatchObject({
      state: "CONNECTED",
      verifiedAt: "2026-07-29T10:00:00.000Z"
    });
    expect(discoveryCalls).toBe(1);
    expect(completedConnectionIds).toHaveLength(16);
  });

  it("does not retain a stale missing-credential reason after credential material appears", async () => {
    const store = new InMemorySpaceStore();
    await store.upsertSetupConnectionVerification({
      connectionId: "cli:codex",
      state: "NEEDS_SETUP",
      reasonCode: "CREDENTIAL_REQUIRED",
      fingerprintHash: null,
      verifiedAt: null,
      updatedAt: "2026-07-29T09:00:00.000Z"
    });
    const registry: AgentRuntimeRegistry = agentRuntimeRegistrySchema.parse({
      data: [runtime("cli:codex")],
      checkedAt: "2026-07-29T09:00:00.000Z"
    });
    const service = createSetupConnectionsService({
      store,
      discoverRuntimes: async () => registry,
      observeCredential: async () => "d".repeat(64),
      smokeCredential: async () => true,
      now: () => "2026-07-29T10:00:00.000Z"
    });

    expect(await service.overview()).toContainEqual(
      expect.objectContaining({
        id: "cli:codex",
        state: "CONNECTED",
        functionalState: "FUNCTIONAL",
        liveVerificationState: "NOT_CHECKED",
        reasonCode: "NOT_VERIFIED"
      })
    );
  });

  it("reports a safe per-CLI completion when one bulk verification throws", async () => {
    const store = new InMemorySpaceStore();
    const completions = new Map<string, SetupConnection | null>();
    const registry: AgentRuntimeRegistry = agentRuntimeRegistrySchema.parse({
      data: [runtime("cli:codex"), runtime("cli:gemini")],
      checkedAt: "2026-07-29T09:00:00.000Z"
    });
    const service = createSetupConnectionsService({
      store,
      discoverRuntimes: async () => registry,
      observeCredential: async () => "e".repeat(64),
      checkCredential: async (candidate) => {
        if (candidate.id === "cli:codex") {
          throw new Error("sensitive provider failure");
        }
        return { outcome: "VERIFIED" };
      },
      now: () => "2026-07-29T10:00:00.000Z"
    });

    await expect(service.verifyAll(undefined, async (connectionId, connection) => {
      completions.set(connectionId, connection);
    })).rejects.toThrow("One or more setup connection verifications failed.");
    expect(completions.size).toBe(16);
    expect(completions.get("cli:codex")).toBeNull();
    expect(completions.get("cli:gemini")).toMatchObject({
      functionalState: "FUNCTIONAL",
      liveVerificationState: "VERIFIED"
    });
  });
});
