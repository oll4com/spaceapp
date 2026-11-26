#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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
  // This is the public application's bundled promotional video, not a test capture.
  if (normalized === "apps/web/public/demo/media/discover-space.mp4") return false;
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

// Delivery (2026-10-11, supersedes the 2026-09-24 direct-to-main rule): agents
// commit in their own worktree, on any branch, and submit it to the merge queue,
// which integrates on live main. Only the live checkout itself must stay on main.
const liveRoot = process.env.SPACE_HYGIENE_LIVE_ROOT || "/opt/spaceapp";
const liveCheckout = Boolean(worktreePath) && resolve(worktreePath) === resolve(liveRoot);
// Worktrees inside the live checkout (Claude Code's .claude/worktrees) hide work from git status and the queue
// (cleanup plan clipboard:mJxMBg0sQ8hi step 6): space-worktree creates them under var/worktrees/space/ instead.
const strayWorktreeRoot = resolve(liveRoot, ".claude", "worktrees");
if (worktreePath && resolve(worktreePath).startsWith(`${strayWorktreeRoot}${sep}`)) {
  fail(`This worktree is inside the live checkout (${strayWorktreeRoot}); create one with /opt/spaceapp/bin/space-worktree create.`);
}
const strayWorktrees = existsSync(strayWorktreeRoot) ? readdirSync(strayWorktreeRoot) : [];
if (strayWorktrees.length) {
  fail(`Worktrees inside the live checkout (${strayWorktreeRoot}) are not allowed; create one with /opt/spaceapp/bin/space-worktree create.`, strayWorktrees);
}

if (preflight && liveCheckout && branch !== "main") {
  fail("The live checkout must stay on main; deliver from your own worktree through the merge queue (space-queue submit).");
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
if (liveCheckout && branch === "main" && entries.length > 0 && process.env.SPACE_HYGIENE_ALLOW_LIVE_DIRTY !== "1") {
  fail("Live /opt/spaceapp main must be clean before delivery; commit only authorized task changes on main.", entries.map((entry) => `${entry.code} ${entry.path}`));
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

// These three test:deploy guards caused 11 of the 17 failed-test hits in dev queue batches on 20-21/11, and each failure
// cost a batch plus a bisect. They take seconds, so a worktree's preflight runs them before submit.
if (preflight && !liveCheckout) {
  const hasEslint = existsSync(resolve(repoRoot, "node_modules/.bin/eslint"));
  const guards = ["domain-boundaries-current", "composition-root-size", ...(hasEslint ? ["lint-ceiling"] : [])]
    .map((name) => `scripts/tests/${name}.test.mjs`).filter((path) => existsSync(resolve(repoRoot, path)));
  if (!hasEslint && existsSync(resolve(repoRoot, "scripts/tests/lint-ceiling.test.mjs"))) {
    warnings.push({ message: "No node_modules here, so the lint warning ceiling was not checked; the queue's test:deploy still checks it.", details: [] });
  }
  const run = guards.length
    ? spawnSync(process.execPath, ["--test", ...guards], {
      cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
      // A parent node --test sets NODE_TEST_CONTEXT, which makes the child report to it and exit 0 whatever fails.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"))
    })
    : { status: 0 };
  if (run.status !== 0) {
    const lines = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.split("\n").map((line) => line.trim());
    const causes = lines.filter((line) => /^✖ |New dependency cycle|problems \(|too many warnings|its budget is/.test(line));
    fail("A merge queue test:deploy guard fails in this tree; fix it before you submit.", causes.length ? causes : lines.slice(-12));
  }
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
