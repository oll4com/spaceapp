import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { clearStaleBuildRecoveryGuard, handleStaleBuildLoadError } from "./entry-load-recovery.js";
import { resolveEntryRoute } from "./entry-route.js";
import { enableStrictCspCompatibility } from "./strict-csp.js";
import { startAppDiagnosticsBootstrap } from "./app-diagnostics/app-diagnostics-bootstrap.js";

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
  if (route === "app") {
    const diagnosticsStartup = startAppDiagnosticsBootstrap();
    await diagnosticsStartup.beforeMount;
  }
  const root = createRoot(document.getElementById("root")!);
  if (route === "homepage") {
    const { Homepage } = await import("./features/homepage/Homepage.js");
    root.render(<StrictMode><Homepage /></StrictMode>);
    return route;
  }

  await import("./styles.css");
  if (route === "demo") {
    const { DemoSpaceApp } = await import("./demo/DemoSpaceApp.js");
    root.render(<StrictMode><DemoSpaceApp /></StrictMode>);
    return route;
  }
  const [{ LiveSpaceApp }, { readUiTheme }] = await Promise.all([
    import("./live/LiveSpaceApp.js"),
    import("./ui-theme.js")
  ]);
  if (readUiTheme(window.localStorage) === "modern") {
    await import("./features/ui-theme/modern-theme.css");
  }
  root.render(<StrictMode><LiveSpaceApp /></StrictMode>);
  return route;
}

void mount()
  .then((route) => {
    if (route === "app") clearStaleBuildRecoveryGuard();
  })
  .catch((error: unknown) => {
    const route = resolveEntryRoute(window.location.pathname, window.location.hostname);
    if (route !== "app" || !handleStaleBuildLoadError(error)) throw error;
  });
