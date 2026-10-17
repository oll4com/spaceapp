import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEMORY_CAMERA,
  FALLBACK_CANVAS_2D_NODE_CAP,
  MAX_DRAWN_MEMORY_LABELS,
  MAX_MEASURED_MEMORY_LABELS,
  computeMemory3DExtent,
  createMemorySpatialPicker3D,
  layoutMemoryNetwork3D,
  memory3DVolumeRatio,
  memory3DVolumeRatioFromMap,
  pickMemoryNode3D,
  projectMemoryClipZ,
  projectMemoryPoint,
  selectMemoryLabelsLOD,
  streamLayoutMemoryNetwork3D,
  unpackMemoryCoordinates3D,
  type MemoryPoint3D
} from "../src/features/memory-workspace/memory-3d.js";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";
import { generateSyntheticMemoryGraph, DemoStore } from "../src/demo/DemoStore.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

describe("3D memory projection, spatial picking, LOD labels, streaming layout, and WebGL2 renderer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rotates all three axes through a full turn and returns to the same view", () => {
    const point = { x: 45, y: 20, z: 60 };
    const initial = projectMemoryPoint(point, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
    const rotated = projectMemoryPoint(point, { ...DEFAULT_MEMORY_CAMERA, yaw: DEFAULT_MEMORY_CAMERA.yaw + Math.PI / 2 }, 2, 1000, 700);
    const full = projectMemoryPoint(point, { ...DEFAULT_MEMORY_CAMERA, yaw: DEFAULT_MEMORY_CAMERA.yaw + Math.PI * 2, pitch: DEFAULT_MEMORY_CAMERA.pitch + Math.PI * 2 }, 2, 1000, 700);
    expect(rotated.x).not.toBeCloseTo(initial.x);
    expect(rotated.z).not.toBeCloseTo(initial.z);
    expect(full.x).toBeCloseTo(initial.x);
    expect(full.y).toBeCloseTo(initial.y);
    expect(full.z).toBeCloseTo(initial.z);
  });

  it("computes single-normalized clip-space depth in [-0.995, 0.995] with front-to-back ordering", () => {
    const coords = new Map<string, MemoryPoint3D>([
      ["near", { x: 0, y: 0, z: -120 }],
      ["mid", { x: 0, y: 0, z: 0 }],
      ["far", { x: 0, y: 0, z: 120 }]
    ]);
    const extent = computeMemory3DExtent(coords);
    expect(extent).toBeCloseTo(120);
    const nearClip = projectMemoryClipZ(-120, extent);
    const midClip = projectMemoryClipZ(0, extent);
    const farClip = projectMemoryClipZ(120, extent);
    expect(nearClip).toBeGreaterThanOrEqual(-0.995);
    expect(farClip).toBeLessThanOrEqual(0.995);
    expect(nearClip).toBeLessThan(midClip);
    expect(midClip).toBeLessThan(farClip);
    expect(Math.abs(farClip - nearClip)).toBeGreaterThan(1.0);
  });

  const fixture = () => {
    const nodes: MemoryGraphNode[] = [{ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null }];
    const edges: MemoryGraphEdge[] = [];
    for (let file = 0; file < 12; file++) {
      const id = `source-${file}`;
      nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: null });
      edges.push({ id: `file-${file}`, type: "DERIVED_FROM", source: "root", target: id });
      for (let item = 0; item < 30; item++) {
        const memory = `${id}-memory-${item}`;
        nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: memory });
        edges.push({ id: memory, type: "CONTAINS", source: id, target: memory });
      }
    }
    return { nodes, edges };
  };

  it("occupies a volume, including at a side-on camera angle", () => {
    const { nodes, edges } = fixture();
    const layout = layoutMemoryNetwork3D(nodes, edges);
    expect(layout.size).toBe(nodes.length);
    expect(layout.get("root")).toEqual({ x: 0, y: 0, z: 0 });
    expect(memory3DVolumeRatio([...layout.values()])).toBeGreaterThan(0.35);
    expect(memory3DVolumeRatioFromMap(layout)).toBeCloseTo(memory3DVolumeRatio([...layout.values()]), 4);
    for (const yaw of [0, Math.PI / 2, Math.PI]) {
      const points = [...layout.values()].map(p => projectMemoryPoint(p, { yaw, pitch: 0, zoom: 1 }, 1, 1000, 700));
      const width = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
      const height = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
      expect(width / height).toBeGreaterThan(0.5);
      expect(width / height).toBeLessThan(2);
    }
  });

  it("keeps real source links close and is deterministic under input reordering", () => {
    const { nodes, edges } = fixture();
    const layout = layoutMemoryNetwork3D(nodes, edges);
    const reversed = layoutMemoryNetwork3D([...nodes].reverse(), [...edges].reverse());
    expect([...reversed]).toEqual([...layout]);
    const distance = (a: string, b: string) => { const p = layout.get(a)!, q = layout.get(b)!; return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); };
    const related = edges.filter(edge => edge.type === "CONTAINS");
    const meanLink = related.reduce((sum, edge) => sum + distance(edge.source, edge.target), 0) / related.length;
    const meanUnrelated = related.reduce((sum, edge) => sum + distance(edge.source === "source-0" ? "source-6" : "source-0", edge.target), 0) / related.length;
    expect(meanLink).toBeLessThan(meanUnrelated * 0.7);
  });

  it("detects flat geometry even if the plane is tilted", () => {
    const plane = Array.from({ length: 100 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), z: i % 10 + Math.floor(i / 10) }));
    expect(memory3DVolumeRatio(plane)).toBeCloseTo(0);
    expect(layoutMemoryNetwork3D([], []).size).toBe(0);
  });

  it("streams incremental 3D layout batches that converge to the exact deterministic layout", () => {
    const { nodes, edges } = fixture();
    const frames: Array<{ step: number; totalSteps: number; done: boolean; packed: Float32Array; orderedIds: string[] }> = [];
    const finalSnapshot = streamLayoutMemoryNetwork3D(
      nodes,
      edges,
      frame => {
        frames.push({
          ...frame,
          packed: new Float32Array(frame.packed)
        });
      },
      45
    );
    expect(frames.length).toBeGreaterThan(2);
    expect(frames[0]?.step).toBe(0);
    expect(frames[0]?.done).toBe(false);
    expect(frames.at(-1)?.done).toBe(true);
    expect(frames.at(-1)?.step).toBe(frames.at(-1)?.totalSteps);

    const directLayout = layoutMemoryNetwork3D(nodes, edges);
    expect([...finalSnapshot]).toEqual([...directLayout]);

    // Verify unpackMemoryCoordinates3D reuses backing map across streamed frames and matches final snapshot.
    let unpacked = unpackMemoryCoordinates3D(frames[0]!.orderedIds, frames[0]!.packed, frames[0]!.step);
    const firstBackingMap = unpacked.backingMap;
    for (let i = 1; i < frames.length; i++) {
      const next = unpackMemoryCoordinates3D(frames[i]!.orderedIds, frames[i]!.packed, frames[i]!.step, unpacked);
      expect(next).not.toBe(unpacked);
      expect(next.backingMap).toBe(firstBackingMap);
      unpacked = next;
    }
    expect(unpacked.get("source-0")?.x).toBeCloseTo(directLayout.get("source-0")!.x, 3);
    expect(unpacked.get("source-0")?.y).toBeCloseTo(directLayout.get("source-0")!.y, 3);
    expect(unpacked.get("source-0")?.z).toBeCloseTo(directLayout.get("source-0")!.z, 3);
  });

  it("picks the frontmost overlapping node and completes 50k-node spatial picking in under 4 ms", () => {
    const camera = { yaw: 0, pitch: 0, zoom: 1 };
    const nodes: MemoryGraphNode[] = [
      { id: "back-node", label: "back", type: "MEMORY", sourcePath: null, recordId: "back-node" },
      { id: "front-node", label: "front", type: "MEMORY", sourcePath: null, recordId: "front-node" }
    ];
    const coordinates = new Map<string, MemoryPoint3D>([
      ["back-node", { x: 0, y: 0, z: 80 }],
      ["front-node", { x: 0, y: 0, z: -80 }]
    ]);
    expect(pickMemoryNode3D(nodes, coordinates, camera, 1, 800, 600, 400, 300)).toBe("front-node");
    expect(pickMemoryNode3D(nodes, coordinates, camera, 1, 800, 600, 10, 10)).toBeNull();

    // Benchmark 50,000 nodes spatial index picking
    const synthetic = generateSyntheticMemoryGraph(50_000, 150_000);
    expect(synthetic.nodes).toHaveLength(50_000);
    expect(synthetic.edges).toHaveLength(150_000);

    const orderedIds = synthetic.nodes.map(n => n.id);
    const packed = new Float32Array(50_000 * 3);
    for (let i = 0; i < 50_000; i++) {
      packed[i * 3] = ((i * 73) % 400) - 200;
      packed[i * 3 + 1] = ((i * 137) % 400) - 200;
      packed[i * 3 + 2] = ((i * 251) % 400) - 200;
    }
    const coordMap = unpackMemoryCoordinates3D(orderedIds, packed, 1);
    const picker = createMemorySpatialPicker3D();
    picker.update(synthetic.nodes, coordMap, DEFAULT_MEMORY_CAMERA, 1.2, 1280, 720, null);

    const rootProjected = projectMemoryPoint(
      coordMap.get("source:demo-core-gemini")!,
      DEFAULT_MEMORY_CAMERA,
      1.2,
      1280,
      720
    );
    const start = performance.now();
    let lastPicked: string | null = null;
    const queries = 100;
    for (let q = 0; q < queries; q++) {
      const qx = q === 0 ? rootProjected.x : (q * 13) % 1280;
      const qy = q === 0 ? rootProjected.y : (q * 17) % 720;
      lastPicked = picker.pick(qx, qy);
    }
    const avgPickMs = (performance.now() - start) / queries;
    expect(avgPickMs).toBeLessThan(4);
    expect(lastPicked === null || typeof lastPicked === "string").toBe(true);
  });

  it("enforces LOD label priority, collision avoidance, and hard per-frame measurement/draw caps at 50k nodes", () => {
    const synthetic = generateSyntheticMemoryGraph(50_000, 150_000);
    const orderedIds = synthetic.nodes.map(n => n.id);
    const packed = new Float32Array(50_000 * 3);
    for (let i = 0; i < 50_000; i++) {
      packed[i * 3] = ((i * 53) % 300) - 150;
      packed[i * 3 + 1] = ((i * 97) % 300) - 150;
      packed[i * 3 + 2] = ((i * 193) % 300) - 150;
    }
    packed[0] = 0;
    packed[1] = 0;
    packed[2] = -50;
    const coordMap = unpackMemoryCoordinates3D(orderedIds, packed, 1);

    let measureCalls = 0;
    const measureTextWidth = (text: string) => {
      measureCalls++;
      return text.length * 6.5;
    };

    // At default zoom (1.0 < 1.6), non-source nodes are excluded unless focused
    const focusedMemoryId = "memory:synth-00001";
    const lowZoom = selectMemoryLabelsLOD({
      nodes: synthetic.nodes,
      coordinates: coordMap,
      camera: { yaw: 0, pitch: 0, zoom: 1.0 },
      scale: 1.5,
      width: 1280,
      height: 720,
      focusId: focusedMemoryId,
      measureTextWidth
    });
    expect(lowZoom.measuredCount).toBeLessThanOrEqual(MAX_MEASURED_MEMORY_LABELS);
    expect(lowZoom.labels.length).toBeLessThanOrEqual(MAX_DRAWN_MEMORY_LABELS);
    expect(lowZoom.labels[0]?.id).toBe(focusedMemoryId);
    expect(lowZoom.labels.some(l => l.id === "source:demo-core-gemini" && l.core)).toBe(true);
    expect(
      lowZoom.labels.every(
        l => l.id === focusedMemoryId || l.id.startsWith("source:")
      )
    ).toBe(true);

    // At high zoom (2.2 >= 1.6), non-source nodes are eligible but strictly capped by LOD bounds
    measureCalls = 0;
    const highZoom = selectMemoryLabelsLOD({
      nodes: synthetic.nodes,
      coordinates: coordMap,
      camera: { yaw: 0, pitch: 0, zoom: 2.2 },
      scale: 1.5,
      width: 1280,
      height: 720,
      focusId: null,
      measureTextWidth
    });
    expect(measureCalls).toBe(highZoom.measuredCount);
    expect(highZoom.measuredCount).toBeLessThanOrEqual(MAX_MEASURED_MEMORY_LABELS);
    expect(highZoom.labels.length).toBeLessThanOrEqual(MAX_DRAWN_MEMORY_LABELS);

    // Verify no two placed labels collide
    for (let i = 0; i < highZoom.labels.length; i++) {
      for (let j = i + 1; j < highZoom.labels.length; j++) {
        const a = highZoom.labels[i]!;
        const b = highZoom.labels[j]!;
        const overlapsY = Math.abs(a.y - b.y) < 16;
        const overlapsX = a.x < b.x + b.width + 5 && a.x + a.width + 5 > b.x;
        expect(overlapsY && overlapsX).toBe(false);
      }
    }
  });

  it("renders with WebGL2 instanced nodes and batched edges, falls back to 2k-capped Canvas 2D on context loss, and restores WebGL2", () => {
    const drawArrays = vi.fn();
    const drawArraysInstanced = vi.fn();
    const enable = vi.fn();
    let isLost = false;

    const mockGl: Record<string, unknown> = {
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
      COMPILE_STATUS: 0x8b81,
      LINK_STATUS: 0x8b82,
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88e4,
      DYNAMIC_DRAW: 0x88e8,
      FLOAT: 0x1406,
      DEPTH_TEST: 0x0b71,
      LEQUAL: 0x0203,
      BLEND: 0x0be2,
      SRC_ALPHA: 0x0302,
      ONE_MINUS_SRC_ALPHA: 0x0303,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      LINES: 0x0001,
      TRIANGLE_STRIP: 0x0005,
      isContextLost: () => isLost,
      createShader: () => ({}),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      deleteShader: () => {},
      createProgram: () => ({}),
      attachShader: () => {},
      linkProgram: () => {},
      getProgramParameter: () => true,
      deleteProgram: () => {},
      createVertexArray: () => ({}),
      createBuffer: () => ({}),
      bindVertexArray: () => {},
      bindBuffer: () => {},
      bufferData: () => {},
      enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      vertexAttribDivisor: () => {},
      getUniformLocation: () => ({}),
      viewport: () => {},
      enable,
      depthFunc: () => {},
      blendFunc: () => {},
      clearDepth: () => {},
      clearColor: () => {},
      clear: () => {},
      useProgram: () => {},
      uniform1f: () => {},
      drawArrays,
      drawArraysInstanced
    };

    const arcCalls = vi.fn();
    const mock2d: Record<string, unknown> = {
      clearRect: () => {},
      setTransform: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      arc: arcCalls,
      fill: () => {},
      fillRect: () => {},
      fillText: () => {},
      measureText: (text: string) => ({ width: text.length * 6 })
    };

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      contextId: string
    ) {
      if (contextId === "webgl2") return mockGl as unknown as WebGL2RenderingContext;
      if (contextId === "2d") return mock2d as unknown as CanvasRenderingContext2D;
      return null;
    } as typeof HTMLCanvasElement.prototype.getContext);

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(16);
      return 1;
    });

    const synthetic = generateSyntheticMemoryGraph(2_500, 7_500);
    const coordinates = new Map<string, MemoryPoint3D>();
    const positions = new Map<string, { x: number; y: number; size: number; color: string; groupId: string; hub: boolean }>();
    for (let i = 0; i < synthetic.nodes.length; i++) {
      const n = synthetic.nodes[i]!;
      coordinates.set(n.id, { x: (i % 50) * 4 - 100, y: Math.floor(i / 50) * 4 - 100, z: (i % 15) * 6 - 45 });
      positions.set(n.id, { x: 0, y: 0, size: 3, color: "#6dbdff", groupId: "archive", hub: i === 0 });
    }

    const onSelectNode = vi.fn();
    render(
      createElement(MemoryGraph3D, {
        nodes: synthetic.nodes,
        edges: synthetic.edges,
        positions,
        coordinates,
        showTitles: true,
        selectedNodeId: null,
        onSelectNode,
        loading: false,
        resetToken: 0
      })
    );

    const appCanvas = screen.getByRole("application");
    expect(appCanvas.getAttribute("data-renderer")).toBe("webgl2");
    expect(appCanvas.getAttribute("data-titles-visible")).toBe("true");
    expect(appCanvas.getAttribute("data-rotation")).toBe("0.300,-0.150");
    expect(enable).toHaveBeenCalledWith(mockGl.DEPTH_TEST);
    expect(drawArrays).toHaveBeenCalledWith(mockGl.LINES, 0, synthetic.edges.length * 2);
    expect(drawArraysInstanced).toHaveBeenCalledWith(mockGl.TRIANGLE_STRIP, 0, 4, synthetic.nodes.length);

    // Keyboard rotation and Enter key selection
    fireEvent.keyDown(appCanvas, { key: "ArrowRight" });
    expect(appCanvas.getAttribute("data-rotation")).toBe("0.450,-0.150");
    fireEvent.keyDown(appCanvas, { key: "Enter" });
    expect(onSelectNode).toHaveBeenCalledWith("source:demo-core-gemini");

    // Simulate WebGL context loss -> falls back to Canvas 2D with 2,000-node cap
    isLost = true;
    arcCalls.mockClear();
    const lostEvent = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      appCanvas.dispatchEvent(lostEvent);
    });
    expect(lostEvent.defaultPrevented).toBe(true);
    expect(appCanvas.getAttribute("data-renderer")).toBe("canvas2d");
    expect(arcCalls).toHaveBeenCalledTimes(FALLBACK_CANVAS_2D_NODE_CAP);

    // Simulate WebGL context restoration -> restores WebGL2 renderer
    isLost = false;
    drawArraysInstanced.mockClear();
    act(() => {
      appCanvas.dispatchEvent(new Event("webglcontextrestored"));
    });
    expect(appCanvas.getAttribute("data-renderer")).toBe("webgl2");
    expect(drawArraysInstanced).toHaveBeenCalledWith(mockGl.TRIANGLE_STRIP, 0, 4, synthetic.nodes.length);
  });

  it("supports synthetic demo graphs at 2k, 10k, and 50k nodes in DemoStore", async () => {
    const store = new DemoStore();
    for (const size of [2_000, 10_000, 50_000]) {
      const overview = await store.api.memoryGraphOverview({ month: "all", relationMode: "RELATIONS", limit: size });
      expect(overview.data.nodes).toHaveLength(size);
      expect(overview.data.edges).toHaveLength(size * 3);
      expect(overview.data.truncated).toBe(false);
    }
    const detail = await store.api.memoryGraphNode("memory:synth-00001");
    expect(detail.node.id).toBe("memory:synth-00001");
    expect(detail.record?.title).toContain("Synthetic");
  });
});
