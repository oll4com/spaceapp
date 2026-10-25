/**
 * The provider route view shared by the provider settings and toolbar routes. The global Codex-LB route switch that
 * lived here was removed with codex-lb: Codex runs through Space Gateway.
 */
import type { Provider } from "@space/contracts";

export function providerRouteResponse(provider: Provider): {
  routeMode: "direct" | "headroom" | null;
  routeTargetMode: "primary" | "fallback" | "auto" | null;
} {
  switch (provider.routeProfile) {
    case "headroom":
      return { routeMode: "headroom", routeTargetMode: null };
    case "direct-primary":
      return { routeMode: "direct", routeTargetMode: "primary" };
    case "direct-auto":
      return { routeMode: "direct", routeTargetMode: "auto" };
    case "direct-fallback":
      return { routeMode: "direct", routeTargetMode: "fallback" };
    default:
      return { routeMode: null, routeTargetMode: null };
  }
}
