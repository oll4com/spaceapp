import {
  cliGlobalEgressStatusSchema,
  cliRuntimeVpnStatusSchema,
  cliToggleRuntimeIds,
  cliVpnConnectionSchema,
  type CliGlobalEgressStatus,
  type CliRuntimeSetting,
  type CliRuntimeVpnStatus,
  type PaneCliSession
} from "@space/contracts";
import { nowIso, type SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import { CliVpnError, type CliVpnBroker } from "./cli-vpn.js";

/**
 * Which CLI sessions run on which egress route: per runtime the sessions the selected route covers and those that need a
 * restart to join it, plus the global egress status. Direct when CLI egress is off; blocked on the fallback route when the
 * broker cannot be read.
 */
export function createCliVpnApplicationsReader(options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  cliVpnSessionPidResolver: (sessions: readonly PaneCliSession[]) => Promise<Map<string, number>>;
  inspectCliVpnStatus: (runtimes: Parameters<CliVpnBroker["inspectRuntimes"]>[0]) => ReturnType<CliVpnBroker["inspectRuntimes"]>;
}) {
  const { config, store, cliVpnSessionPidResolver, inspectCliVpnStatus } = options;
  function unavailableCliVpnConnection(error: unknown) {
    const toolingUnavailable = error instanceof CliVpnError && error.code === "TOOLING_UNAVAILABLE";
    return cliVpnConnectionSchema.parse({
      profileConfigured: false,
      status: "ERROR",
      endpoint: null,
      dnsServers: [],
      profileFingerprint: null,
      relay: null,
      egressIpv4: null,
      egressIpv6: null,
      lastHandshakeAt: null,
      lastVerifiedAt: null,
      lastVerificationCode: toolingUnavailable ? "TOOLING_UNAVAILABLE" : "APPLY_FAILED",
      updatedAt: nowIso()
    });
  }

  async function readCliVpnApplications(settings: readonly CliRuntimeSetting[]): Promise<{
    connection: ReturnType<typeof unavailableCliVpnConnection> | undefined;
    applications: CliRuntimeVpnStatus[];
    egress: CliGlobalEgressStatus;
  }> {
    const sessionGroups = await Promise.all(cliToggleRuntimeIds.map(async (runtimeId) => ({
      runtimeId,
      sessions: await store.listActivePaneCliSessions(runtimeId)
    })));
    if (!config.cliVpnEnabled) {
      const unavailable = unavailableCliVpnConnection(new CliVpnError("TOOLING_UNAVAILABLE", "CLI egress is disabled.", 503));
      const applications = sessionGroups.map(({ runtimeId, sessions }) => cliRuntimeVpnStatusSchema.parse({
        runtimeId,
        effectiveMode: "DIRECT",
        appliedSessionIds: sessions.map((session) => session.sessionId),
        restartRequiredSessionIds: []
      }));
      return {
        connection: undefined,
        applications,
        egress: cliGlobalEgressStatusSchema.parse({
          supported: false,
          selectedRoute: "direct",
          directEgressIpv4: null,
          removedProfiles: [],
          profiles: { greece: unavailable, thailand: unavailable, mullvad: unavailable, nord: unavailable },
          applications: applications.map((application) => ({
            runtimeId: application.runtimeId,
            routeId: "direct",
            appliedSessionIds: application.appliedSessionIds,
            restartRequiredSessionIds: application.restartRequiredSessionIds
          })),
          checkedAt: nowIso()
        })
      };
    }
    const allSessions = sessionGroups.flatMap((group) => group.sessions);
    const pidBySessionId = await cliVpnSessionPidResolver(allSessions);
    try {
      const inspection = await inspectCliVpnStatus(sessionGroups.map(({ runtimeId, sessions }) => ({
        runtimeId,
        pids: sessions.flatMap((session) => {
          const pid = pidBySessionId.get(session.sessionId);
          return pid ? [pid] : [];
        })
      })));
      const inspectionByRuntime = new Map(inspection.runtimes.map((item) => [item.runtimeId, item]));
      const selectedConnection = inspection.selectedRoute === "direct"
        ? inspection.profiles.greece
        : inspection.profiles[inspection.selectedRoute];
      const settingByRuntime = new Map(settings.map((setting) => [setting.runtimeId, setting]));
      const applications = sessionGroups.map(({ runtimeId, sessions }) => {
        const inspected = inspectionByRuntime.get(runtimeId);
        const isolatedPids = new Set(inspected?.isolatedPids ?? []);
        const runningSessions = sessions.filter((session) => pidBySessionId.has(session.sessionId));
        const vpnEnabled = settingByRuntime.get(runtimeId)?.vpnEnabled === true;
        const vpnRequested = vpnEnabled && inspection.selectedRoute !== "direct";
        const routeReady = !vpnRequested || selectedConnection.status === "CONNECTED";
        const runtimeUsesVpn = inspected?.mode === "vpn";
        const appliedSessionIds = vpnRequested && routeReady && runtimeUsesVpn
          ? runningSessions.filter((session) => isolatedPids.has(pidBySessionId.get(session.sessionId)!)).map((session) => session.sessionId)
          : vpnRequested
            ? []
            : runningSessions.map((session) => session.sessionId);
        const restartRequiredSessionIds = vpnRequested && routeReady && runtimeUsesVpn
          ? runningSessions.filter((session) => !isolatedPids.has(pidBySessionId.get(session.sessionId)!)).map((session) => session.sessionId)
          : [];
        return cliRuntimeVpnStatusSchema.parse({
          runtimeId,
          effectiveMode: !vpnRequested ? "DIRECT" : routeReady && runtimeUsesVpn ? "VPN" : "BLOCKED",
          appliedSessionIds,
          restartRequiredSessionIds
        });
      });
      return {
        connection: inspection.connection,
        applications,
        egress: cliGlobalEgressStatusSchema.parse({
          supported: true,
          selectedRoute: inspection.selectedRoute,
          directEgressIpv4: inspection.directEgressIpv4,
          removedProfiles: inspection.removedProfiles,
          profiles: inspection.profiles,
          applications: applications.map((application) => ({
            runtimeId: application.runtimeId,
            routeId: inspectionByRuntime.get(application.runtimeId)?.routeId ?? (application.effectiveMode === "VPN" ? inspection.selectedRoute : "direct"),
            appliedSessionIds: application.appliedSessionIds,
            restartRequiredSessionIds: application.restartRequiredSessionIds
          })),
          checkedAt: nowIso()
        })
      };
    } catch (error) {
      const unavailable = unavailableCliVpnConnection(error);
      const fallbackRoute = settings.some((setting) => setting.vpnEnabled) ? "greece" : "direct";
      const applications = sessionGroups.map(({ runtimeId, sessions }) => cliRuntimeVpnStatusSchema.parse({
        runtimeId,
        effectiveMode: fallbackRoute === "direct" ? "DIRECT" : "BLOCKED",
        appliedSessionIds: fallbackRoute === "direct" ? sessions.map((session) => session.sessionId) : [],
        restartRequiredSessionIds: fallbackRoute === "direct" ? [] : sessions.map((session) => session.sessionId)
      }));
      return {
        connection: unavailable,
        applications,
        egress: cliGlobalEgressStatusSchema.parse({
          supported: true,
          selectedRoute: fallbackRoute,
          directEgressIpv4: null,
          removedProfiles: [],
          profiles: { greece: unavailable, thailand: unavailable, mullvad: unavailable, nord: unavailable },
          applications: applications.map((application) => ({
            runtimeId: application.runtimeId,
            routeId: fallbackRoute,
            appliedSessionIds: application.appliedSessionIds,
            restartRequiredSessionIds: application.restartRequiredSessionIds
          })),
          checkedAt: nowIso()
        })
      };
    }
  }

  return readCliVpnApplications;
}
