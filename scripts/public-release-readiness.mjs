#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRegistrySafeReleaseVersion } from "./release-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function evaluatePublicRelease({
  requestedVersion,
  requestedNpmTag,
  requestedReleaseMode = "full",
  requestedRuntimeVersion = requestedVersion,
  packageVersion,
  packageRuntimeVersion = packageVersion,
  packageHostRootRuntimeCompatible = true,
  notices,
  dockerfile,
  distributionPolicy
}) {
  const blockers = [];
  const warnings = [];
  if (!isRegistrySafeReleaseVersion(requestedVersion)) {
    blockers.push(
      `Requested version ${requestedVersion} is not a valid registry-safe semantic version.`
    );
  } else if (requestedVersion !== packageVersion) {
    blockers.push(
      `Requested version ${requestedVersion} does not match run-spaceapp ${packageVersion}.`
    );
  }
  if (
    requestedVersion.includes("-hostroot.") &&
    requestedNpmTag !== "personal"
  ) {
    blockers.push(
      "Host-root prereleases must publish only to the npm personal tag."
    );
  }
  if (!["full", "launcher-only"].includes(requestedReleaseMode)) {
    blockers.push(`Unknown release mode ${requestedReleaseMode}.`);
  }
  if (!isRegistrySafeReleaseVersion(requestedRuntimeVersion)) {
    blockers.push(
      `Requested runtime version ${requestedRuntimeVersion} is not a valid registry-safe semantic version.`
    );
  } else if (requestedRuntimeVersion !== packageRuntimeVersion) {
    blockers.push(
      `Requested runtime version ${requestedRuntimeVersion} does not match run-spaceapp runtime ${packageRuntimeVersion}.`
    );
  }
  if (
    requestedReleaseMode === "full" &&
    requestedRuntimeVersion !== requestedVersion
  ) {
    blockers.push(
      "Full releases must publish runtime images at the exact launcher version."
    );
  }
  if (
    requestedReleaseMode === "launcher-only" &&
    packageHostRootRuntimeCompatible !== false
  ) {
    blockers.push(
      "Launcher-only releases must disable host-root until matching runtime images are rebuilt."
    );
  }
  const claudePolicy = distributionPolicy?.packages?.["@anthropic-ai/claude-code"];
  if (
    distributionPolicy?.schemaVersion !== 1 ||
    claudePolicy?.version !== "2.1.206" ||
    claudePolicy?.distribution !== "owner-installed-only" ||
    claudePolicy?.imageBundled !== false
  ) {
    blockers.push("Claude Code distribution policy must be owner-installed-only and imageBundled=false.");
  }
  if (/@anthropic-ai\/claude-code/i.test(dockerfile)) {
    blockers.push("The distributed Dockerfile must not install @anthropic-ai/claude-code.");
  }
  if (!/@anthropic-ai\/claude-code@2\.1\.206/i.test(notices)) {
    blockers.push("Third-party notices must identify the reviewed Claude Code package.");
  }
  if (!/not included in published SpaceApp images/i.test(notices)) {
    blockers.push("Third-party notices must state that Claude Code is excluded from published images.");
  }
  if (!/owner-initiated/i.test(notices)) {
    blockers.push("Third-party notices must document the owner-initiated Claude installation boundary.");
  }
  return {
    ok: blockers.length === 0,
    requestedVersion,
    packageVersion,
    blockers,
    warnings
  };
}

function parseArgs(argv) {
  let requestedVersion = "";
  let requestedNpmTag = "";
  let requestedReleaseMode = "";
  let requestedRuntimeVersion = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version" && argv[index + 1]) {
      requestedVersion = argv[index + 1];
      index += 1;
    } else if (argument === "--npm-tag" && argv[index + 1]) {
      requestedNpmTag = argv[index + 1];
      index += 1;
    } else if (argument === "--release-mode" && argv[index + 1]) {
      requestedReleaseMode = argv[index + 1];
      index += 1;
    } else if (argument === "--runtime-version" && argv[index + 1]) {
      requestedRuntimeVersion = argv[index + 1];
      index += 1;
    } else {
      throw new Error(
        "Usage: public-release-readiness.mjs --version <semantic-version> --npm-tag <next|personal> --release-mode <full|launcher-only> --runtime-version <semantic-version>"
      );
    }
  }
  if (
    !requestedVersion ||
    !["next", "personal"].includes(requestedNpmTag) ||
    !["full", "launcher-only"].includes(requestedReleaseMode) ||
    !requestedRuntimeVersion
  ) {
    throw new Error(
      "Usage: public-release-readiness.mjs --version <semantic-version> --npm-tag <next|personal> --release-mode <full|launcher-only> --runtime-version <semantic-version>"
    );
  }
  return {
    requestedVersion,
    requestedNpmTag,
    requestedReleaseMode,
    requestedRuntimeVersion
  };
}

export async function runCli(argv) {
  const options = parseArgs(argv);
  const packageManifest = JSON.parse(
    await readFile(join(repoRoot, "packages", "run-spaceapp", "package.json"), "utf8")
  );
  const notices = await readFile(join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
  const distributionPolicy = JSON.parse(
    await readFile(join(repoRoot, "docs", "legal", "cli-distribution-policy.json"), "utf8")
  );
  const result = evaluatePublicRelease({
    ...options,
    packageVersion: packageManifest.version,
    packageRuntimeVersion: packageManifest.spaceappRuntimeVersion,
    packageHostRootRuntimeCompatible:
      packageManifest.spaceappHostRootRuntimeCompatible,
    notices,
    dockerfile,
    distributionPolicy
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Release readiness failed."}\n`);
    process.exitCode = 1;
  });
}
