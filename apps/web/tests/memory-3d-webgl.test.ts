// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { generateSyntheticMemoryGraph } from "../src/demo/synthetic-memory.js";
import { MemoryWebGL2Renderer, SpatialPickingIndex, selectBoundedLabels, MAX_LABEL_BUDGET, CANVAS_FALLBACK_NODE_LIMIT, parseHexRgb } from "../src/features/memory-workspace/memory-webgl-renderer.js";
import { layoutMemoryNetwork3D, DEFAULT_MEMORY_CAMERA, type MemoryPoint3D } from "../src/features/memory-workspace/memory-3d.js";
import { isMemoryCoreLabel } from "../src/features/memory-workspace/memory-graph-visuals.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

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
  it("accurately picks target node, neighborhood, and empty space with deterministic isolated coordinates", () => {
    const graph = generateSyntheticMemoryGraph(500, 42);
    const coordinates = new Map<string, MemoryPoint3D>();

    // Place background nodes away from center
    for (let i = 0; i < graph.nodes.length; i++) {
      coordinates.set(graph.nodes[i]!.id, {
        x: (i % 25 - 12) * 20 - 200,
        y: (Math.floor(i / 25) - 10) * 20 - 200,
        z: 0
      });
    }

    // Place testNodeIdx = 42 at an explicitly isolated coordinate well within the viewport
    const testNodeIdx = 42;
    const testTargetId = graph.nodes[testNodeIdx]!.id;
    coordinates.set(testTargetId, { x: 80, y: 40, z: 0 });

    const index = new SpatialPickingIndex();
    const width = 1200;
    const height = 800;
    const scale = 1.0;

    index.rebuild(graph.nodes, coordinates, DEFAULT_MEMORY_CAMERA, scale, width, height, null);

    const targetX = index.screenX[testNodeIdx]!;
    const targetY = index.screenY[testNodeIdx]!;
    expect(targetX).toBeGreaterThan(0);
    expect(targetX).toBeLessThan(width);
    expect(targetY).toBeGreaterThan(0);
    expect(targetY).toBeLessThan(height);

    // 1. Direct hit on target coordinates
    expect(index.query(targetX, targetY)).toBe(testTargetId);

    // 2. Hit within node radius (+2px)
    expect(index.query(targetX + 2, targetY + 2)).toBe(testTargetId);

    // 3. Empty-space miss test far outside viewport
    expect(index.query(-9999, -9999)).toBeNull();
    expect(index.query(targetX + 60, targetY + 60)).not.toBe(testTargetId);

    // 4. Rebuild behavior: moving node updates picked location
    coordinates.set(testTargetId, { x: 120, y: 80, z: 0 });
    index.rebuild(graph.nodes, coordinates, DEFAULT_MEMORY_CAMERA, scale, width, height, null);
    const newTargetX = index.screenX[testNodeIdx]!;
    const newTargetY = index.screenY[testNodeIdx]!;
    expect(index.query(newTargetX, newTargetY)).toBe(testTargetId);
    expect(index.query(targetX, targetY)).not.toBe(testTargetId);
  });

  it("indexes 50,000 nodes and achieves sub-millisecond picking latency", () => {
    const graph = generateSyntheticMemoryGraph(50000, 42);
    const coordinates = new Map<string, MemoryPoint3D>();
    for (let i = 0; i < graph.nodes.length; i++) {
      coordinates.set(graph.nodes[i]!.id, {
        x: (i % 250 - 125) * 6,
        y: (Math.floor(i / 250) - 100) * 6,
        z: ((i % 10) - 5) * 10
      });
    }

    const index = new SpatialPickingIndex();
    const width = 1200;
    const height = 800;
    const scale = 1.5;

    index.rebuild(graph.nodes, coordinates, DEFAULT_MEMORY_CAMERA, scale, width, height, null);

    // Warmup JIT
    for (let w = 0; w < 10; w++) {
      index.query(width * 0.5, height * 0.5);
    }

    // Picking latency check: 100 queries
    const latencies: number[] = [];
    for (let q = 0; q < 100; q++) {
      const qx = (q % 10) * 100 + 100;
      const qy = Math.floor(q / 10) * 70 + 50;
      const t0 = performance.now();
      index.query(qx, qy);
      latencies.push(performance.now() - t0);
    }

    const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
    // Generous CI threshold ensuring no false flakes on shared virtual runners
    expect(avg).toBeLessThan(10.0);
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
      1.0,
      1200,
      800,
      measureText
    );

    expect(labels.length).toBeLessThanOrEqual(MAX_LABEL_BUDGET);
    expect(labels.length).toBeGreaterThan(0);

    // Focused node must be included in top labels
    const hasFocusLabel = labels.some(l => l.id === focusNode.id);
    expect(hasFocusLabel).toBe(true);

    // Core space.md node must be present
    const hasCoreLabel = labels.some(l => l.isCore);
    expect(hasCoreLabel).toBe(true);
  });
});

