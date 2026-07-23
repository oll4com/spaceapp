import { createHash } from "node:crypto";
import { MultiUndirectedGraph } from "graphology";
import forceAtlas2Module from "graphology-layout-forceatlas2";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphPosition } from "./types.js";

type LayoutMode = "clustered" | "relations";

interface ForceAtlas2Layout {
  assign(
    graph: MultiUndirectedGraph,
    options: {
      iterations: number;
      settings: Record<string, boolean | number | undefined>;
      getEdgeWeight: string;
    }
  ): void;
  inferSettings(graph: MultiUndirectedGraph): Record<string, boolean | number | undefined>;
}

const forceAtlas2 = forceAtlas2Module as unknown as ForceAtlas2Layout;

export interface PositionMemoryGraphOptions {
  previousNodes?: MemoryGraphNode[];
  previousEdges?: MemoryGraphEdge[];
}

function round(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function stableFraction(value: string): number {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function defaultClusterId(node: MemoryGraphNode): string {
  if (node.sourcePath) {
    const sourceHash = createHash("sha256").update(node.sourcePath).digest("hex").slice(0, 24);
    return `source:${sourceHash}`;
  }
  return `cluster:${node.type.toLocaleLowerCase()}`;
}

function nodeRadius(node: MemoryGraphNode): number {
  switch (node.type) {
    case "SOURCE":
      return 2.8;
    case "TOPIC":
    case "ROOM":
      return 2.4;
    case "PROVENANCE":
    case "SECTION":
      return 2.1;
    case "MEMORY":
      return 1.7;
    case "CACHE_RECORD":
      return 1.5;
  }
}

function isFinitePosition(position: MemoryGraphPosition | undefined): position is MemoryGraphPosition {
  return Boolean(position && Number.isFinite(position.x) && Number.isFinite(position.y));
}

function seededPosition(node: MemoryGraphNode, index: number, mode: LayoutMode, previous?: MemoryGraphNode): MemoryGraphPosition {
  const previousPosition = previous?.position?.[mode];
  if (isFinitePosition(previousPosition)) return previousPosition;
  const angle = stableFraction(`${mode}:${node.id}`) * Math.PI * 2;
  const radius = 8 + Math.sqrt(index + 1) * 2.5;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function normalizePositions(positions: Map<string, MemoryGraphPosition>, targetSpan: number): void {
  if (!positions.size) return;
  const values = [...positions.values()];
  const centerX = values.reduce((total, position) => total + position.x, 0) / values.length;
  const centerY = values.reduce((total, position) => total + position.y, 0) / values.length;
  const maxDistance = Math.max(
    1,
    ...values.map((position) => Math.hypot(position.x - centerX, position.y - centerY))
  );
  const scale = targetSpan / maxDistance;
  for (const [id, position] of positions) {
    positions.set(id, {
      x: (position.x - centerX) * scale,
      y: (position.y - centerY) * scale
    });
  }
}

function centerPositions(positions: Map<string, MemoryGraphPosition>): void {
  if (!positions.size) return;
  const values = [...positions.values()];
  const centerX = values.reduce((total, position) => total + position.x, 0) / values.length;
  const centerY = values.reduce((total, position) => total + position.y, 0) / values.length;
  for (const position of values) {
    position.x -= centerX;
    position.y -= centerY;
  }
}

function removeCollisions(nodes: MemoryGraphNode[], positions: Map<string, MemoryGraphPosition>): void {
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  for (let pass = 0; pass < 48; pass += 1) {
    let moved = false;
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      const left = ordered[leftIndex]!;
      const leftPosition = positions.get(left.id)!;
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const right = ordered[rightIndex]!;
        const rightPosition = positions.get(right.id)!;
        const minimumDistance = nodeRadius(left) + nodeRadius(right) + 0.65;
        let dx = rightPosition.x - leftPosition.x;
        let dy = rightPosition.y - leftPosition.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= minimumDistance) continue;
        if (distance < 0.000001) {
          const angle = stableFraction(`${left.id}\n${right.id}`) * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const shift = (minimumDistance - distance) / 2;
        const unitX = dx / distance;
        const unitY = dy / distance;
        leftPosition.x -= unitX * shift;
        leftPosition.y -= unitY * shift;
        rightPosition.x += unitX * shift;
        rightPosition.y += unitY * shift;
        moved = true;
      }
    }
    if (!moved) break;
  }
  centerPositions(positions);
}

function runForceAtlasLayout(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  mode: LayoutMode,
  previousById: Map<string, MemoryGraphNode>
): Map<string, MemoryGraphPosition> {
  const graph = new MultiUndirectedGraph({ allowSelfLoops: false });
  const orderedNodes = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  for (const [index, node] of orderedNodes.entries()) {
    const position = seededPosition(node, index, mode, previousById.get(node.id));
    graph.addNode(node.id, { x: position.x, y: position.y, size: nodeRadius(node) });
  }
  for (const edge of [...edges].sort((left, right) => left.id.localeCompare(right.id))) {
    if (
      edge.source === edge.target ||
      graph.hasEdge(edge.id) ||
      !graph.hasNode(edge.source) ||
      !graph.hasNode(edge.target)
    ) continue;
    graph.addEdgeWithKey(edge.id, edge.source, edge.target, { weight: 1 });
  }

  if (mode === "clustered") {
    const clusterIds = [...new Set(orderedNodes.map((node) => node.clusterId!))].sort();
    for (const clusterId of clusterIds) {
      const hubId = `__memory_graph_cluster__:${clusterId}`;
      const angle = stableFraction(hubId) * Math.PI * 2;
      const radius = Math.max(12, clusterIds.length * 3.5);
      graph.addNode(hubId, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        size: 0.25
      });
      for (const node of orderedNodes.filter((candidate) => candidate.clusterId === clusterId)) {
        graph.addEdgeWithKey(`__cluster_edge__:${node.id}`, hubId, node.id, { weight: 2.5 });
      }
    }
  }

  if (graph.order > 1) {
    forceAtlas2.assign(graph, {
      iterations: Math.min(220, Math.max(90, Math.round(72_000 / graph.order))),
      settings: {
        ...forceAtlas2.inferSettings(graph),
        adjustSizes: false,
        barnesHutOptimize: graph.order > 180,
        barnesHutTheta: 0.55,
        edgeWeightInfluence: 1,
        gravity: mode === "clustered" ? 0.08 : 0.045,
        scalingRatio: mode === "clustered" ? 14 : 18,
        slowDown: 2,
        strongGravityMode: true
      },
      getEdgeWeight: "weight"
    });
  }

  const positions = new Map<string, MemoryGraphPosition>();
  for (const node of orderedNodes) {
    positions.set(node.id, {
      x: Number(graph.getNodeAttribute(node.id, "x")),
      y: Number(graph.getNodeAttribute(node.id, "y"))
    });
  }
  normalizePositions(positions, Math.max(32, Math.sqrt(Math.max(1, orderedNodes.length)) * 8));
  removeCollisions(orderedNodes, positions);
  return positions;
}

