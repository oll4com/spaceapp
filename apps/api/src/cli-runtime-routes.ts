import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  type AgentRuntime, type CliEgressRouteId, cliProviderSettingsResponseSchema, cliRuntimeDisablePreviewSchema,
  cliRuntimeSettingsResponseSchema, cliToggleRuntimeIds, cliToggleRuntimeIdSchema,
  harnessMaintenanceRestartResultSchema, type HarnessMaintenanceStatus, type PaneCliSession,
  restartCliRuntimeVpnSessionsResultSchema, updateAllCliProvidersInputSchema, updateCliGlobalEgressInputSchema,
  updateCliGlobalEgressResultSchema, updateCliProviderSettingInputSchema, updateCliRuntimeSettingInputSchema,
  updateCliRuntimeSettingResultSchema, updateCliRuntimeVpnInputSchema, updateCliRuntimeVpnResultSchema,
  updateHarnessEnabledInputSchema, updateHarnessEnabledResultSchema, updateHarnessVpnResultSchema
} from "@space/contracts";
import { nowIso, SpaceConflictError, SpaceFeatureDisabledError, type SpaceStore } from "@space/runtime";
import type { CliVpnApplicationsReader } from "./cli-egress-routes.js";
import { getCliProviderSettings, updateAllCliProviders, updateCliProviderSetting } from "./cli-providers.js";
import { cliRuntimeSettingAuditAction } from "./cli-runtime-pane-restore.js";
import { cliRuntimeSettingParamSchema } from "./cli-runtime-params.js";
import { restartAllCliRuntimes, restartCliRuntimeSessions } from "./cli-runtime-restarts.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import {
  type createAgentRuntimeRegistryCache, discoverAgentRuntimes, findRuntime, isCliRuntimeTerminalLaunchable
} from "./cli-runtimes.js";
import { type CliVpnBroker, CliVpnError } from "./cli-vpn.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import { assertCliPaneCompatible, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import { type DeepSeekHarnessServiceController, restartOpenCodeSharedServer } from "./service-restarts.js";

/**
 * CLI runtime list and settings, CLI provider toggles and the DeepSeek harness VPN/enable/restart controls; the
 * parent retains authentication, CSRF, errors and rate limits.
 */
