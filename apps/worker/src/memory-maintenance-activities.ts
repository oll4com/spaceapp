import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  memoryConsolidationWorkflowInputSchema,
  memoryMaintenanceInputSchema,
  memoryMaintenanceResultSchema,
  memoryGraphSnapshotSchema,
  type CreateMemoryChangeSetInput,
  type CreateMemoryConsolidationFindingInput,
  type CreateMemoryConsolidationOperationInput,
  type CreateMemoryConsolidationRunInput,
  type ListMemoryCacheLinksQuery,
  type ListMemoryQuery,
  type MemoryCacheLink,
  type MemoryChangeSet,
  type MemoryAiAuditResult,
  type MemoryConsolidationFinding,
  type MemoryConsolidationOperation,
  type MemoryConsolidationRun,
  type MemoryConsolidationWorkflowInput,
  type MemoryEntry,
  type MemoryMaintenanceInput,
  type MemoryMaintenanceResult,
  type MemoryMutationWorkflowResult,
  type UpdateMemoryChangeSetInput,
  type UpdateMemoryConsolidationFindingInput,
  type UpdateMemoryConsolidationOperationInput,
  type UpdateMemoryConsolidationRunInput
} from "@space/contracts";
import {
  ALL_MONTHS_SNAPSHOT_FILENAME,
  buildMemoryGraphSnapshot,
  calculateMemoryGraphSourceHash,
  createMemoryGraphSnapshotStore,
  type MemoryGraphCacheRecord,
  type MemoryGraphSnapshot,
  type MemoryGraphSource
} from "@space/memory-graph";
import { redactMemoryText, resolveCanonicalGeminiMemoryPaths } from "@space/runtime";
import { runMemoryAiAudit } from "./memory-ai-audit.js";

const DEFAULT_INDEX_PATH = "/opt/spaceapp/docs/gemini_history.md";
const DEFAULT_GRAPH_ROOT = "/opt/spaceapp/var/memory-graph";
const ATHENS_TIME_ZONE = "Europe/Athens";
const CACHE_BATCH_LIMIT = 500;
const MONTHLY_MEMORY_PATTERN = /^gemini_history_(\d{4}-\d{2})\.md$/;

interface MemoryMaintenanceCacheStore {
  listMemoryEntries(query: ListMemoryQuery, options: { limit: number }): Promise<MemoryEntry[]> | MemoryEntry[];
  listMemoryCacheLinks(query: ListMemoryCacheLinksQuery): Promise<MemoryCacheLink[]> | MemoryCacheLink[];
  linkMemoryCacheRecord(input: {
    memoryRecordId: string;
    canonicalMemoryId: string;
    linkSource: "EXACT_BACKFILL";
  }): Promise<MemoryCacheLink> | MemoryCacheLink;
}

interface MemoryConsolidationStore {
  createMemoryConsolidationRun(
    input: CreateMemoryConsolidationRunInput
  ): Promise<MemoryConsolidationRun> | MemoryConsolidationRun;
  getMemoryConsolidationRun(runId: string): Promise<MemoryConsolidationRun> | MemoryConsolidationRun;
  updateMemoryConsolidationRun(
    runId: string,
    input: UpdateMemoryConsolidationRunInput
  ): Promise<MemoryConsolidationRun> | MemoryConsolidationRun;
  createMemoryConsolidationFinding(
    input: CreateMemoryConsolidationFindingInput
  ): Promise<MemoryConsolidationFinding> | MemoryConsolidationFinding;
  updateMemoryConsolidationFinding(
    findingId: string,
    input: UpdateMemoryConsolidationFindingInput
  ): Promise<MemoryConsolidationFinding> | MemoryConsolidationFinding;
  listMemoryConsolidationFindings(runId: string, limit?: number): Promise<MemoryConsolidationFinding[]> | MemoryConsolidationFinding[];
  createMemoryConsolidationOperation(
    input: CreateMemoryConsolidationOperationInput
  ): Promise<MemoryConsolidationOperation> | MemoryConsolidationOperation;
  updateMemoryConsolidationOperation(
    operationId: string,
    input: UpdateMemoryConsolidationOperationInput
  ): Promise<MemoryConsolidationOperation> | MemoryConsolidationOperation;
  listMemoryConsolidationOperations(runId: string, limit?: number): Promise<MemoryConsolidationOperation[]> | MemoryConsolidationOperation[];
  createMemoryChangeSet(
    input: CreateMemoryChangeSetInput,
    traceId?: string,
    options?: { id?: string }
  ): Promise<MemoryChangeSet> | MemoryChangeSet;
  getMemoryChangeSet(changeSetId: string): Promise<MemoryChangeSet> | MemoryChangeSet;
  updateMemoryChangeSet(
    changeSetId: string,
    input: UpdateMemoryChangeSetInput
  ): Promise<MemoryChangeSet> | MemoryChangeSet;
}

