#!/usr/bin/env node
import { chmod, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const observedStart = performance.now();
let directoryAttempts = 0, fileAttempts = 0;
console.log(JSON.stringify({ schema: "spaceapp.build-permissions-step.v1", stage: "web-dist", event: "START" }));

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(scriptDir, "..", "dist");

async function chmodTree(path) {
  const entries = await readdir(path, { withFileTypes: true });
  directoryAttempts += 1;
  await chmod(path, 0o755);

  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await chmodTree(entryPath);
      continue;
    }
    if (entry.isFile()) {
      fileAttempts += 1;
      await chmod(entryPath, 0o644);
    }
  }
}

await chmodTree(distDir);
console.log(JSON.stringify({ schema: "spaceapp.build-permissions-step.v1", stage: "web-dist", event: "DONE",
  elapsedMs: Math.max(0, Math.round(performance.now() - observedStart)), directoryAttempts, fileAttempts }));
