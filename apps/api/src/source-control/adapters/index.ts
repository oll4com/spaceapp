import { repositoryListInputSchema, repositoryTargetListInputSchema, createRemoteRepositoryInputSchema, type RepositoryProviderAdapter, type RepositoryProviderId } from "@space/contracts";
import type { ProviderExchange, ProviderUrlPolicy } from "../provider-transport.js";
import { GitControlError } from "../errors.js";
import { ForgeAdapter } from "./forge.js";
import { GitLabAdapter } from "./gitlab.js";
import { BitbucketAdapter } from "./bitbucket.js";
import { AzureAdapter } from "./azure.js";
export interface RepositoryCredentials { token: string; email?: string }
export function repositoryServer(provider: RepositoryProviderId, input: string, policy: ProviderUrlPolicy): string {
  if (provider === "github") return "https://github.com";
  if (provider === "bitbucket") return "https://bitbucket.org";
  const server = policy.normalize(input), url = new URL(server);
  if (provider === "azure-devops" && (url.origin !== "https://dev.azure.com" || !/^\/[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(url.pathname))) throw new GitControlError("INVALID_SERVER", "Use an Azure DevOps Services organization URL.");
  // Self-hosted forges may use HTTP only for origins on the installation allowlist (checked by normalize).
  if (!["gitea", "forgejo", "gitlab"].includes(provider) && url.protocol !== "https:") throw new GitControlError("INVALID_SERVER", "Use an HTTPS provider URL.");
  return server;
}
export function repositoryGitLogin(provider: RepositoryProviderId, login: string): string {
  return provider === "bitbucket" ? "x-bitbucket-api-token-auth" : provider === "gitlab" ? "oauth2" : provider === "azure-devops" ? "space" : login;
}
export function createRepositoryProvider(provider: RepositoryProviderId, serverUrl: string, credentials: RepositoryCredentials, policy: ProviderUrlPolicy, exchange: ProviderExchange = policy.exchange): RepositoryProviderAdapter {
  const server = repositoryServer(provider, serverUrl, policy), token = credentials.token;
  if (!token || /[\x00-\x1f\x7f]/.test(token)) throw new GitControlError("INVALID_TOKEN", "Enter a valid API token.");
  let adapter: RepositoryProviderAdapter;
  switch (provider) {
    case "github": adapter = new ForgeAdapter(provider, server, "https://api.github.com", `Bearer ${token}`, policy, exchange); break;
    case "gitea": case "forgejo": adapter = new ForgeAdapter(provider, server, `${server}/api/v1`, `token ${token}`, policy, exchange); break;
    case "gitlab": adapter = new GitLabAdapter(provider, server, `${server}/api/v4`, `Bearer ${token}`, policy, exchange); break;
    case "bitbucket": {
      if (!credentials.email || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(credentials.email)) throw new GitControlError("INVALID_ACCOUNT", "Enter your Atlassian account email.");
      adapter = new BitbucketAdapter(provider, server, "https://api.bitbucket.org/2.0", `Basic ${Buffer.from(`${credentials.email}:${token}`).toString("base64")}`, policy, exchange); break;
    }
    case "azure-devops": adapter = new AzureAdapter(provider, server, server, `Basic ${Buffer.from(`:${token}`).toString("base64")}`, policy, exchange); break;
    default: throw new GitControlError("UNKNOWN_PROVIDER", "Unknown repository provider.");
  }
  return {
    identity: () => adapter.identity(), lookup: id => adapter.lookup(id), validateCloneUrl: url => adapter.validateCloneUrl(url),
    list: input => { const value = repositoryListInputSchema.parse(input); if (value.provider !== provider) throw new GitControlError("INVALID_INPUT", "Provider does not match the connection."); return adapter.list(value); },
    targets: input => { const value = repositoryTargetListInputSchema.parse(input); if (value.provider !== provider) throw new GitControlError("INVALID_INPUT", "Provider does not match the connection."); return adapter.targets(value); },
    createRepository: async input => {
      try { return await adapter.createRepository(createRemoteRepositoryInputSchema.parse(input)); }
      catch (error) {
        // Validation, target lookups and permission checks run before the request: nothing was created.
        if (error instanceof GitControlError) { if (!error.createAttempted) error.createNotSent = true; throw error; }
        const failure = new GitControlError("INVALID_INPUT", "Repository create request is invalid."); failure.createNotSent = true; throw failure;
      }
    }
  };
}
