/**
 * Memory search status and the canonical Space Memory reference search shared by the memory routes and composition
 * (moved verbatim from the composition root).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  type ListMemoryQuery, type MemoryEmbeddingSmokeCheck, type MemoryEntry, memoryEntrySchema, type MemoryGraphSnapshot,
  type MemorySearchMode, type MemorySearchStatus, type MemoryVectorReadiness
} from "@space/contracts";
import { nowIso, redactMemoryText, spaceMemoryIndexPath, spaceMemoryMonthlyPath } from "@space/runtime";
import type { DecisionsService } from "./decisions-service.js";

export type SpaceMemorySearcher = (query: ListMemoryQuery) => Promise<MemoryEntry[]> | MemoryEntry[];

export function buildMemorySearchStatus(
  mode: MemorySearchMode,
  latestEmbeddingSmoke: MemoryEmbeddingSmokeCheck | null,
  vectorReadiness: MemoryVectorReadiness,
  spaceMemoryReferenceCount = 0
): MemorySearchStatus {
  const semanticReady = isSemanticMemoryReady(latestEmbeddingSmoke, vectorReadiness);
  const semanticStatus =
    semanticReady ? "VERIFIED" : vectorReadiness.status === "ERROR" || latestEmbeddingSmoke?.status === "ERROR" ? "ERROR" : "DISABLED";
  const semanticReason = latestEmbeddingSmoke
    ? `Vector ${vectorReadiness.code}; latest embedding smoke ${latestEmbeddingSmoke.code}: ${latestEmbeddingSmoke.message}`
    : `Vector ${vectorReadiness.code}: ${vectorReadiness.message}. Embedding provider smoke has not passed.`;
  return {
    mode,
    keyword: {
      status: "VERIFIED",
      statusReason:
        "Canonical Space Memory keyword search is active against redacted title, body and provenance fields." +
        (spaceMemoryReferenceCount > 0 ? ` Canonical Space Memory references included: ${spaceMemoryReferenceCount}.` : ""),
      checkedAt: null
    },
    semantic: {
      status: semanticStatus,
      statusReason: semanticReason,
      checkedAt: latestEmbeddingSmoke?.checkedAt ?? vectorReadiness.checkedAt
    }
  };
}

export function isSemanticMemoryReady(
  latestEmbeddingSmoke: MemoryEmbeddingSmokeCheck | null,
  vectorReadiness: MemoryVectorReadiness
): boolean {
  return (
    vectorReadiness.status === "VERIFIED" &&
    vectorReadiness.code === "MEMORY_VECTOR_READY" &&
    latestEmbeddingSmoke?.status === "VERIFIED" &&
    latestEmbeddingSmoke.code === "EMBEDDING_SMOKE_OK" &&
    latestEmbeddingSmoke.embeddingProviderReady === true
  );
}

function currentSpaceMemoryMonthlyPath(): string {
  return spaceMemoryMonthlyPath(nowIso().slice(0, 7));
}

function memoryReferenceMatchesQuery(text: string, query: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedText.includes(normalizedQuery)) return true;
  const terms = normalizedQuery.split(/\s+/).filter((term) => term.length >= 3);
  return terms.length > 0 && terms.every((term) => normalizedText.includes(term));
}

function projectMemoryGraphEntries(snapshot: MemoryGraphSnapshot, query: ListMemoryQuery): MemoryEntry[] {
  const entries = snapshot.records
    .filter((record) => record.lifecycleStatus === "ACTIVE")
    .filter((record) => !query.scope || record.scope === query.scope)
    .filter((record) => !query.roomId || record.roomId === query.roomId)
    .map((record) => memoryEntrySchema.parse({
      id: record.id,
      scope: record.scope,
      roomId: record.roomId,
      title: redactMemoryText(record.title).slice(0, 160),
      body: redactMemoryText(record.body).slice(0, 10000),
      provenance: redactMemoryText(record.provenance).slice(0, 500),
      createdAt: record.createdAt
    }))
    .filter((entry) => !query.q || memoryReferenceMatchesQuery(`${entry.title}\n${entry.body}\n${entry.provenance}`, query.q));
  const direction = query.sortOrder === "asc" ? 1 : -1;
  const sortBy = query.sortBy === "title" || query.sortBy === "provenance" || query.sortBy === "scope"
    ? query.sortBy
    : "createdAt";
  return entries.sort((left, right) => direction * (left[sortBy].localeCompare(right[sortBy]) || left.id.localeCompare(right.id)));
}

export async function searchDefaultSpaceMemory(query: ListMemoryQuery, decisionsService?: DecisionsService): Promise<MemoryEntry[]> {
  if (!query.q) return [];
  const paths = [spaceMemoryIndexPath(), currentSpaceMemoryMonthlyPath()];
  const candidates: Array<{ id: string; text: string; path: string; line: string }> = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const matchingLines = lines.filter((line) => memoryReferenceMatchesQuery(line, query.q ?? ""));
    for (const matchedLine of matchingLines.slice(0, 8)) {
      const hash = createHash("sha256").update(`${path}\n${query.q}\n${matchedLine}`).digest("hex").slice(0, 24);
      candidates.push({
        id: `space_memory:${hash}`,
        text: matchedLine,
        path,
        line: matchedLine
      });
    }
  }
  if (!candidates.length) return [];

  let selected = candidates;
  if (decisionsService && candidates.length > 2) {
    try {
      const rankedResult = await decisionsService.rankMemoryRelevance(query.q, candidates);
      const topIds = new Set(rankedResult.ranked.slice(0, 5).map((r) => r.id));
      selected = candidates.filter((c) => topIds.has(c.id));
    } catch {
      // fallback
    }
  }

  const entries: MemoryEntry[] = [];
  for (const item of selected.slice(0, 5)) {
    entries.push(
      memoryEntrySchema.parse({
        id: item.id,
        scope: "SYSTEM",
        roomId: null,
        title: redactMemoryText(`Space Memory reference: ${basename(item.path, ".md")}`).slice(0, 160),
        body: redactMemoryText(item.line).slice(0, 1000),
        provenance: item.path,
        createdAt: nowIso()
      })
    );
  }
  return entries;
}
