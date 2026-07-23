import { App } from "../App.js";
import { SpaceRuntimeProvider } from "../runtime/SpaceRuntime.js";
import { demoRuntimeBundle } from "./demo-runtime.js";

export function DemoSpaceApp() {
  return <SpaceRuntimeProvider runtime={demoRuntimeBundle.runtime}><App /></SpaceRuntimeProvider>;
}
