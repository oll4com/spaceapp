import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphPayload } from "@space/contracts";
import { DEMO_FIXED_AT } from "./demo-fixture.js";

/**
 * Deterministic synthetic memory graph for demo mode, so the 50,000-node benchmark can
 * be reproduced without a backend or embeddings provider. Structure mirrors a real
 * archive: one core file, source files, records contained in them, explicit topics and
 * semantic neighbour links, roughly three edges per node.
 */
export function createSyntheticMemoryGraph(size: number): MemoryGraphPayload {
  const target = Math.max(2, Math.min(50000, Math.floor(size)));
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const push = (node: MemoryGraphNode) => { nodes.push(node); return node.id; };
  const rootId = "source:synthetic-space";
  push({ id: rootId, type: "SOURCE", label: "space.md", sourcePath: "/demo/synthetic/space.md", recordId: null, position: { clustered: { x: 0, y: 0 }, relations: { x: 0, y: 0 } } });
  const sourceCount = Math.max(1, Math.min(400, Math.floor(target / 50)));
  const sourceIds: string[] = [];
  for (let file = 0; file < sourceCount && nodes.length < target; file++) {
    const id = "source:synthetic-" + String(file).padStart(4, "0");
    sourceIds.push(id);
    push({ id, type: "SOURCE", label: "synthetic-notes-" + String(file).padStart(4, "0") + ".md", sourcePath: "/demo/synthetic/notes-" + String(file).padStart(4, "0") + ".md", recordId: null,
      position: { clustered: { x: -40 + (file % 20) * 4, y: -20 + Math.floor(file / 20) * 4 }, relations: { x: -30 + (file % 20) * 3, y: -15 + Math.floor(file / 20) * 3 } } });
    edges.push({ id: "edge:derived-" + file, type: "DERIVED_FROM", source: rootId, target: id });
  }
  const topicCount = Math.max(1, Math.min(48, Math.floor(target / 1250)));
  const topicIds: string[] = [];
  for (let topic = 0; topic < topicCount && nodes.length < target; topic++) {
    const id = "topic:synthetic-" + String(topic).padStart(3, "0");
    topicIds.push(id);
    push({ id, type: "TOPIC", label: "synthetic theme " + String(topic).padStart(3, "0"), sourcePath: null, recordId: null,
      position: { clustered: { x: 30 + (topic % 6) * 5, y: -30 + Math.floor(topic / 6) * 6 }, relations: { x: 26 + (topic % 6) * 4, y: -26 + Math.floor(topic / 6) * 5 } } });
  }
  let index = 0;
  let previousMemory: string | null = null;
  while (nodes.length < target) {
    const id = "memory:synthetic-" + String(index).padStart(6, "0");
    const file = sourceIds[index % sourceIds.length]!;
    push({ id, type: "MEMORY", label: "Synthetic memory " + String(index).padStart(6, "0"), sourcePath: null, recordId: null,
      position: { clustered: { x: (index % 37) * 2 - 37, y: (index % 23) * 2 - 23 }, relations: { x: (index % 29) * 2 - 29, y: (index % 17) * 2 - 17 } } });
    edges.push({ id: "edge:contains-" + index, type: "CONTAINS", source: file, target: id });
    if (topicIds.length && index % 12 === 0) edges.push({ id: "edge:tagged-" + index, type: "TAGGED_WITH", source: id, target: topicIds[index % topicIds.length]!, origin: "EXPLICIT_TAG", confidence: 1, evidence: "Synthetic demo tag." });
    if (previousMemory) edges.push({ id: "edge:semantic-" + index, type: "SEMANTICALLY_RELATED", source: previousMemory, target: id, confidence: 0.8, evidence: "Synthetic demo similarity." });
    const sameFilePrevious = index - sourceCount;
    if (sameFilePrevious >= 0) edges.push({ id: "edge:semantic-file-" + index, type: "SEMANTICALLY_RELATED", source: "memory:synthetic-" + String(sameFilePrevious).padStart(6, "0"), target: id, confidence: 0.7, evidence: "Synthetic demo similarity." });
    previousMemory = id;
    index++;
  }
  return {
    version: 2,
    generatedAt: DEMO_FIXED_AT,
    sourceHash: "e".repeat(64),
    revisionHash: "f".repeat(64),
    isStale: false,
    summary: { sourceCount: sourceIds.length + 1, recordCount: index, nodeCount: nodes.length, edgeCount: edges.length, issueCount: 0 },
    nodes,
    edges,
    layoutVersion: 2,
    taxonomyVersion: 2,
    filters: { q: null, nodeType: null, scope: null, roomId: null, sourcePath: null, lifecycleStatus: null, relationMode: "RELATIONS", month: null },
    months: []
  };
}