interface CanonicalMemorySource {
  path: string;
  kind: "INDEX" | "MONTHLY";
}

let cachedDatabaseUrl: string | null = null;
let cachedStore: MemoryMaintenanceCacheStore | null = null;
let cachedConsolidationDatabaseUrl: string | null = null;
let cachedConsolidationStore: MemoryConsolidationStore | null = null;

export interface RefreshMemoryGraphSnapshotOptions {
  rootDir?: string;
  indexPath?: string;
  monthlyPath?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  store?: MemoryMaintenanceCacheStore;
}

export interface RefreshAllMonthsMemoryGraphSnapshotOptions {
  rootDir?: string;
  indexPath?: string;
  memoryDir?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  store?: MemoryMaintenanceCacheStore;
}

export interface ExecuteMemoryConsolidationOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  store?: MemoryConsolidationStore;
  sources?: CanonicalMemorySource[];
  runAiAudit?: (input: Parameters<typeof runMemoryAiAudit>[0]) => Promise<MemoryAiAuditResult>;
}

export interface MemoryConsolidationPreparation {
  run: MemoryConsolidationRun;
  changeSetId: string | null;
}

export interface FinalizeMemoryRepairInput {
  runId: string;
  changeSetId: string;
  mutationResult: MemoryMutationWorkflowResult;
}

export interface ScheduledMemoryAuditInput extends MemoryMaintenanceInput {
  sourceHash: string;
}

async function resolveCacheStore(options: RefreshMemoryGraphSnapshotOptions): Promise<MemoryMaintenanceCacheStore | null> {
  if (options.store) return options.store;
  const databaseUrl = (options.env ?? process.env).SPACE_DATABASE_URL;
  if (!databaseUrl) return null;
  if (cachedStore && cachedDatabaseUrl === databaseUrl) return cachedStore;
  const { PostgresSpaceStore } = await import("@space/db");
  cachedDatabaseUrl = databaseUrl;
  cachedStore = PostgresSpaceStore.fromConnectionString(databaseUrl);
  return cachedStore;
}

async function resolveConsolidationStore(options: ExecuteMemoryConsolidationOptions): Promise<MemoryConsolidationStore> {
  if (options.store) return options.store;
  const databaseUrl = (options.env ?? process.env).SPACE_DATABASE_URL;
  if (!databaseUrl) throw new Error("SPACE_DATABASE_URL is required for durable memory consolidation.");
  if (cachedConsolidationStore && cachedConsolidationDatabaseUrl === databaseUrl) return cachedConsolidationStore;
  const { PostgresSpaceStore } = await import("@space/db");
  cachedConsolidationDatabaseUrl = databaseUrl;
  cachedConsolidationStore = PostgresSpaceStore.fromConnectionString(databaseUrl);
  return cachedConsolidationStore;
}

function memoryConsolidationEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env.SPACE_MEMORY_GRAPH_ENABLED === "true" && env.SPACE_MEMORY_MAINTENANCE_ENABLED === "true";
}

function athensDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATHENS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("Unable to resolve the Athens calendar date.");
  return `${year}-${month}-${day}`;
}

function memoryRepairEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return memoryConsolidationEnabled(env) && env.SPACE_MEMORY_MUTATIONS_ENABLED === "true";
}

