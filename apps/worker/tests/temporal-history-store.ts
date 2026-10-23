import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const historyDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/workflow-histories");
export interface RecordedHistory { name: string; workflowId: string; history: unknown }
interface ReplayResult { error?: Error; fixture?: string }

export async function loadHistories(directory = historyDirectory, allowEmpty = false): Promise<RecordedHistory[]> {
  let files: string[];
  try { files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort(); }
  catch (error) {
    if (!allowEmpty || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  if (!files.length && !allowEmpty) throw new Error("No recorded histories: replay must never silently pass without fixtures");
  return Promise.all(files.map(async file => ({ name: file.slice(0, -5), ...JSON.parse(await readFile(resolve(directory, file), "utf8")) })));
}

// Preparation is awaited before any scenarios run or any fixture can be written.
export async function createHistoryRecorder(options: {
  directory?: string;
  version?: string;
  replay: (histories: RecordedHistory[]) => Promise<ReplayResult[]>;
}) {
  const directory = options.directory ?? historyDirectory;
  const version = options.version;
  if (version !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(version)) {
    throw new Error("History version must contain lowercase letters, digits and single hyphens");
  }
  const baseline = await loadHistories(directory, true);
  if (baseline.length) {
    if (!version) throw new Error("Existing histories are immutable; use --version <new-patched-version> to add fixtures");
    const results = await options.replay(baseline);
    if (results.length !== baseline.length) throw new Error("Existing history replay did not return every result; nothing recorded");
    for (const result of results) {
      if (result.error) throw new Error(`Existing history replay failed (${result.fixture ?? "unknown fixture"}): ${result.error.message}; nothing recorded`);
    }
    console.info(`Replayed ${baseline.length} existing histories successfully before recording any additions.`);
  }
  return async (histories: RecordedHistory[]) => {
    const paths = new Set<string>();
    const writes = histories.map(entry => {
      if (!/^[a-z0-9-]+$/.test(entry.name)) throw new Error(`Unsafe fixture name ${entry.name}`);
      const name = version ? `${entry.name}--${version}` : entry.name;
      const path = resolve(directory, `${name}.json`);
      if (paths.has(path)) throw new Error(`Duplicate fixture name ${name}`);
      paths.add(path);
      return { path, contents: JSON.stringify({ workflowId: entry.workflowId, history: entry.history }, null, 2) + "\n" };
    });
    // Reject a batch collision before writing any member. Exclusive creation also
    // protects originals if a file appears after this preflight.
    for (const { path } of writes) {
      try { await access(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`Refusing to replace existing history ${path}`);
    }
    await mkdir(directory, { recursive: true });
    for (const { path, contents } of writes) await writeFile(path, contents, { flag: "wx" });
  };
}
