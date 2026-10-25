import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MemoryGraphNode } from "@space/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopMemoryGraph from "../src/features/memory-workspace/DesktopMemoryGraph.js";

const sigmaMock = vi.hoisted(() => {
  type GraphLike = {
    getNodeAttribute: (nodeId: string, name: string) => unknown;
    hasNode: (nodeId: string) => boolean;
    order: number;
  };
  type NodeAttributes = Record<string, unknown>;
  type CanvasNodeDrawingFunction = (
    context: CanvasRenderingContext2D,
    data: NodeAttributes,
    settings: Record<string, unknown>
  ) => void;
  type SigmaSettings = {
    nodeReducer?: (nodeId: string, attributes: NodeAttributes) => NodeAttributes;
    defaultDrawNodeLabel?: CanvasNodeDrawingFunction;
    defaultDrawNodeHover?: CanvasNodeDrawingFunction;
  };
  type SigmaHandler = (payload: { node: string }) => void;

  const construct = vi.fn();
  const instances: SigmaMock[] = [];

  class SigmaMock {
    graph: GraphLike;
    settings: SigmaSettings;
    canvases = {
      edges: document.createElement("canvas"),
      nodes: document.createElement("canvas")
    };
    handlers = new Map<string, SigmaHandler>();
    camera = {
      animate: vi.fn(async () => undefined),
      animatedReset: vi.fn(async () => undefined)
    };
    setGraph = vi.fn((graph: GraphLike) => { this.graph = graph; });
    setSetting = vi.fn();
    refresh = vi.fn();
    resize = vi.fn();
    kill = vi.fn();

    constructor(graph: GraphLike, _container: HTMLElement, settings: SigmaSettings) {
      this.graph = graph;
      this.settings = settings;
      construct();
      instances.push(this);
    }

    getGraph() {
      return this.graph;
    }

    getCanvases() {
      return this.canvases;
    }

    getCamera() {
      return this.camera;
    }

    getNodeDisplayData(nodeId: string) {
      return this.graph.hasNode(nodeId) ? { x: 0, y: 0 } : undefined;
    }

    on(event: string, handler: SigmaHandler) {
      this.handlers.set(event, handler);
      return this;
    }

    emit(event: string, payload: { node: string }) {
      this.handlers.get(event)?.(payload);
    }
  }

  return { construct, instances, SigmaMock };
});

vi.mock("sigma", () => ({ default: sigmaMock.SigmaMock }));

function memoryNode(id: string, index = 0): MemoryGraphNode {
  return {
    id,
    type: "MEMORY",
    label: `Memory ${id}`,
    sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
    recordId: id,
    position: {
      clustered: { x: index, y: index + 1 },
      relations: { x: index + 2, y: index + 3 }
    }
  };
}

const onSelectNode = vi.fn();
const common = {
  nodes: [] as MemoryGraphNode[],
  edges: [],
  displayMode: "FOCUSED" as const,
  relationMode: "CLUSTERED" as const,
  selectedNodeId: null,
  onSelectNode,
  loading: false,
  error: null,
  totalNodes: 0,
  totalEdges: 0,
  truncated: false
};

