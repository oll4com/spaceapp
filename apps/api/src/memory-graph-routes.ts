import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createMemoryChangeSetInputSchema,
  createMemoryNodeChangeSetInputSchema,
  createMemoryConsolidationInputSchema,
  createMemoryRollbackInputSchema,
  buildMemoryConsolidationWorkflowId,
  idSchema,
  listMemoryGraphOverviewQuerySchema,
  listMemoryGraphQuerySchema,
  listMemoryChangeSetsQuerySchema,
  listMemoryIssuesQuerySchema,
  memoryGraphNodeDetailSchema,
  memoryGraphOverviewPayloadSchema,
  memoryGraphPayloadSchema,
  memoryConsolidationCommandResponseSchema,
  memoryConsolidationDetailSchema,
  memoryChangeSetCommandInputSchema,
  memoryChangeSetSchema,
  memoryChangeSetSummarySchema,
  patchMemoryIssueInputSchema,
  type ListMemoryGraphQuery,
  type ListMemoryGraphOverviewQuery,
  type ListMemoryIssuesQuery,
  type MemoryGraphEdge,
  type MemoryGraphIssue,
  type MemoryGraphNode,
  type MemoryGraphRecord,
  type MemoryGraphSnapshot,
  type MemoryGraphSummary,
  type MemoryIssueState,
  type MemoryChangeSet,
  type MemoryChangeSetSummary
} from "@space/contracts";
import {
  SpaceConflictError,
  SpaceFeatureDisabledError,
  SpaceNotFoundError,
  redactMemoryText,
  type SpaceStore
} from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import type { MemoryGraphApiService } from "./memory-graph-service.js";
import {
  buildMemoryCommandResourceId,
  hashMemoryCommandRequest,
  hashMemoryIdempotencyKey
} from "./memory-command-idempotency.js";
import {
  buildMemoryMutationWorkflowId,
  type MemoryMutationCoordinator
} from "./memory-mutation-coordinator.js";
import type { MemoryConsolidationCoordinator } from "./memory-consolidation-coordinator.js";

function requireMemoryGraph(config: SpaceApiConfig): void {
  if (!config.memoryGraphEnabled) {
    throw new SpaceFeatureDisabledError(
      "MEMORY_GRAPH_DISABLED",
      "The memory graph workspace is disabled until its guarded rollout is enabled."
    );
  }
}

function requireMemoryMutations(config: SpaceApiConfig): void {
  requireMemoryGraph(config);
  if (!config.memoryMutationsEnabled) {
    throw new SpaceFeatureDisabledError(
      "MEMORY_MUTATIONS_DISABLED",
      "Canonical memory mutations are disabled until their guarded rollout is enabled."
    );
  }
}

function requireMemoryMaintenance(config: SpaceApiConfig): void {
  requireMemoryGraph(config);
  if (!config.memoryMaintenanceEnabled) {
    throw new SpaceFeatureDisabledError(
      "MEMORY_MAINTENANCE_DISABLED",
      "Memory consolidation is disabled until its guarded maintenance rollout is enabled."
    );
  }
}

function setSnapshotEtag(request: FastifyRequest, reply: FastifyReply, revisionHash: string): boolean {
  const etag = `"${revisionHash}"`;
  reply.header("ETag", etag);
  const submitted = request.headers["if-none-match"];
  const values = Array.isArray(submitted) ? submitted : submitted?.split(",");
  return values?.some((value) => value.trim() === etag) ?? false;
}

function pagination(page: number, pageSize: number, totalItems: number) {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface MemorySourceEdit {
  start: number;
  end: number;
  replacement: string;
}

function recordBodyEdit(content: string, record: MemoryGraphRecord, replacement: string): MemorySourceEdit {
  if (record.sourceStart === undefined || record.sourceEnd === undefined) {
    throw new SpaceConflictError(`Memory record ${record.id} has no exact canonical source offsets.`);
  }
  const span = content.slice(record.sourceStart, record.sourceEnd);
  if (span.trim() !== record.body) {
    throw new SpaceConflictError(`Memory record ${record.id} no longer matches its canonical source span.`);
  }
  const bodyStart = span.indexOf(record.body);
  if (bodyStart < 0) {
    throw new SpaceConflictError(`Memory record ${record.id} could not be located in its canonical source span.`);
  }
  return {
    start: record.sourceStart + bodyStart,
    end: record.sourceStart + bodyStart + record.body.length,
    replacement
  };
}

function applySourceEdits(content: string, edits: MemorySourceEdit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.start < ordered[index]!.end) {
      throw new SpaceConflictError("Memory node proposal contains overlapping canonical source edits.");
    }
  }
  return ordered.reduce(
    (current, edit) => `${current.slice(0, edit.start)}${edit.replacement}${current.slice(edit.end)}`,
    content
  );
}

