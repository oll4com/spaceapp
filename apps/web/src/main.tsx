import { SurfaceErrorBoundary } from "./features/SurfaceErrorBoundary.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { clearStaleBuildRecoveryGuard, handleStaleBuildLoadError, renderReloadFallback } from "./entry-load-recovery.js";
import { PUBLIC_SITE_URL, resolveEntryRoute } from "./entry-route.js";
import { enableStrictCspCompatibility } from "./strict-csp.js";
import {
  appDiagnosticsSessionIsAuthenticated,
  startAppDiagnosticsBootstrap
} from "./app-diagnostics/app-diagnostics-bootstrap.js";

enableStrictCspCompatibility();

async function mount() {
  if (new URLSearchParams(window.location.search).get("spaceDebug") === "1") {
    try {
      const { installBrowserDiagnostics } = await import("./browser-diagnostics.js");
      installBrowserDiagnostics();
    } catch {
      console.info("[space-debug] diagnostics:load-failed");
    }
  }
  const route = resolveEntryRoute(window.location.pathname, window.location.hostname);
  // Diagnostics auth is still awaited before the first app render, but its
  // request can overlap the entry chunk and stylesheet work below.
  const diagnosticsAuth = route === "app"
    ? appDiagnosticsSessionIsAuthenticated()
    : Promise.resolve(false);
  if (route === "public-site") {
    // The old in-app homepage was retired; the public site is spaceapp.dev.
    window.location.replace(PUBLIC_SITE_URL);
    return route;
  }
  const root = createRoot(document.getElementById("root")!);
  // Start the base stylesheet and the app entry chunks together. The shell
  // still renders only after CSS is ready, but the stylesheet no longer holds
  // the large LiveSpaceApp/App imports behind a serial dynamic import.
  const stylesReady = import("./styles.css");
  if (route === "demo") {
    await stylesReady;
    await import("./features/ui-theme/modern-theme.css");
    await import("./features/ui-theme/codex-theme.css");
    await import("./features/ui-theme/motion-theme.css");
    await import("./features/ui-theme/aurora-theme.css");
    await import("./features/ui-theme/liquid-glass-theme.css");
    await import("./features/ui-theme/jarvis-theme.css");
    await import("./features/ui-theme/aira-theme.css");
    const { DemoSpaceApp } = await import("./demo/DemoSpaceApp.js");
    root.render(<StrictMode><SurfaceErrorBoundary><DemoSpaceApp /></SurfaceErrorBoundary></StrictMode>);
    return route;
  }
  const appModules = Promise.all([
    import("./live/LiveSpaceApp.js"),
    import("./ui-theme.js"),
    import("@space/icons"),
    import("./features/instance-badge/InstanceBadge.js")
  ]);
  await stylesReady;
  const [{ LiveSpaceApp }, { readUiTheme, readUiBackground, readModernIconPack, readLiquidGlassTint, applyLiquidGlassTint }, { loadAppIconPack }, { InstanceBadge }] = await appModules;
  if (await diagnosticsAuth) {
    const diagnosticsStartup = startAppDiagnosticsBootstrap();
    await diagnosticsStartup.beforeMount;
  }
  document.documentElement.dataset.uiBackground = readUiBackground(window.localStorage);
  applyLiquidGlassTint(readLiquidGlassTint(window.localStorage));
  // Non-default icon packs load on demand; await the stored one like the theme CSS.
  const iconPackReady = loadAppIconPack(readModernIconPack(window.localStorage)).catch(() => undefined);
  if (readUiTheme(window.localStorage) !== "classic") {
    await import("./features/ui-theme/modern-theme.css");
    await import("./features/ui-theme/codex-theme.css");
    await import("./features/ui-theme/motion-theme.css");
    await import("./features/ui-theme/aurora-theme.css");
    await import("./features/ui-theme/liquid-glass-theme.css");
    await import("./features/ui-theme/jarvis-theme.css");
    await import("./features/ui-theme/aira-theme.css");
  }
  await iconPackReady;
  if (route === "app") {
    // Uncaught errors are reported by name and bundle location only (no messages or user content).
    const [{ installClientErrorReporter }, { api }] = await Promise.all([
      import("./client-error-reporter.js"),
      import("./live-api.js")
    ]);
    installClientErrorReporter({ send: (report) => {
      // Keep the same sanitized evidence locally even when the server cannot be reached.
      try { (window as any).spaceDesktop?.reportClientError?.(report); } catch { /* Diagnostics must not break reporting. */ }
      return api.reportClientError(report);
    } });
  }
  root.render(<StrictMode><SurfaceErrorBoundary><LiveSpaceApp /><InstanceBadge /></SurfaceErrorBoundary></StrictMode>);
  return route;
}

void mount()
  .then((route) => {
    if (route === "app") clearStaleBuildRecoveryGuard();
  })
  .catch((error: unknown) => {
    const route = resolveEntryRoute(window.location.pathname, window.location.hostname);
    if (route !== "app" || !handleStaleBuildLoadError(error)) {
      renderReloadFallback(null, () => window.location.reload(), "Space could not load. Check your connection and try again.");
    }
  });
