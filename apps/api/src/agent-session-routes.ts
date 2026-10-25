import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  agentSessionHistoryQuerySchema, agentSessionHistoryResponseSchema, cliTaskHistoryQuerySchema,
  cliTaskHistoryResponseSchema, type CodexEnvironment, codexEnvironmentSchema, codexHistoryItemSchema,
  codexHistoryResponseSchema, codexThreadQuerySchema, codexThreadResponseSchema
} from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { AgentSessionHistoryService } from "./agent-session-history.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { applySpacePaneTitlesToCodexHistory } from "./codex-history-titles.js";
import type { CodexParityService } from "./codex-parity.js";
import { assertCliPaneCompatible, getPaneById } from "./pane-guards.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import type { UnifiedCliTaskRegistry } from "./unified-cli-task-registry.js";

const codexThreadParamSchema = z.object({ id: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._:-]+$/) });

const agentSessionThreadParamSchema = z.object({ id: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._:-]+$/) });

const agentSessionRenameRequestSchema = z.object({ title: z.string().trim().min(1).max(300) });

const codexHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    includeArchived: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .default(false)
      .transform((value) => value === true || value === "true"),
    dedupeTitles: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .default(false)
      .transform((value) => value === true || value === "true"),
    q: z.string().max(300).optional()
  })
  .transform((input) => ({
    page: input.page ?? 1,
    pageSize: input.pageSize ?? input.limit ?? 50,
    limit: input.limit,
    includeArchived: input.includeArchived,
    dedupeTitles: input.dedupeTitles,
    q: input.q?.trim() || undefined
  }));

/**
 * Codex history, unified CLI task list and agent session history; the parent retains authentication, CSRF, errors
 * and rate limits.
 */
export function registerAgentSessionHistoryRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  codexParity: CodexParityService;
  unifiedCliTaskRegistry: UnifiedCliTaskRegistry;
  agentSessionHistoryService: AgentSessionHistoryService;
  visibleCliRuntimeIds: () => Promise<string[]>;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, codexParity, unifiedCliTaskRegistry, agentSessionHistoryService, visibleCliRuntimeIds,
    routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/codex/history", defaultRouteRateLimitOptions, async (request) => {
    const query = parseQuery(codexHistoryQuerySchema, request.query);
    return codexHistoryResponseSchema.parse(
      await codexParity.listHistory({
        page: query.page,
        pageSize: query.pageSize,
        limit: query.limit,
        includeArchived: query.includeArchived,
        dedupeTitles: query.dedupeTitles,
        q: query.q,
        mapRows: (rows) => applySpacePaneTitlesToCodexHistory(store, rows)
      })
    );
  });
  // Unified CLI task history endpoint (all providers)
  app.get("/api/cli/tasks", defaultRouteRateLimitOptions, async (request) => {
    const query = parseQuery(cliTaskHistoryQuerySchema, request.query);
    const visibleRuntimeIds = await visibleCliRuntimeIds();
    if (!visibleRuntimeIds.includes("cli:codex")) visibleRuntimeIds.push("cli:codex");
    const runtimeIds = query.runtimeId
      ? visibleRuntimeIds.includes(query.runtimeId) ? [query.runtimeId] : []
      : visibleRuntimeIds;
    const result = await unifiedCliTaskRegistry.listAllTasks({
      page: query.page,
      pageSize: query.pageSize,
      includeArchived: query.includeArchived,
      q: query.q,
      runtimeIds
    });
    return cliTaskHistoryResponseSchema.parse({
      threads: result.tasks,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize
    });
  });
  // Agent session history endpoint (merged Codex threads + active CLI tasks)
  app.get("/api/agent/sessions", defaultRouteRateLimitOptions, async (request) => {
    const query = parseQuery(agentSessionHistoryQuerySchema, request.query);
    const requestedId = await visibleCliRuntimeIds();
    if (!requestedId.includes("cli:codex")) requestedId.push("cli:codex");
    return agentSessionHistoryResponseSchema.parse(
      await agentSessionHistoryService.list({
        page: query.page,
        pageSize: query.pageSize,
        includeArchived: query.includeArchived,
        q: query.q,
        interval: query.interval,
        status: query.status,
        runtimeIds: requestedId
      })
    );
  });
}

/**
 * Codex session rename/archive, pane recovery task, Codex thread and environment views; the parent retains
 * authentication, CSRF, errors and rate limits.
 */
export function registerAgentSessionThreadRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  codexParity: CodexParityService;
  unifiedCliTaskRegistry: UnifiedCliTaskRegistry;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  visibleCliRuntimeIds: () => Promise<string[]>;
  readCodexEnvironmentSpaceStats: () => Promise<NonNullable<CodexEnvironment["spaceStats"]>>;
  readCodexEnvironmentHostStats: () => Promise<CodexEnvironment["hostStats"] | undefined>;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, codexParity, unifiedCliTaskRegistry, cliRuntimeVisibility, visibleCliRuntimeIds,
    readCodexEnvironmentSpaceStats, readCodexEnvironmentHostStats, routeOptions: defaultRouteRateLimitOptions } = options;
  app.post(
    "/api/agent/sessions/codex/:id/rename",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const params = parseQuery(agentSessionThreadParamSchema, request.params);
      const input = parseBody(agentSessionRenameRequestSchema, request.body ?? {});
      return codexHistoryItemSchema.parse(await codexParity.renameThread(params.id, input.title));
    }
  );
  app.post(
    "/api/agent/sessions/codex/:id/archive",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const params = parseQuery(agentSessionThreadParamSchema, request.params);
      return codexHistoryItemSchema.parse(await codexParity.archiveThread(params.id));
    }
  );
  app.get("/api/panes/:id/cli/recovery-task", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    const visibleRuntimeIds = await visibleCliRuntimeIds();
    if (!visibleRuntimeIds.includes("cli:codex")) visibleRuntimeIds.push("cli:codex");
    const task = await unifiedCliTaskRegistry.findLatestTaskForPane(pane.id, visibleRuntimeIds);
    return cliTaskHistoryResponseSchema.parse({
      threads: task ? [task] : [],
      total: task ? 1 : 0,
      page: 1,
      pageSize: 1
    });
  });
  app.get("/api/codex/threads/:id", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(codexThreadParamSchema, request.params);
    const query = parseQuery(codexThreadQuerySchema, request.query);
    return codexThreadResponseSchema.parse(await codexParity.getThread(params.id, { presentation: query.presentation }));
  });
  app.get("/api/codex/environment", defaultRouteRateLimitOptions, async () => {
    const [environment, spaceStats, hostStats, isCodexEnabled] = await Promise.all([
      codexParity.getEnvironment(),
      readCodexEnvironmentSpaceStats(),
      readCodexEnvironmentHostStats(),
      cliRuntimeVisibility.isEnabled("cli:codex")
    ]);
    return codexEnvironmentSchema.parse({
      ...environment,
      isCodexEnabled,
      spaceStats,
      ...(hostStats ? { hostStats } : {})
    });
  });
}
