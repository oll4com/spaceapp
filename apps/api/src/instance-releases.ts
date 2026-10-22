import { execFile } from "./safe-child-process.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  releaseActionResponseSchema, releasesReportSchema,
  type ReleaseActionResponse, type ReleasePendingChange, type ReleasesReport
} from "@space/contracts";
import { readDeployQueue } from "./deploy-queue.js";
import { childProcessEnv } from "./child-process-env.js";
import { signQueueOperatorGrant } from "./queue-operator-grants.js";

const execFileAsync = promisify(execFile);

export interface ReleasesOptions {
  stableRepo: string;
  devRepo: string;
  stableQueueRoot: string;
  devQueueRoot: string;
  queueScript: string;
  nodeBin: string;
  stableUrl: string;
  devUrl: string;
  /** Only the stable instance promotes; the dev instance shows the same report read-only. */
  managedHere: boolean;
}

export const defaultReleasesOptions: ReleasesOptions = {
  stableRepo: "/opt/spaceapp",
  devRepo: "/opt/spaceapp-dev",
  stableQueueRoot: "/opt/spaceapp/var/merge-queue",
  devQueueRoot: "/opt/spaceapp/var/merge-queue-dev",
  queueScript: "/opt/spaceapp/scripts/space-queue.mjs",
  nodeBin: process.execPath,
  stableUrl: "http://127.0.0.1:4911",
  devUrl: "http://127.0.0.1:4911:4940",
  managedHere: true
};

const PROMOTION_PREFIX = "Promote dev ";
const BACKMERGE_SUMMARY = "Back-merge stable main into dev";
const MAX_PENDING = 200;
// The API user reads checkouts owned by the operator account.
const gitEnv = { ...childProcessEnv(), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };

export class ReleaseActionError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

async function git(repo: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { env: gitEnv, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readDefaultTarget(stableQueueRoot: string): Promise<"stable" | "dev"> {
  try {
    return (await readFile(join(stableQueueRoot, "default-target"), "utf8")).trim() === "dev" ? "dev" : "stable";
  } catch {
    return "stable";
  }
}

/** First-parent history of dev that stable lacks: one entry per merge-queue batch merge. */
async function pendingChanges(stableRepo: string, stableCommit: string | null, devCommit: string | null): Promise<{ pending: ReleasePendingChange[]; count: number }> {
  if (!stableCommit || !devCommit) return { pending: [], count: 0 };
  const log = await git(stableRepo, ["log", "--first-parent", "--format=%H%x1f%s%x1f%cI", `${stableCommit}..${devCommit}`]);
  if (!log) return { pending: [], count: 0 };
  const changes = log.split("\n").map((line) => {
    const [commit = "", subject = "", committedAt = ""] = line.split("\x1f");
    const queued = /^Merge queue (q-\d{8}-\d{6}-[0-9a-f]{4}): (.*)$/.exec(subject);
    return { commit: commit.slice(0, 40), ticketId: queued?.[1] ?? null, summary: (queued?.[2] ?? subject).slice(0, 240), committedAt: committedAt.slice(0, 40) };
  }).filter((change) => change.commit && change.summary !== BACKMERGE_SUMMARY);
  return { pending: changes.slice(0, MAX_PENDING), count: changes.length };
}

export async function readReleases(options: ReleasesOptions = defaultReleasesOptions): Promise<ReleasesReport> {
  const available = existsSync(join(options.devRepo, ".git")) && existsSync(options.devQueueRoot);
  const [defaultTarget, stableCommit, devCommit, verifiedCommit, stableQueue, devQueue] = await Promise.all([
    readDefaultTarget(options.stableQueueRoot),
    git(options.stableRepo, ["rev-parse", "--verify", "--quiet", "main^{commit}"]),
    available ? git(options.devRepo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) : Promise.resolve(null),
    available ? git(options.devRepo, ["rev-parse", "--verify", "--quiet", "refs/space-queue/live-verified^{commit}"]) : Promise.resolve(null),
    readDeployQueue(options.stableQueueRoot),
    readDeployQueue(options.devQueueRoot)
  ]);
  // Dev deploys publish their commit into the stable repository, so the history is readable there.
  const { pending, count } = await pendingChanges(options.stableRepo, stableCommit, devCommit);
  const promotion = [...stableQueue.active, ...stableQueue.recent].find((ticket) => ticket.summary.startsWith(PROMOTION_PREFIX)) ?? null;
  return releasesReportSchema.parse({
    available,
    managedHere: options.managedHere,
    defaultTarget,
    stable: { commit: stableCommit, url: options.stableUrl },
    dev: { commit: devCommit, verifiedCommit, url: options.devUrl },
    pending,
    pendingCount: count,
    promotion,
    hotfixes: stableQueue.active.filter((ticket) => ticket.status === "AWAITING_APPROVAL").slice(0, 50),
    devQueue
  });
}

async function runQueue(options: ReleasesOptions, args: string[], operatorOp?: string): Promise<string> {
  try {
    // The operator's own Releases action carries their grant for the queue's operator-only commands.
    const env = operatorOp ? { ...gitEnv, SPACE_QUEUE_OPERATOR_GRANT: signQueueOperatorGrant(operatorOp, "operator:settings-releases") } : gitEnv;
    const { stdout } = await execFileAsync(options.nodeBin, [options.queueScript, ...args], { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    const message = /space-queue: (.+)/.exec(stderr)?.[1] ?? "The merge queue command failed.";
    throw new ReleaseActionError(message.slice(0, 500), 409);
  }
}

/** Queues the verified dev commit for stable; the stable queue ships it through the protected pipeline. */
export async function promoteDev(options: ReleasesOptions = defaultReleasesOptions): Promise<ReleaseActionResponse> {
  if (!options.managedHere) throw new ReleaseActionError("Releases are managed from the stable instance.", 409);
  const output = await runQueue(options, ["promote", "--json"], "promote");
  if (!output.startsWith("{")) {
    return releaseActionResponseSchema.parse({ status: "ALREADY_LIVE", ticketId: null, message: "Stable already runs the latest dev commit." });
  }
  const ticket = JSON.parse(output) as { id?: unknown };
  const ticketId = typeof ticket.id === "string" ? ticket.id : null;
  return releaseActionResponseSchema.parse({
    status: "QUEUED", ticketId,
    message: "Promotion queued. Stable restarts once while it deploys; CLI sessions keep running."
  });
}

export async function approveHotfix(ticketId: string, options: ReleasesOptions = defaultReleasesOptions): Promise<ReleaseActionResponse> {
  if (!options.managedHere) throw new ReleaseActionError("Releases are managed from the stable instance.", 409);
  if (!/^q-\d{8}-\d{6}-[0-9a-f]{4}$/.test(ticketId)) throw new ReleaseActionError("Invalid ticket id.", 400);
  await runQueue(options, ["approve", ticketId, "--target", "stable"], `approve:${ticketId}`);
  return releaseActionResponseSchema.parse({ status: "APPROVED", ticketId, message: "Hotfix approved for stable." });
}
