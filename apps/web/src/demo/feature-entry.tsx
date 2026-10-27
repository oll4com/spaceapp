import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FeatureShowcase } from "./FeatureShowcase.js";
import { installMockStorage } from "./mock-storage.js";
import { createDemoRuntime } from "./demo-runtime.js";
import { createShowcaseFixture } from "./showcase-fixture.js";
import { SpaceRuntimeProvider } from "../runtime/SpaceRuntime.js";
import { enableStrictCspCompatibility } from "../strict-csp.js";
import "../styles.css";
import "../features/ui-theme/modern-theme.css";
import "../features/ui-theme/codex-theme.css";
import "../features/ui-theme/motion-theme.css";
import "../features/ui-theme/aurora-theme.css";
import "../features/ui-theme/liquid-glass-theme.css";
import "../features/ui-theme/jarvis-theme.css";
import "../features/ui-theme/aira-theme.css";

// This entry mounts only the real feature components. It never imports App
// or preloads the terminal renderer used by the full interactive workspace.
enableStrictCspCompatibility();
installMockStorage();
const kind = new URLSearchParams(location.search).get("feature") === "memory" ? "memory" : "voice";
const bundle = createDemoRuntime({ fixture: createShowcaseFixture(), localStorage: window.localStorage, sessionStorage: window.sessionStorage });
createRoot(document.getElementById("root")!).render(<StrictMode><SpaceRuntimeProvider runtime={bundle.runtime}><FeatureShowcase kind={kind} /></SpaceRuntimeProvider></StrictMode>);