describe("DesktopMemoryGraph", () => {
  beforeEach(() => {
    sigmaMock.construct.mockClear();
    sigmaMock.instances.length = 0;
    onSelectNode.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("explains loading, error, empty and truncated states instead of leaving a blank canvas", () => {
    const { rerender } = render(<DesktopMemoryGraph {...common} loading />);
    expect(screen.getByRole("status").textContent).toContain("Loading memory map");
    expect(screen.getByLabelText("Memory map legend").textContent).toContain("Explicit tag");
    expect(screen.getByLabelText("Memory map legend").textContent).toContain("Derived topic");
    expect(screen.getByText(/0 explicit tags · 0 derived topics · 0 semantic links/)).toBeTruthy();

    rerender(<DesktopMemoryGraph {...common} error="Memory map request failed." />);
    expect(screen.getByRole("alert").textContent).toContain("Memory map request failed.");

    rerender(<DesktopMemoryGraph {...common} />);
    expect(screen.getByText("No memories found. Try another search.")).toBeTruthy();

    rerender(<DesktopMemoryGraph {...common} truncated totalNodes={2_400} totalEdges={7_500} />);
    expect(screen.getByText(/Exploring/).textContent).toContain("2,400 archive nodes");
  });

  it("keeps one Sigma renderer through repeated graph, display-mode, and relation-mode changes", () => {
    const { rerender } = render(<DesktopMemoryGraph {...common} nodes={[memoryNode("memory:0")]} />);

    for (let index = 1; index <= 12; index += 1) {
      rerender(
        <DesktopMemoryGraph
          {...common}
          nodes={[memoryNode(`memory:${index}`, index)]}
          displayMode={index % 2 === 0 ? "FOCUSED" : "SEMANTIC"}
          relationMode={index % 2 === 0 ? "CLUSTERED" : "RELATIONS"}
        />
      );
    }

    expect(sigmaMock.construct).toHaveBeenCalledTimes(1);
    expect(sigmaMock.instances).toHaveLength(1);
    expect(sigmaMock.instances[0]!.setGraph).toHaveBeenCalledTimes(13);
    expect(sigmaMock.instances[0]!.kill).not.toHaveBeenCalled();
  });

  it("recovers from an empty result by swapping data into the existing renderer", () => {
    const { rerender } = render(<DesktopMemoryGraph {...common} />);

    expect(sigmaMock.construct).toHaveBeenCalledTimes(1);
    expect(sigmaMock.instances[0]!.getGraph().order).toBe(0);

    rerender(<DesktopMemoryGraph {...common} nodes={[memoryNode("memory:available")]} totalNodes={1} />);

    expect(sigmaMock.construct).toHaveBeenCalledTimes(1);
    expect(sigmaMock.instances[0]!.getGraph().hasNode("memory:available")).toBe(true);
    expect(screen.getByText(/Drag to explore/)).toBeTruthy();
  });

  it("cancels stale reveal batches when a newer graph arrives", () => {
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const firstNodes = Array.from({ length: 321 }, (_, index) => memoryNode(`memory:first-${index}`, index));
    const { rerender } = render(<DesktopMemoryGraph {...common} nodes={firstNodes} totalNodes={firstNodes.length} />);
    const renderer = sigmaMock.instances[0]!;
    const firstGraph = renderer.setGraph.mock.calls.at(-1)![0];

    expect(firstGraph.order).toBe(140);
    rerender(<DesktopMemoryGraph {...common} nodes={[memoryNode("memory:latest")]} totalNodes={1} />);

    act(() => { vi.advanceTimersByTime(500); });
    expect(clearTimeout).toHaveBeenCalled();
    expect(firstGraph.order).toBe(140);
    expect(renderer.getGraph().order).toBe(1);
    expect(renderer.getGraph().hasNode("memory:latest")).toBe(true);
  });

  it("focuses a selected semantic node once its deferred reveal batch reaches Sigma", () => {
    vi.useFakeTimers();
    const nodes = Array.from({ length: 321 }, (_, index) => memoryNode(`memory:${index}`, index));
    const deferredNode = nodes.at(-1)!;
    const { rerender } = render(
      <DesktopMemoryGraph
        {...common}
        displayMode="SEMANTIC"
        relationMode="RELATIONS"
        nodes={nodes}
        totalNodes={nodes.length}
      />
    );
    const renderer = sigmaMock.instances[0]!;

    rerender(
      <DesktopMemoryGraph
        {...common}
        displayMode="SEMANTIC"
        relationMode="RELATIONS"
        nodes={nodes}
        totalNodes={nodes.length}
        selectedNodeId={deferredNode.id}
      />
    );
    expect(renderer.getGraph().hasNode(deferredNode.id)).toBe(false);
    expect(renderer.camera.animate).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(240); });
    expect(renderer.getGraph().hasNode(deferredNode.id)).toBe(true);
    expect(renderer.camera.animate).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(500); });
    expect(renderer.camera.animate).toHaveBeenCalledTimes(1);
  });

  it("keeps only important hub, hovered and selected labels without manual focus or label controls", () => {
    const hub = memoryNode("memory:hub");
    const leaves = [
      memoryNode("memory:leaf-1", 1),
      memoryNode("memory:leaf-2", 2),
      memoryNode("memory:leaf-3", 3)
    ];
    const edges = leaves.map((leaf, index) => ({
      id: `edge:${index}`,
      type: "SEMANTICALLY_RELATED" as const,
      source: hub.id,
      target: leaf.id,
      origin: "DETERMINISTIC_TFIDF" as const,
      confidence: 0.8
    }));
    const { rerender } = render(
      <DesktopMemoryGraph {...common} nodes={[hub, ...leaves]} edges={edges} totalNodes={4} totalEdges={3} />
    );
    const renderer = sigmaMock.instances[0]!;
    const reduceNode = renderer.settings.nodeReducer!;
    const hubAttributes = { label: hub.label, color: "#72c0b1", size: 8, importantHub: true };
    const leafAttributes = { label: leaves[0]!.label, color: "#72c0b1", size: 8, importantHub: false };

    expect(screen.queryByRole("combobox", { name: "Focus graph node" })).toBeNull();
    expect(screen.queryByRole("button", { name: /map labels/i })).toBeNull();
    expect(renderer.getGraph().getNodeAttribute(hub.id, "forceLabel")).toBe(true);
    expect(renderer.getGraph().getNodeAttribute(leaves[0]!.id, "forceLabel")).toBe(false);
    expect(reduceNode(hub.id, hubAttributes).label).toBe(hub.label);
    expect(reduceNode(leaves[0]!.id, leafAttributes).label).toBeNull();

    act(() => { renderer.emit("enterNode", { node: leaves[0]!.id }); });
    expect(reduceNode(leaves[0]!.id, leafAttributes).label).toBe(leaves[0]!.label);
    act(() => { renderer.emit("leaveNode", { node: leaves[0]!.id }); });

    rerender(
      <DesktopMemoryGraph
        {...common}
        nodes={[hub, ...leaves]}
        edges={edges}
        totalNodes={4}
        totalEdges={3}
        selectedNodeId={leaves[0]!.id}
      />
    );
    expect(reduceNode(leaves[0]!.id, leafAttributes).label).toBe(leaves[0]!.label);
  });

  it("supports keyboard discovery without bringing back dropdowns", () => {
    render(<DesktopMemoryGraph {...common} displayMode="SEMANTIC" nodes={[memoryNode("memory:first"), memoryNode("memory:second")]} totalNodes={2} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.keyDown(screen.getByRole("application"), { key: "ArrowRight" });
    expect(onSelectNode).toHaveBeenCalledWith("memory:first");
  });

  it("draws readable highlighted labels and keeps the selected node bright while another node is hovered", () => {
    const selected = memoryNode("memory:selected");
    const hovered = memoryNode("memory:hovered", 1);
    render(
      <DesktopMemoryGraph
        {...common}
        nodes={[selected, hovered]}
        totalNodes={2}
        selectedNodeId={selected.id}
      />
    );
    const renderer = sigmaMock.instances[0]!;
    const reduceNode = renderer.settings.nodeReducer!;
    const attributes = { label: selected.label, color: "#72c0b1", size: 8 };

    act(() => { renderer.emit("enterNode", { node: hovered.id }); });
    expect(reduceNode(selected.id, attributes)).toMatchObject({
      color: "#ffffff",
      highlighted: true,
      selected: true
    });
    expect(reduceNode(hovered.id, { ...attributes, label: hovered.label })).toMatchObject({
      color: "#b0eaff",
      highlighted: true,
      hovered: true
    });

    const fillStyles: string[] = [];
    const strokeStyles: string[] = [];
    const context = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 84 })),
      save: vi.fn(),
      restore: vi.fn(),
      set fillStyle(value: string) { fillStyles.push(value); },
      set strokeStyle(value: string) { strokeStyles.push(value); }
    } as unknown as CanvasRenderingContext2D;
    const drawSettings = { labelSize: 14, labelFont: "sans-serif", labelWeight: "500" };

    renderer.settings.defaultDrawNodeHover!(context, {
      x: 20,
      y: 30,
      size: 8,
      label: selected.label,
      color: "#ffffff",
      selected: true
    }, drawSettings);
    expect(fillStyles).toEqual(expect.arrayContaining(["#f4e6c1", "#222627"]));
    expect(strokeStyles).toContain("#ffffff");
    expect(context.fillText).toHaveBeenCalledWith(selected.label, expect.any(Number), expect.any(Number));

    renderer.settings.defaultDrawNodeLabel!(context, {
      x: 20,
      y: 30,
      size: 8,
      label: hovered.label,
      color: "#72c0b1"
    }, drawSettings);
    expect(fillStyles).toContain("#c8dfec");
  });

  it("does not dim a replacement graph when the selected node is filtered out", () => {
    const selected = memoryNode("memory:selected");
    const replacement = memoryNode("memory:replacement", 1);
    const { rerender } = render(
      <DesktopMemoryGraph {...common} nodes={[selected]} totalNodes={1} selectedNodeId={selected.id} />
    );
    const renderer = sigmaMock.instances[0]!;
    const reduceNode = renderer.settings.nodeReducer!;
    const attributes = { label: replacement.label, color: "#72c0b1", size: 8 };

    rerender(
      <DesktopMemoryGraph {...common} nodes={[replacement]} totalNodes={1} selectedNodeId={selected.id} />
    );

    expect(reduceNode(replacement.id, attributes)).toMatchObject({
      color: attributes.color,
      size: attributes.size,
      label: null,
      forceLabel: false
    });
    expect(sigmaMock.construct).toHaveBeenCalledTimes(1);
  });

  it("keeps the graph workspace visible and offers Retry after WebGL context loss", () => {
    render(<DesktopMemoryGraph {...common} nodes={[memoryNode("memory:context")]} totalNodes={1} />);
    const lostEvent = new Event("webglcontextlost", { cancelable: true });

    act(() => { sigmaMock.instances[0]!.canvases.nodes.dispatchEvent(lostEvent); });

    expect(lostEvent.defaultPrevented).toBe(true);
    expect(screen.getByLabelText("Interactive memory map")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("graphics context was lost");
    fireEvent.click(screen.getByRole("button", { name: "Retry memory map" }));
    expect(sigmaMock.construct).toHaveBeenCalledTimes(2);
    expect(sigmaMock.instances[0]!.kill).toHaveBeenCalledOnce();
    expect(screen.queryByText(/graphics context was lost/)).toBeNull();
  });
});
