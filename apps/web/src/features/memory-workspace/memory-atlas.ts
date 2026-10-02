import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

export const ATLAS_COLORS = ["#57ccff", "#ff79bc", "#ab95ff", "#53e2ba", "#ffc56c", "#fa887e", "#a0df73", "#8caaff"];
export type MemoryAtlasPosition = { x: number; y: number; color: string; hub: boolean; groupId: string; monthLabel?: string };
export type MemoryAtlasGroup = { id: string; label: string; color: string; count: number; kind: "tag" | "topic" | "month" | "archive" };
export const memorySourceMonth = (node: MemoryGraphNode) => node.sourcePath?.match(/(?:^|[_/-])(20\d{2}-(?:0[1-9]|1[0-2]))(?:[_. /-]|$)/)?.[1] ?? null;
export const memoryMonthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en", { month: "short", year: "numeric", timeZone: "UTC" });

export const MIN_ATLAS_TAG_COUNT = 10;

/** Colors and labels describe real taxonomy or canonical source months; links are never invented. */
export function createMemoryAtlas(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], computeLayout = true, minTagCount = MIN_ATLAS_TAG_COUNT) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const topicMembers = new Map<string, Set<string>>();
  const explicit = new Set<string>();
  for (const edge of edges) {
    if (edge.type !== "TAGGED_WITH" || byId.get(edge.target)?.type !== "TOPIC" || byId.get(edge.source)?.type !== "MEMORY") continue;
    if (edge.origin === "EXPLICIT_TAG") explicit.add(edge.target);
    if (!topicMembers.has(edge.target)) topicMembers.set(edge.target, new Set());
    topicMembers.get(edge.target)!.add(edge.source);
  }
  const topics = nodes.filter(node => node.type === "TOPIC" && (explicit.has(node.id) ? (topicMembers.get(node.id)?.size ?? 0) >= minTagCount : (topicMembers.get(node.id)?.size ?? 0) >= 2))
    .sort((a, b) => Number(explicit.has(b.id)) - Number(explicit.has(a.id)) || (topicMembers.get(b.id)?.size ?? 0) - (topicMembers.get(a.id)?.size ?? 0) || a.id.localeCompare(b.id));
  // Near-identical tags should not consume every color in the overview.
  const anchors: MemoryGraphNode[] = [];
  for (const topic of topics) {
    const members = topicMembers.get(topic.id)!;
    const duplicate = anchors.some(anchor => {
      const previous = topicMembers.get(anchor.id)!;
      const intersection = [...members].filter(id => previous.has(id)).length;
      return intersection / (members.size + previous.size - intersection) > 0.82;
    });
    if (!duplicate) anchors.push(topic);
    if (anchors.length === 6) break;
  }
  const assignments = new Map<string, string>();
  anchors.forEach(topic => {
    assignments.set(topic.id, topic.id);
    for (const id of topicMembers.get(topic.id)!) {
      const previous = assignments.get(id);
      if (!previous || topicMembers.get(previous)!.size > topicMembers.get(topic.id)!.size) assignments.set(id, topic.id);
    }
  });
  // Assign remaining themes by their real members, rather than by the first edge encountered.
  for (const topic of topics) {
    if (assignments.has(topic.id)) continue;
    const votes = new Map<string, number>();
    for (const id of topicMembers.get(topic.id)!) {
      const group = assignments.get(id);
      if (group) votes.set(group, (votes.get(group) ?? 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) assignments.set(topic.id, best[0]);
  }
  const topicIds = new Set(topics.map(node => node.id));
  let visibleNodes = nodes.filter(node => node.type === "MEMORY" || node.type === "SOURCE" || node.type === "ROOM" || topicIds.has(node.id));
  if (!visibleNodes.length) visibleNodes = nodes;
  const ids = new Set(visibleNodes.map(node => node.id));
  const visibleEdges = edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  const residualMonths = new Map<string, number>();
  for (const node of visibleNodes) {
    if (assignments.has(node.id)) continue;
    const month = memorySourceMonth(node);
    if (month) residualMonths.set(month, (residualMonths.get(month) ?? 0) + 1);
  }
  const monthSlots = 8;
  const monthKeys = [...residualMonths].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(0, monthSlots).map(([month]) => month).sort();
  const groupInfo = new Map<string, Pick<MemoryAtlasGroup, "label" | "kind">>(anchors.map(topic => [topic.id, { label: topic.label, kind: explicit.has(topic.id) ? "tag" : "topic" }]));
  for (const month of monthKeys) groupInfo.set(`month:${month}`, { label: memoryMonthLabel(month), kind: "month" });
  for (const node of visibleNodes) {
    if (assignments.has(node.id)) continue;
    const month = memorySourceMonth(node);
    const group = month && monthKeys.includes(month) ? `month:${month}` : "archive:other";
    assignments.set(node.id, group);
    if (!groupInfo.has(group)) groupInfo.set(group, { label: month ? "Other months" : "Other knowledge", kind: "archive" });
  }
  const buckets = new Map<string, MemoryGraphNode[]>();
  for (const node of [...visibleNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const group = assignments.get(node.id)!;
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group)!.push(node);
  }
  const positions = new Map<string, MemoryAtlasPosition>();
  const groups: MemoryAtlasGroup[] = [];
  const activeGroups = [...groupInfo].filter(([id]) => buckets.has(id));
  const networkPositions = computeLayout ? layoutMemoryNetwork(visibleNodes, visibleEdges) : new Map(visibleNodes.map((node, index) => [node.id, node.position?.relations ?? { x: index % 40, y: Math.floor(index / 40) }]));
  activeGroups.forEach(([groupId, info], groupIndex) => {
    const members = buckets.get(groupId)!;
    const color = info.kind === "archive" ? "#7395ad" : ATLAS_COLORS[groupIndex % ATLAS_COLORS.length]!;
    groups.push({ id: groupId, ...info, color, count: members.filter(node => node.type === "MEMORY").length });
    members.forEach(node => {
      const hub = node.type === "SOURCE" || anchors.some(anchor => anchor.id === node.id);
      const position = networkPositions.get(node.id)!;
      const month = memorySourceMonth(node);
      positions.set(node.id, { ...position, color: node.label === "gemini.md" ? "#fff0b0" : color, hub, groupId, ...(month ? { monthLabel: memoryMonthLabel(month) } : {}) });
    });
  });
  return {
    nodes: visibleNodes, edges: visibleEdges, positions, groups,
    topics: anchors.map(node => ({ ...node, color: groups.find(group => group.id === node.id)!.color, count: topicMembers.get(node.id)!.size, explicit: explicit.has(node.id) })),
    explicitCount: explicit.size,
    semanticCount: visibleEdges.filter(edge => edge.type === "SEMANTICALLY_RELATED").length
  };
}
