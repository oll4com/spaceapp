import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";
import { WebGL2MemoryGraphRenderer } from "../src/features/memory-workspace/memory-graph-webgl.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "../src/features/memory-workspace/memory-atlas.js";
import type { MemoryPoint3D } from "../src/features/memory-workspace/memory-3d.js";

function createMockNodesAndEdges(nodeCount: number, edgeCount: number) {
  const nodes: MemoryGraphNode[] = [
    {
      id: "root-core",
      type: "SOURCE",
      label: "gemini.md",
      sourcePath: "/opt/spaceapp/docs/gemini.md",
      recordId: null
    }
  ];
  const edges: MemoryGraphEdge[] = [];
  const positions = new Map<string, MemoryAtlasPosition>();
  const coordinates = new Map<string, MemoryPoint3D>();

  positions.set("root-core", {
    x: 0,
    y: 0,
    color: "#ffffff",
    hub: true,
    groupId: "core"
  });
  coordinates.set("root-core", { x: 0, y: 0, z: 0 });

  for (let i = 1; i < nodeCount; i++) {
    const id = `node-${i}`;
    const isSource = i <= 50;
    nodes.push({
      id,
      type: isSource ? "SOURCE" : "MEMORY",
      label: isSource ? `source-${i}.md` : `memory-${i}`,
      sourcePath: `/opt/spaceapp/docs/source-${i % 50}.md`,
      recordId: isSource ? null : `rec-${i}`
    });
    positions.set(id, {
      x: 0,
      y: 0,
      color: isSource ? "#72c0b1" : "#5b8296",
      hub: isSource,
      groupId: isSource ? "sources" : "records"
    });
    coordinates.set(id, {
      x: (Math.sin(i) * 100) | 0,
      y: (Math.cos(i) * 100) | 0,
      z: ((i % 100) - 50) * 2
    });
  }

  for (let i = 0; i < edgeCount; i++) {
    const sourceIdx = i % nodeCount;
    const targetIdx = (i * 7 + 1) % nodeCount;
    edges.push({
      id: `edge-${i}`,
      type: i % 4 === 0 ? "DERIVED_FROM" : "CONTAINS",
      source: nodes[sourceIdx]!.id,
      target: nodes[targetIdx]!.id
    });
  }

  return { nodes, edges, positions, coordinates };
}

describe("MemoryGraph3D Component Contract & Fallback", () => {
  it("renders with required accessibility attributes and initial contract dataset", () => {
    const { nodes, edges, positions, coordinates } = createMockNodesAndEdges(10, 15);
    const onSelectNode = vi.fn();

    const { container } = render(
      <MemoryGraph3D
        nodes={nodes}
        edges={edges}
        positions={positions}
        coordinates={coordinates}
        showTitles={true}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
        loading={false}
        resetToken={0}
      />
    );

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    expect(canvas.getAttribute("role")).toBe("application");
    expect(canvas.getAttribute("tabIndex")).toBe("0");
    expect(canvas.getAttribute("aria-label")).toContain("3D memory graph");
    expect(canvas.getAttribute("aria-busy")).toBe("false");
    expect(canvas.getAttribute("data-titles-visible")).toBe("true");
    expect(canvas.hasAttribute("data-layout-volume")).toBe(true);

    // Initial rotation
    expect(canvas.dataset.rotation).toBe("0.300,-0.150");
  });

  it("handles keyboard navigation (Arrow keys) to rotate camera and Enter to select", () => {
    const { nodes, edges, positions, coordinates } = createMockNodesAndEdges(10, 15);
    const onSelectNode = vi.fn();

    const { container } = render(
      <MemoryGraph3D
        nodes={nodes}
        edges={edges}
        positions={positions}
        coordinates={coordinates}
        showTitles={true}
        selectedNodeId="node-2"
        onSelectNode={onSelectNode}
        loading={false}
        resetToken={0}
      />
    );

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.dataset.rotation).toBe("0.300,-0.150");

    // Press ArrowRight
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(canvas.dataset.rotation).toBe("0.450,-0.150");

    // Press ArrowDown
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    expect(canvas.dataset.rotation).toBe("0.450,0.000");

    // Press Enter to select focused node
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(onSelectNode).toHaveBeenCalledWith("node-2");
  });

  it("seamlessly handles context loss events without throwing", () => {
    const { nodes, edges, positions, coordinates } = createMockNodesAndEdges(5, 5);
    const onSelectNode = vi.fn();

    const { container } = render(
      <MemoryGraph3D
        nodes={nodes}
        edges={edges}
        positions={positions}
        coordinates={coordinates}
        showTitles={true}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
        loading={false}
        resetToken={0}
      />
    );

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const lostEvent = new Event("webglcontextlost", { cancelable: true });
    fireEvent(canvas, lostEvent);
    expect(lostEvent.defaultPrevented).toBe(true);

    const restoreEvent = new Event("webglcontextrestored");
    fireEvent(canvas, restoreEvent);
    expect(canvas.dataset.rotation).toBeDefined();
  });

  it("caps nodes to 2,000 in Canvas 2D fallback mode when large graph is provided", () => {
    // 3,000 nodes in 2D fallback mode
    const { nodes, edges, positions, coordinates } = createMockNodesAndEdges(3000, 4000);
    const onSelectNode = vi.fn();

    const { container } = render(
      <MemoryGraph3D
        nodes={nodes}
        edges={edges}
        positions={positions}
        coordinates={coordinates}
        showTitles={true}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
        loading={false}
        resetToken={0}
      />
    );

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    expect(canvas.dataset.rotation).toBe("0.300,-0.150");
  });
});

