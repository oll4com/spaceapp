import type { AnyProjectBinding, GitFileDiff, GitOperation, GitOperationInput, GitOperationResult, GitRemoteRepository, GitStatusSnapshot, OpenProjectInput, OpenProjectResult, PersonalGitConnection, PluginConnectionState, ProjectDefaultRepositories, ProjectRepositoryBinding, RepositoryPage, RepositoryProviderId, RepositoryProviderState, RepositoryTarget, SourceControlProvider } from "@space/contracts";
export const SOURCE_CONTROL_CONNECTION_EVENT = "space:source-control-connection";
export interface RepositoryListRequest { provider: RepositoryProviderId; query?: string; targetId?: string; cursor?: string; page?: number }
export interface PublishPreview {
  provider: RepositoryProviderId; serverUrl: string; targetId: string | null; targetName: string | null;
  createPermission: "allowed" | "denied" | "unknown"; name: string; private: boolean; visibility: "private" | "public";
  hasCommits: boolean; willCommit: false; willPush: false; expectedVersion: string;
}
export interface PendingPublish { bindingId: string; provider: RepositoryProviderId; operationId: string; state: "unknown" | "creating" | "created"; name: string | null; createdAt: string }
export interface SourceControlClient {
  connections(signal?: AbortSignal): Promise<PersonalGitConnection[]>;
  repositories(provider: SourceControlProvider, page: number, signal?: AbortSignal): Promise<{ data: GitRemoteRepository[]; nextPage: number | null }>;
  bind(path: string, provider: SourceControlProvider, fullName?: string, signal?: AbortSignal): Promise<ProjectRepositoryBinding>;
  defaults(projectPath: string, signal?: AbortSignal): Promise<ProjectDefaultRepositories>;
  setDefault(projectPath: string, provider: SourceControlProvider, repositoryFullName?: string | null, signal?: AbortSignal): Promise<{ ok: boolean; isDefault: boolean; repository: GitRemoteRepository | null }>;
  status(bindingId: string, signal?: AbortSignal): Promise<GitStatusSnapshot>;
  diff(bindingId: string, path: string, staged: boolean, signal?: AbortSignal, remoteComparison?: boolean): Promise<GitFileDiff>;
  operate(operation: GitOperation, input: GitOperationInput): Promise<GitOperationResult>;
  providers(signal?: AbortSignal): Promise<RepositoryProviderState[]>;
  listRepositories(input: RepositoryListRequest, signal?: AbortSignal): Promise<RepositoryPage<GitRemoteRepository>>;
  targets(provider: RepositoryProviderId, parentId?: string, cursor?: string, signal?: AbortSignal): Promise<RepositoryPage<RepositoryTarget>>;
  bindRepository(projectPath: string, provider: RepositoryProviderId, repositoryId?: string, signal?: AbortSignal): Promise<AnyProjectBinding>;
  bindLocal(projectPath: string, signal?: AbortSignal): Promise<AnyProjectBinding>;
  setDefaultRepository(projectPath: string, provider: RepositoryProviderId, repositoryId: string | null): Promise<{ ok: boolean; isDefault: boolean; repository: GitRemoteRepository | null }>;
  previewPublish(input: GitOperationInput): Promise<PublishPreview>;
  pendingPublishes(projectPath: string, signal?: AbortSignal): Promise<PendingPublish[]>;
  dismissPublish(bindingId: string, operationId: string): Promise<{ ok: boolean }>;
  openProject(input: OpenProjectInput): Promise<OpenProjectResult>;
}
export class SourceControlRequestError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) { super(message); }
}
let csrfToken: Promise<string> | null = null;
/** One shared token request. It must not carry a caller's AbortSignal: another caller may still be waiting on it. */
async function csrf(refresh = false): Promise<string> {
  if (refresh) csrfToken = null;
  csrfToken ??= fetch("/api/auth/csrf", { credentials: "same-origin" }).then(async response => {
    if (!response.ok) throw new SourceControlRequestError("Sign in again to use Source Control.", "UNAUTHENTICATED", response.status);
    return (await response.json() as { csrfToken: string }).csrfToken;
  });
  try { return await csrfToken; } catch (error) { csrfToken = null; throw error; }
}
async function call<T>(url: string, body?: unknown, signal?: AbortSignal, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) { headers["x-space-csrf-token"] = await csrf(retried); headers["content-type"] = "application/json"; }
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({}));
  if (response.status === 403 && body !== undefined && !retried && data?.error?.code === "CSRF_INVALID") return call<T>(url, body, signal, true);
  if (!response.ok) {
    const error = data?.error;
    throw new SourceControlRequestError(typeof error === "string" ? data.message || error : error?.message || data?.message || "Source Control request failed.", typeof error === "string" ? error : error?.code ?? null, response.status);
  }
  return data as T;
}
const request = <T>(path: string, body?: unknown, signal?: AbortSignal) => call<T>(`/api/source-control/${path}`, body, signal);
const query = (values: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "").map(([key, value]) => [key, String(value)]));
export const sourceControlClient: SourceControlClient = {
  connections: signal => request("connections", undefined, signal),
  repositories: (provider, page, signal) => request(`repositories?${new URLSearchParams({ provider, page: String(page) })}`, undefined, signal),
  bind: (projectPath, provider, repositoryFullName, signal) => request("bindings", { projectPath, provider, repositoryFullName }, signal),
  defaults: (projectPath, signal) => request(`defaults?${new URLSearchParams({ projectPath })}`, undefined, signal),
  setDefault: (projectPath, provider, repositoryFullName, signal) => request("defaults", { projectPath, provider, repositoryFullName }, signal),
  status: (bindingId, signal) => request(`status?${new URLSearchParams({ bindingId })}`, undefined, signal),
  diff: (bindingId, path, staged, signal, remoteComparison = false) => request(`diff?${new URLSearchParams({ bindingId, path, staged: String(staged), comparison: remoteComparison ? "remote" : "local" })}`, undefined, signal),
  operate: (operation, input) => request(operation, input),
  providers: signal => request("providers", undefined, signal),
  listRepositories: async (input, signal) => {
    const page = await request<RepositoryPage<GitRemoteRepository> & { nextCursor?: string | null }>(`repositories?${query({ provider: input.provider, query: input.query?.trim() || undefined, targetId: input.targetId, cursor: input.cursor, page: input.cursor ? undefined : input.page })}`, undefined, signal);
    return { data: page.data, nextPage: page.nextPage ?? null, nextCursor: page.nextCursor ?? null };
  },
  targets: (provider, parentId, cursor, signal) => request(`targets?${query({ provider, parentId, cursor })}`, undefined, signal),
  bindRepository: (projectPath, provider, repositoryId, signal) => request("bindings", { projectPath, provider, ...(repositoryId ? { repositoryId } : {}) }, signal),
  bindLocal: (projectPath, signal) => request("bindings", { projectPath, kind: "local" }, signal),
  setDefaultRepository: (projectPath, provider, repositoryId) => request("defaults", { projectPath, provider, repositoryId }),
  previewPublish: input => request("publish-preview", input),
  pendingPublishes: (projectPath, signal) => request(`publish-pending?${new URLSearchParams({ projectPath })}`, undefined, signal),
  dismissPublish: (bindingId, operationId) => request("publish-dismiss", { bindingId, operationId, confirmed: true }),
  openProject: input => call("/api/projects/open", input)
};

