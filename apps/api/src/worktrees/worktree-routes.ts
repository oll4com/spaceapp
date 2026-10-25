import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createWorktreeSchema,
  mergeWorktreeSchema,
  type CreateWorktreeInput,
  type MergeWorktreeInput
} from "@space/contracts";
import type { SpaceWorktree } from "@space/contracts";
import { createStaleWhileRevalidateCache } from "../stale-while-revalidate.js";
import { WORKTREES_ROOT, WorktreeError, WorktreeService } from "./worktree-service.js";
import { assertRemovableWorktreePath, parseForceFlag } from "./worktree-removal-guard.js";

/**
 * Worktree badges poll each path every few seconds and every status read
 * spawns several git processes, so one result per path is shared for this
 * long. Mutations through these routes clear the cache immediately.
 */
// Badges poll every 7.5 s; each load runs 3 git (stable 2026-10-24: ~3,100 git an hour at 20 s). Remove reads `fresh=1`.
export const WORKTREE_ITEM_CACHE_TTL_MS = 60_000;
const worktreeItemCacheMaxEntries = 256;

export interface WorktreeRoutesOptions {
  service: WorktreeService;
  rateLimitOptions?: Record<string, unknown>;
  /** Authorizes listing, creation, merge, removal and cleanup. The composition root requires an
   * ADMIN or OPERATOR session; standalone route tests may omit it. */
  authorizeDestructive?: (request: FastifyRequest) => boolean;
  /** Managed checkout directory whose non-Git leftovers may be removed. */
  managedWorktreesRoot?: string;
  /** Override for tests; 0 disables the per-path status cache. */
  itemCacheTtlMs?: number;
}

export function registerWorktreeRoutes(app: FastifyInstance, options: WorktreeRoutesOptions) {
  const { service, rateLimitOptions = {}, authorizeDestructive, managedWorktreesRoot = WORKTREES_ROOT } = options;
  const requireDestructiveAccess = (request: FastifyRequest) => {
    if (authorizeDestructive && !authorizeDestructive(request)) {
      throw new WorktreeError("FORBIDDEN", "Worktree listing, creation, merge, removal and cleanup require ADMIN or OPERATOR access.", 403);
    }
  };
  const itemCacheTtlMs = Math.max(0, options.itemCacheTtlMs ?? WORKTREE_ITEM_CACHE_TTL_MS);
  // Plain TTL: no stale reads and no cached failures or misses (404s).
  const itemCache = createStaleWhileRevalidateCache<SpaceWorktree>({
    freshMs: itemCacheTtlMs,
    maxAgeMs: itemCacheTtlMs,
    maxEntries: worktreeItemCacheMaxEntries
  });
  const loadWorktreeItem = async (path: string): Promise<SpaceWorktree> => {
    const worktree = await service.getWorktree(path);
    if (!worktree) {
      throw new WorktreeError("NOT_FOUND", `Worktree not found for ${path}`, 404);
    }
    return worktree;
  };
  // A merge into main changes ahead/behind counts of every other worktree, so
  // every mutation drops all cached statuses, also when it fails part-way.
  const invalidatingWorktreeItems = async <T>(mutation: () => Promise<T>): Promise<T> => {
    try {
      return await mutation();
    } finally {
      itemCache.invalidate();
    }
  };

  const handler = (action: (request: FastifyRequest) => Promise<unknown>) => async (
    request: FastifyRequest,
    reply: import("fastify").FastifyReply
  ) => {
    try {
      return await action(request);
    } catch (error) {
      if (error instanceof WorktreeError) {
        request.log.warn({ err: error, body: request.body }, "Worktree error");
        return reply.code(error.statusCode).send({
          error: { code: error.code, message: error.message }
        });
      }
      if (error instanceof z.ZodError) {
        request.log.warn({ err: error, issues: error.issues, body: request.body }, "Worktree validation error");
        return reply.code(400).send({
          error: { code: "INVALID_INPUT", message: "Worktree request validation failed.", details: error.issues }
        });
      }
      request.log.error({ err: error, body: request.body }, "Worktree unhandled error");
      return reply.code(500).send({
        // The cause stays in the log; git and filesystem messages can name host paths (1.1.5 review F20).
        error: { code: "WORKTREE_OPERATION_FAILED", message: "The worktree operation failed; the API log has the cause." }
      });
    }
  };

  app.get(
    "/api/worktrees",
    rateLimitOptions,
    handler(async (request) => {
      requireDestructiveAccess(request);
      const query = z
        .object({
          repoPath: z.string().min(1).default("/opt/spaceapp")
        })
        .parse(request.query);
      const data = await service.listWorktrees(query.repoPath);
      return { data };
    })
  );

  app.post(
    "/api/worktrees",
    rateLimitOptions,
    handler(async (request) => {
      // Create may commit everything in an unborn repository and runs its hooks (1.1.5 review F20).
      requireDestructiveAccess(request);
      const body = createWorktreeSchema.parse(request.body);
      const worktree = await invalidatingWorktreeItems(() => service.createWorktree(body));
      return { ok: true, data: worktree };
    })
  );

  app.get(
    "/api/worktrees/item",
    rateLimitOptions,
    handler(async (request) => {
      const query = z.object({ path: z.string().min(1), fresh: z.literal("1").optional() }).parse(request.query);
      const worktree = itemCacheTtlMs > 0
        ? await itemCache.get(query.path, () => loadWorktreeItem(query.path), { force: query.fresh === "1" })
        : await loadWorktreeItem(query.path);
      return { data: worktree };
    })
  );

  app.post(
    "/api/worktrees/merge",
    rateLimitOptions,
    handler(async (request) => {
      requireDestructiveAccess(request);
      const body = z
        .object({
          path: z.string().min(1),
          strategy: z.enum(["merge", "squash", "rebase"]).default("merge"),
          commitMessage: z.string().max(10000).optional(),
          deleteBranchAfter: z.boolean().default(true)
        })
        .parse(request.body ?? {});
      const result = await invalidatingWorktreeItems(() => service.mergeWorktree(body.path, body));
      return result;
    })
  );

  app.delete(
    "/api/worktrees",
    rateLimitOptions,
    handler(async (request) => {
      requireDestructiveAccess(request);
      // z.coerce.boolean() would turn "false" into true; only explicit true forces.
      const query = z.object({ path: z.string().min(1), force: z.unknown().optional() }).parse(request.query);
      await assertRemovableWorktreePath(query.path, managedWorktreesRoot);
      await invalidatingWorktreeItems(() => service.removeWorktree(query.path, parseForceFlag(query.force)));
      return { ok: true };
    })
  );

  app.post(
    "/api/worktrees/clean",
    rateLimitOptions,
    handler(async (request) => {
      requireDestructiveAccess(request);
      const body = z
        .object({
          repoPath: z.string().min(1).default("/opt/spaceapp"),
          dryRun: z.boolean().default(false),
          force: z.boolean().default(false),
          excludePaths: z.array(z.string()).optional()
        })
        .parse(request.body ?? {});
      const result = await invalidatingWorktreeItems(() => service.cleanCompletedWorktrees(body.repoPath, {
        dryRun: body.dryRun,
        force: body.force,
        excludePaths: body.excludePaths
      }));
      return { ok: true, ...result };
    })
  );
}
