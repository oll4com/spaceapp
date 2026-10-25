import { FeatureShowcase } from "./FeatureShowcase.js";
import { DemoGuide } from "./DemoGuide.js";
import { App } from "../App.js";
import { SpaceRuntimeProvider } from "../runtime/SpaceRuntime.js";
import { demoRuntimeBundle } from "./demo-runtime.js";
import { VoiceInputProvider } from "../features/voice-input/VoiceInputProvider.js";
import { useEffect, useState } from "react";
import { createDemoRuntime } from "./demo-runtime.js";
import { createCurrentMockFixture } from "./mock-fixture.js";
import { noteServerModules } from "../features/pane-visibility/server-modules.js";
import { PUBLIC_MOCK_MODULES } from "./mock-copilots.js";

export function DemoSpaceApp() {
  return <SpaceRuntimeProvider runtime={demoRuntimeBundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>;
}

import { createShowcaseFixture } from "./showcase-fixture.js";
import { installShowcaseController } from "./showcase-controller.js";

export function PublicMockApp() {
  const showcase = new URLSearchParams(location.search).get("showcase") === "1";
  useEffect(() => showcase ? installShowcaseController() : undefined, [showcase]);
  const [bundle] = useState(() => {
    noteServerModules({ optionalModules: [...PUBLIC_MOCK_MODULES] });
    return createDemoRuntime({ fixture: showcase ? createShowcaseFixture() : createCurrentMockFixture(), localStorage: window.localStorage, sessionStorage: window.sessionStorage });
  });
  const feature = new URLSearchParams(location.search).get("feature");
  if (feature === "voice" || feature === "memory") return <SpaceRuntimeProvider runtime={bundle.runtime}><FeatureShowcase kind={feature} /></SpaceRuntimeProvider>;
  const reset = () => window.location.reload();
  Object.defineProperty(window, "__spacePublicMock", { configurable: true, value: { api: bundle.runtime.api, reset } });
  return <div className={`public-mock-shell${showcase ? " public-mock-showcase" : ""}`}>
    <div className="public-mock-controls" role="toolbar" aria-label="Demo controls">
      <DemoGuide />
      <button type="button" className="public-mock-reset" onClick={reset} title="Restore the initial demo workspace">
        <span aria-hidden="true">↻</span> Reset demo
      </button>
    </div>
    <div className="public-mock-workspace">
      <SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>
    </div>
  </div>;
}
