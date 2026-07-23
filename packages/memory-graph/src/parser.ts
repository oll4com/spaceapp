import { createHash } from "node:crypto";
import { basename } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Content, Heading, RootContent } from "mdast";
import type {
  MemoryGraphEdge,
  MemoryGraphCacheRecord,
  MemoryGraphIssue,
  MemoryGraphNode,
  MemoryGraphRecord,
  MemoryGraphSnapshot,
  MemoryGraphSource
} from "./types.js";
import { positionMemoryGraphNodes } from "./layout.js";
import { analyzeMemoryGraphSemantics } from "./semantics.js";

const markerPattern = /<!--\s*space-memory:id=([a-zA-Z0-9:_-]{3,200})\s*-->/;
const markerCandidatePattern = /<!--\s*space-memory:id=[\s\S]*?-->/;
const datedHeadingPattern = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}):(\d{2})\s+(EEST|EET|UTC))?(?:\s+follow-up)?\s*[-–—]\s*(.+)$/i;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotRevisionHash(input: {
  sourceHash: string;
  records: MemoryGraphRecord[];
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  issues: MemoryGraphIssue[];
}): string {
  return sha256(JSON.stringify({
    version: 2,
    layoutVersion: 2,
    taxonomyVersion: 2,
    sourceHash: input.sourceHash,
    records: input.records.map((record) => ({
      id: record.id,
      contentHash: record.contentHash,
      lifecycleStatus: record.lifecycleStatus,
      tags: record.tags ?? [],
      topics: record.topics ?? []
    })),
    nodes: input.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      clusterId: node.clusterId ?? null,
      position: node.position
    })),
    edges: input.edges.map((edge) => ({
      id: edge.id,
      type: edge.type,
      source: edge.source,
      target: edge.target,
      origin: edge.origin ?? null,
      confidence: edge.confidence ?? null,
      evidence: edge.evidence ?? null
    })),
    issues: input.issues.map((issue) => ({
      id: issue.id,
      type: issue.type,
      severity: issue.severity,
      confidence: issue.confidence,
      recordId: issue.recordId
    }))
  }));
}

export function calculateMemoryGraphSourceHash(sources: MemoryGraphSource[]): string {
  return sha256(
    sources
      .filter((source) => !source.path.split(/[\\/]/).includes("_archive"))
      .map((source) => `${source.path}\n${sha256(source.content)}`)
      .sort()
      .join("\n")
  );
}

function textFromNode(node: RootContent | Content): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return node.children.map((child) => textFromNode(child)).join("");
  return "";
}

function nodeOffset(node: RootContent, boundary: "start" | "end", fallback: number): number {
  return node.position?.[boundary].offset ?? fallback;
}

function timestampFromHeading(value: string): { createdAt: string | null; title: string } {
  const match = datedHeadingPattern.exec(value.trim());
  if (!match) return { createdAt: null, title: value.trim() };
  const [, date, hour = "00", minute = "00", zone = "EEST", title = value] = match;
  const normalizedZone = zone.toUpperCase();
  const offset = normalizedZone === "UTC" ? "+00:00" : normalizedZone === "EET" ? "+02:00" : "+03:00";
  const parsed = new Date(`${date}T${hour}:${minute}:00${offset}`);
  return { createdAt: Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString(), title: title.trim() };
}

function normalizeTitle(value: string): string {
  return value.replace(/^Space canonical memory:\s*/i, "").trim();
}

function parseMetadata(body: string): Pick<MemoryGraphRecord, "scope" | "roomId" | "provenance" | "lifecycleStatus"> {
  const scope = /original_scope=(ROOM|PROJECT|SYSTEM)\b/.exec(body)?.[1] as MemoryGraphRecord["scope"] | undefined;
  const roomId = /(?:^|[,;]\s*)room=([^,;\s]+)\b/m.exec(body)?.[1] ?? null;
  const provenance = /(?:^|[;]\s*)provenance=([^;\n]+?)(?:;\s*trace=|\.|$)/m.exec(body)?.[1]?.trim() ?? "canonical-history";
  const lifecycleStatus = /(?:lifecycle_status|status)=ARCHIVED\b/.test(body) ? "ARCHIVED" : "ACTIVE";
  return { scope: scope ?? "SYSTEM", roomId: scope === "ROOM" ? roomId : null, provenance, lifecycleStatus };
}