/** Personal repository provider settings share the plugin endpoints and the Source Control event. */
export const repositoryProviderSettings = {
  setEnabled: (provider: RepositoryProviderId, enabled: boolean) => call<{ provider: RepositoryProviderId; enabled: boolean }>(`/api/plugins/${provider}/enabled`, { enabled }),
  connect: (provider: RepositoryProviderId, credentials: Record<string, string>) => call<PluginConnectionState>(`/api/plugins/${provider}/connect`, { credentials }),
  disconnect: (provider: RepositoryProviderId) => call<PluginConnectionState>(`/api/plugins/${provider}/disconnect`, {}),
  test: (provider: RepositoryProviderId) => call<{ ok: boolean; message: string }>(`/api/plugins/${provider}/test`, {}),
  changed: (detail?: { openDock?: boolean }) => window.dispatchEvent(new CustomEvent(SOURCE_CONTROL_CONNECTION_EVENT, { detail }))
};

export interface ServerDirectoryEntry { name: string; path: string }
export interface ServerDirectoryListing { currentPath: string; parentPath: string | null; entries: ServerDirectoryEntry[] }
/** Folders on the Space runtime host, through the existing Files authorization (Admin Mode only for ADMIN/OPERATOR). */
export async function listServerDirectories(path: string | undefined, admin: boolean, signal?: AbortSignal): Promise<ServerDirectoryListing> {
  const result = await call<{ currentPath: string; parentPath: string | null; entries: { name: string; path: string; isDirectory: boolean }[] }>(`/api/files/list?${query({ path, mode: admin ? "admin" : "user" })}`, undefined, signal);
  return { currentPath: result.currentPath, parentPath: result.parentPath, entries: result.entries.filter(entry => entry.isDirectory).map(entry => ({ name: entry.name, path: entry.path })) };
}
