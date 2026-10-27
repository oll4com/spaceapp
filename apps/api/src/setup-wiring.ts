import { join } from "node:path";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { SetupPlan, SetupTask } from "@space/contracts";
import { SetupExecutionCoordinator, type SetupActionAdapter, type SpaceStore } from "@space/runtime";
import type { AgentSessionHistoryService } from "./agent-session-history.js";
import type { AuthConfig } from "./auth.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import type { CredentialHost } from "./cli-auth-transfer.js";
import type { SpaceApiConfig } from "./config.js";
import { databasesService } from "./databases/databases-service.js";
import { recordAudit } from "./request-audit.js";
import { registerSetupAssistantRoutes } from "./setup-assistant.js";
import { createSetupBrowserCheck } from "./setup-browser-check.js";
import { createSetupCapabilityChecks } from "./setup-capability-checks.js";
import { SetupClientRuntimeVerification, registerSetupClientRuntimeRoutes, setupClientRuntimeBuildId } from "./setup-client-runtime-verification.js";
import type { SetupConnectionCheckRunManager } from "./setup-connection-check-runs.js";
import type { SetupConnectionsService } from "./setup-connections.js";
import { registerSetupExecutionRoutes } from "./setup-execution-routes.js";
import { createSetupFunctionalChecks } from "./setup-local-runtime-checks.js";
import { checkNativeSetupFreeModel, nativeFreeModelSelectionSupported, selectNativeSetupFreeModel } from "./setup-native-model-selection.js";
import { SetupOwnerVoiceRuntime } from "./setup-owner-voice-runtime.js";
import { createSetupRoomAgentCheck } from "./setup-room-agent-check.js";
import { registerSetupRoutes } from "./setup-routes.js";
import { createSetupSelectedServiceAdapters } from "./setup-selected-services.js";
import { SetupVoiceCredentials } from "./setup-voice-credentials.js";
import { registerSetupVoiceRoutes } from "./setup-voice-routes.js";
import { SetupVoiceVerification } from "./setup-voice-verification.js";
import { createStoredSetupVncAdapter } from "./setup-vnc-check.js";
import type { SourceControlService } from "./source-control/service.js";
import type { StreamingService } from "./streaming-service.js";

/** createApp options that only First Setup reads (tests replace its actions, Live provider and installation files). */
export interface FirstSetupAppOptions {
  setupActionAdapterFor?: (task: SetupTask, ownerId: string, plan: SetupPlan) => SetupActionAdapter | null;
  setupActionPumpEnabled?: boolean;
  /** The selected Live connection's proof and its provider recheck at finish (tests replace the real provider). */
  setupLiveVoice?: { fingerprint: (ownerId: string) => Promise<string | null>; reauthorize: (ownerId: string) => Promise<boolean> };
  setupMemoryRoot?: string;
  setupHandoffRoot?: string;
}

/**
 * First Setup's routes and server checks (owner setup, the wizard's plan and run, Live voice, the setup assistant and every
 * selected tool's check), composed from the services createApp already built.
 */
