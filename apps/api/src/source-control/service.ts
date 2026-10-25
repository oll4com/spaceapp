import { createHash, randomUUID } from "node:crypto";
import type { AnyProjectBinding, GitOperation, GitOperationInput, GitUrlProjectBinding, LocalProjectBinding, PersonalGitConnection, PluginConnectionState, ProjectDefaultRepositories, ProjectDefaultRepository, ProjectRepositoryBinding, ProviderProjectBinding } from "@space/contracts";
import { repositoryProviderRegistry, isRepositoryProviderId, isProviderBinding, type RepositoryProviderId, type LegacyRepositoryProviderId, type RepositoryProviderState, type RepositoryListInput, type RepositoryTargetListInput, type RepositoryProviderAdapter } from "@space/contracts";
import type { PersonalGitConnectionRecord, SourceControlRepository } from "@space/db";
import { DemoCredentialStore } from "../demo-projects/credentials.js";
import { ApiGitProvider, ProviderUrlPolicy, createRepositoryProvider, repositoryServer, repositoryGitLogin, createGitEnvironment, createAnonymousGitEnvironment, type RepositoryCredentials, type GitProviderClient } from "./providers.js";
import { GitEngine, runGit, type RemoteComparisonTarget } from "./git-engine.js";
import { GitControlError } from "./errors.js";
import { RepositoryPublisher, type ConnectedRepositoryProvider } from "./publishing.js";