export function registerCliRuntimeRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  cliRuntimeRegistryCache: ReturnType<typeof createAgentRuntimeRegistryCache>;
  cliVpnBroker: CliVpnBroker;
  deepSeekHarnessServiceController: DeepSeekHarnessServiceController;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  assertCliVpnAvailable: () => void;
  runningDeepSeekHarnessPid: () => Promise<number>;
  assertDeepSeekHarnessIsolated: (pid: number) => Promise<void>;
  readDeepSeekHarnessMaintenanceStatus: () => Promise<HarnessMaintenanceStatus>;
  readCliVpnApplications: CliVpnApplicationsReader;
  /** Multi-user: the registry whose sign-in states come from this user's own CLI container, or null. */
  userRegistry?: (userId: string) => ReturnType<typeof createAgentRuntimeRegistryCache> | null;
}) {
  const { config, store, cliRuntimeRegistryCache, cliVpnBroker, deepSeekHarnessServiceController,
    routeOptions: defaultRouteRateLimitOptions, assertCliVpnAvailable, runningDeepSeekHarnessPid,
    assertDeepSeekHarnessIsolated, readDeepSeekHarnessMaintenanceStatus, readCliVpnApplications, userRegistry } = options;
  app.get("/api/cli/runtimes", defaultRouteRateLimitOptions, async (request) => {
    // A USER with an own CLI container sees whether their own keys and logins are ready, not the owner's.
    const own = request.user?.role === "USER" ? userRegistry?.(request.user.id) : null;
    const registry = await (own ?? cliRuntimeRegistryCache).readStaleWhileRefreshing();
    const settings = new Map((await store.listCliRuntimeSettings()).map((setting) => [setting.runtimeId, setting.enabled]));
    const visible = registry.data.filter((runtime) => {
      const toggleRuntimeId = cliToggleRuntimeIdSchema.safeParse(runtime.id);
      return !toggleRuntimeId.success || settings.get(toggleRuntimeId.data) !== false;
    });
    if (request.user?.role === "ADMIN") return { ...registry, data: visible };
    return { ...registry, data: visible.filter((runtime) => runtime.id !== "cli:root") };
  });
  app.get("/api/cli/runtime-settings", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI runtime settings require the ADMIN role.");
    }
    const [settings, registry] = await Promise.all([
      store.listCliRuntimeSettings(),
      cliRuntimeRegistryCache.readStaleWhileRefreshing()
    ]);
    const vpn = await readCliVpnApplications(settings);
    const harness = await readDeepSeekHarnessMaintenanceStatus();
    return cliRuntimeSettingsResponseSchema.parse({
      settings,
      runtimes: registry.data.filter((runtime) => settings.some((setting) => setting.runtimeId === runtime.id)),
      vpnSupported: config.cliVpnEnabled,
      vpnConnection: vpn.connection,
      vpnApplications: vpn.applications,
      egress: vpn.egress,
      harness,
      checkedAt: nowIso()
    });
  });
  app.get("/api/cli/providers", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI provider settings require the ADMIN role.");
    }
    const settings = await getCliProviderSettings();
    return cliProviderSettingsResponseSchema.parse(settings);
  });
  app.patch("/api/cli/providers/:id", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI provider settings require the ADMIN role.");
    }
    const params = request.params as { id: string };
    const input = parseBody(updateCliProviderSettingInputSchema, request.body ?? {});
    const settings = await updateCliProviderSetting(params.id, input.enabled);
    await recordAudit(store, request, {
      action: input.enabled ? "cli_provider.enable" : "cli_provider.disable",
      targetType: "cli_provider",
      targetId: params.id,
      metadata: { enabled: input.enabled }
    });
    return cliProviderSettingsResponseSchema.parse(settings);
  });
  app.post("/api/cli/providers/toggle-all", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI provider settings require the ADMIN role.");
    }
    const input = parseBody(updateAllCliProvidersInputSchema, request.body ?? {});
    const settings = await updateAllCliProviders(input.enabled);
    await recordAudit(store, request, {
      action: input.enabled ? "cli_provider.enable_all" : "cli_provider.disable_all",
      targetType: "cli_provider",
      targetId: "all",
      metadata: { enabled: input.enabled }
    });
    return cliProviderSettingsResponseSchema.parse(settings);
  });
  app.patch("/api/admin/harness/vpn", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Harness VPN settings require the ADMIN role.");
    }
    if (!config.harnessEnabled) {
      throw new SpaceFeatureDisabledError("HARNESS_DISABLED", "DeepSeek Harness is disabled.");
    }
    assertCliVpnAvailable();
    const input = parseBody(updateCliRuntimeVpnInputSchema, request.body ?? {});
    const previous = await readDeepSeekHarnessMaintenanceStatus();
    let pid = await runningDeepSeekHarnessPid();
    let routed = await cliVpnBroker.setRuntime("cli:harness", input.enabled, [pid]);
    if (!routed.isolatedPids.includes(pid)) {
      await deepSeekHarnessServiceController.restart();
      pid = await runningDeepSeekHarnessPid();
      routed = await cliVpnBroker.setRuntime("cli:harness", input.enabled, [pid]);
    }
    if (!routed.isolatedPids.includes(pid)) {
      await cliVpnBroker.setRuntime("cli:harness", previous.vpnEnabled, [pid]).catch(() => undefined);
      throw new CliVpnError(
        "HARNESS_NETWORK_ISOLATION_FAILED",
        "DeepSeek Harness could not be moved onto the selected protected route.",
        502
      );
    }
    const status = await readDeepSeekHarnessMaintenanceStatus();
    await recordAudit(store, request, {
      action: "harness.vpn.update",
      targetType: "managed_service",
      targetId: "space-deepseek-harness.service",
      metadata: { enabled: input.enabled, effectiveMode: status.effectiveMode, isolated: status.isolated }
    });
    return updateHarnessVpnResultSchema.parse({ status, connection: routed.connection });
  });
  app.patch("/api/admin/harness/enabled", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Harness service settings require the ADMIN role.");
    }
    if (!config.harnessEnabled) {
      throw new SpaceFeatureDisabledError("HARNESS_DISABLED", "DeepSeek Harness is disabled.");
    }
    const input = parseBody(updateHarnessEnabledInputSchema, request.body ?? {});
    const previous = await readDeepSeekHarnessMaintenanceStatus();
    await deepSeekHarnessServiceController.setEnabled(input.enabled);
    if (input.enabled) {
      const pid = await runningDeepSeekHarnessPid();
      if (config.cliVpnEnabled) {
        const routed = await cliVpnBroker.setRuntime("cli:harness", previous.vpnEnabled, [pid]);
        if (!routed.isolatedPids.includes(pid)) {
          await deepSeekHarnessServiceController.setEnabled(false).catch(() => undefined);
          throw new CliVpnError(
            "HARNESS_NETWORK_ISOLATION_FAILED",
            "DeepSeek Harness did not enter its protected network namespace.",
            502
          );
        }
        await assertDeepSeekHarnessIsolated(pid);
      }
    }
    const status = await readDeepSeekHarnessMaintenanceStatus();
    await recordAudit(store, request, {
      action: input.enabled ? "harness.enabled" : "harness.disabled",
      targetType: "managed_service",
      targetId: "space-deepseek-harness.service",
      metadata: { enabled: status.enabled, isolated: status.isolated, effectiveMode: status.effectiveMode }
    });
    return updateHarnessEnabledResultSchema.parse({ status });
  });
  app.post("/api/admin/harness/restart", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Harness restarts require the ADMIN role.");
    }
    if (!config.harnessEnabled) {
      throw new SpaceFeatureDisabledError("HARNESS_DISABLED", "DeepSeek Harness is disabled.");
    }
    assertCliVpnAvailable();
    await deepSeekHarnessServiceController.restart();
    const pid = await runningDeepSeekHarnessPid();
    await assertDeepSeekHarnessIsolated(pid);
    const status = await readDeepSeekHarnessMaintenanceStatus();
    await recordAudit(store, request, {
      action: "harness.restart_requested",
      targetType: "managed_service",
      targetId: "space-deepseek-harness.service",
      metadata: { isolated: status.isolated, effectiveMode: status.effectiveMode }
    });
    return harnessMaintenanceRestartResultSchema.parse({ status });
  });
}

