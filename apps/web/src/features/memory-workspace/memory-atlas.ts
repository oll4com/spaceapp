import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export const ATLAS_COLORS = ["#57ccff", "#ff79bc", "#ab95ff", "#53e2ba", "#ffc56c", "#fa887e", "#a0df73", "#8caaff"];
export type MemoryAtlasPosition = { x: number; y: number; color: string; hub: boolean; groupId: string; monthLabel?: string };
export type MemoryAtlasGroup = { id: string; label: string; color: string; count: number; kind: "tag" | "topic" | "month" | "archive" };
const sourceMonthCache = new Map<string, string | null>();
const monthLabelCache = new Map<string, string>();

/**
 * Extracts a canonical source month (YYYY-MM) from a memory graph node's sourcePath.
 *
 * @param node Memory graph node to inspect.
 * @returns Month string in format "YYYY-MM", or null if not dated.
 */
export const memorySourceMonth = (node: MemoryGraphNode): string | null => {
  const path = node.sourcePath;
  if (!path) return null;
  const cached = sourceMonthCache.get(path);
  if (cached !== undefined) return cached;
  const parsed = path.match(/(?:^|[_/-])(20\d{2}-(?:0[1-9]|1[0-2]))(?:[_. /-]|$)/)?.[1] ?? null;
  if (sourceMonthCache.size > 2048) sourceMonthCache.clear();
  sourceMonthCache.set(path, parsed);
  return parsed;
};

/**
 * Formats a canonical month string (YYYY-MM) into a human-readable label (e.g. "Jul 2026").
 *
 * @param month Month string in format "YYYY-MM".
 * @returns Human-readable short month and year label.
 */
export const memoryMonthLabel = (month: string): string => {
  const cached = monthLabelCache.get(month);
  if (cached !== undefined) return cached;
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", { month: "short", year: "numeric", timeZone: "UTC" });
  monthLabelCache.set(month, label);
  return label;
};

export const MIN_ATLAS_TAG_COUNT = 10;

/**
 * Constructs an atlas clustering layout, color assignment, and group taxonomy for memory graph nodes.
 * Colors and labels describe real taxonomy or canonical source months; links are never invented.
 *
 * @param nodes List of memory graph nodes.
 * @param edges List of memory graph edges.
 * @param computeLayout When true, executes 2D force simulation layout for small graphs.
 * @param minTagCount Minimum occurrences for an explicit tag to form an atlas anchor.
 * @returns Memory atlas with positioned nodes, active groups, topics, and edge counts.
 */
