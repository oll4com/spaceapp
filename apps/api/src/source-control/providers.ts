import type { GitRemoteRepository, LegacyRepositoryProviderId, LegacyRepositoryProviderAdapter, RepositoryProviderAdapter } from "@space/contracts";
import { GitControlError } from "./errors.js";
import type { ProviderRequest, ProviderUrlPolicy } from "./provider-transport.js";

export interface ProviderIdentity { login: string; email: string | null }
export interface GitProviderClient extends LegacyRepositoryProviderAdapter, Partial<Omit<RepositoryProviderAdapter, keyof LegacyRepositoryProviderAdapter>> {}

export class ApiGitProvider implements GitProviderClient {
  private readonly server: string;
  private readonly api: string;
  constructor(readonly provider: LegacyRepositoryProviderId, serverUrl: string, private readonly token: string, private readonly policy: ProviderUrlPolicy, private readonly request: ProviderRequest = policy.request) {
    if (provider !== "github" && provider !== "gitea") throw new GitControlError("PROVIDER_NOT_AVAILABLE", "This repository provider is not available yet.", 409);
    this.server = provider === "github" ? "https://github.com" : policy.normalize(serverUrl);
    this.api = provider === "github" ? "https://api.github.com" : `${this.server}/api/v1`;
  }
  private call(path: string, method = "GET", body?: unknown) { return this.request(new URL(`${this.api}${path}`), this.token, method, body, this.provider === "gitea" ? "token" : "Bearer"); }
  async identity(): Promise<ProviderIdentity> {
    const user = await this.call("/user") as { login?: string; email?: string | null };
    if (!user.login) throw new GitControlError("INVALID_TOKEN", "Provider did not verify an account.", 401);
    return { login: user.login, email: user.email ?? null };
  }
  private map(value: unknown): GitRemoteRepository {
    const r = value as { id: string | number; full_name: string; clone_url: string; html_url: string; private: boolean; default_branch?: string; permissions?: { pull?: boolean; push?: boolean; admin?: boolean } };
    if (!r.id || !r.full_name || !r.clone_url) throw new GitControlError("PROVIDER_FAILED", "Provider returned an invalid repository.", 502);
    return { id: String(r.id), fullName: r.full_name, cloneUrl: r.clone_url, webUrl: r.html_url, private: r.private, defaultBranch: r.default_branch || "main", permissions: { pull: r.permissions?.pull ?? false, push: r.permissions?.push ?? false, admin: r.permissions?.admin ?? false } };
  }
  async repositories(page: number) {
    const result = await this.call(`/user/repos?page=${page}&${this.provider === "github" ? "per_page" : "limit"}=50&sort=updated`) as unknown[];
    if (!Array.isArray(result)) throw new GitControlError("PROVIDER_FAILED", "Provider returned an invalid repository list.", 502);
    return result.map(r => this.map(r));
  }
  async repository(fullName: string) {
    const parts = fullName.split("/");
    if (parts.length !== 2 || parts.some(p => !p || p === "." || p === "..")) throw new GitControlError("INVALID_REPOSITORY", "Invalid repository name.");
    return this.map(await this.call(`/repos/${parts.map(encodeURIComponent).join("/")}`));
  }
  async create(name: string, privateRepo: boolean) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new GitControlError("INVALID_REPOSITORY", "Invalid repository name.");
    return this.map(await this.call("/user/repos", "POST", { name, private: privateRepo, auto_init: false, default_branch: "main" }));
  }
  async validateCloneUrl(input: string) {
    let url: URL; try { url = new URL(input); } catch { throw new GitControlError("REMOTE_MISMATCH", "Only provider HTTPS clone URLs are supported."); }
    const server = new URL(this.server);
    if (url.origin !== server.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(`${server.pathname.replace(/\/$/, "")}/`)) throw new GitControlError("REMOTE_MISMATCH", "Repository URL does not match the connected provider.", 409);
    await this.policy.address(url);
    return url.toString();
  }
}

export { ProviderUrlPolicy, type ProviderExchange, type ProviderRequest, type ProviderResponse } from "./provider-transport.js";
export { createRepositoryProvider, repositoryGitLogin, repositoryServer, type RepositoryCredentials } from "./adapters/index.js";
export { createGitEnvironment, createAnonymousGitEnvironment } from "./git-credentials.js";
