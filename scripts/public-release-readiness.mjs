#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPattern = /^\d+\.\d+\.\d+-alpha\.\d+$/;

export function evaluatePublicRelease({
  requestedVersion,
  packageVersion,
  notices,
  dockerfile,
  distributionPolicy
}) {
  const blockers = [];
  const warnings = [];
  if (!versionPattern.test(requestedVersion)) {
    blockers.push(`Requested version ${requestedVersion} is not an alpha version.`);
  } else if (requestedVersion !== packageVersion) {
    blockers.push(
      `Requested version ${requestedVersion} does not match run-spaceapp ${packageVersion}.`
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
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version" && argv[index + 1]) {
      requestedVersion = argv[index + 1];
      index += 1;
    } else {
      throw new Error(
        "Usage: public-release-readiness.mjs --version <0.1.0-alpha.N>"
      );
    }
  }
  if (!requestedVersion) {
    throw new Error("A release version is required.");
  }
  return { requestedVersion };
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
