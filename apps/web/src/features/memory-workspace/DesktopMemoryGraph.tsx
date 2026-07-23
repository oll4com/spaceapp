import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Eye, EyeOff, RotateCcw } from "lucide-react";
import { MultiDirectedGraph } from "graphology";
import Sigma from "sigma";
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import {
  memoryGraphEdgeStyle,
  memoryGraphNodeStyle,
  memoryGraphTaxonomySummary,
  orderMemoryGraphNodes,
  resolveMemoryGraphPosition,
  shouldForceMemoryGraphLabel
} from "./memory-graph-visuals.js";

const INITIAL_REVEAL_COUNT = 140;
const REVEAL_BATCH_SIZE = 180;
const REVEAL_DELAY_MS = 120;
const MEMORY_GRAPH_LABEL_COLOR = "#ded8cc";
const MEMORY_GRAPH_HIGHLIGHT_BACKGROUND = "#f4e6c1";
const MEMORY_GRAPH_HIGHLIGHT_TEXT = "#222627";
const MEMORY_GRAPH_SELECTED_COLOR = "#e05252";
const MEMORY_GRAPH_HOVER_COLOR = "#f5d78b";

const drawMemoryGraphLabel: NodeLabelDrawingFunction = (context, data, settings) => {
  if (!data.label) return;

  context.save();
  context.fillStyle = MEMORY_GRAPH_LABEL_COLOR;
  context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
  context.fillText(data.label, data.x + data.size + 3, data.y + settings.labelSize / 3);
  context.restore();
};

const drawMemoryGraphHover: NodeHoverDrawingFunction = (context, data, settings) => {
  const padding = 3;
  const labelSize = settings.labelSize;
  const radius = Math.max(data.size, labelSize / 2) + padding;

  context.save();
  context.font = `${settings.labelWeight} ${labelSize}px ${settings.labelFont}`;
  context.fillStyle = MEMORY_GRAPH_HIGHLIGHT_BACKGROUND;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.shadowBlur = 8;
  context.shadowColor = "#000";

  context.beginPath();
  if (typeof data.label === "string") {
    const boxHeight = Math.round(labelSize + padding * 2);
    const boxWidth = Math.round(context.measureText(data.label).width + 7);
    const angle = Math.asin(Math.min(1, boxHeight / 2 / radius));
    const xDelta = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2));
    context.moveTo(data.x + xDelta, data.y + boxHeight / 2);
    context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
    context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
    context.lineTo(data.x + xDelta, data.y - boxHeight / 2);
    context.arc(data.x, data.y, radius, angle, -angle);
  } else {
    context.arc(data.x, data.y, radius, 0, Math.PI * 2);
  }
  context.closePath();
  context.fill();

  context.shadowBlur = 0;
  if (data.selected === true) {
    context.lineWidth = 2;
    context.strokeStyle = MEMORY_GRAPH_SELECTED_COLOR;
    context.stroke();
  }

  if (data.label) {
    context.fillStyle = MEMORY_GRAPH_HIGHLIGHT_TEXT;
    context.fillText(data.label, data.x + data.size + 3, data.y + labelSize / 3);
  }
  context.restore();
};

const legend = [
  { label: "Memory", kind: "memory" },
  { label: "Explicit tag", kind: "explicit-tag" },
  { label: "Derived topic", kind: "derived-topic" },
  { label: "Source", kind: "source" },
  { label: "Room", kind: "room" }
];

