import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryGraphSnapshot, MemoryGraphSource } from "@space/memory-graph";

export interface MemoryGraphApiService {
  getSnapshot(): Promise<{ snapshot: MemoryGraphSnapshot; isStale: boolean }>;
  getCachedSnapshot(): Promise<MemoryGraphSnapshot | null>;
  getArchiveSnapshot(): Promise<MemoryGraphSnapshot>;
  getArchiveSnapshotState?(): Promise<{ snapshot: MemoryGraphSnapshot; isStale: boolean }>;
  listAvailableMonths(): Promise<string[]>;
  getSourceContent(sourcePath: string): Promise<string>;
  invalidateCachedSnapshot(): Promise<void>;
}

interface CreateMemoryGraphServiceOptions {
  rootDir: string;
  indexPath: string;
  monthlyPath: string;
  now?: () => Date;
  buildArchiveSnapshot?: (input: { previousSnapshot: MemoryGraphSnapshot | null }) => Promise<MemoryGraphSnapshot>;
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
    if (options.buildArchiveSnapshot) {
      const built = await options.buildArchiveSnapshot({ previousSnapshot });
      await store.write(built);
      return built;
    }
    return buildArchiveSnapshotOutOfProcess(graph.ALL_MONTHS_SNAPSHOT_FILENAME);
  };
  // The all-months build walks every canonical source and can take minutes, so it must never run on
  // the API event loop: the build runs in a child process and the request only waits for its result.
  const buildArchiveSnapshotOutOfProcess = async (filename: string): Promise<MemoryGraphSnapshot> => {
    const graph = await loadGraphModule();
    const cli = fileURLToPath(new URL("./archive-build-cli.js", import.meta.resolve("@space/memory-graph")));
    const status = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        "--memory-dir", memoryDir,
        "--index", options.indexPath,
        "--root", options.rootDir,
        "--filename", filename,
        "--generated-at", (options.now?.() ?? new Date()).toISOString()
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve(0);
        else reject(new Error(stderr.trim() || `Memory archive build exited with code ${code ?? "null"}.`));
      });
    });
    if (status !== 0) throw new Error("Memory archive build failed.");
    const built = await graph.createMemoryGraphSnapshotStore({
      rootDir: options.rootDir,
      filename
    }).read();
    if (!built || !isCurrentSnapshot(built)) throw new Error("Memory archive snapshot is unavailable after its build.");
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
      if (invalidatedSourceHash === "*" || persisted?.sourceHash === invalidatedSourceHash || !isCurrentSnapshot(persisted)) return null;
      return graph.calculateMemoryGraphSourceHash(await readSources()) === persisted.sourceHash ? persisted : null;
    },
    async getArchiveSnapshot() {
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
      // An unusable persisted archive snapshot must not rebuild on every request: serve the last
      // good in-memory build while a single shared build finishes out of process.
      if (isCurrentSnapshot(archiveSnapshot)) return archiveSnapshot;
      archiveBuild ??= buildAndPersistArchiveSnapshot(persisted).finally(() => { archiveBuild = null; });
      archiveSnapshot = await archiveBuild;
      return archiveSnapshot;
    },
    async getArchiveSnapshotState() {
      const snapshot = await this.getArchiveSnapshot();
      const graph = await loadGraphModule();
      return { snapshot, isStale: graph.calculateMemoryGraphSourceHash(await readArchiveSources()) !== snapshot.sourceHash };
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
      archiveSnapshot = null;
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
        initialLoad ??= buildAndPersistSnapshot(sources, persisted).finally(() => { initialLoad = null; });
        snapshot = await initialLoad;
      }
      return {
        snapshot,
        isStale: graph.calculateMemoryGraphSourceHash(sources) !== snapshot.sourceHash
      };
    }
  };
}
