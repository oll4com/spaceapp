import { describe, expect, it } from "vitest";
import { layoutMemoryNetwork3D, memory3DVolumeRatio, projectMemoryPoint, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

describe("3D memory projection", () => {
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

  it("picks the frontmost node in under 4 ms on a 50,000-node synthetic graph using the spatial grid", async () => {
    const {
      MemorySpatialPicker3D,
      PackedMemoryCoordinates3D
    } = await import("../src/features/memory-workspace/memory-3d.js");
    const count = 50_000;
    const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, index) => ({
      id: `node:${index}`,
      label: index === 0 ? "space.md" : `Node ${index}`,
      type: index === 0 ? "SOURCE" : "MEMORY",
      sourcePath: "/demo/space.md",
      recordId: index === 0 ? null : `rec:${index}`
    }));
    const nodeIds = nodes.map(n => n.id);
    const positions3D = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const golden = Math.PI * (3 - Math.sqrt(5));
      const y = 1 - (i / (count - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      const radius = 150 + (i % 7) * 8;
      positions3D[i * 3] = Math.cos(theta) * r * radius;
      positions3D[i * 3 + 1] = y * radius;
      positions3D[i * 3 + 2] = Math.sin(theta) * r * radius;
    }

    const coordinates = new PackedMemoryCoordinates3D(nodeIds, positions3D);
    const picker = new MemorySpatialPicker3D();
    picker.setGraph(nodes, coordinates);
    picker.syncProjection(DEFAULT_MEMORY_CAMERA, 1280, 720);

    const targetIndex = 12_345;
    const scale = Math.min(1280, 720) * 0.4 / picker.extent;
    const targetProjected = projectMemoryPoint(
      coordinates.pointAt(targetIndex),
      DEFAULT_MEMORY_CAMERA,
      scale,
      1280,
      720
    );

    const start = performance.now();
    const hit = picker.pick(targetProjected.x, targetProjected.y, DEFAULT_MEMORY_CAMERA, 1280, 720, `node:${targetIndex}`);
    const elapsedMs = performance.now() - start;

    expect(hit).toBeTruthy();
    expect(elapsedMs).toBeLessThan(4);

    // Measure 60 continuous camera orbit + zoom frames (projection sync + LOD label pass) at 50,000 nodes
    const frameTimes: number[] = [];
    for (let f = 0; f < 60; f++) {
      const cam = {
        yaw: DEFAULT_MEMORY_CAMERA.yaw + f * 0.04,
        pitch: DEFAULT_MEMORY_CAMERA.pitch + Math.sin(f * 0.1) * 0.2,
        zoom: 1.1 + Math.cos(f * 0.08) * 0.3
      };
      const t0 = performance.now();
      picker.selectLabels({
        camera: cam,
        width: 1280,
        height: 720,
        showTitles: true,
        focusId: `node:${targetIndex}`
      });
      frameTimes.push(performance.now() - t0);
    }
    frameTimes.sort((a, b) => a - b);
    const p50FrameMs = frameTimes[Math.floor(frameTimes.length * 0.5)]!;
    const p95FrameMs = frameTimes[Math.floor(frameTimes.length * 0.95)]!;
    expect(p95FrameMs).toBeLessThan(16.6);
    console.info(`[benchmark-50k] pickMs=${elapsedMs.toFixed(3)} frameP50Ms=${p50FrameMs.toFixed(2)} frameP95Ms=${p95FrameMs.toFixed(2)}`);
  });

  it("enforces hard measurement and draw caps in LOD label selection across camera distances and focus states", async () => {
    const {
      PackedMemoryCoordinates3D,
      selectMemory3DLabels,
      MAX_MEMORY_3D_LABELS_DRAWN,
      MAX_MEMORY_3D_LABELS_MEASURED
    } = await import("../src/features/memory-workspace/memory-3d.js");
    const count = 5_000;
    const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, i) => ({
      id: `node:${i}`,
      label: i === 0 ? "space.md" : `Memory node title ${i}`,
      type: i === 0 ? "SOURCE" : i < 20 ? "TOPIC" : "MEMORY",
      sourcePath: i === 0 ? "/demo/space.md" : null,
      recordId: i >= 20 ? `rec:${i}` : null
    }));
    const positions3D = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions3D[i * 3] = ((i % 50) - 25) * 4;
      positions3D[i * 3 + 1] = (Math.floor(i / 50) - 50) * 2;
      positions3D[i * 3 + 2] = ((i * 7) % 100) - 50;
    }
    positions3D[42 * 3] = 0;
    positions3D[42 * 3 + 1] = 0;
    positions3D[42 * 3 + 2] = -20;
    const coordinates = new PackedMemoryCoordinates3D(nodes.map(n => n.id), positions3D);

    let measureCount = 0;
    const measureWidth = (text: string) => {
      measureCount++;
      return text.length * 6.5;
    };

    const result = selectMemory3DLabels({
      nodes,
      coordinates,
      camera: { ...DEFAULT_MEMORY_CAMERA, zoom: 1.8 },
      width: 1280,
      height: 720,
      showTitles: true,
      focusId: "node:42",
      measureWidth
    });

    expect(measureCount).toBeLessThanOrEqual(MAX_MEMORY_3D_LABELS_MEASURED);
    expect(result.measuredCount).toBeLessThanOrEqual(MAX_MEMORY_3D_LABELS_MEASURED);
    expect(result.labels.length).toBeLessThanOrEqual(MAX_MEMORY_3D_LABELS_DRAWN);
    expect(result.labels[0]?.id).toBe("node:42");

    // When showTitles is false, zero labels are measured or drawn.
    measureCount = 0;
    const hiddenTitles = selectMemory3DLabels({
      nodes,
      coordinates,
      camera: DEFAULT_MEMORY_CAMERA,
      width: 1280,
      height: 720,
      showTitles: false,
      focusId: null,
      measureWidth
    });
    expect(hiddenTitles.measuredCount).toBe(0);
    expect(hiddenTitles.labels).toHaveLength(0);
  });

  it("streams incremental 3D layout snapshots and matches deterministic final coordinates", async () => {
    const {
      streamMemoryNetwork3D,
      PackedMemoryCoordinates3D
    } = await import("../src/features/memory-workspace/memory-3d.js");
    const { nodes, edges } = fixture();
    const snapshots: Array<{ step: number; totalSteps: number; done: boolean; length: number }> = [];
    let finalFrame: Float32Array | null = null;
    let finalIds: string[] = [];

    streamMemoryNetwork3D(nodes, edges, frame => {
      snapshots.push({
        step: frame.step,
        totalSteps: frame.totalSteps,
        done: frame.done,
        length: frame.xyz.length
      });
      if (frame.done) {
        finalFrame = frame.xyz;
        finalIds = frame.ids;
      }
    });

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[0]?.step).toBe(0);
    expect(snapshots[0]?.done).toBe(false);
    expect(snapshots.at(-1)?.done).toBe(true);

    const packed = new PackedMemoryCoordinates3D(finalIds, finalFrame!);
    const direct = layoutMemoryNetwork3D(nodes, edges);
    expect(packed.size).toBe(direct.size);
    for (const [id, point] of direct) {
      const streamedPoint = packed.get(id)!;
      expect(streamedPoint.x).toBeCloseTo(point.x, 4);
      expect(streamedPoint.y).toBeCloseTo(point.y, 4);
      expect(streamedPoint.z).toBeCloseTo(point.z, 4);
    }
  });

  it("caps Canvas 2D fallback graphs at 2,000 nodes and generates 50,000 synthetic demo nodes deterministically", async () => {
    const { selectFallback2DGraph } = await import("../src/features/memory-workspace/memory-3d.js");
    const { generateSyntheticMemoryGraph, DemoStore } = await import("../src/demo/DemoStore.js");

    const synthetic = generateSyntheticMemoryGraph(50_000, 150_000);
    expect(synthetic.nodes.length).toBe(50_000);
    expect(synthetic.edges.length).toBe(150_000);

    const fallback = selectFallback2DGraph(synthetic.nodes, synthetic.edges, null, 2000, 6000);
    expect(fallback.nodes.length).toBe(2000);
    expect(fallback.edges.length).toBeLessThanOrEqual(6000);
    expect(fallback.nodes.some(node => node.label === "space.md")).toBe(true);

    const store = new DemoStore();
    store.setSyntheticMemoryGraphSize(50_000);
    const defaultOverview = await store.api.memoryGraphOverview({ relationMode: "RELATIONS" });
    expect(defaultOverview.data.nodes.length).toBe(2000);
    expect(defaultOverview.data.totalMatchingNodes).toBe(50_000);
    expect(defaultOverview.data.truncated).toBe(true);

    const fullOverview = await store.api.memoryGraphOverview({ relationMode: "RELATIONS", limit: 50_000 });
    expect(fullOverview.data.nodes.length).toBe(50_000);
    expect(fullOverview.data.edges.length).toBe(150_000);
    expect(fullOverview.data.truncated).toBe(false);
  });

  it("handles WebGL2 context loss and restoration cleanly and falls back to Canvas 2D when WebGL2 is unavailable", async () => {
    const React = await import("react");
    const { render, cleanup } = await import("@testing-library/react");
    const { MemoryGraph3D } = await import("../src/features/memory-workspace/MemoryGraph3D.js");
    const { PackedMemoryCoordinates3D } = await import("../src/features/memory-workspace/memory-3d.js");

    const { nodes, edges } = fixture();
    const coordinates = new PackedMemoryCoordinates3D(
      nodes.map(n => n.id),
      new Float32Array(nodes.length * 3)
    );
    const positions = new Map(nodes.map(n => [n.id, { x: 0, y: 0, color: "#7395ad", radius: 4, groupId: "g", hub: false }]));

    const mock2D = {
      clearRect: () => {},
      setTransform: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      arc: () => {},
      fill: () => {},
      save: () => {},
      restore: () => {},
      fillRect: () => {},
      fillText: () => {},
      measureText: (t: string) => ({ width: t.length * 6 })
    };

    const drawInstancedCalls: number[] = [];
    const mockGL2 = {
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
      COMPILE_STATUS: 0x8b81,
      LINK_STATUS: 0x8b82,
      ARRAY_BUFFER: 0x8892,
      ELEMENT_ARRAY_BUFFER: 0x8893,
      STATIC_DRAW: 0x88e4,
      DYNAMIC_DRAW: 0x88e8,
      FLOAT: 0x1406,
      UNSIGNED_INT: 0x1405,
      LINES: 0x0001,
      TRIANGLE_STRIP: 0x0005,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      DEPTH_TEST: 0x0b71,
      LEQUAL: 0x0203,
      BLEND: 0x0be2,
      ONE: 1,
      ONE_MINUS_SRC_ALPHA: 0x0303,
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
      bindVertexArray: () => {},
      createBuffer: () => ({}),
      bindBuffer: () => {},
      bufferData: () => {},
      enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      vertexAttribDivisor: () => {},
      getUniformLocation: () => ({}),
      viewport: () => {},
      clearColor: () => {},
      clear: () => {},
      enable: () => {},
      depthFunc: () => {},
      blendFunc: () => {},
      useProgram: () => {},
      uniform1f: () => {},
      uniform2f: () => {},
      uniform4f: () => {},
      drawElements: () => {},
      drawArraysInstanced: (_mode: number, _first: number, _count: number, instanceCount: number) => {
        drawInstancedCalls.push(instanceCount);
      }
    };

    const origGetContext = HTMLCanvasElement.prototype.getContext;
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    };
    HTMLCanvasElement.prototype.getContext = function (type: string) {
      if (type === "webgl2") return mockGL2 as unknown as WebGL2RenderingContext;
      if (type === "2d") return mock2D as unknown as CanvasRenderingContext2D;
      return null;
    } as typeof HTMLCanvasElement.prototype.getContext;

    try {
      const { container } = render(
        React.createElement(MemoryGraph3D, {
          nodes,
          edges,
          positions,
          coordinates,
          showTitles: true,
          selectedNodeId: null,
          onSelectNode: () => {},
          loading: false,
          resetToken: 0
        })
      );

      const canvas = container.querySelector("canvas[role='application']") as HTMLCanvasElement;
      expect(canvas).toBeTruthy();
      expect(canvas.dataset.renderer).toBe("webgl2");
      expect(drawInstancedCalls.at(-1)).toBe(nodes.length);

      const lostEvent = new Event("webglcontextlost", { cancelable: true });
      canvas.dispatchEvent(lostEvent);
      expect(lostEvent.defaultPrevented).toBe(true);
      expect(canvas.dataset.renderer).toBe("canvas2d");

      const restoredEvent = new Event("webglcontextrestored");
      canvas.dispatchEvent(restoredEvent);
      expect(canvas.dataset.renderer).toBe("webgl2");
    } finally {
      cleanup();
      HTMLCanvasElement.prototype.getContext = origGetContext;
      window.requestAnimationFrame = origRaf;
    }
  });
});