export default function DesktopMemoryGraph({
  nodes,
  edges,
  relationMode,
  selectedNodeId,
  onSelectNode,
  loading,
  error,
  totalNodes,
  totalEdges,
  truncated
}: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  relationMode: "CLUSTERED" | "RELATIONS";
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  loading: boolean;
  error: string | null;
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const selectedNodeRef = useRef<string | null>(selectedNodeId);
  const hoveredNodeRef = useRef<string | null>(null);
  const onSelectNodeRef = useRef(onSelectNode);
  const labelsVisibleRef = useRef(true);
  const neighborsRef = useRef(new Map<string, Set<string>>());
  const graphGenerationRef = useRef(0);
  const rendererFailedRef = useRef(false);
  const [revealedCount, setRevealedCount] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererRevision, setRendererRevision] = useState(0);
  const [labelsVisible, setLabelsVisible] = useState(true);

  selectedNodeRef.current = selectedNodeId;
  onSelectNodeRef.current = onSelectNode;
  labelsVisibleRef.current = labelsVisible;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const graph = new MultiDirectedGraph({ allowSelfLoops: false });
    let renderer: Sigma | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const contextCanvases: HTMLCanvasElement[] = [];
    rendererFailedRef.current = false;
    setRenderError(null);
    setRendererReady(false);

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (rendererFailedRef.current) return;
      rendererFailedRef.current = true;
      graphGenerationRef.current += 1;
      const failedRenderer = renderer;
      if (rendererRef.current === failedRenderer) rendererRef.current = null;
      renderer = null;
      failedRenderer?.kill();
      setRendererReady(false);
      setRenderError("The memory map graphics context was lost. Retry to restore the map.");
    };

    try {
      renderer = new Sigma(graph, container, {
        labelColor: { color: MEMORY_GRAPH_LABEL_COLOR },
        labelDensity: 0.1,
        labelGridCellSize: 90,
        labelRenderedSizeThreshold: 6.5,
        hideEdgesOnMove: true,
        hideLabelsOnMove: false,
        minCameraRatio: 0.06,
        maxCameraRatio: 8,
        stagePadding: 28,
        zIndex: true,
        defaultDrawNodeLabel: drawMemoryGraphLabel,
        defaultDrawNodeHover: drawMemoryGraphHover,
        nodeReducer: (nodeId, attributes) => {
          const neighbors = neighborsRef.current;
          const hoveredNodeId = hoveredNodeRef.current && neighbors.has(hoveredNodeRef.current)
            ? hoveredNodeRef.current
            : null;
          const selectedNodeId = selectedNodeRef.current && neighbors.has(selectedNodeRef.current)
            ? selectedNodeRef.current
            : null;
          const traceNodeId = hoveredNodeId ?? selectedNodeId;
          if (!traceNodeId) {
            return labelsVisibleRef.current
              ? attributes
              : { ...attributes, forceLabel: false, label: null };
          }
          if (nodeId === selectedNodeId) {
            return {
              ...attributes,
              color: MEMORY_GRAPH_SELECTED_COLOR,
              forceLabel: true,
              highlighted: true,
              hovered: nodeId === hoveredNodeId,
              selected: true,
              size: Number(attributes.size ?? 5) * 1.65,
              zIndex: 4
            };
          }
          if (nodeId === hoveredNodeId) {
            return {
              ...attributes,
              color: MEMORY_GRAPH_HOVER_COLOR,
              forceLabel: true,
              highlighted: true,
              hovered: true,
              size: Number(attributes.size ?? 5) * 1.55,
              zIndex: 3
            };
          }
          if (neighbors.get(traceNodeId)?.has(nodeId)) {
            return {
              ...attributes,
              forceLabel: labelsVisibleRef.current,
              label: labelsVisibleRef.current ? attributes.label : null,
              size: Number(attributes.size ?? 5) * 1.12,
              zIndex: 2
            };
          }
          return {
            ...attributes,
            color: "#343a3b",
            forceLabel: false,
            label: null,
            size: Number(attributes.size ?? 5) * 0.72,
            zIndex: 0
          };
        },
        edgeReducer: (_edgeId, attributes) => {
          const neighbors = neighborsRef.current;
          const hoveredNodeId = hoveredNodeRef.current && neighbors.has(hoveredNodeRef.current)
            ? hoveredNodeRef.current
            : null;
          const selectedNodeId = selectedNodeRef.current && neighbors.has(selectedNodeRef.current)
            ? selectedNodeRef.current
            : null;
          const traceNodeId = hoveredNodeId ?? selectedNodeId;
          if (!traceNodeId) return attributes;
          const incident = attributes.sourceId === traceNodeId || attributes.targetId === traceNodeId;
          return incident
            ? { ...attributes, color: "#d8bd79", size: Number(attributes.size ?? 1) * 1.75, zIndex: 2 }
            : { ...attributes, color: "#272c2d", size: Math.max(0.35, Number(attributes.size ?? 1) * 0.55), zIndex: 0 };
        }
      });
      rendererRef.current = renderer;
      renderer.on("clickNode", ({ node }) => onSelectNodeRef.current(node));
      renderer.on("enterNode", ({ node }) => {
        hoveredNodeRef.current = node;
        container.style.cursor = "pointer";
        renderer?.refresh();
      });
      renderer.on("leaveNode", () => {
        hoveredNodeRef.current = null;
        container.style.cursor = "default";
        renderer?.refresh();
      });
      for (const canvas of Object.values(renderer.getCanvases())) {
        canvas.addEventListener("webglcontextlost", handleContextLost);
        contextCanvases.push(canvas);
      }
      resizeObserver = typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => renderer?.resize());
      resizeObserver?.observe(container);
      setRendererReady(true);
    } catch (caught) {
      setRenderError(caught instanceof Error ? caught.message : "The graph renderer could not start.");
      renderer?.kill();
      renderer = null;
      rendererRef.current = null;
      rendererFailedRef.current = true;
      setRendererReady(false);
    }

    return () => {
      graphGenerationRef.current += 1;
      resizeObserver?.disconnect();
      for (const canvas of contextCanvases) canvas.removeEventListener("webglcontextlost", handleContextLost);
      renderer?.kill();
      if (rendererRef.current === renderer) rendererRef.current = null;
      hoveredNodeRef.current = null;
      container.style.cursor = "default";
    };
  }, [rendererRevision]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const generation = graphGenerationRef.current + 1;
    graphGenerationRef.current = generation;
    setRevealedCount(0);
    if (!renderer || rendererFailedRef.current) return;

    const graph = new MultiDirectedGraph({ allowSelfLoops: false });
    const orderedNodes = orderMemoryGraphNodes(nodes, edges);
    const topicOrigins = new Map<string, "EXPLICIT_TAG" | "DERIVED_TFIDF">();
    for (const edge of edges) {
      if (edge.type !== "TAGGED_WITH" || (edge.origin !== "EXPLICIT_TAG" && edge.origin !== "DERIVED_TFIDF")) continue;
      if (edge.origin === "EXPLICIT_TAG" || !topicOrigins.has(edge.target)) topicOrigins.set(edge.target, edge.origin);
    }
    const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]));
    for (const edge of edges) {
      neighbors.get(edge.source)?.add(edge.target);
      neighbors.get(edge.target)?.add(edge.source);
    }
    neighborsRef.current = neighbors;

    let revealTimer: number | null = null;
    const isCurrent = () => (
      graphGenerationRef.current === generation &&
      rendererRef.current === renderer &&
      !rendererFailedRef.current
    );

    const addAvailableEdges = () => {
      for (const edge of edges) {
        if (
          edge.source === edge.target ||
          graph.hasEdge(edge.id) ||
          !graph.hasNode(edge.source) ||
          !graph.hasNode(edge.target)
        ) continue;
        const style = memoryGraphEdgeStyle(edge);
        graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
          color: style.color,
          size: style.size,
          sourceId: edge.source,
          targetId: edge.target,
          relationType: edge.type
        });
      }
    };

    const revealThrough = (end: number) => {
      if (!isCurrent()) return;
      const start = graph.order;
      for (let index = start; index < end; index += 1) {
        const node = orderedNodes[index]!;
        const position = resolveMemoryGraphPosition(node, index, relationMode);
        const topicOrigin = topicOrigins.get(node.id) ?? null;
        const style = memoryGraphNodeStyle(node, topicOrigin);
        graph.addNode(node.id, {
          label: node.label,
          x: position.x,
          y: position.y,
          size: style.size,
          color: style.color,
          forceLabel: shouldForceMemoryGraphLabel(node, topicOrigin),
          nodeType: node.type,
          topicOrigin
        });
      }
      addAvailableEdges();
      setRevealedCount(end);
    };

    const scheduleNextBatch = (currentEnd: number) => {
      if (!isCurrent() || currentEnd >= orderedNodes.length) return;
      revealTimer = window.setTimeout(() => {
        if (!isCurrent()) return;
        const nextEnd = Math.min(orderedNodes.length, currentEnd + REVEAL_BATCH_SIZE);
        revealThrough(nextEnd);
        renderer.refresh();
        scheduleNextBatch(nextEnd);
      }, REVEAL_DELAY_MS);
    };

    try {
      const initialEnd = Math.min(INITIAL_REVEAL_COUNT, orderedNodes.length);
      revealThrough(initialEnd);
      renderer.setGraph(graph);
      renderer.refresh();
      scheduleNextBatch(initialEnd);
    } catch (caught) {
      setRenderError(caught instanceof Error ? caught.message : "The graph renderer could not start.");
      rendererFailedRef.current = true;
      setRendererReady(false);
    }

    return () => {
      if (graphGenerationRef.current === generation) graphGenerationRef.current += 1;
      if (revealTimer !== null) window.clearTimeout(revealTimer);
    };
  }, [edges, nodes, relationMode, rendererRevision]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || rendererFailedRef.current) return;
    renderer.refresh();
    if (!selectedNodeId || !renderer.getGraph().hasNode(selectedNodeId)) return;
    const displayData = renderer.getNodeDisplayData(selectedNodeId);
    if (displayData) {
      void renderer.getCamera().animate({ x: displayData.x, y: displayData.y, ratio: 0.24 }, { duration: 360 });
    }
  }, [nodes, rendererRevision, selectedNodeId]);

  useEffect(() => {
    rendererRef.current?.refresh();
  }, [labelsVisible]);

  const visibleEdges = revealedCount >= nodes.length
    ? edges.length
    : edges.filter((edge) => {
      const graph = rendererRef.current?.getGraph();
      return graph?.hasNode(edge.source) && graph.hasNode(edge.target);
    }).length;
  const effectiveError = error ?? renderError;
  const taxonomy = memoryGraphTaxonomySummary(nodes, edges);

  return (
    <section className="memory-graph-panel" aria-label="Interactive memory map">
      <header className="memory-graph-toolbar">
        <div>
          <span>Memory map</span>
          <strong>{nodes.length.toLocaleString()} nodes · {edges.length.toLocaleString()} relationships</strong>
          <small className="memory-graph-taxonomy-summary">
            {taxonomy.explicitTags.toLocaleString()} explicit tags · {taxonomy.derivedTopics.toLocaleString()} derived topics · {taxonomy.semanticLinks.toLocaleString()} semantic links
          </small>
        </div>
        <label className="memory-graph-node-picker">
          <span>Focus node</span>
          <select
            aria-label="Focus graph node"
            name="memoryGraphFocusNode"
            disabled={nodes.length === 0}
            value={selectedNodeId ?? ""}
            onChange={(event) => { if (event.currentTarget.value) onSelectNode(event.currentTarget.value); }}
          >
            <option value="">Choose a node…</option>
            {[...nodes].sort((left, right) => left.label.localeCompare(right.label)).map((node) => (
              <option key={node.id} value={node.id}>{node.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="memory-graph-label-toggle"
          aria-label={labelsVisible ? "Hide map labels" : "Show map labels"}
          aria-pressed={!labelsVisible}
          title={labelsVisible ? "Hide map labels" : "Show map labels"}
          onClick={() => setLabelsVisible((visible) => !visible)}
        >
          {labelsVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          <span>{labelsVisible ? "Hide labels" : "Show labels"}</span>
        </button>
        <button
          type="button"
          className="memory-graph-reset"
          aria-label="Reset memory map view"
          title="Reset memory map view"
          disabled={!rendererReady}
          onClick={() => { void rendererRef.current?.getCamera().animatedReset({ duration: 360 }); }}
        >
          <RotateCcw aria-hidden="true" />
        </button>
      </header>

      <div className="memory-graph-legend" aria-label="Memory map legend">
        {legend.map((item) => <span key={item.label}><i data-node-kind={item.kind} />{item.label}</span>)}
        <span><i data-edge-kind="tag" />Taxonomy link</span>
        <span><i data-edge-kind="semantic" />Semantic link</span>
      </div>

      <div
        className="memory-graph-canvas"
        ref={containerRef}
        role="img"
        aria-label={`Canonical memory graph with ${nodes.length} visible nodes and ${edges.length} visible relationships`}
        aria-busy={loading || (!effectiveError && revealedCount < nodes.length)}
        data-relation-mode={relationMode}
      >
        {renderError ? (
          <div className="memory-graph-render-fallback" aria-hidden="true">
            <AlertTriangle />
            <strong>Map rendering paused</strong>
            <span>Use Retry below to restore the graphics layer.</span>
          </div>
        ) : !loading && !effectiveError && nodes.length === 0 ? <p>No graph nodes match these filters.</p> : null}
      </div>

      <footer className="memory-graph-status" aria-live="polite">
        {loading ? <p role="status">Loading memory map…</p> : effectiveError ? (
          <div className="memory-graph-error-state">
            <p role="alert">{effectiveError}</p>
            {renderError ? (
              <button
                type="button"
                aria-label="Retry memory map"
                onClick={() => setRendererRevision((revision) => revision + 1)}
              >
                <RotateCcw aria-hidden="true" />
                Retry
              </button>
            ) : null}
          </div>
        ) : truncated ? (
          <p>Showing the bounded map of {nodes.length.toLocaleString()} from {totalNodes.toLocaleString()} nodes and {edges.length.toLocaleString()} from {totalEdges.toLocaleString()} relationships.</p>
        ) : nodes.length > 0 && revealedCount < nodes.length ? (
          <p role="status">Revealing map… {revealedCount.toLocaleString()} of {nodes.length.toLocaleString()} nodes</p>
        ) : nodes.length > 0 ? (
          <p>{nodes.length.toLocaleString()} nodes and {visibleEdges.toLocaleString()} relationships ready. Hover to trace; select to inspect evidence.</p>
        ) : <p>Adjust filters to explore another part of canonical memory.</p>}
      </footer>
    </section>
  );
}
