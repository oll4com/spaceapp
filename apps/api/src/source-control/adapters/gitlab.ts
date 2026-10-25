import type { CreateRemoteRepositoryInput, GitRemoteRepository, RepositoryListInput, RepositoryProviderAdapter, RepositoryTarget, RepositoryTargetListInput } from "@space/contracts";
import { AdapterBase, numericId, object, permission, repositoryName, segment, text } from "./base.js";
import { GitControlError } from "../errors.js";

export class GitLabAdapter extends AdapterBase implements RepositoryProviderAdapter {
  private async user() { return object(await this.data("/user")); }
  async identity() { const u = await this.user(); return { login: text(u.username), email: typeof u.email === "string" ? u.email : null }; }
  private map(value: unknown): GitRemoteRepository {
    const r = object(value), level = Math.max(Number(r.permissions?.project_access?.access_level || 0), Number(r.permissions?.group_access?.access_level || 0));
    const pull = r.repository_access_level !== "disabled" && (level >= 20 || r.visibility === "public" && r.repository_access_level !== "private");
    return { id: numericId(String(r.id)), fullName: text(r.path_with_namespace), cloneUrl: this.clone(text(r.http_url_to_repo)), webUrl: this.clone(text(r.web_url)),
      private: r.visibility !== "public", defaultBranch: typeof r.default_branch === "string" && r.default_branch ? r.default_branch : "main", permissions: { pull, push: pull && level >= 30 && !r.archived, admin: level >= 40 && !r.archived } };
  }
  async lookup(id: string) { return this.map(await this.data(`/projects/${numericId(id)}`)); }
  async list(input: RepositoryListInput) {
    const namespace = input.targetId ? object(await this.data(`/namespaces/${numericId(input.targetId)}`)) : null;
    const path = namespace ? namespace.kind === "user" ? `/users/${segment(text(namespace.path))}/projects` : `/groups/${numericId(input.targetId!)}/projects` : "/projects";
    const page = await this.page(path, { per_page: 50, membership: "true", search: input.query, ...(namespace && namespace.kind !== "user" ? { include_subgroups: "true", with_shared: "false" } : {}) }, input, [input.targetId ?? null, input.query ?? ""]);
    // Group/list payloads may omit permissions; stable lookup supplies effective access.
    const data: GitRemoteRepository[] = [];
    for (const value of page.values) { const r = object(value); data.push(r.permissions ? this.map(r) : await this.lookup(String(r.id))); }
    return this.result(page, data);
  }
  private async target(value: unknown): Promise<RepositoryTarget> {
    const n = object(value), id = numericId(String(n.id)), user = await this.user();
    let canCreateRepository = false;
    if (n.kind === "user") canCreateRepository = n.path === user.username && user.can_create_project !== false && (user.projects_limit === undefined || user.projects_limit > 0);
    else {
      const group = object(await this.data(`/groups/${id}`));
      let level = 0;
      try { level = Number(object(await this.data(`/groups/${id}/members/all/${numericId(String(user.id))}`)).access_level || 0); }
      catch (e) { if (!(e instanceof GitControlError) || ![403, 404].includes(e.statusCode)) throw e; }
      const threshold = group.project_creation_level === "developer" ? 30 : group.project_creation_level === "maintainer" ? 40 : group.project_creation_level === "owner" ? 50 : Infinity;
      canCreateRepository = !group.archived && level >= threshold;
    }
    return { id, provider: "gitlab", kind: n.kind === "user" ? "user" : "namespace", name: text(n.full_path || n.path), parentId: n.parent_id ? String(n.parent_id) : null, canCreateRepository };
  }
  async targets(input: RepositoryTargetListInput) {
    const path = input.parentId ? `/groups/${numericId(input.parentId)}/subgroups` : "/namespaces";
    const page = await this.page(path, { per_page: 50 }, input, ["targets", input.parentId ?? null]);
    return this.result(page, await Promise.all(page.values.map(v => this.target(v))));
  }
  async createRepository(input: CreateRemoteRepositoryInput) {
    const name = repositoryName(input.name);
    let namespaceId: number | undefined;
    if (input.targetId) { const target = await this.target(await this.data(`/namespaces/${numericId(input.targetId)}`)); if (!target.canCreateRepository) permission(); namespaceId = Number(target.id); }
    else { const u = await this.user(); if (u.can_create_project === false || u.projects_limit === 0) permission(); }
    return this.createRequest("/projects", { name, path: name, visibility: input.private ? "private" : "public", ...(namespaceId === undefined ? {} : { namespace_id: namespaceId }), initialize_with_readme: false }, data => this.map(object(data)));
  }
}
