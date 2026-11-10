import type { CodexAppServerSocketControlService } from "@space/codex-app-server";
import { SpaceConflictError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { dirname, join } from "node:path";
import { registerAgentToolRoutingRoutes } from "./agent-tool-routing-routes.js";
import { registerAgentToolsLaunchRoutes } from "./agent-tools-launch-routes.js";
import type { AuthConfig } from "./auth.js";
import type { CliAccountBalancer } from "./cli-account-balancer.js";
import { registerCliAccountRoutes } from "./cli-account-routes.js";
import { createCliEgressStatus } from "./cli-egress-status.js";
import { registerCliEgressRoutes } from "./cli-egress-routes.js";
import { createCliLoginOpener } from "./cli-login-opener.js";
import { codexDirectParityCodexHome, isClaudeDirectParityRuntime, isCodexDirectParityRuntime } from "./cli-parity.js";
import { registerCliRuntimeRoutes, registerCliRuntimeSettingsRoutes } from "./cli-runtime-routes.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { registerCliRuntimeCacheInvalidation } from "./cli-runtimes.js";
import { codexPrivateAppServerSocketPath, type CliTerminalManager } from "./cli-terminal.js";
import type { createCliUserHosting } from "./cli-user-hosts.js";
import { createCliVpnApplicationsReader } from "./cli-vpn-applications.js";
import type { CodexCliModeDefaultsService } from "./codex-cli-mode-defaults.js";
import { findCodexWriterThreads } from "./codex-thread-writer.js";
import type { SpaceApiConfig } from "./config.js";
import { registerInstanceReleaseRoutes } from "./instance-release-routes.js";
import { defaultReleasesOptions } from "./instance-releases.js";
import { roomOpenCodeTasks } from "./opencode-room-inspection.js";
import { registerPaneCliRoutes } from "./pane-cli-route-group.js";
import { resolvePaneCodexThreadId } from "./pane-codex-thread.js";
import { assertCliPaneCompatible, assertNormalCliSession, getPaneById } from "./pane-guards.js";
import { claudePaneManagedTurnDriver, claudePlanTarget } from "./plan-execution-claude-driver.js";
import { registerPlanExecutionRoutes } from "./plan-execution-routes.js";
import { recordAudit } from "./request-audit.js";
import { registerServerOpsRoutes, type ServerOpsRunner } from "./server-ops-routes.js";
import type { createRoomCoordination } from "./room-coordination.js";
import type { createRoomShareAccess } from "./room-shares.js";

type PaneCliDeps = Parameters<typeof registerPaneCliRoutes>[1];
type ClaudeDriverDeps = Parameters<typeof claudePaneManagedTurnDriver>[0];
type CliRoutesWiringDeps = Pick<PaneCliDeps, "observability" | "assertRootAdmin" | "assertPaneCliRuntimeEnabled" | "cliPaneReopener"
  | "assertRoomAccess" | "assertCliHttpMutationControl" | "waitForCodexThreadSettings" | "readPaneNativeModelSettings" | "applyNativePaneModel"
  | "readPaneCliModelSettings" | "resolveOpenCodeServerControl" | "readPaneOpenCodeModelSettings" | "applyOpenCodePaneSelection"
  | "assertNoManagedModelMutation" | "roomPaneController">
  & Pick<Parameters<typeof registerCliAccountRoutes>[1], "removeGeminiAccountProfileState" | "removeClaudeAccountProfileState"
    | "removeCopilotAccountProfileState" | "removeCursorAccountProfileState" | "removeKimiAccountProfileState" | "deletingCliAccountProfileKeys"
    | "cliAccountProfileKey" | "readCliAccountProfileDetails" | "cliAccountIdentityCacheTtlMs" | "cliAccountIdentityCache"
    | "readCachedCliAccountIdentity" | "invalidateCliAccountIdentity" | "gatewayCliAccounts">
  & Pick<Parameters<typeof registerCliRuntimeRoutes>[1], "cliRuntimeRegistryCache" | "cliVpnBroker" | "deepSeekHarnessServiceController">
  & Pick<Parameters<typeof registerCliRuntimeSettingsRoutes>[1], "cliVpnSessionPidResolver" | "cliVpnSessionRestarter">
  & {
    store: SpaceStore; config: SpaceApiConfig; cliAccountBalancer: CliAccountBalancer;
    options: { agentToolsOptions?: Parameters<typeof registerAgentToolRoutingRoutes>[1]["agentToolsOptions"];
      releasesOptions?: Parameters<typeof registerInstanceReleaseRoutes>[1]["releases"]; serverOpsRunner?: ServerOpsRunner;
      findCodexThreadId?: Parameters<typeof resolvePaneCodexThreadId>[0]["findThreadId"]; findCodexModelControlThreads?: typeof findCodexWriterThreads };
    auth: Pick<AuthConfig, "sessionSecret">; eventBus: SpaceEventBus; cliTerminalManager: CliTerminalManager; cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
    cliUserHosting: Pick<ReturnType<typeof createCliUserHosting>, "userRegistry">; roomShares: Pick<ReturnType<typeof createRoomShareAccess>, "observeOnly">;
    roomCoordination: Pick<ReturnType<typeof createRoomCoordination>, "registerRoutes">;
    controlRepository: PaneCliDeps["repository"]; controlUser: (id: string) => Promise<NonNullable<Parameters<PaneCliDeps["assertRoomAccess"]>[1]>>;
    codexCliModeDefaultsService: Pick<CodexCliModeDefaultsService, "read">; codexSocketControlFactory: (socketPath: string) => CodexAppServerSocketControlService;
    inspectRoomCli: ClaudeDriverDeps["inspect"]; readClaudeLiveTurns: ClaudeDriverDeps["readTurns"];
    defaultRouteRateLimitOptions: RouteShorthandOptions & Pick<RouteShorthandOptions, "config">; defaultWebsocketRateLimitOptions: PaneCliDeps["websocketRouteOptions"];
  };

/** The CLI routes (moved verbatim from app.ts, ARCH-001 step 73): CLI egress status and VPN applications, CLI runtimes and their settings,
 * agent tool routing and launch, the release-train and instance release routes registered among them, CLI egress, CLI accounts and sign-in,
 * the Codex defaults, the pane CLI routes and managed plan execution on Codex and Claude Code panes. Returns what app.ts reads elsewhere. */
export function registerCliRoutes(app: FastifyInstance, deps: CliRoutesWiringDeps) {
  const { store, config, options, auth, eventBus, observability, cliTerminalManager, cliRuntimeVisibility, cliRuntimeRegistryCache, cliUserHosting, roomShares,
    roomCoordination, controlRepository, controlUser, codexCliModeDefaultsService, codexSocketControlFactory, inspectRoomCli, readClaudeLiveTurns,
    defaultRouteRateLimitOptions, defaultWebsocketRateLimitOptions, cliVpnBroker, deepSeekHarnessServiceController, cliVpnSessionPidResolver,
    cliVpnSessionRestarter, assertRootAdmin, assertPaneCliRuntimeEnabled, cliPaneReopener, cliAccountBalancer, assertRoomAccess, assertCliHttpMutationControl,
    waitForCodexThreadSettings, readPaneNativeModelSettings, applyNativePaneModel, readPaneCliModelSettings, resolveOpenCodeServerControl,
    readPaneOpenCodeModelSettings, applyOpenCodePaneSelection, assertNoManagedModelMutation, roomPaneController, removeGeminiAccountProfileState,
    removeClaudeAccountProfileState, removeCopilotAccountProfileState, removeCursorAccountProfileState, removeKimiAccountProfileState,
    deletingCliAccountProfileKeys, cliAccountProfileKey, readCliAccountProfileDetails, cliAccountIdentityCacheTtlMs, cliAccountIdentityCache,
    readCachedCliAccountIdentity, invalidateCliAccountIdentity, gatewayCliAccounts } = deps;
  const { assertCliVpnAvailable, runningDeepSeekHarnessPid, inspectCliVpnStatus, assertDeepSeekHarnessIsolated, readDeepSeekHarnessMaintenanceStatus } =
    createCliEgressStatus({ config, cliVpnBroker, deepSeekHarnessServiceController });

  const readCliVpnApplications = createCliVpnApplicationsReader({ config, store, cliVpnSessionPidResolver, inspectCliVpnStatus });

  registerCliRuntimeCacheInvalidation(app, () => cliRuntimeRegistryCache.invalidate());
  registerCliRuntimeRoutes(app, {
    config, store, cliRuntimeRegistryCache, cliVpnBroker, deepSeekHarnessServiceController,
    routeOptions: defaultRouteRateLimitOptions, assertCliVpnAvailable, runningDeepSeekHarnessPid,
    assertDeepSeekHarnessIsolated, readDeepSeekHarnessMaintenanceStatus, readCliVpnApplications,
    userRegistry: cliUserHosting.userRegistry
  });

  registerAgentToolRoutingRoutes(app, {
    store, agentToolsOptions: options.agentToolsOptions, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  roomCoordination.registerRoutes(app, defaultRouteRateLimitOptions);
  registerInstanceReleaseRoutes(app, { store, releases: options.releasesOptions, managedHere: config.instance === "stable", routeOptions: defaultRouteRateLimitOptions,
    sessionSecret: auth.sessionSecret, grantStateFile: process.env.VITEST === "true" ? null : join(dirname(config.cliAccountBalancerStateFile), "queue-operator-grants.json") });
  // Hidden on public installs, like cli-update: no route, so the web hides the Operations block on 404.
  if (!config.publicDistribution) registerServerOpsRoutes(app, { store, managedHere: config.instance === "stable", routeOptions: defaultRouteRateLimitOptions,
    queueRoot: options.releasesOptions?.stableQueueRoot ?? defaultReleasesOptions.stableQueueRoot, runner: options.serverOpsRunner });

  registerAgentToolsLaunchRoutes(app, {
    config, store, cliRuntimeVisibility, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions
  });

  registerCliEgressRoutes(app, {
    store, config, cliVpnBroker, assertCliVpnAvailable, readCliVpnApplications,
    routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  registerCliRuntimeSettingsRoutes(app, {
    config, store, cliVpnBroker, cliVpnSessionPidResolver, cliVpnSessionRestarter, cliRuntimeVisibility,
    routeOptions: defaultRouteRateLimitOptions, assertCliVpnAvailable, readCliVpnApplications
  });

  const openCliLogin = createCliLoginOpener({
    config, store, eventBus, cliRuntimeVisibility, cliRuntimeRegistryCache, cliTerminalManager
  });
  registerCliAccountRoutes(app, {
    removeGeminiAccountProfileState, removeClaudeAccountProfileState, removeCopilotAccountProfileState,
    removeCursorAccountProfileState, deletingCliAccountProfileKeys, cliAccountProfileKey,
    readCliAccountProfileDetails, cliAccountIdentityCacheTtlMs, cliAccountIdentityCache, readCachedCliAccountIdentity,
    invalidateCliAccountIdentity, store, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions,
    openCliLogin, gatewayCliAccounts, cliAccountBalancer, removeKimiAccountProfileState
  });

  app.get("/api/cli/codex-defaults", defaultRouteRateLimitOptions, async () => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    return codexCliModeDefaultsService.read();
  });

  registerPaneCliRoutes(app, {
    config, store, observability, cliRuntimeRegistryCache, cliTerminalManager, cliRuntimeVisibility, assertRootAdmin,
    assertPaneCliRuntimeEnabled, cliPaneReopener, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions, cliAccountBalancer, repository: controlRepository,
    assertRoomAccess, observeOnly: roomShares.observeOnly, assertCliHttpMutationControl,
    waitForCodexThreadSettings, readPaneNativeModelSettings, applyNativePaneModel, readPaneCliModelSettings,
    resolveOpenCodeServerControl, readPaneOpenCodeModelSettings, applyOpenCodePaneSelection, roomOpenCodeTasks,
    assertNoManagedModelMutation, roomPaneController
  });

  const planExecutionTarget = async (owner: string, paneId: string, expectedSessionId?: string) => {
    const actor = await controlUser(owner);
    if (actor.role !== "ADMIN") throw new SpaceConflictError("Managed execution requires current administrator access.");
    const pane = await getPaneById(store, paneId);
    await assertRoomAccess(pane.roomId, actor);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const session = await store.getActivePaneCliSession(pane.id);
    if (!session || !session.isActive || session.status !== "RUNNING" || (expectedSessionId && session.sessionId !== expectedSessionId) ||
        !(isCodexDirectParityRuntime(session.runtimeId) || isClaudeDirectParityRuntime(session.runtimeId)))
      throw new SpaceConflictError("Managed execution requires the same running Codex or Claude Code session.");
    assertNormalCliSession(session);
    if (isClaudeDirectParityRuntime(session.runtimeId)) return claudePlanTarget(session, (options) => readClaudeLiveTurns(session, options));
    let threadId = await resolvePaneCodexThreadId({store,session,traceId:"managed-plan",findThreadId:options.findCodexThreadId});
    if (!threadId && session.cwd) {
      // Fresh TUI threads have a writer lock before their first persisted turn.
      // Bind only the single writer owned by this exact pane/session, confirmed
      // by that session's private native socket and working directory.
      const candidates = await (options.findCodexModelControlThreads ?? findCodexWriterThreads)({
        codexHome: codexDirectParityCodexHome, paneId: pane.id, sessionId: session.sessionId
      });
      if (candidates.length === 1) {
        const native = await codexSocketControlFactory(codexPrivateAppServerSocketPath(session)).readThread?.(candidates[0]!);
        if (native && native.id === candidates[0] && native.cwd === session.cwd && ['idle','active'].includes(native.status)) {
          await store.claimPaneCliCodexThread(session.sessionId,native.id,"AUTO","managed-plan");
          threadId = native.id;
        }
      }
    }
    if (!threadId || !session.cwd) throw new SpaceConflictError("The Codex session has no confirmed native thread and working directory.");
    return {paneId:pane.id,sessionId:session.sessionId,threadId,cwd:session.cwd};
  };
  registerPlanExecutionRoutes(app, {
    store,
    autoStart: config.instanceJobs["managed-plan-controller"],
    maxStageAttempts: config.planStageMaxAttempts,
    target: planExecutionTarget,
    assertStartControl: async (request, target) => {
      const session = await store.getActivePaneCliSession(target.paneId);
      if (!session || session.sessionId !== target.sessionId) throw new SpaceConflictError("The CLI session changed.");
      await assertCliHttpMutationControl(request, session);
    },
    resolve: async execution => {
      const target = await planExecutionTarget(execution.ownerUserId,execution.paneId,execution.sessionId);
      if (target.threadId !== execution.threadId || target.cwd !== execution.cwd)
        throw new SpaceConflictError("Managed execution identity changed.");
      const session = await store.getPaneCliSession(execution.sessionId);
      if (!session || session.paneId !== execution.paneId) throw new SpaceConflictError("Managed session was not found.");
      if (isClaudeDirectParityRuntime(session.runtimeId)) return claudePaneManagedTurnDriver({ store, terminal: cliTerminalManager, pane: await getPaneById(store, session.paneId),
        session, executionId: execution.id, cwd: target.cwd, readTurns: readClaudeLiveTurns, inspect: inspectRoomCli, settings: readPaneNativeModelSettings, applyModel: applyNativePaneModel, log: (fields, message) => app.log.warn(fields, message) });
      return codexSocketControlFactory(codexPrivateAppServerSocketPath(session));
    },
    publish: async event => {
      eventBus.publish(await store.publishManagedPlanExecutionEvent(event));
    }
  });
  return { readDeepSeekHarnessMaintenanceStatus, readCliVpnApplications, openCliLogin };
}