function appendMemoryMetadata(body: string, lines: string[]): string {
  const separator = body.endsWith("\n") ? "" : "\n";
  return `${body}${separator}${lines.map((line) => `- ${line}`).join("\n")}`;
}

const reviewMemoryChangeSetSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("APPROVED") }).strict(),
  z.object({ status: z.literal("REJECTED"), statusReason: z.string().trim().min(1).max(2000) }).strict()
]);

interface MemoryGraphAuditInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export type MemoryGraphAuditRecorder = (
  request: FastifyRequest,
  input: MemoryGraphAuditInput
) => Promise<void> | void;

function sortNodes(nodes: MemoryGraphNode[], query: ListMemoryGraphQuery): MemoryGraphNode[] {
  const direction = query.sortOrder === "asc" ? 1 : -1;
  return nodes.sort((left, right) => {
    const leftValue = query.sortBy === "type" ? left.type : left.label;
    const rightValue = query.sortBy === "type" ? right.type : right.label;
    return direction * leftValue.localeCompare(rightValue);
  });
}

type MemoryGraphFilterQuery = Pick<
  ListMemoryGraphOverviewQuery,
  "q" | "nodeType" | "scope" | "roomId" | "sourcePath" | "lifecycleStatus" | "month"
>;

function filterNodes(snapshot: Awaited<ReturnType<MemoryGraphApiService["getSnapshot"]>>["snapshot"], query: MemoryGraphFilterQuery) {
  const records = new Map(snapshot.records.map((record) => [record.id, record]));
  const normalizedQuery = query.q?.toLocaleLowerCase() ?? null;
  return snapshot.nodes.filter((node) => {
    const record = node.recordId ? records.get(node.recordId) : undefined;
    if (query.nodeType && node.type !== query.nodeType) return false;
    if (query.scope && record?.scope !== query.scope) return false;
    if (query.roomId && record?.roomId !== query.roomId && !(node.type === "ROOM" && node.label === query.roomId)) return false;
    if (query.sourcePath && node.sourcePath !== query.sourcePath) return false;
    if (query.month && query.month !== "all") {
      const expected = `gemini_history_${query.month}.md`;
      if (!node.sourcePath || node.sourcePath.split(/[\\/]/).at(-1) !== expected) return false;
    }
    if (query.lifecycleStatus && record?.lifecycleStatus !== query.lifecycleStatus) return false;
    if (!normalizedQuery) return true;
    return [node.id, node.label, node.sourcePath, record?.body, record?.provenance]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
}

function monthScopedSummary(
  snapshot: Awaited<ReturnType<MemoryGraphApiService["getSnapshot"]>>["snapshot"],
  month: string
): MemoryGraphSummary {
  const expected = `gemini_history_${month}.md`;
  const monthSources = new Set(
    snapshot.nodes
      .filter((node) => node.sourcePath?.split(/[\\/]/).at(-1) === expected)
      .map((node) => node.sourcePath!)
  );
  const inMonth = (sourcePath: string | null) => Boolean(sourcePath && monthSources.has(sourcePath));
  const nodes = snapshot.nodes.filter((node) => inMonth(node.sourcePath));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    sourceCount: monthSources.size,
    recordCount: snapshot.records.filter((record) => inMonth(record.sourcePath)).length,
    nodeCount: nodes.length,
    edgeCount: snapshot.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).length,
    issueCount: snapshot.issues.filter((issue) => inMonth(issue.sourcePath)).length
  };
}

function sortIssues(issues: MemoryGraphIssue[], query: ListMemoryIssuesQuery): MemoryGraphIssue[] {
  const direction = query.sortOrder === "asc" ? 1 : -1;
  const severityRank = { INFO: 1, WARN: 2, ERROR: 3 } as const;
  return issues.sort((left, right) => {
    if (query.sortBy === "severity") return direction * (severityRank[left.severity] - severityRank[right.severity]);
    return direction * left[query.sortBy].localeCompare(right[query.sortBy]);
  });
}

function redactedNode(node: MemoryGraphNode): MemoryGraphNode {
  return { ...node, label: redactMemoryText(node.label) };
}

function redactedRecord(record: MemoryGraphRecord | null): MemoryGraphRecord | null {
  if (!record) return null;
  return {
    ...record,
    title: redactMemoryText(record.title),
    body: redactMemoryText(record.body),
    provenance: redactMemoryText(record.provenance),
    tags: record.tags?.filter((tag) => redactMemoryText(tag) === tag),
    topics: record.topics?.filter((topic) => redactMemoryText(topic.label) === topic.label)
  };
}

function redactedEdge(edge: MemoryGraphEdge): MemoryGraphEdge {
  return { ...edge, evidence: edge.evidence ? redactMemoryText(edge.evidence) : edge.evidence };
}

function redactedIssue(issue: MemoryGraphIssue): MemoryGraphIssue {
  return {
    ...issue,
    evidence: redactMemoryText(issue.evidence),
    statusReason: issue.statusReason ? redactMemoryText(issue.statusReason) : issue.statusReason
  };
}

