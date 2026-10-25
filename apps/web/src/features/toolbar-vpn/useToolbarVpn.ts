import { useEffect, useRef, useState, type RefObject } from "react";
import type { CliEgressRouteId, CliRuntimeSettingsResponse } from "@space/contracts";
import { api } from "../../api.js";
import { CLI_VPN_ROUTING_STATUS_EVENT, refreshCliVpnRoutingStatus } from "../../cli-vpn-routing.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";

// The room toolbar's VPN control: the selected CLI egress route and the
// "Change city" action with its result notice.

export interface ToolbarVpn {
  toolbarVpnRoute: CliEgressRouteId | null;
  vpnCityPending: boolean;
  vpnCityNotice: string | null;
  setVpnCityNotice: (notice: string | null) => void;
  vpnCityNoticeRef: RefObject<HTMLDivElement | null>;
  rotateVpnCityFromToolbar: () => Promise<void>;
}

export function useToolbarVpn({ isAuthenticated, onRuntimeSettings }: {
  /** `auth?.isAuthenticated` */
  isAuthenticated: boolean | undefined;
  /** The status refresh also re-reads the CLI runtime settings. */
  onRuntimeSettings: (settings: CliRuntimeSettingsResponse) => void;
}): ToolbarVpn {
  const [toolbarVpnRoute, setToolbarVpnRoute] = useState<CliEgressRouteId | null>(null);
  useEffect(() => {
    if (!isAuthenticated) return;
    const interval = window.setInterval(() => {
      void refreshCliVpnRoutingStatus().catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(interval);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      setToolbarVpnRoute(null);
      return;
    }
    let active = true;
    const refresh = () => {
      void api
        .cliVpnRoutingStatus()
        .then((status) => {
          if (active) setToolbarVpnRoute(status.selectedRoute);
        })
        .catch(() => {
          if (active) setToolbarVpnRoute(null);
        });
      void api
        .cliRuntimeSettings()
        .then((settings) => {
          if (active) onRuntimeSettings(settings);
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener(CLI_VPN_ROUTING_STATUS_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(CLI_VPN_ROUTING_STATUS_EVENT, refresh);
    };
  }, [isAuthenticated]);

  const [vpnCityNotice, setVpnCityNotice] = useState<string | null>(null);
  const [vpnCityPending, setVpnCityPending] = useState(false);
  useAutoDismiss(vpnCityNotice, setVpnCityNotice);
  const vpnCityNoticeRef = useRef<HTMLDivElement | null>(null);

  async function rotateVpnCityFromToolbar() {
    if (vpnCityPending || !toolbarVpnRoute) return;
    setVpnCityPending(true);
    setVpnCityNotice(null);
    const providerLabel = toolbarVpnRoute === "nord" ? "NordVPN" : "Mullvad";
    try {
      const connection = toolbarVpnRoute === "nord"
        ? await api.rotateCliNordCity()
        : await api.rotateCliMullvadCity();
      setVpnCityNotice(connection.relay
        ? `${providerLabel} changed to ${connection.relay.cityName}, ${connection.relay.countryName} (${connection.egressIpv4 ?? "public IP verifying"}).`
        : `${providerLabel} city changed and the new egress was verified.`);
    } catch {
      setVpnCityNotice(`${providerLabel} city could not be changed.`);
    } finally {
      setVpnCityPending(false);
    }
  }

  return { toolbarVpnRoute, vpnCityPending, vpnCityNotice, setVpnCityNotice, vpnCityNoticeRef, rotateVpnCityFromToolbar };
}