function canonicalSources(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  override?: CanonicalMemorySource[]
): CanonicalMemorySource[] {
  if (override) return override;
  const { indexPath, monthlyPath } = resolveCanonicalGeminiMemoryPaths(env);
  return [
    { path: indexPath, kind: "INDEX" },
    { path: monthlyPath, kind: "MONTHLY" }
  ];
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

interface RepairEdit {
  start: number;
  end: number;
  replacement: string;
}

interface RepairCandidate {
  issue: MemoryGraphSnapshot["issues"][number];
  operationKind: "NORMALIZE_MARKER" | "ARCHIVE_EXACT_DUPLICATE" | "ARCHIVE_SUPERSEDED" | "REPORT_ISSUE";
  recordIds: string[];
  sourcePath: string;
  edit: RepairEdit | null;
  reason: string;
}

function archiveRecordEdit(content: string, record: MemoryGraphSnapshot["records"][number]): RepairEdit | null {
  if (record.lifecycleStatus !== "ACTIVE" || record.sourceStart === undefined || record.sourceEnd === undefined) return null;
  const span = content.slice(record.sourceStart, record.sourceEnd);
  if (span.trim() !== record.body || /\blifecycle_status=ARCHIVED\b/.test(record.body)) return null;
  const bodyStart = span.indexOf(record.body);
  if (bodyStart < 0) return null;
  const bodyEnd = bodyStart + record.body.length;
  return {
    start: record.sourceStart,
    end: record.sourceEnd,
    replacement: `${span.slice(0, bodyEnd)}\n- lifecycle_status=ARCHIVED${span.slice(bodyEnd)}`
  };
}

function normalizeMarkerEdit(content: string, record: MemoryGraphSnapshot["records"][number]): RepairEdit | null {
  if (record.markerId || record.sourceStart === undefined) return null;
  const prefix = content.slice(0, record.sourceStart);
  const matches = [...prefix.matchAll(/<!--\s*space-memory:id=[\s\S]*?-->/g)];
  const marker = matches.at(-1);
  if (!marker || marker.index === undefined) return null;
  const end = marker.index + marker[0].length;
  if (prefix.slice(end).trim()) return null;
  return {
    start: marker.index,
    end,
    replacement: `<!-- space-memory:id=${record.id} -->`
  };
}

function deterministicRepairCandidates(
  snapshot: MemoryGraphSnapshot,
  contents: Map<string, string>
): RepairCandidate[] {
  const records = new Map(snapshot.records.map((record) => [record.id, record]));
  const candidates = snapshot.issues.map((issue): RepairCandidate => {
    const record = issue.recordId ? records.get(issue.recordId) : undefined;
    const report = (reason: string): RepairCandidate => ({
      issue,
      operationKind: "REPORT_ISSUE",
      recordIds: issue.recordId ? [issue.recordId] : [issue.id],
      sourcePath: issue.sourcePath,
      edit: null,
      reason
    });
    if (!record || issue.confidence !== 1 || !contents.has(record.sourcePath)) {
      return report("The deterministic validator could not prove a lossless repair.");
    }
    if (issue.type === "INVALID_MARKER") {
      const edit = normalizeMarkerEdit(contents.get(record.sourcePath)!, record);
      return edit ? {
        issue,
        operationKind: "NORMALIZE_MARKER",
        recordIds: [record.id],
        sourcePath: record.sourcePath,
        edit,
        reason: "Normalize one malformed marker to the record's deterministic ID."
      } : report("The malformed marker could not be isolated exactly.");
    }
    if (issue.type === "EXACT_DUPLICATE") {
      const edge = snapshot.edges.find((candidate) =>
        candidate.type === "DUPLICATES" && candidate.source === record.id && records.has(candidate.target)
      );
      const edit = edge ? archiveRecordEdit(contents.get(record.sourcePath)!, record) : null;
      return edge && edit ? {
        issue,
        operationKind: "ARCHIVE_EXACT_DUPLICATE",
        recordIds: [record.id, edge.target],
        sourcePath: record.sourcePath,
        edit,
        reason: "Archive the exact duplicate while retaining its original canonical content."
      } : report("The exact duplicate relation or source span was not provable.");
    }
    if (issue.type === "STALE") {
      const edge = snapshot.edges.find((candidate) =>
        candidate.type === "SUPERSEDES" && candidate.target === record.id && records.has(candidate.source)
      );
      const edit = edge ? archiveRecordEdit(contents.get(record.sourcePath)!, record) : null;
      return edge && edit ? {
        issue,
        operationKind: "ARCHIVE_SUPERSEDED",
        recordIds: [record.id, edge.source],
        sourcePath: record.sourcePath,
        edit,
        reason: "Archive a record with an exact explicit supersession edge."
      } : report("The supersession relation or source span was not provable.");
    }
    return report("This issue category requires operator review and is never auto-applied.");
  });
  return candidates.sort((left, right) => {
    const leftSafe = left.operationKind === "REPORT_ISSUE" ? 1 : 0;
    const rightSafe = right.operationKind === "REPORT_ISSUE" ? 1 : 0;
    return leftSafe - rightSafe || left.issue.id.localeCompare(right.issue.id);
  });
}

async function completePreparedRepair(
  store: MemoryConsolidationStore,
  run: MemoryConsolidationRun
): Promise<MemoryConsolidationRun> {
  const findings = await store.listMemoryConsolidationFindings(run.id, 500);
  const operations = await store.listMemoryConsolidationOperations(run.id, 500);
  return store.updateMemoryConsolidationRun(run.id, {
    status: "SUCCEEDED",
    progressCompleted: findings.length,
    progressTotal: findings.length,
    findingCount: findings.length,
    appliedOperationCount: operations.filter((operation) => operation.status === "APPLIED").length,
    skippedOperationCount: operations.filter((operation) => operation.status === "SKIPPED").length,
    failedOperationCount: operations.filter((operation) => operation.status === "FAILED").length,
    metrics: {
      deterministicIssueCount: findings.length,
      findingsCreated: findings.length,
      operationsCreated: operations.length
    },
    modelId: null,
    aiVerified: false,
    aiEvidence: {}
  });
}

export async function createScheduledMemoryAudit(
  rawInput: ScheduledMemoryAuditInput,
  options: Pick<ExecuteMemoryConsolidationOptions, "env" | "store"> = {}
): Promise<MemoryConsolidationRun> {
  const maintenance = memoryMaintenanceInputSchema.parse(rawInput);
  if (!/^[a-f0-9]{64}$/.test(rawInput.sourceHash)) throw new Error("Scheduled memory audit requires a valid source hash.");
  const env = options.env ?? process.env;
  if (!memoryConsolidationEnabled(env)) throw new Error("Memory consolidation maintenance is disabled.");
  const date = athensDate(new Date(maintenance.scheduledAt));
  const store = await resolveConsolidationStore(options);
  return store.createMemoryConsolidationRun({
    mode: "AUDIT",
    triggerKind: "SCHEDULED",
    workflowId: `space-memory-consolidation:scheduled:${date}`,
    dedupeKey: `scheduled:${date}`,
    sourceHash: rawInput.sourceHash,
    actorUserId: null
  });
}

export async function executeMemoryConsolidation(
  rawInput: MemoryConsolidationWorkflowInput,
  options: ExecuteMemoryConsolidationOptions = {}
): Promise<MemoryConsolidationRun> {
  const input = memoryConsolidationWorkflowInputSchema.parse(rawInput);
  const env = options.env ?? process.env;
  if (!memoryConsolidationEnabled(env)) throw new Error("Memory consolidation maintenance is disabled.");

  const store = await resolveConsolidationStore(options);
  let run = await store.getMemoryConsolidationRun(input.runId);
  if (run.status === "SUCCEEDED") return run;
  if (run.status !== "QUEUED" && run.status !== "RUNNING") {
    throw new Error(`Memory consolidation ${run.id} cannot execute from ${run.status}.`);
  }
  if (run.mode !== "AUDIT") {
    throw new Error(`Memory consolidation mode ${run.mode} is not supported by the deterministic audit activity.`);
  }

  const rootDir = options.rootDir ?? env.SPACE_MEMORY_GRAPH_ROOT ?? DEFAULT_GRAPH_ROOT;
  const snapshot = await createMemoryGraphSnapshotStore({ rootDir }).read();
  if (!snapshot) {
    if (run.status === "QUEUED") {
      await store.updateMemoryConsolidationRun(run.id, {
        status: "FAILED",
        statusReason: "No valid persisted memory graph snapshot is available."
      });
    }
    throw new Error("No valid persisted memory graph snapshot is available.");
  }
  if (run.sourceHash && run.sourceHash !== snapshot.sourceHash) {
    throw new Error(`Memory consolidation ${run.id} is pinned to a different snapshot.`);
  }

  if (run.status === "QUEUED") {
    run = await store.updateMemoryConsolidationRun(run.id, {
      status: "RUNNING",
      sourceHash: snapshot.sourceHash,
      progressCompleted: 0,
      progressTotal: snapshot.issues.length,
      metrics: {
        snapshotVersion: snapshot.version,
        deterministicIssueCount: snapshot.issues.length,
        findingsCreated: 0,
        operationsCreated: 0
      }
    });
  }

  for (const issue of snapshot.issues) {
    await store.createMemoryConsolidationFinding({
      runId: run.id,
      issueId: issue.id,
      findingType: issue.type,
      severity: issue.severity,
      confidence: issue.confidence,
      recordIds: issue.recordId ? [issue.recordId] : [],
      sourcePath: issue.sourcePath,
      evidence: redactMemoryText(issue.evidence).slice(0, 4_000)
    });
  }

  let aiResult: MemoryAiAuditResult;
  try {
    aiResult = await (options.runAiAudit ?? ((auditInput) => runMemoryAiAudit(auditInput, { env })))({
      issues: snapshot.issues,
      records: snapshot.records.map((record) => ({
        id: record.id,
        title: record.title,
        body: record.body,
        provenance: record.provenance,
        sourcePath: record.sourcePath
      }))
    });
  } catch {
    aiResult = {
      status: "DEGRADED",
      verified: false,
      modelId: null,
      suggestionCount: 0,
      downgradedCount: 0,
      evidence: { reason: "AI_AUDIT_FAILED_CLOSED" }
    };
  }

  return store.updateMemoryConsolidationRun(run.id, {
    status: "SUCCEEDED",
    sourceHash: snapshot.sourceHash,
    progressCompleted: snapshot.issues.length,
    progressTotal: snapshot.issues.length,
    findingCount: snapshot.issues.length,
    appliedOperationCount: 0,
    skippedOperationCount: 0,
    failedOperationCount: 0,
    metrics: {
      snapshotVersion: snapshot.version,
      deterministicIssueCount: snapshot.issues.length,
      findingsCreated: snapshot.issues.length,
      operationsCreated: 0,
      aiStatus: aiResult.status,
      aiSuggestionCount: aiResult.suggestionCount,
      aiDowngradedCount: aiResult.downgradedCount
    },
    modelId: aiResult.modelId,
    aiVerified: aiResult.verified,
    aiEvidence: { status: aiResult.status, ...aiResult.evidence }
  });
}

export async function prepareMemoryConsolidation(
  rawInput: MemoryConsolidationWorkflowInput,
  options: ExecuteMemoryConsolidationOptions = {}
): Promise<MemoryConsolidationPreparation> {
  const input = memoryConsolidationWorkflowInputSchema.parse(rawInput);
  const env = options.env ?? process.env;
  if (!memoryConsolidationEnabled(env)) throw new Error("Memory consolidation maintenance is disabled.");
  const store = await resolveConsolidationStore(options);
  let run = await store.getMemoryConsolidationRun(input.runId);
  if (run.mode === "AUDIT") {
    return { run: await executeMemoryConsolidation(input, { ...options, store }), changeSetId: null };
  }
  if (!memoryRepairEnabled(env)) throw new Error("Memory consolidation repair is disabled.");
  if (!run.actorUserId) throw new Error("Memory consolidation repair requires an operator actor.");
  const actorUserId = run.actorUserId;
  if (run.status === "SUCCEEDED") return { run, changeSetId: null };
  if (run.status !== "QUEUED" && run.status !== "RUNNING") {
    throw new Error(`Memory consolidation ${run.id} cannot prepare repair from ${run.status}.`);
  }

  const rootDir = options.rootDir ?? env.SPACE_MEMORY_GRAPH_ROOT ?? DEFAULT_GRAPH_ROOT;
  const snapshot = await createMemoryGraphSnapshotStore({ rootDir }).read();
  if (!snapshot) throw new Error("No valid persisted memory graph snapshot is available.");
  if (run.sourceHash && run.sourceHash !== snapshot.sourceHash) {
    throw new Error(`Memory consolidation ${run.id} is pinned to a different snapshot.`);
  }
  const sources = canonicalSources(env, options.sources);
  const sourceContents = new Map<string, string>();
  for (const source of sources) sourceContents.set(source.path, await readFile(source.path, "utf8"));
  const currentSourceHash = calculateMemoryGraphSourceHash(sources.map((source) => ({
    ...source,
    content: sourceContents.get(source.path)!
  })));
  if (currentSourceHash !== snapshot.sourceHash) {
    throw new Error("Canonical memory changed after the persisted snapshot was generated.");
  }

  if (run.status === "QUEUED") {
    run = await store.updateMemoryConsolidationRun(run.id, {
      status: "RUNNING",
      sourceHash: snapshot.sourceHash,
      progressCompleted: 0,
      progressTotal: snapshot.issues.length,
      metrics: {
        snapshotVersion: snapshot.version,
        deterministicIssueCount: snapshot.issues.length,
        findingsCreated: 0,
        operationsCreated: 0
      }
    });
  }

  let candidates = deterministicRepairCandidates(snapshot, sourceContents);
  const safeSourcePaths = new Set(
    candidates.filter((candidate) => candidate.edit).map((candidate) => candidate.sourcePath)
  );
  if (safeSourcePaths.size > 1) {
    candidates = candidates.map((candidate) => candidate.edit ? {
      ...candidate,
      operationKind: "REPORT_ISSUE",
      edit: null,
      reason: "A multi-file automatic repair cannot preserve one exact aggregate source hash."
    } : candidate);
  }
  const edits = candidates.flatMap((candidate) => candidate.edit ? [candidate.edit] : [])
    .sort((left, right) => left.start - right.start);
  if (edits.some((edit, index) => index > 0 && edit.start < edits[index - 1]!.end)) {
    candidates = candidates.map((candidate) => candidate.edit ? {
      ...candidate,
      operationKind: "REPORT_ISSUE",
      edit: null,
      reason: "Automatic repair edits overlap and require operator review."
    } : candidate);
  }

  const existingFindings = await store.listMemoryConsolidationFindings(run.id, 500);
  const existingOperations = await store.listMemoryConsolidationOperations(run.id, 500);
  const safe: Array<{ candidate: RepairCandidate; finding: MemoryConsolidationFinding; operation: MemoryConsolidationOperation }> = [];
  for (const candidate of candidates) {
    const finding = existingFindings.find((item) => item.issueId === candidate.issue.id) ??
      await store.createMemoryConsolidationFinding({
        runId: run.id,
        issueId: candidate.issue.id,
        findingType: candidate.issue.type,
        severity: candidate.issue.severity,
        confidence: candidate.issue.confidence,
        recordIds: candidate.recordIds,
        sourcePath: candidate.issue.sourcePath,
        evidence: redactMemoryText(candidate.issue.evidence).slice(0, 4_000)
      });
    const operation = existingOperations.find((item) => item.findingId === finding.id) ??
      await store.createMemoryConsolidationOperation({
        runId: run.id,
        findingId: finding.id,
        operationKind: candidate.operationKind,
        recordIds: candidate.recordIds,
        reason: candidate.reason
      });
    if (!candidate.edit) {
      if (operation.status === "PROPOSED") await store.updateMemoryConsolidationOperation(operation.id, { status: "SKIPPED" });
      if (finding.status === "OPEN") await store.updateMemoryConsolidationFinding(finding.id, { status: "SKIPPED" });
      continue;
    }
    safe.push({ candidate, finding, operation });
  }

  if (safe.length === 0) {
    return { run: await completePreparedRepair(store, run), changeSetId: null };
  }
  const sourcePath = safe[0]!.candidate.sourcePath;
  const beforeSnapshot = sourceContents.get(sourcePath)!;
  const afterSnapshot = [...safe]
    .sort((left, right) => right.candidate.edit!.start - left.candidate.edit!.start)
    .reduce((content, item) => {
      const edit = item.candidate.edit!;
      return `${content.slice(0, edit.start)}${edit.replacement}${content.slice(edit.end)}`;
    }, beforeSnapshot);
  const changeSetId = `memory_change:${digest(`${run.id}\n${snapshot.sourceHash}\n${sourcePath}`).slice(0, 24)}`;
  let changeSet = await store.createMemoryChangeSet({
    kind: safe.every((item) => item.candidate.operationKind.startsWith("ARCHIVE_")) ? "ARCHIVE" : "EDIT",
    sourcePath,
    recordIds: [...new Set(safe.flatMap((item) => item.candidate.recordIds))],
    resolvesIssueIds: safe.map((item) => item.candidate.issue.id),
    expectedSourceHash: snapshot.sourceHash,
    beforeContentHash: digest(beforeSnapshot),
    afterContentHash: digest(afterSnapshot),
    beforeSnapshot,
    afterSnapshot,
    reason: "Deterministic memory consolidation repair approved by exact validators.",
    actorUserId
  }, input.traceId, { id: changeSetId });
  if (changeSet.status === "PROPOSED") {
    changeSet = await store.updateMemoryChangeSet(changeSet.id, { status: "APPROVED" });
  }
  if (!["APPROVED", "APPLYING", "APPLIED"].includes(changeSet.status)) {
    throw new Error(`Memory repair change set ${changeSet.id} cannot execute from ${changeSet.status}.`);
  }
  for (const item of safe) {
    if (item.operation.status === "PROPOSED") {
      await store.updateMemoryConsolidationOperation(item.operation.id, {
        status: "APPLYING",
        changeSetId: changeSet.id
      });
    }
  }
  return { run, changeSetId: changeSet.id };
}

export async function finalizeMemoryRepair(
  input: FinalizeMemoryRepairInput,
  options: Pick<ExecuteMemoryConsolidationOptions, "env" | "store"> = {}
): Promise<MemoryConsolidationRun> {
  const store = await resolveConsolidationStore(options);
  const run = await store.getMemoryConsolidationRun(input.runId);
  if (run.status === "SUCCEEDED") return run;
  if (run.status !== "RUNNING") throw new Error(`Memory consolidation ${run.id} cannot finalize from ${run.status}.`);
  const operations = await store.listMemoryConsolidationOperations(run.id, 500);
  const findings = await store.listMemoryConsolidationFindings(run.id, 500);
  const targeted = operations.filter((operation) => operation.changeSetId === input.changeSetId);
  const applied = input.mutationResult.status === "APPLIED";
  const failed = input.mutationResult.status === "FAILED";
  for (const operation of targeted) {
    if (operation.status !== "APPLYING") continue;
    if (applied) {
      await store.updateMemoryConsolidationOperation(operation.id, {
        status: "APPLIED",
        changeSetId: input.changeSetId
      });
      const finding = operation.findingId ? findings.find((item) => item.id === operation.findingId) : null;
      if (finding?.status === "OPEN") await store.updateMemoryConsolidationFinding(finding.id, { status: "APPLIED" });
    } else if (failed) {
      await store.updateMemoryConsolidationOperation(operation.id, {
        status: "FAILED",
        changeSetId: input.changeSetId,
        statusReason: input.mutationResult.reason ?? "The journaled mutation failed before commit."
      });
      const finding = operation.findingId ? findings.find((item) => item.id === operation.findingId) : null;
      if (finding?.status === "OPEN") await store.updateMemoryConsolidationFinding(finding.id, { status: "SKIPPED" });
    }
  }
  const finalOperations = await store.listMemoryConsolidationOperations(run.id, 500);
  const finalFindings = await store.listMemoryConsolidationFindings(run.id, 500);
  const terminalStatus = applied ? "SUCCEEDED" : "FAILED";
  return store.updateMemoryConsolidationRun(run.id, {
    status: terminalStatus,
    progressCompleted: finalFindings.length,
    progressTotal: finalFindings.length,
    findingCount: finalFindings.length,
    appliedOperationCount: finalOperations.filter((operation) => operation.status === "APPLIED").length,
    skippedOperationCount: finalOperations.filter((operation) => operation.status === "SKIPPED").length,
    failedOperationCount: finalOperations.filter((operation) => operation.status === "FAILED").length,
    metrics: {
      deterministicIssueCount: finalFindings.length,
      findingsCreated: finalFindings.length,
      operationsCreated: finalOperations.length
    },
    modelId: null,
    aiVerified: false,
    aiEvidence: {},
    statusReason: applied ? null : redactMemoryText(
      input.mutationResult.reason ?? `Repair requires operator review after ${input.mutationResult.status}.`
    ).slice(0, 2_000)
  });
}

function snapshotContentsMatch(left: MemoryGraphSnapshot, right: MemoryGraphSnapshot): boolean {
  const normalizedRight = memoryGraphSnapshotSchema.parse(right) as MemoryGraphSnapshot;
  const { generatedAt: _leftGeneratedAt, ...leftContents } = left;
  const { generatedAt: _rightGeneratedAt, ...rightContents } = normalizedRight;
  return JSON.stringify(leftContents) === JSON.stringify(rightContents);
}

function athensYearMonth(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATHENS_TIME_ZONE,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Unable to resolve the Athens calendar month.");
  return `${year}-${month}`;
}

async function listMonthlyMemoryPaths(memoryDir: string): Promise<string[]> {
  const entries = await readdir(memoryDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MONTHLY_MEMORY_PATTERN.test(entry.name))
    .map((entry) => join(memoryDir, entry.name))
    .sort();
}

export async function refreshAllMonthsMemoryGraphSnapshot(
  rawInput: MemoryMaintenanceInput,
  options: RefreshAllMonthsMemoryGraphSnapshotOptions = {}
): Promise<MemoryMaintenanceResult> {
  const input = memoryMaintenanceInputSchema.parse(rawInput);
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const indexPath = options.indexPath ?? DEFAULT_INDEX_PATH;
  const memoryDir = options.memoryDir ?? "/opt/spaceapp/docs";
  const rootDir = options.rootDir ?? process.env.SPACE_MEMORY_GRAPH_ROOT ?? DEFAULT_GRAPH_ROOT;
  const indexContent = await readFile(indexPath, "utf8");
  const monthlyPaths = await listMonthlyMemoryPaths(memoryDir);
  const monthlyContents = await Promise.all(monthlyPaths.map((path) => readFile(path, "utf8")));
  const sources: MemoryGraphSource[] = [
    { path: indexPath, kind: "INDEX", content: indexContent },
    ...monthlyPaths.map((path, index) => ({ path, kind: "MONTHLY" as const, content: monthlyContents[index]! }))
  ];
  const store = createMemoryGraphSnapshotStore({ rootDir, filename: ALL_MONTHS_SNAPSHOT_FILENAME });
  const previous = await store.read();
  const snapshot = buildMemoryGraphSnapshot({ sources, generatedAt, previousSnapshot: previous });
  const status = previous && snapshotContentsMatch(previous, snapshot) ? "UNCHANGED" : "REFRESHED";
  if (status === "REFRESHED") await store.write(snapshot);

  return memoryMaintenanceResultSchema.parse({
    status,
    generatedAt,
    sourceHash: snapshot.sourceHash,
    previousSourceHash: previous?.sourceHash ?? null,
    summary: snapshot.summary,
    durationMs: Math.max(0, Date.now() - startedAt)
  });
}

export async function refreshMemoryGraphSnapshot(
  rawInput: MemoryMaintenanceInput,
  options: RefreshMemoryGraphSnapshotOptions = {}
): Promise<MemoryMaintenanceResult> {
  const input = memoryMaintenanceInputSchema.parse(rawInput);
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const scheduledAt = new Date(input.scheduledAt);
  const indexPath = options.indexPath ?? DEFAULT_INDEX_PATH;
  const monthlyPath = options.monthlyPath ?? `/opt/spaceapp/docs/gemini_history_${athensYearMonth(scheduledAt)}.md`;
  const rootDir = options.rootDir ?? process.env.SPACE_MEMORY_GRAPH_ROOT ?? DEFAULT_GRAPH_ROOT;
  const [indexContent, monthlyContent] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(monthlyPath, "utf8")
  ]);
  const sources: MemoryGraphSource[] = [
    { path: indexPath, kind: "INDEX", content: indexContent },
    { path: monthlyPath, kind: "MONTHLY", content: monthlyContent }
  ];
  const cacheStore = await resolveCacheStore(options);
  const cacheRows = cacheStore
    ? await cacheStore.listMemoryEntries(
        { page: 1, pageSize: 100, sortOrder: "desc", searchMode: "keyword" },
        { limit: CACHE_BATCH_LIMIT }
      )
    : [];
  const cacheLinks = cacheStore && cacheRows.length > 0
    ? await cacheStore.listMemoryCacheLinks({ memoryRecordIds: cacheRows.map((row) => row.id), limit: CACHE_BATCH_LIMIT })
    : [];
  const linksByRecordId = new Map(cacheLinks.map((link) => [link.memoryRecordId, link]));
  const cacheRecords: MemoryGraphCacheRecord[] = cacheRows.map((row) => ({
    id: row.id,
    scope: row.scope,
    roomId: row.roomId,
    title: row.title,
    body: row.body,
    provenance: row.provenance,
    canonicalMemoryId: linksByRecordId.get(row.id)?.canonicalMemoryId ?? null
  }));
  const store = createMemoryGraphSnapshotStore({ rootDir });
  const previous = await store.read();
  const snapshot = buildMemoryGraphSnapshot({ sources, generatedAt, cacheRecords, previousSnapshot: previous });

  if (cacheStore) {
    for (const node of snapshot.nodes) {
      if (node.type !== "CACHE_RECORD" || !node.cacheRecordId || !node.recordId || linksByRecordId.has(node.cacheRecordId)) continue;
      await cacheStore.linkMemoryCacheRecord({
        memoryRecordId: node.cacheRecordId,
        canonicalMemoryId: node.recordId,
        linkSource: "EXACT_BACKFILL"
      });
    }
  }
  const status = previous && snapshotContentsMatch(previous, snapshot) ? "UNCHANGED" : "REFRESHED";

  if (status === "REFRESHED") await store.write(snapshot);

  return memoryMaintenanceResultSchema.parse({
    status,
    generatedAt,
    sourceHash: snapshot.sourceHash,
    previousSourceHash: previous?.sourceHash ?? null,
    summary: snapshot.summary,
    durationMs: Math.max(0, Date.now() - startedAt)
  });
}
