import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import {
  createImportCandidateInputSchema, createMemoryEntryInputSchema, createSkillProposalInputSchema,
  importCandidateDecisionInputSchema, importCandidateDecisionResultSchema, listImportCandidatesQuerySchema,
  listMemoryQuerySchema, type MemoryEntry
} from "@space/contracts";
import {
  type CanonicalMemoryBridge, type SpaceEventBus, SpaceFeatureDisabledError, type SpaceStore
} from "@space/runtime";
import type { DotMemoryEmbeddings } from "@space/db";
import type { CanonicalMemorySearch } from "./canonical-memory-search.js";
import { sendApiError } from "./http-errors.js";
import type { MemoryEmbeddingBackfill } from "./memory-embedding-backfill.js";
import type { SpaceApiConfig } from "./config.js";
import type { MemoryGraphApiService } from "./memory-graph-service.js";
import { buildMemorySearchStatus, isSemanticMemoryReady } from "./memory-search.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";

/**
 * Skills, import candidates and memory entries (search and writes); the parent retains authentication, CSRF, errors
 * and rate limits.
 */
export function registerMemoryRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  memoryEmbeddingGenerator: (input: string, purpose?: "document" | "query") => Promise<number[]>;
  canonicalMemory: CanonicalMemoryBridge;
  canonicalSearch: CanonicalMemorySearch | null;
  memoryGraphService: MemoryGraphApiService;
  memoryEmbeddingBackfill?: MemoryEmbeddingBackfill | null;
  dotMemoryEmbeddings?: DotMemoryEmbeddings | null;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { config, store, eventBus, memoryEmbeddingGenerator, canonicalMemory, canonicalSearch, memoryGraphService,
    routeOptions: defaultRouteRateLimitOptions } = options;
  // Space Memory embeddings at a glance (counts and model names only, never memory text): what the backfill still has to do.
  app.get("/api/admin/memory/embedding-status", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Memory embedding status requires the ADMIN role.");
    const [smoke, records, dotMemories, canonical] = await Promise.all([
      store.getLatestMemoryEmbeddingSmoke(),
      store.countMemoryRecordEmbeddings(),
      options.dotMemoryEmbeddings?.countEmbeddings() ?? null,
      canonicalSearch?.coverage().catch(() => null) ?? null
    ]);
    return {
      provider: config.memoryEmbeddingProvider, model: config.memoryEmbeddingModel, dimensions: config.memoryEmbeddingDimensions,
      smoke: smoke ? { status: smoke.status, code: smoke.code, checkedAt: smoke.checkedAt } : null,
      memoryRecords: records, dotMemories, canonical, backfill: options.memoryEmbeddingBackfill?.state() ?? null
    };
  });
  app.get("/api/skills", defaultRouteRateLimitOptions, async () => {
    const skills = await store.listSkills();
    return { data: skills, pagination: { page: 1, pageSize: 100, totalItems: skills.length, totalPages: skills.length ? 1 : 0 } };
  });
  app.post("/api/skills", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(createSkillProposalInputSchema, request.body);
    const record = await store.createSkillProposal(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(store, request, {
      action: "skill.propose",
      targetType: "skill",
      targetId: record.skill.id,
      metadata: {
        displayName: record.skill.displayName,
        version: record.skill.version,
        status: record.skill.status,
        contentHash: record.skill.contentHash,
        allowedToolCount: record.skill.allowedTools.length
      }
    });
    return record.skill;
  });
  app.get("/api/imports", defaultRouteRateLimitOptions, async (request) => {
    const page = parseQuery(listImportCandidatesQuerySchema, request.query);
    const candidates = await store.listImportCandidates(page);
    const start = (page.page - 1) * page.pageSize;
    return {
      data: candidates.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: candidates.length,
        totalPages: Math.ceil(candidates.length / page.pageSize)
      }
    };
  });
  app.post("/api/imports", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(createImportCandidateInputSchema, request.body);
    const record = await store.createImportCandidate(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(store, request, {
      action: "import.candidate.create",
      targetType: "import_candidate",
      targetId: record.candidate.id,
      metadata: {
        sourceKind: record.candidate.sourceKind,
        targetKind: record.candidate.targetKind,
        status: record.candidate.status,
        sourceRef: record.candidate.sourceRef
      }
    });
    return record.candidate;
  });
  app.post("/api/imports/:id/decision", defaultRouteRateLimitOptions, async (request) => {
    const params = request.params as { id: string };
    const input = parseBody(importCandidateDecisionInputSchema, request.body);
    const record = await store.decideImportCandidate(params.id, input, request.requestIdForSpace);
    for (const event of record.events) {
      eventBus.publish(event);
    }
    await recordAudit(store, request, {
      action: "import.candidate.decide",
      targetType: "import_candidate",
      targetId: record.candidate.id,
      metadata: {
        decision: input.decision,
        status: record.candidate.status,
        targetKind: record.candidate.targetKind,
        importedMemoryId: record.candidate.importedMemoryId,
        importedSkillId: record.candidate.importedSkillId
      }
    });
    return importCandidateDecisionResultSchema.parse({
      candidate: record.candidate,
      memoryEntry: record.memoryEntry,
      skill: record.skill
    });
  });
  app.get("/api/memory", defaultRouteRateLimitOptions, async (request) => {
    const page = parseQuery(listMemoryQuerySchema, request.query);
    const [latestEmbeddingSmoke, vectorReadiness] = await Promise.all([
      store.getLatestMemoryEmbeddingSmoke(),
      store.getMemoryVectorReadiness(config.memoryEmbeddingDimensions)
    ]);
    const semanticReady = isSemanticMemoryReady(latestEmbeddingSmoke, vectorReadiness);
    let queryEmbedding: number[] | undefined;
    if (page.searchMode === "semantic") {
      if (!semanticReady) {
        throw new SpaceFeatureDisabledError(
          "MEMORY_SEMANTIC_DISABLED",
          "Semantic memory search is disabled until vector storage and embedding provider smoke are verified.",
          {
            vectorReadinessCode: vectorReadiness.code,
            embeddingSmokeCode: latestEmbeddingSmoke?.code ?? null
          }
        );
      }
      try {
        queryEmbedding = await memoryEmbeddingGenerator(page.q ?? "", "query");
      } catch {
        throw new SpaceFeatureDisabledError(
          "MEMORY_SEMANTIC_UNAVAILABLE",
          "Semantic memory search could not generate a query embedding.",
          {
            vectorReadinessCode: vectorReadiness.code,
            embeddingSmokeCode: latestEmbeddingSmoke?.code ?? null
          }
        );
      }
    }
    // Canonical retrieval is shared with native agents and checks source fingerprints.
    // The graph is a visualization projection, never the authority for search freshness.
    const entries = page.searchMode === "semantic"
      ? canonicalSearch
        ? await canonicalSearch.search(page, queryEmbedding!)
        : await store.listMemoryEntries(page, { semanticReady, queryEmbedding, embeddingModel: config.memoryEmbeddingModel ?? undefined })
      : await canonicalMemory.list(page);
    const geminiEntries: MemoryEntry[] = [];
    const entriesById = new Map<string, MemoryEntry>();
    for (const entry of [...entries, ...geminiEntries]) {
      if (!entriesById.has(entry.id)) entriesById.set(entry.id, entry);
    }
    const mergedEntries = [...entriesById.values()];
    const search = buildMemorySearchStatus(page.searchMode, latestEmbeddingSmoke, vectorReadiness, geminiEntries.length);
    if (canonicalSearch) {
      try {
        const coverage = await canonicalSearch.coverage();
        search.semantic.statusReason = `Canonical coverage: ${coverage.indexed}/${coverage.total}. ${coverage.error ?? search.semantic.statusReason}`.slice(0, 500);
      } catch {
        search.semantic.status = "ERROR";
        search.semantic.statusReason = "Canonical embedding coverage is unavailable; keyword search remains active.";
      }
    }
    const start = (page.page - 1) * page.pageSize;
    return {
      data: mergedEntries.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: mergedEntries.length,
        totalPages: Math.ceil(mergedEntries.length / page.pageSize)
      },
      search
    };
  });
  app.post("/api/memory", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(createMemoryEntryInputSchema, request.body);
    const entry = await canonicalMemory.save(input, request.requestIdForSpace);
    await memoryGraphService.invalidateCachedSnapshot();
    const [latestEmbeddingSmoke, vectorReadiness] = await Promise.all([
      store.getLatestMemoryEmbeddingSmoke(),
      store.getMemoryVectorReadiness(config.memoryEmbeddingDimensions)
    ]);
    let cacheEntry: MemoryEntry | null = null;
    try {
      // A rate-limited or failing provider never costs the save: the row is kept without a vector and the backfill embeds it later.
      const embedding = isSemanticMemoryReady(latestEmbeddingSmoke, vectorReadiness)
        ? await memoryEmbeddingGenerator(`${input.title}\n${input.body}`, "document").catch(() => undefined)
        : undefined;
      const cached = await store.createMemoryEntry(input, request.requestIdForSpace, { embedding, embeddingModel: config.memoryEmbeddingModel ?? undefined });
      await store.linkMemoryCacheRecord({
        memoryRecordId: cached.entry.id,
        canonicalMemoryId: entry.id,
        linkSource: "CANONICAL_SAVE"
      });
      cacheEntry = cached.entry;
      eventBus.publish(cached.event);
    } catch {
      cacheEntry = null;
    }
    await recordAudit(store, request, {
      action: "memory.save",
      targetType: "memory",
      targetId: entry.id,
      metadata: {
        scope: entry.scope,
        roomId: entry.roomId,
        title: entry.title,
        provenance: entry.provenance,
        canonical: true,
        cacheMemoryId: cacheEntry?.id ?? null,
        originalScope: input.scope,
        originalRoomId: input.roomId ?? null
      }
    });
    return entry;
  });
}
