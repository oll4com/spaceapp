import { describe, expect, it, vi } from "vitest";
import { generateSyntheticMemoryGraph } from "../src/demo/synthetic-memory.js";
import { MemoryWebGL2Renderer, SpatialPickingIndex, selectBoundedLabels, MAX_LABEL_BUDGET, CANVAS_FALLBACK_NODE_LIMIT, parseHexRgb } from "../src/features/memory-workspace/memory-webgl-renderer.js";
import { layoutMemoryNetwork3D, DEFAULT_MEMORY_CAMERA, type MemoryPoint3D } from "../src/features/memory-workspace/memory-3d.js";
import { isMemoryCoreLabel } from "../src/features/memory-workspace/memory-graph-visuals.js";
import type { MemoryGraphNode } from "@space/contracts";

describe("Synthetic Memory Graph Generator", () => {
  it("generates 2,000, 10,000, and 50,000 nodes with ~3x edges deterministically", () => {
    const graph2k = generateSyntheticMemoryGraph(2000, 42);
    expect(graph2k.nodes.length).toBe(2000);
    expect(graph2k.edges.length).toBeGreaterThan(4000);
    expect(graph2k.edges.length).toBeLessThan(7000);

    const graph10k = generateSyntheticMemoryGraph(10000, 42);
    expect(graph10k.nodes.length).toBe(10000);
    expect(graph10k.edges.length).toBeGreaterThan(25000);

    const graph50k = generateSyntheticMemoryGraph(50000, 42);
    expect(graph50k.nodes.length).toBe(50000);
    expect(graph50k.edges.length).toBeGreaterThan(120000);
    expect(graph50k.edges.length).toBeLessThanOrEqual(150000);

    // Root node uses space.md and is recognized as core
    const root = graph50k.nodes[0]!;
    expect(root.label).toBe("space.md");
    expect(isMemoryCoreLabel(root.label)).toBe(true);

    // Deterministic repeatability: same seed produces identical graphs
    const graph50kRepeat = generateSyntheticMemoryGraph(50000, 42);
    expect(graph50kRepeat.nodes[100]).toEqual(graph50k.nodes[100]);
    expect(graph50kRepeat.edges[500]).toEqual(graph50k.edges[500]);
  });
});

describe("Screen-Space Spatial Picking Index (50,000 Nodes)", () => {
  it("indexes 50,000 nodes and achieves sub-millisecond picking latency (target <= 4ms)", () => {
    const graph = generateSyntheticMemoryGraph(50000, 42);
    const coordinates = new Map<string, MemoryPoint3D>();
    for (let i = 0; i < graph.nodes.length; i++) {
      coordinates.set(graph.nodes[i]!.id, {
        x: (Math.random() - 0.5) * 500,
        y: (Math.random() - 0.5) * 500,
        z: (Math.random() - 0.5) * 500
      });
    }

    const index = new SpatialPickingIndex();
    const width = 1200;
    const height = 800;
    const scale = 2.0;

    // Index rebuild benchmark
    const startRebuild = performance.now();
    index.rebuild(graph.nodes, coordinates, DEFAULT_MEMORY_CAMERA, scale, width, height, null);
    const rebuildDuration = performance.now() - startRebuild;
    expect(rebuildDuration).toBeLessThan(50); // fast rebuild

    // Accurate hit test: pick directly on known projected node
    const testNodeIdx = 42;
    const targetX = index.screenX[testNodeIdx]!;
    const targetY = index.screenY[testNodeIdx]!;
    const targetId = graph.nodes[testNodeIdx]!.id;

    const hit = index.query(targetX, targetY);
    expect(hit).toBe(targetId);

    // Miss test: click far away from viewport
    const miss = index.query(-9999, -9999);
    expect(miss).toBeNull();

    // Warmup JIT
    for (let w = 0; w < 10; w++) {
      index.query(width * 0.5, height * 0.5);
    }

    // Picking latency benchmark: 100 queries
    const latencies: number[] = [];
    for (let q = 0; q < 100; q++) {
      const qx = Math.random() * width;
      const qy = Math.random() * height;
      const t0 = performance.now();
      index.query(qx, qy);
      latencies.push(performance.now() - t0);
    }

    latencies.sort((a, b) => a - b);
    const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
    const p50 = latencies[Math.floor(latencies.length * 0.5)]!;
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    const max = latencies[latencies.length - 1]!;

    // Must satisfy acceptance criteria: picking latency <= 4 ms
    expect(avg).toBeLessThan(4.0);
    expect(p50).toBeLessThan(4.0);
    expect(p95).toBeLessThan(4.0);
    expect(max).toBeLessThan(4.0);
  });
});

