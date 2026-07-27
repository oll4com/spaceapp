#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isRegistrySafeReleaseVersion } from "./release-version.mjs";

const targets = ["core", "cli", "browser"];

function isNpmNotFound(result) {
  return result.status !== 0 && /\bE404\b|404 Not Found/i.test(result.output);
}

function isGhcrNotFound(result, image) {
  return result.status !== 0 && (
    /manifest unknown|MANIFEST_UNKNOWN/i.test(result.output) ||
    result.output.includes(`${image}: not found`)
  );
}

export function evaluateArtifactAvailability({ version, npm, images }) {
  const blockers = [];
  if (npm.status === 0) {
    blockers.push(`npm package run-spaceapp@${version} already exists.`);
  } else if (!isNpmNotFound(npm)) {
    blockers.push(`Could not prove that npm package run-spaceapp@${version} is absent.`);
  }

  for (const target of targets) {
    const image = `ghcr.io/oll4com/spaceapp-${target}:${version}`;
    const result = images[target];
    if (result.status === 0) {
      blockers.push(`GHCR tag ${image} already exists.`);
    } else if (!isGhcrNotFound(result, image)) {
      blockers.push(`Could not prove that GHCR tag ${image} is absent.`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}\n${result.stderr || ""}`.trim()
  };
}

function parseArgs(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--version" ||
    !isRegistrySafeReleaseVersion(argv[1])
  ) {
    throw new Error(
      "Usage: release-artifact-preflight.mjs --version <semantic-version>"
    );
  }
  return argv[1];
}

export function runCli(argv) {
  const version = parseArgs(argv);
  const npm = run("npm", ["view", `run-spaceapp@${version}`, "version"]);
  const images = Object.fromEntries(
    targets.map((target) => [
      target,
      run("docker", [
        "buildx",
        "imagetools",
        "inspect",
        `ghcr.io/oll4com/spaceapp-${target}:${version}`
      ])
    ])
  );
  const result = evaluateArtifactAvailability({ version, npm, images });
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
      `${error instanceof Error ? error.message : "Artifact preflight failed."}\n`
    );
    process.exitCode = 1;
  }
}
