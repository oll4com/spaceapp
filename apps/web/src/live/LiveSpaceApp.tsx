import { App } from "../App.js";
import { SpaceRuntimeProvider } from "../runtime/SpaceRuntime.js";
import { liveRuntime } from "./live-runtime.js";

export function LiveSpaceApp() {
  return <SpaceRuntimeProvider runtime={liveRuntime}><App /></SpaceRuntimeProvider>;
}
