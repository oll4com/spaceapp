#!/usr/bin/env node
import { chmod, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const targets = [
  "apps/web/dist",
  "apps/api/dist",
  "apps/worker/dist",
  "packages/browser-host/dist",
  "packages/contracts/dist",
  "packages/codex-app-server/dist",
  "packages/runtime/dist",
  "packages/db/dist",
  "packages/db/migrations"
];

async function normalize(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  await chmod(path, 0o755).catch(() => {});
  for (const entry of entries) {
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory()) {
      await normalize(absolute);
      continue;
    }
    if (entry.isFile()) {
      await chmod(absolute, 0o644).catch(() => {});
    }
  }
}

await Promise.all(targets.map((target) => normalize(resolve(root, target))));