export function createMemoryAtlas(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], computeLayout = true, minTagCount = MIN_ATLAS_TAG_COUNT) {
  const isLargeGraph = nodes.length > 2000;
  const byId = isLargeGraph ? null : new Map<string, MemoryGraphNode>();
  const topicNodeIds = isLargeGraph ? new Set<string>() : null;
  const nonMemoryNodeIds = isLargeGraph ? new Set<string>() : null;
  let otherNodeCount = 0;
  if (isLargeGraph) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.type !== "MEMORY") {
        nonMemoryNodeIds!.add(node.id);
        if (node.type === "TOPIC") {
          topicNodeIds!.add(node.id);
        } else if (node.type !== "SOURCE" && node.type !== "ROOM") {
          otherNodeCount++;
        }
      }
    }
  } else {
    for (const node of nodes) byId!.set(node.id, node);
  }
  const topicMembers = new Map<string, Set<string>>();
  const explicit = new Set<string>();
  let semanticCount = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    if (edge.type === "SEMANTICALLY_RELATED") semanticCount++;
    if (edge.type !== "TAGGED_WITH") continue;
    if (isLargeGraph) {
      if (!topicNodeIds!.has(edge.target) || nonMemoryNodeIds!.has(edge.source)) continue;
    } else {
      if (byId!.get(edge.target)?.type !== "TOPIC" || byId!.get(edge.source)?.type !== "MEMORY") continue;
    }
    if (edge.origin === "EXPLICIT_TAG") explicit.add(edge.target);
    let members = topicMembers.get(edge.target);
    if (!members) {
      members = new Set();
      topicMembers.set(edge.target, members);
    }
    members.add(edge.source);
  }
  const topics = nodes.filter(node => node.type === "TOPIC" && (explicit.has(node.id) ? (topicMembers.get(node.id)?.size ?? 0) >= minTagCount : (topicMembers.get(node.id)?.size ?? 0) >= 2))
    .sort((a, b) => Number(explicit.has(b.id)) - Number(explicit.has(a.id)) || (topicMembers.get(b.id)?.size ?? 0) - (topicMembers.get(a.id)?.size ?? 0) || a.id.localeCompare(b.id));
  // Near-identical tags should not consume every color in the overview.
  const anchors: MemoryGraphNode[] = [];
  for (const topic of topics) {
    const members = topicMembers.get(topic.id)!;
    const duplicate = anchors.some(anchor => {
      const previous = topicMembers.get(anchor.id)!;
      let intersection = 0;
      const [smaller, larger] = members.size <= previous.size ? [members, previous] : [previous, members];
      let checked = 0;
      for (const id of smaller) {
        if (larger.has(id)) intersection++;
        if (isLargeGraph && ++checked >= 128) {
          intersection = Math.round((intersection / 128) * smaller.size);
          break;
        }
      }
      return intersection / (members.size + previous.size - intersection) > 0.82;
    });
    if (!duplicate) anchors.push(topic);
    if (anchors.length === 6) break;
  }
  const anchorIds = new Set(anchors.map(anchor => anchor.id));
  const assignments = new Map<string, string>();
  anchors.forEach(topic => {
    assignments.set(topic.id, topic.id);
    const currentSize = topicMembers.get(topic.id)!.size;
    for (const id of topicMembers.get(topic.id)!) {
      const previous = assignments.get(id);
      if (!previous || topicMembers.get(previous)!.size > currentSize) assignments.set(id, topic.id);
    }
  });
  // Assign remaining themes by their real members, rather than by the first edge encountered.
  for (const topic of topics) {
    if (assignments.has(topic.id)) continue;
    const votes = new Map<string, number>();
    let checked = 0;
    for (const id of topicMembers.get(topic.id)!) {
      const group = assignments.get(id);
      if (group) votes.set(group, (votes.get(group) ?? 0) + 1);
      if (isLargeGraph && ++checked >= 128) break;
    }
    const best = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) assignments.set(topic.id, best[0]);
  }
  const topicIds = new Set(topics.map(node => node.id));
  let visibleNodes = isLargeGraph && otherNodeCount === 0 && topics.length === topicNodeIds?.size
    ? nodes
    : nodes.filter(node => node.type === "MEMORY" || node.type === "SOURCE" || node.type === "ROOM" || topicIds.has(node.id));
  if (!visibleNodes.length) visibleNodes = nodes;
  const allNodesVisible = visibleNodes.length === nodes.length;
  const vLen = visibleNodes.length;
  let visibleEdges: MemoryGraphEdge[];
  if (allNodesVisible && isLargeGraph) {
    visibleEdges = edges;
  } else {
    const ids = allNodesVisible && byId ? byId : new Set(visibleNodes.map(node => node.id));
    visibleEdges = edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  }
  const residualMonths = new Map<string, number>();
  const cachedMonths = new Array<string | null>(vLen);
  const preAssigned = new Array<string | undefined>(vLen);
  let lastPath: string | null | undefined = undefined;
  let lastMonth: string | null = null;
  for (let i = 0; i < vLen; i++) {
    const node = visibleNodes[i]!;
    const path = node.sourcePath;
    const month = path === lastPath ? lastMonth : (lastPath = path, lastMonth = memorySourceMonth(node));
    cachedMonths[i] = month;
    const assigned = assignments.get(node.id);
    if (assigned !== undefined) {
      preAssigned[i] = assigned;
      continue;
    }
    if (month) residualMonths.set(month, (residualMonths.get(month) ?? 0) + 1);
  }
  const monthSlots = 8;
  const monthKeys = [...residualMonths].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(0, monthSlots).map(([month]) => month).sort();
  const monthKeySet = new Set(monthKeys);
  const groupInfo = new Map<string, Pick<MemoryAtlasGroup, "label" | "kind">>(anchors.map(topic => [topic.id, { label: topic.label, kind: explicit.has(topic.id) ? "tag" : "topic" }]));
  for (const month of monthKeys) groupInfo.set(`month:${month}`, { label: memoryMonthLabel(month), kind: "month" });

  const positions = new Map<string, MemoryAtlasPosition>();
  const groups: MemoryAtlasGroup[] = [];

  if (vLen <= 2000) {
    const buckets = new Map<string, MemoryGraphNode[]>();
    for (let i = 0; i < vLen; i++) {
      if (preAssigned[i] !== undefined) continue;
      const node = visibleNodes[i]!;
      const month = cachedMonths[i];
      const group = month && monthKeySet.has(month) ? `month:${month}` : "archive:other";
      assignments.set(node.id, group);
      if (!groupInfo.has(group)) groupInfo.set(group, { label: month ? "Other months" : "Other knowledge", kind: "archive" });
    }
    const bucketSource = [...visibleNodes].sort((a, b) => a.id.localeCompare(b.id));
    for (const node of bucketSource) {
      const group = assignments.get(node.id)!;
      let bucket = buckets.get(group);
      if (!bucket) {
        bucket = [];
        buckets.set(group, bucket);
      }
      bucket.push(node);
    }
    const activeGroups = [...groupInfo].filter(([id]) => buckets.has(id));
    const networkPositions = computeLayout ? layoutMemoryNetwork(visibleNodes, visibleEdges) : null;
    const fallbackIndex = !networkPositions && visibleNodes.some(n => !n.position?.relations)
      ? new Map(visibleNodes.map((n, i) => [n.id, i]))
      : null;
    activeGroups.forEach(([groupId, info], groupIndex) => {
      const members = buckets.get(groupId)!;
      const color = info.kind === "archive" ? "#7395ad" : ATLAS_COLORS[groupIndex % ATLAS_COLORS.length]!;
      let memoryCount = 0;
      for (let i = 0; i < members.length; i++) {
        const node = members[i]!;
        if (node.type === "MEMORY") memoryCount++;
        const hub = node.type === "SOURCE" || anchorIds.has(node.id);
        let posX: number;
        let posY: number;
        if (networkPositions) {
          const p = networkPositions.get(node.id)!;
          posX = p.x;
          posY = p.y;
        } else if (node.position?.relations) {
          posX = node.position.relations.x;
          posY = node.position.relations.y;
        } else {
          const idx = fallbackIndex?.get(node.id) ?? i;
          posX = idx % 40;
          posY = Math.floor(idx / 40);
        }
        const month = memorySourceMonth(node);
        const nodeColor = isMemoryCoreLabel(node.label) ? "#fff0b0" : color;
        positions.set(
          node.id,
          month
            ? { x: posX, y: posY, color: nodeColor, hub, groupId, monthLabel: memoryMonthLabel(month) }
            : { x: posX, y: posY, color: nodeColor, hub, groupId }
        );
      }
      groups.push({ id: groupId, label: info.label, kind: info.kind, color, count: memoryCount });
    });
  } else {
    const nodeGroups = new Array<string>(vLen);
    const hasMembers = new Set<string>();
    for (let i = 0; i < vLen; i++) {
      let group = preAssigned[i];
      if (group === undefined) {
        const month = cachedMonths[i];
        group = month && monthKeySet.has(month) ? `month:${month}` : "archive:other";
        if (!groupInfo.has(group)) groupInfo.set(group, { label: month ? "Other months" : "Other knowledge", kind: "archive" });
      }
      nodeGroups[i] = group;
      hasMembers.add(group);
    }
    interface GroupMetaEntry {
      id: string;
      color: string;
      count: number;
      info: Pick<MemoryAtlasGroup, "label" | "kind">;
      defaultPos: MemoryAtlasPosition;
      monthPos: Map<string, MemoryAtlasPosition>;
    }
    const groupMeta = new Map<string, GroupMetaEntry>();
    let groupIndex = 0;
    for (const [groupId, info] of groupInfo) {
      if (!hasMembers.has(groupId)) continue;
      const color = info.kind === "archive" ? "#7395ad" : ATLAS_COLORS[groupIndex % ATLAS_COLORS.length]!;
      groupIndex++;
      groupMeta.set(groupId, {
        id: groupId,
        color,
        count: 0,
        info,
        defaultPos: { x: 0, y: 0, color, hub: false, groupId },
        monthPos: new Map()
      });
    }
    const nodeMetas = new Array<GroupMetaEntry>(vLen);
    for (let i = 0; i < vLen; i++) {
      nodeMetas[i] = groupMeta.get(nodeGroups[i]!)!;
    }
    for (let i = 0; i < vLen; i++) {
      const node = visibleNodes[i]!;
      const meta = nodeMetas[i]!;
      const isMemory = node.type === "MEMORY";
      if (isMemory) meta.count++;
      const hub = !isMemory && (node.type === "SOURCE" || anchorIds.has(node.id));
      const rel = node.position?.relations;
      const month = cachedMonths[i];
      const isCore = !isMemory && isMemoryCoreLabel(node.label);
      if (!rel && !hub && !isCore) {
        if (!month) {
          positions.set(node.id, meta.defaultPos);
        } else {
          let entry = meta.monthPos.get(month);
          if (!entry) {
            entry = { x: 0, y: 0, color: meta.color, hub: false, groupId: meta.id, monthLabel: memoryMonthLabel(month) };
            meta.monthPos.set(month, entry);
          }
          positions.set(node.id, entry);
        }
        continue;
      }
      const posX = rel ? rel.x : i % 40;
      const posY = rel ? rel.y : Math.floor(i / 40);
      const nodeColor = isCore ? "#fff0b0" : meta.color;
      if (month) {
        positions.set(node.id, { x: posX, y: posY, color: nodeColor, hub, groupId: meta.id, monthLabel: memoryMonthLabel(month) });
      } else {
        positions.set(node.id, { x: posX, y: posY, color: nodeColor, hub, groupId: meta.id });
      }
    }
    for (const [groupId, meta] of groupMeta) {
      groups.push({ id: groupId, label: meta.info.label, kind: meta.info.kind, color: meta.color, count: meta.count });
    }
  }
  if (!allNodesVisible) {
    semanticCount = 0;
    for (let i = 0; i < visibleEdges.length; i++) {
      if (visibleEdges[i]!.type === "SEMANTICALLY_RELATED") semanticCount++;
    }
  }
  return {
    nodes: visibleNodes, edges: visibleEdges, positions, groups,
    topics: anchors.map(node => ({ ...node, color: groups.find(group => group.id === node.id)!.color, count: topicMembers.get(node.id)!.size, explicit: explicit.has(node.id) })),
    explicitCount: explicit.size,
    semanticCount
  };
}
