import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

describe("personal repository provider contracts", () => {
  it("registers six providers without expanding installation publishing", () => {
    expect(contracts.repositoryProviderIdSchema.options).toEqual(["github", "gitea", "forgejo", "gitlab", "bitbucket", "azure-devops"]);
    expect(contracts.sourceControlProviderSchema.options).toEqual(["gitea", "github"]);
    expect(contracts.repositoryProviderRegistry.map(p => p.id)).toEqual(contracts.repositoryProviderIdSchema.options);
    expect(contracts.repositoryProviderRegistry.filter(p => p.available).map(p => p.id)).toEqual(["github", "gitea", "forgejo", "gitlab", "bitbucket", "azure-devops"]);
    expect(contracts.repositoryProviderRegistry.filter(p => p.defaultEnabled).map(p => p.id)).toEqual(["github", "gitea"]);
    expect(contracts.isRepositoryProviderId("toString")).toBe(false);
    expect(contracts.isRepositoryProviderId("gitlab")).toBe(true);
  });

  it("normalizes legacy provider bindings without changing identity, defaults or remote metadata", () => {
    const binding = { id: "binding:legacy", ownerUserId: "user:a", projectPath: "/workspace/proof", provider: "github" as const,
      serverUrl: "https://github.com", repository: null, isDefault: true };
    expect(contracts.normalizeProviderBinding(binding)).toEqual({ ...binding, kind: "provider" });
    expect(binding).not.toHaveProperty("kind");
  });

  it("locks provider targets and pagination without assuming two-segment repository names", () => {
    expect(contracts.repositoryTargetSchema.parse({ id: "group/subgroup", provider: "gitlab", kind: "namespace", name: "Subgroup", parentId: "group", canCreateRepository: true }).id).toBe("group/subgroup");
    expect(contracts.repositoryListInputSchema.parse({ provider: "github", page: 2 }).page).toBe(2);
    expect(contracts.repositoryListInputSchema.parse({ provider: "gitlab", query: "project", cursor: "opaque-next", targetId: "group/subgroup" }).cursor).toBe("opaque-next");
    expect(contracts.repositoryListInputSchema.safeParse({ provider: "gitlab", cursor: "next", page: 2 }).success).toBe(false);
    expect(contracts.repositoryListInputSchema.safeParse({ provider: "github", page: 0 }).success).toBe(false);
  });

  it("separates local selection from creation and clone destination contracts", () => {
    expect(contracts.openProjectInputSchema.safeParse({ source: { kind: "local", path: "/workspace/existing" } }).success).toBe(true);
    expect(contracts.openProjectInputSchema.safeParse({ source: { kind: "new", name: "demo" }, destination: "/workspace/demo" }).success).toBe(true);
    expect(contracts.openProjectInputSchema.safeParse({ source: { kind: "provider", provider: "gitlab", repositoryId: "42" }, destination: "/workspace/demo" }).success).toBe(true);
    expect(contracts.openProjectInputSchema.safeParse({ source: { kind: "git-url", url: "https://example.org/team/repo.git" } }).success).toBe(false);
    for (const url of ["file:///etc", "ssh://host/repo", "https://token@example.org/repo", "https://example.org/repo?token=x"]) {
      expect(contracts.openProjectInputSchema.safeParse({ source: { kind: "git-url", url }, destination: "/workspace/demo" }).success).toBe(false);
    }
  });
});

describe("publish request contracts", () => {
  it("keeps private default and accepts explicit durable operation and target without staging fields", () => {
    const request = contracts.gitOperationSchema.parse({ bindingId: "fixture", expectedVersion: "v1", name: "repo", targetId: "organization:9", operationId: "operation-1" });
    expect(request).toMatchObject({ private: true, targetId: "organization:9", operationId: "operation-1", paths: [] });
    expect(contracts.gitOperationSchema.safeParse({ bindingId: "fixture", expectedVersion: "v1", operationId: "" }).success).toBe(false);
    expect(contracts.sourceControlProviderSchema.safeParse("gitlab").success).toBe(false);
  });
});
