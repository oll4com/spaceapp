import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { repositoryProviderRegistry, type AnyProjectBinding, type GitRemoteRepository, type RepositoryProviderId, type OpenProjectInput, type OpenProjectResult, type ProjectSourceSummary, type ProviderProjectBinding } from "@space/contracts";
import { runGit } from "./git-engine.js";
import { GitControlError } from "./errors.js";
import type { SourceControlService } from "./service.js";

export type AuthorizePath = (path: string) => Promise<string>;
/** Who is asking: users without ADMIN/OPERATOR may only create or clone inside the projects root. */
export interface ProjectAccess { authorize: AuthorizePath; restricted: boolean }
const inside = (root: string, path: string) => { const offset = relative(root, path); return offset === "" || !offset.startsWith("..") && !isAbsolute(offset); };
type RemoteSource =
  | { kind: "git-url"; url: string; env: NodeJS.ProcessEnv; provider: RepositoryProviderId | null }
  | { kind: "provider"; env: NodeJS.ProcessEnv; repository: GitRemoteRepository; remote: string; serverUrl: string };
const folderName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const providerLabel = (id: string) => repositoryProviderRegistry.find(p => p.id === id)?.label ?? id;

/**
 * Creates, opens or clones a project folder on the Space runtime host. Create and clone never write into
 * a non-empty folder; a failed create/clone removes only the folder this request created.
 */
export class ProjectSourceOpener {
  private destinations = new Set<string>();
  constructor(private readonly service: SourceControlService, private readonly projectsRoot: string) {}

  async open(owner: string, input: OpenProjectInput, access: ProjectAccess | AuthorizePath): Promise<OpenProjectResult> {
    const { authorize, restricted } = typeof access === "function" ? { authorize: access, restricted: false } : access;
    if (input.source.kind === "local") return this.local(owner, input.source.path, authorize);
    const destination = input.destination!;
    // Validate the remote, its host and the account before anything is created on disk.
    const remote = await this.remote(owner, input);
    const target = await this.prepare(destination, authorize, restricted);
    if (this.destinations.has(target.path)) throw new GitControlError("DESTINATION_BUSY", "Another project is being created in this folder.", 409);
    this.destinations.add(target.path);
    try {
      return await this.populate(owner, input, target, remote, restricted);
    } catch (error) {
      if (target.created) await this.removeCreated(target.path);
      throw error;
    } finally { this.destinations.delete(target.path); }
  }

