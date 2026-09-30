import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildMemoryGraphSnapshot } from "./parser.js";
import { createMemoryGraphSnapshotStore } from "./snapshot-store.js";
import type { MemoryGraphSnapshot, MemoryGraphSource } from "./types.js";

export const ALL_MONTHS_SNAPSHOT_FILENAME = "snapshot-all-months.json";
export const MONTHLY_MEMORY_FILE_PATTERN = /^gemini_history_(\d{4}-\d{2})\.md$/;

export async function listMonthlyMemorySourcePaths(memoryDir: string): Promise<string[]> {
  const entries = await readdir(memoryDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MONTHLY_MEMORY_FILE_PATTERN.test(entry.name))
    .map((entry) => join(memoryDir, entry.name))
    .sort();
}

export async function readMemoryGraphArchiveSources(input: {
  indexPath: string;
  memoryDir: string;
}): Promise<MemoryGraphSource[]> {
  const monthlyPaths = await listMonthlyMemorySourcePaths(input.memoryDir);
  const [indexContent, ...monthlyContents] = await Promise.all([
    readFile(input.indexPath, "utf8"),
    ...monthlyPaths.map((path) => readFile(path, "utf8"))
  ]);
  return [
    { path: input.indexPath, kind: "INDEX", content: indexContent },
    ...monthlyPaths.map((path, index) => ({ path, kind: "MONTHLY" as const, content: monthlyContents[index]! }))
  ];
}

// Building the all-months snapshot is expensive (every canonical source plus semantic analysis and
// layout), so it is only exposed as an explicit build step: the API delegates to the CLI in a child
// process and the memory maintenance worker runs the same builder in its own service.
export async function buildMemoryGraphArchiveSnapshot(input: {
  indexPath: string;
  memoryDir: string;
  rootDir: string;
  generatedAt: string;
  previousSnapshot?: MemoryGraphSnapshot | null;
  filename?: string;
}): Promise<MemoryGraphSnapshot> {
  const sources = await readMemoryGraphArchiveSources({ indexPath: input.indexPath, memoryDir: input.memoryDir });
  const store = createMemoryGraphSnapshotStore({
    rootDir: input.rootDir,
    filename: input.filename ?? ALL_MONTHS_SNAPSHOT_FILENAME
  });
  const previousSnapshot = input.previousSnapshot ?? await store.read();
  const snapshot = buildMemoryGraphSnapshot({
    sources,
    generatedAt: input.generatedAt,
    previousSnapshot
  });
  await store.write(snapshot);
  return snapshot;
}
