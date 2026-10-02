import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installMockStorage } from "./mock-storage.js";
import { enableStrictCspCompatibility } from "../strict-csp.js";
import "../styles.css";
import "../features/ui-theme/modern-theme.css";
import "../features/ui-theme/codex-theme.css";
import "../features/ui-theme/motion-theme.css";
import "./public-mock.css";

async function mount() {
  enableStrictCspCompatibility();
  installMockStorage();
  const [{ PublicMockApp }, { SurfaceErrorBoundary }] = await Promise.all([
    import("./DemoSpaceApp.js"), import("../features/SurfaceErrorBoundary.js")
  ]);
  await Promise.all([...document.querySelectorAll<HTMLLinkElement>("link[data-space-mock-style]")].map(link => {
    if (link.sheet) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      link.addEventListener("load", () => resolve(), { once: true });
      link.addEventListener("error", () => reject(new Error("Workspace styles could not load.")), { once: true });
    });
  }));
  createRoot(document.getElementById("root")!).render(
    <StrictMode><SurfaceErrorBoundary><PublicMockApp /></SurfaceErrorBoundary></StrictMode>
  );
  // Never block the first render on cache setup. The worker scope is demo-only.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      void navigator.serviceWorker.register("/demoappnew/mock-worker.js", { scope: "/demoappnew/", updateViaCache: "none" }).catch(() => {});
    }
  }));
}
void mount().catch(error => {
  console.error("Space mock could not load", error);
  window.dispatchEvent(new Event("space-mock-load-error"));
});
