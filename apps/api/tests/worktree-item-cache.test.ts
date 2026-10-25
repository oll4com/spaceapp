import Fastify from "fastify";
import type { SpaceWorktree } from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorktreeRoutes, WORKTREE_ITEM_CACHE_TTL_MS } from "../src/worktrees/worktree-routes.js";
import type { WorktreeService } from "../src/worktrees/worktree-service.js";

const worktreePath = "/opt/spaceapp/var/worktrees/space/wt-cache";

function worktree(overrides: Partial<SpaceWorktree> = {}): SpaceWorktree {
  return {
    id: "wt:wt-cache",
    repoPath: "/opt/spaceapp",
    worktreePath,
    branch: "space/wt-cache",
    baseBranch: "main",
    baseCommit: "abc123",
    roomId: "",
    status: "ACTIVE",
    isDirty: false,
    aheadCount: 1,
    behindCount: 0,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides
  };
}

function fakeService(getWorktree: WorktreeService["getWorktree"]) {
  const service = {
    getWorktree: vi.fn(getWorktree),
    createWorktree: vi.fn(async () => worktree({ worktreePath: "/tmp/new-worktree" })),
    mergeWorktree: vi.fn(async () => ({ ok: true, commitSha: "def456" })),
    removeWorktree: vi.fn(async () => undefined),
    cleanCompletedWorktrees: vi.fn(async () => ({ cleaned: [], preserved: [] })),
    listWorktrees: vi.fn(async () => [])
  };
  return service;
}

async function routes(service: ReturnType<typeof fakeService>, itemCacheTtlMs?: number) {
  const app = Fastify();
  registerWorktreeRoutes(app, {
    service: service as unknown as WorktreeService,
    ...(itemCacheTtlMs === undefined ? {} : { itemCacheTtlMs })
  });
  await app.ready();
  return app;
}

const itemUrl = `/api/worktrees/item?path=${encodeURIComponent(worktreePath)}`;

describe("worktree item status cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one git status read between concurrent requests and keeps the response shape", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = fakeService(async () => {
      await gate;
      return worktree();
    });
    const app = await routes(service);

    const pending = Promise.all([
      app.inject({ method: "GET", url: itemUrl }),
      app.inject({ method: "GET", url: itemUrl })
    ]);
    await vi.waitFor(() => expect(service.getWorktree).toHaveBeenCalledOnce());
    release();
    const [first, second] = await pending;

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ data: worktree() });
    expect(second.json()).toEqual(first.json());
    expect(service.getWorktree).toHaveBeenCalledOnce();
    expect(service.getWorktree).toHaveBeenCalledWith(worktreePath);
    await app.close();
  });

  it("reuses a status for the TTL window and reloads after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
    const service = fakeService(async () => worktree());
    const app = await routes(service);

    await app.inject({ method: "GET", url: itemUrl });
    vi.setSystemTime(Date.now() + WORKTREE_ITEM_CACHE_TTL_MS - 1);
    await app.inject({ method: "GET", url: itemUrl });
    expect(service.getWorktree).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + 1);
    service.getWorktree.mockResolvedValueOnce(worktree({ isDirty: true, status: "DIRTY" }));
    const refreshed = await app.inject({ method: "GET", url: itemUrl });
    expect(refreshed.json().data.isDirty).toBe(true);
    expect(service.getWorktree).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("reads a fresh status for fresh=1 (the badge's Remove) and keeps it for the polls", async () => {
    const service = fakeService(async () => worktree());
    const app = await routes(service);
    await app.inject({ method: "GET", url: itemUrl });
    service.getWorktree.mockResolvedValueOnce(worktree({ isDirty: true, status: "DIRTY" }));
    const fresh = await app.inject({ method: "GET", url: `${itemUrl}&fresh=1` });
    expect(fresh.json().data.isDirty).toBe(true);
    expect((await app.inject({ method: "GET", url: itemUrl })).json().data.isDirty).toBe(true);
    expect(service.getWorktree).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("caches neither 404 misses nor failures", async () => {
    const service = fakeService(async () => null);
    const app = await routes(service);

    const missing = await app.inject({ method: "GET", url: itemUrl });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: `Worktree not found for ${worktreePath}` }
    });

    service.getWorktree.mockRejectedValueOnce(new Error("git exploded"));
    const failed = await app.inject({ method: "GET", url: itemUrl });
    expect(failed.statusCode).toBe(500);

    service.getWorktree.mockResolvedValueOnce(worktree());
    const recovered = await app.inject({ method: "GET", url: itemUrl });
    expect(recovered.statusCode).toBe(200);
    expect(service.getWorktree).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it.each([
    ["create", { method: "POST", url: "/api/worktrees", payload: { repoPath: "/opt/spaceapp", roomId: "room:test" } }],
    ["merge", { method: "POST", url: "/api/worktrees/merge", payload: { path: worktreePath } }],
    ["remove", { method: "DELETE", url: `/api/worktrees?path=${encodeURIComponent(worktreePath)}&force=true` }],
    ["clean", { method: "POST", url: "/api/worktrees/clean", payload: { repoPath: "/opt/spaceapp" } }]
  ] as const)("drops cached statuses after a %s", async (_name, mutation) => {
    const service = fakeService(async () => worktree());
    const app = await routes(service);
    await app.inject({ method: "GET", url: itemUrl });
    await app.inject({ method: "GET", url: itemUrl });
    expect(service.getWorktree).toHaveBeenCalledOnce();

    const response = await app.inject(mutation as Parameters<typeof app.inject>[0]);
    expect(response.statusCode).toBe(200);

    service.getWorktree.mockResolvedValueOnce(worktree({ status: "MERGED", aheadCount: 0 }));
    const after = await app.inject({ method: "GET", url: itemUrl });
    expect(after.json().data.status).toBe("MERGED");
    expect(service.getWorktree).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("drops cached statuses even when a mutation fails", async () => {
    const service = fakeService(async () => worktree());
    service.mergeWorktree.mockRejectedValueOnce(new Error("merge conflict"));
    const app = await routes(service);
    await app.inject({ method: "GET", url: itemUrl });

    const merge = await app.inject({ method: "POST", url: "/api/worktrees/merge", payload: { path: worktreePath } });
    expect(merge.statusCode).toBe(500);

    await app.inject({ method: "GET", url: itemUrl });
    expect(service.getWorktree).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("does not let a status read that overlapped a mutation repopulate the cache", async () => {
    let releaseRead!: () => void;
    const slowRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const service = fakeService(async () => {
      await slowRead;
      return worktree({ aheadCount: 1 });
    });
    const app = await routes(service);

    const overlapping = app.inject({ method: "GET", url: itemUrl });
    await vi.waitFor(() => expect(service.getWorktree).toHaveBeenCalledOnce());
    await app.inject({ method: "POST", url: "/api/worktrees/merge", payload: { path: worktreePath } });
    releaseRead();
    expect((await overlapping).statusCode).toBe(200);

    service.getWorktree.mockResolvedValueOnce(worktree({ aheadCount: 0, status: "MERGED" }));
    const after = await app.inject({ method: "GET", url: itemUrl });
    expect(after.json().data.status).toBe("MERGED");
    await app.close();
  });

  it("can be disabled for callers that need uncached reads", async () => {
    const service = fakeService(async () => worktree());
    const app = await routes(service, 0);
    await app.inject({ method: "GET", url: itemUrl });
    await app.inject({ method: "GET", url: itemUrl });
    expect(service.getWorktree).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
