import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphOverviewPayload, MemoryGraphNodeDetail } from "@space/contracts";

export type SyntheticGraphScale = "2k" | "10k" | "50k" | 2000 | 10000 | 50000;

export interface SyntheticMemoryDataset {
  graph: MemoryGraphOverviewPayload;
  nodeDetails: Record<string, MemoryGraphNodeDetail>;
}

// Deterministic PRNG (Mulberry32) for 100% reproducible synthetic generation
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPIC_TEMPLATES = [
  "Architecture & System Design",
  "Temporal Workflows & Orchestration",
  "WebGL2 Instanced Graph Shaders",
  "Vector Embeddings & Semantic Search",
  "Incremental Web Worker Layout",
  "AST Parser & Code Intelligence",
  "Docker Container Runtime Sandbox",
  "Rate Limiting & Token Bucket",
  "Session Recovery & State Hydration",
  "Agent Swarm Coordination Protocol",
  "Canonical Knowledge Atlas",
  "Browser Automation & Playwright Harness",
  "Audio Streaming & VAD Pipeline",
  "Terminal Multiplexer & PTY Daemon",
  "Security Checkpoints & Access Control",
  "Static Asset Compression & Caching",
  "Sigma Rendering & Bounded Spatial Grid",
  "Reactive EventSource & WebSocket Hub",
  "Memory Consolidation & Deduplication",
  "Multi-Agent Pair Programming Harness",
  "High-Resolution Frame Profiling",
  "Git Worktree Isolation Engine",
  "Live Voice & Whisper Model Pipeline",
  "Distributed Lock & Consensus Gate",
  "PostMessage Transferable Float32 Buffers",
  "Graphology MultiDirected Graph Core",
  "Interactive 3D Perspective Projection",
  "Zero-Lag Canvas Viewport Transformations",
  "Micro-batch Scheduler for Animation Frames",
  "Deterministic Force Simulation Mechanics"
];

const MEMORY_ACTION_TEMPLATES = [
  "Optimized WebGL2 instanced buffer allocation",
  "Implemented micro-batch scheduling to eliminate main-thread lag",
  "Added deterministic force relaxation cooling schedule",
  "Configured spatial-grid neighbor bucketing for sub-quadratic repulsion",
  "Streamed layout convergence updates across Web Worker postMessage channel",
  "Restricted transfer payloads to transferable float arrays",
  "Resolved WebGL context loss recovery lifecycle handler",
  "Fixed camera projection pitch gimbal lock at poles",
  "Profiled p95 frame rendering latency under continuous rotation",
  "Validated topic cluster coherence with cosine similarity",
  "Anchored canonical root source file at geometric origin",
  "Integrated interactive zoom clipping planes and depth testing",
  "Added keyboard arrow rotation and pinch gesture navigation",
  "Synchronized 2D and 3D coordinate space mappings",
  "Enforced 100ms task budget boundary across worker message handlers"
];

export function normalizeScale(scale: SyntheticGraphScale): { nodeCount: number; targetEdgeCount: number; label: string } {
  if (scale === "2k" || scale === 2000) return { nodeCount: 2000, targetEdgeCount: 6000, label: "2k" };
  if (scale === "10k" || scale === 10000) return { nodeCount: 10000, targetEdgeCount: 30000, label: "10k" };
  return { nodeCount: 50000, targetEdgeCount: 150000, label: "50k" };
}

/**
 * Generates a realistic synthetic memory network graph.
 * Supports 2,000, 10,000, and 50,000 nodes with 150,000 edges.
 * Degree distribution follows realistic power-law hubs (topics + sources)
 * and dense local clustering within topic/source groups.
 */
