import { createHash } from "node:crypto";
import type { GitOperationInput, ProviderProjectBinding, RepositoryProviderId, RepositoryTarget } from "@space/contracts";
import type { PersonalGitConnectionRecord, RepositoryPublishOperation, SourceControlRepository } from "@space/db";
import type { GitProviderClient } from "./providers.js";
import { GitEngine } from "./git-engine.js";
import { GitControlError } from "./errors.js";
import { repositoryName } from "./adapters/base.js";

type Binding = ProviderProjectBinding;
export interface ConnectedRepositoryProvider { record: PersonalGitConnectionRecord; token: string; client: GitProviderClient }
interface PublisherOptions {
  repository: SourceControlRepository; engine: GitEngine;
  binding(owner: string, id: string): Promise<Binding>;
  client(owner: string, provider: RepositoryProviderId): Promise<ConnectedRepositoryProvider>;
  validateConfiguration(root: string, remote?: string): Promise<void>;
  environment(binding: Binding, connection: ConnectedRepositoryProvider): Promise<NodeJS.ProcessEnv>;
}
/** A durable claim precedes POST. Only a confirmed response supplies ownership of a new remote. */
export class RepositoryPublisher {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private readonly options: PublisherOptions) {}
  private fingerprint(binding: Binding, input: GitOperationInput) {
    return createHash("sha256").update(JSON.stringify([binding.provider, binding.serverUrl, input.name, input.private, input.targetId ?? null])).digest("hex");
  }
  private async target(binding: Binding, connection: ConnectedRepositoryProvider, id?: string): Promise<RepositoryTarget | null> {
    if (!id) {
      if (binding.provider !== "github" && binding.provider !== "gitea") throw new GitControlError("TARGET_REQUIRED", "Select an existing target before publishing.");
      return null; // Legacy publish explicitly names a repo in the connected user's namespace.
    }
    if (!connection.client.targets) throw new GitControlError("PROVIDER_NOT_AVAILABLE", "Provider target selection is unavailable.", 409);
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await connection.client.targets({ provider: binding.provider, ...(binding.provider === "bitbucket" ? { parentId: id.split("/")[0] } : {}), cursor });
      const target = page.data.find(t => t.id === id);
      if (target) {
        if (!target.canCreateRepository && target.createPermission !== "unknown") throw new GitControlError("INSUFFICIENT_PERMISSION", "Account cannot create a repository in this target.", 403);
        return target;
      }
      if (!page.nextCursor) break; cursor = page.nextCursor;
    }
    throw new GitControlError("TARGET_REQUIRED", "Select an existing repository target.");
  }
  async preview(owner: string, input: GitOperationInput) {
    const binding = await this.options.binding(owner, input.bindingId), connection = await this.options.client(owner, binding.provider);
    if (!input.name) throw new GitControlError("NAME_REQUIRED", "Enter a repository name."); repositoryName(input.name);
    const snapshot = await this.options.engine.status(binding.projectPath);
    const comparison = binding.repository ? { url: binding.repository.cloneUrl, defaultBranch: binding.repository.defaultBranch } : undefined;
    if ((await this.options.engine.status(binding.projectPath, comparison)).version !== input.expectedVersion) throw new GitControlError("STALE_STATE", "Repository changed. Refresh the publish preview.", 409);
    const journal = await this.options.repository.getPublish(owner, binding.id);
    if (snapshot.remoteUrl && (!journal?.remote || snapshot.remoteUrl !== journal.remote.cloneUrl)) throw new GitControlError("REMOTE_EXISTS", "Project already has an origin. It has not been replaced.", 409);
    if (binding.repository && !journal) throw new GitControlError("REMOTE_EXISTS", "This binding already selects a repository. Use Fetch or Push.", 409);
    // A create recorded by another provider binding of this project must be resolved before a second remote is created.
    for (const other of await this.options.repository.listBindings(owner)) {
      if (other.id === binding.id || other.projectPath !== binding.projectPath) continue;
      const pending = await this.options.repository.getPublish(owner, other.id);
      if (pending && pending.state !== "rejected" && !(pending.remote && snapshot.remoteUrl === pending.remote.cloneUrl)) {
        throw new GitControlError("PUBLISH_CONFLICT", "Another publish for this project is pending or unconfirmed. Resolve it before creating a second remote.", 409);
      }
    }
    const target = await this.target(binding, connection, input.targetId);
    if (target?.visibility && input.private !== (target.visibility === "private")) throw new GitControlError("VISIBILITY_INHERITED", "Repository visibility is inherited from the selected project.", 409);
    await this.options.validateConfiguration(binding.projectPath, journal?.remote?.cloneUrl);
    return { provider: binding.provider, serverUrl: binding.serverUrl, targetId: target?.id ?? null, targetName: target?.name ?? connection.record.accountLogin,
      createPermission: target?.createPermission ?? "allowed", name: input.name, private: input.private, visibility: target?.visibility ?? (input.private ? "private" : "public"),
      hasCommits: !!snapshot.head, willCommit: false, willPush: false, expectedVersion: input.expectedVersion };
  }
  private serialized<T>(owner: string, projectPath: string, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([owner, projectPath]), previous = this.queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action); this.queues.set(key, operation);
    return operation.finally(() => { if (this.queues.get(key) === operation) this.queues.delete(key); });
  }
  /** Unresolved creates (unknown or interrupted) for every binding of a project, so the user can review them. */
  async pending(owner: string, projectPath: string) {
    const result = [];
    for (const binding of await this.options.repository.listBindings(owner)) {
      if (binding.projectPath !== projectPath || binding.kind !== "provider") continue;
      const journal = await this.options.repository.getPublish(owner, binding.id);
      if (journal && (journal.state === "unknown" || journal.state === "creating" || journal.state === "created" && !binding.repository)) {
        result.push({ bindingId: binding.id, provider: binding.provider, operationId: journal.operationId, state: journal.state, name: journal.name ?? null, createdAt: journal.createdAt });
      }
    }
    return result;
  }
  /**
   * After the user has checked the provider, an unconfirmed create can be marked as not created so a new,
   * explicitly reviewed publish is possible. A confirmed create is never dismissed.
   */
  async dismiss(owner: string, bindingId: string, operationId: string) {
    const binding = await this.options.binding(owner, bindingId);
    return this.serialized(owner, binding.projectPath, async () => {
      const journal = await this.options.repository.getPublish(owner, binding.id);
      if (!journal || journal.operationId !== operationId || journal.state !== "unknown" && journal.state !== "creating") throw new GitControlError("PUBLISH_NOT_DISMISSIBLE", "Only an unconfirmed publish can be dismissed.", 409);
      if (!await this.options.repository.dismissPublish(owner, binding.id, operationId)) throw new GitControlError("PUBLISH_NOT_DISMISSIBLE", "The publish outcome changed. Refresh and review it again.", 409);
      return { ok: true, bindingId: binding.id, operationId };
    });
  }
  async publish(owner: string, input: GitOperationInput) {
    // Different provider bindings can share one project root. Serialize per root so a second
    // publish re-reads origin after the first attaches it and never issues a second remote POST.
    const { projectPath } = await this.options.binding(owner, input.bindingId);
    return this.serialized(owner, projectPath, () => this.perform(owner, input));
  }
  private async perform(owner: string, input: GitOperationInput) {
    let binding = await this.options.binding(owner, input.bindingId);
    const connection = await this.options.client(owner, binding.provider), fingerprint = this.fingerprint(binding, input);
    let journal = await this.options.repository.getPublish(owner, binding.id);
    if (journal?.state === "rejected" && input.operationId && input.operationId !== journal.operationId && !journal.previousOperationIds?.includes(input.operationId)) journal = null;
    if (journal && (journal.fingerprint !== fingerprint || input.operationId && journal.operationId !== input.operationId)) throw new GitControlError("PUBLISH_CONFLICT", "This binding already has a different publish operation. Review its recorded outcome.", 409);
    const result = async (message: string, known: boolean) => ({ ok: false, remoteCreated: known, createOutcome: known ? "created" as const : "unknown" as const, committed: false, pushed: false, message, binding, snapshot: await this.options.engine.status(binding.projectPath, binding.repository ? { url: binding.repository.cloneUrl, defaultBranch: binding.repository.defaultBranch } : undefined) });
    const uncertain = () => result("Remote creation is unconfirmed or still in progress. No create was retried. Check the provider manually and select the verified repository; a matching name alone does not prove ownership.", false);
    if (journal?.state === "unknown" || journal?.state === "creating") return uncertain();
    if (journal?.state === "rejected") throw new GitControlError(journal.errorCode || "PROVIDER_FAILED", "The provider rejected this publish operation. Its outcome is recorded; no new create was attempted.", 409);
    const localVersion = (await this.options.engine.status(binding.projectPath)).version;
    if (!journal) {
      await this.preview(owner, input);
      journal = { ownerUserId: owner, bindingId: binding.id, operationId: input.operationId ?? binding.id, fingerprint, state: "creating", remote: null, errorCode: null, createdAt: new Date().toISOString(), name: input.name, targetId: input.targetId ?? null };
      if (!await this.options.repository.claimPublish(journal)) return uncertain();
      let remote;
      try {
        remote = connection.client.createRepository ? await connection.client.createRepository({ name: input.name!, private: input.private, targetId: input.targetId }) : await connection.client.create(input.name!, input.private);
      } catch (error) {
        // Only a definite refusal establishes that no repository was created: the request was never sent,
        // or the provider answered it with a 4xx other than a timeout.
        const code = error instanceof GitControlError ? error.code : "PROVIDER_UNAVAILABLE";
        const status = error instanceof GitControlError ? error.statusCode : 503;
        const rejected = error instanceof GitControlError && error.createNotSent === true
          || ["INVALID_TOKEN", "INSUFFICIENT_PERMISSION", "REPOSITORY_COLLISION", "RATE_LIMITED", "TARGET_REQUIRED", "INVALID_REPOSITORY", "VISIBILITY_INHERITED", "PROVIDER_REJECTED"].includes(code)
          || status >= 400 && status < 500 && status !== 408;
        await this.options.repository.finishPublish({ ...journal, state: rejected ? "rejected" : "unknown", errorCode: code });
        if (rejected) throw error;
        return uncertain();
      }
      // Adapters return sanitized metadata before any follow-up network read.
      // Persist immediately, before binding/initialization/attachment can fail.
      journal = { ...journal, state: "created", remote };
      await this.options.repository.finishPublish(journal);
    }
    if (!journal.remote) return uncertain();
    binding = { ...binding, repository: journal.remote };
    try {
      await this.options.repository.saveBinding(binding);
      const remote = connection.client.lookup ? await connection.client.lookup(journal.remote.id) : await connection.client.repository(journal.remote.fullName);
      if (remote.id !== journal.remote.id) throw new GitControlError("REPOSITORY_CHANGED", "Repository identity changed.", 409);
      if (!remote.permissions.pull) throw new GitControlError("INSUFFICIENT_PERMISSION", "The created repository cannot currently be read.", 403);
      await connection.client.validateCloneUrl(remote.cloneUrl);
      binding = { ...binding, repository: remote }; await this.options.repository.saveBinding(binding);
      const snapshot = await this.options.engine.status(binding.projectPath);
      if (snapshot.version !== localVersion) throw new GitControlError("STALE_STATE", "Project changed while creating the remote. Refresh before retrying.", 409);
      if (snapshot.remoteUrl && snapshot.remoteUrl !== remote.cloneUrl) throw new GitControlError("REMOTE_EXISTS", "Existing origin was not replaced.", 409);
      await this.options.validateConfiguration(binding.projectPath, remote.cloneUrl);
      if (!snapshot.initialized) await this.options.engine.operate(binding.projectPath, { operation: "initialize", expectedVersion: snapshot.version });
      const comparison = { url: remote.cloneUrl, defaultBranch: remote.defaultBranch };
      const env = await this.options.environment(binding, connection);
      const attached = await this.options.engine.operate(binding.projectPath, { operation: "publish", expectedVersion: (await this.options.engine.status(binding.projectPath, comparison)).version, remoteUrl: remote.cloneUrl, comparison, env });
      return { ...attached, remoteCreated: true, createOutcome: "created" as const, committed: false, pushed: false, binding,
        message: attached.snapshot.head ? "Remote created and bound. Existing commits were not pushed. Use Push explicitly." : "Empty remote created and bound. No files were staged or committed." };
    } catch {
      return result("Remote was created and its identity is saved, but local binding or fetch did not finish. Retry this operation to reuse the same remote. No files were committed or pushed.", true);
    }
  }
}
