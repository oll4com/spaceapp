import { providerSwitchTargetsSchema } from "@space/contracts";
import { nowIso, type SpaceStore } from "@space/runtime";
import { providerRouteResponse } from "./codex-provider-route.js";

/**
 * The provider list behind the toolbar's "Active provider" health check: every provider with its health and the
 * current one first. Codex runs through Space Gateway, so no provider offers a switch.
 */
export function createToolbarProviderTargets(options: { store: SpaceStore }) {
  const { store } = options;
  async function readToolbarProviderTargets() {
    const [providers, settings] = await Promise.all([store.listProviders(), store.getProviderSettings()]);
    const data = providers.map((provider) => {
      const route = providerRouteResponse(provider);
      const backingProviderId = provider.backingProviderId ?? (provider.type === "CODEX_LB" || provider.type === "SPACE_GATEWAY" ? "codex-lb" : provider.id);
      const supported = backingProviderId === "codex-lb" && route.routeMode !== null;
      const health = provider.status === "VERIFIED" ? "HEALTHY" : provider.status === "ERROR" ? "UNAVAILABLE" : "UNKNOWN";
      // Codex runs through Space Gateway; the codex-lb route these providers named is retired.
      const canSwitch = false;
      const reason = supported ? "Codex runs through Space Gateway." : "Provider does not expose a supported Space Gateway route.";
      return {
        providerId: provider.id,
        displayName: provider.displayName,
        isCurrent: provider.id === settings.defaultProviderId,
        canSwitch,
        health,
        reason
      };
    }).sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent) || left.displayName.localeCompare(right.displayName));
    return providerSwitchTargetsSchema.parse({
      data,
      pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0 },
      checkedAt: nowIso()
    });
  }
  return { readToolbarProviderTargets };
}
