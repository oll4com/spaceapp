export type MemoryGraphSourceKind = "INDEX" | "MONTHLY";
export type MemoryLifecycleStatus = "ACTIVE" | "ARCHIVED";
export type MemoryGraphNodeType = "SOURCE" | "SECTION" | "MEMORY" | "ROOM" | "PROVENANCE" | "TOPIC" | "CACHE_RECORD";
export type MemoryGraphEdgeType =
  | "CONTAINS"
  | "BELONGS_TO_ROOM"
  | "DERIVED_FROM"
  | "TAGGED_WITH"
  | "SEMANTICALLY_RELATED"
  | "CACHED_AS"
  | "DUPLICATES"
  | "SUPERSEDES"
  | "CONFLICTS_WITH";

export interface MemoryGraphSource {
  path: string;
  kind: MemoryGraphSourceKind;
  content: string;
}

export interface MemoryGraphCacheRecord {
  id: string;
  title: string;
  body: string;
  scope: "ROOM" | "PROJECT" | "SYSTEM";
  roomId: string | null;
  provenance: string;
  canonicalMemoryId?: string | null;
}

export interface MemoryGraphRecord {
  id: string;
  sourcePath: string;
  sectionId: string;
  title: string;
  body: string;
  createdAt: string;
  scope: "ROOM" | "PROJECT" | "SYSTEM";
  roomId: string | null;
  provenance: string;
  contentHash: string;
  lifecycleStatus: MemoryLifecycleStatus;
  tags?: string[];
  topics?: MemoryGraphTopicAssignment[];
  sourceStart?: number;
  sourceEnd?: number;
  markerId?: string | null;
}

export type MemoryGraphTopicOrigin = "EXPLICIT_TAG" | "DERIVED_TFIDF";
export type MemoryGraphEdgeOrigin = MemoryGraphTopicOrigin | "DETERMINISTIC_TFIDF" | "EMBEDDING";

export interface MemoryGraphTopicAssignment {
  label: string;
  origin: MemoryGraphTopicOrigin;
  confidence: number;
}

export interface MemoryGraphPosition {
  x: number;
  y: number;
}

export interface MemoryGraphNodePosition {
  clustered: MemoryGraphPosition;
  relations: MemoryGraphPosition;
}

export interface MemoryGraphNode {
  id: string;
  type: MemoryGraphNodeType;
  label: string;
  sourcePath: string | null;
  recordId: string | null;
  clusterId?: string | null;
  cacheRecordId?: string | null;
  position?: MemoryGraphNodePosition;
}

export interface MemoryGraphEdge {
  id: string;
  type: MemoryGraphEdgeType;
  source: string;
  target: string;
  origin?: MemoryGraphEdgeOrigin;
  confidence?: number;
  evidence?: string;
}

export interface MemoryGraphIssue {
  id: string;
  type: "MISSING_TIMESTAMP" | "INVALID_MARKER" | "EXACT_DUPLICATE" | "NEAR_DUPLICATE" | "CONFLICT" | "STALE" | "CACHE_MISMATCH";
  severity: "INFO" | "WARN" | "ERROR";
  status: "OPEN" | "IGNORED" | "RESOLVED";
  confidence: number;
  recordId: string | null;
  sourcePath: string;
  evidence: string;
}

export interface MemoryGraphSnapshot {
  version: 1 | 2;
  layoutVersion?: 1 | 2;
  taxonomyVersion?: 1 | 2;
  revisionHash?: string;
  generatedAt: string;
  sourceHash: string;
  records: MemoryGraphRecord[];
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  issues: MemoryGraphIssue[];
  summary: {
    sourceCount: number;
    recordCount: number;
    nodeCount: number;
    edgeCount: number;
    issueCount: number;
  };
}
