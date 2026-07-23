#!/usr/bin/env node
import { chmod, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(scriptDir, "..", "dist");

async function chmodTree(path) {
  const entries = await readdir(path, { withFileTypes: true });
  await chmod(path, 0o755);

  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await chmodTree(entryPath);
      continue;
    }
    if (entry.isFile()) {
      await chmod(entryPath, 0o644);
    }
  }
}

await chmodTree(distDir);