function edgeTopology(edges: MemoryGraphEdge[]): string[] {
  return edges
    .map((edge) => `${edge.type}\n${edge.source}\n${edge.target}`)
    .sort();
}

function reusablePreviousLayout(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: PositionMemoryGraphOptions
): Map<string, MemoryGraphNode> | null {
  const previousNodes = options.previousNodes ?? [];
  if (previousNodes.length !== nodes.length || !options.previousEdges) return null;
  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  if (nodes.some((node) => {
    const previous = previousById.get(node.id);
    return !previous ||
      previous.clusterId !== node.clusterId ||
      !isFinitePosition(previous.position?.clustered) ||
      !isFinitePosition(previous.position?.relations);
  })) return null;
  const currentEdges = edgeTopology(edges);
  const previousEdges = edgeTopology(options.previousEdges);
  return currentEdges.length === previousEdges.length && currentEdges.every((edge, index) => edge === previousEdges[index])
    ? previousById
    : null;
}

export function positionMemoryGraphNodes(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[] = [],
  options: PositionMemoryGraphOptions = {}
): MemoryGraphNode[] {
  const prepared = nodes
    .map((node) => ({ ...node, clusterId: node.clusterId ?? defaultClusterId(node) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const reusable = reusablePreviousLayout(prepared, edges, options);
  if (reusable) {
    return prepared.map((node) => ({
      ...node,
      cacheRecordId: node.cacheRecordId ?? null,
      position: reusable.get(node.id)!.position
    }));
  }
  const previousById = new Map((options.previousNodes ?? []).map((node) => [node.id, node]));
  const clustered = runForceAtlasLayout(prepared, edges, "clustered", previousById);
  const relations = runForceAtlasLayout(prepared, edges, "relations", previousById);

  return prepared.map((node) => ({
    ...node,
    cacheRecordId: node.cacheRecordId ?? null,
    position: {
      clustered: {
        x: round(clustered.get(node.id)!.x),
        y: round(clustered.get(node.id)!.y)
      },
      relations: {
        x: round(relations.get(node.id)!.x),
        y: round(relations.get(node.id)!.y)
      }
    }
  }));
}
