#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const targets = ["core", "cli", "browser"];
const stableVersionPattern = /^\d+\.\d+\.\d+$/;

export function evaluatePublishedContainer({ image, manifest, sbom, provenance }) {
  const blockers = [];
  const manifests = Array.isArray(manifest?.manifests) ? manifest.manifests : [];
  for (const architecture of ["amd64", "arm64"]) {
    const present = manifests.some(
      (entry) =>
        entry?.platform?.os === "linux" &&
        entry?.platform?.architecture === architecture
    );
    if (!present) blockers.push(`${image} is missing linux/${architecture}.`);
  }
  const attestationCount = manifests.filter(
    (entry) =>
      entry?.platform?.os === "unknown" &&
      entry?.platform?.architecture === "unknown"
  ).length;
  if (attestationCount < 2) {
    blockers.push(`${image} does not expose two platform attestations.`);
  }
  if (!sbom || (typeof sbom === "object" && Object.keys(sbom).length === 0)) {
    blockers.push(`${image} does not expose an SBOM.`);
  }
  if (
    !provenance ||
    (typeof provenance === "object" && Object.keys(provenance).length === 0)
  ) {
    blockers.push(`${image} does not expose provenance.`);
  }
  return { ok: blockers.length === 0, blockers };
}

function inspect(image, args) {
  const result = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", image, ...args],
    {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  if (result.status !== 0) {
    throw new Error(`Could not inspect ${image}.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Inspection of ${image} did not return valid JSON.`);
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--version" || !stableVersionPattern.test(argv[1])) {
    throw new Error(
      "Usage: verify-published-containers.mjs --version <major.minor.patch>"
    );
  }
  return argv[1];
}

export function runCli(argv) {
  const version = parseArgs(argv);
  const blockers = [];
  for (const target of targets) {
    const image = `ghcr.io/oll4com/spaceapp-${target}:${version}`;
    const result = evaluatePublishedContainer({
      image,
      manifest: inspect(image, ["--raw"]),
      sbom: inspect(image, ["--format", "{{json .SBOM}}"]),
      provenance: inspect(image, ["--format", "{{json .Provenance.SLSA}}"])
    });
    blockers.push(...result.blockers);
  }
  const result = { ok: blockers.length === 0, blockers };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Container verification failed."}\n`
    );
    process.exitCode = 1;
  }
}
