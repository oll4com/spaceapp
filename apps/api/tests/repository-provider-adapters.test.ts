import { describe, expect, it } from "vitest";
import * as providers from "../src/source-control/providers.js";
import type { RepositoryProviderId, RepositoryProviderAdapter } from "@space/contracts";

const policy = new providers.ProviderUrlPolicy();
type Reply = { data: unknown; headers?: Record<string, string> };
type RequestFixture = (url: URL, authorization: string, method: string, body?: unknown) => Reply | Promise<Reply>;
function adapter(provider: RepositoryProviderId, server: string, fixture: RequestFixture, email?: string): RepositoryProviderAdapter {
  return providers.createRepositoryProvider(provider, server, { token: "fixture-token", email }, policy, async (...args) => ({ headers: {}, ...await fixture(...args) }));
}
const forgeRepo = (host: string, id = 42) => ({ id, full_name: "team/repo", clone_url: `https://${host}/team/repo.git`, html_url: `https://${host}/team/repo`, private: true, default_branch: "main", permissions: { pull: true, push: false, admin: false } });
describe("repository adapter contract", () => {
  it.each(["github", "gitea", "forgejo"] as const)("%s keeps stable IDs and actual permissions with scoped pagination", async provider => {
    const host = provider === "github" ? "github.com" : "forge.example.test";
    const api = provider === "github" ? "https://api.github.com" : `https://${host}/api/v1`;
    const calls: string[] = [];
    const a = adapter(provider, `https://${host}`, (url, auth) => {
      calls.push(url.toString()); expect(auth).toBe(`${provider === "github" ? "Bearer" : "token"} fixture-token`);
      if (url.pathname.endsWith("/repositories/42")) return { data: forgeRepo(host) };
      expect(url.pathname).toBe(provider === "github" ? "/user/repos" : "/api/v1/user/repos");
      return url.searchParams.get("page") === "2" ? { data: [forgeRepo(host, 43)] } : { data: [forgeRepo(host)], headers: { link: `<${api}/user/repos?page=2&${provider === "github" ? "per_page" : "limit"}=50>; rel="next"` } };
    });
    const first = await a.list({ provider }); expect(first.data[0]?.permissions).toEqual({ pull: true, push: false, admin: false });
    expect(first.nextCursor).toBeTypeOf("string");
    expect((await a.list({ provider, cursor: first.nextCursor! })).data[0]?.id).toBe("43");
    expect((await a.lookup("42")).id).toBe("42");
    expect(calls).toHaveLength(3);
    await expect(a.list({ provider, cursor: first.nextCursor!, query: "different" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  it("rejects foreign or cross-endpoint pagination before transferring credentials", async () => {
    const a = adapter("github", "https://github.com", () => ({ data: [forgeRepo("github.com")], headers: { link: '<https://evil.invalid/user/repos?page=2>; rel="next"' } }));
    await expect(a.list({ provider: "github" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  it.each(["gitea", "forgejo"] as const)("%s explicitly chooses an existing organization for create", async provider => {
    const a = adapter(provider, "https://forge.example.test", (url, _auth, method, body) => {
      if (url.pathname.endsWith("/user")) return { data: { id: 1, login: "me" } };
      if (url.pathname.endsWith("/user/orgs")) return { data: [{ id: 9, username: "team" }] };
      if (url.pathname.endsWith("/users/me/orgs/team/permissions")) return { data: { is_owner: true, can_create_repository: true } };
      if (method === "POST") { expect(url.pathname).toBe("/api/v1/orgs/team/repos"); expect(body).toMatchObject({ name: "repo", private: true, auto_init: false }); return { data: forgeRepo("forge.example.test") }; }
      throw new Error(`Unexpected fixture path ${url.pathname}`);
    });
    expect((await a.createRepository({ name: "repo", private: true, targetId: "organization:9" })).id).toBe("42");
  });
  it("GitLab uses numeric namespace IDs, nested names and effective project permissions", async () => {
    const repo = { id: 71, path_with_namespace: "group/subgroup/repo", http_url_to_repo: "https://git.example.test/gitlab/group/subgroup/repo.git", web_url: "https://git.example.test/gitlab/group/subgroup/repo", visibility: "private", archived: false, repository_access_level: "enabled", default_branch: "main", permissions: { project_access: null, group_access: { access_level: 30 } } };
    const a = adapter("gitlab", "https://git.example.test/gitlab", (url, auth, method, body) => {
      expect(auth).toBe("Bearer fixture-token"); expect(url.pathname.startsWith("/gitlab/api/v4/")).toBe(true);
      if (method === "POST") { expect(body).toMatchObject({ namespace_id: 29, path: "repo", visibility: "private", initialize_with_readme: false }); return { data: repo }; }
      if (url.pathname.endsWith("/user")) return { data: { id: 1, username: "me" } };
      if (url.pathname.endsWith("/groups/29/members/all/1")) return { data: { id: 1, access_level: 30 } };
      if (url.pathname.endsWith("/namespaces/29")) return { data: { id: 29, kind: "group", full_path: "group/subgroup", parent_id: 12 } };
      if (url.pathname.endsWith("/groups/29")) return { data: { id: 29, full_path: "group/subgroup", project_creation_level: "developer" } };
      if (url.pathname.endsWith("/projects/71")) return { data: repo };
      expect(url.searchParams.get("search")).toBe("repo"); return { data: [repo], headers: { "x-next-page": "2" } };
    });
    const page = await a.list({ provider: "gitlab", query: "repo", targetId: "29" }); expect(page.nextPage).toBe(2);
    expect(page.data[0]).toMatchObject({ id: "71", fullName: "group/subgroup/repo", permissions: { pull: true, push: true, admin: false } });
    expect((await a.lookup("71")).fullName).toBe("group/subgroup/repo");
    expect((await a.createRepository({ name: "repo", private: true, targetId: "29" })).id).toBe("71");
  });
  it("Bitbucket separates email API auth from Git login and requires an existing project", async () => {
    const a = adapter("bitbucket", "https://bitbucket.org", () => ({ data: {} }), "person@example.invalid");
    await expect(a.createRepository({ name: "repo", private: true })).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
    expect(providers.repositoryGitLogin("bitbucket", "person")).toBe("x-bitbucket-api-token-auth");
  });
  it.each([
    ["gitlab", "https://git.example.test/base", "https://git.example.test/other/team/repo.git"],
    ["azure-devops", "https://dev.azure.com/owned", "https://dev.azure.com/foreign/project/_git/repo"],
    ["github", "https://github.com", "https://token@github.com/team/repo.git"],
    ["bitbucket", "https://bitbucket.org", "https://bitbucket.org/team/repo.git?token=x"]
  ] as const)("%s rejects clone URL boundary mismatch", async (id, server, url) => {
    const a = adapter(id, server, () => ({ data: {} }), "person@example.invalid");
    await expect(a.validateCloneUrl(url)).rejects.toMatchObject({ code: "REMOTE_MISMATCH" });
  });
});

describe("adapter create identity and personal namespace regressions", () => {
  const r = { id: 88, path_with_namespace: "me/repo", http_url_to_repo: "https://gitlab.com/me/repo.git", web_url: "https://gitlab.com/me/repo", visibility: "private", default_branch: "main" };
  it("lists a personal GitLab namespace using its username instead of treating the namespace ID as a group", async () => {
    const a = adapter("gitlab", "https://gitlab.com", url => {
      if (url.pathname === "/api/v4/namespaces/77") return { data: { id: 77, kind: "user", path: "me", full_path: "me" } };
      expect(url.pathname).toBe("/api/v4/users/me/projects"); return { data: [{ ...r, permissions: { project_access: { access_level: 50 }, group_access: null } }] };
    });
    expect((await a.list({ provider: "gitlab", targetId: "77" })).data[0]?.id).toBe("88");
  });
  it("returns a confirmed GitLab create identity before any fallible permission refresh", async () => {
    let posted = false;
    const a = adapter("gitlab", "https://gitlab.com", (url, _auth, method) => {
      if (posted) throw new Error("Post-create permission refresh unavailable");
      if (method === "POST") { posted = true; return { data: r }; }
      expect(url.pathname).toBe("/api/v4/user"); return { data: { id: 1, username: "me", can_create_project: true } };
    });
    const result = await a.createRepository({ name: "repo", private: true });
    expect(result).toMatchObject({ id: "88", permissions: { push: false, admin: false } });
  });
});
