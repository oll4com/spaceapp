#!/usr/bin/env node
import { chmod, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const observedStart = performance.now();
let directoryAttempts = 0, fileAttempts = 0;
console.log(JSON.stringify({ schema: "spaceapp.build-permissions-step.v1", stage: "root-build", event: "START" }));

const root = resolve(new URL("..", import.meta.url).pathname);
const targets = [
  "apps/web/dist",
  "apps/api/dist",
  "apps/worker/dist",
  "packages/browser-host/dist",
  "packages/contracts/dist",
  "packages/memory-graph/dist",
  "packages/codex-app-server/dist",
  "packages/runtime/dist",
  "packages/db/dist",
  "packages/gateway/dist",
  "packages/db/migrations"
];

async function normalize(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  directoryAttempts += 1;
  await chmod(path, 0o755).catch(() => {});
  for (const entry of entries) {
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory()) {
      await normalize(absolute);
      continue;
    }
    if (entry.isFile()) {
      fileAttempts += 1;
      await chmod(absolute, 0o644).catch(() => {});
    }
  }
}

await Promise.all(targets.map((target) => normalize(resolve(root, target))));
await chmod(resolve(root, "var/worktrees"), 0o2775).catch(() => {});
console.log(JSON.stringify({ schema: "spaceapp.build-permissions-step.v1", stage: "root-build", event: "DONE",
  elapsedMs: Math.max(0, Math.round(performance.now() - observedStart)), directoryAttempts, fileAttempts }));
