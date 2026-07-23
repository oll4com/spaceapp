import { readFile } from "node:fs/promises";
import type { MemoryGraphSnapshot, MemoryGraphSource } from "@space/memory-graph";

export interface MemoryGraphApiService {
  getSnapshot(): Promise<{ snapshot: MemoryGraphSnapshot; isStale: boolean }>;
  getCachedSnapshot(): Promise<MemoryGraphSnapshot | null>;
  getSourceContent(sourcePath: string): Promise<string>;
  invalidateCachedSnapshot(): Promise<void>;
}

interface CreateMemoryGraphServiceOptions {
  rootDir: string;
  indexPath: string;
  monthlyPath: string;
  now?: () => Date;
}

function isCurrentSnapshot(snapshot: MemoryGraphSnapshot | null): snapshot is MemoryGraphSnapshot {
  return Boolean(
    snapshot &&
    snapshot.version === 2 &&
    snapshot.layoutVersion === 2 &&
    snapshot.taxonomyVersion === 2 &&
    /^[a-f0-9]{64}$/.test(snapshot.revisionHash ?? "") &&
    snapshot.nodes.every((node) => node.position !== undefined)
  );
}

export function createMemoryGraphService(options: CreateMemoryGraphServiceOptions): MemoryGraphApiService {
  let snapshot: MemoryGraphSnapshot | null = null;
  let initialLoad: Promise<MemoryGraphSnapshot> | null = null;
  let graphModule: Promise<typeof import("@space/memory-graph")> | null = null;
  let invalidatedSourceHash: string | null = null;

  const loadGraphModule = () => {
    graphModule ??= import("@space/memory-graph");
    return graphModule;
  };
  const readSources = async (): Promise<MemoryGraphSource[]> => [
    { path: options.indexPath, kind: "INDEX", content: await readFile(options.indexPath, "utf8") },
    { path: options.monthlyPath, kind: "MONTHLY", content: await readFile(options.monthlyPath, "utf8") }
  ];
  const buildAndPersistSnapshot = async (
    sources: MemoryGraphSource[],
    previousSnapshot: MemoryGraphSnapshot | null
  ): Promise<MemoryGraphSnapshot> => {
    const graph = await loadGraphModule();
    const store = graph.createMemoryGraphSnapshotStore({ rootDir: options.rootDir });
    const built = graph.buildMemoryGraphSnapshot({
      sources,
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      previousSnapshot
    });
    await store.write(built);
    invalidatedSourceHash = null;
    return built;
  };

  return {
    async getSourceContent(sourcePath) {
      if (sourcePath !== options.indexPath && sourcePath !== options.monthlyPath) {
        throw new Error("Canonical memory source is outside the configured source allowlist.");
      }
      return readFile(sourcePath, "utf8");
    },
    async getCachedSnapshot() {
      const graph = await loadGraphModule();
      const persisted = await graph.createMemoryGraphSnapshotStore({ rootDir: options.rootDir }).read();
      return invalidatedSourceHash === "*" || persisted?.sourceHash === invalidatedSourceHash || !isCurrentSnapshot(persisted)
        ? null
        : persisted;
    },
    async invalidateCachedSnapshot() {
      const graph = await loadGraphModule();
      const store = graph.createMemoryGraphSnapshotStore({ rootDir: options.rootDir });
      snapshot = null;
      initialLoad = null;
      try {
        const persisted = await store.read();
        invalidatedSourceHash = persisted?.sourceHash ?? invalidatedSourceHash;
        await store.invalidate();
      } catch (error) {
        invalidatedSourceHash = "*";
        throw error;
      }
    },
    async getSnapshot() {
      const graph = await loadGraphModule();
      const persisted = await graph.createMemoryGraphSnapshotStore({ rootDir: options.rootDir }).read();
      const sources = await readSources();
      if (isCurrentSnapshot(persisted) && invalidatedSourceHash !== "*" && persisted.sourceHash !== invalidatedSourceHash) {
        snapshot = persisted;
      } else if (!isCurrentSnapshot(snapshot)) {
        initialLoad ??= buildAndPersistSnapshot(sources, persisted);
        snapshot = await initialLoad;
      }
      return {
        snapshot,
        isStale: graph.calculateMemoryGraphSourceHash(sources) !== snapshot.sourceHash
      };
    }
  };
}