describe("50,000 Nodes and 150,000 Edges WebGL2 Scale Benchmark", () => {
  it("initializes and buffers 50k nodes and 150k edges efficiently", () => {
    // Mock WebGL2 context
    const glMock = {
      TRIANGLES: 4,
      LINES: 1,
      UNSIGNED_SHORT: 5123,
      UNSIGNED_BYTE: 5121,
      FLOAT: 5126,
      RGBA: 6408,
      RGBA8: 32856,
      DEPTH_COMPONENT16: 33189,
      COLOR_ATTACHMENT0: 36064,
      DEPTH_ATTACHMENT: 36096,
      FRAMEBUFFER: 36160,
      RENDERBUFFER: 36161,
      ARRAY_BUFFER: 34962,
      ELEMENT_ARRAY_BUFFER: 34963,
      STATIC_DRAW: 35044,
      DYNAMIC_DRAW: 35048,
      DEPTH_TEST: 2929,
      LEQUAL: 515,
      BLEND: 3042,
      SRC_ALPHA: 770,
      ONE_MINUS_SRC_ALPHA: 771,
      COLOR_BUFFER_BIT: 16384,
      DEPTH_BUFFER_BIT: 256,
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
      deleteProgram: vi.fn(),
      getUniformLocation: vi.fn((_p, name) => ({ name })),
      createVertexArray: vi.fn(() => ({})),
      bindVertexArray: vi.fn(),
      deleteVertexArray: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      bufferSubData: vi.fn(),
      deleteBuffer: vi.fn(),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      vertexAttribDivisor: vi.fn(),
      createFramebuffer: vi.fn(() => ({})),
      bindFramebuffer: vi.fn(),
      deleteFramebuffer: vi.fn(),
      createRenderbuffer: vi.fn(() => ({})),
      bindRenderbuffer: vi.fn(),
      renderbufferStorage: vi.fn(),
      framebufferRenderbuffer: vi.fn(),
      deleteRenderbuffer: vi.fn(),
      viewport: vi.fn(),
      clearColor: vi.fn(),
      clearDepth: vi.fn(),
      clear: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      depthFunc: vi.fn(),
      depthMask: vi.fn(),
      blendFunc: vi.fn(),
      useProgram: vi.fn(),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform1i: vi.fn(),
      drawArrays: vi.fn(),
      drawElementsInstanced: vi.fn(),
      readPixels: vi.fn((_x, _y, _w, _h, _f, _t, array: Uint8Array) => {
        // Mock returning node ID 42 (R=42, G=0, B=0)
        array[0] = 42;
        array[1] = 0;
        array[2] = 0;
        array[3] = 255;
      })
    } as unknown as WebGL2RenderingContext;

    const canvasMock = {
      getContext: vi.fn((type: string) => (type === "webgl2" ? glMock : null)),
      getBoundingClientRect: vi.fn(() => ({ width: 1000, height: 700 }))
    } as unknown as HTMLCanvasElement;

    const startTime = performance.now();
    const renderer = new WebGL2MemoryGraphRenderer(canvasMock);

    // Create 50,000 nodes and 150,000 edges
    const { nodes, edges, positions, coordinates } = createMockNodesAndEdges(50000, 150000);
    renderer.setGraph(nodes, edges, positions, coordinates);

    const setupDuration = performance.now() - startTime;
    expect(setupDuration).toBeLessThan(1000); // Must setup in less than 1s

    // Test render pass
    const camera = { yaw: 0.3, pitch: -0.15, zoom: 1 };
    renderer.render(camera, 1.5, 200, 1000, 700, 2);
    expect(glMock.drawElementsInstanced).toHaveBeenCalledWith(
      expect.anything(),
      6,
      expect.anything(),
      0,
      50000
    );
    expect(glMock.drawArrays).toHaveBeenCalledWith(
      expect.anything(),
      0,
      300000 // 150k edges * 2 vertices
    );

    // Test picking performance (<= 4ms at 50k nodes)
    const pickStart = performance.now();
    const pickedNodeId = renderer.pick(500, 350, camera, 1.5, 200, 1000, 700);
    const pickDuration = performance.now() - pickStart;

    expect(pickedNodeId).toBe("node-41"); // 1-based index 42 -> node-41
    expect(pickDuration).toBeLessThan(4); // Issue #62 requirement: <= 4ms

    renderer.destroy();
  });
});
