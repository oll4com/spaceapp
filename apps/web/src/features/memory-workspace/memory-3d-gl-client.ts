import type { MemoryCamera3D } from "./memory-3d.js";
import type { PackedMemoryGraph } from "./memory-3d-buffers.js";

export function chooseMemoryGraphRenderer(input: { webgl2: boolean; contextLost: boolean }): "webgl2" | "canvas2d" {
  if (!input.webgl2 || input.contextLost) return "canvas2d";
  return "webgl2";
}

export interface MemoryGraphGLClient {
  readonly contextLost: boolean;
  hardwareRenderer: string;
  setGraph(packed: PackedMemoryGraph): void;
  clearGraph(): void;
  setPositions(xyz: Float32Array): void;
  setFocus(index: number): void;
  render(camera: MemoryCamera3D, scale: number, width: number, height: number, sync: boolean): void;
  renderFrame(camera: MemoryCamera3D, scale: number, width: number, height: number): Promise<number>;
  idle(): boolean;
  dispose(): void;
}

interface ClientEvents {
  onLost: () => void;
  onRestored: () => void;
}

/** Owns the WebGL canvas on a worker so context creation and texture uploads stay off the main thread. */
export function openMemoryGraphGL(canvas: HTMLCanvasElement, dpr: number, events: ClientEvents): Promise<MemoryGraphGLClient | null> {
  return new Promise(resolve => {
    if (typeof Worker === "undefined" || typeof canvas.transferControlToOffscreen !== "function") {
      resolve(null);
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL("./memory-3d-render.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(null);
      return;
    }
    let epoch = 0;
    let ackedEpoch = -1;
    let graphSerial = 0;
    let graphSend: Promise<void> = Promise.resolve();
    let latestFocus: number | null = null;
    let lost = false;
    let settled = false;
    const pending = new Map<number, (ms: number) => void>();
    let nextRender = 0;
    const yieldTurn = () => new Promise<void>(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
    let timer = 0;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      window.__spaceMemoryGLError = reason;
      window.clearTimeout(timer);
      worker.terminate();
      resolve(null);
    };
    const publishFocus = (generation: number) => {
      if (latestFocus === null || generation !== graphSerial) return;
      worker.postMessage({ type: "focus", index: latestFocus });
    };
    const client: MemoryGraphGLClient = {
      get contextLost() { return lost; },
      hardwareRenderer: "",
      setGraph(packed) {
        const generation = ++graphSerial;
        const sendEpoch = ++epoch;
        const source = packed;
        const send = (async () => {
          await yieldTurn();
          if (generation !== graphSerial) return;
          const xyz = source.xyz.slice();
          await yieldTurn();
          if (generation !== graphSerial) return;
          const colors = source.colors.slice();
          await yieldTurn();
          if (generation !== graphSerial) return;
          const radii = source.radii.slice();
          await yieldTurn();
          if (generation !== graphSerial) return;
          const edgePairs = source.edgePairs.slice();
          await yieldTurn();
          if (generation !== graphSerial) return;
          const edgeTypes = source.edgeTypes.slice();
          if (generation !== graphSerial) return;
          worker.postMessage({ type: "graph", xyz, colors, radii, edgePairs, edgeTypes, epoch: sendEpoch }, [xyz.buffer, colors.buffer, radii.buffer, edgePairs.buffer, edgeTypes.buffer]);
          publishFocus(generation);
        })();
        graphSend = send.then(() => undefined, () => undefined);
      },
      clearGraph() {
        latestFocus = null;
        const generation = ++graphSerial;
        const send = graphSend.then(() => {
          if (generation !== graphSerial) return;
          worker.postMessage({ type: "clear" });
        });
        graphSend = send.then(() => undefined, () => undefined);
      },
      setPositions(xyz) {
        const generation = graphSerial;
        const sendEpoch = ++epoch;
        void graphSend.then(() => yieldTurn()).then(() => {
          if (generation !== graphSerial || sendEpoch !== epoch) return;
          const copy = xyz.slice();
          worker.postMessage({ type: "positions", xyz: copy, epoch: sendEpoch }, [copy.buffer]);
        });
      },
      setFocus(index) {
        latestFocus = index;
        const generation = graphSerial;
        void graphSend.then(() => publishFocus(generation));
      },
      render(camera, scale, width, height, sync) {
        worker.postMessage({ type: "render", id: ++nextRender, camera, scale, width, height, sync, dpr: window.devicePixelRatio || dpr });
      },
      renderFrame(camera, scale, width, height) {
        const id = ++nextRender;
        return new Promise(done => {
          pending.set(id, done);
          worker.postMessage({ type: "render", id, camera, scale, width, height, sync: true, dpr: window.devicePixelRatio || dpr });
        });
      },
      idle() { return graphSerial > 0 && ackedEpoch === epoch && !lost; },
      dispose() {
        worker.postMessage({ type: "dispose" });
        worker.terminate();
      }
    };
    timer = window.setTimeout(() => fail("WebGL worker did not start"), 20_000);
    worker.onmessage = (event: MessageEvent<{ type: string; ok?: boolean; hardwareRenderer?: string; uploadMs?: number; positionMs?: number; id?: number; ms?: number; epoch?: number; error?: string }>) => {
      const message = event.data;
      if (message.type === "status") {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!message.ok) {
          window.__spaceMemoryGLError = message.error || "WebGL2 context unavailable";
          worker.terminate();
          resolve(null);
          return;
        }
        window.__spaceMemoryGLError = undefined;
        client.hardwareRenderer = message.hardwareRenderer ?? "";
        resolve(client);
      } else if (message.type === "metrics") {
        if (message.uploadMs !== undefined) window.__spaceMemoryUploadMs = message.uploadMs;
        if (message.positionMs !== undefined) window.__spaceMemoryPositionMs = Math.max(window.__spaceMemoryPositionMs ?? 0, message.positionMs);
      } else if (message.type === "idle" && message.epoch === epoch) {
        ackedEpoch = epoch;
      } else if (message.type === "rendered" && message.id !== undefined) {
        const rendered = message as { ms?: number; drew?: boolean; count?: number; uploaded?: number; bufferWidth?: number; bufferHeight?: number; gpuMs?: number | null; gpuNanos?: number; wallMs?: number };
        window.__spaceMemoryDraw = { ms: rendered.ms ?? 0, drew: Boolean(rendered.drew), count: rendered.count ?? -1, uploaded: rendered.uploaded ?? -2, bufferWidth: rendered.bufferWidth ?? 0, bufferHeight: rendered.bufferHeight ?? 0, gpuMs: rendered.gpuMs ?? null, gpuNanos: rendered.gpuNanos ?? -1, wallMs: rendered.wallMs ?? 0 };
        pending.get(message.id)?.(rendered.ms ?? 0);
        pending.delete(message.id);
      } else if (message.type === "lost") {
        lost = true;
        events.onLost();
      } else if (message.type === "restored") {
        lost = false;
        events.onRestored();
      }
    };
    worker.onerror = (event) => {
      fail(event.message || "WebGL worker failed");
    };
    try {
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: "init", canvas: offscreen, dpr }, [offscreen]);
    } catch (error) {
      fail(error instanceof Error ? error.message : "OffscreenCanvas transfer failed");
    }
  });
}
