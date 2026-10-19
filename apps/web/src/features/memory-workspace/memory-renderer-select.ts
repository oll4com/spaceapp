export type MemoryRendererKind = "webgl" | "canvas2d";

/** WebGL2 support, probed on a throwaway canvas so the render canvas never gets a context type it did not choose. */
export function probeWebGL2(createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas")): boolean {
  try {
    const gl = createCanvas().getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext(); // free the probe's context right away
    return true;
  } catch { return false; }
}

export interface RendererState { webgl2Supported: boolean; shaderFailed: boolean; contextLost: boolean }

/** WebGL while it works; Canvas 2D without support, after a shader failure, or while the context is lost. */
export const chooseRenderer = (state: RendererState): MemoryRendererKind =>
  state.webgl2Supported && !state.shaderFailed && !state.contextLost ? "webgl" : "canvas2d";
