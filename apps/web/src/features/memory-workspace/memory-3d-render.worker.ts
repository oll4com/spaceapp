import type { MemoryCamera3D } from "./memory-3d.js";
import { MemoryGraphWebGL } from "./memory-3d-gl.js";

type WorkerScope = {
  onmessage: ((event: MessageEvent<RenderCommand>) => void) | null;
  postMessage(message: unknown): void;
};

type RenderCommand =
  | { type: "init"; canvas: OffscreenCanvas; dpr: number }
  | { type: "graph"; xyz: Float32Array; colors: Uint8Array; radii: Float32Array; edgePairs: Uint32Array; edgeTypes: Uint8Array; epoch: number }
  | { type: "clear" }
  | { type: "positions"; xyz: Float32Array; epoch: number }
  | { type: "focus"; index: number }
  | { type: "render"; id: number; camera: MemoryCamera3D; scale: number; width: number; height: number; sync: boolean; dpr: number }
  | { type: "dispose" };

const scope = self as unknown as WorkerScope;
let renderer: MemoryGraphWebGL | null = null;
let epoch = 0;
let pumping = false;

function schedulePump() {
  if (pumping) return;
  pumping = true;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    pumping = false;
    if (!renderer || renderer.contextLost) return;
    if (!renderer.pump()) schedulePump();
    else scope.postMessage({ type: "idle", epoch });
  };
  channel.port2.postMessage(null);
}

scope.onmessage = (event: MessageEvent<RenderCommand>) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      renderer = MemoryGraphWebGL.create(message.canvas);
      if (!renderer) {
        scope.postMessage({ type: "status", ok: false, hardwareRenderer: "", error: "WebGL2 context unavailable" });
        return;
      }
      renderer.setDeviceScale(message.dpr);
      renderer.onMetrics = metrics => scope.postMessage({ type: "metrics", ...metrics });
      renderer.onContextLost = () => scope.postMessage({ type: "lost" });
      renderer.onContextRestored = () => {
        renderer?.recover();
        schedulePump();
        scope.postMessage({ type: "restored" });
      };
      renderer.startCompile();
      scope.postMessage({ type: "status", ok: true, hardwareRenderer: renderer.rendererLabel() });
      schedulePump();
    } catch (error) {
      scope.postMessage({ type: "status", ok: false, hardwareRenderer: "", error: error instanceof Error ? error.message : "WebGL worker init failed" });
    }
    return;
  }
  if (!renderer) return;
  if (message.type === "graph") {
    epoch = message.epoch;
    renderer.setGraph({
      count: message.xyz.length / 3,
      edgeCount: message.edgePairs.length / 2,
      xyz: message.xyz,
      colors: message.colors,
      radii: message.radii,
      edgePairs: message.edgePairs,
      edgeTypes: message.edgeTypes
    });
    schedulePump();
  } else if (message.type === "clear") {
    renderer.clearGraph();
  } else if (message.type === "positions") {
    epoch = message.epoch;
    renderer.setPositions(message.xyz);
    schedulePump();
  } else if (message.type === "focus") {
    renderer.setFocus(message.index);
  } else if (message.type === "render") {
    renderer.setDeviceScale(message.dpr);
    const started = performance.now();
    const gpuMs = renderer.render(message.camera, message.scale, message.width, message.height, message.sync);
    const wallMs = performance.now() - started;
    scope.postMessage({ type: "rendered", id: message.id, ms: gpuMs ?? wallMs, drew: true, count: renderer.nodeCount, uploaded: renderer.uploadedCount, bufferWidth: renderer.canvas.width, bufferHeight: renderer.canvas.height, gpuMs, wallMs });
  } else if (message.type === "dispose") {
    renderer.dispose();
    renderer = null;
  }
};