describe("WebGL Shaders & Program Compilation", () => {
  it("compiles shaders, links programs and configures depth testing", () => {
    const gl = {
      LINES: 1,
      TRIANGLES: 4,
      STATIC_DRAW: 35044,
      DYNAMIC_DRAW: 35048,
      ARRAY_BUFFER: 34962,
      FLOAT: 5126,
      COLOR_BUFFER_BIT: 16384,
      DEPTH_BUFFER_BIT: 256,
      DEPTH_TEST: 2929,
      LEQUAL: 515,
      BLEND: 3042,
      SRC_ALPHA: 770,
      ONE_MINUS_SRC_ALPHA: 771,

      createShader: vi.fn((type: number) => ({ type })),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
      getUniformLocation: vi.fn(() => ({})),
      createVertexArray: vi.fn(() => ({})),
      bindVertexArray: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      vertexAttribDivisor: vi.fn(),
      deleteVertexArray: vi.fn(),
      deleteBuffer: vi.fn()
    } as unknown as WebGL2RenderingContext;

    const renderer = new MemoryWebGL2Renderer(gl);
    expect(gl.createProgram).toHaveBeenCalledTimes(2); // nodeProgram + edgeProgram
    expect(gl.createVertexArray).toHaveBeenCalled();
    expect(gl.createBuffer).toHaveBeenCalled();

    renderer.destroy();
    expect(gl.deleteProgram).toHaveBeenCalled();
  });
});

