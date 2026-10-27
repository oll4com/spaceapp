import { z } from "zod";
import type { ControlRepository } from "@space/db";
import { SpaceConflictError, nowIso } from "@space/runtime";
import { execGit } from "./worktrees/worktree-service.js";

/**
 * Release trains: one live release per product that every pane joins (operator decision 2026-10-15), so panes ship
 * one joint version instead of cutting their own. A change joins until the captain starts publishing.
 * shortcut: one control record per product (actor "space", key = product); a new train replaces the closed one and the
 * history stays in each release's release-state.json. Upgrade to a table if the operator wants a release history view.
 */
const ACTOR = "space";
const LIVE = new Set(["OPEN", "PUBLISHING"]);
const sha = z.string().trim().regex(/^[0-9a-f]{7,40}$/i, "a git commit hash");

// approve: the operator's yes to the candidate, only through a Nous RELEASE decision (operator decision 2026-10-17).
export const releaseTrainOps = ["status", "open", "join", "leave", "candidate", "approve", "publishing", "published", "cancel"] as const;
export const releaseTrainInputSchema = z.object({
  op: z.enum(releaseTrainOps),
  product: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/).default("run-spaceapp"),
  version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "a version like 1.1.5").optional(),
  commit: sha.optional(),
  sourceSha: sha.optional().describe("The commit the release candidate is built from (op candidate)."),
  note: z.string().trim().max(300).optional()
}).strict();
export type ReleaseTrainInput = z.infer<typeof releaseTrainInputSchema>;

export interface ReleaseTrainPane { paneId: string; name: string }
export interface ReleaseTrain {
  product: string;
  version: string;
  status: "OPEN" | "PUBLISHING" | "PUBLISHED" | "CANCELLED";
  captain: ReleaseTrainPane;
  roomId: string;
  sourceSha: string | null;
  /** The candidate the operator approved; publishing needs it to be the current candidate. */
  approvedSha?: string | null;
  contributors: Array<ReleaseTrainPane & { commit: string; note: string | null; addedAt: string }>;
  openedAt: string;
  updatedAt: string;
}

/** Who asks: the Room Agent or the operator name any pane; a pane acting for itself may not run the captain's steps. */
export interface ReleaseTrainActor { roomId: string; pane: ReleaseTrainPane | null; paneSelf: boolean; /** The operator approved it in a Nous decision. */ operatorApproved?: boolean }

export function isLiveTrain(train: ReleaseTrain): boolean {
  return LIVE.has(train.status);
}

export async function listReleaseTrains(repo: ControlRepository): Promise<ReleaseTrain[]> {
  return (await repo.list("release_train", ACTOR)).map((record) => record.value as ReleaseTrain);
}

