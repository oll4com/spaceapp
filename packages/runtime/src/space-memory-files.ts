import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// Space Memory file names. The canonical files move from the legacy gemini_* names
// (gemini.md, gemini_core_*.md, gemini_history.md, gemini_history_YYYY-MM.md) to
// space.md, space_core_*.md, space_memory.md and space_memory_YYYY-MM.md. Readers accept
// both sets; writers follow the index file that exists, so only one set is ever written.
// The memory-graph parser keeps its own copy of the monthly pattern (packages/memory-graph/src/memory-files.ts).

export const SPACE_MEMORY_DIRECTORY = "/opt/spaceapp/docs";
export const SPACE_MEMORY_INDEX_FILENAME = "space_memory.md";
export const LEGACY_MEMORY_INDEX_FILENAME = "gemini_history.md";

/** A monthly Space Memory file; capture group 1 is the YYYY-MM month. */
export const MONTHLY_MEMORY_FILE_PATTERN = /^(?:space_memory|gemini_history)_(\d{4}-\d{2})\.md$/;
export const MEMORY_INDEX_FILE_PATTERN = /^(?:space_memory|gemini_history)\.md$/;
/** The agent core rules file every agent reads first: the root of the memory graph. */
export const MEMORY_CORE_FILE_PATTERN = /^(?:space|gemini)\.md$/;
/** Core and domain reference files that recall searches beside the monthly files. */
export const MEMORY_REFERENCE_FILE_PATTERN = /^(?:space|gemini|(?:space|gemini)_core(?:_[a-z_]+)?|agent_task_policies)\.md$/;

export const isMonthlyMemoryFile = (name: string) => MONTHLY_MEMORY_FILE_PATTERN.test(name);
export const isMemoryIndexFile = (name: string) => MEMORY_INDEX_FILE_PATTERN.test(name);
export const isMemoryCoreFile = (name: string) => MEMORY_CORE_FILE_PATTERN.test(name);

/** The month of a monthly memory file path, or null for any other source. */
export function monthOfMemoryFile(path: string): string | null {
  return MONTHLY_MEMORY_FILE_PATTERN.exec(basename(path))?.[1] ?? null;
}

/** True until the index has been renamed to space_memory.md. */
export function usesLegacyMemoryFiles(directory = SPACE_MEMORY_DIRECTORY): boolean {
  return !existsSync(join(directory, SPACE_MEMORY_INDEX_FILENAME));
}

/** The agent core rules file: space.md once renamed, gemini.md until then. */
export function spaceAgentCorePath(directory = SPACE_MEMORY_DIRECTORY): string {
  return join(directory, existsSync(join(directory, "space.md")) ? "space.md" : "gemini.md");
}

export function spaceMemoryIndexPath(directory = SPACE_MEMORY_DIRECTORY): string {
  return join(directory, usesLegacyMemoryFiles(directory) ? LEGACY_MEMORY_INDEX_FILENAME : SPACE_MEMORY_INDEX_FILENAME);
}

export function spaceMemoryMonthlyPath(month: string, directory = SPACE_MEMORY_DIRECTORY): string {
  return join(directory, `${usesLegacyMemoryFiles(directory) ? "gemini_history" : "space_memory"}_${month}.md`);
}
