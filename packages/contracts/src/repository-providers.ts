import { z } from "zod";
import type { PluginAuthField } from "./plugins.js";
import type { GitRemoteRepository, PersonalGitConnection, ProjectRepositoryBinding } from "./source-control.js";

/** Personal providers are deliberately independent of ADMIN deployment providers. */
export const repositoryProviderIdSchema = z.enum(["github", "gitea", "forgejo", "gitlab", "bitbucket", "azure-devops"]);
export type RepositoryProviderId = z.infer<typeof repositoryProviderIdSchema>;
export const legacyRepositoryProviderIdSchema = z.enum(["gitea", "github"]);
export type LegacyRepositoryProviderId = z.infer<typeof legacyRepositoryProviderIdSchema>;
export function isRepositoryProviderId(value: string): value is RepositoryProviderId {
  return repositoryProviderIdSchema.options.some(id => id === value);
}
export interface RepositoryProviderDescriptor {
  id: RepositoryProviderId;
  label: string;
  icon: string;
  available: boolean;
  defaultEnabled: boolean;
  defaultServerUrl: string;
  authFields: readonly PluginAuthField[];
  capabilities: { list: boolean; clone: boolean; create: boolean; targets: boolean; search: boolean };
}
const field = (key: string, label: string, type: PluginAuthField["type"], placeholder = ""): PluginAuthField =>
  ({ key, label, type, placeholder, required: true, description: "" });
const token = field("token", "Personal Access Token", "password");
const descriptor = (id: RepositoryProviderId, label: string, defaultServerUrl: string, authFields: PluginAuthField[], defaultEnabled = false): RepositoryProviderDescriptor => ({
  id, label, icon: id, available: true, defaultEnabled, defaultServerUrl, authFields,
  capabilities: { list: true, clone: true, create: true, targets: true, search: true }
});
export const repositoryProviderRegistry: readonly RepositoryProviderDescriptor[] = [
  descriptor("github", "GitHub", "https://github.com", [token], true),
  descriptor("gitea", "Gitea", "", [field("serverUrl", "Server URL", "url"), token], true),
  descriptor("forgejo", "Forgejo", "", [field("serverUrl", "Server URL", "url"), token]),
  descriptor("gitlab", "GitLab", "https://gitlab.com", [field("serverUrl", "Server URL", "url", "https://gitlab.com"), token]),
  descriptor("bitbucket", "Bitbucket Cloud", "https://bitbucket.org", [field("email", "Atlassian account email", "text"), field("token", "API token", "password")]),
  descriptor("azure-devops", "Azure DevOps Services", "https://dev.azure.com", [field("organization", "Organization URL", "url", "https://dev.azure.com/organization"), token])
];
export interface RepositoryProviderState extends RepositoryProviderDescriptor {
  enabled: boolean;
  connection: PersonalGitConnection<RepositoryProviderId>;
}
export const setRepositoryProviderEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export function normalizeProviderBinding<T extends ProjectRepositoryBinding<RepositoryProviderId>>(binding: T): T & { kind: "provider" } {
  return { ...binding, kind: "provider" };
}
/** Project Git state usable without any provider account. */
export interface LocalProjectBinding { kind: "local"; id: string; ownerUserId: string; projectPath: string }
/** Project cloned from an HTTPS Git URL. A provider is recorded only when its connected server matched the URL. */
export interface GitUrlProjectBinding { kind: "git-url"; id: string; ownerUserId: string; projectPath: string; url: string; provider: RepositoryProviderId | null }
export type ProviderProjectBinding = ProjectRepositoryBinding<RepositoryProviderId> & { kind: "provider" };
export type AnyProjectBinding = ProviderProjectBinding | LocalProjectBinding | GitUrlProjectBinding;
/** Stored records without a kind predate local/Git URL bindings and are provider bindings. */
export function normalizeProjectBinding(binding: AnyProjectBinding | ProjectRepositoryBinding<RepositoryProviderId>): AnyProjectBinding {
  if (binding.kind === "local" || binding.kind === "git-url") return binding as LocalProjectBinding | GitUrlProjectBinding;
  return normalizeProviderBinding(binding as ProjectRepositoryBinding<RepositoryProviderId>);
}
export function isProviderBinding(binding: AnyProjectBinding): binding is ProviderProjectBinding { return binding.kind === "provider"; }

