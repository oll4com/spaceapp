import { describe, expect, it } from "vitest";
import * as providers from "../src/source-control/providers.js";
const ws = "{11111111-1111-4111-8111-111111111111}", project = "{22222222-2222-4222-8222-222222222222}", repo = "{33333333-3333-4333-8333-333333333333}";
function fixture(admin = true) {
  let creates = 0;
  const repository = { uuid: repo, full_name: "renamed-workspace/repo", is_private: true, workspace: { uuid: ws, slug: "renamed-workspace" }, project: { uuid: project, key: "EXISTING" }, mainbranch: { name: "main" }, links: { clone: [{ name: "https", href: "https://account@bitbucket.org/renamed-workspace/repo.git" }], html: { href: "https://bitbucket.org/renamed-workspace/repo" } } };
  const a = providers.createRepositoryProvider("bitbucket", "https://bitbucket.org", { email: "person@example.invalid", token: "fixture" }, new providers.ProviderUrlPolicy(), async (url, auth, method, body) => {
    expect(auth).toBe(`Basic ${Buffer.from("person@example.invalid:fixture").toString("base64")}`); expect(url.origin).toBe("https://api.bitbucket.org");
    const path = decodeURIComponent(url.pathname);
    if (path === "/2.0/user") return { data: { uuid: "{account}", display_name: "Account", nickname: "account" }, headers: {} };
    if (path === "/2.0/user/workspaces") return { data: { values: [{ workspace: { uuid: ws, slug: "renamed-workspace", name: "Workspace" }, administrator: admin }] }, headers: {} };
    if (path === `/2.0/user/workspaces/${ws}/permission`) return { data: { workspace: { uuid: ws }, permission: admin ? "owner" : "member" }, headers: {} };
    if (path === `/2.0/workspaces/${ws}/projects`) return { data: { values: [{ uuid: project, key: "EXISTING", name: "Existing project" }] }, headers: {} };
    if (path === `/2.0/workspaces/${ws}/projects/${project}`) return { data: { uuid: project, key: "EXISTING", name: "Existing project" }, headers: {} };
    if (path === `/2.0/user/workspaces/${ws}/permissions/repositories`) return { data: { values: [{ permission: "read", repository }], ...(url.searchParams.has("page") ? {} : { next: `${url.toString()}&page=2` }) }, headers: {} };
    if (method === "POST") { creates++; expect(path).toBe(`/2.0/repositories/${ws}/repo`); expect(body).toEqual({ scm: "git", name: "repo", is_private: true, project: { key: "EXISTING" } }); return { data: repository, headers: {} }; }
    if (path === `/2.0/repositories/${ws}/${repo}`) return { data: repository, headers: {} };
    throw new Error(`Unexpected fixture path ${path}`);
  });
  return { a, creates: () => creates };
}
describe("Bitbucket API token adapter", () => {
  it("discovers existing workspaces and projects without inventing create access for members", async () => {
    const { a } = fixture(); expect((await a.identity()).login).toBe("account");
    const workspaces = await a.targets({ provider: "bitbucket" }); expect(workspaces.data[0]).toMatchObject({ id: ws, kind: "workspace" });
    expect((await a.targets({ provider: "bitbucket", parentId: ws })).data[0]).toMatchObject({ id: `${ws}/${project}`, parentId: ws, kind: "project", canCreateRepository: true });
    const unknown = await fixture(false).a.targets({ provider: "bitbucket", parentId: ws }); expect(unknown.data[0]).toMatchObject({ canCreateRepository: false, createPermission: "unknown" });
  });
  it("paginates effective permissions, uses stable workspace/repository UUIDs and sanitizes clone links", async () => {
    const { a } = fixture(); const first = await a.list({ provider: "bitbucket", targetId: ws, query: "repo" });
    expect(first.data[0]).toMatchObject({ id: `${ws}/${repo}`, cloneUrl: "https://bitbucket.org/renamed-workspace/repo.git", permissions: { pull: true, push: false, admin: false } });
    expect(first.nextCursor).toBeTypeOf("string"); expect((await a.list({ provider: "bitbucket", targetId: ws, query: "repo", cursor: first.nextCursor! })).nextCursor).toBeNull();
    expect((await a.lookup(`${ws}/${repo}`)).id).toBe(`${ws}/${repo}`);
  });
  it("creates only with explicit existing project and keeps scoped-token Git login separate", async () => {
    const { a, creates } = fixture(); await expect(a.createRepository({ name: "repo", private: true, targetId: ws })).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
    expect((await a.createRepository({ name: "repo", private: true, targetId: `${ws}/${project}` })).id).toBe(`${ws}/${repo}`); expect(creates()).toBe(1);
    expect(providers.repositoryGitLogin("bitbucket", "account")).toBe("x-bitbucket-api-token-auth");
  });
});
