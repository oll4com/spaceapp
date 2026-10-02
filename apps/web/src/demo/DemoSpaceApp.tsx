import { App } from "../App.js";
import { SpaceRuntimeProvider } from "../runtime/SpaceRuntime.js";
import { demoRuntimeBundle } from "./demo-runtime.js";
import { VoiceInputProvider } from "../features/voice-input/VoiceInputProvider.js";
import { useState } from "react";
import { createDemoRuntime } from "./demo-runtime.js";
import { createCurrentMockFixture } from "./mock-fixture.js";

export function DemoSpaceApp() {
  return <SpaceRuntimeProvider runtime={demoRuntimeBundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>;
}

export function PublicMockApp() {
  const [bundle] = useState(() => createDemoRuntime({ fixture: createCurrentMockFixture(), localStorage: window.localStorage, sessionStorage: window.sessionStorage }));
  const reset = () => window.location.reload();
  Object.defineProperty(window, "__spacePublicMock", { configurable: true, value: { api: bundle.runtime.api, reset } });
  return <div className="public-mock-shell">
    <div className="public-mock-controls" role="toolbar" aria-label="Demo controls">
      <button type="button" className="public-mock-reset" onClick={reset} title="Restore the initial demo workspace">
        <span aria-hidden="true">↻</span> Reset demo
      </button>
    </div>
    <div className="public-mock-workspace">
      <SpaceRuntimeProvider runtime={bundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>
    </div>
  </div>;
}
