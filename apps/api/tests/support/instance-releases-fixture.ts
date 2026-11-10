import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleasesOptions } from "../../src/instance-releases.js";

// Throwaway stable and dev repositories, queue folders and a fake space-queue, shared by instance-releases tests.
export const secret = "test-secret-with-enough-length";
const grantModule = fileURLToPath(new URL("../../../../scripts/space-queue-operator-grant.mjs", import.meta.url));

const roots: string[] = [];
export function cleanupReleaseFixtures() { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function ticket(id: string, status: string, summary: string) {
  return { id, status, sha: "a".repeat(40), branch: "space/wt", summary, submittedAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z", history: [] };
}

export function fixture(queueOutput = "{\"id\":\"q-20261012-100000-abcd\"}") {
  const root = mkdtempSync(join(tmpdir(), "space-releases-"));
  roots.push(root);
  const stableRepo = join(root, "stable");
  execFileSync("git", ["init", "-q", "-b", "main", stableRepo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"]]) git(stableRepo, "config", key, value);
  writeFileSync(join(stableRepo, "app.txt"), "base\n");
  git(stableRepo, "add", ".");
  git(stableRepo, "commit", "-qm", "base");
  const devRepo = join(root, "dev");
  execFileSync("git", ["clone", "-q", stableRepo, devRepo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"]]) git(devRepo, "config", key, value);
  git(devRepo, "checkout", "-q", "-b", "dev");
  for (const subject of ["Merge queue q-20261012-090000-aaaa: Feature A", "Merge queue q-20261012-091000-bbbb: Back-merge stable main into dev", "Merge queue q-20261012-092000-cccc: Feature B"]) {
    git(devRepo, "commit", "-q", "--allow-empty", "-m", subject);
  }
  git(devRepo, "update-ref", "refs/space-queue/live-verified", git(devRepo, "rev-parse", "HEAD"));
  git(stableRepo, "fetch", "-q", devRepo, "+dev:refs/heads/dev");
  const stableQueueRoot = join(root, "queue");
  const devQueueRoot = join(root, "queue-dev");
  for (const dir of [join(stableQueueRoot, "tickets"), join(devQueueRoot, "tickets")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stableQueueRoot, "default-target"), "dev\n");
  writeFileSync(join(stableQueueRoot, "tickets", "q-20261012-080000-1111.json"), JSON.stringify(ticket("q-20261012-080000-1111", "DEPLOYED", "Promote dev 0123456789 to stable")));
  writeFileSync(join(stableQueueRoot, "tickets", "q-20261012-093000-2222.json"), JSON.stringify(ticket("q-20261012-093000-2222", "AWAITING_APPROVAL", "Urgent stable fix")));
  const queueScript = join(root, "fake-queue.mjs");
  // Like space-queue, the operator-only commands need the operator grant the API signed (hardening plan step 5).
  writeFileSync(join(root, ".env"), `SPACE_SESSION_SECRET=${secret}\n`);
  writeFileSync(queueScript, `import { requireOperator } from ${JSON.stringify(grantModule)};
const [command, ticket] = process.argv.slice(2);
try {
  await requireOperator(command === "approve" ? "approve:" + ticket : command, { SPACE_QUEUE_OPERATOR_GRANT: process.env.SPACE_QUEUE_OPERATOR_GRANT }, { uid: 1000, envFile: ${JSON.stringify(join(root, ".env"))} });
} catch (error) { process.stderr.write("space-queue: " + error.message + "\\n"); process.exit(1); }
process.stdout.write(${JSON.stringify(queueOutput)});
`);
  const options: ReleasesOptions = {
    stableRepo, devRepo, stableQueueRoot, devQueueRoot, queueScript, nodeBin: process.execPath,
    stableUrl: "https://stable.test", devUrl: "https://dev.test", managedHere: true
  };
  return { root, options, devHead: git(devRepo, "rev-parse", "HEAD") };
}
