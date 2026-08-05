import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphTopicOrigin } from "@space/contracts";

export interface MemoryGraphVisualStyle {
  color: string;
  size: number;
  label: string;
}

const nodeStyles: Record<MemoryGraphNode["type"], MemoryGraphVisualStyle> = {
  SOURCE: { color: "#8796a8", size: 7, label: "Source" },
  SECTION: { color: "#b79c79", size: 4.5, label: "Section" },
  MEMORY: { color: "#72c0b1", size: 5.5, label: "Memory" },
  ROOM: { color: "#79a7df", size: 6.5, label: "Room" },
  PROVENANCE: { color: "#ba8bca", size: 4.5, label: "Provenance" },
  TOPIC: { color: "#e0b45b", size: 6, label: "Tag / topic" },
  CACHE_RECORD: { color: "#8d9298", size: 3.5, label: "Cache record" }
};

const CANONICAL_INDEX_STYLE: MemoryGraphVisualStyle = { color: "#e8c05f", size: 11, label: "Canonical index" };

export function isCanonicalIndexNode(node: MemoryGraphNode): boolean {
  return node.type === "SOURCE" && (
    node.label === "gemini_history.md" ||
    node.sourcePath?.split(/[\\/]/).at(-1) === "gemini_history.md"
  );
}

const nodeTypePriority: Record<MemoryGraphNode["type"], number> = {
  SOURCE: 0,
  TOPIC: 1,
  ROOM: 2,
  MEMORY: 3,
  SECTION: 4,
  PROVENANCE: 5,
  CACHE_RECORD: 6
};
const MAX_FORCED_HUB_LABELS = 4;

function stableFraction(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0xffff_ffff;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function memoryGraphNodeStyle(
  node: MemoryGraphNode,
  topicOrigin: MemoryGraphTopicOrigin | null = null
): MemoryGraphVisualStyle {
  if (isCanonicalIndexNode(node)) return CANONICAL_INDEX_STYLE;
  if (node.type === "TOPIC" && topicOrigin === "EXPLICIT_TAG") {
    return { color: "#f2c66d", size: 7.25, label: "Explicit tag" };
  }
  if (node.type === "TOPIC" && topicOrigin === "DERIVED_TFIDF") {
    return { color: "#c89443", size: 4.2, label: "Derived topic" };
  }
  return nodeStyles[node.type];
}

export function shouldForceMemoryGraphLabel(
  node: MemoryGraphNode,
  _topicOrigin: MemoryGraphTopicOrigin | null,
  degree: number,
  degreeRank: number
): boolean {
  return isCanonicalIndexNode(node) || (degree >= 3 && degreeRank < MAX_FORCED_HUB_LABELS);
}

export function memoryGraphTaxonomySummary(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[]
): { explicitTags: number; derivedTopics: number; semanticLinks: number } {
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const explicitTags = new Set<string>();
  const derivedTopics = new Set<string>();
  let semanticLinks = 0;
  for (const edge of edges) {
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
    if (edge.type === "TAGGED_WITH" && edge.origin === "EXPLICIT_TAG") explicitTags.add(edge.target);
    if (edge.type === "TAGGED_WITH" && edge.origin === "DERIVED_TFIDF") derivedTopics.add(edge.target);
    if (edge.type === "SEMANTICALLY_RELATED") semanticLinks += 1;
  }
  return { explicitTags: explicitTags.size, derivedTopics: derivedTopics.size, semanticLinks };
}

export function memoryGraphEdgeStyle(edge: MemoryGraphEdge): MemoryGraphVisualStyle {
  switch (edge.type) {
    case "TAGGED_WITH":
      return edge.origin === "EXPLICIT_TAG"
        ? { color: "#d9aa4f", size: 1.7, label: "Explicit tag" }
        : { color: "#9d854e", size: 1.25, label: "Derived topic" };
    case "SEMANTICALLY_RELATED":
      return { color: "#4fa99a", size: 1.15 + (edge.confidence ?? 0) * 0.65, label: "Semantic similarity" };
    case "CONFLICTS_WITH":
      return { color: "#c45d66", size: 1.8, label: "Conflict" };
    case "DUPLICATES":
      return { color: "#d1845f", size: 1.45, label: "Duplicate" };
    case "SUPERSEDES":
      return { color: "#a987d0", size: 1.35, label: "Supersedes" };
    case "BELONGS_TO_ROOM":
      return { color: "#4f6f94", size: 0.9, label: "Room membership" };
    case "DERIVED_FROM":
      return { color: "#675b78", size: 0.8, label: "Provenance" };
    case "CACHED_AS":
      return { color: "#51565c", size: 0.7, label: "Cache link" };
    case "CONTAINS":
      return { color: "#40504f", size: 0.75, label: "Contains" };
  }
}

export function resolveMemoryGraphPosition(
  node: MemoryGraphNode,
  index: number,
  relationMode: "CLUSTERED" | "RELATIONS"
): { x: number; y: number } {
  const position = node.position?.[relationMode === "RELATIONS" ? "relations" : "clustered"];
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) return position;

  const clusterKey = node.clusterId ?? node.sourcePath ?? node.type;
  const clusterAngle = stableFraction(`${relationMode}:cluster:${clusterKey}`) * Math.PI * 2;
  const clusterRadius = relationMode === "CLUSTERED" ? 42 : 24;
  const localAngle = stableFraction(`${relationMode}:node:${node.id}`) * Math.PI * 2 + index * 2.399963;
  const localRadius = 7 + Math.sqrt(index + 1) * 2.4;
  return {
    x: round(Math.cos(clusterAngle) * clusterRadius + Math.cos(localAngle) * localRadius),
    y: round(Math.sin(clusterAngle) * clusterRadius + Math.sin(localAngle) * localRadius)
  };
}

export function orderMemoryGraphNodes(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): MemoryGraphNode[] {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (degree.has(edge.source)) degree.set(edge.source, degree.get(edge.source)! + 1);
    if (degree.has(edge.target)) degree.set(edge.target, degree.get(edge.target)! + 1);
  }
  return [...nodes].sort((left, right) =>
    Number(isCanonicalIndexNode(right)) - Number(isCanonicalIndexNode(left)) ||
    (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
    nodeTypePriority[left.type] - nodeTypePriority[right.type] ||
    left.id.localeCompare(right.id)
  );
}
