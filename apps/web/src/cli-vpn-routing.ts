import type { CliVpnRoutingStatus } from "@space/contracts";
import { api } from "./api.js";

export const CLI_VPN_ROUTING_STATUS_EVENT = "space:cli-vpn-routing-status";

const routingStatusCacheTtlMs = 10_000;
let cachedStatus: CliVpnRoutingStatus | null = null;
let cachedAtMs = 0;
let inFlightStatus: Promise<CliVpnRoutingStatus> | null = null;

export interface PaneVpnRoutingPresentation {
  label: string;
  title: string;
  tone: "vpn" | "pending" | "blocked";
  city?: string;
}

const routeLabels = {
  direct: "Direct",
  greece: "Greece",
  thailand: "Thailand",
  mullvad: "Mullvad"
} as const;

function relayCityLabel(status: CliVpnRoutingStatus): string | undefined {
  const relay = status.relay;
  if (!relay) return undefined;
  return relay.countryCode ? `${relay.cityName} (${relay.countryCode.toUpperCase()})` : relay.cityName;
}

export function paneVpnRoutingPresentation(
  status: CliVpnRoutingStatus | null,
  session: { sessionId: string | null; runtimeId: string | null; purpose: "NORMAL" | "LOGIN" }
): PaneVpnRoutingPresentation | null {
  if (!status?.vpnSupported || !session.sessionId || !session.runtimeId || session.purpose !== "NORMAL") return null;
  const application = status.applications.find((candidate) => candidate.runtimeId === session.runtimeId);
  if (!application) return null;
  if (application.appliedSessionIds.includes(session.sessionId) && application.effectiveMode === "VPN") {
    const egressIp = status.egressIpv4 ?? status.egressIpv6;
    const routeLabel = routeLabels[status.selectedRoute];
    const city = relayCityLabel(status);
    const label = egressIp ? `${routeLabel} · ${egressIp}` : `${routeLabel} connected`;
    const title = egressIp
      ? `This CLI session is connected through the ${routeLabel} VPN egress ${egressIp}.`
      : `This CLI session is connected through the ${routeLabel} VPN.`;
    return {
      label: city ? `${label} · ${city}` : label,
      title: city ? `${title} VPN city: ${city}.` : title,
      tone: "vpn",
      city
    };
  }
  if (application.restartRequiredSessionIds.includes(session.sessionId)) {
    return application.effectiveMode === "BLOCKED"
      ? {
          label: "VPN unavailable",
          title: "VPN routing is enabled, but the protected VPN connection is unavailable.",
          tone: "blocked"
        }
      : {
          label: "VPN pending",
          title: "This existing CLI session is waiting for automatic VPN migration.",
          tone: "pending"
        };
  }
  return null;
}

export function invalidateCliVpnRoutingStatus(): void {
  cachedStatus = null;
  cachedAtMs = 0;
}

export function publishCliVpnRoutingStatus(status?: CliVpnRoutingStatus): void {
  if (status) {
    cachedStatus = status;
    cachedAtMs = Date.now();
  } else {
    invalidateCliVpnRoutingStatus();
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CLI_VPN_ROUTING_STATUS_EVENT));
  }
}

export async function loadCliVpnRoutingStatus(force = false): Promise<CliVpnRoutingStatus> {
  const now = Date.now();
  if (!force && cachedStatus && now - cachedAtMs < routingStatusCacheTtlMs) return cachedStatus;
  if (inFlightStatus) return inFlightStatus;
  inFlightStatus = api.cliVpnRoutingStatus()
    .then((status) => {
      cachedStatus = status;
      cachedAtMs = Date.now();
      return status;
    })
    .finally(() => {
      inFlightStatus = null;
    });
  return inFlightStatus;
}

export function resetCliVpnRoutingStatusForTests(): void {
  invalidateCliVpnRoutingStatus();
  inFlightStatus = null;
}
