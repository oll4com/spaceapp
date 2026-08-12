import { App } from "../App.js";
import { SpaceRuntimeProvider } from "../runtime/SpaceRuntime.js";
import { liveRuntime } from "./live-runtime.js";
import { VoiceInputProvider } from "../features/voice-input/VoiceInputProvider.js";

export function LiveSpaceApp() {
  return <SpaceRuntimeProvider runtime={liveRuntime}><VoiceInputProvider><App /></VoiceInputProvider></SpaceRuntimeProvider>;
}
