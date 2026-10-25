import { z } from "zod";

export type WorktreeStatus = "ACTIVE" | "MERGED" | "DISCARDED" | "DIRTY";

export interface SpaceWorktree {
  id: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  roomId: string;
  paneId?: string | null;
  status: WorktreeStatus;
  isDirty: boolean;
  aheadCount: number;
  behindCount: number;
  createdAt: string;
  updatedAt: string;
}

export const createWorktreeSchema = z.object({
  repoPath: z.string().min(1).max(4096),
  roomId: z.string().min(1).max(160),
  branchName: z.string().regex(/^[A-Za-z0-9._\/-]{1,100}$/).optional(),
  baseBranch: z.string().min(1).max(100).default("main"),
  paneId: z.string().min(1).max(160).nullable().optional(),
  linkModules: z.boolean().default(true)
}).passthrough();
export type CreateWorktreeInput = z.infer<typeof createWorktreeSchema>;

export const mergeWorktreeSchema = z.object({
  strategy: z.enum(["merge", "squash", "rebase"]).default("merge"),
  commitMessage: z.string().max(10000).optional(),
  deleteBranchAfter: z.boolean().default(true)
}).passthrough();
export type MergeWorktreeInput = z.infer<typeof mergeWorktreeSchema>;

export interface WorktreeOperationResult {
  ok: boolean;
  worktree?: SpaceWorktree;
  commitSha?: string | null;
  error?: string | null;
  alreadyMerged?: boolean;
}