export async function changeReleaseTrain(repo: ControlRepository, input: ReleaseTrainInput, by: ReleaseTrainActor): Promise<ReleaseTrain> {
  const { op, product } = input;
  if (op === "status") throw new SpaceConflictError("status does not change a release train.");
  return repo.withLock(`release_train:${product}`, async () => {
    const record = await repo.get("release_train", ACTOR, product);
    const current = record ? record.value as ReleaseTrain : null;
    const live = current && isLiveTrain(current) ? current : null;
    const at = nowIso();
    let next: ReleaseTrain;
    if (op === "open") {
      if (live) throw new SpaceConflictError(`${product} ${live.version} is ${live.status.toLowerCase()} (captain ${live.captain.name}): join it instead of cutting your own version.`);
      if (!input.version) throw new SpaceConflictError("Give the version to open.");
      if (!by.pane) throw new SpaceConflictError("Name the captain pane that cuts this release.");
      next = { product, version: input.version, status: "OPEN", captain: by.pane, roomId: by.roomId, sourceSha: null, contributors: [], openedAt: at, updatedAt: at };
    } else {
      if (!live) throw new SpaceConflictError(`No ${product} release is open. Open one with op open.`);
      if (input.version && input.version !== live.version) {
        throw new SpaceConflictError(`${product} ${live.version} is the open release, not ${input.version}: join ${live.version} instead of cutting your own version.`);
      }
      if (["candidate", "approve", "publishing", "published", "cancel"].includes(op) && by.paneSelf && by.pane?.paneId !== live.captain.paneId) {
        throw new SpaceConflictError(`Only the captain (${live.captain.name}) can mark ${product} ${live.version} ${op}.`);
      }
      next = { ...live, contributors: [...live.contributors], updatedAt: at };
      if (op === "join") {
        if (live.status !== "OPEN") throw new SpaceConflictError(`${product} ${live.version} is already publishing: this change goes to the next release.`);
        if (!by.pane || !input.commit) throw new SpaceConflictError("Give the pane and the commit that joins the release.");
        const entry = { ...by.pane, commit: input.commit.toLowerCase(), note: input.note ?? null, addedAt: at };
        next.contributors = [...next.contributors.filter((item) => item.commit !== entry.commit), entry];
      } else if (op === "leave") {
        if (!by.pane) throw new SpaceConflictError("Name the pane that leaves the release.");
        next.contributors = next.contributors.filter((item) => item.paneId !== by.pane!.paneId || (input.commit && item.commit !== input.commit.toLowerCase()));
      } else if (op === "candidate") {
        // A train marked publishing before the operator's approval existed (stable 2026-10-17) reopens with its new candidate.
        if (live.status !== "OPEN" && live.approvedSha === live.sourceSha) throw new SpaceConflictError(`${product} ${live.version} is already publishing.`);
        if (!input.sourceSha) throw new SpaceConflictError("Give the sourceSha the candidate is built from.");
        next.sourceSha = input.sourceSha.toLowerCase();
        next.status = "OPEN";
      } else if (op === "approve") {
        if (!by.operatorApproved) throw new SpaceConflictError("Only the operator approves a release, through Nous (a RELEASE decision in the Nous dock).");
        if (live.status !== "OPEN" || !live.sourceSha) throw new SpaceConflictError("Record the candidate (op candidate with sourceSha) before the operator approves it.");
        next.approvedSha = live.sourceSha;
      } else if (op === "publishing") {
        if (!live.sourceSha) throw new SpaceConflictError("Record the candidate (op candidate with sourceSha) before publishing.");
        if (live.approvedSha !== live.sourceSha) throw new SpaceConflictError(`The operator has not approved ${product} ${live.version} at ${live.sourceSha.slice(0, 10)}: ask Nous to bring the release to the operator.`);
        next.status = "PUBLISHING";
      } else {
        next.status = op === "published" ? "PUBLISHED" : "CANCELLED";
      }
    }
    if (!await repo.write({ kind: "release_train", actorId: ACTOR, key: product, roomId: next.roomId, version: record?.version ?? 0, value: next }, record?.version ?? 0)) {
      throw new SpaceConflictError("The release train changed meanwhile. Read it again.");
    }
    return next;
  });
}

type Contains = (commit: string, ref: string) => Promise<boolean | null>;

/** Whether a commit is in a ref of the Space repository; null when git cannot tell (unknown commit). */
export const spaceRepoContains: Contains = async (commit, ref) => {
  const result = await execGit("/opt/spaceapp", ["merge-base", "--is-ancestor", commit, ref], 5_000).catch(() => null);
  return result?.code === 0 ? true : result?.code === 1 ? false : null;
};

function yes(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}

/** One line per train and per contributor commit, with where the commit already is. */
export async function releaseTrainLines(trains: ReleaseTrain[], contains: Contains = spaceRepoContains): Promise<string[]> {
  const lines: string[] = [];
  for (const train of trains) {
    const approval = !train.sourceSha ? "" : train.approvedSha === train.sourceSha ? " (approved by the operator)" : " (not approved by the operator yet)";
    lines.push(`- ${train.product} ${train.version}: ${train.status}, captain ${train.captain.name}, candidate ${train.sourceSha ?? "not built yet"}${approval}, ${train.contributors.length} joined change${train.contributors.length === 1 ? "" : "s"}.`);
    if (!isLiveTrain(train)) continue;
    for (const item of train.contributors) {
      const [inDev, inMain, inCandidate] = await Promise.all([contains(item.commit, "dev"), contains(item.commit, "main"),
        train.sourceSha ? contains(item.commit, train.sourceSha) : Promise.resolve(false)]);
      // A commit already in the candidate needs nothing more; otherwise main first, then a new candidate.
      const missing = inCandidate === true ? "" : inMain === false ? " (needs the operator's dev→stable promote)"
        : inCandidate === false && train.sourceSha ? " (the captain must rebuild the candidate)" : "";
      lines.push(`  - ${item.name}: ${item.commit.slice(0, 10)}${item.note ? ` (${item.note})` : ""}; in dev ${yes(inDev)}, in main ${yes(inMain)}, in candidate ${train.sourceSha ? yes(inCandidate) : "n/a"}${missing}.`);
    }
  }
  return lines;
}
