import { describe, expect, it } from "vitest";
import {
  agentRuntimeRegistrySchema,
  type AgentRuntime,
  type AgentRuntimeRegistry,
  type SetupConnectionCheckStage
} from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import {
  createSetupConnectionsService,
  summarizeSetupConnections
} from "../src/setup-connections.js";

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

function registry(): AgentRuntimeRegistry {
  return agentRuntimeRegistrySchema.parse({
    data: cliRuntimeDescriptors.map((descriptor) => runtime(descriptor.id)),
    checkedAt: "2026-07-29T09:00:00.000Z"
  });
}

describe("functional setup connections", () => {
  it("summarizes 15 functional, 4 live verified, and 1 needing setup", async () => {
    const store = new InMemorySpaceStore();
    const fingerprints = new Map(
      cliRuntimeDescriptors
        .filter((descriptor) => descriptor.id !== "cli:autohand")
        .map((descriptor, index) => [descriptor.id, (index + 1).toString(16).padStart(64, "0")])
    );
    for (const descriptor of cliRuntimeDescriptors.slice(0, 4)) {
      await store.upsertSetupConnectionVerification({
        connectionId: descriptor.id,
        state: "CONNECTED",
        reasonCode: null,
        fingerprintHash: fingerprints.get(descriptor.id)!,
        verifiedAt: "2026-07-29T09:00:00.000Z",
        updatedAt: "2026-07-29T09:00:00.000Z"
      });
    }
    const service = createSetupConnectionsService({
      store,
      discoverRuntimes: async () => registry(),
      observeCredential: async (candidate) => fingerprints.get(candidate.id) ?? null,
      now: () => "2026-07-29T10:00:00.000Z"
    });

    const connections = await service.overview();
    expect(summarizeSetupConnections(connections)).toEqual({
      total: 16,
      functional: 15,
      liveVerified: 4,
      needsSetup: 1
    });
    expect(connections.find((connection) => connection.id === "cli:autohand")).toMatchObject({
      state: "NEEDS_SETUP",
      functionalState: "NEEDS_SETUP",
      liveVerificationState: "NOT_CHECKED",
      reasonCode: "CREDENTIAL_REQUIRED"
    });
  });

  it("keeps quota exhaustion functional without claiming live verification", async () => {
    const store = new InMemorySpaceStore();
    const service = createSetupConnectionsService({
      store,
      discoverRuntimes: async () => registry(),
      observeCredential: async () => "a".repeat(64),
      checkCredential: async () => ({ outcome: "QUOTA_LIMITED" }),
      now: () => "2026-07-29T10:00:00.000Z"
    });

    await expect(service.verify("cli:kimi")).resolves.toMatchObject({
      state: "CONNECTED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "QUOTA_LIMITED",
      reasonCode: "PROVIDER_QUOTA_LIMITED",
      verifiedAt: null,
      actions: ["VERIFY"]
    });
  });

  it("keeps generic provider failure functional and distinct from quota", async () => {
    const store = new InMemorySpaceStore();
    const stages: SetupConnectionCheckStage[] = [];
    const service = createSetupConnectionsService({
      store,
      discoverRuntimes: async () => registry(),
      observeCredential: async () => "b".repeat(64),
      checkCredential: async () => ({ outcome: "PROVIDER_FAILED" }),
      now: () => "2026-07-29T10:00:00.000Z"
    });

    await expect(service.verify("cli:codex", async (stage) => {
      stages.push(stage);
    })).resolves.toMatchObject({
      state: "CONNECTED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "PROVIDER_FAILED",
      reasonCode: "PROVIDER_CHECK_FAILED"
    });
    expect(stages).toEqual([
      "Detecting CLI",
      "Checking saved credential",
      "Sending live provider challenge",
      "Confirming credential identity",
      "Saving result",
      "Provider failed"
    ]);
  });

  it("emits ordered stages and fails live evidence closed when identity changes", async () => {
    const store = new InMemorySpaceStore();
    let observation = "c".repeat(64);
    const stages: SetupConnectionCheckStage[] = [];
    const service = createSetupConnectionsService({
      store,
      discoverRuntimes: async () => registry(),
      observeCredential: async () => observation,
      checkCredential: async () => {
        observation = "d".repeat(64);
        return { outcome: "VERIFIED" };
      },
      now: () => "2026-07-29T10:00:00.000Z"
    });

    await expect(service.verify("cli:gemini", async (stage) => {
      stages.push(stage);
    })).resolves.toMatchObject({
      state: "CONNECTED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "CREDENTIAL_CHANGED",
      reasonCode: "CREDENTIAL_CHANGED_DURING_VERIFICATION"
    });
    expect(stages).toEqual([
      "Detecting CLI",
      "Checking saved credential",
      "Sending live provider challenge",
      "Confirming credential identity",
      "Saving result",
      "Credential changed"
    ]);
  });
});
