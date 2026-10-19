import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { buildMemoryGpuScene } from "../src/features/memory-workspace/memory-gpu-scene.js";
import { MemoryPickIndex } from "../src/features/memory-workspace/memory-pick-index.js";
import { MemoryWebGLRenderer } from "../src/features/memory-workspace/memory-webgl-renderer.js";

// Exercise the real renderer/index contract with WebGL calls stubbed. These tests
// prove displayed-frame hit behavior, not shader execution or GPU performance.
function rendererFixture() {
  let lost = false;
  const methods = new Map<PropertyKey, unknown>([
    ["isContextLost", () => lost],
    ["getShaderParameter", () => true], ["getProgramParameter", () => true],
    ...["createShader", "createProgram", "createTexture", "createBuffer", "createVertexArray"]
      .map(name => [name, () => ({})] as [PropertyKey, unknown])
  ]);
  methods.set("getUniformLocation", (_program: unknown, name: string) => ({ name }));
  const constants: Record<string, number> = { SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303, ONE: 1, TRIANGLE_STRIP: 5 };
  const gl = new Proxy({} as WebGL2RenderingContext, { get(_target, key) {
    if (/^[A-Z][A-Z0-9_]*$/.test(String(key))) return constants[String(key)] ?? 1;
    if (!methods.has(key)) methods.set(key, vi.fn());
    return methods.get(key);
  } });
  const canvas = document.createElement("canvas");
  const getContext = vi.spyOn(canvas, "getContext").mockReturnValue(gl);
  const renderer = new MemoryWebGLRenderer(canvas);
  renderer.resize(200, 200, 1);
  return { renderer, gl, getContext, loseContext: () => { lost = true; } };
}

async function sceneAt(x: number, radius = 2.1) {
  const node: MemoryGraphNode = { id: "node:one", type: "MEMORY", label: "One", sourcePath: null, recordId: "node:one" };
  const scene = (await buildMemoryGpuScene([node], [], new Map(), new Map([[node.id, { x, y: 0, z: 0 }]])))!;
  scene.extent = 100; scene.coordinates[3] = radius;
  return scene;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("WebGL renderer displayed-frame picking contract (mock GPU)", () => {
  it("requests analytic AA without MSAA and preserves coverage alpha and physical pixel scale", async () => {
    const { renderer, gl, getContext } = rendererFixture();
    expect(getContext).toHaveBeenCalledWith("webgl2", { alpha: true, antialias: false, depth: true, preserveDrawingBuffer: false });
    renderer.resize(200, 200, 2);
    renderer.setScene(await sceneAt(0));
    renderer.draw({ yaw: 0, pitch: 0, zoom: 1 }, -1);
    expect(gl.blendFuncSeparate).toHaveBeenCalledWith(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    expect(gl.blendFunc).not.toHaveBeenCalled();
    expect(gl.uniform2f).toHaveBeenCalledWith({ name: "u_pixelRatio" }, 2, 2);
    expect(gl.drawArraysInstanced).toHaveBeenNthCalledWith(1, gl.TRIANGLE_STRIP, 0, 4, 0);
    renderer.dispose();
  });

  it("keeps the displayed camera's targets until the next draw, without rebuilding from input", async () => {
    const { renderer } = rendererFixture(), scene = await sceneAt(50);
    const camera = { yaw: 0, pitch: 0, zoom: 1 };
    const rebuild = vi.spyOn(MemoryPickIndex.prototype, "update");
    renderer.setScene(scene);
    expect(renderer.pick(140, 100)).toBe(-1); // No frame has been drawn yet.
    expect(rebuild).not.toHaveBeenCalled();
    renderer.draw(camera, -1);
    expect(rebuild).toHaveBeenCalledOnce();
    rebuild.mockClear();
    camera.yaw = Math.PI; // The UI queues a camera change before its next animation frame.
    for (let i = 0; i < 100; i++) expect(renderer.pick(140, 100)).toBe(0);
    expect(renderer.pick(60, 100)).toBe(-1);
    expect(rebuild).not.toHaveBeenCalled();
    renderer.draw(camera, -1);
    expect(renderer.pick(60, 100)).toBe(0);
    expect(renderer.pick(140, 100)).toBe(-1);
    expect(rebuild).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it("retains old coordinate targets after uploading new geometry until it is drawn", async () => {
    const { renderer } = rendererFixture(), scene = await sceneAt(0);
    const camera = { yaw: 0, pitch: 0, zoom: 1 };
    renderer.setScene(scene); renderer.draw(camera, -1);
    scene.coordinates[0] = 50;
    renderer.updateCoordinates();
    expect(renderer.pick(100, 100)).toBe(0);
    expect(renderer.pick(140, 100)).toBe(-1);
    renderer.draw(camera, -1);
    expect(renderer.pick(140, 100)).toBe(0);
    expect(renderer.pick(100, 100)).toBe(-1);
    renderer.dispose();
  });

  it("invalidates replaced scenes and cleared canvases, including DPR-only resize", async () => {
    const { renderer, loseContext } = rendererFixture();
    const camera = { yaw: 0, pitch: 0, zoom: 1 };
    renderer.setScene(await sceneAt(0)); renderer.draw(camera, -1);
    renderer.setScene(await sceneAt(50));
    expect(renderer.pick(100, 100)).toBe(-1);
    expect(renderer.pick(140, 100)).toBe(-1);
    renderer.draw(camera, -1);
    expect(renderer.pick(140, 100)).toBe(0);
    renderer.resize(200, 200, 2);
    expect(renderer.pick(140, 100)).toBe(-1);
    renderer.draw(camera, -1);
    expect(renderer.pick(140, 100)).toBe(0);
    renderer.resize(400, 200, 2);
    expect(renderer.pick(240, 100)).toBe(-1);
    renderer.draw(camera, -1);
    expect(renderer.pick(240, 100)).toBe(0);
    loseContext();
    expect(renderer.pick(240, 100)).toBe(-1);
    renderer.dispose();
    expect(renderer.pick(240, 100)).toBe(-1);
  });

  it("uses the focus-expanded hit radius from the displayed frame", async () => {
    const { renderer } = rendererFixture();
    const camera = { yaw: 0, pitch: 0, zoom: 1 };
    renderer.setScene(await sceneAt(0, 10)); renderer.draw(camera, -1);
    expect(renderer.pick(114, 100)).toBe(-1);
    renderer.draw(camera, 0);
    expect(renderer.pick(118, 100)).toBe(0);
    expect(renderer.pick(118.1, 100)).toBe(-1);
    renderer.draw(camera, -1);
    expect(renderer.pick(114, 100)).toBe(-1);
    renderer.dispose();
  });
});
