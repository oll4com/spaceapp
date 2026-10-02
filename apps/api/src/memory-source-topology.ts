import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryGraphSnapshot, MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** Read only existing Markdown references inside the configured canonical memory directory. */
export function createMemorySourceTopology(indexPath: string) {
  type Topology = { until: number; nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] };
  let cached: Topology | null = null;
  let pending: Promise<Topology> | null = null;
  async function load() {
    const directory = await realpath(dirname(indexPath));
    const queue = [join(directory, "gemini.md"), indexPath];
    const visited = new Set<string>();
    const nodes = new Map<string, MemoryGraphNode>();
    const edges = new Map<string, MemoryGraphEdge>();
    let bytes = 0;
    while (queue.length && visited.size < 80 && bytes < 8_000_000) {
      const path = queue.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      let content: string;
      try {
        if (dirname(await realpath(path)) !== directory) continue;
        content = await readFile(path, "utf8");
      } catch { continue; }
      bytes += content.length;
      const id = `source:${hash(path)}`;
      nodes.set(id, { id, type: "SOURCE", label: basename(path), sourcePath: path, recordId: null });
      // Archive entry bodies are not routing documents. Their containment is in the snapshot.
      if (/^gemini_history_\d{4}-\d{2}\.md$/.test(basename(path))) continue;
      const references = new Set(content.match(/(?:\/[a-zA-Z0-9_.-]+)*\/?[a-zA-Z][a-zA-Z0-9_-]*\.md\b/g) ?? []);
      for (const reference of references) {
        const targetPath = resolve(directory, reference);
        const name = basename(targetPath);
        if (targetPath === path || dirname(targetPath) !== directory) continue;
        try { if (dirname(await realpath(targetPath)) !== directory) continue; } catch { continue; }
        const target = `source:${hash(targetPath)}`;
        const edgeId = `edge:${hash(`reference:${path}:${targetPath}`)}`;
        nodes.set(target, { id: target, type: "SOURCE", label: name, sourcePath: targetPath, recordId: null });
        edges.set(edgeId, { id: edgeId, type: "DERIVED_FROM", source: id, target, evidence: `${basename(path)} references ${name}.` });
        if (!visited.has(targetPath) && queue.length < 160) queue.push(targetPath);
      }
    }
    return { until: Date.now() + 60_000, nodes: [...nodes.values()], edges: [...edges.values()] };
  }
  return async (snapshot: MemoryGraphSnapshot): Promise<MemoryGraphSnapshot> => {
    if (!cached || cached.until < Date.now()) {
      pending ??= load().finally(() => { pending = null; });
      cached = await pending;
    }
    const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
    const byPath = new Map(snapshot.nodes.filter(node => node.type === "SOURCE").map(node => [node.sourcePath, node.id]));
    const remap = new Map<string, string>();
    for (const node of cached.nodes) {
      const existing = byPath.get(node.sourcePath);
      remap.set(node.id, existing ?? node.id);
      if (!existing) nodes.set(node.id, node);
    }
    const edges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
    for (const edge of cached.edges) edges.set(edge.id, { ...edge, source: remap.get(edge.source)!, target: remap.get(edge.target)! });
    // Direct provenance links are supported by each canonical record's exact source path.
    const sources = new Map([...nodes.values()].filter(node => node.type === "SOURCE").map(node => [node.sourcePath, node.id]));
    for (const record of snapshot.records) {
      const source = sources.get(record.sourcePath);
      if (!source || !nodes.has(record.id)) continue;
      const id = `edge:${hash(`source-record:${source}:${record.id}`)}`;
      edges.set(id, { id, type: "CONTAINS", source, target: record.id, evidence: `Canonical record belongs to ${basename(record.sourcePath)}.` });
    }
    const revisionHash = createHash("sha256").update(JSON.stringify([snapshot.revisionHash ?? snapshot.sourceHash, [...edges.keys()]])).digest("hex");
    return { ...snapshot, nodes: [...nodes.values()], edges: [...edges.values()], revisionHash };
  };
}
