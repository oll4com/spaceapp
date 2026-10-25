import { z } from "zod";
import type { AnyProjectBinding, RepositoryProviderId, LegacyRepositoryProviderId } from "./repository-providers.js";
import { legacyRepositoryProviderIdSchema, repositoryProviderIdSchema } from "./repository-providers.js";

export interface PersonalGitConnection<P extends RepositoryProviderId = LegacyRepositoryProviderId> {
  provider: P;
  enabled?: boolean;
  serverUrl: string;
  status: "NOT_CONNECTED" | "CONNECTED" | "ERROR";
  accountLogin: string | null;
  connectedAt: string | null;
  checkedAt: string | null;
  error: string | null;
}
export interface GitRemoteRepository {
  id: string;
  fullName: string;
  cloneUrl: string;
  webUrl: string;
  private: boolean;
  defaultBranch: string;
  permissions: { pull: boolean; push: boolean; admin: boolean };
}
export interface ProjectRepositoryBinding<P extends RepositoryProviderId = LegacyRepositoryProviderId> {
  kind?: "provider";
  id: string;
  ownerUserId: string;
  projectPath: string;
  provider: P;
  serverUrl: string;
  repository: GitRemoteRepository | null;
  isDefault?: boolean;
}
export interface ProjectDefaultRepository {
  fullName: string | null;
  repository: GitRemoteRepository | null;
  isDefault: boolean;
  active: boolean;
}
export interface ProjectDefaultRepositories {
  projectPath: string;
  /** GitHub/Gitea keys are always present for legacy clients; other providers appear once implemented. */
  defaults: Record<LegacyRepositoryProviderId, ProjectDefaultRepository> & Partial<Record<RepositoryProviderId, ProjectDefaultRepository>>;
}
export const setProjectDefaultRepoSchema = z.object({
  projectPath: z.string().min(1).max(4096),
  provider: repositoryProviderIdSchema,
  repositoryFullName: z.string().min(1).max(300).nullable().optional(),
  repositoryId: z.string().min(1).max(1024).nullable().optional()
}).strict()
  .refine(value => !(value.repositoryFullName && value.repositoryId), "Choose a repository by ID or legacy name, not both.")
  .refine(value => !value.repositoryFullName || legacyRepositoryProviderIdSchema.safeParse(value.provider).success, "Use a stable repository ID for this provider.");
export type SetProjectDefaultRepoInput = z.infer<typeof setProjectDefaultRepoSchema>;
export interface GitFileChange {
  path: string;
  originalPath: string | null;
  status: string;
}
export interface GitStatusSnapshot {
  version: string;
  initialized: boolean;
  branch: string | null;
  head: string | null;
  headShort?: string | null;
  headDate?: string | null;
  headMessage?: string | null;
  projectVersion?: string | null;
  projectPillars?: { core?: string; desktop?: string; mobile?: string; setup?: string } | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  staged: GitFileChange[];
  conflicts: GitFileChange[];
  outgoing: { id: string; message: string }[];
  remoteUrl: string | null;
  comparison?: {
    ready: boolean;
    branch: string;
    head: string | null;
    headShort?: string | null;
    headDate?: string | null;
    headMessage?: string | null;
    repoVersion?: string | null;
    repoPillars?: { core?: string; desktop?: string; mobile?: string; setup?: string } | null;
    checkedAt: string | null;
    related: boolean | null;
    changes: GitFileChange[];
  };
}
export interface GitDiffHunk { id: string; header: string; lines: string[] }
export interface GitFileDiff { path: string; staged: boolean; binary: boolean; hunks: GitDiffHunk[]; text: string; version: string }
export const gitOperationSchema = z.object({
  bindingId: z.string().min(1).max(160),
  expectedVersion: z.string().min(1).max(100),
  paths: z.array(z.string().min(1).max(4096)).max(200).default([]),
  hunkId: z.string().min(1).max(100).optional(),
  message: z.string().trim().min(1).max(10000).optional(),
  confirmed: z.boolean().default(false),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).optional(),
  private: z.boolean().default(true),
  targetId: z.string().min(1).max(1024).optional(),
  operationId: z.string().min(1).max(160).optional()
}).strict();
export type GitOperationInput = z.infer<typeof gitOperationSchema>;
export type GitOperation = "initialize" | "clone" | "publish" | "stage" | "unstage" | "discard" | "commit" | "commit-push" | "fetch" | "pull" | "push";
export interface GitOperationResult {
  ok: boolean;
  snapshot: GitStatusSnapshot;
  remoteCreated?: boolean;
  createOutcome?: "created" | "unknown";
  committed: boolean;
  pushed: boolean;
  message: string;
  binding?: AnyProjectBinding;
}
