import { basename, dirname, join } from "node:path";

// Space Memory file names; @space/runtime (space-memory-files.ts) holds the full set.
// The legacy gemini_history files stay readable until they are renamed to space_memory.

/** A monthly Space Memory file; capture group 1 is the YYYY-MM month. */
export const MONTHLY_MEMORY_FILE_PATTERN = /^(?:space_memory|gemini_history)_(\d{4}-\d{2})\.md$/;

/** The month of a monthly memory file path, or null for any other source. */
export function monthOfMemoryFile(path: string): string | null {
  return MONTHLY_MEMORY_FILE_PATTERN.exec(basename(path))?.[1] ?? null;
}

/**
 * The legacy name of a renamed memory source. Record, section and source ids are hashed
 * from it, so ids derived from a path stay the same when the file is renamed.
 */
export function memorySourceIdentityPath(path: string): string {
  const name = basename(path);
  const legacy = name
    .replace(/^space_memory(_\d{4}-\d{2})?\.md$/, "gemini_history$1.md")
    .replace(/^space(_core(?:_[a-z_]+)?)?\.md$/, "gemini$1.md");
  return legacy === name ? path : join(dirname(path), legacy);
}
