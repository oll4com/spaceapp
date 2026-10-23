import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveWorkflowPath(relativePath: string): string {
  const tsPath = fileURLToPath(new URL(`../${relativePath}.ts`, import.meta.url));
  if (existsSync(tsPath)) return tsPath;
  return fileURLToPath(new URL(`../${relativePath}.js`, import.meta.url));
}
