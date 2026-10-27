import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

export function syntheticMemoryNode(i: number): MemoryGraphNode {
  return {
    id: `synthetic-memory-${i}`,
    label:
      i === 0
        ? "gemini.md"
        : i % 50 === 0
          ? `source-${i}.md`
          : `Synthetic memory ${i}`,
    type: i % 50 === 0 ? "SOURCE" : "MEMORY",
    sourcePath: "/demo/synthetic.md",
    recordId: null,
  };
}

function* buildSyntheticMemoryGraph(count: number) {
  const size = Math.max(1, Math.min(50000, Math.floor(count)));
  const nodes: MemoryGraphNode[] = [],
    edges: MemoryGraphEdge[] = [];
  for (let i = 0; i < size; i++) {
    nodes.push(syntheticMemoryNode(i));
    if (i % 2000 === 1999) yield;
  }
  for (let i = 0; i < size; i++) {
    for (let k = 1; k <= 3; k++) {
      const target = (i + k * (k === 1 ? 1 : 127)) % size;
      if (target !== i)
        edges.push({
          id: `synthetic-edge-${i}-${k}`,
          type: "SEMANTICALLY_RELATED",
          origin: "DETERMINISTIC_TFIDF",
          confidence: 0.8,
          source: nodes[i]!.id,
          target: nodes[target]!.id,
        });
    }
    if (i % 2000 === 1999) yield;
  }
  return { nodes, edges };
}

/** Deterministic fixture for pure tests and the isolated renderer harness. */
export function syntheticMemoryGraph(count: number) {
  const builder = buildSyntheticMemoryGraph(count);
  let step = builder.next();
  while (!step.done) step = builder.next();
  return step.value;
}

const cached = new Map<
  number,
  Promise<ReturnType<typeof syntheticMemoryGraph>>
>();
/** Demo construction yields between batches, just as the live view yields between uploads. */
export function loadSyntheticMemoryGraph(count: number) {
  if (!cached.has(count))
    cached.set(
      count,
      (async () => {
        const builder = buildSyntheticMemoryGraph(count);
        let step = builder.next();
        while (!step.done) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          step = builder.next();
        }
        return step.value;
      })(),
    );
  return cached.get(count)!;
}
