import { harnessMaintenanceStatusSchema } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";
import { CliVpnError, type CliVpnBroker } from "./cli-vpn.js";
import type { DeepSeekHarnessServiceController } from "./service-restarts.js";

/**
 * CLI egress checks shared by the CLI runtime, egress and settings routes: whether VPN routing is on, the DeepSeek
 * Harness's pid and network isolation, its maintenance status, and the short-lived cached broker inspection that status
 * displays share (isolation gates always read the broker directly).
 */
export function createCliEgressStatus(options: {
  config: SpaceApiConfig;
  cliVpnBroker: CliVpnBroker;
  deepSeekHarnessServiceController: DeepSeekHarnessServiceController;
}) {
  const { config, cliVpnBroker, deepSeekHarnessServiceController } = options;
  function assertCliVpnAvailable(): void {
    if (!config.cliVpnEnabled) {
      throw new CliVpnError("VPN_FEATURE_DISABLED", "CLI VPN routing is not enabled on this Space installation.", 503);
    }
  }

  async function runningDeepSeekHarnessPid(): Promise<number> {
    const pid = await deepSeekHarnessServiceController.mainPid();
    if (!pid) {
      throw new CliVpnError("HARNESS_UNAVAILABLE", "DeepSeek Harness is not running.", 503);
    }
    return pid;
  }

  // Status displays share a short-lived egress inspection; isolation gates
  // (assertDeepSeekHarnessIsolated) always read the broker directly.
  function inspectCliVpnStatus(runtimes: Parameters<CliVpnBroker["inspectRuntimes"]>[0]) {
    return cliVpnBroker.inspectRuntimesCached
      ? cliVpnBroker.inspectRuntimesCached(runtimes)
      : cliVpnBroker.inspectRuntimes(runtimes);
  }

  async function assertDeepSeekHarnessIsolated(pid: number): Promise<void> {
    const inspection = await cliVpnBroker.inspectRuntimes([{ runtimeId: "cli:harness", pids: [pid] }]);
    const harness = inspection.runtimes.find((runtime) => runtime.runtimeId === "cli:harness");
    if (!harness?.isolatedPids.includes(pid)) {
      throw new CliVpnError(
        "HARNESS_NETWORK_ISOLATION_FAILED",
        "DeepSeek Harness did not enter its protected network namespace.",
        502
      );
    }
  }

  async function readDeepSeekHarnessMaintenanceStatus() {
    if (!config.harnessEnabled) {
      return harnessMaintenanceStatusSchema.parse({
        runtimeId: "cli:harness",
        enabled: false,
        vpnEnabled: false,
        effectiveMode: "DIRECT",
        isolated: false,
        pid: null
      });
    }
    const pid = await deepSeekHarnessServiceController.mainPid().catch(() => null);
    if (!config.cliVpnEnabled) {
      return harnessMaintenanceStatusSchema.parse({
        runtimeId: "cli:harness",
        enabled: Boolean(pid),
        vpnEnabled: false,
        effectiveMode: "DIRECT",
        isolated: false,
        pid
      });
    }
    try {
      const inspection = await inspectCliVpnStatus([{ runtimeId: "cli:harness", pids: pid ? [pid] : [] }]);
      const harness = inspection.runtimes.find((runtime) => runtime.runtimeId === "cli:harness");
      const vpnEnabled = harness?.mode === "vpn";
      const isolated = Boolean(pid && harness?.isolatedPids.includes(pid));
      const selectedConnection = inspection.selectedRoute === "direct"
        ? null
        : inspection.profiles[inspection.selectedRoute];
      return harnessMaintenanceStatusSchema.parse({
        runtimeId: "cli:harness",
        enabled: Boolean(pid),
        vpnEnabled,
        effectiveMode: vpnEnabled
          ? isolated && selectedConnection?.status === "CONNECTED" ? "VPN" : "BLOCKED"
          : "DIRECT",
        isolated,
        pid
      });
    } catch {
      return harnessMaintenanceStatusSchema.parse({
        runtimeId: "cli:harness",
        enabled: Boolean(pid),
        vpnEnabled: false,
        effectiveMode: "BLOCKED",
        isolated: false,
        pid
      });
    }
  }

  return { assertCliVpnAvailable, runningDeepSeekHarnessPid, inspectCliVpnStatus, assertDeepSeekHarnessIsolated, readDeepSeekHarnessMaintenanceStatus };
}