/**
 * Global CLI egress switch, per-runtime settings, VPN routing and its restart flow, and CLI runtime restarts; the
 * parent retains authentication, CSRF, errors and rate limits.
 */
export function registerCliRuntimeSettingsRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  cliVpnBroker: CliVpnBroker;
  cliVpnSessionPidResolver: (sessions: readonly PaneCliSession[]) => Promise<Map<string, number>>;
  cliVpnSessionRestarter: (session: PaneCliSession, runtime: AgentRuntime, traceId: string) => Promise<PaneCliSession>;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  assertCliVpnAvailable: () => void;
  readCliVpnApplications: CliVpnApplicationsReader;
}) {
  const { config, store, cliVpnBroker, cliVpnSessionPidResolver, cliVpnSessionRestarter, cliRuntimeVisibility,
    routeOptions: defaultRouteRateLimitOptions, assertCliVpnAvailable, readCliVpnApplications } = options;
  async function switchGlobalCliEgress(request: FastifyRequest, routeId: CliEgressRouteId) {
    assertCliVpnAvailable();
    if (!request.user) throw new CliVpnError("AUTH_REQUIRED", "Authentication is required.", 401);
    const previousSettings = await store.listCliRuntimeSettings();
    const previousStatus = await readCliVpnApplications(previousSettings);
    const sessionGroups = await Promise.all(cliToggleRuntimeIds.map(async (runtimeId) => ({
      runtimeId,
      sessions: await store.listActivePaneCliSessions(runtimeId)
    })));
    const allSessions = sessionGroups.flatMap((group) => group.sessions);
    const pidBySessionId = await cliVpnSessionPidResolver(allSessions);
    const routed = await cliVpnBroker.setGlobalRoute(routeId, sessionGroups.map(({ runtimeId, sessions }) => ({
      runtimeId,
      pids: sessions.flatMap((session) => {
        const pid = pidBySessionId.get(session.sessionId);
        return pid ? [pid] : [];
      })
    })));

    try {
      if (routeId === "direct") {
        for (const runtimeId of cliToggleRuntimeIds) {
          await store.updateCliRuntimeVpnSetting(runtimeId, { enabled: false }, request.user.id);
        }
      }
    } catch (error) {
      try {
        await cliVpnBroker.setGlobalRoute(previousStatus.egress.selectedRoute, sessionGroups.map(({ runtimeId, sessions }) => ({
          runtimeId,
          pids: sessions.flatMap((session) => {
            const pid = pidBySessionId.get(session.sessionId);
            return pid ? [pid] : [];
          })
        })));
        for (const setting of previousSettings) {
          await store.updateCliRuntimeVpnSetting(setting.runtimeId, { enabled: setting.vpnEnabled }, request.user.id);
        }
      } catch {
        throw new CliVpnError(
          "VPN_ROLLBACK_FAILED",
          "Global CLI egress persistence failed and the previous protected route could not be restored.",
          502
        );
      }
      throw error;
    }

    const legacyPidByRuntime = new Map(
      routed.runtimes.map((application) => [application.runtimeId, new Set(application.legacyPids)])
    );
    const requestedSessions = allSessions.filter((session) => {
          const pid = pidBySessionId.get(session.sessionId);
          const runtimeId = cliToggleRuntimeIdSchema.safeParse(session.runtimeId);
          const application = runtimeId.success ? routed.runtimes.find((candidate) => candidate.runtimeId === runtimeId.data) : null;
          return pid && runtimeId.success && application?.routeId !== "direct"
            ? legacyPidByRuntime.get(runtimeId.data)?.has(pid) === true
            : false;
        });
    const registry = await discoverAgentRuntimes(config);
    const requestedRestartSessionIds = requestedSessions.map((session) => session.sessionId);
    const restartedSessionIds: string[] = [];
    const replacementSessionIds: string[] = [];
    const failedSessionIds: string[] = [];
    for (const session of requestedSessions) {
      const runtime = findRuntime(registry, session.runtimeId);
      if (
        session.purpose !== "NORMAL" ||
        !runtime ||
        !runtime.capabilities.includes("CLI") ||
        !isCliRuntimeTerminalLaunchable(runtime)
      ) {
        failedSessionIds.push(session.sessionId);
        continue;
      }
      try {
        const pane = await getPaneById(store, session.paneId);
        assertCliPaneCompatible(pane);
        if (pane.terminalRuntimeId && pane.terminalRuntimeId !== session.runtimeId) {
          throw new SpaceConflictError(`Pane ${pane.id} no longer uses ${session.runtimeId}.`);
        }
        const replacement = await cliVpnSessionRestarter(session, runtime, request.requestIdForSpace);
        if (
          replacement.paneId !== session.paneId ||
          replacement.runtimeId !== session.runtimeId ||
          replacement.sessionId === session.sessionId
        ) {
          throw new SpaceConflictError(`CLI session ${session.sessionId} returned an invalid egress replacement.`);
        }
        restartedSessionIds.push(session.sessionId);
        replacementSessionIds.push(replacement.sessionId);
      } catch {
        failedSessionIds.push(session.sessionId);
      }
    }

    const status = (await readCliVpnApplications(await store.listCliRuntimeSettings())).egress;
    await recordAudit(store, request, {
      action: "cli.egress.route.update",
      targetType: "cli_egress",
      targetId: "global",
      metadata: {
        previousRoute: previousStatus.egress.selectedRoute,
        selectedRoute: routeId,
        requestedRestartSessionCount: requestedRestartSessionIds.length,
        restartedSessionCount: restartedSessionIds.length,
        failedSessionCount: failedSessionIds.length,
        appliedRuntimeCount: status.applications.filter((application) => application.restartRequiredSessionIds.length === 0).length
      }
    });
    return updateCliGlobalEgressResultSchema.parse({
      status,
      requestedRestartSessionIds,
      restartedSessionIds,
      replacementSessionIds,
      failedSessionIds
    });
  }
  app.put("/api/cli/egress/route", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI egress settings require the ADMIN role.");
    }
    const input = parseBody(updateCliGlobalEgressInputSchema, request.body ?? {});
    return switchGlobalCliEgress(request, input.routeId);
  });
  app.post("/api/cli/runtime-settings/:runtimeId/disable-preview", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI runtime settings require the ADMIN role.");
    }
    const params = parseQuery(cliRuntimeSettingParamSchema, request.params);
    return cliRuntimeDisablePreviewSchema.parse(await cliRuntimeVisibility.createDisablePreview(params.runtimeId));
  });
  app.patch("/api/cli/runtime-settings/:runtimeId", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI runtime settings require the ADMIN role.");
    }
    const params = parseQuery(cliRuntimeSettingParamSchema, request.params);
    const input = parseBody(updateCliRuntimeSettingInputSchema, request.body ?? {});
    const result = input.enabled
      ? await cliRuntimeVisibility.enable(params.runtimeId, request.user.id, request.requestIdForSpace)
      : await cliRuntimeVisibility.disable(
          params.runtimeId,
          input.confirmationToken!,
          request.user.id,
          request.requestIdForSpace
        );
    await recordAudit(store, request, {
      action: cliRuntimeSettingAuditAction,
      targetType: "cli_runtime",
      targetId: params.runtimeId,
      metadata: {
        enabled: result.setting.enabled,
        cleanup: result.cleanup
      }
    });
    return updateCliRuntimeSettingResultSchema.parse(result);
  });
  app.patch("/api/cli/runtime-settings/:runtimeId/vpn", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI VPN settings require the ADMIN role.");
    }
    const params = parseQuery(cliRuntimeSettingParamSchema, request.params);
    const input = parseBody(updateCliRuntimeVpnInputSchema, request.body ?? {});
    assertCliVpnAvailable();
    if (!request.user) throw new CliVpnError("AUTH_REQUIRED", "Authentication is required.", 401);
    const previousSettings = await store.listCliRuntimeSettings();
    const previousSetting = previousSettings.find((candidate) => candidate.runtimeId === params.runtimeId);
    if (!previousSetting) throw new CliVpnError("BROKER_FAILED", "CLI runtime VPN setting is unavailable.", 502);
    const sessions = await store.listActivePaneCliSessions(params.runtimeId);
    const pidBySessionId = await cliVpnSessionPidResolver(sessions);
    const routed = await cliVpnBroker.setRuntime(
      params.runtimeId,
      input.enabled,
      sessions.flatMap((session) => {
        const pid = pidBySessionId.get(session.sessionId);
        return pid ? [pid] : [];
      })
    );
    try {
      await store.updateCliRuntimeVpnSetting(params.runtimeId, { enabled: input.enabled }, request.user.id);
    } catch (error) {
      try {
        await cliVpnBroker.setRuntime(
          params.runtimeId,
          previousSetting.vpnEnabled,
          sessions.flatMap((session) => {
            const pid = pidBySessionId.get(session.sessionId);
            return pid ? [pid] : [];
          })
        );
      } catch {
        throw new CliVpnError(
          "VPN_ROLLBACK_FAILED",
          "The CLI VPN setting could not be saved and its previous route could not be restored.",
          502
        );
      }
      throw error;
    }
    const legacyPids = new Set(routed.legacyPids);
    const requestedSessions = sessions.filter((session) => {
      const pid = pidBySessionId.get(session.sessionId);
      return pid && legacyPids.has(pid) && session.purpose === "NORMAL";
    });
    const registry = requestedSessions.length ? await discoverAgentRuntimes(config) : null;
    const runtime = registry ? findRuntime(registry, params.runtimeId) : null;
    const restartedSessionIds: string[] = [];
    const replacementSessionIds: string[] = [];
    const failedSessionIds: string[] = [];
    for (const session of requestedSessions) {
      if (!runtime || !runtime.capabilities.includes("CLI") || !isCliRuntimeTerminalLaunchable(runtime)) {
        failedSessionIds.push(session.sessionId);
        continue;
      }
      try {
        const pane = await getPaneById(store, session.paneId);
        assertCliPaneCompatible(pane);
        if (pane.terminalRuntimeId && pane.terminalRuntimeId !== params.runtimeId) {
          throw new SpaceConflictError(`Pane ${pane.id} no longer uses ${params.runtimeId}.`);
        }
        const replacement = await cliVpnSessionRestarter(session, runtime, request.requestIdForSpace);
        if (
          replacement.paneId !== session.paneId
          || replacement.runtimeId !== params.runtimeId
          || replacement.sessionId === session.sessionId
        ) {
          throw new SpaceConflictError(`CLI session ${session.sessionId} returned an invalid egress replacement.`);
        }
        restartedSessionIds.push(session.sessionId);
        replacementSessionIds.push(replacement.sessionId);
      } catch {
        failedSessionIds.push(session.sessionId);
      }
    }
    const afterSettings = await store.listCliRuntimeSettings();
    const after = await readCliVpnApplications(afterSettings);
    const setting = afterSettings.find((candidate) => candidate.runtimeId === params.runtimeId);
    const application = after.applications.find((candidate) => candidate.runtimeId === params.runtimeId);
    if (!setting || !application || !after.connection) {
      throw new CliVpnError("BROKER_FAILED", "CLI VPN routing status is unavailable after the route change.", 502);
    }
    await recordAudit(store, request, {
      action: "cli.runtime.vpn.update",
      targetType: "cli_runtime",
      targetId: params.runtimeId,
      metadata: {
        enabled: input.enabled,
        selectedRoute: after.egress.selectedRoute,
        requestedRestartSessionCount: requestedSessions.length,
        restartedSessionCount: restartedSessionIds.length,
        failedSessionCount: failedSessionIds.length,
        profileFingerprint: after.connection.profileFingerprint
      }
    });
    return updateCliRuntimeVpnResultSchema.parse({
      setting,
      connection: after.connection,
      application: {
        effectiveMode: application.effectiveMode,
        appliedSessionIds: application.appliedSessionIds,
        restartRequiredSessionIds: application.restartRequiredSessionIds
      }
    });
  });
  const cliVpnRestartPendingRuntimes = new Set<string>();
  app.post("/api/cli/runtime-settings/:runtimeId/vpn/restart-required", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI VPN session restarts require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const params = parseQuery(cliRuntimeSettingParamSchema, request.params);
    if (cliVpnRestartPendingRuntimes.has(params.runtimeId)) {
      throw new SpaceConflictError(`A VPN session restart is already running for ${params.runtimeId}.`);
    }
    cliVpnRestartPendingRuntimes.add(params.runtimeId);
    try {
      const settings = await store.listCliRuntimeSettings();
      const setting = settings.find((candidate) => candidate.runtimeId === params.runtimeId);
      if (!setting?.vpnEnabled) {
        throw new SpaceConflictError(`Enable VPN routing for ${params.runtimeId} before restarting its sessions.`);
      }
      await cliRuntimeVisibility.assertEnabled(params.runtimeId);
      const before = await readCliVpnApplications(settings);
      const connection = before.connection;
      const application = before.applications.find((candidate) => candidate.runtimeId === params.runtimeId);
      if (!connection || connection.status !== "CONNECTED" || application?.effectiveMode !== "VPN") {
        throw new CliVpnError(
          "VPN_NOT_READY",
          "The protected VPN route must be connected before restarting CLI sessions.",
          409
        );
      }

      const requestedSessionIds = [...(application.restartRequiredSessionIds ?? [])];
      const requestedSessionIdSet = new Set(requestedSessionIds);
      const sessions = await store.listActivePaneCliSessions(params.runtimeId);
      const sessionById = new Map(
        sessions
          .filter((session) => requestedSessionIdSet.has(session.sessionId))
          .map((session) => [session.sessionId, session])
      );
      const registry = await discoverAgentRuntimes(config);
      const runtime = findRuntime(registry, params.runtimeId);
      if (!runtime || !runtime.capabilities.includes("CLI") || !isCliRuntimeTerminalLaunchable(runtime)) {
        throw new SpaceFeatureDisabledError(
          "CLI_RUNTIME_DISABLED",
          runtime?.statusReason ?? `CLI runtime ${params.runtimeId} is unavailable.`,
          { runtimeId: params.runtimeId }
        );
      }

      const restartedSessionIds: string[] = [];
      const replacementSessionIds: string[] = [];
      const failedSessionIds: string[] = [];
      for (const sessionId of requestedSessionIds) {
        const session = sessionById.get(sessionId);
        if (!session || session.purpose !== "NORMAL") {
          failedSessionIds.push(sessionId);
          continue;
        }
        try {
          const pane = await getPaneById(store, session.paneId);
          assertCliPaneCompatible(pane);
          if (pane.terminalRuntimeId && pane.terminalRuntimeId !== params.runtimeId) {
            throw new SpaceConflictError(`Pane ${pane.id} no longer uses ${params.runtimeId}.`);
          }
          const replacement = await cliVpnSessionRestarter(
            session,
            runtime,
            request.requestIdForSpace
          );
          if (
            replacement.paneId !== session.paneId ||
            replacement.runtimeId !== params.runtimeId ||
            replacement.sessionId === session.sessionId
          ) {
            throw new SpaceConflictError(`CLI session ${session.sessionId} returned an invalid VPN replacement.`);
          }
          restartedSessionIds.push(session.sessionId);
          replacementSessionIds.push(replacement.sessionId);
        } catch {
          failedSessionIds.push(sessionId);
        }
      }

      const afterSettings = await store.listCliRuntimeSettings();
      const after = await readCliVpnApplications(afterSettings);
      const afterConnection = after.connection;
      const afterApplication = after.applications.find((candidate) => candidate.runtimeId === params.runtimeId);
      if (!afterConnection || !afterApplication) {
        throw new CliVpnError("BROKER_FAILED", "CLI VPN routing status is unavailable after restart.", 502);
      }
      await recordAudit(store, request, {
        action: "cli.runtime.vpn.restart_required",
        targetType: "cli_runtime",
        targetId: params.runtimeId,
        metadata: {
          requestedSessionCount: requestedSessionIds.length,
          restartedSessionCount: restartedSessionIds.length,
          failedSessionCount: failedSessionIds.length,
          remainingRestartRequiredSessionCount: afterApplication.restartRequiredSessionIds.length,
          connectionStatus: afterConnection.status,
          profileFingerprint: afterConnection.profileFingerprint
        }
      });
      const { runtimeId: _applicationRuntimeId, ...restartApplication } = afterApplication;
      return restartCliRuntimeVpnSessionsResultSchema.parse({
        runtimeId: params.runtimeId,
        requestedSessionIds,
        restartedSessionIds,
        replacementSessionIds,
        failedSessionIds,
        connection: afterConnection,
        application: restartApplication
      });
    } finally {
      cliVpnRestartPendingRuntimes.delete(params.runtimeId);
    }
  });
  const guardCliRuntimeRestartPane = async (paneId: string, runtimeId: string) => {
    const pane = await getPaneById(store, paneId);
    assertCliPaneCompatible(pane);
    if (pane.terminalRuntimeId && pane.terminalRuntimeId !== runtimeId) {
      throw new SpaceConflictError(`Pane ${pane.id} no longer uses ${runtimeId}.`);
    }
  };
  const cliRuntimeRestartPendingRuntimes = new Set<string>();
  app.post("/api/admin/cli/runtime/:runtimeId/restart", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI runtime session restarts require the ADMIN role.");
    }
    const params = parseQuery(cliRuntimeSettingParamSchema, request.params);
    if (cliRuntimeRestartPendingRuntimes.has(params.runtimeId)) {
      throw new SpaceConflictError(`A CLI session restart is already running for ${params.runtimeId}.`);
    }
    cliRuntimeRestartPendingRuntimes.add(params.runtimeId);
    try {
      await cliRuntimeVisibility.assertEnabled(params.runtimeId);
      const registry = await discoverAgentRuntimes(config);
      const runtime = findRuntime(registry, params.runtimeId);
      if (!runtime || !runtime.capabilities.includes("CLI") || !isCliRuntimeTerminalLaunchable(runtime)) {
        throw new SpaceFeatureDisabledError(
          "CLI_RUNTIME_DISABLED",
          runtime?.statusReason ?? `CLI runtime ${params.runtimeId} is unavailable.`,
          { runtimeId: params.runtimeId }
        );
      }
      const result = await restartCliRuntimeSessions(
        {
          store,
          traceId: request.requestIdForSpace,
          restarter: cliVpnSessionRestarter,
          guardPane: guardCliRuntimeRestartPane
        },
        params.runtimeId,
        runtime
      );
      await recordAudit(store, request, {
        action: "cli.runtime.restart_requested",
        targetType: "cli_runtime",
        targetId: params.runtimeId,
        metadata: {
          requestedSessionCount: result.requestedSessionIds.length,
          restartedSessionCount: result.restartedSessionIds.length,
          failedSessionCount: result.failedSessionIds.length
        }
      });
      if (params.runtimeId === "cli:opencode") {
        await restartOpenCodeSharedServer();
      }
      return result;
    } finally {
      cliRuntimeRestartPendingRuntimes.delete(params.runtimeId);
    }
  });
  let cliRuntimeRestartAllInFlight = false;
  app.post("/api/admin/cli/runtime/restart-all", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI runtime session restarts require the ADMIN role.");
    }
    if (cliRuntimeRestartAllInFlight) {
      throw new SpaceConflictError("A CLI restart-all request is already running.");
    }
    cliRuntimeRestartAllInFlight = true;
    try {
      const registry = await discoverAgentRuntimes(config);
      const result = await restartAllCliRuntimes(
        {
          store,
          traceId: request.requestIdForSpace,
          restarter: cliVpnSessionRestarter,
          guardPane: guardCliRuntimeRestartPane
        },
        registry.data,
        (runtime) =>
          runtime.capabilities.includes("CLI") &&
          isCliRuntimeTerminalLaunchable(runtime) &&
          !cliRuntimeRestartPendingRuntimes.has(runtime.id)
      );
      await recordAudit(store, request, {
        action: "cli.runtime.restart_all_requested",
        targetType: "cli_runtime",
        targetId: "all",
        metadata: {
          requestedRuntimeCount: result.requestedRuntimes.length,
          restartedSessionCount: result.restartedSessionIds.length,
          failedSessionCount: result.failedSessionIds.length
        }
      });
      if (result.requestedRuntimes.includes("cli:opencode")) {
        await restartOpenCodeSharedServer();
      }
      return result;
    } finally {
      cliRuntimeRestartAllInFlight = false;
    }
  });
}
