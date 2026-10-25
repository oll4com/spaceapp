import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  listSharedTasksQuerySchema, type SharedTask, sharedTaskSchema, type SwarmTask, updateCodexGoalTaskInputSchema
} from "@space/contracts";
import { type CodexGoalsAdapter, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";

const codexGoalThreadParamSchema = z.object({ threadId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/) });

function sharedTaskFromSwarmTask(task: SwarmTask): SharedTask {
  return sharedTaskSchema.parse({
    id: `space_swarm:${task.id}`,
    source: "space_swarm",
    title: task.title,
    status: task.status,
    roomId: task.roomId,
    role: task.role,
    assignee: task.assignee,
    resultSummary: task.resultSummary,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  });
}

function sortSharedTasks(tasks: SharedTask[], sortOrder: "asc" | "desc"): SharedTask[] {
  return [...tasks].sort((left, right) => {
    const order = left.updatedAt.localeCompare(right.updatedAt);
    return sortOrder === "asc" ? order : -order;
  });
}

/**
 * Shared task list (swarm tasks and Codex goals) and Codex goal updates; the parent retains authentication, CSRF,
 * errors and rate limits.
 */
export function registerSharedTaskRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  codexGoals: CodexGoalsAdapter;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, codexGoals, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/tasks", defaultRouteRateLimitOptions, async (request) => {
    const page = parseQuery(listSharedTasksQuerySchema, request.query);
    const tasks: SharedTask[] = [];
    if (page.source === "all" || page.source === "space_swarm") {
      const swarmTasks = await store.listSwarmTasks({ page: 1, pageSize: 100, sortOrder: page.sortOrder });
      tasks.push(...swarmTasks.map(sharedTaskFromSwarmTask));
    }
    if (page.source === "all" || page.source === "codex_goal") {
      tasks.push(...(await codexGoals.list()));
    }
    const sortedTasks = sortSharedTasks(tasks, page.sortOrder);
    const start = (page.page - 1) * page.pageSize;
    return {
      data: sortedTasks.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: sortedTasks.length,
        totalPages: Math.ceil(sortedTasks.length / page.pageSize)
      }
    };
  });
  app.patch("/api/tasks/codex-goals/:threadId", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const params = parseBody(codexGoalThreadParamSchema, request.params);
    const input = parseBody(updateCodexGoalTaskInputSchema, request.body);
    const updated = await codexGoals.update(params.threadId, input);
    if (!updated) {
      throw new SpaceNotFoundError(`Codex goal ${params.threadId} was not found.`);
    }
    await recordAudit(store, request, {
      action: "codex_goal.update",
      targetType: "codex_goal",
      targetId: updated.threadId,
      metadata: {
        status: updated.status,
        changedObjective: input.objective !== undefined
      }
    });
    return updated;
  });
}
