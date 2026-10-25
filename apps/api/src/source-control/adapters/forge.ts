import type { CreateRemoteRepositoryInput, GitRemoteRepository, RepositoryListInput, RepositoryProviderAdapter, RepositoryTarget, RepositoryTargetListInput } from "@space/contracts";
import { AdapterBase, array, invalid, numericId, object, permission, repositoryName, requiredTarget, segment, text } from "./base.js";
import { GitControlError } from "../errors.js";

/** GitHub and the compatible Gitea/Forgejo APIs share mapping, never provider identity. */
export class ForgeAdapter extends AdapterBase implements RepositoryProviderAdapter {
  private async user() { return object(await this.data("/user")); }
  async identity() { const u = await this.user(); return { login: text(u.login), email: typeof u.email === "string" ? u.email : null }; }
  private map(value: unknown): GitRemoteRepository {
    const r = object(value); const disabled = r.archived === true || r.mirror === true;
    return { id: numericId(String(r.id)), fullName: text(r.full_name), cloneUrl: this.clone(text(r.clone_url)), webUrl: this.clone(text(r.html_url)),
      private: r.private === true, defaultBranch: typeof r.default_branch === "string" && r.default_branch || "main",
      permissions: { pull: r.permissions?.pull === true, push: !disabled && r.permissions?.push === true, admin: !disabled && r.permissions?.admin === true } };
  }
  async lookup(id: string) { return this.map(await this.data(`/repositories/${numericId(id)}`)); }
  async repository(fullName: string) { const parts = fullName.split("/"); if (parts.length !== 2) throw new GitControlError("INVALID_REPOSITORY", "Invalid repository name."); return this.map(await this.data(`/repos/${parts.map(segment).join("/")}`)); }
  async repositories(page: number) { return (await this.list({ provider: this.provider, page })).data; }
  async list(input: RepositoryListInput) {
    let path = "/user/repos"; const alternates: string[] = [];
    if (input.targetId) {
      const target = await this.target(input.targetId); path = target.kind === "user" ? "/user/repos" : `/orgs/${segment(target.name)}/repos`;
      // GitHub's Link header names the organization by numeric ID.
      if (target.kind === "organization" && this.provider === "github") alternates.push(`/organizations/${numericId(target.id.slice("organization:".length))}/repos`);
    }
    // These list endpoints have no name filter, so a search scans pages until one has matches (bounded) and
    // returns the cursor of the last page it read; "Load more" continues from there.
    const params = { [this.provider === "github" ? "per_page" : "limit"]: 50 }, context = [input.targetId ?? null, input.query ?? ""];
    const owner = input.targetId?.startsWith("user:") ? text((await this.user()).login).toLowerCase() : null;
    const needle = input.query?.toLowerCase();
    let request: { page?: number; cursor?: string } = { page: input.page, cursor: input.cursor }, data: GitRemoteRepository[] = [];
    let page: Awaited<ReturnType<AdapterBase["page"]>> | undefined;
    for (let scanned = 0; scanned < (needle ? 10 : 1); scanned++) {
      page = await this.page(path, params, request, context, "array", alternates);
      data.push(...page.values.map(v => this.map(v)).filter(r => (!owner || r.fullName.split("/")[0]?.toLowerCase() === owner) && (!needle || r.fullName.toLowerCase().includes(needle))));
      if (data.length || !page.nextCursor) break;
      request = { cursor: page.nextCursor };
    }
    return this.result(page!, data);
  }
  private async organizationPermission(login: string, user: string): Promise<boolean> {
    if (this.provider !== "github") return object(await this.data(`/users/${segment(user)}/orgs/${segment(login)}/permissions`)).can_create_repository === true;
    const member = object(await this.data(`/user/memberships/orgs/${segment(login)}`));
    if (member.state !== "active") return false;
    if (member.role === "admin") return true;
    const org = object(await this.data(`/orgs/${segment(login)}`));
    return org.members_can_create_repositories === true || org.members_can_create_private_repositories === true || org.members_can_create_public_repositories === true;
  }
  async targets(input: RepositoryTargetListInput) {
    if (input.parentId) return this.result({ nextPage: null, nextCursor: null }, [] as RepositoryTarget[]);
    const user = await this.user(); const login = text(user.login);
    const page = await this.page("/user/orgs", { [this.provider === "github" ? "per_page" : "limit"]: 50 }, input, "targets");
    const data: RepositoryTarget[] = [];
    if (!input.cursor) data.push({ id: `user:${numericId(String(user.id))}`, provider: this.provider, kind: "user", name: login, canCreateRepository: true });
    for (const v of page.values) {
      const org = object(v); const name = text(org.login || org.username || org.name);
      let canCreateRepository = false;
      try { canCreateRepository = await this.organizationPermission(name, login); } catch (e) { if (!(e instanceof GitControlError) || ![403, 404].includes(e.statusCode)) throw e; }
      data.push({ id: `organization:${numericId(String(org.id))}`, provider: this.provider, kind: "organization", name, canCreateRepository });
    }
    return this.result(page, data);
  }
  private async target(id: string): Promise<RepositoryTarget> {
    if (!/^(user|organization):[1-9][0-9]*$/.test(id)) requiredTarget();
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await this.targets({ provider: this.provider, cursor }); const target = page.data.find(t => t.id === id); if (target) return target;
      if (!page.nextCursor) requiredTarget(); cursor = page.nextCursor;
    }
    return invalid("PROVIDER_LIMIT", "Target enumeration exceeded its limit.");
  }
  async createRepository(input: CreateRemoteRepositoryInput) {
    const name = repositoryName(input.name);
    const target = input.targetId ? await this.target(input.targetId) : null;
    if (target && !target.canCreateRepository) permission();
    if (target?.kind === "organization" && this.provider === "github") {
      const user = await this.user(); const member = object(await this.data(`/user/memberships/orgs/${segment(target.name)}`));
      const org = object(await this.data(`/orgs/${segment(target.name)}`));
      if (member.state !== "active" || member.role !== "admin" && org[input.private ? "members_can_create_private_repositories" : "members_can_create_public_repositories"] === false) permission();
      text(user.login);
    }
    return this.createRequest(target?.kind === "organization" ? `/orgs/${segment(target.name)}/repos` : "/user/repos", {
      name, private: input.private, auto_init: false, ...(this.provider === "github" ? {} : { default_branch: "main" })
    }, data => this.map(data));
  }
  async create(name: string, privateRepo: boolean) { return this.createRepository({ name, private: privateRepo }); }
}