export async function registerFirstSetup(app: FastifyInstance, deps: {
  options: FirstSetupAppOptions; config: SpaceApiConfig; store: SpaceStore; auth: AuthConfig;
  publicCredentialHost: CredentialHost | null; setupConnections: SetupConnectionsService;
  setupConnectionCheckRuns: SetupConnectionCheckRunManager; routeOptions: Pick<RouteShorthandOptions, "config">;
  quotaProviders: Record<"codex" | "antigravity" | "api", () => Promise<unknown>>;
  readSystemHealth: () => Promise<unknown>; streamingService: StreamingService;
  sourceControlService: Pick<SourceControlService, "bindings">; browserSessionManager: BrowserSessionManagerWithHostHealth;
  visibleCliRuntimeIds: () => Promise<string[]>; agentSessionHistoryService: Pick<AgentSessionHistoryService, "list">;
  onOwnerClaimed: () => void;
}) {
  const { options, config, store, auth, publicCredentialHost, streamingService } = deps;
  const setupVoiceCredentials = new SetupVoiceCredentials(join(config.demoProjectsVarRoot, "..", "voice-secrets"), config);
  const setupOwnerVoiceRuntime = new SetupOwnerVoiceRuntime({ config, credentials: setupVoiceCredentials });
  const setupVoiceVerification = new SetupVoiceVerification({ store, credentials: setupVoiceCredentials, config });
  registerSetupVoiceRoutes(app, { store, credentials: setupVoiceCredentials, verification: setupVoiceVerification,
    uiOrigin: config.browserEvidenceTargetOrigin,
    audit: (request, providerId) => recordAudit(store, request, { action: "setup.voice.credential.saved",
      targetType: "voice_provider", targetId: providerId, metadata: { scope: "OWNER" } }) });
  registerSetupAssistantRoutes(app, { store, memoryRoot: options.setupMemoryRoot ?? process.env.SPACE_MEMORY_ROOT,
    handoffRoot: options.setupHandoffRoot ?? process.env.SPACE_INSTALLATION_HANDOFF_ROOT, installationSecret: auth.sessionSecret,
    scratchRoot: join(config.demoProjectsVarRoot, "setup-checks"), uiOrigin: config.browserEvidenceTargetOrigin,
    // A public install's core has no OpenCode (1.1.7 decision B): the assistant answers through the CLI container.
    ...(publicCredentialHost ? { openCodeText: publicCredentialHost.openCodeText, openCodeModels: publicCredentialHost.openCodeModels } : {}) });
  const setupClientRuntimeVerification = new SetupClientRuntimeVerification(store, await setupClientRuntimeBuildId());
  registerSetupClientRuntimeRoutes(app, { verification: setupClientRuntimeVerification, uiOrigin: config.browserEvidenceTargetOrigin });
  const setupExecution = registerSetupExecutionRoutes(app, {
    store,
    uiOrigin: config.browserEvidenceTargetOrigin,
    connections: deps.setupConnections,
    voiceFingerprint: options.setupLiveVoice?.fingerprint ?? ((ownerId) => setupVoiceVerification.currentFingerprint(ownerId)),
    selectedServices: { ...createSetupSelectedServiceAdapters({ databases: databasesService, streaming: streamingService }),
      "pane:vnc": createStoredSetupVncAdapter(store) },
    installationSecret: auth.sessionSecret,
    memoryRoot: options.setupMemoryRoot,
    handoffRoot: options.setupHandoffRoot,
    actionAdapterFor: options.setupActionAdapterFor,
    actionPumpEnabled: options.setupActionPumpEnabled,
    // The public OpenCode wrapper's select-free-model probes the chosen model with a real tool call and writes the CLI's
    // model only on a pass; until the installed wrapper lists it, the wizard shows the choice disabled.
    // On a public install the CLI's config lives only in its container, so the pick goes through its credential agent.
    ...(publicCredentialHost ? {
      selectFreeModel: (choice: string) => selectNativeSetupFreeModel(publicCredentialHost, "opencode-vscode-parity", choice),
      freeModelSelectable: () => nativeFreeModelSelectionSupported(publicCredentialHost, "opencode-vscode-parity")
    } : {}),
    capabilityChecks: { ...setupClientRuntimeVerification.capabilityChecks(), ...createSetupCapabilityChecks({
      store,
      readQuotaSources: async () => (await Promise.allSettled(Object.entries(deps.quotaProviders).map(async ([kind, read]) =>
        ({ kind: kind as "codex" | "antigravity" | "api", snapshot: await read() }))))
        .flatMap(source => source.status === "fulfilled" ? [source.value] : []),
      readSystemHealth: deps.readSystemHealth,
      checkStreamingMetrics: async () => {
        const snapshot = await streamingService.overlaySnapshot();
        if (!snapshot.tiles.some(tile => tile.state === "FRESH" && tile.value !== null)) throw new Error("Streaming metrics source is unavailable.");
      },
      checkSourceControl: async (ownerId) => { await deps.sourceControlService.bindings(ownerId); }
    }) },
    functionalChecks: { ...createSetupFunctionalChecks({ store, demoRoot: config.demoProjectsRoot, demoEnabled: config.demoProjectsEnabled,
      workspaceRoot: process.env.SPACE_WORKSPACE_ROOT || "/opt/spaceapp",
      scratchRoot: join(config.demoProjectsVarRoot, "setup-checks") }),
      ...(config.browserSessionsEnabled ? { "pane:browser": createSetupBrowserCheck({ store, manager: deps.browserSessionManager,
        origin: config.browserEvidenceTargetOrigin, profileRoot: config.browserSessionsProfileRoot }) } : {}),
      ...(config.cliEnabled ? { "dock:room-agent": createSetupRoomAgentCheck({ memoryRoot: options.setupMemoryRoot,
        scratchRoot: join(config.demoProjectsVarRoot, "setup-checks"),
        ...(publicCredentialHost ? { openCodeModels: publicCredentialHost.openCodeModels,
          checkFreeModel: (modelId: string) => checkNativeSetupFreeModel(publicCredentialHost, "opencode-vscode-parity", modelId) } : {}) }) } : {}) },
    checkAgentSessions: async () => {
      const runtimeIds = await deps.visibleCliRuntimeIds();
      if (!runtimeIds.includes("cli:codex")) runtimeIds.push("cli:codex");
      await deps.agentSessionHistoryService.list({ page: 1, pageSize: 1, runtimeIds });
    },
    audit: (request, action, targetId) => recordAudit(store, request, {
      action, targetType: "owner_setup", targetId,
      metadata: { protocolVersion: 2 }
    })
  });

  registerSetupRoutes(app, {
    execution: { coordinator: () => new SetupExecutionCoordinator(store), inspectTask: setupExecution.inspectTask,
      memoryRoot: options.setupMemoryRoot, handoffRoot: options.setupHandoffRoot,
      liveReauthorize: options.setupLiveVoice?.reauthorize ?? ((ownerId) => setupVoiceVerification.reauthorize(ownerId)) },
    auth, store, setupConnections: deps.setupConnections, setupConnectionCheckRuns: deps.setupConnectionCheckRuns,
    routeOptions: deps.routeOptions, optionalModules: [...config.optionalModules], onOwnerClaimed: deps.onOwnerClaimed
  });
  return { setupOwnerVoiceRuntime, setupVoiceCredentials };
}
