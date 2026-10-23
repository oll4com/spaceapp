// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import { layoutMemoryNetwork } from "../src/features/memory-workspace/memory-network-layout.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";
import { createMemoryNetwork3DSimulation } from "../src/features/memory-workspace/memory-3d.js";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY"): MemoryGraphNode => ({ id, type, label: id, recordId: type === "MEMORY" ? id : null, sourcePath: null });
const edge = (id: string, source: string, target: string, type: MemoryGraphEdge["type"] = "TAGGED_WITH"): MemoryGraphEdge => ({ id, source, target, type, origin: "EXPLICIT_TAG" });

describe("Memory atlas data integrity", () => {
  afterEach(cleanup);
  it("preserves source files, memories, isolates and real provenance links", () => {
    const nodes = [node("a"), node("b"), node("isolated"), node("tag", "TOPIC"), node("file", "SOURCE")];
    const edges = [edge("at", "a", "tag"), edge("bt", "b", "tag"), edge("source", "file", "a", "CONTAINS")];
    const atlas = createMemoryAtlas(nodes, edges, true, 2);
    expect(atlas.nodes.map(n => n.id)).toEqual(["a", "b", "isolated", "tag", "file"]);
    expect(atlas.edges.map(e => e.id)).toEqual(["at", "bt", "source"]);
    expect(atlas.topics[0]).toMatchObject({ id: "tag", count: 2, explicit: true });
    expect(atlas.positions.get("a")?.color).toBe(atlas.positions.get("tag")?.color);
    expect(atlas.positions.has("isolated")).toBe(true);
  });
  it("does not fabricate relationships and produces finite stable positions for large graphs", () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => node(`memory:${i}`));
    const atlas = createMemoryAtlas(nodes, []);
    expect(atlas.edges).toEqual([]);
    expect(atlas.nodes).toHaveLength(2000);
    expect(atlas.positions).toEqual(createMemoryAtlas([...nodes].reverse(), []).positions);
    expect([...atlas.positions.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
  it("derives positions from real edges and anchors the actual entrypoint", () => {
    const root = { ...node("root", "SOURCE"), label: "gemini.md" };
    const nodes = [root, node("a"), node("b")];
    const unlinked = layoutMemoryNetwork(nodes, []);
    const linked = layoutMemoryNetwork(nodes, [edge("link", "root", "a", "CONTAINS")]);
    expect(linked.get("root")).toEqual({ x: 0, y: 0 });
    expect(linked.get("a")).not.toEqual(unlinked.get("a"));
    const distance = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    expect(distance(linked.get("a")!)).toBeLessThan(distance(unlinked.get("a")!));
  });
  it("keeps structural search results usable when no memories are returned", () => {
    const atlas = createMemoryAtlas([node("source", "SOURCE")], []);
    expect(atlas.nodes).toHaveLength(1);
    expect(atlas.positions.has("source")).toBe(true);
  });
  it("labels derived topics separately and ignores dangling edge endpoints", () => {
    const atlas = createMemoryAtlas([node("a"), node("b"), node("theme", "TOPIC")], [
      { ...edge("a", "a", "theme"), origin: "DERIVED_TFIDF" },
      { ...edge("b", "b", "theme"), origin: "DERIVED_TFIDF" },
      edge("missing", "missing", "theme")
    ]);
    expect(atlas.topics[0]).toMatchObject({ explicit: false, count: 2 });
    expect(atlas.edges).toHaveLength(2);
  });
  it("uses real source months for distinct labeled groups when tags are absent", () => {
    const nodes = [
      { ...node("may"), sourcePath: "/opt/spaceapp/docs/gemini_history_2026-05.md" },
      { ...node("june"), sourcePath: "/opt/spaceapp/docs/gemini_history_2026-06.md" },
      node("undated")
    ];
    const atlas = createMemoryAtlas(nodes, []);
    expect(atlas.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "May 2026", kind: "month", count: 1 }),
      expect.objectContaining({ label: "Jun 2026", kind: "month", count: 1 }),
      expect.objectContaining({ label: "Other knowledge", kind: "archive" })
    ]));
    expect(atlas.positions.get("may")?.color).not.toBe(atlas.positions.get("june")?.color);
    expect(atlas.positions.get("may")?.groupId).toBe("month:2026-05");
    expect(atlas.edges).toEqual([]);
  });
  it("colors real themes inside one cloud without duplicate tags consuming the palette", () => {
    const nodes = [node("a"), node("b"), node("c"), node("space", "TOPIC"), node("alias", "TOPIC"), node("other", "TOPIC")];
    const atlas = createMemoryAtlas(nodes, [edge("a1", "a", "space"), edge("b1", "b", "space"), edge("a2", "a", "alias"), edge("b2", "b", "alias"), edge("c1", "c", "other")], true, 1);
    expect(atlas.topics).toHaveLength(2);
    expect(atlas.groups).toHaveLength(2);
    expect(atlas.positions.get("a")?.color).not.toBe(atlas.positions.get("c")?.color);
    expect([...atlas.positions.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });
  it("ignores tags with fewer than 10 records by default", () => {
    const nodes = [
      ...Array.from({ length: 9 }, (_, i) => node(`mem:${i}`)),
      node("rare-tag", "TOPIC")
    ];
    const edges = Array.from({ length: 9 }, (_, i) => edge(`e:${i}`, `mem:${i}`, "rare-tag"));
    const atlas = createMemoryAtlas(nodes, edges);
    expect(atlas.topics).toHaveLength(0);
    expect(atlas.groups.some(g => g.id === "rare-tag")).toBe(false);
  });
  it("includes tags with 10 or more records by default", () => {
    const nodes = [
      ...Array.from({ length: 10 }, (_, i) => node(`mem:${i}`)),
      node("frequent-tag", "TOPIC")
    ];
    const edges = Array.from({ length: 10 }, (_, i) => edge(`e:${i}`, `mem:${i}`, "frequent-tag"));
    const atlas = createMemoryAtlas(nodes, edges);
    expect(atlas.topics).toHaveLength(1);
    expect(atlas.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "frequent-tag", kind: "tag", count: 10 })
    ]));
  });
  it("renders MemoryGraph3D with accessible controls, keyboard navigation, and automatic Canvas 2D fallback when WebGL2 is unavailable", () => {
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    const nodes = Array.from({ length: 2500 }, (_, i) => node(`mem:${i}`));
    const edges = Array.from({ length: 100 }, (_, i) => edge(`e:${i}`, `mem:${i}`, `mem:${i + 1}`, "CONTAINS"));
    const atlas = createMemoryAtlas(nodes, edges);
    const sim = createMemoryNetwork3DSimulation(nodes, edges);
    sim.step(2);
    const packedCoordinates = sim.packCoordinates();
    const onSelectNode = vi.fn();

    render(
      <MemoryGraph3D
        nodes={atlas.nodes}
        edges={atlas.edges}
        positions={atlas.positions}
        coordinates={new Map()}
        packedCoordinates={packedCoordinates}
        showTitles={true}
        selectedNodeId="mem:0"
        onSelectNode={onSelectNode}
        loading={false}
        resetToken={0}
      />
    );

    const canvas = screen.getByRole("application", { name: /3D memory graph/i });
    expect(canvas.getAttribute("tabindex")).toBe("0");
    expect(canvas.getAttribute("data-renderer")).toBe("canvas2d");
    expect(canvas.getAttribute("data-fallback-node-cap")).toBe("2000");
    expect(canvas.getAttribute("data-rendered-node-count")).toBe("2000");

    const initialRotation = canvas.getAttribute("data-rotation");
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowUp" });
    expect(canvas.getAttribute("data-rotation")).not.toBe(initialRotation);

    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(onSelectNode).toHaveBeenCalledWith("mem:0");
  });

  it("restores WebGL2 rendering and GPU resources upon webglcontextrestored event after context loss", () => {
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    const nodes = Array.from({ length: 2500 }, (_, i) => node(`mem:${i}`));
    const edges = Array.from({ length: 100 }, (_, i) => edge(`e:${i}`, `mem:${i}`, `mem:${i + 1}`, "CONTAINS"));
    const atlas = createMemoryAtlas(nodes, edges);
    const sim = createMemoryNetwork3DSimulation(nodes, edges);
    sim.step(2);
    const packedCoordinates = sim.packCoordinates();

    let contextLostState = false;
    const mockGl = {
      isContextLost: vi.fn(() => contextLostState),
      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      getShaderInfoLog: vi.fn(() => ""),
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      getProgramInfoLog: vi.fn(() => ""),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
      createVertexArray: vi.fn(() => ({})),
      deleteVertexArray: vi.fn(),
      bindVertexArray: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      deleteBuffer: vi.fn(),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      bufferSubData: vi.fn(),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      vertexAttribDivisor: vi.fn(),
      getUniformLocation: vi.fn(() => ({})),
      viewport: vi.fn(),
      clearColor: vi.fn(),
      clearDepth: vi.fn(),
      clear: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      depthMask: vi.fn(),
      depthFunc: vi.fn(),
      blendFunc: vi.fn(),
      useProgram: vi.fn(),
      uniform2f: vi.fn(),
      uniform1f: vi.fn(),
      drawArrays: vi.fn(),
      drawArraysInstanced: vi.fn(),
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x0100,
      DEPTH_TEST: 0x0b71,
      LEQUAL: 0x0203,
      BLEND: 0x0be2,
      SRC_ALPHA: 0x0302,
      ONE_MINUS_SRC_ALPHA: 0x0303,
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88e4,
      DYNAMIC_DRAW: 0x88e8,
      FLOAT: 0x1406,
      UNSIGNED_BYTE: 0x1401,
      TRIANGLE_STRIP: 0x0005,
      LINES: 0x0001,
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
      COMPILE_STATUS: 0x8b81,
      LINK_STATUS: 0x8b82
    };

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement, contextId: string, options?: unknown) {
      if (contextId === "webgl2") return mockGl as unknown as WebGL2RenderingContext;
      return (originalGetContext as unknown as (this: HTMLCanvasElement, cid: string, opt?: unknown) => unknown).call(this, contextId, options);
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      render(
        <MemoryGraph3D
          nodes={atlas.nodes}
          edges={atlas.edges}
          positions={atlas.positions}
          coordinates={new Map()}
          packedCoordinates={packedCoordinates}
          showTitles={false}
          selectedNodeId={null}
          onSelectNode={() => {}}
          loading={false}
          resetToken={0}
        />
      );

      const canvas = screen.getByRole("application", { name: /3D memory graph/i });
      expect(canvas.getAttribute("data-renderer")).toBe("webgl2");
      expect(canvas.getAttribute("data-rendered-node-count")).toBe("2500");

      // 1. Trigger context loss: Canvas 2D fallback capped at 2,000 nodes takes over
      contextLostState = true;
      const lostEvent = new Event("webglcontextlost", { cancelable: true });
      canvas.dispatchEvent(lostEvent);

      expect(canvas.getAttribute("data-renderer")).toBe("canvas2d");
      expect(canvas.getAttribute("data-fallback-node-cap")).toBe("2000");
      expect(canvas.getAttribute("data-rendered-node-count")).toBe("2000");

      // 2. Trigger context restored: WebGL2 resources are reallocated and full 2,500 nodes are restored
      contextLostState = false;
      const restoredEvent = new Event("webglcontextrestored");
      canvas.dispatchEvent(restoredEvent);

      expect(canvas.getAttribute("data-renderer")).toBe("webgl2");
      expect(canvas.getAttribute("data-rendered-node-count")).toBe("2500");
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });
});