export function generateSyntheticMemoryDataset(scale: SyntheticGraphScale = "50k", seed = 42): SyntheticMemoryDataset {
  const { nodeCount, targetEdgeCount } = normalizeScale(scale);
  const rand = mulberry32(seed);

  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const nodeDetails: Record<string, MemoryGraphNodeDetail> = {};

  // 1. Root canonical entrypoint
  const rootNode: MemoryGraphNode = {
    id: "source:gemini-core",
    type: "SOURCE",
    label: "gemini.md",
    sourcePath: "/demo/memory/gemini.md",
    recordId: null,
    position: { clustered: { x: 0, y: 0 }, relations: { x: 0, y: 0 } }
  };
  nodes.push(rootNode);

  // 2. Topic nodes (30 topic clusters)
  const topicCount = Math.min(TOPIC_TEMPLATES.length, Math.max(10, Math.floor(nodeCount / 100)));
  const topicNodes: MemoryGraphNode[] = [];
  for (let i = 0; i < topicCount; i++) {
    const topicLabel = TOPIC_TEMPLATES[i % TOPIC_TEMPLATES.length]!;
    const topicId = `topic:synth-${i}`;
    const tNode: MemoryGraphNode = {
      id: topicId,
      type: "TOPIC",
      label: topicLabel,
      sourcePath: null,
      recordId: null,
      position: {
        clustered: { x: (rand() - 0.5) * 80, y: (rand() - 0.5) * 80 },
        relations: { x: (rand() - 0.5) * 120, y: (rand() - 0.5) * 120 }
      }
    };
    nodes.push(tNode);
    topicNodes.push(tNode);
  }

  // 3. Source markdown files (representing monthly journals & subsystem docs)
  const sourceCount = Math.min(120, Math.max(8, Math.floor(nodeCount / 200)));
  const sourceNodes: MemoryGraphNode[] = [];
  const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
  for (let s = 0; s < sourceCount; s++) {
    const month = months[s % months.length]!;
    const sourceId = `source:synth-${s}`;
    const sourcePath = `/demo/memory/space_memory_${month}_part${Math.floor(s / months.length) + 1}.md`;
    const sNode: MemoryGraphNode = {
      id: sourceId,
      type: "SOURCE",
      label: `space_memory_${month}_p${Math.floor(s / months.length) + 1}.md`,
      sourcePath,
      recordId: null,
      position: {
        clustered: { x: (rand() - 0.5) * 100, y: (rand() - 0.5) * 100 },
        relations: { x: (rand() - 0.5) * 150, y: (rand() - 0.5) * 150 }
      }
    };
    nodes.push(sNode);
    sourceNodes.push(sNode);

    // Link source to root
    edges.push({
      id: `edge:source-root-${s}`,
      source: rootNode.id,
      target: sourceId,
      type: "DERIVED_FROM",
      origin: "DERIVED_TFIDF"
    });
  }

  // 4. Memory nodes to reach exact nodeCount
  const existingNodeCount = nodes.length;
  const memoryCount = nodeCount - existingNodeCount;
  const memoryNodeIds: string[] = [];

  for (let m = 0; m < memoryCount; m++) {
    const memId = `memory:synth-${m}`;
    memoryNodeIds.push(memId);
    const parentSource = sourceNodes[m % sourceNodes.length]!;
    const action = MEMORY_ACTION_TEMPLATES[m % MEMORY_ACTION_TEMPLATES.length]!;
    const topic = topicNodes[Math.floor(rand() * topicNodes.length)]!;
    const label = `${action} #${m + 1}`;

    const mNode: MemoryGraphNode = {
      id: memId,
      type: "MEMORY",
      label,
      sourcePath: parentSource.sourcePath,
      recordId: memId,
      position: {
        clustered: { x: (rand() - 0.5) * 200, y: (rand() - 0.5) * 200 },
        relations: { x: (rand() - 0.5) * 200, y: (rand() - 0.5) * 200 }
      }
    };
    nodes.push(mNode);

    // CONTAINS edge from parent source
    edges.push({
      id: `edge:contains-${m}`,
      source: parentSource.id,
      target: memId,
      type: "CONTAINS"
    });

    // TAGGED_WITH edge to chosen topic
    edges.push({
      id: `edge:tag-${m}`,
      source: memId,
      target: topic.id,
      type: "TAGGED_WITH",
      origin: "EXPLICIT_TAG",
      confidence: 0.95
    });

    // Provide detailed record for node inspection
    nodeDetails[memId] = {
      node: mNode,
      record: {
        id: memId,
        sourcePath: parentSource.sourcePath ?? "/demo/memory/gemini.md",
        sectionId: "sec:synthetic",
        title: label,
        body: `Detailed benchmark memory record #${m + 1}. Represents canonical engineering knowledge in topic '${topic.label}'. Verified deterministic layout streaming and WebGL2 rendering.`,
        createdAt: "2026-10-27T00:00:00.000Z",
        scope: "PROJECT",
        roomId: "room:synthetic-benchmark",
        provenance: "synthetic benchmark generator",
        contentHash: "0".repeat(64),
        lifecycleStatus: "ACTIVE"
      },
      relatedNodes: [parentSource, topic],
      relatedEdges: [],
      issues: []
    };
  }

  // 5. Additional semantic / relation edges to reach exact targetEdgeCount
  // We add intra-cluster semantic links and cross-cluster bridges with power-law degree
  let edgeIdSeq = edges.length;
  const remainingEdgesNeeded = Math.max(0, targetEdgeCount - edges.length);

  for (let e = 0; e < remainingEdgesNeeded; e++) {
    // Pick source memory
    const srcIndex = Math.floor(rand() * memoryCount);
    const srcId = memoryNodeIds[srcIndex]!;

    // Power-law jump: 80% close neighbors (same cluster), 20% distant
    const isLocal = rand() < 0.8;
    const offset = isLocal ? Math.floor((rand() - 0.5) * 120) : Math.floor(rand() * memoryCount);
    let targetIndex = (srcIndex + offset + memoryCount) % memoryCount;
    if (targetIndex === srcIndex) targetIndex = (srcIndex + 1) % memoryCount;

    const tgtId = memoryNodeIds[targetIndex]!;
    edges.push({
      id: `edge:rel-${edgeIdSeq++}`,
      source: srcId,
      target: tgtId,
      type: isLocal ? "SEMANTICALLY_RELATED" : "DERIVED_FROM",
      origin: "DERIVED_TFIDF",
      confidence: Math.round((0.5 + rand() * 0.49) * 100) / 100
    });
  }

  const payload: MemoryGraphOverviewPayload = {
    version: 2,
    generatedAt: new Date().toISOString(),
    sourceHash: "0".repeat(64),
    isStale: false,
    months: [],
    totalMatchingNodes: nodes.length,
    totalMatchingEdges: edges.length,
    truncated: false,
    summary: {
      sourceCount: sourceNodes.length + 1,
      recordCount: memoryCount,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      issueCount: 0
    },
    nodes,
    edges,
    filters: {
      q: null,
      nodeType: null,
      scope: null,
      roomId: null,
      sourcePath: null,
      lifecycleStatus: null,
      relationMode: "RELATIONS",
      month: null
    }
  };

  return { graph: payload, nodeDetails };
}
