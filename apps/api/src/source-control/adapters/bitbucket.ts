import type { CreateRemoteRepositoryInput, GitRemoteRepository, RepositoryListInput, RepositoryPage, RepositoryProviderAdapter, RepositoryTarget, RepositoryTargetListInput } from "@space/contracts";
import { AdapterBase, array, invalid, object, repositoryName, requiredTarget, segment, text } from "./base.js";
import { GitControlError } from "../errors.js";
function uuid(value: string): string { if (!/^\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/i.test(value)) throw new GitControlError("INVALID_REPOSITORY", "A stable Bitbucket UUID is required."); return value; }
export class BitbucketAdapter extends AdapterBase implements RepositoryProviderAdapter {
  async identity() { const u = object(await this.data("/user")); text(u.uuid); return { login: text(u.nickname || u.display_name || u.uuid), email: null }; }
  private map(value: unknown, permission: string): GitRemoteRepository {
    const r = object(value), ws = object(r.workspace);
    const clone = array(r.links?.clone).map(object).find(c => c.name === "https");
    return { id: `${uuid(text(ws.uuid))}/${uuid(text(r.uuid))}`, fullName: text(r.full_name), cloneUrl: this.clone(text(clone?.href), true), webUrl: this.clone(text(r.links?.html?.href)),
      private: r.is_private === true, defaultBranch: typeof r.mainbranch?.name === "string" && r.mainbranch.name ? r.mainbranch.name : "main", permissions: { pull: ["read", "write", "admin"].includes(permission), push: ["write", "admin"].includes(permission), admin: permission === "admin" } };
  }
  private async workspaceAdmin(id: string) {
    const p = object(await this.data(`/user/workspaces/${segment(uuid(id))}/permission`));
    return p.permission === "owner";
  }
  async targets(input: RepositoryTargetListInput) {
    if (!input.parentId) {
      const page = await this.page("/user/workspaces", { pagelen: 50 }, input, "workspaces", "values");
      return this.result(page, page.values.map(v => { const r = object(v), w = object(r.workspace); return { id: uuid(text(w.uuid)), provider: "bitbucket" as const, kind: "workspace" as const, name: text(w.name || w.slug), canCreateRepository: false }; }));
    }
    const ws = uuid(input.parentId), admin = await this.workspaceAdmin(ws);
    const page = await this.page(`/workspaces/${segment(ws)}/projects`, { pagelen: 50 }, input, ["projects", ws], "values");
    return this.result(page, page.values.map(v => { const p = object(v); return { id: `${ws}/${uuid(text(p.uuid))}`, provider: "bitbucket" as const, kind: "project" as const, parentId: ws, name: text(p.name || p.key), canCreateRepository: admin, createPermission: admin ? "allowed" as const : "unknown" as const }; }));
  }
  async lookup(id: string) {
    const parts = id.split("/"); if (parts.length !== 2) requiredTarget(); const ws = uuid(parts[0]!), repo = uuid(parts[1]!);
    const r = await this.data(`/repositories/${segment(ws)}/${segment(repo)}`);
    const page = await this.page(`/user/workspaces/${segment(ws)}/permissions/repositories`, { pagelen: 50, q: `repository.uuid="${repo}"` }, {}, ["lookup", ws, repo], "values");
    const grant = page.values.map(object).find(p => p.repository?.uuid === repo);
    return this.map(r, typeof grant?.permission === "string" ? grant.permission : "unknown");
  }
  async list(input: RepositoryListInput): Promise<RepositoryPage<GitRemoteRepository>> {
    if (!input.targetId) return this.allWorkspaces(input);
    const parts = input.targetId.split("/"); if (parts.length > 2) requiredTarget(); const ws = uuid(parts[0]!);
    const filters: string[] = [];
    if (parts[1]) filters.push(`repository.project.uuid="${uuid(parts[1])}"`);
    if (input.query) filters.push(`repository.name~${JSON.stringify(input.query)}`);
    const page = await this.page(`/user/workspaces/${segment(ws)}/permissions/repositories`, { pagelen: 50, q: filters.length ? filters.join(" AND ") : undefined }, input, [input.targetId, input.query ?? ""], "values");
    const data: GitRemoteRepository[] = [];
    for (const v of page.values) {
      const p = object(v), r = object(p.repository);
      const details = r.links?.clone ? r : await this.data(`/repositories/${segment(ws)}/${segment(uuid(text(r.uuid)))}`);
      const mapped = this.map(details, text(p.permission)); if (!mapped.id.startsWith(`${ws}/`)) invalid(); data.push(mapped);
    }
    return this.result(page, data);
  }
  private async allWorkspaces(input: RepositoryListInput): Promise<RepositoryPage<GitRemoteRepository>> {
    let state: { workspaceCursor?: string; index: number; repositoryCursor?: string; query: string; kind: string } = { index: 0, query: input.query ?? "", kind: "bitbucket-all" };
    const fail = (): never => { throw new GitControlError("INVALID_CURSOR", "Pagination cursor does not match this request."); };
    if (input.page !== undefined && input.page !== 1 || input.page !== undefined && input.cursor) fail();
    if (input.cursor) { try { state = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); } catch { fail(); } }
    if (state.kind !== "bitbucket-all" || state.query !== (input.query ?? "") || !Number.isInteger(state.index) || state.index < 0 || state.index > 49 || input.cursor && input.cursor.length > 4096 || state.workspaceCursor !== undefined && typeof state.workspaceCursor !== "string" || state.repositoryCursor !== undefined && typeof state.repositoryCursor !== "string") fail();
    const workspaces = await this.targets({ provider: "bitbucket", cursor: state.workspaceCursor });
    const workspace = workspaces.data[state.index];
    if (!workspace) { if (state.index !== 0) fail(); return { data: [], nextPage: null, nextCursor: workspaces.nextCursor ? Buffer.from(JSON.stringify({ ...state, workspaceCursor: workspaces.nextCursor })).toString("base64url") : null }; }
    const page = await this.list({ provider: "bitbucket", targetId: workspace.id, query: input.query, cursor: state.repositoryCursor });
    let next: typeof state | null;
    if (page.nextCursor) next = { ...state, repositoryCursor: page.nextCursor };
    else if (state.index + 1 < workspaces.data.length) next = { ...state, index: state.index + 1, repositoryCursor: undefined };
    else next = workspaces.nextCursor ? { ...state, index: 0, workspaceCursor: workspaces.nextCursor, repositoryCursor: undefined } : null;
    return { data: page.data, nextPage: null, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null };
  }
  async createRepository(input: CreateRemoteRepositoryInput) {
    const parts = input.targetId?.split("/"); if (!parts || parts.length !== 2) requiredTarget();
    const ws = uuid(parts[0]!), projectId = uuid(parts[1]!), name = repositoryName(input.name);
    const project = object(await this.data(`/workspaces/${segment(ws)}/projects/${segment(projectId)}`));
    if (project.uuid !== projectId) requiredTarget();
    // Bitbucket does not expose effective project-create permission to all callers.
    // The explicitly requested POST is authoritative; never infer it from workspace membership.
    return this.createRequest(`/repositories/${segment(ws)}/${segment(name)}`, { scm: "git", name, is_private: input.private, project: { key: text(project.key) } }, data => this.map(data, "unknown"));
  }
}