describe("Bounded Label LOD (50,000 Nodes)", () => {
  it("enforces hard label budget (<= 32) and prioritizes focused and core nodes", () => {
    const graph = generateSyntheticMemoryGraph(50000, 42);
    const coordinates = new Map<string, MemoryPoint3D>();
    for (let i = 0; i < graph.nodes.length; i++) {
      coordinates.set(graph.nodes[i]!.id, {
        x: (i % 50 - 25) * 10,
        y: (Math.floor(i / 50) % 50 - 25) * 10,
        z: 0
      });
    }

    const index = new SpatialPickingIndex();
    const focusNode = graph.nodes[100]!;
    index.rebuild(graph.nodes, coordinates, DEFAULT_MEMORY_CAMERA, 1.5, 1200, 800, focusNode.id);

    const measureText = (text: string) => text.length * 7;
    const labels = selectBoundedLabels(
      graph.nodes,
      index,
      focusNode.id,
      DEFAULT_MEMORY_CAMERA.zoom,
      1200,
      800,
      measureText,
      MAX_LABEL_BUDGET
    );

    // Hard budget upper bound
    expect(labels.length).toBeLessThanOrEqual(MAX_LABEL_BUDGET);
    expect(labels.length).toBeGreaterThan(0);

    // Focused node must be present
    const hasFocused = labels.some(l => l.id === focusNode.id);
    expect(hasFocused).toBe(true);

    // Core root node space.md must be prioritized
    const hasCore = labels.some(l => l.isCore);
    expect(hasCore).toBe(true);
  });
});

describe("Color & Utility Parsers", () => {
  it("parses hex colors correctly with fallbacks", () => {
    const white = parseHexRgb("#ffffff");
    expect(white).toEqual([1, 1, 1]);

    const blue = parseHexRgb("#0000ff");
    expect(blue).toEqual([0, 0, 1]);

    const shortHex = parseHexRgb("#fff");
    expect(shortHex).toEqual([1, 1, 1]);

    const fallback = parseHexRgb("invalid");
    expect(fallback[0]).toBeCloseTo(0.45);
  });
});