function summarizedChangeSet(changeSet: MemoryChangeSet): MemoryChangeSetSummary {
  return memoryChangeSetSummarySchema.parse(changeSet);
}

function redactedChangeSet(changeSet: MemoryChangeSet): MemoryChangeSet {
  return memoryChangeSetSchema.parse({
    ...changeSet,
    beforeSnapshot: redactMemoryText(changeSet.beforeSnapshot),
    afterSnapshot: redactMemoryText(changeSet.afterSnapshot),
    reason: redactMemoryText(changeSet.reason),
    statusReason: changeSet.statusReason ? redactMemoryText(changeSet.statusReason) : null
  });
}

async function applyIssueStateOverlays(
  store: SpaceStore,
  issues: MemoryGraphIssue[]
): Promise<{ issues: MemoryGraphIssue[]; appliedStates: MemoryIssueState[] }> {
  const states = new Map<string, MemoryIssueState>();
  for (let offset = 0; offset < issues.length; offset += 500) {
    const issueIds = issues.slice(offset, offset + 500).map((issue) => issue.id);
    const batch = await store.listMemoryIssueStates({ issueIds, page: 1, pageSize: 500, sortOrder: "desc" });
    for (const state of batch) states.set(state.issueId, state);
  }
  const appliedStates: MemoryIssueState[] = [];
  const overlayedIssues = issues.map((issue) => {
    const state = states.get(issue.id);
    const isCurrent = state?.issueType === issue.type && state.recordId === issue.recordId;
    if (!isCurrent) {
      return { ...issue, statusReason: null, stateVersion: null, stateUpdatedAt: null };
    }
    appliedStates.push(state);
    return {
      ...issue,
      status: state.status,
      statusReason: state.reason,
      stateVersion: state.version,
      stateUpdatedAt: state.updatedAt
    };
  });
  return { issues: overlayedIssues, appliedStates };
}

function memoryIssuesRevisionHash(snapshotRevision: string, states: MemoryIssueState[]): string {
  const stateRevisions = states
    .map((state) => ({
      issueId: state.issueId,
      issueType: state.issueType,
      recordId: state.recordId,
      status: state.status,
      reason: state.reason,
      version: state.version,
      updatedAt: state.updatedAt
    }))
    .sort((left, right) => left.issueId.localeCompare(right.issueId));
  return digest(JSON.stringify({ snapshotRevision, stateRevisions }));
}