export const repositoryTargetSchema = z.object({
  id: z.string().min(1).max(1024), provider: repositoryProviderIdSchema,
  kind: z.enum(["user", "organization", "namespace", "workspace", "project"]),
  name: z.string().min(1).max(300), parentId: z.string().min(1).max(1024).nullable().optional(),
  canCreateRepository: z.boolean(),
  createPermission: z.enum(["allowed", "denied", "unknown"]).optional(),
  visibility: z.enum(["private", "public"]).optional()
}).strict();
export type RepositoryTarget = z.infer<typeof repositoryTargetSchema>;
export const repositoryListInputSchema = z.object({
  provider: repositoryProviderIdSchema,
  query: z.string().trim().max(300).optional(), targetId: z.string().min(1).max(1024).optional(),
  page: z.number().int().min(1).max(1000).optional(), cursor: z.string().min(1).max(4096).optional()
}).strict().refine(value => value.page === undefined || value.cursor === undefined, "Choose page or cursor pagination.");
export type RepositoryListInput = z.infer<typeof repositoryListInputSchema>;
export interface RepositoryPage<T> { data: T[]; nextPage: number | null; nextCursor: string | null }
export const repositoryTargetListInputSchema = z.object({
  provider: repositoryProviderIdSchema, parentId: z.string().min(1).max(1024).optional(), cursor: z.string().min(1).max(4096).optional()
}).strict();
export type RepositoryTargetListInput = z.infer<typeof repositoryTargetListInputSchema>;
export const createRemoteRepositoryInputSchema = z.object({
  name: z.string().trim().min(1).max(100), private: z.boolean(), targetId: z.string().min(1).max(1024).optional()
}).strict();
export type CreateRemoteRepositoryInput = z.infer<typeof createRemoteRepositoryInputSchema>;
/** Shared transport contract currently implemented by GitHub/Gitea. */
export interface LegacyRepositoryProviderAdapter {
  identity(): Promise<{ login: string; email: string | null }>;
  repositories(page: number): Promise<GitRemoteRepository[]>;
  repository(fullName: string): Promise<GitRemoteRepository>;
  create(name: string, privateRepo: boolean): Promise<GitRemoteRepository>;
  validateCloneUrl(url: string): Promise<string>;
}
/** Extended contract for subsequent adapters; registry capabilities gate exposure. */
export interface RepositoryProviderAdapter extends Pick<LegacyRepositoryProviderAdapter, "identity" | "validateCloneUrl"> {
  list(input: RepositoryListInput): Promise<RepositoryPage<GitRemoteRepository>>;
  lookup(repositoryId: string): Promise<GitRemoteRepository>;
  targets(input: RepositoryTargetListInput): Promise<RepositoryPage<RepositoryTarget>>;
  createRepository(input: CreateRemoteRepositoryInput): Promise<GitRemoteRepository>;
  validateCloneUrl(url: string): Promise<string>;
}
const projectPath = z.string().min(1).max(4096).refine(path => !path.includes("\0"), "Invalid path.");
const cloneUrl = z.string().url().max(4096).refine(input => {
  try { const url = new URL(input); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}, "Use an HTTPS repository URL without credentials or query parameters.");
export const projectSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/) }).strict(),
  z.object({ kind: z.literal("local"), path: projectPath }).strict(),
  z.object({ kind: z.literal("git-url"), url: cloneUrl }).strict(),
  z.object({ kind: z.literal("provider"), provider: repositoryProviderIdSchema, repositoryId: z.string().min(1).max(1024) }).strict()
]);
export type ProjectSource = z.infer<typeof projectSourceSchema>;
export const openProjectInputSchema = z.object({ source: projectSourceSchema, destination: projectPath.optional() }).strict()
  .refine(input => input.source.kind === "local" ? input.destination === undefined : input.destination !== undefined, "Creation and cloning require a destination; local selection uses its source path.");
export type OpenProjectInput = z.infer<typeof openProjectInputSchema>;
export type ProjectSourceBinding = AnyProjectBinding;
export interface ProjectSourceSummary { kind: ProjectSource["kind"]; label: string; detail: string | null }
/** binding is null when a local folder is inside another repository; Source Control then uses that repository root. */
export interface OpenProjectResult { projectPath: string; binding: AnyProjectBinding | null; source: ProjectSourceSummary; created: boolean; repositoryRoot: string | null }
