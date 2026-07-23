#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const args = new Set(process.argv.slice(2));
const preflight = args.has("--preflight");
const trackedRuntimeSourceAllowlist = new Set([
  "packages/run-spaceapp/bin/spaceapp.mjs"
]);

function git(args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function gitLines(args) {
  const output = git(args);
  return output ? output.split("\n").filter(Boolean) : [];
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function isRuntimeOrSecretPath(path) {
  const normalized = toPosix(path);
  if (trackedRuntimeSourceAllowlist.has(normalized)) return false;
  return (
    /(^|\/)\.env($|\/)/.test(normalized) ||
    /(^|\/)\.env\.local$/.test(normalized) ||
    /(^|\/)\.env\..*\.local$/.test(normalized) ||
    /(^|\/)(node_modules|dist|dist-types|coverage|playwright-report|test-results|secrets|backups|bin|var|lost\+found)(\/|$)/.test(normalized) ||
    /\.(pem|key|log)$/.test(normalized)
  );
}

function isRepoArtifactPath(path) {
  const normalized = toPosix(path);
  return (
    /(^|\/)(reports?|screenshots?|traces?|tmp|temp)(\/|$)/.test(normalized) ||
    /\.(har|trace|trace\.zip|webm|mp4|mov)$/.test(normalized) ||
    /(^|\/)playwright-report\//.test(normalized) ||
    /(^|\/)test-results\//.test(normalized)
  );
}

function statusEntries() {
  return gitLines(["status", "--porcelain=v1", "--untracked-files=all"]).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(3)
  }));
}

function fail(message, details = []) {
  failures.push({ message, details });
}

const failures = [];
const warnings = [];

if (!existsSync(repoRoot) || !existsSync(resolve(repoRoot, ".git"))) {
  fail("Script is not running inside the Space git worktree.");
}

const branch = git(["branch", "--show-current"]) || "(detached)";
const worktreePath = git(["rev-parse", "--show-toplevel"]);

if (preflight && branch === "main" && process.env.SPACE_HYGIENE_ALLOW_MAIN !== "1") {
  fail("Refusing implementation preflight on main without SPACE_HYGIENE_ALLOW_MAIN=1.");
}

if (preflight && worktreePath === "/opt/spaceapp" && branch === "main" && process.env.SPACE_HYGIENE_ALLOW_MAIN !== "1") {
  fail("Refusing implementation work directly in /opt/spaceapp main.");
}

const stagedFiles = gitLines(["diff", "--cached", "--name-only"]);
const stagedRuntime = stagedFiles.filter(isRuntimeOrSecretPath);
const stagedArtifacts = stagedFiles.filter(isRepoArtifactPath);
if (stagedRuntime.length) {
  fail("Staged changes include runtime, secret, dependency, or generated output paths.", stagedRuntime);
}
if (stagedArtifacts.length) {
  fail("Staged changes include repo-local reports, screenshots, traces, or temp artifacts.", stagedArtifacts);
}

const entries = statusEntries();
if (worktreePath === "/opt/spaceapp" && branch === "main" && entries.length > 0 && process.env.SPACE_HYGIENE_ALLOW_LIVE_DIRTY !== "1") {
  fail("Live /opt/spaceapp main must stay clean; move WIP to an isolated worktree or rescue branch before continuing.", entries.map((entry) => `${entry.code} ${entry.path}`));
}

const untracked = entries.filter((entry) => entry.code === "??").map((entry) => entry.path);
const untrackedRuntime = untracked.filter(isRuntimeOrSecretPath);
const untrackedArtifacts = untracked.filter(isRepoArtifactPath);
if (preflight && untracked.length) {
  fail("Untracked files must be committed intentionally or removed before handoff.", untracked);
}
if (untrackedRuntime.length) {
  warnings.push({
    message: "Ignored or untracked runtime-looking files are present; do not commit or delete them generically.",
    details: untrackedRuntime
  });
}
if (untrackedArtifacts.length) {
  fail("Repo-local reports, screenshots, traces, or temp artifacts must move to /var/lib/spaceapp-user/agent-workspace/reports.", untrackedArtifacts);
}

const changedGenerated = entries
  .filter((entry) => entry.code !== "??")
  .map((entry) => entry.path)
  .filter((path) => isRuntimeOrSecretPath(path) || isRepoArtifactPath(path));
if (changedGenerated.length) {
  fail("Tracked changes touch forbidden runtime/generated/report paths.", changedGenerated);
}

console.log(`Space hygiene ${preflight ? "preflight" : "status"} report`);
console.log(`worktree=${worktreePath}`);
console.log(`branch=${branch}`);
console.log(`staged=${stagedFiles.length}`);
console.log(`untracked=${untracked.length}`);
console.log(`changed=${entries.length}`);

if (warnings.length) {
  console.log("\nWarnings:");
  for (const warning of warnings) {
    console.log(`- ${warning.message}`);
    for (const detail of warning.details.slice(0, 20)) console.log(`  ${detail}`);
    if (warning.details.length > 20) console.log(`  ... ${warning.details.length - 20} more`);
  }
}

if (failures.length) {
  console.error("\nFailures:");
  for (const failure of failures) {
    console.error(`- ${failure.message}`);
    for (const detail of failure.details.slice(0, 40)) console.error(`  ${detail}`);
    if (failure.details.length > 40) console.error(`  ... ${failure.details.length - 40} more`);
  }
  process.exit(1);
}

console.log("\nHygiene check passed.");
