#!/usr/bin/env node
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const temporalPlatformByDockerArch = Object.freeze({
  amd64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu"
});

export function pruneForeignTemporalBinaries(root, dockerArch) {
  const keep = temporalPlatformByDockerArch[dockerArch];
  if (!keep) throw new Error(`Unsupported Docker architecture: ${dockerArch}`);

  const releases = path.join(root, "node_modules", "@temporalio", "core-bridge", "releases");
  if (!existsSync(releases)) return [];

  const removed = [];
  for (const name of readdirSync(releases).sort()) {
    if (name === keep) continue;
    rmSync(path.join(releases, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const dockerArch = process.argv[2];
    if (!dockerArch) throw new Error("Usage: container-prune-platform-binaries.mjs <amd64|arm64> [node_modules-root]");
    const root = process.argv[3] ? path.resolve(process.argv[3]) : repositoryRoot;
    const removed = pruneForeignTemporalBinaries(root, dockerArch);
    process.stdout.write(`Kept ${temporalPlatformByDockerArch[dockerArch]}; removed ${removed.length} foreign Temporal binaries.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