function addNode(nodes: Map<string, MemoryGraphNode>, node: MemoryGraphNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function makeEdge(
  type: MemoryGraphEdge["type"],
  source: string,
  target: string,
  metadata: Pick<MemoryGraphEdge, "origin" | "confidence" | "evidence"> = {}
): MemoryGraphEdge {
  return { id: `edge:${sha256(`${type}\n${source}\n${target}`).slice(0, 24)}`, type, source, target, ...metadata };
}

function explicitRelation(body: string, key: "supersedes" | "conflicts_with"): string | null {
  return new RegExp(`\\b${key}=([A-Za-z0-9:_-]{3,200})\\b`).exec(body)?.[1] ?? null;
}

function cacheMatchesRecord(cache: MemoryGraphCacheRecord, record: MemoryGraphRecord): boolean {
  if (cache.title.trim() !== record.title.trim() || cache.scope !== record.scope || cache.roomId !== record.roomId) return false;
  const expectedBodyLine = `- ${cache.body.trim()}`;
  return record.body.split(/\r?\n/).some((line) => line.trim() === expectedBodyLine);
}

function isMemoryBlockHeading(node: RootContent): node is Heading {
  if (node.type !== "heading") return false;
  if (node.depth === 2) return true;
  return node.depth === 3 && timestampFromHeading(textFromNode(node)).createdAt !== null;
}

function parseMonthlySource(source: MemoryGraphSource): { records: MemoryGraphRecord[]; sections: Array<{ id: string; label: string }>; issues: MemoryGraphIssue[] } {
  const tree = fromMarkdown(source.content);
  const records: MemoryGraphRecord[] = [];
  const sections: Array<{ id: string; label: string }> = [];
  const issues: MemoryGraphIssue[] = [];

  for (let index = 0; index < tree.children.length; index += 1) {
    const node = tree.children[index];
    if (!node || !isMemoryBlockHeading(node)) continue;
    const heading = node;
    const headingText = textFromNode(heading).trim();
    const nextHeadingIndex = tree.children.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && isMemoryBlockHeading(candidate)
    );
    const nextHeading = nextHeadingIndex === -1 ? null : tree.children[nextHeadingIndex];
    const nodeBeforeNextHeading = nextHeadingIndex > 0 ? tree.children[nextHeadingIndex - 1] : undefined;
    const nextMarker = nodeBeforeNextHeading?.type === "html" && markerCandidatePattern.test(nodeBeforeNextHeading.value)
      ? nodeBeforeNextHeading
      : null;
    const start = nodeOffset(node, "start", 0);
    const end = nextMarker
      ? nodeOffset(nextMarker, "start", source.content.length)
      : nextHeading
        ? nodeOffset(nextHeading, "start", source.content.length)
        : source.content.length;
    const body = source.content.slice(start, end).trim();
    const previous = tree.children[index - 1];
    const markerText = previous?.type === "html" ? previous.value : "";
    const explicitId = markerPattern.exec(markerText)?.[1] ?? markerPattern.exec(body)?.[1] ?? null;
    const invalidMarker = markerCandidatePattern.test(markerText || body) && explicitId === null;
    const { createdAt, title } = timestampFromHeading(headingText);
    const normalizedTitle = normalizeTitle(title);
    const fallbackId = `memory:${sha256(`${source.path}\n${createdAt ?? headingText}\n${normalizedTitle}`).slice(0, 24)}`;
    const recordId = explicitId ?? fallbackId;
    const sectionId = `section:${sha256(`${source.path}\n${headingText}`).slice(0, 24)}`;
    const metadata = parseMetadata(body);

    sections.push({ id: sectionId, label: normalizedTitle });
    records.push({
      id: recordId,
      sourcePath: source.path,
      sectionId,
      title: normalizedTitle,
      body,
      createdAt: createdAt ?? new Date(0).toISOString(),
      ...metadata,
      contentHash: sha256(body),
      sourceStart: start,
      sourceEnd: end,
      markerId: explicitId
    });
    if (invalidMarker) {
      issues.push({
        id: `issue:${sha256(`INVALID_MARKER\n${source.path}\n${recordId}`).slice(0, 24)}`,
        type: "INVALID_MARKER",
        severity: "WARN",
        status: "OPEN",
        confidence: 1,
        recordId,
        sourcePath: source.path,
        evidence: `The marker for ${recordId} is malformed and was ignored.`
      });
    }
    if (!createdAt) {
      issues.push({
        id: `issue:${sha256(`MISSING_TIMESTAMP\n${source.path}\n${headingText}`).slice(0, 24)}`,
        type: "MISSING_TIMESTAMP",
        severity: "WARN",
        status: "OPEN",
        confidence: 1,
        recordId,
        sourcePath: source.path,
        evidence: headingText.slice(0, 500)
      });
    }
  }

  return { records, sections, issues };
}