  /** Removes a folder this request created, never a symlink or a path that now resolves elsewhere. */
  private async removeCreated(path: string) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) return;
      await rm(path, { recursive: true, force: true });
    } catch { /* Keep the original error authoritative. */ }
  }

  private async remote(owner: string, input: OpenProjectInput): Promise<RemoteSource | null> {
    const source = input.source;
    if (source.kind === "git-url") {
      const url = this.service.urlPolicy.normalize(source.url);
      return { kind: "git-url", url, ...await this.service.gitUrlCloneEnvironment(owner, url) };
    }
    if (source.kind === "provider") return { kind: "provider", ...await this.service.providerCloneEnvironment(owner, source.provider, source.repositoryId) };
    return null;
  }
  private async populate(owner: string, input: OpenProjectInput, target: { path: string; created: boolean }, remote: RemoteSource | null, restricted: boolean): Promise<OpenProjectResult> {
    const source = input.source;
    // The folder is new or empty and reserved for this request. Git runs directly in it, so an enclosing
    // repository (for example /opt/spaceapp around /opt/spaceapp/projects) is never discovered or modified.
    if (source.kind === "new") {
      if (basename(target.path) !== source.name) throw new GitControlError("INVALID_DESTINATION", "The folder name must match the project name.");
      await runGit(target.path, ["init", "-b", "main"]);
      return this.result(target, await this.service.bindLocal(owner, target.path), { kind: "new", label: "New project", detail: null });
    }
    if (source.kind === "git-url" && remote?.kind === "git-url") {
      const { url, env, provider } = remote;
      await this.clone(target.path, url, env, provider === null, restricted);
      const id = `git_url_${createHash("sha256").update(JSON.stringify([owner, target.path, url])).digest("hex").slice(0, 32)}`;
      const binding = await this.service.saveProjectBinding({ kind: "git-url", id, ownerUserId: owner, projectPath: target.path, url, provider });
      const host = new URL(url);
      return this.result(target, binding, { kind: "git-url", label: provider ? `Git URL · ${providerLabel(provider)}` : "Git URL", detail: `${host.host}${host.pathname}` });
    }
    if (source.kind === "provider" && remote?.kind === "provider") {
      const { env, repository, serverUrl } = remote;
      await this.clone(target.path, remote.remote, env, false, restricted);
      const id = `git_binding_${createHash("sha256").update(JSON.stringify([owner, target.path, source.provider, serverUrl, repository.id])).digest("hex").slice(0, 32)}`;
      const binding: ProviderProjectBinding = { kind: "provider", id, ownerUserId: owner, projectPath: target.path, provider: source.provider, serverUrl, repository, isDefault: false };
      await this.service.saveProjectBinding(binding);
      return this.result(target, binding, { kind: "provider", label: providerLabel(source.provider), detail: repository.fullName });
    }
    throw new GitControlError("INVALID_INPUT", "Unknown project source.");
  }

  private async clone(path: string, url: string, env: NodeJS.ProcessEnv, anonymous: boolean, restricted: boolean) {
    if ((await readdir(path)).length) throw new GitControlError("NOT_EMPTY", "The destination folder is not empty. Choose a new or empty folder.", 409);
    try {
      // Without ADMIN/OPERATOR, checked-out symlinks become plain files so a clone cannot point outside the workspace.
      await runGit(path, ["clone", ...(restricted ? ["-c", "core.symlinks=false"] : []), "--no-recurse-submodules", "--", url, "."], { env, timeout: 120000 });
    } catch (error) {
      if (anonymous && error instanceof GitControlError && error.code === "GIT_FAILED" && /Authentication/.test(error.message)) {
        throw new GitControlError("AUTHENTICATION_REQUIRED", "The repository requires sign-in. Connect and enable its provider in Plugins, then try again.", 409);
      }
      throw error;
    }
  }

  private async local(owner: string, path: string, authorize: AuthorizePath): Promise<OpenProjectResult> {
    const root = await authorize(path);
    const info = await lstat(root);
    if (!info.isDirectory()) throw new GitControlError("INVALID_ROOT", "Choose a folder.");
    // Local selection never initializes, clones or changes the folder.
    const top = (await runGit(root, ["rev-parse", "--show-toplevel"], { accepted: [0, 128] })).trim();
    const repositoryRoot = top ? await realpath(top) : null;
    let binding: AnyProjectBinding | null = null, detail: string | null = repositoryRoot && repositoryRoot !== root ? `Inside repository ${repositoryRoot}` : null;
    if (!repositoryRoot || repositoryRoot === root) {
      // A folder Source Control cannot review (for example a linked worktree whose metadata lives elsewhere)
      // is still a valid project folder for a room; it simply has no binding.
      try { binding = await this.service.bindLocal(owner, root); }
      catch (error) { if (!(error instanceof GitControlError)) throw error; detail = `Source Control unavailable: ${error.message}`; }
    }
    return { projectPath: root, binding, created: false, repositoryRoot, source: { kind: "local", label: "Local folder", detail } };
  }

  private async prepare(destination: string, authorize: AuthorizePath, restricted: boolean): Promise<{ path: string; created: boolean }> {
    if (!isAbsolute(destination) || normalize(destination) !== destination || destination.endsWith("/")) throw new GitControlError("INVALID_DESTINATION", "Enter an absolute folder path.");
    const name = basename(destination);
    if (!folderName.test(name) || name.endsWith(".git")) throw new GitControlError("INVALID_DESTINATION", "Use a folder name with letters, numbers, dots, underscores or hyphens.");
    const parent = await authorize(dirname(destination));
    if (restricted) {
      const projects = await realpath(this.projectsRoot).catch(() => { throw new GitControlError("PROJECT_FORBIDDEN", "The projects folder is not available on this Space host.", 403); });
      if (!inside(projects, parent)) throw new GitControlError("PROJECT_FORBIDDEN", `Create and clone projects inside ${projects}.`, 403);
    }
    if (!(await lstat(parent)).isDirectory()) throw new GitControlError("INVALID_DESTINATION", "The parent location must be a folder.");
    const path = join(parent, name);
    let created = false;
    try {
      await mkdir(path, { mode: 0o775 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new GitControlError("INVALID_DESTINATION", "The destination must be a new or empty folder.", 409);
    // Re-check after creation: a parent swapped for a symlink in between must not move the write elsewhere.
    if (await realpath(path) !== path || await realpath(parent) !== parent) {
      if (created) await this.removeCreated(path);
      throw new GitControlError("INVALID_DESTINATION", "The destination changed while it was prepared. Try again.", 409);
    }
    if (!created && (await readdir(path)).length) throw new GitControlError("NOT_EMPTY", "The destination folder is not empty. Choose a new or empty folder.", 409);
    return { path, created };
  }

  private result(target: { path: string; created: boolean }, binding: AnyProjectBinding, source: ProjectSourceSummary): OpenProjectResult {
    return { projectPath: target.path, binding, source, created: target.created, repositoryRoot: target.path };
  }
}
