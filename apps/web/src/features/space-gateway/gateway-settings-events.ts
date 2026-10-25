import type { GatewaySettings } from "@space/contracts";

// Every place that changes Space Gateway settings announces the result, so the quick toggle and the Space Gateway
// dialog never disagree.
export const GATEWAY_SETTINGS_EVENT = "space:gateway-settings-change";

export function announceGatewaySettings(settings: GatewaySettings) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<GatewaySettings>(GATEWAY_SETTINGS_EVENT, { detail: settings }));
}
