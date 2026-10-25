import { describe, expect, it } from "vitest";
import * as providers from "../src/source-control/providers.js";
const projectId = "11111111-1111-4111-8111-111111111111", repoId = "22222222-2222-4222-8222-222222222222";
const ns = "2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87";
function fixture(visibility = "private", createAllowed = true) {
  let creates = 0;
  const repository = { id: repoId, name: "repo", project: { id: projectId, name: "Existing", visibility }, remoteUrl: "https://owned@dev.azure.com/owned/Existing/_git/repo", webUrl: "https://dev.azure.com/owned/Existing/_git/repo", defaultBranch: "refs/heads/main" };
  const a = providers.createRepositoryProvider("azure-devops", "https://dev.azure.com/owned", { token: "fixture" }, new providers.ProviderUrlPolicy(), async (url, auth, method, body) => {
    expect(auth).toBe("Basic OmZpeHR1cmU="); expect(url.pathname.startsWith("/owned/")).toBe(true);
    if (url.pathname.includes("/_apis/permissions/")) {
      expect(url.pathname).toContain(ns); expect(url.searchParams.get("tokens")).toMatch(new RegExp(`^repoV2/${projectId}(/${repoId})?$`));
      const bit = Number(url.pathname.split("/").at(-1)); return { data: { count: 1, value: [bit === 2 || bit === 256 && createAllowed] }, headers: {} };
    }
    if (url.pathname.endsWith("/_apis/projects")) return { data: { value: [{ id: projectId, name: "Existing", visibility }] }, headers: url.searchParams.has("continuationToken") ? {} : { "x-ms-continuationtoken": "next token" } };
    if (url.pathname.endsWith(`/_apis/projects/${projectId}`)) return { data: { id: projectId, name: "Existing", visibility }, headers: {} };
    if (method === "POST") { creates++; expect(url.pathname).toBe(`/owned/${projectId}/_apis/git/repositories`); expect(body).toEqual({ name: "repo", project: { id: projectId } }); return { data: repository, headers: {} }; }
    if (url.pathname.endsWith(`/_apis/git/repositories/${repoId}`)) return { data: repository, headers: {} };
    if (url.pathname.endsWith("/_apis/git/repositories")) return { data: { value: [repository] }, headers: {} };
    throw new Error(`Unexpected fixture path ${url.pathname}`);
  });
  return { a, creates: () => creates };
}
describe("Azure DevOps Services adapter", () => {
  it("paginates existing projects and evaluates actual caller permission", async () => {
    const { a } = fixture(); const first = await a.targets({ provider: "azure-devops" });
    expect(first.data[0]).toMatchObject({ id: projectId, kind: "project", canCreateRepository: true, visibility: "private" });
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await a.targets({ provider: "azure-devops", cursor: first.nextCursor! }); expect(second.nextCursor).toBeNull();
  });
  it("uses stable repository IDs and strips returned Git username without granting writes", async () => {
    const { a } = fixture(); const r = await a.lookup(repoId);
    expect(r).toMatchObject({ id: repoId, cloneUrl: "https://dev.azure.com/owned/Existing/_git/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: false, admin: false } });
    expect((await a.list({ provider: "azure-devops", query: "repo" })).data).toHaveLength(1);
  });
  it("creates only in the existing project and inherits its visibility", async () => {
    const { a, creates } = fixture(); expect((await a.createRepository({ name: "repo", targetId: projectId, private: true })).id).toBe(repoId); expect(creates()).toBe(1);
    const publicProject = fixture("public"); await expect(publicProject.a.createRepository({ name: "repo", targetId: projectId, private: true })).rejects.toMatchObject({ code: "VISIBILITY_INHERITED" }); expect(publicProject.creates()).toBe(0);
    const denied = fixture("private", false); await expect(denied.a.createRepository({ name: "repo", targetId: projectId, private: true })).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" }); expect(denied.creates()).toBe(0);
  });
});

describe("Azure confirmed create identity", () => {
  it("returns the new ID before a later permission probe can fail", async () => {
    let posted = false;
    const a = providers.createRepositoryProvider("azure-devops", "https://dev.azure.com/owned", { token: "fixture" }, new providers.ProviderUrlPolicy(), async (url, _auth, method) => {
      if (posted) throw new Error("Post-create permission refresh unavailable");
      if (method === "POST") { posted = true; return { data: { id: repoId, name: "repo", project: { id: projectId, name: "Existing", visibility: "private" }, remoteUrl: "https://dev.azure.com/owned/Existing/_git/repo", webUrl: "https://dev.azure.com/owned/Existing/_git/repo" }, headers: {} }; }
      return { data: url.pathname.includes("/permissions/") ? { value: [true] } : { id: projectId, name: "Existing", visibility: "private" }, headers: {} };
    });
    expect(await a.createRepository({ name: "repo", private: true, targetId: projectId })).toMatchObject({ id: repoId, permissions: { push: false, admin: false } });
  });
});

describe("Azure documented shallow responses", () => {
  it("returns the official create payload without webUrl or any post-create read", async () => {
    let posted = false;
    const a = providers.createRepositoryProvider("azure-devops", "https://dev.azure.com/fabrikam", { token: "fixture" }, new providers.ProviderUrlPolicy(), async (url, _auth, method) => {
      if (posted) throw new Error("No post-create requests allowed");
      if (method === "POST") {
        posted = true;
        return { data: { id: "7dcd24d7-3c3d-4e14-b9c0-14cb638f91e6", name: "AnotherRepository", url: "https://dev.azure.com/fabrikam/_apis/git/repositories/7dcd24d7-3c3d-4e14-b9c0-14cb638f91e6", project: { id: "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c", name: "Fabrikam-Fiber-Git", url: "https://dev.azure.com/fabrikam/_apis/projects/6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c", state: "wellFormed" }, remoteUrl: "https://dev.azure.com/fabrikam/Fabrikam-Fiber-Git/_git/AnotherRepository" }, headers: {} };
      }
      return { data: url.pathname.includes("/permissions/") ? { value: [true] } : { id: "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c", name: "Fabrikam-Fiber-Git", visibility: "public" }, headers: {} };
    });
    expect(await a.createRepository({ name: "AnotherRepository", private: false, targetId: "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c" })).toMatchObject({ id: "7dcd24d7-3c3d-4e14-b9c0-14cb638f91e6", private: false, webUrl: "https://dev.azure.com/fabrikam/Fabrikam-Fiber-Git/_git/AnotherRepository" });
  });
  it("hydrates shallow project discovery and repository visibility from the existing project", async () => {
    const a = providers.createRepositoryProvider("azure-devops", "https://dev.azure.com/owned", { token: "fixture" }, new providers.ProviderUrlPolicy(), async (url) => {
      if (url.pathname.includes("/permissions/")) return { data: { value: [true] }, headers: {} };
      if (url.pathname.endsWith("/_apis/projects")) return { data: { value: [{ id: projectId, name: "Existing", state: "wellFormed" }] }, headers: {} };
      if (url.pathname.endsWith(`/_apis/projects/${projectId}`)) return { data: { id: projectId, name: "Existing", visibility: "public" }, headers: {} };
      return { data: { id: repoId, name: "repo", project: { id: projectId, name: "Existing" }, remoteUrl: "https://dev.azure.com/owned/Existing/_git/repo", webUrl: "https://dev.azure.com/owned/Existing/_git/repo" }, headers: {} };
    });
    expect((await a.targets({ provider: "azure-devops" })).data[0]).toMatchObject({ id: projectId, visibility: "public", canCreateRepository: true });
    expect(await a.lookup(repoId)).toMatchObject({ id: repoId, private: false });
  });
});
