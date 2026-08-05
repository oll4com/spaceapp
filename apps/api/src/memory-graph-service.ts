import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MemoryGraphSnapshot, MemoryGraphSource } from "@space/memory-graph";

export interface MemoryGraphApiService {
  getSnapshot(): Promise<{ snapshot: MemoryGraphSnapshot; isStale: boolean }>;
  getCachedSnapshot(): Promise<MemoryGraphSnapshot | null>;
  getArchiveSnapshot(): Promise<MemoryGraphSnapshot>;
  listAvailableMonths(): Promise<string[]>;
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
  let archiveSnapshot: MemoryGraphSnapshot | null = null;
  let archiveBuild: Promise<MemoryGraphSnapshot> | null = null;
  const memoryDir = dirname(options.indexPath);
  const monthlyMemoryPattern = /^gemini_history_(\d{4}-\d{2})\.md$/;

  const loadGraphModule = () => {
    graphModule ??= import("@space/memory-graph");
    return graphModule;
  };
  const listMonthlyPaths = async (): Promise<string[]> => {
    const entries = await readdir(memoryDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && monthlyMemoryPattern.test(entry.name))
      .map((entry) => join(memoryDir, entry.name))
      .sort();
  };
  const readArchiveSources = async (): Promise<MemoryGraphSource[]> => {
    const monthlyPaths = await listMonthlyPaths();
    const [indexContent, ...monthlyContents] = await Promise.all([
      readFile(options.indexPath, "utf8"),
      ...monthlyPaths.map((path) => readFile(path, "utf8"))
    ]);
    return [
      { path: options.indexPath, kind: "INDEX", content: indexContent },
      ...monthlyPaths.map((path, index) => ({ path, kind: "MONTHLY" as const, content: monthlyContents[index]! }))
    ];
  };
  const buildAndPersistArchiveSnapshot = async (
    previousSnapshot: MemoryGraphSnapshot | null
  ): Promise<MemoryGraphSnapshot> => {
    const graph = await loadGraphModule();
    const store = graph.createMemoryGraphSnapshotStore({
      rootDir: options.rootDir,
      filename: graph.ALL_MONTHS_SNAPSHOT_FILENAME
    });
    const built = graph.buildMemoryGraphSnapshot({
      sources: await readArchiveSources(),
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      previousSnapshot
    });
    await store.write(built);
    return built;
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
    async getArchiveSnapshot() {
      if (archiveSnapshot) return archiveSnapshot;
      const graph = await loadGraphModule();
      const store = graph.createMemoryGraphSnapshotStore({
        rootDir: options.rootDir,
        filename: graph.ALL_MONTHS_SNAPSHOT_FILENAME
      });
      const persisted = await store.read();
      if (persisted && isCurrentSnapshot(persisted)) {
        archiveSnapshot = persisted;
        return archiveSnapshot;
      }
      archiveBuild ??= buildAndPersistArchiveSnapshot(persisted);
      archiveSnapshot = await archiveBuild;
      return archiveSnapshot;
    },
    async listAvailableMonths() {
      const paths = await listMonthlyPaths();
      return paths
        .map((path) => monthlyMemoryPattern.exec(basename(path))?.[1])
        .filter((month): month is string => Boolean(month));
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
