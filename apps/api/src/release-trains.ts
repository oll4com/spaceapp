import { stat } from "node:fs/promises";
import { z } from "zod";
import type { ControlRepository } from "@space/db";
import { SpaceConflictError, nowIso } from "@space/runtime";
import { execGit } from "./worktrees/worktree-service.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

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
// lab: the captain records its lab run's proof for the exact candidate ("May publish after a green lab proof", 2026-10-28).
// captain: Nous or the Room Agent names a new captain pane when the old one closed (1.2.0, 2026-11-10), never a pane for itself.
export const releaseTrainOps = ["status", "open", "join", "leave", "candidate", "lab", "approve", "publishing", "published", "cancel", "captain"] as const;
const version = z.string().trim().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "a version like 1.1.5");
export const releaseLabProofSchema = z.object({
  acceptanceSha256: z.string().trim().regex(/^[0-9a-f]{64}$/i).describe("SHA-256 of the release/acceptance.json the lab run wrote for this candidate."),
  allCasesPass: z.boolean().describe("Every required acceptance case PASS (spaceapp-setup-engine acceptance allPassed)."),
  freshInstall: z.boolean().describe("A fresh install of exactly this candidate is among the passed cases."),
  ciGreen: z.boolean().describe("The public CI is green on this candidate."),
  versionVerified: z.boolean().describe("space-version verify passed."),
  warm: z.enum(["NONE", "APPROVED", "UNAPPROVED"]).describe("Warm changes since the last published version: none, all approved by the operator, or some not."),
  previousVersion: version.describe("The published version npm latest moves back to if this release must be rolled back."),
  report: z.string().trim().max(400).optional().describe("Where the lab report lies.")
}).strict();
export type ReleaseLabProof = z.infer<typeof releaseLabProofSchema>;
export const releaseTrainInputSchema = z.object({
  op: z.enum(releaseTrainOps),
  product: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/).default("run-spaceapp"),
  version: version.optional(),
  commit: sha.optional(),
  sourceSha: sha.optional().describe("The commit the release candidate is built from (op candidate)."),
  note: z.string().trim().max(300).optional(),
  lab: releaseLabProofSchema.optional().describe("op lab: the captain's lab proof for the candidate named by sourceSha.")
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
  /** The captain's lab proof; it counts only for the candidate it names. */
  lab?: ReleaseLabProof & { sourceSha: string; recordedAt: string; by: string } | null;
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
        // A publishing train whose release run failed (1.2.0, 10/11) reopens with its new candidate; approvedSha keeps the earlier
        // approval, so op publishing waits until the operator's approval binds to the new candidate (R13-15b).
        if (!input.sourceSha) throw new SpaceConflictError("Give the sourceSha the candidate is built from.");
        next.sourceSha = input.sourceSha.toLowerCase();
        next.status = "OPEN";
      } else if (op === "captain") {
        if (by.paneSelf) throw new SpaceConflictError(`Only Nous or the Room Agent names a new captain for ${product} ${live.version}.`);
        if (!by.pane) throw new SpaceConflictError("Name the new captain pane.");
        next.captain = by.pane;
        next.roomId = by.roomId;
      } else if (op === "lab") {
        // Only the captain's own pane records it: neither Nous nor the Room Agent can attest a lab run they approve on.
        if (!by.paneSelf || by.pane?.paneId !== live.captain.paneId) throw new SpaceConflictError(`Only the captain pane (${live.captain.name}) records the lab proof, from its own lab run.`);
        if (!live.sourceSha || input.sourceSha?.toLowerCase() !== live.sourceSha) throw new SpaceConflictError("The lab proof must name the current candidate's sourceSha exactly.");
        if (!input.lab) throw new SpaceConflictError("Give the lab proof (lab: acceptanceSha256, allCasesPass, freshInstall, ciGreen, versionVerified, warm, previousVersion).");
        next.lab = { ...input.lab, acceptanceSha256: input.lab.acceptanceSha256.toLowerCase(), sourceSha: live.sourceSha, recordedAt: at, by: by.pane!.name };
      } else if (op === "approve") {
        if (!by.operatorApproved) throw new SpaceConflictError("Only the operator approves a release, through Nous (a RELEASE decision in the Nous dock).");
        if (live.status !== "OPEN" || !live.sourceSha) throw new SpaceConflictError("Record the candidate (op candidate with sourceSha) before the operator approves it.");
        if (input.sourceSha && input.sourceSha.toLowerCase() !== live.sourceSha) throw new SpaceConflictError(`The candidate changed to ${live.sourceSha.slice(0, 10)} after it was checked: nothing approved.`);
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
/** A commit can arrive without its ref moving (a worktree commit, a fetch), so an unknown answer is asked again after this. */
const UNKNOWN_RECHECK_MS = 5 * 60_000;

/**
 * Answers once per commit, ref and ref position. API audit 4/11: every room's minute read asked git twice per joined change
 * (38 changes: ~76 git spawns a minute per room), the main thread's longest blocks. `refKey` changes when the ref moves;
 * an unknown answer (null) holds UNKNOWN_RECHECK_MS: asked again on every read, the commits this clone lacks kept
 * ~3 git spawns a second on stable's event loop (4/11 06:20 BKK, its p99 lag 0.4-1.7 s).
 */
export function cachedContains(contains: Contains, refKey: (ref: string) => Promise<string>, now: () => number = Date.now): Contains {
  const answers = new Map<string, { at: number; answer: Promise<boolean | null> }>();
  return async (commit, ref) => {
    const key = `${commit} ${ref} ${await refKey(ref)}`;
    const cached = answers.get(key);
    if (cached && (now() - cached.at < UNKNOWN_RECHECK_MS || await cached.answer !== null)) return cached.answer;
    // Memory bound: keys of refs that moved on are never asked again.
    if (answers.size > 10_000) answers.clear();
    const answer = contains(commit, ref);
    answers.set(key, { at: now(), answer });
    void answer.catch(() => { if (answers.get(key)?.answer === answer) answers.delete(key); });
    return answer;
  };
}

/** Where a branch of the Space repository points, from file metadata only; "" for a commit id, whose ancestors never change. */
async function spaceRefKey(ref: string): Promise<string> {
  if (/^[0-9a-f]{7,64}$/.test(ref)) return "";
  const files = [`${SPACE_INSTALL_ROOT}/.git/refs/heads/${ref}`, `${SPACE_INSTALL_ROOT}/.git/packed-refs`];
  return (await Promise.all(files.map((file) => stat(file).then((info) => `${info.size}:${info.mtimeMs}`, () => "-")))).join("|");
}

/** Whether a commit is in a ref of the Space repository; null when git cannot tell (unknown commit). */
export const spaceRepoContains: Contains = cachedContains(async (commit, ref) => {
  const result = await execGit(SPACE_INSTALL_ROOT, ["merge-base", "--is-ancestor", commit, ref], 5_000).catch(() => null);
  return result?.code === 0 ? true : result?.code === 1 ? false : null;
}, spaceRefKey);

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
    if (train.lab) {
      const lab = train.lab;
      lines.push(`  - Lab proof for ${lab.sourceSha.slice(0, 10)}${lab.sourceSha === train.sourceSha ? "" : " (an older candidate: does not count)"}: all cases PASS ${lab.allCasesPass ? "yes" : "no"}, fresh install ${lab.freshInstall ? "yes" : "no"}, `
        + `CI green ${lab.ciGreen ? "yes" : "no"}, space-version verify ${lab.versionVerified ? "yes" : "no"}, Warm ${lab.warm}, rollback to ${lab.previousVersion}; recorded by ${lab.by} at ${lab.recordedAt.slice(0, 16)} UTC.`);
    }
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
