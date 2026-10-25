#!/usr/bin/env node
// Release step between npm next and latest (review IR117-C-F7): the lab acceptance runs on the source candidate's
// local images, and the release workflow then builds the images it publishes. Installing the published package on each
// lab platform pulls the shipped bytes and records what the launcher verified (image-attestations.json in the
// installation's folder). This passes only when every platform's record covers exactly the published package's image
// lock; it lists the release runs and commits that built them.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { IMAGE_TARGETS, parseImageLock } from "../packages/run-spaceapp/src/image-lock.mjs";

export function evaluateShippedEvidence(lock, records) {
  const blockers = [];
  const runs = new Set();
  for (const [label, record] of Object.entries(records)) {
    const entry = record?.[lock.runtimeVersion];
    if (!entry) {
      blockers.push(`${label}: no verified install of runtime ${lock.runtimeVersion}.`);
      continue;
    }
    for (const target of IMAGE_TARGETS) {
      const image = entry.images?.[target];
      if (image?.index !== lock.images[target]) {
        blockers.push(`${label}: ${target} ran ${image?.index ?? "nothing verified"}, not the published ${lock.images[target]}.`);
        continue;
      }
      const platforms = Object.values(image.platforms ?? {});
      if (platforms.length === 0) blockers.push(`${label}: ${target} has no verified platform.`);
      for (const platform of platforms) runs.add(`${platform.runId}@${platform.workflowSha}`);
    }
  }
  if (Object.keys(records).length === 0) blockers.push("No platform evidence was given.");
  return { ok: blockers.length === 0, blockers, runtimeVersion: lock.runtimeVersion, runs: [...runs].sort() };
}

export async function runCli(argv) {
  const [flag, lockPath, ...evidence] = argv;
  if (flag !== "--lock" || !lockPath || evidence.length === 0 || evidence.some((argument) => !/^[a-z0-9-]+=.+/.test(argument))) {
    throw new Error("Usage: shipped-image-evidence.mjs --lock <published images.lock.json> <platform>=<image-attestations.json>...");
  }
  const lock = parseImageLock(await readFile(lockPath, "utf8"));
  const records = {};
  for (const argument of evidence) {
    const [label, path] = [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)];
    records[label] = JSON.parse(await readFile(path, "utf8"));
  }
  const result = evaluateShippedEvidence(lock, records);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
