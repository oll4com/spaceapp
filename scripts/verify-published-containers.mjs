#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isRegistrySafeReleaseVersion } from "./release-version.mjs";

const targets = ["core", "cli", "browser"];

const sbomPredicate = "https://spdx.dev/Document";
const provenancePredicate = "https://slsa.dev/provenance/v1";

export function evaluatePublishedContainer({ image, manifest, attestations }) {
  const blockers = [];
  const manifests = Array.isArray(manifest?.manifests) ? manifest.manifests : [];
  for (const architecture of ["amd64", "arm64"]) {
    const platformManifest = manifests.find(
      (entry) =>
        entry?.platform?.os === "linux" &&
        entry?.platform?.architecture === architecture
    );
    if (!platformManifest) {
      blockers.push(`${image} is missing linux/${architecture}.`);
      continue;
    }
    const matchingAttestations = (Array.isArray(attestations) ? attestations : []).filter(
      (entry) =>
        entry?.descriptor?.annotations?.["vnd.docker.reference.type"] ===
          "attestation-manifest" &&
        entry?.descriptor?.annotations?.["vnd.docker.reference.digest"] ===
          platformManifest.digest
    );
    const predicates = new Set(
      matchingAttestations
        .flatMap((attestation) =>
          Array.isArray(attestation?.manifest?.layers) ? attestation.manifest.layers : []
        )
        .map((layer) => layer?.annotations?.["in-toto.io/predicate-type"])
        .filter((value) => typeof value === "string")
    );
    if (!predicates.has(sbomPredicate)) {
      blockers.push(`${image} does not expose an SBOM for linux/${architecture}.`);
    }
    if (!predicates.has(provenancePredicate)) {
      blockers.push(`${image} does not expose provenance for linux/${architecture}.`);
    }
  }
  return { ok: blockers.length === 0, blockers };
}

function inspectRaw(image) {
  const result = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", image, "--raw"],
    {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || "unknown error";
    throw new Error(`Could not inspect ${image}: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Inspection of ${image} did not return valid JSON.`);
  }
}

export function loadPublishedContainerEvidence(image, inspect = inspectRaw) {
  const manifest = inspect(image);
  const repository = image.slice(0, image.lastIndexOf(":"));
  const attestationDescriptors = (
    Array.isArray(manifest?.manifests) ? manifest.manifests : []
  ).filter(
    (entry) =>
      entry?.platform?.os === "unknown" &&
      entry?.platform?.architecture === "unknown" &&
      entry?.annotations?.["vnd.docker.reference.type"] ===
        "attestation-manifest" &&
      typeof entry?.digest === "string"
  );
  return {
    manifest,
    attestations: attestationDescriptors.map((descriptor) => ({
      descriptor,
      manifest: inspect(`${repository}@${descriptor.digest}`)
    }))
  };
}

function parseArgs(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--version" ||
    !isRegistrySafeReleaseVersion(argv[1])
  ) {
    throw new Error(
      "Usage: verify-published-containers.mjs --version <semantic-version>"
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
      ...loadPublishedContainerEvidence(image)
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
