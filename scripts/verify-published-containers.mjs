#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { evaluateImageAttestations, loadImageAttestations } from "../packages/run-spaceapp/src/image-attestations.mjs";
import { isRegistrySafeReleaseVersion } from "./release-version.mjs";

// The release's check of its published images is the launcher's install-time check (image-attestations.mjs): each
// platform's SBOM, and provenance about that exact image from the release workflow on main; with --workflow-sha, built
// at that commit (the images this run built).
const targets = ["core", "cli", "browser"];
const architectures = ["amd64", "arm64"];
const usage = "Usage: verify-published-containers.mjs --version <semantic-version> [--targets core,cli,browser] [--architectures amd64,arm64] [--workflow-sha <commit>]";

function commaSeparatedValues(value, allowed, label) {
  const values = value.split(",").filter(Boolean);
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((entry) => !allowed.includes(entry))
  ) {
    throw new Error(
      `Invalid ${label}: ${value}.`
    );
  }
  return values;
}

function parseArgs(argv) {
  let version = "";
  let requestedTargets = targets;
  let requestedArchitectures = architectures;
  let workflowSha;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version" && argv[index + 1]) {
      version = argv[index + 1];
      index += 1;
    } else if (argument === "--targets" && argv[index + 1]) {
      requestedTargets = commaSeparatedValues(argv[index + 1], targets, "targets");
      index += 1;
    } else if (argument === "--architectures" && argv[index + 1]) {
      requestedArchitectures = commaSeparatedValues(
        argv[index + 1],
        architectures,
        "architectures"
      );
      index += 1;
    } else if (argument === "--workflow-sha" && /^[0-9a-f]{40}$/.test(argv[index + 1] ?? "")) {
      workflowSha = argv[index + 1];
      index += 1;
    } else {
      throw new Error(usage);
    }
  }
  if (!isRegistrySafeReleaseVersion(version)) throw new Error(usage);
  return {
    version,
    targets: requestedTargets,
    architectures: requestedArchitectures,
    workflowSha
  };
}

export async function runCli(argv, load = loadImageAttestations) {
  const { version, targets: requestedTargets, architectures: requestedArchitectures, workflowSha } = parseArgs(argv);
  const blockers = [];
  for (const target of requestedTargets) {
    const evidence = await load(`oll4com/spaceapp-${target}`, version);
    const result = evaluateImageAttestations({
      image: `ghcr.io/oll4com/spaceapp-${target}:${version}`,
      ...evidence,
      architectures: requestedArchitectures,
      workflowSha
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
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Container verification failed."}\n`
    );
    process.exitCode = 1;
  }
}
