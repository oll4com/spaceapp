import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitRemoteRepository, RepositoryPage, RepositoryProviderAdapter, RepositoryProviderId } from "@space/contracts";
import * as providers from "../src/source-control/providers.js";
import { GitControlError } from "../src/source-control/errors.js";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { SourceControlService } from "../src/source-control/service.js";

/*
 * Phase 4 independent contract matrix. Every provider response below is shaped after the
 * official API reference extracts in reports/20261007-122825-repository-providers-phase1.
 * The fake exchange records every credentialed request so tests can prove what was NOT sent.
 */
const policy = new providers.ProviderUrlPolicy();
type Reply = { data: unknown; headers?: Record<string, string> };
interface Call { url: URL; authorization: string; method: string; body?: unknown }
type Route = (call: Call) => Reply | Promise<Reply>;
function harness(provider: RepositoryProviderId, server: string, route: Route, email = "person@example.invalid") {
  const calls: Call[] = [];
  const adapter = providers.createRepositoryProvider(provider, server, { token: "fixture-token", email }, policy, async (url, authorization, method, body) => {
    const call = { url: new URL(url.toString()), authorization, method, body }; calls.push(call);
    return { headers: {}, ...await route(call) };
  });
  return { adapter, calls };
}
function endpoint(url: URL, api: string): string {
  const prefix = new URL(api).pathname.replace(/\/$/, ""), path = decodeURIComponent(url.pathname);
  if (!path.startsWith(`${prefix}/`)) throw new Error(`Request left the API prefix: ${url}`);
  return path.slice(prefix.length);
}
const failure = (code: string, status: number) => new GitControlError(code, `fixture ${code}`, status);
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected a rejection");
}
async function collect<T>(load: (cursor?: string) => Promise<RepositoryPage<T>>, limit = 20): Promise<RepositoryPage<T>[]> {
  const pages: RepositoryPage<T>[] = []; let cursor: string | undefined;
  for (let i = 0; i < limit; i++) { const page = await load(cursor); pages.push(page); if (!page.nextCursor) return pages; cursor = page.nextCursor; }
  throw new Error("Pagination did not terminate");
}

// ---- provider fixtures -------------------------------------------------------------------
const FORGE = {
  github: { server: "https://github.com", api: "https://api.github.com", web: "https://github.com", size: "per_page", auth: "Bearer fixture-token" },
  gitea: { server: "https://forge.example.test/git", api: "https://forge.example.test/git/api/v1", web: "https://forge.example.test/git", size: "limit", auth: "token fixture-token" },
  forgejo: { server: "https://forgejo.example.test", api: "https://forgejo.example.test/api/v1", web: "https://forgejo.example.test", size: "limit", auth: "token fixture-token" }
} as const;
type ForgeId = keyof typeof FORGE;
const forgeRepo = (web: string, id: number, extra: Record<string, unknown> = {}) => ({ id, full_name: `team/repo-${id}`, clone_url: `${web}/team/repo-${id}.git`, html_url: `${web}/team/repo-${id}`, private: true, default_branch: "main", archived: false, permissions: { pull: true, push: true, admin: false }, ...extra });

const GL = { server: "https://git.example.test/gitlab", api: "https://git.example.test/gitlab/api/v4" };
const glRepo = (id: number, extra: Record<string, unknown> = {}) => ({ id, path_with_namespace: `group/sub/repo-${id}`, http_url_to_repo: `${GL.server}/group/sub/repo-${id}.git`, web_url: `${GL.server}/group/sub/repo-${id}`, visibility: "private", archived: false, repository_access_level: "enabled", default_branch: "main", permissions: { project_access: { access_level: 30 }, group_access: null }, ...extra });

const BB_API = "https://api.bitbucket.org/2.0";
const bbId = (n: number) => `{00000000-0000-4000-8000-${String(n).padStart(12, "0")}}`;
const WS = bbId(9001), WS2 = bbId(9002), PROJECT = bbId(8001), PROJECT2 = bbId(8002), REPO = bbId(1);
const bbRepo = (n: number, ws = WS, slug = "ws", extra: Record<string, unknown> = {}) => ({ type: "repository", uuid: bbId(n), name: `repo-${n}`, full_name: `${slug}/repo-${n}`, is_private: true, workspace: { type: "workspace", uuid: ws, slug }, project: { type: "project", uuid: PROJECT, key: "EXISTING" }, mainbranch: { type: "branch", name: "main" }, links: { clone: [{ name: "https", href: `https://account@bitbucket.org/${slug}/repo-${n}.git` }, { name: "ssh", href: `git@bitbucket.org:${slug}/repo-${n}.git` }], html: { href: `https://bitbucket.org/${slug}/repo-${n}` } }, ...extra });
const bbGrant = (n: number, permission: string) => ({ type: "repository_permission", permission, repository: { type: "repository", name: `repo-${n}`, full_name: `ws/repo-${n}`, uuid: bbId(n) } });

const AZ = "https://dev.azure.com/owned", AZ_NS = "2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87";
const azId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AZ_PROJECT = azId(7001), AZ_REPO = azId(1);
const azRepo = (n: number, extra: Record<string, unknown> = {}) => ({ id: azId(n), name: `repo-${n}`, project: { id: AZ_PROJECT, name: "Existing", state: "wellFormed", visibility: "private" }, remoteUrl: `https://owned@dev.azure.com/owned/Existing/_git/repo-${n}`, webUrl: `https://dev.azure.com/owned/Existing/_git/repo-${n}`, defaultBranch: "refs/heads/main", isDisabled: false, ...extra });
interface AzureOptions { bits?: Record<number, boolean>; visibility?: "private" | "public"; repo?: unknown; repos?: unknown[]; projects?: Route }
function azure(options: AzureOptions = {}) {
  const bits: Record<number, boolean> = { 2: true, 4: true, 8192: false, 256: true, ...options.bits };
  let posts = 0;
  const h = harness("azure-devops", AZ, call => {
    const { url, method } = call, path = url.pathname;
    if (path.startsWith(`/owned/_apis/permissions/${AZ_NS}/`)) return { data: { count: 1, value: [bits[Number(path.split("/").at(-1))] === true] } };
    if (path === "/owned/_apis/projects") return options.projects ? options.projects(call) : { data: { count: 1, value: [{ id: AZ_PROJECT, name: "Existing", state: "wellFormed", visibility: options.visibility ?? "private" }] } };
    if (path === `/owned/_apis/projects/${AZ_PROJECT}`) return { data: { id: AZ_PROJECT, name: "Existing", state: "wellFormed", visibility: options.visibility ?? "private" } };
    if (method === "POST") { posts++; return { data: azRepo(1, { project: { id: AZ_PROJECT, name: "Existing", visibility: options.visibility ?? "private" } }) }; }
    if (path === `/owned/_apis/git/repositories/${AZ_REPO}`) return { data: options.repo ?? azRepo(1) };
    if (path === "/owned/_apis/git/repositories" || path === `/owned/${AZ_PROJECT}/_apis/git/repositories`) { const value = options.repos ?? [azRepo(1)]; return { data: { count: value.length, value } }; }
    throw new Error(`Unexpected Azure request ${method} ${path}`);
  });
  return { ...h, posts: () => posts };
}