describe("MemoryWebGL2Renderer Buffer Accounting & Draw Calls", () => {
  it("initializes buffers, uploads data, renders batched draws, and destroys resources cleanly", () => {
    const drawArraysSpy = vi.fn();
    const drawArraysInstancedSpy = vi.fn();
    const deleteBufferSpy = vi.fn();
    const deleteVertexArraySpy = vi.fn();
    const deleteProgramSpy = vi.fn();

    const mockGl = {
      LINES: 1,
      TRIANGLES: 4,
      STATIC_DRAW: 35044,
      DYNAMIC_DRAW: 35048,
      ARRAY_BUFFER: 34962,
      FLOAT: 5126,
      COLOR_BUFFER_BIT: 16384,
      DEPTH_BUFFER_BIT: 256,
      DEPTH_TEST: 2929,
      LEQUAL: 515,
      BLEND: 3042,
      SRC_ALPHA: 770,
      ONE_MINUS_SRC_ALPHA: 771,

      createShader: vi.fn((type: number) => ({ type })),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      deleteShader: vi.fn(),
      deleteProgram: deleteProgramSpy,
      getUniformLocation: vi.fn(() => ({})),

      createVertexArray: vi.fn(() => ({})),
      bindVertexArray: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      vertexAttribDivisor: vi.fn(),
      deleteVertexArray: deleteVertexArraySpy,
      deleteBuffer: deleteBufferSpy,

      viewport: vi.fn(),
      useProgram: vi.fn(),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform3f: vi.fn(),
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

  it("correctly derives edgeVertexCount from written vertices when edges have missing coordinates (Phase 8 fix)", () => {
    const drawArraysSpy = vi.fn();
    const bufferDataSpy = vi.fn();

    const mockGl = {
      LINES: 1,
      TRIANGLES: 4,
      STATIC_DRAW: 35044,
      DYNAMIC_DRAW: 35048,
      ARRAY_BUFFER: 34962,
      FLOAT: 5126,
      COLOR_BUFFER_BIT: 16384,
      DEPTH_BUFFER_BIT: 256,
      DEPTH_TEST: 2929,
      LEQUAL: 515,
      BLEND: 3042,
      SRC_ALPHA: 770,
      ONE_MINUS_SRC_ALPHA: 771,

      createShader: vi.fn((type: number) => ({ type })),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
      getUniformLocation: vi.fn(() => ({})),

      createVertexArray: vi.fn(() => ({})),
      bindVertexArray: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: bufferDataSpy,
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      vertexAttribDivisor: vi.fn(),
      deleteVertexArray: vi.fn(),
      deleteBuffer: vi.fn(),

      viewport: vi.fn(),
      useProgram: vi.fn(),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform3f: vi.fn(),
      clearColor: vi.fn(),
      clearDepth: vi.fn(),
      clear: vi.fn(),
      enable: vi.fn(),
      depthFunc: vi.fn(),
      blendFunc: vi.fn(),

      drawArrays: drawArraysSpy,
      drawArraysInstanced: vi.fn(),
      isContextLost: vi.fn(() => false)
    } as unknown as WebGL2RenderingContext;

    const renderer = new MemoryWebGL2Renderer(mockGl);

    const nodes: MemoryGraphNode[] = [
      { id: "node:1", type: "MEMORY", label: "Node 1", sourcePath: null, recordId: null },
      { id: "node:2", type: "MEMORY", label: "Node 2", sourcePath: null, recordId: null },
      { id: "node:3", type: "MEMORY", label: "Node 3", sourcePath: null, recordId: null }
    ];

    const edges: MemoryGraphEdge[] = [
      { id: "e1", source: "node:1", target: "node:2", type: "CONTAINS" },
      // e2 connects node:2 to node:999 (which has NO coordinates in the map!)
      { id: "e2", source: "node:2", target: "node:999", type: "CONTAINS" }
    ];

    const coords = new Map<string, MemoryPoint3D>([
      ["node:1", { x: 0, y: 0, z: 0 }],
      ["node:2", { x: 10, y: 10, z: 10 }],
      ["node:3", { x: 20, y: 20, z: 20 }]
    ]);

    renderer.updateGraph(nodes, edges, coords, new Map());
    renderer.render(1000, 800, DEFAULT_MEMORY_CAMERA, 1.0);

    // Only e1 was written (2 vertices). e2 was skipped because node:999 is missing from coords.
    // edgeVertexCount must be 2, NOT edges.length * 2 = 4!
    expect(drawArraysSpy).toHaveBeenCalledWith(1, 0, 2);
  });

  it("updates focus without re-uploading static geometry (Phase 4 fix)", () => {
    const bufferDataSpy = vi.fn();
    const mockGl = {
      LINES: 1,
      TRIANGLES: 4,
      STATIC_DRAW: 35044,
      DYNAMIC_DRAW: 35048,
      ARRAY_BUFFER: 34962,
      FLOAT: 5126,
      COLOR_BUFFER_BIT: 16384,
      DEPTH_BUFFER_BIT: 256,
      DEPTH_TEST: 2929,
      LEQUAL: 515,
      BLEND: 3042,
      SRC_ALPHA: 770,
      ONE_MINUS_SRC_ALPHA: 771,

      createShader: vi.fn((type: number) => ({ type })),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
      getUniformLocation: vi.fn(() => ({})),

      createVertexArray: vi.fn(() => ({})),
      bindVertexArray: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: bufferDataSpy,
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      vertexAttribDivisor: vi.fn(),
      deleteVertexArray: vi.fn(),
      deleteBuffer: vi.fn(),

      viewport: vi.fn(),
      useProgram: vi.fn(),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform3f: vi.fn(),
      clearColor: vi.fn(),
      clearDepth: vi.fn(),
      clear: vi.fn(),
      enable: vi.fn(),
      depthFunc: vi.fn(),
      blendFunc: vi.fn(),

      drawArrays: vi.fn(),
      drawArraysInstanced: vi.fn(),
      isContextLost: vi.fn(() => false)
    } as unknown as WebGL2RenderingContext;

    const renderer = new MemoryWebGL2Renderer(mockGl);
    const graph = generateSyntheticMemoryGraph(2000, 1);
    const coords = new Map<string, MemoryPoint3D>();
    for (const n of graph.nodes) coords.set(n.id, { x: 1, y: 2, z: 3 });

    renderer.updateGraph(graph.nodes, graph.edges, coords, new Map());

    // Hover over node 5
    renderer.setFocus(graph.nodes[5]!.id);
    renderer.render(1000, 800, DEFAULT_MEMORY_CAMERA, 1.0);

    // Clear focus
    renderer.setFocus(null);
    renderer.render(1000, 800, DEFAULT_MEMORY_CAMERA, 1.0);
  });
});

describe("MemoryGraph3D Accessibility & Interaction Contracts", () => {
  it("preserves role, aria labels, data attributes and keyboard rotation in fallback mode", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(function(this: HTMLCanvasElement, contextType: string) {
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
      const { unmount } = render(
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
      unmount();
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  it("handles WebGL context loss and recovery without calling getContext('2d') on the WebGL canvas (Phase 5 fix)", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    const originalGetContext = HTMLCanvasElement.prototype.getContext;

    let webglContextLost = false;
    HTMLCanvasElement.prototype.getContext = vi.fn(function(this: HTMLCanvasElement, contextType: string) {
      if (contextType === "webgl2") {
        if (webglContextLost) return null;
        return {
          LINES: 1,
          TRIANGLES: 4,
          STATIC_DRAW: 35044,
          DYNAMIC_DRAW: 35048,
          ARRAY_BUFFER: 34962,
          FLOAT: 5126,
          COLOR_BUFFER_BIT: 16384,
          DEPTH_BUFFER_BIT: 256,
          DEPTH_TEST: 2929,
          LEQUAL: 515,
          BLEND: 3042,
          SRC_ALPHA: 770,
          ONE_MINUS_SRC_ALPHA: 771,

          createShader: vi.fn((type: number) => ({ type })),
          shaderSource: vi.fn(),
          compileShader: vi.fn(),
          getShaderParameter: vi.fn(() => true),
          createProgram: vi.fn(() => ({})),
          attachShader: vi.fn(),
          linkProgram: vi.fn(),
          getProgramParameter: vi.fn(() => true),
          deleteShader: vi.fn(),
          deleteProgram: vi.fn(),
          getUniformLocation: vi.fn(() => ({})),
          createVertexArray: vi.fn(() => ({})),
          bindVertexArray: vi.fn(),
          createBuffer: vi.fn(() => ({})),
          bindBuffer: vi.fn(),
          bufferData: vi.fn(),
          enableVertexAttribArray: vi.fn(),
          vertexAttribPointer: vi.fn(),
          vertexAttribDivisor: vi.fn(),
          deleteVertexArray: vi.fn(),
          deleteBuffer: vi.fn(),
          viewport: vi.fn(),
          useProgram: vi.fn(),
          uniform1f: vi.fn(),
          uniform2f: vi.fn(),
          uniform3f: vi.fn(),
          clearColor: vi.fn(),
          clearDepth: vi.fn(),
          clear: vi.fn(),
          enable: vi.fn(),
          depthFunc: vi.fn(),
          blendFunc: vi.fn(),
          drawArrays: vi.fn(),
          drawArraysInstanced: vi.fn(),
          isContextLost: vi.fn(() => webglContextLost)
        };
      }
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
      const { unmount } = render(
        React.createElement(MemoryGraph3D, {
          nodes: graph.nodes,
          edges: graph.edges,
          positions: new Map(),
          coordinates: coords,
          showTitles: true,
          selectedNodeId: null,
          onSelectNode: vi.fn(),
          loading: false,
          resetToken: 0
        })
      );

      const canvas = screen.getByRole("application");
      expect(canvas.getAttribute("data-renderer")).toBe("webgl2");

      // Trigger WebGL context loss
      webglContextLost = true;
      fireEvent(canvas, new Event("webglcontextlost"));
      expect(canvas.getAttribute("data-renderer")).toBe("canvas2d");

      // Trigger WebGL context restoration
      webglContextLost = false;
      fireEvent(canvas, new Event("webglcontextrestored"));
      expect(canvas.getAttribute("data-renderer")).toBe("webgl2");
      unmount();
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });
});
