import { startWebSentry } from "./sentry-bootstrap.js";
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
startWebSentry(window.__SPACE_SENTRY__);

// styles.css pauses every CSS animation while the window is hidden or unfocused; after the event, when focus has settled (an iframe keeps it).
const markWindowIdle = () => setTimeout(() => document.documentElement.toggleAttribute("data-window-idle", document.hidden || !document.hasFocus()));
window.addEventListener("focus", markWindowIdle);
window.addEventListener("blur", markWindowIdle);
document.addEventListener("visibilitychange", markWindowIdle);
markWindowIdle();

// Speed audit 21/11: load only the active theme's CSS in parallel with styles.css and appModules instead of 7 serial theme CSS imports.
const THEME_VARIANT_LOADERS: Record<string, () => Promise<unknown>> = {
  codex: () => import("./features/ui-theme/codex-theme.css"),
  motion: () => import("./features/ui-theme/motion-theme.css"),
  aurora: () => import("./features/ui-theme/aurora-theme.css"),
  "liquid-glass": () => import("./features/ui-theme/liquid-glass-theme.css"),
  jarvis: () => import("./features/ui-theme/jarvis-theme.css"),
  aira: () => import("./features/ui-theme/aira-theme.css")
};

function readStoredUiThemeForPreload(): string {
  try {
    const raw = window.localStorage.getItem("space.uiTheme.v1");
    if (raw === "classic" || raw === "codex" || raw === "motion" || raw === "aurora" || raw === "liquid-glass" || raw === "jarvis" || raw === "aira") return raw;
  } catch { /* storage may be restricted */ }
  return "modern";
}

function readStoredUiLanguageForPreload(): "el" | "en" {
  try {
    const raw = window.localStorage.getItem("space.uiLanguage.v1");
    if (raw === "el" || raw === "en") return raw;
  } catch { /* storage may be restricted */ }
  const first = (navigator.languages?.[0] ?? navigator.language ?? "").toLowerCase();
  return first.startsWith("el") ? "el" : "en";
}

function loadActiveThemeCss(theme: string): Promise<unknown> {
  if (theme === "classic") return Promise.resolve();
  const variant = THEME_VARIANT_LOADERS[theme];
  return variant
    ? Promise.all([import("./features/ui-theme/modern-theme.css"), variant()])
    : import("./features/ui-theme/modern-theme.css");
}

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
  // Start the base stylesheet, active theme stylesheet, and the app entry chunks together.
  // The shell still renders only after CSS is ready, without serial CSS waterfalls.
  const stylesReady = import("./styles.css");
  if (route === "demo") {
    const [demoModule] = await Promise.all([
      import("./demo/DemoSpaceApp.js"),
      stylesReady,
      import("./features/ui-theme/modern-theme.css"),
      import("./features/ui-theme/codex-theme.css"),
      import("./features/ui-theme/motion-theme.css"),
      import("./features/ui-theme/aurora-theme.css"),
      import("./features/ui-theme/liquid-glass-theme.css"),
      import("./features/ui-theme/jarvis-theme.css"),
      import("./features/ui-theme/aira-theme.css")
    ]);
    root.render(<StrictMode><SurfaceErrorBoundary><demoModule.DemoSpaceApp /></SurfaceErrorBoundary></StrictMode>);
    return route;
  }
  const preloadedTheme = readStoredUiThemeForPreload();
  const themeStylesReady = preloadedTheme !== "classic" ? loadActiveThemeCss(preloadedTheme) : Promise.resolve();
  const languagePackReady = readStoredUiLanguageForPreload() === "el"
    ? import("./features/ui-language/ui-language.js").then((m) => m.ensureUiLanguagePack("el")).catch(() => undefined)
    : Promise.resolve();
  const appModules = Promise.all([
    import("./live/LiveSpaceApp.js"),
    import("./ui-theme.js"),
    import("@space/icons"),
    import("./features/instance-badge/InstanceBadge.js"),
    import("./features/instance-badge/AppUpdateNotice.js")
  ]);
  await stylesReady;
  const [{ LiveSpaceApp }, { readUiTheme, readUiBackground, readModernIconPack, readLiquidGlassTint, applyLiquidGlassTint }, { loadAppIconPack }, { InstanceBadge }, { AppUpdateNotice }] = await appModules;
  if (await diagnosticsAuth) {
    const diagnosticsStartup = startAppDiagnosticsBootstrap();
    await diagnosticsStartup.beforeMount;
  }
  document.documentElement.dataset.uiBackground = readUiBackground(window.localStorage);
  applyLiquidGlassTint(readLiquidGlassTint(window.localStorage));
  // Non-default icon packs load on demand; await the stored one like the theme CSS.
  const iconPackReady = loadAppIconPack(readModernIconPack(window.localStorage)).catch(() => undefined);
  if (readUiTheme(window.localStorage) !== "classic") {
    const activeTheme = readUiTheme(window.localStorage);
    await (activeTheme === preloadedTheme ? themeStylesReady : loadActiveThemeCss(activeTheme));
  }
  await Promise.all([iconPackReady, languagePackReady]);
  if (route === "app") {
    // Uncaught errors reach the server by name and bundle location only (no messages or user content); the desktop app's local log also gets the message, redacted there.
    const [{ installClientErrorReporter }, { api }] = await Promise.all([
      import("./client-error-reporter.js"),
      import("./live-api.js")
    ]);
    installClientErrorReporter({
      // Kept locally even when the server cannot be reached.
      local: (report, message) => (window as unknown as { spaceDesktop?: { reportClientError?: (report: object) => unknown } }).spaceDesktop?.reportClientError?.({ ...report, message }),
      send: (report) => api.reportClientError(report)
    });
  }
  root.render(<StrictMode><SurfaceErrorBoundary><LiveSpaceApp /><InstanceBadge /><AppUpdateNotice /></SurfaceErrorBoundary></StrictMode>);
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