// ---- 1. pagination -------------------------------------------------------------------------
describe("1. multi-page pagination for list() and targets()", () => {
  it.each(Object.keys(FORGE) as ForgeId[])("%s list() follows Link rel=next across three pages and stops at the last page", async provider => {
    const p = FORGE[provider], link = (page: number) => `${p.api}/user/repos?${p.size}=50&page=${page}`;
    const { adapter, calls } = harness(provider, p.server, ({ url }) => {
      expect(endpoint(url, p.api)).toBe("/user/repos"); expect(url.searchParams.get(p.size)).toBe("50");
      const page = url.searchParams.get("page") ?? "1";
      if (page === "1") return { data: [forgeRepo(p.web, 1), forgeRepo(p.web, 2)], headers: { link: `<${link(2)}>; rel="next",<${link(3)}>; rel="last"` } };
      if (page === "2") return { data: [forgeRepo(p.web, 3), forgeRepo(p.web, 4)], headers: { link: `<${link(1)}>; rel="prev", <${link(3)}>; rel="next", <${link(3)}>; rel="last", <${link(1)}>; rel="first"` } };
      return { data: [forgeRepo(p.web, 5)], headers: { link: `<${link(2)}>; rel="prev", <${link(1)}>; rel="first"` } };
    });
    const pages = await collect(cursor => adapter.list({ provider, cursor }));
    expect(pages.map(page => page.data.map(r => r.id))).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect(pages.map(page => page.nextPage)).toEqual([2, 3, null]);
    expect(calls.map(c => c.url.searchParams.get("page"))).toEqual([null, "2", "3"]);
    expect(calls.every(c => c.url.origin === new URL(p.api).origin && c.authorization === p.auth)).toBe(true);
  });

  it.each(Object.keys(FORGE) as ForgeId[])("%s targets() pages /user/orgs and keeps the personal target only on the first page", async provider => {
    const p = FORGE[provider], link = (page: number) => `${p.api}/user/orgs?${p.size}=50&page=${page}`;
    const org = (id: number, name: string) => provider === "github" ? { id, login: name } : { id, username: name, name: `${name} org` };
    const { adapter } = harness(provider, p.server, ({ url }) => {
      const path = endpoint(url, p.api);
      if (path === "/user") return { data: { id: 1, login: "me" } };
      if (path === "/user/orgs") return url.searchParams.get("page") === "2"
        ? { data: [org(10, "beta")], headers: { link: `<${link(1)}>; rel="prev"` } }
        : { data: [org(9, "alpha")], headers: { link: `<${link(2)}>; rel="next"` } };
      if (path === "/user/memberships/orgs/alpha") return { data: { state: "active", role: "admin" } };
      if (path === "/user/memberships/orgs/beta") return { data: { state: "active", role: "member" } };
      if (path === "/orgs/beta") return { data: { login: "beta", members_can_create_repositories: false } };
      if (path === "/users/me/orgs/alpha/permissions") return { data: { is_owner: true, can_create_repository: true } };
      if (path === "/users/me/orgs/beta/permissions") return { data: { is_owner: false, can_create_repository: false } };
      throw new Error(`Unexpected ${path}`);
    });
    const pages = await collect(cursor => adapter.targets({ provider, cursor }));
    expect(pages.map(page => page.data.map(t => [t.id, t.kind, t.name, t.canCreateRepository]))).toEqual([
      [["user:1", "user", "me", true], ["organization:9", "organization", "alpha", true]],
      [["organization:10", "organization", "beta", false]]
    ]);
  });

  // GitHub documents that Link URLs are canonical and may name a different (ID-based) path than the request.
  it("github list() for an organization target follows GitHub's canonical /organizations/{id}/repos next link", async () => {
    const api = "https://api.github.com";
    const { adapter, calls } = harness("github", "https://github.com", ({ url }) => {
      if (url.pathname === "/user") return { data: { id: 1, login: "me" } };
      if (url.pathname === "/user/orgs") return { data: [{ id: 9, login: "team" }] };
      if (url.pathname === "/user/memberships/orgs/team") return { data: { state: "active", role: "admin" } };
      if (url.pathname === "/orgs/team/repos") return { data: [forgeRepo("https://github.com", 1)], headers: { link: `<${api}/organizations/9/repos?per_page=50&page=2>; rel="next", <${api}/organizations/9/repos?per_page=50&page=2>; rel="last"` } };
      if (url.pathname === "/organizations/9/repos") return { data: [forgeRepo("https://github.com", 2)], headers: { link: `<${api}/organizations/9/repos?per_page=50&page=1>; rel="prev", <${api}/organizations/9/repos?per_page=50&page=1>; rel="first"` } };
      throw new Error(`Unexpected ${url.pathname}`);
    });
    const first = await adapter.list({ provider: "github", targetId: "organization:9" });
    expect(first.data.map(r => r.id)).toEqual(["1"]); expect(first.nextCursor).toBeTypeOf("string");
    const second = await adapter.list({ provider: "github", targetId: "organization:9", cursor: first.nextCursor! });
    expect(second.data.map(r => r.id)).toEqual(["2"]); expect(second.nextCursor).toBeNull();
    expect(calls.every(c => c.url.origin === api)).toBe(true);
  });

  it("gitlab list() pages through Link + x-next-page, then x-next-page alone, and stops on an empty x-next-page", async () => {
    const link = (page: number) => `${GL.api}/projects?membership=true&page=${page}&per_page=50&search=repo`;
    const { adapter, calls } = harness("gitlab", GL.server, ({ url }) => {
      expect(endpoint(url, GL.api)).toBe("/projects"); expect(url.searchParams.get("search")).toBe("repo"); expect(url.searchParams.get("membership")).toBe("true");
      const page = url.searchParams.get("page") ?? "1";
      if (page === "1") return { data: [glRepo(1), glRepo(2)], headers: { link: `<${link(2)}>; rel="next", <${link(1)}>; rel="first", <${link(3)}>; rel="last"`, "x-next-page": "2", "x-page": "1" } };
      if (page === "2") return { data: [glRepo(3)], headers: { "x-next-page": "3", "x-page": "2" } };
      return { data: [glRepo(4)], headers: { link: `<${link(2)}>; rel="prev", <${link(1)}>; rel="first"`, "x-next-page": "", "x-page": "3" } };
    });
    const pages = await collect(cursor => adapter.list({ provider: "gitlab", query: "repo", cursor }));
    expect(pages.map(page => page.data.map(r => r.id))).toEqual([["1", "2"], ["3"], ["4"]]);
    expect(pages.map(page => page.nextPage)).toEqual([2, 3, null]);
    expect(calls.map(c => c.url.searchParams.get("page"))).toEqual([null, "2", "3"]);
  });

  it("gitlab targets() pages /namespaces with x-next-page and maps every namespace kind", async () => {
    const { adapter } = harness("gitlab", GL.server, ({ url }) => {
      const path = endpoint(url, GL.api);
      if (path === "/user") return { data: { id: 1, username: "me", can_create_project: true, projects_limit: 10 } };
      if (path === "/namespaces") return url.searchParams.get("page") === "2"
        ? { data: [{ id: 3, kind: "group", path: "bar", full_path: "foo/bar", parent_id: 9 }], headers: { "x-next-page": "" } }
        : { data: [{ id: 1, kind: "user", path: "me", full_path: "me", parent_id: null }, { id: 2, kind: "group", path: "group1", full_path: "group1", parent_id: null }], headers: { "x-next-page": "2" } };
      if (/^\/groups\/\d+$/.test(path)) return { data: { id: Number(path.split("/")[2]), project_creation_level: "developer" } };
      if (/^\/groups\/\d+\/members\/all\/1$/.test(path)) return { data: { id: 1, access_level: 30 } };
      throw new Error(`Unexpected ${path}`);
    });
    const pages = await collect(cursor => adapter.targets({ provider: "gitlab", cursor }));
    expect(pages.map(page => page.data.map(t => [t.id, t.kind, t.name, t.parentId, t.canCreateRepository]))).toEqual([
      [["1", "user", "me", null, true], ["2", "namespace", "group1", null, true]], [["3", "namespace", "foo/bar", "9", true]]
    ]);
  });

  it("bitbucket list() follows the envelope next URL with the q filter intact", async () => {
    const { adapter, calls } = harness("bitbucket", "https://bitbucket.org", ({ url }) => {
      const path = endpoint(url, BB_API);
      if (path === `/user/workspaces/${WS}/permissions/repositories`) {
        expect(url.searchParams.get("q")).toBe(`repository.project.uuid="${PROJECT}" AND repository.name~"repo"`);
        if (url.searchParams.get("page") === "2") return { data: { pagelen: 50, page: 2, size: 3, values: [bbGrant(3, "admin")] } };
        const next = new URL(url); next.searchParams.set("page", "2");
        return { data: { pagelen: 50, page: 1, size: 3, values: [bbGrant(1, "read"), bbGrant(2, "write")], next: next.toString() } };
      }
      const repo = path.match(/^\/repositories\/[^/]+\/\{0+-0+-4000-8000-0+(\d+)\}$/);
      if (repo) return { data: bbRepo(Number(repo[1])) };
      throw new Error(`Unexpected ${path}`);
    });
    const pages = await collect(cursor => adapter.list({ provider: "bitbucket", targetId: `${WS}/${PROJECT}`, query: "repo", cursor }));
    expect(pages.map(page => page.data.map(r => [r.id, r.permissions.push, r.permissions.admin]))).toEqual([
      [[`${WS}/${bbId(1)}`, false, false], [`${WS}/${bbId(2)}`, true, false]], [[`${WS}/${bbId(3)}`, true, true]]
    ]);
    expect(calls.filter(c => c.url.pathname.includes("/permissions/repositories")).map(c => c.url.searchParams.get("page"))).toEqual([null, "2"]);
  });

  it("bitbucket list() without a target walks every repository page of every workspace", async () => {
    const { adapter } = harness("bitbucket", "https://bitbucket.org", ({ url }) => {
      const path = endpoint(url, BB_API);
      if (path === "/user/workspaces") return { data: { pagelen: 50, page: 1, values: [{ type: "workspace_access", administrator: false, workspace: { uuid: WS, slug: "ws" } }, { type: "workspace_access", administrator: true, workspace: { uuid: WS2, slug: "ws2" } }] } };
      if (path === `/user/workspaces/${WS}/permissions/repositories`) {
        if (url.searchParams.get("page") === "2") return { data: { values: [{ permission: "write", repository: bbRepo(2) }] } };
        const next = new URL(url); next.searchParams.set("page", "2");
        return { data: { values: [{ permission: "read", repository: bbRepo(1) }], next: next.toString() } };
      }
      if (path === `/user/workspaces/${WS2}/permissions/repositories`) return { data: { values: [{ permission: "admin", repository: bbRepo(3, WS2, "ws2") }] } };
      throw new Error(`Unexpected ${path}`);
    });
    const pages = await collect(cursor => adapter.list({ provider: "bitbucket", cursor }));
    expect(pages.map(page => page.data.map(r => r.id))).toEqual([[`${WS}/${bbId(1)}`], [`${WS}/${bbId(2)}`], [`${WS2}/${bbId(3)}`]]);
  });

  it("bitbucket workspace and project targets both follow envelope next links", async () => {
    const { adapter } = harness("bitbucket", "https://bitbucket.org", ({ url }) => {
      const path = endpoint(url, BB_API), second = url.searchParams.get("page") === "2", next = new URL(url); next.searchParams.set("page", "2");
      if (path === "/user/workspaces") return second ? { data: { values: [{ administrator: false, workspace: { uuid: WS2, slug: "ws2" } }] } } : { data: { values: [{ administrator: true, workspace: { uuid: WS, slug: "ws" } }], next: next.toString() } };
      if (path === `/user/workspaces/${WS}/permission`) return { data: { type: "workspace_membership", permission: "owner", workspace: { uuid: WS } } };
      if (path === `/workspaces/${WS}/projects`) return second ? { data: { values: [{ uuid: PROJECT2, key: "SECOND", name: "Second" }] } } : { data: { values: [{ uuid: PROJECT, key: "EXISTING", name: "Existing" }], next: next.toString() } };
      throw new Error(`Unexpected ${path}`);
    });
    expect((await collect(cursor => adapter.targets({ provider: "bitbucket", cursor }))).map(p => p.data.map(t => [t.id, t.kind, t.canCreateRepository]))).toEqual([[[WS, "workspace", false]], [[WS2, "workspace", false]]]);
    expect((await collect(cursor => adapter.targets({ provider: "bitbucket", parentId: WS, cursor }))).map(p => p.data.map(t => [t.id, t.kind, t.parentId, t.createPermission]))).toEqual([[[`${WS}/${PROJECT}`, "project", WS, "allowed"]], [[`${WS}/${PROJECT2}`, "project", WS, "allowed"]]]);
  });

  it("azure targets() pages projects with x-ms-continuationtoken and keeps the documented query", async () => {
    const project = (n: number) => ({ id: azId(n), name: `Project ${n}`, state: "wellFormed", visibility: n === 2 ? "public" : "private" });
    const { adapter, calls } = azure({ projects: ({ url }) => {
      expect(url.searchParams.get("api-version")).toBe("7.1"); expect(url.searchParams.get("$top")).toBe("50"); expect(url.searchParams.get("stateFilter")).toBe("wellFormed");
      const token = url.searchParams.get("continuationToken");
      if (!token) return { data: { count: 1, value: [project(1)] }, headers: { "x-ms-continuationtoken": "1" } };
      if (token === "1") return { data: { count: 1, value: [project(2)] }, headers: { "x-ms-continuationtoken": "2" } };
      return { data: { count: 1, value: [project(3)] } };
    } });
    const pages = await collect(cursor => adapter.targets({ provider: "azure-devops", cursor }));
    expect(pages.map(p => p.data.map(t => [t.id, t.visibility, t.canCreateRepository]))).toEqual([[[azId(1), "private", true]], [[azId(2), "public", true]], [[azId(3), "private", true]]]);
    expect(calls.filter(c => c.url.pathname === "/owned/_apis/projects").map(c => c.url.searchParams.get("continuationToken"))).toEqual([null, "1", "2"]);
  });

  it("azure list() pages the unpaginated repository collection locally with nextPage", async () => {
    const { adapter } = azure({ repos: Array.from({ length: 120 }, (_, i) => azRepo(i + 1)) });
    const pages = [1, 2, 3].map(page => adapter.list({ provider: "azure-devops", page }));
    const resolved = await Promise.all(pages);
    expect(resolved.map(p => [p.data.length, p.data[0]?.id, p.nextPage, p.nextCursor])).toEqual([[50, azId(1), 2, null], [50, azId(51), 3, null], [20, azId(101), null, null]]);
  });
});

