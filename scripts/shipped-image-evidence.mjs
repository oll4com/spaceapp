#!/usr/bin/env node
// Release step between npm next and latest (review IR117-C-F7): the lab acceptance runs on the source candidate's
// local images, and the release workflow then builds the images it publishes. Installing the published package on each
// lab platform pulls the shipped bytes and records what the launcher verified (image-attestations.json in the
// installation's folder). This passes only when every platform's record covers exactly the published package's image
// lock; it lists the release runs and commits that built them. The launcher writes that record when it configures an
// installation, before any image is pulled or started, so it proves the check, not the install: each platform also gives
// `docker inspect` of its running containers, and every advertised platform must be there (1.1.9 in-app review, Codex #5).
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { IMAGE_TARGETS, parseImageLock } from "../packages/run-spaceapp/src/image-lock.mjs";

export const REQUIRED_PLATFORMS = ["linux", "windows", "macos"];
const imageRef = (lock, target) => `ghcr.io/oll4com/spaceapp-${target}:${lock.runtimeVersion}@${lock.images[target]}`;

export function evaluateShippedEvidence(lock, records, running = {}) {
  const blockers = [];
  const runs = new Set();
  for (const label of REQUIRED_PLATFORMS) {
    if (!records[label]) blockers.push(`${label}: no install evidence (image-attestations.json).`);
  }
  for (const label of new Set([...REQUIRED_PLATFORMS, ...Object.keys(records), ...Object.keys(running)])) {
    const containers = running[label];
    if (!Array.isArray(containers)) {
      blockers.push(`${label}: no running-image evidence (docker inspect of its running containers).`);
      continue;
    }
    for (const target of IMAGE_TARGETS) {
      if (!containers.some((container) => container?.State?.Running === true && container?.Config?.Image === imageRef(lock, target))) {
        blockers.push(`${label}: no running ${target} container from ${imageRef(lock, target)}.`);
      }
    }
  }
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
  return { ok: blockers.length === 0, blockers, runtimeVersion: lock.runtimeVersion, runs: [...runs].sort() };
}

export async function runCli(argv) {
  const [flag, lockPath, ...evidence] = argv;
  const usage = "Usage: shipped-image-evidence.mjs --lock <published images.lock.json> <platform>=<image-attestations.json>... --running <platform>=<docker inspect of its running containers>...";
  if (flag !== "--lock" || !lockPath || evidence.length === 0) throw new Error(usage);
  const lock = parseImageLock(await readFile(lockPath, "utf8"));
  const records = {};
  const running = {};
  for (let index = 0; index < evidence.length; index += 1) {
    const into = evidence[index] === "--running" ? running : records;
    const argument = into === running ? evidence[++index] : evidence[index];
    if (!/^[a-z0-9-]+=.+/.test(argument ?? "")) throw new Error(usage);
    const [label, path] = [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)];
    into[label] = JSON.parse(await readFile(path, "utf8"));
  }
  const result = evaluateShippedEvidence(lock, records, running);
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