function indexSections(source: MemoryGraphSource): Array<{ id: string; label: string }> {
  const tree = fromMarkdown(source.content);
  return tree.children
    .filter((node): node is Heading => node.type === "heading" && node.depth === 2)
    .map((heading) => {
      const label = textFromNode(heading).trim();
      return { id: `section:${sha256(`${source.path}\n${label}`).slice(0, 24)}`, label };
    });
}

export function buildMemoryGraphSnapshot(input: {
  sources: MemoryGraphSource[];
  generatedAt: string;
  cacheRecords?: MemoryGraphCacheRecord[];
  previousSnapshot?: MemoryGraphSnapshot | null;
}): MemoryGraphSnapshot {
  const includedSources = input.sources.filter((source) => !source.path.split(/[\\/]/).includes("_archive"));
  const records: MemoryGraphRecord[] = [];
  const issues: MemoryGraphIssue[] = [];
  const nodes = new Map<string, MemoryGraphNode>();
  const edges: MemoryGraphEdge[] = [];

  for (const source of includedSources) {
    const sourceId = `source:${sha256(source.path).slice(0, 24)}`;
    addNode(nodes, { id: sourceId, type: "SOURCE", label: basename(source.path), sourcePath: source.path, recordId: null });
    const parsed = source.kind === "MONTHLY" ? parseMonthlySource(source) : { records: [], sections: indexSections(source), issues: [] };
    records.push(...parsed.records);
    issues.push(...parsed.issues);

    for (const section of parsed.sections) {
      addNode(nodes, { id: section.id, type: "SECTION", label: section.label, sourcePath: source.path, recordId: null });
      edges.push(makeEdge("CONTAINS", sourceId, section.id));
    }
    for (const record of parsed.records) {
      addNode(nodes, { id: record.id, type: "MEMORY", label: record.title, sourcePath: source.path, recordId: record.id });
      edges.push(makeEdge("CONTAINS", record.sectionId, record.id));
      const provenanceId = `provenance:${sha256(record.provenance).slice(0, 24)}`;
      addNode(nodes, { id: provenanceId, type: "PROVENANCE", label: record.provenance, sourcePath: null, recordId: null });
      edges.push(makeEdge("DERIVED_FROM", record.id, provenanceId));
      if (record.roomId) {
        const roomNodeId = `room-node:${sha256(record.roomId).slice(0, 24)}`;
        addNode(nodes, { id: roomNodeId, type: "ROOM", label: record.roomId, sourcePath: null, recordId: null });
        edges.push(makeEdge("BELONGS_TO_ROOM", record.id, roomNodeId));
      }
    }
  }

  const semanticAnalysis = analyzeMemoryGraphSemantics(records);
  records.splice(0, records.length, ...semanticAnalysis.records);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    for (const topic of record.topics ?? []) {
      const topicId = `topic:${sha256(topic.label.normalize("NFKC").toLowerCase()).slice(0, 24)}`;
      addNode(nodes, { id: topicId, type: "TOPIC", label: topic.label, sourcePath: null, recordId: null });
      edges.push(makeEdge("TAGGED_WITH", record.id, topicId, {
        origin: topic.origin,
        confidence: topic.confidence,
        evidence: topic.origin === "EXPLICIT_TAG"
          ? `Explicit canonical tag: ${topic.label}.`
          : `Deterministic TF-IDF topic: ${topic.label}; confidence=${topic.confidence.toFixed(3)}.`
      }));
    }
    const supersededId = explicitRelation(record.body, "supersedes");
    if (supersededId && supersededId !== record.id && recordsById.has(supersededId)) {
      edges.push(makeEdge("SUPERSEDES", record.id, supersededId));
      issues.push({
        id: `issue:${sha256(`STALE\n${supersededId}\n${record.id}`).slice(0, 24)}`,
        type: "STALE",
        severity: "WARN",
        status: "OPEN",
        confidence: 1,
        recordId: supersededId,
        sourcePath: recordsById.get(supersededId)!.sourcePath,
        evidence: `${supersededId} is explicitly superseded by ${record.id}.`
      });
    }
    const conflictedId = explicitRelation(record.body, "conflicts_with");
    if (conflictedId && conflictedId !== record.id && recordsById.has(conflictedId)) {
      edges.push(makeEdge("CONFLICTS_WITH", record.id, conflictedId));
      issues.push({
        id: `issue:${sha256(`CONFLICT\n${record.id}\n${conflictedId}`).slice(0, 24)}`,
        type: "CONFLICT",
        severity: "ERROR",
        status: "OPEN",
        confidence: 1,
        recordId: record.id,
        sourcePath: record.sourcePath,
        evidence: `${record.id} explicitly conflicts with ${conflictedId}.`
      });
    }
  }
  for (const relation of semanticAnalysis.relations) {
    edges.push(makeEdge("SEMANTICALLY_RELATED", relation.source, relation.target, {
      origin: "DETERMINISTIC_TFIDF",
      confidence: relation.confidence,
      evidence: relation.evidence
    }));
  }

  for (const cache of input.cacheRecords ?? []) {
    const cacheNodeId = `cache-node:${sha256(cache.id).slice(0, 24)}`;
    const candidates = cache.canonicalMemoryId
      ? records.filter((record) => record.id === cache.canonicalMemoryId)
      : records.filter((record) => cacheMatchesRecord(cache, record));
    const matched = candidates.length === 1 ? candidates[0]! : null;
    addNode(nodes, {
      id: cacheNodeId,
      type: "CACHE_RECORD",
      label: cache.title,
      sourcePath: null,
      recordId: matched?.id ?? null,
      cacheRecordId: cache.id,
      clusterId: "cluster:cache_record"
    });
    if (matched) {
      edges.push(makeEdge("CACHED_AS", matched.id, cacheNodeId));
    } else {
      issues.push({
        id: `issue:${sha256(`CACHE_MISMATCH\n${cache.id}\n${candidates.map((record) => record.id).sort().join("\n")}`).slice(0, 24)}`,
        type: "CACHE_MISMATCH",
        severity: "WARN",
        status: "OPEN",
        confidence: candidates.length === 0 ? 1 : 0.5,
        recordId: null,
        sourcePath: "memory_records",
        evidence: `${cache.id} has ${candidates.length} exact canonical matches and remains unlinked.`
      });
    }
  }

  const recordsByHash = new Map<string, MemoryGraphRecord[]>();
  for (const record of records) {
    const matching = recordsByHash.get(record.contentHash) ?? [];
    matching.push(record);
    recordsByHash.set(record.contentHash, matching);
  }
  for (const matching of recordsByHash.values()) {
    if (matching.length < 2) continue;
    const ordered = [...matching].sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) ||
      (left.sourceStart ?? 0) - (right.sourceStart ?? 0) ||
      left.id.localeCompare(right.id)
    );
    const canonical = ordered[0]!;
    for (const duplicate of ordered.slice(1)) {
      if (duplicate.id === canonical.id) continue;
      edges.push(makeEdge("DUPLICATES", duplicate.id, canonical.id));
      issues.push({
        id: `issue:${sha256(`EXACT_DUPLICATE\n${duplicate.id}\n${canonical.id}`).slice(0, 24)}`,
        type: "EXACT_DUPLICATE",
        severity: "WARN",
        status: "OPEN",
        confidence: 1,
        recordId: duplicate.id,
        sourcePath: duplicate.sourcePath,
        evidence: `${duplicate.id} exactly duplicates ${canonical.id}.`
      });
    }
  }

  const sourceHash = calculateMemoryGraphSourceHash(includedSources);
  const positionedNodes = positionMemoryGraphNodes([...nodes.values()], edges, {
    previousNodes: input.previousSnapshot?.nodes,
    previousEdges: input.previousSnapshot?.edges
  });
  const revisionHash = snapshotRevisionHash({ sourceHash, records, nodes: positionedNodes, edges, issues });
  return {
    version: 2,
    layoutVersion: 2,
    taxonomyVersion: 2,
    revisionHash,
    generatedAt: input.generatedAt,
    sourceHash,
    records,
    nodes: positionedNodes,
    edges,
    issues,
    summary: {
      sourceCount: includedSources.length,
      recordCount: records.length,
      nodeCount: positionedNodes.length,
      edgeCount: edges.length,
      issueCount: issues.length
    }
  };
}