describe("1b. cursor scoping and next-link boundaries", () => {
  it("rejects a gitea cursor on a forgejo connection to the same server and a github cursor on gitea, without any request", async () => {
    const page1 = (p: typeof FORGE[ForgeId]) => ({ data: [forgeRepo(p.web, 1)], headers: { link: `<${p.api}/user/repos?${p.size}=50&page=2>; rel="next"` } });
    const gitea = harness("gitea", "https://forgejo.example.test", () => page1(FORGE.forgejo));
    const cursor = (await gitea.adapter.list({ provider: "gitea" })).nextCursor!;
    const forgejo = harness("forgejo", "https://forgejo.example.test", () => page1(FORGE.forgejo));
    await expect(forgejo.adapter.list({ provider: "forgejo", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    const github = harness("github", "https://github.com", () => page1(FORGE.github));
    const githubCursor = (await github.adapter.list({ provider: "github" })).nextCursor!;
    const giteaAgain = harness("gitea", FORGE.gitea.server, () => page1(FORGE.gitea));
    await expect(giteaAgain.adapter.list({ provider: "gitea", cursor: githubCursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(forgejo.calls).toHaveLength(0); expect(giteaAgain.calls).toHaveLength(0);
  });

  it("rejects a list cursor reused for targets(), for another query and for another target", async () => {
    const p = FORGE.gitea;
    const { adapter, calls } = harness("gitea", p.server, ({ url }) => {
      const path = endpoint(url, p.api);
      if (path === "/user") return { data: { id: 1, login: "me" } };
      if (path === "/user/orgs") return { data: [{ id: 9, username: "team" }] };
      if (path === "/users/me/orgs/team/permissions") return { data: { can_create_repository: true } };
      return { data: [forgeRepo(p.web, 1)], headers: { link: `<${p.api}${path}?limit=50&page=2>; rel="next"` } };
    });
    const cursor = (await adapter.list({ provider: "gitea", query: "repo" })).nextCursor!;
    const before = calls.length;
    await expect(adapter.targets({ provider: "gitea", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(adapter.list({ provider: "gitea", query: "other", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(adapter.list({ provider: "gitea", query: "repo", targetId: "organization:9", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    // Only the targets() user read and the org target resolution may have run; never the cursor URL.
    expect(calls.slice(before).filter(c => c.url.searchParams.get("page") === "2")).toHaveLength(0);
  });

  it("rejects a GitLab subgroup cursor for another parent group and on another self-hosted server", async () => {
    const route: Route = ({ url }) => {
      const path = endpoint(url, url.origin === "https://git.example.test" ? GL.api : "https://git2.example.test/gitlab/api/v4");
      if (path === "/user") return { data: { id: 1, username: "me" } };
      if (/^\/groups\/\d+\/subgroups$/.test(path)) return { data: [{ id: 21, path: "a", full_path: "top/a", parent_id: Number(path.split("/")[2]) }], headers: { "x-next-page": "2" } };
      if (/^\/groups\/\d+$/.test(path)) return { data: { id: 21, project_creation_level: "developer" } };
      return { data: { id: 1, access_level: 30 } };
    };
    const a = harness("gitlab", GL.server, route);
    const cursor = (await a.adapter.targets({ provider: "gitlab", parentId: "12" })).nextCursor!;
    const before = a.calls.length;
    await expect(a.adapter.targets({ provider: "gitlab", parentId: "13", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(a.adapter.targets({ provider: "gitlab", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(a.calls.length).toBe(before);
    const b = harness("gitlab", "https://git2.example.test/gitlab", route);
    await expect(b.adapter.targets({ provider: "gitlab", parentId: "12", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(b.calls).toHaveLength(0);
  });

  it("rejects a Bitbucket repository cursor for another workspace and a workspace cursor for project targets", async () => {
    const { adapter, calls } = harness("bitbucket", "https://bitbucket.org", ({ url }) => {
      const path = endpoint(url, BB_API), next = new URL(url); next.searchParams.set("page", "2");
      if (path.endsWith("/permission")) return { data: { permission: "owner" } };
      if (path === "/user/workspaces") return { data: { values: [{ workspace: { uuid: WS, slug: "ws" } }], next: next.toString() } };
      return { data: { values: [{ permission: "read", repository: bbRepo(1) }], next: next.toString() } };
    });
    const repoCursor = (await adapter.list({ provider: "bitbucket", targetId: WS })).nextCursor!;
    const workspaceCursor = (await adapter.targets({ provider: "bitbucket" })).nextCursor!;
    const before = calls.length;
    await expect(adapter.list({ provider: "bitbucket", targetId: WS2, cursor: repoCursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(adapter.list({ provider: "bitbucket", targetId: WS, query: "x", cursor: repoCursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(adapter.list({ provider: "bitbucket", cursor: repoCursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(adapter.targets({ provider: "bitbucket", parentId: WS, cursor: workspaceCursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(calls.slice(before).filter(c => c.url.searchParams.get("page") === "2")).toHaveLength(0);
  });

  it("rejects an Azure project cursor on another organization and any cursor for Azure repository lists", async () => {
    const owned = azure({ projects: () => ({ data: { value: [{ id: AZ_PROJECT, name: "Existing", visibility: "private" }] }, headers: { "x-ms-continuationtoken": "1" } }) });
    const cursor = (await owned.adapter.targets({ provider: "azure-devops" })).nextCursor!;
    const other = harness("azure-devops", "https://dev.azure.com/other", () => { throw new Error("must not be called"); });
    await expect(other.adapter.targets({ provider: "azure-devops", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(other.adapter.list({ provider: "azure-devops", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(other.calls).toHaveLength(0);
  });

  it("binds a forged cursor with a valid scope digest to the initial origin, path and parameters before any request", async () => {
    const initial = "https://api.github.com/user/repos?per_page=50";
    const scope = createHash("sha256").update(JSON.stringify(["github", "https://github.com", initial, [null, ""]])).digest("hex");
    const forged = (url: string) => Buffer.from(JSON.stringify({ scope, url })).toString("base64url");
    const { adapter, calls } = harness("github", "https://github.com", () => ({ data: [forgeRepo("https://github.com", 7)] }));
    // Control: the digest reproduces the adapter scope, so each rejection below is a URL-boundary decision.
    expect((await adapter.list({ provider: "github", cursor: forged("https://api.github.com/user/repos?per_page=50&page=7") })).data[0]?.id).toBe("7");
    for (const url of [
      "https://evil.example.test/user/repos?per_page=50&page=2", "http://api.github.com/user/repos?per_page=50&page=2",
      "https://api.github.com.evil.example.test/user/repos?per_page=50&page=2", "https://user:pw@api.github.com/user/repos?per_page=50&page=2",
      "https://api.github.com/user/emails?per_page=50&page=2", "https://api.github.com/user/repos?per_page=100&page=2",
      "https://api.github.com/user/repos?per_page=50&page=2&visibility=all", "https://api.github.com/user/repos?per_page=50&page=2&page=3",
      "https://api.github.com/user/repos?per_page=50&page=0", "https://api.github.com/user/repos?per_page=50&page=9999999",
      "https://api.github.com/user/repos?per_page=50&page=2#fragment", "not a url"
    ]) await expect(adapter.list({ provider: "github", cursor: forged(url) }), url).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    for (const cursor of ["%%%", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ scope })).toString("base64url")])
      await expect(adapter.list({ provider: "github", cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(calls).toHaveLength(1);
  });

  const page = (data: unknown, headers: Record<string, string> = {}): Reply => ({ data, headers });
  const foreignNext: Array<[string, RepositoryProviderId, string, Reply | Route, (a: RepositoryProviderAdapter, provider: RepositoryProviderId) => Promise<unknown>]> = [
    ["gitea Link to a foreign origin", "gitea", FORGE.gitea.server, page([forgeRepo(FORGE.gitea.web, 1)], { link: '<https://evil.example.test/git/api/v1/user/repos?limit=50&page=2>; rel="next"' }), (a, p) => a.list({ provider: p })],
    ["gitea Link downgraded to http", "gitea", FORGE.gitea.server, page([forgeRepo(FORGE.gitea.web, 1)], { link: '<http://forge.example.test/git/api/v1/user/repos?limit=50&page=2>; rel="next"' }), (a, p) => a.list({ provider: p })],
    ["gitea Link escaping the server subpath", "gitea", FORGE.gitea.server, page([forgeRepo(FORGE.gitea.web, 1)], { link: '<https://forge.example.test/api/v1/user/repos?limit=50&page=2>; rel="next"' }), (a, p) => a.list({ provider: p })],
    ["forgejo Link to another API path", "forgejo", FORGE.forgejo.server, page([forgeRepo(FORGE.forgejo.web, 1)], { link: '<https://forgejo.example.test/api/v1/admin/users?limit=50&page=2>; rel="next"' }), (a, p) => a.list({ provider: p })],
    ["forgejo Link carrying userinfo", "forgejo", FORGE.forgejo.server, page([forgeRepo(FORGE.forgejo.web, 1)], { link: '<https://user:pw@forgejo.example.test/api/v1/user/repos?limit=50&page=2>; rel="next"' }), (a, p) => a.list({ provider: p })],
    ["github Link widening per_page", "github", FORGE.github.server, page([forgeRepo(FORGE.github.web, 1)], { link: '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next"' }), (a, p) => a.list({ provider: p })],
    ["github Link adding a filter parameter", "github", FORGE.github.server, page([forgeRepo(FORGE.github.web, 1)], { link: '<https://api.github.com/user/repos?per_page=50&page=2&visibility=all>; rel="next"' }), (a, p) => a.list({ provider: p })],
    ["github Link pointing at the current page (loop)", "github", FORGE.github.server, page([forgeRepo(FORGE.github.web, 1)], { link: '<https://api.github.com/user/repos?per_page=50>; rel="next"' }), (a, p) => a.list({ provider: p })],
    ["github targets Link to a foreign origin", "github", FORGE.github.server, ({ url }) => url.pathname === "/user" ? page({ id: 1, login: "me" }) : page([{ id: 9, login: "team" }], { link: '<https://evil.example.test/user/orgs?per_page=50&page=2>; rel="next"' }), (a, p) => a.targets({ provider: p })],
    ["gitlab Link to a foreign origin", "gitlab", GL.server, page([glRepo(1)], { link: '<https://evil.example.test/gitlab/api/v4/projects?membership=true&page=2&per_page=50>; rel="next"', "x-next-page": "2" }), (a, p) => a.list({ provider: p })],
    ["gitlab Link outside the server subpath", "gitlab", GL.server, page([glRepo(1)], { link: '<https://git.example.test/api/v4/projects?membership=true&page=2&per_page=50>; rel="next"', "x-next-page": "2" }), (a, p) => a.list({ provider: p })],
    ["gitlab x-next-page that is not a page number", "gitlab", GL.server, page([glRepo(1)], { "x-next-page": "../admin" }), (a, p) => a.list({ provider: p })],
    ["bitbucket envelope next to a foreign origin", "bitbucket", "https://bitbucket.org", page({ values: [], next: "https://evil.example.test/2.0/user/workspaces?pagelen=50&page=2" }), (a, p) => a.targets({ provider: p })],
    ["bitbucket envelope next to the web origin instead of the API", "bitbucket", "https://bitbucket.org", page({ values: [], next: "https://bitbucket.org/2.0/user/workspaces?pagelen=50&page=2" }), (a, p) => a.targets({ provider: p })],
    ["bitbucket envelope next to a lookalike API host", "bitbucket", "https://bitbucket.org", page({ values: [], next: "https://api.bitbucket.org.evil.example.test/2.0/user/workspaces?pagelen=50&page=2" }), (a, p) => a.targets({ provider: p })],
    ["azure envelope next to a foreign origin", "azure-devops", AZ, page({ value: [], next: "https://evil.example.test/owned/_apis/projects?api-version=7.1&%24top=50&stateFilter=wellFormed&continuationToken=1" }), (a, p) => a.targets({ provider: p })]
  ];
  it.each(foreignNext)("%s is rejected before any credentialed request to the next link", async (_label, provider, server, reply, run) => {
    const { adapter, calls } = harness(provider, server, typeof reply === "function" ? reply : () => reply);
    await expect(run(adapter, provider)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.url.origin === calls[0]!.url.origin && !c.url.searchParams.has("page") && !c.url.searchParams.has("continuationToken"))).toBe(true);
  });
});

// ---- 2. GitLab subgroups and creation levels ------------------------------------------------
describe("2. GitLab subgroups and project_creation_level", () => {
  it("targets({parentId}) walks /groups/:id/subgroups across pages with nested full_path names", async () => {
    const levels: Record<number, string> = { 21: "developer", 22: "maintainer", 23: "noone" };
    const sub = (id: number, name: string) => ({ id, name, path: name, full_path: `top/mid/${name}`, parent_id: 12, visibility: "private", project_creation_level: levels[id] });
    const { adapter, calls } = harness("gitlab", GL.server, ({ url }) => {
      const path = endpoint(url, GL.api);
      if (path === "/user") return { data: { id: 1, username: "me" } };
      if (path === "/groups/12/subgroups") {
        expect(url.searchParams.get("per_page")).toBe("50");
        return url.searchParams.get("page") === "2"
          ? { data: [sub(23, "c")], headers: { link: `<${GL.api}/groups/12/subgroups?page=1&per_page=50>; rel="prev"`, "x-next-page": "" } }
          : { data: [sub(21, "a"), sub(22, "b")], headers: { link: `<${GL.api}/groups/12/subgroups?page=2&per_page=50>; rel="next"`, "x-next-page": "2" } };
      }
      const group = path.match(/^\/groups\/(\d+)$/); if (group) return { data: { id: Number(group[1]), full_path: "top/mid/x", project_creation_level: levels[Number(group[1])] } };
      if (/^\/groups\/\d+\/members\/all\/1$/.test(path)) return { data: { id: 1, access_level: 30 } };
      throw new Error(`Unexpected ${path}`);
    });
    const pages = await collect(cursor => adapter.targets({ provider: "gitlab", parentId: "12", cursor }));
    expect(pages.flatMap(p => p.data)).toEqual([
      { id: "21", provider: "gitlab", kind: "namespace", name: "top/mid/a", parentId: "12", canCreateRepository: true },
      { id: "22", provider: "gitlab", kind: "namespace", name: "top/mid/b", parentId: "12", canCreateRepository: false },
      { id: "23", provider: "gitlab", kind: "namespace", name: "top/mid/c", parentId: "12", canCreateRepository: false }
    ]);
    expect(calls.filter(c => endpoint(c.url, GL.api) === "/groups/12/subgroups").map(c => c.url.searchParams.get("page"))).toEqual([null, "2"]);
  });

  it.each([
    ["noone", 50, false], ["administrator", 50, false], ["owner", 40, false], ["owner", 50, true],
    ["maintainer", 30, false], ["maintainer", 40, true], ["maintainer", 50, true],
    ["developer", 20, false], ["developer", 30, true], ["developer", 50, true], ["developer", null, false]
  ] as const)("project_creation_level=%s with access_level=%s maps canCreateRepository=%s and gates POST /projects", async (level, access, allowed) => {
    let posts = 0;
    const namespace = { id: 29, kind: "group", path: "sub", full_path: "group/sub", parent_id: 12 };
    const { adapter } = harness("gitlab", GL.server, ({ url, method, body }) => {
      const path = endpoint(url, GL.api);
      if (method === "POST") { posts++; expect(body).toMatchObject({ namespace_id: 29, path: "new-repo", visibility: "private" }); return { data: glRepo(80) }; }
      if (path === "/user") return { data: { id: 1, username: "me" } };
      if (path === "/namespaces") return { data: [namespace] };
      if (path === "/namespaces/29") return { data: namespace };
      if (path === "/groups/29") return { data: { id: 29, full_path: "group/sub", project_creation_level: level } };
      if (path === "/groups/29/members/all/1") { if (access === null) throw failure("REPOSITORY_NOT_FOUND", 404); return { data: { id: 1, access_level: access } }; }
      throw new Error(`Unexpected ${path}`);
    });
    expect((await adapter.targets({ provider: "gitlab" })).data[0]).toMatchObject({ id: "29", name: "group/sub", parentId: "12", canCreateRepository: allowed });
    const create = adapter.createRepository({ name: "new-repo", private: true, targetId: "29" });
    if (allowed) expect((await create).id).toBe("80");
    else await expect(create).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION", statusCode: 403 });
    expect(posts).toBe(allowed ? 1 : 0);
  });

  it("archived groups, other users' namespaces and exhausted personal limits are not creatable", async () => {
    const run = async (user: Record<string, unknown>) => harness("gitlab", GL.server, ({ url }) => {
      const path = endpoint(url, GL.api);
      if (path === "/user") return { data: user };
      if (path === "/namespaces") return { data: [{ id: 5, kind: "user", path: "me", full_path: "me" }, { id: 6, kind: "user", path: "someone", full_path: "someone" }, { id: 29, kind: "group", path: "old", full_path: "old" }] };
      if (path === "/groups/29") return { data: { id: 29, archived: true, project_creation_level: "developer" } };
      if (path === "/groups/29/members/all/1") return { data: { id: 1, access_level: 50 } };
      throw new Error(`Unexpected ${path}`);
    }).adapter.targets({ provider: "gitlab" });
    expect((await run({ id: 1, username: "me", can_create_project: true, projects_limit: 10 })).data.map(t => t.canCreateRepository)).toEqual([true, false, false]);
    expect((await run({ id: 1, username: "me", can_create_project: false, projects_limit: 10 })).data[0]?.canCreateRepository).toBe(false);
    expect((await run({ id: 1, username: "me", can_create_project: true, projects_limit: 0 })).data[0]?.canCreateRepository).toBe(false);
  });
});

// ---- 3. Bitbucket ---------------------------------------------------------------------------
describe("3. Bitbucket workspace/project targets, permissions and create", () => {
  it.each([["owner", true, "allowed"], ["create-project", false, "unknown"], ["member", false, "unknown"], ["collaborator", false, "unknown"]] as const)(
    "workspace role %s maps project targets to canCreateRepository=%s createPermission=%s", async (role, canCreate, createPermission) => {
      const { adapter } = harness("bitbucket", "https://bitbucket.org", ({ url }) => {
        const path = endpoint(url, BB_API);
        if (path === `/user/workspaces/${WS}/permission`) return { data: { type: "workspace_membership", permission: role, workspace: { uuid: WS } } };
        if (path === `/workspaces/${WS}/projects`) return { data: { values: [{ uuid: PROJECT, key: "EXISTING", name: "Existing" }] } };
        throw new Error(`Unexpected ${path}`);
      });
      expect((await adapter.targets({ provider: "bitbucket", parentId: WS })).data).toEqual([{ id: `${WS}/${PROJECT}`, provider: "bitbucket", kind: "project", parentId: WS, name: "Existing", canCreateRepository: canCreate, createPermission }]);
    });

  it.each([["read", { pull: true, push: false, admin: false }], ["write", { pull: true, push: true, admin: false }], ["admin", { pull: true, push: true, admin: true }], [null, { pull: false, push: false, admin: false }]] as const)(
    "lookup maps the caller's effective permission %s", async (permission, expected) => {
      const { adapter, calls } = harness("bitbucket", "https://bitbucket.org", ({ url }) => {
        const path = endpoint(url, BB_API);
        if (path === `/repositories/${WS}/${REPO}`) return { data: bbRepo(1) };
        if (path === `/user/workspaces/${WS}/permissions/repositories`) return { data: { values: permission ? [bbGrant(1, permission), bbGrant(2, "admin")] : [bbGrant(2, "admin")] } };
        throw new Error(`Unexpected ${path}`);
      });
      const repo = await adapter.lookup(`${WS}/${REPO}`);
      expect(repo).toMatchObject({ id: `${WS}/${REPO}`, cloneUrl: "https://bitbucket.org/ws/repo-1.git", permissions: expected });
      expect(calls.find(c => c.url.pathname.endsWith("/permissions/repositories"))?.url.searchParams.get("q")).toBe(`repository.uuid="${REPO}"`);
    });

  function creator(project: () => Reply) {
    let posts = 0;
    const h = harness("bitbucket", "https://bitbucket.org", ({ url, method, body }) => {
      const path = endpoint(url, BB_API);
      if (method === "POST") { posts++; expect(path).toBe(`/repositories/${WS}/new-repo`); expect(body).toEqual({ scm: "git", name: "new-repo", is_private: true, project: { key: "EXISTING" } }); return { data: bbRepo(5) }; }
      if (path === `/workspaces/${WS}/projects/${PROJECT}`) return project();
      throw new Error(`Unexpected ${path}`);
    });
    return { ...h, posts: () => posts };
  }
  it("create requires an existing project: a missing project propagates 404 and never POSTs", async () => {
    const c = creator(() => { throw failure("REPOSITORY_NOT_FOUND", 404); });
    await expect(c.adapter.createRepository({ name: "new-repo", private: true, targetId: `${WS}/${PROJECT}` })).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    expect(c.posts()).toBe(0);
  });
  it("create refuses a project whose returned identity differs, and malformed project identifiers, without POST", async () => {
    const c = creator(() => ({ data: { uuid: PROJECT2, key: "OTHER", name: "Other" } }));
    await expect(c.adapter.createRepository({ name: "new-repo", private: true, targetId: `${WS}/${PROJECT}` })).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
    await expect(c.adapter.createRepository({ name: "new-repo", private: true, targetId: `${WS}/EXISTING` })).rejects.toMatchObject({ code: "INVALID_REPOSITORY" });
    await expect(c.adapter.createRepository({ name: "new-repo", private: true, targetId: `${WS}/${PROJECT}/extra` })).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
    await expect(c.adapter.createRepository({ name: "new-repo", private: true })).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
    expect(c.posts()).toBe(0); expect(c.calls).toHaveLength(1);
  });
  it("create in an existing project posts the project key and returns an unconfirmed permission set", async () => {
    const c = creator(() => ({ data: { uuid: PROJECT, key: "EXISTING", name: "Existing" } }));
    expect(await c.adapter.createRepository({ name: "new-repo", private: true, targetId: `${WS}/${PROJECT}` })).toMatchObject({ id: `${WS}/${bbId(5)}`, cloneUrl: "https://bitbucket.org/ws/repo-5.git", permissions: { pull: false, push: false, admin: false } });
    expect(c.posts()).toBe(1);
  });
});

// ---- 4. Azure -------------------------------------------------------------------------------
describe("4. Azure DevOps project visibility and permission bits", () => {
  it.each([["private", false], ["public", true]] as const)("a %s project rejects private=%s before POST, and inherits visibility otherwise", async (visibility, mismatched) => {
    const a = azure({ visibility });
    expect((await a.adapter.targets({ provider: "azure-devops" })).data[0]).toMatchObject({ id: AZ_PROJECT, visibility, canCreateRepository: true });
    await expect(a.adapter.createRepository({ name: "repo-1", private: mismatched, targetId: AZ_PROJECT })).rejects.toMatchObject({ code: "VISIBILITY_INHERITED", statusCode: 409 });
    expect(a.posts()).toBe(0);
    expect(await a.adapter.createRepository({ name: "repo-1", private: !mismatched, targetId: AZ_PROJECT })).toMatchObject({ id: AZ_REPO, private: visibility === "private" });
    expect(a.posts()).toBe(1);
  });

  it("CreateRepository bit 256 denial maps to INSUFFICIENT_PERMISSION before POST using the project token", async () => {
    const a = azure({ bits: { 256: false } });
    expect((await a.adapter.targets({ provider: "azure-devops" })).data[0]?.canCreateRepository).toBe(false);
    await expect(a.adapter.createRepository({ name: "repo-1", private: true, targetId: AZ_PROJECT })).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION", statusCode: 403 });
    expect(a.posts()).toBe(0);
    const probe = a.calls.find(c => c.url.pathname.endsWith("/256"))!;
    expect(probe.url.pathname).toBe(`/owned/_apis/permissions/${AZ_NS}/256`);
    expect(Object.fromEntries(probe.url.searchParams)).toEqual({ "api-version": "7.1", tokens: `repoV2/${AZ_PROJECT}`, alwaysAllowAdministrators: "false" });
  });

  it.each([
    [{ 2: true, 4: false, 8192: false }, {}, { pull: true, push: false, admin: false }],
    [{ 2: true, 4: true, 8192: false }, {}, { pull: true, push: true, admin: false }],
    [{ 2: true, 4: true, 8192: true }, {}, { pull: true, push: true, admin: true }],
    [{ 2: false, 4: false, 8192: false }, {}, { pull: false, push: false, admin: false }],
    [{ 2: true, 4: true, 8192: true }, { isDisabled: true }, { pull: false, push: false, admin: false }],
    [{ 2: true, 4: true, 8192: true }, { isInMaintenance: true }, { pull: true, push: false, admin: true }]
  ] as const)("repository bits %j with %j map to %j", async (bits, flags, expected) => {
    const a = azure({ bits, repo: azRepo(1, flags) });
    expect((await a.adapter.lookup(AZ_REPO)).permissions).toEqual(expected);
    const probes = a.calls.filter(c => c.url.pathname.includes("/_apis/permissions/"));
    expect(probes.map(c => Number(c.url.pathname.split("/").at(-1))).sort((x, y) => x - y)).toEqual([2, 4, 8192]);
    expect(probes.every(c => c.url.searchParams.get("tokens") === `repoV2/${AZ_PROJECT}/${AZ_REPO}` && c.url.searchParams.get("alwaysAllowAdministrators") === "false")).toBe(true);
  });
});

// ---- 5. error paths -------------------------------------------------------------------------
const ERROR_TARGETS: Record<RepositoryProviderId, { server: string; lookup: string; targetId?: string }> = {
  github: { server: FORGE.github.server, lookup: "42" }, gitea: { server: FORGE.gitea.server, lookup: "42" }, forgejo: { server: FORGE.forgejo.server, lookup: "42" },
  gitlab: { server: GL.server, lookup: "71" }, bitbucket: { server: "https://bitbucket.org", lookup: `${WS}/${REPO}`, targetId: `${WS}/${PROJECT}` },
  "azure-devops": { server: AZ, lookup: AZ_REPO, targetId: AZ_PROJECT }
};
const TRANSPORT_ERRORS = [["401 invalid or expired token", "INVALID_TOKEN", 401], ["403 read-only account", "INSUFFICIENT_PERMISSION", 403], ["404 not found", "REPOSITORY_NOT_FOUND", 404],
  ["429 rate limit", "RATE_LIMITED", 429], ["3xx redirect", "REDIRECT_BLOCKED", 502], ["provider offline", "PROVIDER_UNAVAILABLE", 503]] as const;
describe("5. error paths through the adapter boundary", () => {
  const matrix = (Object.keys(ERROR_TARGETS) as RepositoryProviderId[]).flatMap(provider => TRANSPORT_ERRORS.map(([label, code, status]) => [provider, label, code, status] as const));
  it.each(matrix)("%s surfaces %s as typed %s from identity, list, lookup, targets and create", async (provider, _label, code, status) => {
    const t = ERROR_TARGETS[provider];
    const { adapter } = harness(provider, t.server, () => { throw failure(code, status); });
    for (const run of [() => adapter.identity(), () => adapter.list({ provider }), () => adapter.lookup(t.lookup), () => adapter.targets({ provider }),
      () => adapter.createRepository({ name: "repo", private: true, ...(t.targetId ? { targetId: t.targetId } : {}) })]) {
      const error = await rejection(run());
      expect(error).toBeInstanceOf(GitControlError); expect(error).toMatchObject({ code, statusCode: status });
    }
  });

  const probes = (["github", "gitea", "gitlab"] as const).flatMap(provider => TRANSPORT_ERRORS.map(([, code, status]) => [provider, code, status] as const));
  it.each(probes)("%s create-permission probe treats only 403/404 as 'cannot create' and propagates %s", async (provider, code, status) => {
    const server = provider === "gitlab" ? GL.server : FORGE[provider].server, api = provider === "gitlab" ? GL.api : FORGE[provider].api;
    const { adapter } = harness(provider, server, ({ url }) => {
      const path = endpoint(url, api);
      if (path === "/user") return { data: { id: 1, login: "me", username: "me" } };
      if (path === "/user/orgs") return { data: [{ id: 9, login: "team", username: "team" }] };
      if (path === "/namespaces") return { data: [{ id: 9, kind: "group", path: "team", full_path: "team" }] };
      if (path === "/groups/9") return { data: { id: 9, project_creation_level: "developer" } };
      if (path === "/user/memberships/orgs/team" || path === "/users/me/orgs/team/permissions" || path === "/groups/9/members/all/1") throw failure(code, status);
      throw new Error(`Unexpected ${path}`);
    });
    const result = adapter.targets({ provider });
    if (status === 403 || status === 404) expect((await result).data.find(t => t.id.endsWith("9"))?.canCreateRepository).toBe(false);
    else { const error = await rejection(result); expect(error).toBeInstanceOf(GitControlError); expect(error).toMatchObject({ code }); }
  });

  const bbRoute = (repo: unknown, grants: unknown = { values: [bbGrant(1, "write")] }): Route => ({ url }) => {
    const path = endpoint(url, BB_API);
    if (path.endsWith("/permissions/repositories")) return { data: grants };
    return { data: repo };
  };
  const azRoute = (repo: unknown, permission: unknown = { count: 1, value: [true] }): Route => ({ url }) => url.pathname.includes("/_apis/permissions/") ? { data: permission } : { data: repo };
  const repoLookup = (id: string) => (a: RepositoryProviderAdapter) => a.lookup(id);
  const malformed: Array<[string, RepositoryProviderId, string, Route, (a: RepositoryProviderAdapter, provider: RepositoryProviderId) => Promise<unknown>]> = [
    ["github repository without id", "github", FORGE.github.server, () => ({ data: { ...forgeRepo(FORGE.github.web, 42), id: undefined } }), repoLookup("42")],
    ["github repository with a non-numeric id", "github", FORGE.github.server, () => ({ data: forgeRepo(FORGE.github.web, "abc" as unknown as number) }), repoLookup("42")],
    ["gitea repository with a fractional id", "gitea", FORGE.gitea.server, () => ({ data: forgeRepo(FORGE.gitea.web, 4.2) }), repoLookup("42")],
    ["forgejo repository with a non-string full_name", "forgejo", FORGE.forgejo.server, () => ({ data: { ...forgeRepo(FORGE.forgejo.web, 42), full_name: 7 } }), repoLookup("42")],
    ["forgejo repository payload that is an array", "forgejo", FORGE.forgejo.server, () => ({ data: [forgeRepo(FORGE.forgejo.web, 42)] }), repoLookup("42")],
    ["gitea repository list that is an object", "gitea", FORGE.gitea.server, () => ({ data: { data: [] } }), (a, p) => a.list({ provider: p })],
    ["github org list with a non-numeric org id", "github", FORGE.github.server, ({ url }) => ({ data: url.pathname === "/user" ? { id: 1, login: "me" } : [{ id: "team", login: "team" }] }), (a, p) => a.targets({ provider: p })],
    ["gitlab project without id", "gitlab", GL.server, () => ({ data: { ...glRepo(71), id: null } }), repoLookup("71")],
    ["gitlab project with a non-numeric id", "gitlab", GL.server, () => ({ data: glRepo("71abc" as unknown as number) }), repoLookup("71")],
    ["gitlab project without path_with_namespace", "gitlab", GL.server, () => ({ data: { ...glRepo(71), path_with_namespace: null } }), repoLookup("71")],
    ["gitlab project list that is an object", "gitlab", GL.server, () => ({ data: { projects: [] } }), (a, p) => a.list({ provider: p })],
    ["gitlab namespace with a non-numeric id", "gitlab", GL.server, ({ url }) => ({ data: url.pathname.endsWith("/user") ? { id: 1, username: "me" } : [{ id: "me", kind: "user", path: "me" }] }), (a, p) => a.targets({ provider: p })],
    ["bitbucket repository with a non-UUID uuid", "bitbucket", "https://bitbucket.org", bbRoute(bbRepo(1, WS, "ws", { uuid: "repo-1" })), repoLookup(`${WS}/${REPO}`)],
    ["bitbucket repository without workspace", "bitbucket", "https://bitbucket.org", bbRoute(bbRepo(1, WS, "ws", { workspace: undefined })), repoLookup(`${WS}/${REPO}`)],
    ["bitbucket repository without an https clone link", "bitbucket", "https://bitbucket.org", bbRoute(bbRepo(1, WS, "ws", { links: { clone: [{ name: "ssh", href: "git@bitbucket.org:ws/repo-1.git" }], html: { href: "https://bitbucket.org/ws/repo-1" } } })), repoLookup(`${WS}/${REPO}`)],
    ["bitbucket permission envelope without values", "bitbucket", "https://bitbucket.org", bbRoute(bbRepo(1), { size: 0 }), repoLookup(`${WS}/${REPO}`)],
    ["bitbucket workspace list with a non-UUID workspace", "bitbucket", "https://bitbucket.org", () => ({ data: { values: [{ workspace: { uuid: "ws", slug: "ws" } }] } }), (a, p) => a.targets({ provider: p })],
    ["azure repository with a non-GUID id", "azure-devops", AZ, azRoute(azRepo(1, { id: "repo-1" })), repoLookup(AZ_REPO)],
    ["azure repository without project", "azure-devops", AZ, azRoute(azRepo(1, { project: undefined })), repoLookup(AZ_REPO)],
    ["azure permission answer that is not boolean", "azure-devops", AZ, azRoute(azRepo(1), { count: 1, value: ["yes"] }), repoLookup(AZ_REPO)],
    ["azure permission answer with extra tokens", "azure-devops", AZ, azRoute(azRepo(1), { count: 2, value: [true, true] }), repoLookup(AZ_REPO)],
    ["azure repository list without value", "azure-devops", AZ, () => ({ data: { count: 0 } }), (a, p) => a.list({ provider: p })],
    ["azure project list with a non-GUID project", "azure-devops", AZ, () => ({ data: { value: [{ id: "Existing", name: "Existing", visibility: "private" }] } }), (a, p) => a.targets({ provider: p })]
  ];
  it.each(malformed)("%s becomes a typed GitControlError", async (_label, provider, server, route, run) => {
    const { adapter } = harness(provider, server, route);
    const error = await rejection(run(adapter, provider));
    expect(error).toBeInstanceOf(GitControlError);
    expect(["PROVIDER_FAILED", "INVALID_REPOSITORY"]).toContain((error as GitControlError).code);
    expect(String((error as Error).message)).not.toContain("fixture-token");
  });

  it.each([
    ["github Link header with an unparsable next URL", "github", FORGE.github.server, { data: [forgeRepo(FORGE.github.web, 1)], headers: { link: '<https://[api.github.com/user/repos?per_page=50&page=2>; rel="next"' } }, (a: RepositoryProviderAdapter) => a.list({ provider: "github" })],
    ["gitlab Link header with an unparsable next URL", "gitlab", GL.server, { data: [glRepo(1)], headers: { link: '<https://git.example.test:99999/gitlab/api/v4/projects?page=2>; rel="next"', "x-next-page": "2" } }, (a: RepositoryProviderAdapter) => a.list({ provider: "gitlab" })],
    ["bitbucket envelope with an unparsable next URL", "bitbucket", "https://bitbucket.org", { data: { values: [], next: "https://[api.bitbucket.org/2.0/user/workspaces?page=2" } }, (a: RepositoryProviderAdapter) => a.targets({ provider: "bitbucket" })]
  ] as const)("%s becomes a typed GitControlError, not a raw TypeError", async (_label, provider, server, reply, run) => {
    const { adapter, calls } = harness(provider, server, () => reply as Reply);
    const error = await rejection(run(adapter));
    expect(error).toBeInstanceOf(GitControlError);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["gitlab default_branch object", "gitlab", GL.server, () => ({ data: glRepo(71, { default_branch: { name: "main" } }) }), "71"],
    ["bitbucket mainbranch.name number", "bitbucket", "https://bitbucket.org", bbRoute(bbRepo(1, WS, "ws", { mainbranch: { type: "branch", name: 7 } })), `${WS}/${REPO}`]
  ] as const)("%s never escapes as a non-string defaultBranch", async (_label, provider, server, route, id) => {
    const { adapter } = harness(provider, server, route as Route);
    const outcome = await adapter.lookup(id).then(r => typeof r.defaultBranch, error => error instanceof GitControlError ? "typed-error" : "raw-error");
    expect(["string", "typed-error"]).toContain(outcome);
  });
});

// ---- 6. clone URL host/path validation --------------------------------------------------------
const CLONE: Record<RepositoryProviderId, { server: string; valid: string; web: string; id: string; subpath?: string }> = {
  github: { server: "https://github.com", valid: "https://github.com/team/repo.git", web: "https://github.com/team/repo", id: "42" },
  gitea: { server: "https://forge.example.test/git", valid: "https://forge.example.test/git/team/repo.git", web: "https://forge.example.test/git/team/repo", id: "42", subpath: "/git" },
  forgejo: { server: "https://forgejo.example.test", valid: "https://forgejo.example.test/team/repo.git", web: "https://forgejo.example.test/team/repo", id: "42" },
  gitlab: { server: GL.server, valid: `${GL.server}/group/sub/repo.git`, web: `${GL.server}/group/sub/repo`, id: "71", subpath: "/gitlab" },
  bitbucket: { server: "https://bitbucket.org", valid: "https://bitbucket.org/ws/repo.git", web: "https://bitbucket.org/ws/repo", id: `${WS}/${REPO}` },
  "azure-devops": { server: AZ, valid: `${AZ}/Existing/_git/repo`, web: `${AZ}/Existing/_git/repo`, id: AZ_REPO, subpath: "/owned" }
};
function lookupWith(provider: RepositoryProviderId, clone: string, web?: string): Promise<GitRemoteRepository> {
  const c = CLONE[provider], html = web ?? c.web;
  const route: Route = ({ url }) => {
    if (provider === "gitlab") return { data: { ...glRepo(71), path_with_namespace: "group/sub/repo", http_url_to_repo: clone, web_url: html } };
    if (provider === "bitbucket") return url.pathname.endsWith("/permissions/repositories") ? { data: { values: [bbGrant(1, "write")] } } : { data: { ...bbRepo(1), full_name: "ws/repo", links: { clone: [{ name: "https", href: clone }], html: { href: html } } } };
    if (provider === "azure-devops") return url.pathname.includes("/_apis/permissions/") ? { data: { value: [true] } } : { data: azRepo(1, { name: "repo", remoteUrl: clone, webUrl: html }) };
    return { data: { ...forgeRepo(c.web, 42), full_name: "team/repo", clone_url: clone, html_url: html } };
  };
  return harness(provider, c.server, route).adapter.lookup(c.id);
}
function cloneMutations(provider: RepositoryProviderId): Array<[string, string]> {
  const { valid, server, subpath } = CLONE[provider], url = new URL(valid), host = url.host;
  const rest = valid.slice(server.length);
  const rows: Array<[string, string]> = [
    ["a different host", valid.replace(host, "evil.example.test")], ["a lookalike host suffix", valid.replace(host, `${host}.evil.example.test`)],
    ["an http downgrade", valid.replace("https:", "http:")], ["a non-default port", valid.replace(host, `${host}:8443`)],
    ["user:password credentials", valid.replace("https://", "https://user:secret@")], ["a token-only userinfo", valid.replace("https://", "https://:fixture-token@")],
    ["a query", `${valid}?private_token=x`], ["a fragment", `${valid}#main`], ["an encoded slash in a segment", valid.replace(/\/([^/]+)$/, "/x%2F$1")],
    ["an ssh URL", `ssh://git@${host}${url.pathname}`], ["an unparsable URL", "https://[broken"]
  ];
  if (subpath) rows.push(["a different server path prefix", `${url.origin}${subpath}-evil${rest}`], ["a dot-dot escape from the server path", `${server}/%2e%2e/evil${rest}`]);
  else rows.push(["a single path segment", `${url.origin}/repo.git`]);
  if (provider === "azure-devops") rows.push(["a different Azure organization", `https://dev.azure.com/foreign${rest}`], ["a non-_git repository path", `${AZ}/Existing/repo/extra`]);
  return rows;
}
describe("6. clone URL host/path validation", () => {
  it.each(Object.keys(CLONE) as RepositoryProviderId[])("control: %s accepts its canonical clone and web URL", async provider => {
    expect(await lookupWith(provider, CLONE[provider].valid)).toMatchObject({ cloneUrl: CLONE[provider].valid, webUrl: CLONE[provider].web });
  });
  const rows = (Object.keys(CLONE) as RepositoryProviderId[]).flatMap(provider => cloneMutations(provider).map(([label, url]) => [provider, label, url] as const));
  it.each(rows)("%s rejects a repository clone URL with %s: %s", async (provider, _label, url) => {
    await expect(lookupWith(provider, url)).rejects.toMatchObject({ code: "REMOTE_MISMATCH", statusCode: 409 });
  });

  it.each(["github", "gitea", "forgejo", "gitlab"] as const)("%s rejects an embedded username it never legitimately returns", async provider => {
    await expect(lookupWith(provider, CLONE[provider].valid.replace("https://", "https://someone@"))).rejects.toMatchObject({ code: "REMOTE_MISMATCH" });
  });
  it.each(["bitbucket", "azure-devops"] as const)("%s strips the username it legitimately returns but still rejects user input with one", async provider => {
    const c = CLONE[provider];
    expect((await lookupWith(provider, c.valid.replace("https://", "https://account@"))).cloneUrl).toBe(c.valid);
    const adapter = harness(provider, c.server, () => { throw new Error("must not be called"); }).adapter;
    await expect(adapter.validateCloneUrl(c.valid.replace("https://", "https://account@"))).rejects.toMatchObject({ code: "REMOTE_MISMATCH" });
  });
  it.each(Object.keys(CLONE) as RepositoryProviderId[])("%s rejects a foreign web URL even when the clone URL is valid", async provider => {
    await expect(lookupWith(provider, CLONE[provider].valid, CLONE[provider].web.replace(new URL(CLONE[provider].web).host, "evil.example.test"))).rejects.toMatchObject({ code: "REMOTE_MISMATCH" });
  });
  it.each(Object.keys(CLONE) as RepositoryProviderId[])("%s validateCloneUrl rejects every mutated URL before DNS", async provider => {
    const adapter = harness(provider, CLONE[provider].server, () => { throw new Error("must not be called"); }).adapter;
    for (const [label, url] of cloneMutations(provider)) await expect(adapter.validateCloneUrl(url), label).rejects.toMatchObject({ code: "REMOTE_MISMATCH" });
  });
});

// ---- 7. read-only repositories through the service --------------------------------------------
// Service tests spawn Git and the encrypted credential store; allow for a loaded host.
describe("7. read-only repository refuses push/commit-push before any Git network call", { timeout: 30000 }, () => {
  let root: string, project: string, repository: InMemorySourceControlRepository, server: Server, origin: string, requests: number;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const author = { name: "Fixture", email: "fixture@example.invalid" };
  const credentials: Record<RepositoryProviderId, Record<string, string>> = {
    github: { token: "fixture-token" }, gitea: { token: "fixture-token", serverUrl: "https://forge.example.test" }, forgejo: { token: "fixture-token", serverUrl: "https://forge.example.test" },
    gitlab: { token: "fixture-token", serverUrl: "https://gitlab.example.test" }, bitbucket: { token: "fixture-token", email: "person@example.invalid" },
    "azure-devops": { token: "fixture-token", organization: "https://dev.azure.com/owned" }
  };
  beforeEach(async () => {
    const scratch = join(tmpdir(), "repository-provider-test-fixtures");
    await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "contract-matrix-")); project = join(root, "project"); await mkdir(project);
    git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    repository = new InMemorySourceControlRepository(); requests = 0;
    server = createServer((_request, response) => { requests++; response.writeHead(404).end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  function service(state: { pull: boolean; push: boolean; validations: string[]; lookups: number }) {
    const remote = (): GitRemoteRepository => ({ id: "repo-1", fullName: "team/repo", cloneUrl: `${origin}/team/repo.git`, webUrl: `${origin}/team/repo`, private: true, defaultBranch: "main", permissions: { pull: state.pull, push: state.push, admin: false } });
    return new SourceControlService({ repository, credentials: new DemoCredentialStore(join(root, "credentials")), credentialRoot: join(root, "credentials"), privateOrigins: [origin], providerFactory: () => ({
      identity: async () => ({ login: "account", email: null }), repositories: async () => [remote()], repository: async () => remote(),
      lookup: async () => { state.lookups++; return remote(); }, list: async () => ({ data: [remote()], nextPage: null, nextCursor: null }),
      targets: async () => ({ data: [], nextPage: null, nextCursor: null }),
      create: async () => { throw new Error("create must not be called"); }, createRepository: async () => { throw new Error("create must not be called"); },
      validateCloneUrl: async (url: string) => { state.validations.push(url); return url; }
    }) });
  }
  async function bound(provider: RepositoryProviderId, state: { pull: boolean; push: boolean; validations: string[]; lookups: number }) {
    const svc = service(state);
    await svc.connect("user:a", provider, credentials[provider]);
    if (!["github", "gitea"].includes(provider)) await svc.setEnabled("user:a", provider, true);
    const binding = await svc.bindRepository("user:a", project, provider, "repo-1");
    return { svc, binding };
  }
  const rows = (Object.keys(credentials) as RepositoryProviderId[]).flatMap(provider => (["push", "commit-push"] as const).map(operation => [provider, operation] as const));
  it.each(rows)("%s %s is refused after a fresh lookup reports push=false, with no Git request, commit or index change", async (provider, operation) => {
    const state = { pull: true, push: true, validations: [] as string[], lookups: 0 };
    await writeFile(join(project, "file.txt"), "staged\n"); git("add", "file.txt");
    const { svc, binding } = await bound(provider, state);
    expect(binding.repository?.permissions.push).toBe(true);
    state.push = false; state.validations.length = 0; state.lookups = 0;
    const expectedVersion = (await svc.status("user:a", binding.id)).version;
    await expect(svc.operate("user:a", operation, { bindingId: binding.id, expectedVersion, paths: [], message: "Fixture commit", confirmed: true }, author)).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION", statusCode: 403 });
    expect(state.lookups).toBe(1); expect(state.validations).toEqual([]); expect(requests).toBe(0);
    expect(git("diff", "--cached", "--name-only")).toBe("file.txt");
    expect(() => git("rev-parse", "--verify", "-q", "HEAD")).toThrow();
    expect((await repository.getBinding("user:a", binding.id))?.repository?.permissions.push).toBe(true);
  });

  it("control: the same read-only repository may still fetch, and that fetch does reach the Git endpoint", async () => {
    const state = { pull: true, push: false, validations: [] as string[], lookups: 0 };
    const { svc, binding } = await bound("gitea", state);
    const expectedVersion = (await svc.status("user:a", binding.id)).version;
    const error = await rejection(svc.operate("user:a", "fetch", { bindingId: binding.id, expectedVersion, paths: [] }, author));
    expect(error).toBeInstanceOf(GitControlError); expect((error as GitControlError).code).not.toBe("INSUFFICIENT_PERMISSION");
    expect(requests).toBeGreaterThan(0); expect(state.validations.length).toBeGreaterThan(0);
  });

  it("an unreadable repository refuses fetch and binding before any Git request", async () => {
    const state = { pull: true, push: false, validations: [] as string[], lookups: 0 };
    const { svc, binding } = await bound("gitlab", state);
    state.pull = false;
    const expectedVersion = (await svc.status("user:a", binding.id)).version;
    await expect(svc.operate("user:a", "fetch", { bindingId: binding.id, expectedVersion, paths: [] }, author)).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
    await expect(svc.bindRepository("user:a", project, "gitlab", "repo-1")).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
    expect(requests).toBe(0);
  });
});
