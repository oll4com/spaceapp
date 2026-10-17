import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolves the path to the workflow OTLP interceptors module so Temporal's
 * workflow bundler can load it in both compiled (`dist/*.js`) and source
 * (`src/*.ts`) execution modes.
 */
export function resolveWorkflowInterceptorsPath(): string {
  const jsPath = fileURLToPath(new URL("./otlp-workflow-interceptors.js", import.meta.url));
  const tsPath = fileURLToPath(new URL("./otlp-workflow-interceptors.ts", import.meta.url));
  return existsSync(jsPath) ? jsPath : tsPath;
}