type ProviderFactory = (provider: RepositoryProviderId, server: string, token: string, credentials?: RepositoryCredentials) => GitProviderClient;
export interface SourceControlServiceOptions {
  repository: SourceControlRepository;
  credentials: DemoCredentialStore;
  credentialRoot: string;
  providerFactory?: ProviderFactory;
  defaultGiteaUrl?: string;
  privateOrigins?: string[];
}
const legacyProviders: LegacyRepositoryProviderId[] = ["github", "gitea"];
export class SourceControlService {
  readonly engine = new GitEngine();
  private readonly policy: ProviderUrlPolicy;
  private readonly factory: ProviderFactory;
  private readonly publisher: RepositoryPublisher;
  private initialization: Promise<void> | null = null;
  private connectionQueues = new Map<string, Promise<unknown>>();
  constructor(private readonly options: SourceControlServiceOptions) {
    this.policy = new ProviderUrlPolicy(options.privateOrigins);
    this.factory = options.providerFactory ?? ((provider, server, token, credentials) => {
      const adapter = createRepositoryProvider(provider, server, { ...credentials, token }, this.policy);
      const legacy = provider === "github" || provider === "gitea" ? new ApiGitProvider(provider, server, token, this.policy) : null;
      return { ...adapter,
        repositories: async page => legacy ? legacy.repositories(page) : (await adapter.list({ provider, page })).data,
        repository: name => legacy ? legacy.repository(name) : adapter.lookup(name),
        create: (name, privateRepo) => adapter.createRepository({ name, private: privateRepo }) };
    });
    this.publisher = new RepositoryPublisher({ repository: options.repository, engine: this.engine,
      binding: (owner, id) => this.providerBinding(owner, id), client: (owner, provider) => this.client(owner, provider),
      validateConfiguration: (root, remote) => this.validateNetworkConfiguration(root, remote),
      environment: (binding, connection) => this.networkEnvironment(binding, connection) });
  }
  get defaultGiteaUrl() { return this.options.defaultGiteaUrl || "https://example.invalid"; }
  private initialize() { return this.initialization ??= this.options.credentials.initialize().catch(error => { this.initialization = null; throw error; }); }
  private publicConnection<P extends RepositoryProviderId>(record: PersonalGitConnectionRecord & { provider: P }): PersonalGitConnection<P> {
    // Explicit projection: stored secrets and future internal fields must never reach API responses.
    return { provider: record.provider, enabled: record.enabled ?? this.descriptor(record.provider).defaultEnabled,
      serverUrl: record.serverUrl, status: record.status, accountLogin: record.accountLogin,
      connectedAt: record.connectedAt, checkedAt: record.checkedAt, error: record.error };
  }
  private descriptor(provider: RepositoryProviderId) {
    const descriptor = isRepositoryProviderId(provider) ? repositoryProviderRegistry.find(p => p.id === provider) : undefined;
    if (!descriptor) throw new GitControlError("UNKNOWN_PROVIDER", "Unknown repository provider.", 400);
    return descriptor;
  }
  private available(provider: RepositoryProviderId) {
    if (!this.descriptor(provider).available) {
      throw new GitControlError("PROVIDER_NOT_AVAILABLE", "This repository provider is not available yet.", 409);
    }
  }
  async providers(owner: string): Promise<RepositoryProviderState[]> {
    return Promise.all(repositoryProviderRegistry.map(async descriptor => {
      const record = await this.options.repository.getConnection(owner, descriptor.id) ?? this.empty(owner, descriptor.id);
      return { ...descriptor, enabled: record.enabled ?? descriptor.defaultEnabled, connection: this.publicConnection(record) };
    }));
  }
  async setEnabled(owner: string, provider: RepositoryProviderId, enabled: boolean) {
    this.descriptor(provider);
    return this.exclusive(owner, provider, async () => {
      const record = await this.options.repository.getConnection(owner, provider) ?? this.empty(owner, provider);
      await this.options.repository.saveConnection({ ...record, enabled });
      return { provider, enabled };
    });
  }
  private empty(owner: string, provider: RepositoryProviderId): PersonalGitConnectionRecord {
    const descriptor = this.descriptor(provider);
    return { ownerUserId: owner, provider, enabled: descriptor.defaultEnabled, serverUrl: provider === "gitea" ? this.defaultGiteaUrl : descriptor.defaultServerUrl, credentialRef: null, status: "NOT_CONNECTED", accountLogin: null, connectedAt: null, checkedAt: null, error: null };
  }
  async connections(owner: string) {
    return Promise.all(legacyProviders.map(async provider => this.publicConnection({ ...await this.options.repository.getConnection(owner, provider) ?? this.empty(owner, provider), provider })));
  }
  private async exclusive<T>(owner: string, provider: RepositoryProviderId, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([owner, provider]); const previous = this.connectionQueues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action); this.connectionQueues.set(key, operation);
    try { return await operation; } finally { if (this.connectionQueues.get(key) === operation) this.connectionQueues.delete(key); }
  }
  async connect(owner: string, provider: RepositoryProviderId, credentials: Record<string, string>) {
    this.available(provider);
    return this.exclusive(owner, provider, async () => {
      const token = credentials.token?.trim();
      if (!token || /[\x00-\x1f\x7f]/.test(token)) throw new GitControlError("INVALID_TOKEN", "Enter a valid Personal Access Token.");
      const email = credentials.email?.trim();
      if (provider === "bitbucket" && (!email || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(email))) throw new GitControlError("INVALID_ACCOUNT", "Enter your Atlassian account email.");
      const server = repositoryServer(provider, provider === "azure-devops" ? credentials.organization || credentials.serverUrl || "" : credentials.serverUrl || (provider === "gitea" ? this.defaultGiteaUrl : this.descriptor(provider).defaultServerUrl), this.policy);
      const auth: RepositoryCredentials = { token, ...(provider === "bitbucket" ? { email } : {}) };
      const client = this.factory(provider, server, token, auth);
      let identity; try { identity = await client.identity(); } catch (error) {
        if (error instanceof GitControlError) throw error;
        throw new GitControlError("INVALID_TOKEN", "Token could not verify a provider account.", 401);
      }
      await this.initialize();
      const old = await this.options.repository.getConnection(owner, provider);
      const ref = `personal_git_${randomUUID()}`; await this.options.credentials.write(ref, { ...auth });
      const now = new Date().toISOString();
      const record: PersonalGitConnectionRecord = { ownerUserId: owner, provider, enabled: old?.enabled ?? this.descriptor(provider).defaultEnabled, serverUrl: server, credentialRef: ref, status: "CONNECTED", accountLogin: identity.login, connectedAt: now, checkedAt: now, error: null };
      try { await this.options.repository.saveConnection(record); } catch (error) { await this.options.credentials.delete(ref); throw error; }
      if (old?.credentialRef) await this.options.credentials.delete(old.credentialRef);
      return this.publicConnection(record);
    });
  }
  async disconnect(owner: string, provider: RepositoryProviderId) {
    this.descriptor(provider);
    return this.exclusive(owner, provider, async () => {
      const old = await this.options.repository.getConnection(owner, provider);
      const disconnected = { ...this.empty(owner, provider), enabled: old?.enabled ?? this.descriptor(provider).defaultEnabled, serverUrl: old?.serverUrl ?? this.empty(owner, provider).serverUrl };
      await this.options.repository.saveConnection(disconnected);
      if (old?.credentialRef) { await this.initialize(); await this.options.credentials.delete(old.credentialRef); }
      return this.publicConnection(disconnected);
    });
  }
  async client(owner: string, provider: RepositoryProviderId, allowError = false): Promise<ConnectedRepositoryProvider> {
    this.available(provider);
    const record = await this.options.repository.getConnection(owner, provider);
    if (!allowError && !(record?.enabled ?? this.descriptor(provider).defaultEnabled)) throw new GitControlError("PROVIDER_DISABLED", "Enable this repository provider in Plugins first.", 409);
    if (!record?.credentialRef || !allowError && record.status !== "CONNECTED") throw new GitControlError("NOT_CONNECTED", "Connect this provider in Plugins first.", 409);
    await this.initialize();
    const credentials = await this.options.credentials.read(record.credentialRef);
    const { token } = credentials;
    if (typeof token !== "string") throw new GitControlError("NOT_CONNECTED", "Reconnect this provider.", 409);
    return { record, token, client: this.factory(provider, record.serverUrl, token, { token, ...(typeof credentials.email === "string" ? { email: credentials.email } : {}) }) };
  }
  async test(owner: string, provider: RepositoryProviderId) {
    this.available(provider);
    return this.exclusive(owner, provider, async () => {
      const record = await this.options.repository.getConnection(owner, provider);
      if (!record?.credentialRef) return { ok: false, message: "Plugin is not connected.", toolCount: 0 };
      try {
        const { client } = await this.client(owner, provider, true); const identity = await client.identity();
        await this.options.repository.saveConnection({ ...record, status: "CONNECTED", accountLogin: identity.login, error: null, checkedAt: new Date().toISOString() });
        return { ok: true, message: `Verified ${provider} account ${identity.login}.`, toolCount: 0 };
      } catch (error) {
        const message = error instanceof GitControlError ? error.message : "Token is invalid, expired, or the provider is unavailable.";
        await this.options.repository.saveConnection({ ...record, status: "ERROR", error: message, checkedAt: new Date().toISOString() });
        return { ok: false, message, toolCount: 0 };
      }
    });
  }
  async pluginState(owner: string, provider: RepositoryProviderId): Promise<PluginConnectionState> {
    const c = this.publicConnection(await this.options.repository.getConnection(owner, provider) ?? this.empty(owner, provider));
    return { pluginId: provider, status: c.status, accountLabel: c.accountLogin, connectedAt: c.connectedAt, lastHealthCheckAt: c.checkedAt, toolCount: 0, installedVersion: "1.0.0", latestVersion: "1.0.0", hasUpdate: false, error: c.error };
  }
  async repositories(owner: string, provider: LegacyRepositoryProviderId, page: number) { return (await this.client(owner, provider)).client.repositories(page); }
  private extended(client: GitProviderClient): RepositoryProviderAdapter {
    if (!client.list || !client.lookup || !client.targets || !client.createRepository) throw new GitControlError("PROVIDER_NOT_AVAILABLE", "This provider adapter does not support extended operations.", 409);
    return client as GitProviderClient & RepositoryProviderAdapter;
  }
  async listRepositories(owner: string, input: RepositoryListInput) { return this.extended((await this.client(owner, input.provider)).client).list(input); }
  async targets(owner: string, input: RepositoryTargetListInput) { return this.extended((await this.client(owner, input.provider)).client).targets(input); }
  async bindRepository(owner: string, projectPath: string, provider: RepositoryProviderId, repositoryId?: string) {
    if (!repositoryId && (provider === "github" || provider === "gitea")) return this.bind(owner, projectPath, provider);
    const root = await this.engine.root(projectPath), { client, record } = await this.client(owner, provider);
    if (!repositoryId) {
      // Same rule as the legacy providers: a saved default is selected automatically, otherwise the binding stays unbound.
      const saved = (await this.options.repository.listBindings(owner)).filter(isProviderBinding);
      const preferred = saved.find(b => b.projectPath === root && b.provider === provider && b.serverUrl === record.serverUrl && b.isDefault && b.repository);
      if (preferred) return preferred;
    }
    const repository = repositoryId ? await this.extended(client).lookup(repositoryId) : null;
    if (repository) {
      if (repository.id !== repositoryId) throw new GitControlError("REPOSITORY_CHANGED", "Repository identity changed. Select it again.", 409);
      await client.validateCloneUrl(repository.cloneUrl);
      if (!repository.permissions.pull) throw new GitControlError("INSUFFICIENT_PERMISSION", "Repository cannot be read by this account.", 403);
    }
    const id = `git_binding_${createHash("sha256").update(JSON.stringify([owner, root, provider, record.serverUrl, repository?.id ?? null])).digest("hex").slice(0, 32)}`;
    const existing = await this.options.repository.getBinding(owner, id);
    const binding: ProviderProjectBinding = { kind: "provider", id, ownerUserId: owner, projectPath: root, provider, serverUrl: record.serverUrl, repository, isDefault: existing?.kind === "provider" ? existing.isDefault ?? false : false };
    await this.options.repository.saveBinding(binding); return binding;
  }
  /** Local Git work never needs a provider. A project cloned from a Git URL keeps that origin binding. */
  async bindLocal(owner: string, projectPath: string): Promise<LocalProjectBinding | GitUrlProjectBinding> {
    const root = await this.engine.root(projectPath);
    const existing = (await this.options.repository.listBindings(owner)).filter(b => b.projectPath === root);
    const origin = existing.find((b): b is GitUrlProjectBinding => b.kind === "git-url");
    if (origin) return origin;
    const id = `git_local_${createHash("sha256").update(JSON.stringify([owner, root])).digest("hex").slice(0, 32)}`;
    const local = existing.find((b): b is LocalProjectBinding => b.kind === "local" && b.id === id);
    if (local) return local;
    const binding: LocalProjectBinding = { kind: "local", id, ownerUserId: owner, projectPath: root };
    await this.options.repository.saveBinding(binding); return binding;
  }
  async saveProjectBinding(binding: AnyProjectBinding) { await this.options.repository.saveBinding(binding); return binding; }
  async bindings(owner: string) { return this.options.repository.listBindings(owner); }
  async binding(owner: string, id: string): Promise<AnyProjectBinding> {
    const binding = await this.options.repository.getBinding(owner, id);
    if (!binding) throw new GitControlError("BINDING_NOT_FOUND", "Project repository binding was not found.", 404);
    if (isProviderBinding(binding)) {
      const connection = await this.options.repository.getConnection(owner, binding.provider);
      if (connection && connection.serverUrl !== binding.serverUrl) throw new GitControlError("SERVER_CHANGED", "Provider server changed. Select the repository again.", 409);
    }
    if (await this.engine.root(binding.projectPath) !== binding.projectPath) throw new GitControlError("PROJECT_CHANGED", "Project root changed. Select the project again.", 409);
    return binding;
  }
  private async providerBinding(owner: string, id: string): Promise<ProviderProjectBinding> {
    const binding = await this.binding(owner, id);
    if (!isProviderBinding(binding)) throw new GitControlError("PROVIDER_REQUIRED", "Choose a repository provider for this project first.", 409);
    return binding;
  }
  async bind(owner: string, projectPath: string, provider: LegacyRepositoryProviderId, fullName?: string) {
    const root = await this.engine.root(projectPath);
    const { client, record } = await this.client(owner, provider);
    if (!fullName) {
      const saved = (await this.options.repository.listBindings(owner)).filter(isProviderBinding);
      const defaultBinding = saved.find(b => b.projectPath === root && b.provider === provider && b.serverUrl === record.serverUrl && b.isDefault && b.repository);
      if (defaultBinding) return defaultBinding;
      const unboundId = `git_binding_${createHash("sha256").update(JSON.stringify([owner, root, provider, record.serverUrl, null])).digest("hex").slice(0, 32)}`;
      const existingUnbound = saved.find(b => b.id === unboundId);
      if (existingUnbound) return existingUnbound;
      const unbound: ProviderProjectBinding = { kind: "provider", id: unboundId, ownerUserId: owner, projectPath: root, provider, serverUrl: record.serverUrl, repository: null, isDefault: false };
      await this.options.repository.saveBinding(unbound);
      return unbound;
    }
    const repository = await client.repository(fullName);
    if (repository) { await client.validateCloneUrl(repository.cloneUrl); if (!repository.permissions.pull) throw new GitControlError("INSUFFICIENT_PERMISSION", "This repository cannot be read by the connected account.", 403); }
    const id = `git_binding_${createHash("sha256").update(JSON.stringify([owner, root, provider, record.serverUrl, repository?.id ?? null])).digest("hex").slice(0, 32)}`;
    const existing = await this.options.repository.getBinding(owner, id);
    const binding: ProviderProjectBinding = { kind: "provider", id, ownerUserId: owner, projectPath: root, provider, serverUrl: record.serverUrl, repository, isDefault: existing?.kind === "provider" ? existing.isDefault ?? false : false };
    await this.options.repository.saveBinding(binding); return binding;
  }
  async getProjectDefaults(owner: string, projectPath: string): Promise<ProjectDefaultRepositories> {
    const root = await this.engine.root(projectPath);
    const allBindings = (await this.options.repository.listBindings(owner)).filter(isProviderBinding);
    const states = await this.providers(owner);
    const entry = (provider: RepositoryProviderId): ProjectDefaultRepository => {
      const state = states.find(p => p.id === provider)!;
      const defaultBinding = allBindings.find(b => b.projectPath === root && b.provider === provider && b.serverUrl === state.connection.serverUrl && b.isDefault && b.repository);
      return { fullName: defaultBinding?.repository?.fullName ?? null, repository: defaultBinding?.repository ?? null, isDefault: Boolean(defaultBinding),
        active: state.enabled && state.connection.status === "CONNECTED" };
    };
    const defaults: ProjectDefaultRepositories["defaults"] = { github: entry("github"), gitea: entry("gitea") };
    for (const descriptor of repositoryProviderRegistry) if (descriptor.available) defaults[descriptor.id] = entry(descriptor.id);
    return { projectPath: root, defaults };
  }
  async setProjectDefault(owner: string, projectPath: string, provider: RepositoryProviderId, selection?: { fullName?: string | null; repositoryId?: string | null } | string | null) {
    const chosen = typeof selection === "object" && selection !== null ? selection : { fullName: selection ?? null };
    const root = await this.engine.root(projectPath);
    const { client, record } = await this.client(owner, provider);
    if (!chosen.fullName && !chosen.repositoryId) {
      if (typeof this.options.repository.setDefaultBinding === "function") {
        await this.options.repository.setDefaultBinding(owner, root, provider, null);
      } else {
        for (const b of (await this.options.repository.listBindings(owner)).filter(isProviderBinding)) {
          if (b.projectPath === root && b.provider === provider && b.isDefault) await this.options.repository.saveBinding({ ...b, isDefault: false });
        }
      }
      return { ok: true, isDefault: false, repository: null };
    }
    const repository = chosen.repositoryId ? await this.extended(client).lookup(chosen.repositoryId) : await client.repository(chosen.fullName!);
    if (chosen.repositoryId && repository.id !== chosen.repositoryId) throw new GitControlError("REPOSITORY_CHANGED", "Repository identity changed. Select it again.", 409);
    await client.validateCloneUrl(repository.cloneUrl);
    if (!repository.permissions.pull) throw new GitControlError("INSUFFICIENT_PERMISSION", "This repository cannot be read by the connected account.", 403);
    const id = `git_binding_${createHash("sha256").update(JSON.stringify([owner, root, provider, record.serverUrl, repository.id])).digest("hex").slice(0, 32)}`;
    const binding: ProviderProjectBinding = { kind: "provider", id, ownerUserId: owner, projectPath: root, provider, serverUrl: record.serverUrl, repository, isDefault: true };
    await this.options.repository.saveBinding(binding);
    if (typeof this.options.repository.setDefaultBinding === "function") {
      await this.options.repository.setDefaultBinding(owner, root, provider, id);
    }
    return { ok: true, isDefault: true, repository };
  }
  private comparison(binding: AnyProjectBinding): RemoteComparisonTarget | undefined {
    if (binding.kind === "git-url") return { url: binding.url };
    if (binding.kind === "local") return undefined;
    return binding.repository ? { url: binding.repository.cloneUrl, defaultBranch: binding.repository.defaultBranch } : undefined;
  }
  async status(owner: string, id: string) { const binding = await this.binding(owner, id); return this.engine.status(binding.projectPath, this.comparison(binding)); }
  async diff(owner: string, id: string, path: string, staged: boolean, remoteComparison = false) {
    const binding = await this.binding(owner, id);
    return this.engine.diff(binding.projectPath, path, staged, this.comparison(binding), remoteComparison);
  }

  /** Credentials for a Git URL binding come only from a connected provider whose server still matches the URL. */
  private async gitUrlEnvironment(owner: string, binding: GitUrlProjectBinding, write: boolean) {
    if (binding.provider) {
      const connection = await this.client(owner, binding.provider).catch(() => null);
      if (connection) {
        const remote = await connection.client.validateCloneUrl(binding.url).catch(() => null);
        if (remote === binding.url) {
          await this.initialize();
          return createGitEnvironment(this.policy, this.options.credentialRoot, remote, connection.token, repositoryGitLogin(binding.provider, connection.record.accountLogin!));
        }
      }
    }
    if (write) throw new GitControlError("PROVIDER_REQUIRED", "Connect and enable the provider that hosts this repository to push.", 409);
    return createAnonymousGitEnvironment(this.policy, this.options.credentialRoot, binding.url);
  }
  async gitUrlCloneEnvironment(owner: string, url: string): Promise<{ env: NodeJS.ProcessEnv; provider: RepositoryProviderId | null }> {
    const states = await this.providers(owner);
    for (const state of states) {
      if (!state.enabled || state.connection.status !== "CONNECTED" || !state.available) continue;
      const server = new URL(state.connection.serverUrl), target = new URL(url);
      if (server.origin !== target.origin || !target.pathname.startsWith(`${server.pathname.replace(/\/$/, "")}/`)) continue;
      const connection = await this.client(owner, state.id).catch(() => null);
      const remote = connection ? await connection.client.validateCloneUrl(url).catch(() => null) : null;
      if (!connection || remote !== url) continue;
      await this.initialize();
      return { env: await createGitEnvironment(this.policy, this.options.credentialRoot, remote, connection.token, repositoryGitLogin(state.id, connection.record.accountLogin!)), provider: state.id };
    }
    return { env: await createAnonymousGitEnvironment(this.policy, this.options.credentialRoot, url), provider: null };
  }
  async providerCloneEnvironment(owner: string, provider: RepositoryProviderId, repositoryId: string) {
    const connection = await this.client(owner, provider), repository = await this.extended(connection.client).lookup(repositoryId);
    if (repository.id !== repositoryId) throw new GitControlError("REPOSITORY_CHANGED", "Repository identity changed. Select it again.", 409);
    if (!repository.permissions.pull) throw new GitControlError("INSUFFICIENT_PERMISSION", "This repository cannot be read by the connected account.", 403);
    const remote = await connection.client.validateCloneUrl(repository.cloneUrl);
    await this.initialize();
    const env = await createGitEnvironment(this.policy, this.options.credentialRoot, remote, connection.token, repositoryGitLogin(provider, connection.record.accountLogin!));
    return { env, repository, remote, serverUrl: connection.record.serverUrl };
  }
  get urlPolicy() { return this.policy; }
  private async networkEnvironment(binding: ProjectRepositoryBinding<RepositoryProviderId>, connection: ConnectedRepositoryProvider) {
    if (!binding.repository) throw new GitControlError("REMOTE_REQUIRED", "Select a repository first.");
    const remote = await connection.client.validateCloneUrl(binding.repository.cloneUrl);
    await this.initialize();
    return createGitEnvironment(this.policy, this.options.credentialRoot, remote, connection.token, repositoryGitLogin(binding.provider, connection.record.accountLogin!));
  }
  private async validateNetworkConfiguration(root: string, remoteUrl?: string) {
    const rewrites = await runGit(root, ["config", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], { accepted: [0, 1, 128] });
    const pushUrl = await runGit(root, ["config", "--get", "remote.origin.pushurl"], { accepted: [0, 1, 128] });
    const unsafe = await runGit(root, ["config", "--get-regexp", "^http\\..+\\.(proxy|followredirects|curloptresolve|extraheader|sslverify)$|^filter\\..*\\.(clean|smudge|process)$|^remote\\.origin\\.(vcs|proxy)$|^core\\.gitproxy$"], { accepted: [0, 1, 128] });
    if (unsafe.trim()) throw new GitControlError("UNSAFE_REMOTE_CONFIG", "Repository configuration includes external filters or scoped network overrides. Resolve them before synchronization.", 409);
    if (rewrites.trim() || pushUrl.trim() && pushUrl.trim() !== remoteUrl) throw new GitControlError("UNSAFE_REMOTE_CONFIG", "Repository URL rewrites or a different push URL must be resolved before synchronization.", 409);
  }
  async previewPublish(owner: string, input: GitOperationInput) { return this.publisher.preview(owner, input); }
  async pendingPublishes(owner: string, projectPath: string) { return this.publisher.pending(owner, await this.engine.root(projectPath)); }
  async dismissPublish(owner: string, bindingId: string, operationId: string) { return this.publisher.dismiss(owner, bindingId, operationId); }
  async operate(owner: string, operation: GitOperation, input: GitOperationInput, author: { name: string; email: string }) {
    if (operation === "publish") return this.publisher.publish(owner, input);
    const network = ["clone", "fetch", "pull", "push", "commit-push"].includes(operation);
    const current = await this.binding(owner, input.bindingId);
    if (current.kind === "local") {
      if (network) throw new GitControlError("PROVIDER_REQUIRED", "Choose a repository provider to synchronize this project.", 409);
      const result = await this.engine.operate(current.projectPath, { operation, expectedVersion: input.expectedVersion, paths: input.paths, hunkId: input.hunkId, message: input.message, confirmed: input.confirmed, author });
      return { ...result, binding: current };
    }
    if (current.kind === "git-url") {
      if (operation === "clone") throw new GitControlError("INVALID_OPERATION", "Open a Git URL from the project picker to clone it.", 409);
      const comparison = this.comparison(current);
      if (network) await this.validateNetworkConfiguration(current.projectPath, current.url);
      const env = network ? await this.gitUrlEnvironment(owner, current, operation === "push" || operation === "commit-push") : undefined;
      const result = await this.engine.operate(current.projectPath, { operation, expectedVersion: input.expectedVersion, paths: input.paths, hunkId: input.hunkId, message: input.message, confirmed: input.confirmed, remoteUrl: network ? current.url : undefined, comparison, env, author });
      return { ...result, binding: current };
    }
    let binding: ProviderProjectBinding = current;
    const remoteClient = network ? await this.client(owner, binding.provider) : undefined;
    if (network && !binding.repository) throw new GitControlError("REMOTE_REQUIRED", "Select a repository first.");
    if (network && binding.repository) {
      const remote = remoteClient!.client.lookup ? await remoteClient!.client.lookup(binding.repository.id) : await remoteClient!.client.repository(binding.repository.fullName);
      if (!remote.permissions.pull || ["publish", "push", "commit-push"].includes(operation) && !remote.permissions.push) throw new GitControlError("INSUFFICIENT_PERMISSION", "Connected account lacks the required repository permission.", 403);
      if (remote.id !== binding.repository.id) throw new GitControlError("REPOSITORY_CHANGED", "Repository identity changed. Select it again.", 409);
      binding = { ...binding, repository: remote }; await this.options.repository.saveBinding(binding);
    }
    const remoteUrl = network && binding.repository ? await remoteClient!.client.validateCloneUrl(binding.repository.cloneUrl) : undefined;
    if (network) await this.validateNetworkConfiguration(binding.projectPath, remoteUrl);
    const env = remoteClient ? await this.networkEnvironment(binding, remoteClient) : undefined;
    const expectedVersion = input.expectedVersion;
    const result = await this.engine.operate(binding.projectPath, { operation, expectedVersion, paths: input.paths, hunkId: input.hunkId, message: input.message, confirmed: input.confirmed, remoteUrl, comparison: this.comparison(binding), env, author });
    return { ...result, binding };
  }
  async close() { await this.options.repository.close?.(); }
}