describe("WebGL2 Renderer Lifecycle & Draw Calls", () => {
  it("creates shaders, compiles programs, binds instanced buffers and executes draw calls", () => {
    const drawArraysInstancedSpy = vi.fn();
    const drawArraysSpy = vi.fn();
    const deleteBufferSpy = vi.fn();
    const deleteVertexArraySpy = vi.fn();
    const deleteProgramSpy = vi.fn();

    const mockGl = {
      VERTEX_SHADER: 35633,
      FRAGMENT_SHADER: 35632,
      COMPILE_STATUS: 35713,
      LINK_STATUS: 35714,
      ARRAY_BUFFER: 34962,
      STATIC_DRAW: 35044,
      DYNAMIC_DRAW: 35048,
      FLOAT: 5126,
      TRIANGLES: 4,
      LINES: 1,
      COLOR_BUFFER_BIT: 16384,
      DEPTH_BUFFER_BIT: 256,
      DEPTH_TEST: 2929,
      LEQUAL: 515,
      BLEND: 3042,
      SRC_ALPHA: 770,
      ONE_MINUS_SRC_ALPHA: 771,

      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      getShaderInfoLog: vi.fn(() => ""),
      deleteShader: vi.fn(),

      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      getProgramInfoLog: vi.fn(() => ""),
      deleteProgram: deleteProgramSpy,
      useProgram: vi.fn(),

      getUniformLocation: vi.fn((_p, name) => ({ name })),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform3f: vi.fn(),

      createVertexArray: vi.fn(() => ({})),
      bindVertexArray: vi.fn(),
      deleteVertexArray: deleteVertexArraySpy,

      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      deleteBuffer: deleteBufferSpy,

      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      vertexAttribDivisor: vi.fn(),

      viewport: vi.fn(),
      clearColor: vi.fn(),
      clearDepth: vi.fn(),
      clear: vi.fn(),
      enable: vi.fn(),
      depthFunc: vi.fn(),
      blendFunc: vi.fn(),

      drawArrays: drawArraysSpy,
      drawArraysInstanced: drawArraysInstancedSpy,
      isContextLost: vi.fn(() => false)
    } as unknown as WebGL2RenderingContext;

    const renderer = new MemoryWebGL2Renderer(mockGl);

    const graph = generateSyntheticMemoryGraph(2000, 1);
    const coords = new Map<string, MemoryPoint3D>();
    for (const n of graph.nodes) coords.set(n.id, { x: 10, y: 20, z: 30 });

    renderer.updateBuffers(graph.nodes, graph.edges, coords, new Map(), null);
    renderer.render(1000, 700, DEFAULT_MEMORY_CAMERA, 1.0);

    // Verify batched line edges and instanced node triangles were drawn
    expect(drawArraysSpy).toHaveBeenCalledWith(1, 0, graph.edges.length * 2);
    expect(drawArraysInstancedSpy).toHaveBeenCalledWith(4, 0, 6, 2000);

    // Verify cleanup
    renderer.destroy();
    expect(deleteBufferSpy).toHaveBeenCalled();
    expect(deleteVertexArraySpy).toHaveBeenCalled();
    expect(deleteProgramSpy).toHaveBeenCalled();
  });
});

describe("MemoryGraph3D Accessibility & Interaction Contracts", () => {
  it("preserves role, aria labels, data attributes and keyboard rotation in fallback mode", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn((contextType: string) => {
      if (contextType === "2d") {
        return {
          clearRect: vi.fn(),
          fillRect: vi.fn(),
          beginPath: vi.fn(),
          arc: vi.fn(),
          fill: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          stroke: vi.fn(),
          measureText: vi.fn(() => ({ width: 40 })),
          setTransform: vi.fn(),
          fillText: vi.fn()
        };
      }
      return null;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      const { MemoryGraph3D } = await import("../src/features/memory-workspace/MemoryGraph3D.js");
      const { render, screen, fireEvent } = await import("@testing-library/react");

      const graph = generateSyntheticMemoryGraph(2000, 1);
      const coords = new Map<string, MemoryPoint3D>();
      for (const n of graph.nodes) coords.set(n.id, { x: 1, y: 2, z: 3 });

      const React = await import("react");
      const onSelect = vi.fn();
      render(
        React.createElement(MemoryGraph3D, {
          nodes: graph.nodes,
          edges: graph.edges,
          positions: new Map(),
          coordinates: coords,
          showTitles: true,
          selectedNodeId: null,
          onSelectNode: onSelect,
          loading: false,
          resetToken: 0
        })
      );

      const canvas = screen.getByRole("application");
      expect(canvas).toBeDefined();
      expect(canvas.getAttribute("aria-label")).toContain("3D memory graph");
      expect(canvas.getAttribute("aria-busy")).toBe("false");
      expect(canvas.getAttribute("data-titles-visible")).toBe("true");
      expect(canvas.getAttribute("data-layout-volume")).toBeDefined();

      // In JSDOM, WebGL2 is not supported natively, so graceful Canvas 2D fallback activates
      expect(canvas.getAttribute("data-renderer")).toBe("canvas2d");

      // Keyboard rotation
      const initialRotation = canvas.getAttribute("data-rotation");
      fireEvent.keyDown(canvas, { key: "ArrowLeft" });
      const newRotation = canvas.getAttribute("data-rotation");
      expect(newRotation).not.toBe(initialRotation);

      // Keyboard selection with Enter
      fireEvent.keyDown(canvas, { key: "Enter" });
      expect(onSelect).toHaveBeenCalled();
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });
});


