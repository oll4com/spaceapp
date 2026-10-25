import type { CreateRemoteRepositoryInput, GitRemoteRepository, RepositoryListInput, RepositoryProviderAdapter, RepositoryTarget, RepositoryTargetListInput } from "@space/contracts";
import { AdapterBase, array, invalid, object, permission, repositoryName, requiredTarget, text } from "./base.js";
import { GitControlError } from "../errors.js";
const namespace = "2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87";
const version = { "api-version": "7.1" };
function guid(value: string): string { if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new GitControlError("INVALID_REPOSITORY", "A stable Azure identifier is required."); return value.toLowerCase(); }
export class AzureAdapter extends AdapterBase implements RepositoryProviderAdapter {
  async identity() {
    const data = object(await this.data("/_apis/connectionData", "GET", undefined, { "api-version": "7.1-preview.1" }));
    const user = object(data.authenticatedUser); if (!user.id || user.isActive === false) throw new GitControlError("INVALID_TOKEN", "Azure did not verify an active account.", 401);
    return { login: text(user.providerDisplayName || user.customDisplayName || user.id), email: null };
  }
  private async allowed(project: string, repository: string | null, bit: number) {
    const tokens = `repoV2/${guid(project)}${repository ? `/${guid(repository)}` : ""}`;
    const data = await this.data(`/_apis/permissions/${namespace}/${bit}`, "GET", undefined, { ...version, tokens, alwaysAllowAdministrators: "false" });
    const values = array(Array.isArray(data) ? data : object(data).value);
    if (values.length !== 1 || typeof values[0] !== "boolean") invalid(); return values[0] === true;
  }
  private visibilities = new Map<string, Promise<"public" | "private">>();
  /** Shallow project/repository payloads omit visibility; read it from the existing project once. */
  private visibility(project: Record<string, any>): Promise<"public" | "private"> {
    if (project.visibility === "public" || project.visibility === "private") return Promise.resolve(project.visibility);
    const id = guid(text(project.id));
    let pending = this.visibilities.get(id);
    if (!pending) {
      pending = this.data(`/_apis/projects/${id}`, "GET", undefined, version).then(value => {
        const visibility = object(value).visibility;
        if (visibility !== "public" && visibility !== "private") invalid();
        return visibility as "public" | "private";
      });
      pending.catch(() => this.visibilities.delete(id));
      this.visibilities.set(id, pending);
    }
    return pending;
  }
  private async map(value: unknown, probePermissions = true, knownVisibility?: "public" | "private"): Promise<GitRemoteRepository> {
    const r = object(value), project = object(r.project), id = guid(text(r.id)), projectId = guid(text(project.id));
    const [pull, push, admin] = probePermissions ? await Promise.all([2, 4, 8192].map(bit => this.allowed(projectId, id, bit))) : [false, false, false];
    const cloneUrl = this.clone(text(r.remoteUrl), true);
    // The documented create response has remoteUrl but no webUrl; both name the same repository page.
    const webUrl = typeof r.webUrl === "string" && r.webUrl ? this.clone(r.webUrl) : cloneUrl;
    const visibility = knownVisibility ?? await this.visibility(project);
    return { id, fullName: `${text(project.name)}/${text(r.name)}`, cloneUrl, webUrl,
      private: visibility !== "public", defaultBranch: typeof r.defaultBranch === "string" ? r.defaultBranch.replace(/^refs\/heads\//, "") : "main",
      permissions: { pull: !!pull && !r.isDisabled, push: !!push && !r.isDisabled && !r.isInMaintenance, admin: !!admin && !r.isDisabled } };
  }
  async lookup(id: string) { return this.map(await this.data(`/_apis/git/repositories/${guid(id)}`, "GET", undefined, version)); }
  async list(input: RepositoryListInput) {
    const path = input.targetId ? `/${guid(input.targetId)}/_apis/git/repositories` : "/_apis/git/repositories";
    // Azure's repository collection is not paginated. Preserve the common page contract locally.
    if (input.cursor) throw new GitControlError("INVALID_CURSOR", "Azure repository lists use page pagination.");
    const values = array(object(await this.data(path, "GET", undefined, version)).value).filter(v => !input.query || text(object(v).name).toLowerCase().includes(input.query.toLowerCase()));
    const page = input.page ?? 1; if (!Number.isInteger(page) || page < 1 || page > 1000) throw new GitControlError("INVALID_CURSOR", "Invalid repository page.");
    return { data: await Promise.all(values.slice((page - 1) * 50, page * 50).map(v => this.map(v))), nextPage: values.length > page * 50 ? page + 1 : null, nextCursor: null };
  }
  private async target(value: unknown): Promise<RepositoryTarget> {
    const p = object(value), id = guid(text(p.id));
    const [visibility, canCreateRepository] = await Promise.all([this.visibility(p), this.allowed(id, null, 256)]);
    return { id, provider: "azure-devops", kind: "project", name: text(p.name), visibility, canCreateRepository };
  }
  async targets(input: RepositoryTargetListInput) {
    if (input.parentId) requiredTarget();
    const page = await this.page("/_apis/projects", { ...version, "$top": 50, stateFilter: "wellFormed" }, input, "targets", "azure");
    return this.result(page, await Promise.all(page.values.map(v => this.target(v))));
  }
  async createRepository(input: CreateRemoteRepositoryInput) {
    if (!input.targetId) requiredTarget(); const id = guid(input.targetId), name = repositoryName(input.name);
    const target = await this.target(await this.data(`/_apis/projects/${id}`, "GET", undefined, version));
    if (!target.canCreateRepository) permission();
    if (input.private !== (target.visibility === "private")) throw new GitControlError("VISIBILITY_INHERITED", "Repository visibility is inherited from the selected Azure project.", 409);
    // Return the confirmed identity without another fallible read; visibility was verified on the target.
    return this.createRequest(`/${id}/_apis/git/repositories`, { name, project: { id } }, data => this.map(data, false, target.visibility), version);
  }
}