export function registerMemoryGraphRoutes(
  app: FastifyInstance,
  options: {
    config: SpaceApiConfig;
    service: MemoryGraphApiService;
    store: SpaceStore;
    consolidationCoordinator: MemoryConsolidationCoordinator;
    mutationCoordinator: MemoryMutationCoordinator;
    recordAudit?: MemoryGraphAuditRecorder;
  }
): void {
  app.get("/api/admin/memory/graph/overview", async (request, reply) => {
    requireMemoryGraph(options.config);
    const query = listMemoryGraphOverviewQuerySchema.parse(request.query);
    const snapshotData = query.month
      ? { snapshot: await options.service.getArchiveSnapshot(), isStale: false }
      : await options.service.getSnapshot();
    const { snapshot, isStale } = snapshotData;
    if (setSnapshotEtag(request, reply, snapshot.revisionHash ?? snapshot.sourceHash)) return reply.code(304).send();
    const availableMonths = await options.service.listAvailableMonths();

    const anchors = filterNodes(snapshot, query).sort((left, right) => left.id.localeCompare(right.id));
    const anchorIds = new Set(anchors.map((node) => node.id));
    const relatedIds = query.relationMode === "RELATIONS"
      ? new Set(snapshot.edges.flatMap((edge) => {
        if (anchorIds.has(edge.source)) return [edge.target];
        if (anchorIds.has(edge.target)) return [edge.source];
        return [];
      }))
      : new Set<string>();
    const relatedNodes = query.relationMode === "RELATIONS"
      ? snapshot.nodes
        .filter((node) => !anchorIds.has(node.id) && relatedIds.has(node.id))
        .sort((left, right) => left.id.localeCompare(right.id))
      : [];
    const matchingNodes = [...anchors, ...relatedNodes];
    const matchingNodeIds = new Set(matchingNodes.map((node) => node.id));
    const matchingEdges = snapshot.edges.filter((edge) =>
      matchingNodeIds.has(edge.source) &&
      matchingNodeIds.has(edge.target) &&
      (query.relationMode !== "RELATIONS" || anchorIds.has(edge.source) || anchorIds.has(edge.target))
    );
    const selectedNodes = matchingNodes.slice(0, 2000);
    const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
    const selectedEdges = matchingEdges
      .filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target))
      .slice(0, 6000);
    const data = memoryGraphOverviewPayloadSchema.parse({
      version: snapshot.version,
      layoutVersion: snapshot.layoutVersion,
      taxonomyVersion: snapshot.taxonomyVersion,
      revisionHash: snapshot.revisionHash,
      generatedAt: snapshot.generatedAt,
      sourceHash: snapshot.sourceHash,
      isStale,
      summary: query.month && query.month !== "all" ? monthScopedSummary(snapshot, query.month) : snapshot.summary,
      nodes: selectedNodes.map(redactedNode),
      edges: selectedEdges.map(redactedEdge),
      totalMatchingNodes: matchingNodes.length,
      totalMatchingEdges: matchingEdges.length,
      truncated: selectedNodes.length !== matchingNodes.length || selectedEdges.length !== matchingEdges.length,
      filters: {
        q: query.q ?? null,
        nodeType: query.nodeType ?? null,
        scope: query.scope ?? null,
        roomId: query.roomId ?? null,
        sourcePath: query.sourcePath ?? null,
        lifecycleStatus: query.lifecycleStatus ?? null,
        relationMode: query.relationMode,
        month: query.month ?? null
      },
      months: availableMonths
    });
    return { data };
  });

  app.get("/api/admin/memory/graph", async (request, reply) => {
    requireMemoryGraph(options.config);
    const query = listMemoryGraphQuerySchema.parse(request.query);
    const snapshotData = query.month
      ? { snapshot: await options.service.getArchiveSnapshot(), isStale: false }
      : await options.service.getSnapshot();
    const { snapshot, isStale } = snapshotData;
    if (setSnapshotEtag(request, reply, snapshot.revisionHash ?? snapshot.sourceHash)) return reply.code(304).send();
    const availableMonths = await options.service.listAvailableMonths();

    const filtered = sortNodes(filterNodes(snapshot, query), query);
    const start = (query.page - 1) * query.pageSize;
    const selectedNodes = filtered.slice(start, start + query.pageSize);
    const anchorIds = new Set(selectedNodes.map((node) => node.id));
    const relatedIds = query.relationMode === "RELATIONS"
      ? new Set(snapshot.edges.flatMap((edge) => {
        if (anchorIds.has(edge.source)) return [edge.target];
        if (anchorIds.has(edge.target)) return [edge.source];
        return [];
      }))
      : new Set<string>();
    const relatedNodes = query.relationMode === "RELATIONS"
      ? snapshot.nodes
        .filter((node) => !anchorIds.has(node.id) && relatedIds.has(node.id))
        .slice(0, Math.max(0, 500 - selectedNodes.length))
      : [];
    const nodes = [...selectedNodes, ...relatedNodes].map(redactedNode);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = snapshot.edges.filter((edge) =>
      nodeIds.has(edge.source) && nodeIds.has(edge.target) &&
      (query.relationMode !== "RELATIONS" || anchorIds.has(edge.source) || anchorIds.has(edge.target))
    ).slice(0, 2000);
    const data = memoryGraphPayloadSchema.parse({
      version: snapshot.version,
      layoutVersion: snapshot.layoutVersion,
      taxonomyVersion: snapshot.taxonomyVersion,
      revisionHash: snapshot.revisionHash,
      generatedAt: snapshot.generatedAt,
      sourceHash: snapshot.sourceHash,
      isStale,
      summary: query.month && query.month !== "all" ? monthScopedSummary(snapshot, query.month) : snapshot.summary,
      nodes,
      edges: edges.map(redactedEdge),
      filters: {
        q: query.q ?? null,
        nodeType: query.nodeType ?? null,
        scope: query.scope ?? null,
        roomId: query.roomId ?? null,
        sourcePath: query.sourcePath ?? null,
        lifecycleStatus: query.lifecycleStatus ?? null,
        relationMode: query.relationMode,
        month: query.month ?? null
      },
      months: availableMonths
    });
    return { data, pagination: pagination(query.page, query.pageSize, filtered.length) };
  });

  app.get("/api/admin/memory/nodes/:id", async (request, reply) => {
    requireMemoryGraph(options.config);
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    const live = await options.service.getSnapshot();
    let snapshotData: { snapshot: MemoryGraphSnapshot; isStale: boolean } = live;
    let node = live.snapshot.nodes.find((candidate) => candidate.id === id);
    if (!node) {
      const archive = await options.service.getArchiveSnapshot();
      node = archive.nodes.find((candidate) => candidate.id === id);
      if (node) snapshotData = { snapshot: archive, isStale: false };
    }
    if (setSnapshotEtag(request, reply, snapshotData.snapshot.revisionHash ?? snapshotData.snapshot.sourceHash)) return reply.code(304).send();
    const activeSnapshot = snapshotData.snapshot;
    if (!node) throw new SpaceNotFoundError(`Memory graph node ${id} was not found.`);
    const relatedIds = new Set(activeSnapshot.edges.flatMap((edge) => {
      if (edge.source === id) return [edge.target];
      if (edge.target === id) return [edge.source];
      return [];
    }));
    const record: MemoryGraphRecord | null = node.recordId
      ? activeSnapshot.records.find((candidate) => candidate.id === node.recordId) ?? null
      : null;
    const { issues } = await applyIssueStateOverlays(
      options.store,
      activeSnapshot.issues.filter((issue) => issue.recordId === node.recordId).slice(0, 500)
    );
    return memoryGraphNodeDetailSchema.parse({
      node: redactedNode(node),
      record: redactedRecord(record),
      relatedNodes: activeSnapshot.nodes.filter((candidate) => relatedIds.has(candidate.id)).slice(0, 500).map(redactedNode),
      relatedEdges: activeSnapshot.edges
        .filter((edge) => edge.source === id || edge.target === id)
        .slice(0, 1000)
        .map(redactedEdge),
      issues: issues.map(redactedIssue)
    });
  });

  app.post(
    "/api/admin/memory/nodes/:id/change-sets",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      requireMemoryGraph(options.config);
      const id = idSchema.parse((request.params as { id?: unknown }).id);
      const input = createMemoryNodeChangeSetInputSchema.parse(request.body);
      const { snapshot, isStale } = await options.service.getSnapshot();
      if (isStale) {
        throw new SpaceConflictError("The memory graph snapshot is stale; refresh it before creating a node proposal.");
      }
      const node = snapshot.nodes.find((candidate) => candidate.id === id);
      const record = node?.recordId
        ? snapshot.records.find((candidate) => candidate.id === node.recordId)
        : undefined;
      if (!node || !record) throw new SpaceNotFoundError(`Memory graph record node ${id} was not found.`);
      if (record.contentHash !== input.expectedContentHash) {
        throw new SpaceConflictError(`Memory record ${record.id} changed before this proposal.`);
      }

      const beforeSnapshot = await options.service.getSourceContent(record.sourcePath);
      const edits: MemorySourceEdit[] = [];
      const recordIds = [record.id];
      if (input.kind === "EDIT") {
        if (redactMemoryText(record.body) !== record.body) {
          throw new SpaceConflictError("This record contains protected content and cannot be edited through the redacted workspace.");
        }
        const replacement = input.body.trim();
        if (!/^#{2,3}\s+\S/.test(replacement)) {
          throw new SpaceConflictError("Edited canonical memory must retain a level-two or dated level-three heading.");
        }
        if (/\b(?:lifecycle_status=ARCHIVED|merged_into=)\b/.test(replacement)) {
          throw new SpaceConflictError("Lifecycle and merge metadata require their dedicated node actions.");
        }
        edits.push(recordBodyEdit(beforeSnapshot, record, replacement));
      } else if (input.kind === "ARCHIVE") {
        if (record.lifecycleStatus !== "ACTIVE") {
          throw new SpaceConflictError(`Memory record ${record.id} is already archived.`);
        }
        edits.push(recordBodyEdit(beforeSnapshot, record, appendMemoryMetadata(record.body, ["lifecycle_status=ARCHIVED"])));
      } else {
        const target = snapshot.records.find((candidate) => candidate.id === input.targetRecordId);
        if (!target || target.id === record.id) {
          throw new SpaceConflictError("Merge target must be a different canonical memory record.");
        }
        if (record.lifecycleStatus !== "ACTIVE" || target.lifecycleStatus !== "ACTIVE") {
          throw new SpaceConflictError("Merge proposals require two active canonical memory records.");
        }
        if (target.sourcePath !== record.sourcePath) {
          throw new SpaceConflictError("Merge proposals require records from the same canonical source file.");
        }
        recordIds.push(target.id);
        edits.push(recordBodyEdit(beforeSnapshot, record, appendMemoryMetadata(record.body, [
          "lifecycle_status=ARCHIVED",
          `merged_into=${target.id}`
        ])));
        const targetBody = new RegExp(`\\bsupersedes=${record.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(target.body)
          ? target.body
          : appendMemoryMetadata(target.body, [`supersedes=${record.id}`]);
        edits.push(recordBodyEdit(beforeSnapshot, target, targetBody));
      }

      const afterSnapshot = applySourceEdits(beforeSnapshot, edits);
      if (afterSnapshot === beforeSnapshot) {
        throw new SpaceConflictError("Memory node proposal does not change canonical content.");
      }
      const actor = await options.store.upsertUser(request.user!);
      const commandScope = "memory.node_change_set.create";
      const idempotencyKeyHash = hashMemoryIdempotencyKey(request.headers["idempotency-key"]);
      const resourceId = buildMemoryCommandResourceId("memory_change", commandScope, actor.id, idempotencyKeyHash);
      const requestHash = hashMemoryCommandRequest(commandScope, { recordId: record.id, input });
      const claim = await options.store.claimMemoryCommand({
        commandScope,
        actorKey: actor.id,
        idempotencyKeyHash,
        requestHash,
        resourceType: "memory_change_set",
        resourceId,
        workflowId: null
      });
      const created = await options.store.createMemoryChangeSet({
        kind: input.kind,
        sourcePath: record.sourcePath,
        recordIds,
        resolvesIssueIds: [],
        expectedSourceHash: snapshot.sourceHash,
        beforeContentHash: digest(beforeSnapshot),
        afterContentHash: digest(afterSnapshot),
        beforeSnapshot,
        afterSnapshot,
        reason: input.reason,
        actorUserId: actor.id
      }, request.requestIdForSpace, { id: resourceId });
      await options.recordAudit?.(request, {
        action: claim.created ? "memory.node_change_set.created" : "memory.node_change_set.retried",
        targetType: "memory_change_set",
        targetId: created.id,
        metadata: {
          kind: created.kind,
          recordIds: created.recordIds,
          idempotencyReplay: !claim.created
        }
      });
      return reply.code(claim.created ? 201 : 200).send(summarizedChangeSet(created));
    }
  );

  app.get("/api/admin/memory/issues", async (request, reply) => {
    requireMemoryGraph(options.config);
    const query = listMemoryIssuesQuerySchema.parse(request.query);
    const { snapshot } = await options.service.getSnapshot();
    const candidates = snapshot.issues.filter((issue) =>
      (!query.type || issue.type === query.type) &&
      (!query.severity || issue.severity === query.severity) &&
      (!query.recordId || issue.recordId === query.recordId)
    );
    const { issues, appliedStates } = await applyIssueStateOverlays(options.store, candidates);
    const revisionHash = memoryIssuesRevisionHash(snapshot.revisionHash ?? snapshot.sourceHash, appliedStates);
    reply.header("Cache-Control", "private, no-cache");
    if (setSnapshotEtag(request, reply, revisionHash)) return reply.code(304).send();
    const filtered = sortIssues(issues.filter((issue) => !query.status || issue.status === query.status), query);
    const start = (query.page - 1) * query.pageSize;
    return {
      data: filtered.slice(start, start + query.pageSize).map(redactedIssue),
      pagination: pagination(query.page, query.pageSize, filtered.length)
    };
  });

  app.patch(
    "/api/admin/memory/issues/:id",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      requireMemoryGraph(options.config);
      const id = idSchema.parse((request.params as { id?: unknown }).id);
      const input = patchMemoryIssueInputSchema.parse(request.body);
      const { snapshot } = await options.service.getSnapshot();
      const issue = snapshot.issues.find((candidate) => candidate.id === id);
      if (!issue) throw new SpaceNotFoundError(`Memory graph issue ${id} was not found.`);
      const actor = await options.store.upsertUser(request.user!);
      const state = await options.store.upsertMemoryIssueState({
        issueId: issue.id,
        issueType: issue.type,
        recordId: issue.recordId,
        sourceHash: snapshot.sourceHash,
        status: input.status,
        reason: input.reason,
        actorUserId: actor.id,
        expectedVersion: input.expectedVersion
      });
      await options.recordAudit?.(request, {
        action: "memory.issue.status_updated",
        targetType: "memory_graph_issue",
        targetId: issue.id,
        metadata: {
          issueType: issue.type,
          recordId: issue.recordId,
          status: state.status,
          stateVersion: state.version
        }
      });
      return redactedIssue({
        ...issue,
        status: state.status,
        statusReason: state.reason,
        stateVersion: state.version,
        stateUpdatedAt: state.updatedAt
      });
    }
  );

  app.post(
    "/api/admin/memory/consolidations",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      requireMemoryMaintenance(options.config);
      const input = createMemoryConsolidationInputSchema.parse(request.body);
      if (input.mode === "REPAIR") requireMemoryMutations(options.config);
      const actor = await options.store.upsertUser(request.user!);
      const idempotencyKeyHash = hashMemoryIdempotencyKey(request.headers["idempotency-key"]);
      const commandScope = "memory.consolidation.create";
      const workflowHash = hashMemoryCommandRequest("memory.consolidation.workflow", {
        actorKey: actor.id,
        idempotencyKeyHash,
        mode: input.mode
      });
      const workflowId = buildMemoryConsolidationWorkflowId(workflowHash);
      const run = await options.store.createMemoryConsolidationRun({
        mode: input.mode,
        triggerKind: "OPERATOR",
        workflowId,
        dedupeKey: `operator:${actor.id}:${idempotencyKeyHash}`,
        sourceHash: null,
        actorUserId: actor.id
      });
      const claim = await options.store.claimMemoryCommand({
        commandScope,
        actorKey: actor.id,
        idempotencyKeyHash,
        requestHash: hashMemoryCommandRequest(commandScope, input),
        resourceType: "memory_consolidation",
        resourceId: run.id,
        workflowId
      });
      const schedule = await options.consolidationCoordinator.start({
        runId: run.id,
        traceId: request.requestIdForSpace
      }, workflowId);
      await options.recordAudit?.(request, {
        action: claim.created ? "memory.consolidation.created" : "memory.consolidation.retried",
        targetType: "memory_consolidation",
        targetId: run.id,
        metadata: {
          mode: run.mode,
          workflowId,
          scheduleStatus: schedule.status,
          temporalRunId: schedule.runId,
          idempotencyReplay: !claim.created
        }
      });
      return reply.code(202).send(memoryConsolidationCommandResponseSchema.parse({
        run,
        schedule,
        maintenanceEnabled: options.config.memoryGraphEnabled && options.config.memoryMaintenanceEnabled,
        mutationsEnabled: options.config.memoryGraphEnabled && options.config.memoryMutationsEnabled
      }));
    }
  );

  app.get("/api/admin/memory/consolidations/:id", async (request) => {
    requireMemoryGraph(options.config);
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    const [run, findings, operations] = await Promise.all([
      options.store.getMemoryConsolidationRun(id),
      options.store.listMemoryConsolidationFindings(id, 500),
      options.store.listMemoryConsolidationOperations(id, 500)
    ]);
    return memoryConsolidationDetailSchema.parse({
      run,
      findings,
      operations,
      maintenanceEnabled: options.config.memoryGraphEnabled && options.config.memoryMaintenanceEnabled,
      mutationsEnabled: options.config.memoryGraphEnabled && options.config.memoryMutationsEnabled
    });
  });

  app.get("/api/admin/memory/change-sets", async (request) => {
    requireMemoryGraph(options.config);
    const query = listMemoryChangeSetsQuerySchema.parse(request.query);
    const [data, nextPage] = await Promise.all([
      options.store.listMemoryChangeSets(query),
      options.store.listMemoryChangeSets({ ...query, page: query.page + 1 })
    ]);
    return {
      data,
      pagination: { page: query.page, pageSize: query.pageSize, hasNext: nextPage.length > 0 },
      mutationsEnabled: options.config.memoryMutationsEnabled
    };
  });

  app.post(
    "/api/admin/memory/change-sets",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      requireMemoryGraph(options.config);
      const actor = await options.store.upsertUser(request.user!);
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const input = createMemoryChangeSetInputSchema.parse({ ...body, actorUserId: actor.id });
      if (input.kind === "ROLLBACK") {
        throw new SpaceConflictError("Rollback change sets must use the dedicated audited rollback endpoint.");
      }
      const commandScope = "memory.change_set.create";
      const idempotencyKeyHash = hashMemoryIdempotencyKey(request.headers["idempotency-key"]);
      const resourceId = buildMemoryCommandResourceId(
        "memory_change",
        commandScope,
        actor.id,
        idempotencyKeyHash
      );
      const claim = await options.store.claimMemoryCommand({
        commandScope,
        actorKey: actor.id,
        idempotencyKeyHash,
        requestHash: hashMemoryCommandRequest(commandScope, input),
        resourceType: "memory_change_set",
        resourceId,
        workflowId: null
      });
      const created = await options.store.createMemoryChangeSet(
        input,
        request.requestIdForSpace,
        { id: resourceId }
      );
      await options.recordAudit?.(request, {
        action: claim.created ? "memory.change_set.created" : "memory.change_set.retried",
        targetType: "memory_change_set",
        targetId: created.id,
        metadata: {
          kind: created.kind,
          status: created.status,
          sourcePath: created.sourcePath,
          idempotencyReplay: !claim.created
        }
      });
      return reply.code(claim.created ? 201 : 200).send(summarizedChangeSet(created));
    }
  );

  app.post(
    "/api/admin/memory/change-sets/:id/rollbacks",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      requireMemoryMutations(options.config);
      const id = idSchema.parse((request.params as { id?: unknown }).id);
      const rollbackRequest = createMemoryRollbackInputSchema.parse(request.body);
      const target = await options.store.getMemoryChangeSet(id);
      if (target.status !== "APPLIED" || target.rolledBackByChangeSetId || !target.resultingSourceHash) {
        throw new SpaceConflictError(`Memory change set ${id} is not eligible for rollback.`);
      }
      const actor = await options.store.upsertUser(request.user!);
      const commandScope = "memory.change_set.rollback";
      const idempotencyKeyHash = hashMemoryIdempotencyKey(request.headers["idempotency-key"]);
      const resourceId = buildMemoryCommandResourceId(
        "memory_change",
        commandScope,
        actor.id,
        idempotencyKeyHash
      );
      const rollbackInput = createMemoryChangeSetInputSchema.parse({
        kind: "ROLLBACK",
        sourcePath: target.sourcePath,
        recordIds: target.recordIds,
        resolvesIssueIds: target.resolvesIssueIds,
        expectedSourceHash: target.resultingSourceHash,
        beforeContentHash: target.afterContentHash,
        afterContentHash: target.beforeContentHash,
        beforeSnapshot: target.afterSnapshot,
        afterSnapshot: target.beforeSnapshot,
        reason: rollbackRequest.reason,
        actorUserId: actor.id,
        rollbackOfChangeSetId: target.id
      });
      const claim = await options.store.claimMemoryCommand({
        commandScope,
        actorKey: actor.id,
        idempotencyKeyHash,
        requestHash: hashMemoryCommandRequest(commandScope, {
          targetChangeSetId: target.id,
          reason: rollbackRequest.reason
        }),
        resourceType: "memory_change_set",
        resourceId,
        workflowId: null
      });
      const created = await options.store.createMemoryChangeSet(
        rollbackInput,
        request.requestIdForSpace,
        { id: resourceId }
      );
      await options.recordAudit?.(request, {
        action: claim.created ? "memory.change_set.rollback_created" : "memory.change_set.rollback_retried",
        targetType: "memory_change_set",
        targetId: created.id,
        metadata: {
          rollbackOfChangeSetId: target.id,
          status: created.status,
          idempotencyReplay: !claim.created
        }
      });
      return reply.code(claim.created ? 201 : 200).send(summarizedChangeSet(created));
    }
  );

  app.get("/api/admin/memory/change-sets/:id", async (request) => {
    requireMemoryGraph(options.config);
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    return redactedChangeSet(await options.store.getMemoryChangeSet(id));
  });

  app.patch("/api/admin/memory/change-sets/:id", async (request) => {
    requireMemoryGraph(options.config);
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    const input = reviewMemoryChangeSetSchema.parse(request.body);
    const updated = await options.store.updateMemoryChangeSet(id, input);
    await options.recordAudit?.(request, {
      action: "memory.change_set.reviewed",
      targetType: "memory_change_set",
      targetId: updated.id,
      metadata: { status: updated.status }
    });
    return summarizedChangeSet(updated);
  });

  const scheduleMutationCommand = (
    commandScope: "memory.change_set.execute" | "memory.change_set.reconcile",
    expectedStatus: "APPROVED" | "APPLYING",
    action: "memory.change_set.executed" | "memory.change_set.reconciled",
    retryAction: "memory.change_set.execution_retried" | "memory.change_set.reconciliation_retried",
    commandLabel: "execution" | "reconciliation"
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    requireMemoryMutations(options.config);
    memoryChangeSetCommandInputSchema.parse(request.body ?? {});
    const id = idSchema.parse((request.params as { id?: unknown }).id);
    const actor = await options.store.upsertUser(request.user!);
    const idempotencyKeyHash = hashMemoryIdempotencyKey(request.headers["idempotency-key"]);
    const workflowCommandHash = commandScope === "memory.change_set.reconcile"
      ? hashMemoryCommandRequest("memory.reconciliation.workflow", {
        actorKey: actor.id,
        changeSetId: id,
        idempotencyKeyHash
      })
      : undefined;
    const workflowId = buildMemoryMutationWorkflowId(id, workflowCommandHash);
    const changeSet = await options.store.getMemoryChangeSet(id);
    if (changeSet.status !== expectedStatus) {
      throw new SpaceConflictError(`Memory change set ${id} must be ${expectedStatus} before ${commandLabel}.`);
    }
    const claim = await options.store.claimMemoryCommand({
      commandScope,
      actorKey: actor.id,
      idempotencyKeyHash,
      requestHash: hashMemoryCommandRequest(commandScope, { changeSetId: id }),
      resourceType: "memory_mutation_workflow",
      resourceId: workflowId,
      workflowId
    });
    const result = await options.mutationCoordinator.start({
      changeSetId: id,
      traceId: request.requestIdForSpace
    }, workflowCommandHash);
    await options.recordAudit?.(request, {
      action: claim.created ? action : retryAction,
      targetType: "memory_change_set",
      targetId: id,
      metadata: {
        workflowId: result.workflowId,
        runId: result.runId,
        scheduleStatus: result.status,
        idempotencyReplay: !claim.created
      }
    });
    return reply.code(202).send(result);
  };

  const executeMutationCommand = scheduleMutationCommand(
    "memory.change_set.execute",
    "APPROVED",
    "memory.change_set.executed",
    "memory.change_set.execution_retried",
    "execution"
  );
  app.post(
    "/api/admin/memory/change-sets/:id/execute",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    executeMutationCommand
  );
  app.post(
    "/api/admin/memory/change-sets/:id/executions",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    executeMutationCommand
  );

  const reconcileMutationCommand = scheduleMutationCommand(
    "memory.change_set.reconcile",
    "APPLYING",
    "memory.change_set.reconciled",
    "memory.change_set.reconciliation_retried",
    "reconciliation"
  );
  app.post(
    "/api/admin/memory/change-sets/:id/reconcile",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    reconcileMutationCommand
  );
  app.post(
    "/api/admin/memory/change-sets/:id/reconciliations",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    reconcileMutationCommand
  );
}
