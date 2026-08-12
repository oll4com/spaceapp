import { App } from "../App.js";
import { SpaceRuntimeProvider } from "../runtime/SpaceRuntime.js";
import { demoRuntimeBundle } from "./demo-runtime.js";
import { VoiceInputProvider } from "../features/voice-input/VoiceInputProvider.js";

export function DemoSpaceApp() {
  return <SpaceRuntimeProvider runtime={demoRuntimeBundle.runtime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>;
}
