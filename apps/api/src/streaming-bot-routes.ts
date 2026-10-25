import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { SpaceStore } from "@space/runtime";
import type { StreamingService } from "./streaming-service.js";
import type { AuditRecorder } from "./request-audit.js";
import type { StreamingBotService } from "./streaming-bot-service.js";
import type { DecisionsService } from "./decisions-service.js";
import type { createMcpToolExecutor } from "./mcp-tool-executor.js";
import { sendApiError } from "./http-errors.js";
import { z } from "zod";
import { updateStreamingBotSettingsInputSchema, streamingBotSettingsSchema, streamingBotStatusSchema, streamingBotActivitySchema, streamingBotTestInputSchema, createStreamingBotMemoryInputSchema, updateStreamingBotMemoryInputSchema, streamingBotReviewedMemorySchema, streamingBotMcpExecuteInputSchema } from "@space/contracts";
import { SpaceNotFoundError } from "@space/runtime";
import { PUBLIC_SPACEAPP_KNOWLEDGE, asksForOperatorPrivateData, containsSensitiveDisclosure, formatStreamingBotLiveMetrics } from "@space/streaming";
import { StreamingBotServiceError, toMcpExecuteResponse } from "./streaming-bot-service.js";

function parseBody<TSchema extends z.ZodType>(schema: TSchema, body: unknown): z.infer<TSchema> {
  return schema.parse(body);
}


/** Authentication, CSRF and internal-token gates are installed by the composition root. */
export function registerStreamingBotRoutes(app: FastifyInstance, options: {
  streamingService: Pick<StreamingService, "overlaySnapshot">;
  recordAudit: AuditRecorder;
  streamingBotService: Pick<StreamingBotService, "getSettings" | "modelOptions" | "updateSettings" | "setPaused" | "getStatus" | "listActivity" | "test" | "clearMemory" | "searchMemory" | "listReviewedMemory" | "listModerationActions" | "sendOperatorReply" | "timeoutFromActivity" | "timeoutReviewedAction" | "undoModerationAction" | "createReviewedMemory" | "updateReviewedMemory" | "deleteReviewedMemory">;
  decisionsService: Pick<DecisionsService, "decide">;
  store: Pick<SpaceStore, "listSkills">;
  executeMcpToolWithPolicy: ReturnType<typeof createMcpToolExecutor>;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { streamingService, recordAudit, streamingBotService, decisionsService, store, executeMcpToolWithPolicy, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/internal/streaming/bot/live-metrics", defaultRouteRateLimitOptions, async () => {
    return { metrics: formatStreamingBotLiveMetrics(await streamingService.overlaySnapshot()) };
  });
  app.get(
    "/api/admin/streaming/bot/settings",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot settings require the ADMIN role.");
      }
      const { settings, memoryCount } = await streamingBotService.getSettings();
      return { settings: streamingBotSettingsSchema.parse(settings), memoryCount };
    }
  );
  app.get("/api/admin/streaming/bot/models", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming model selection requires the ADMIN role.");
    return { models: await streamingBotService.modelOptions() };
  });
  app.patch(
    "/api/admin/streaming/bot/settings",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot settings require the ADMIN role.");
      }
      const input = parseBody(updateStreamingBotSettingsInputSchema, request.body);
      try {
        const settings = await streamingBotService.updateSettings(input, request.user.id);
        await recordAudit(request, {
          action: "admin.streaming.bot_saved",
          targetType: "streaming_bot_settings",
          targetId: "global",
          metadata: { version: settings.version, enabled: settings.enabled, memoryEnabled: settings.memoryEnabled }
        });
        return streamingBotSettingsSchema.parse(settings);
      } catch (error) {
        if (error instanceof StreamingBotServiceError) {
          return sendApiError(reply, error.statusCode, error.code, error.message);
        }
        throw error;
      }
    }
  );
  app.post(
    "/api/admin/streaming/bot/pause",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot controls require the ADMIN role.");
      }
      const settings = await streamingBotService.setPaused(true, request.user.id);
      await recordAudit(request, { action: "admin.streaming.bot_paused", targetType: "streaming_bot_settings", targetId: "global", metadata: { version: settings.version } });
      return streamingBotSettingsSchema.parse(settings);
    }
  );
  app.post(
    "/api/admin/streaming/bot/resume",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot controls require the ADMIN role.");
      }
      try {
        const settings = await streamingBotService.setPaused(false, request.user.id);
        await recordAudit(request, { action: "admin.streaming.bot_resumed", targetType: "streaming_bot_settings", targetId: "global", metadata: { version: settings.version } });
        return streamingBotSettingsSchema.parse(settings);
      } catch (error) {
        if (error instanceof StreamingBotServiceError) return sendApiError(reply, error.statusCode, error.code, error.message);
        throw error;
      }
    }
  );
  app.get(
    "/api/admin/streaming/bot/status",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot status requires the ADMIN role.");
      }
      return streamingBotStatusSchema.parse(await streamingBotService.getStatus());
    }
  );
  app.get(
    "/api/admin/streaming/bot/activity",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot activity requires the ADMIN role.");
      }
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict().parse(request.query);
      const activity = await streamingBotService.listActivity(limit);
      return { data: activity.map((record) => streamingBotActivitySchema.parse(record)), pagination: { page: 1, pageSize: limit, totalItems: activity.length, totalPages: 1 } };
    }
  );
  app.post(
    "/api/admin/streaming/bot/test",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot test requires the ADMIN role.");
      }
      const input = parseBody(streamingBotTestInputSchema, request.body);
      const result = await streamingBotService.test(input);
      await recordAudit(request, {
        action: "admin.streaming.bot_tested",
        targetType: "streaming_bot_settings",
        targetId: "global",
        metadata: { platform: input.platform, errorCode: result.errorCode, model: result.model }
      });
      return result;
    }
  );
  app.post(
    "/api/admin/streaming/bot/memory/clear",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot memory controls require the ADMIN role.");
      }
      parseBody(z.object({}).strict(), request.body ?? {});
      const result = await streamingBotService.clearMemory();
      await recordAudit(request, {
        action: "admin.streaming.bot_memory_cleared",
        targetType: "streaming_bot_settings",
        targetId: "global",
        metadata: { removed: result.removed }
      });
      return result;
    }
  );
  app.get(
    "/api/admin/streaming/bot/memory/search",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot memory search requires the ADMIN role.");
      }
      const { q, limit } = z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict().parse(request.query);
      return streamingBotService.searchMemory(q, limit);
    }
  );
  app.get("/api/admin/streaming/bot/memory", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot memory requires the ADMIN role.");
    const input = z.object({ status: z.enum(["PENDING", "APPROVED"]).default("APPROVED"), q: z.string().max(200).default(""), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(request.query);
    const entries = await streamingBotService.listReviewedMemory(input.status, input.limit, input.q);
    return { entries: entries.map(entry => streamingBotReviewedMemorySchema.parse(entry)) };
  });
  app.get("/api/admin/streaming/bot/moderation", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming moderation requires the ADMIN role.");
    const actions = await streamingBotService.listModerationActions(100);
    return { actions };
  });
  app.get("/api/admin/streaming/live-context", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming Live context requires the ADMIN role.");
    const [snapshot, activity, memory, bot] = await Promise.all([
      streamingService.overlaySnapshot(),
      streamingBotService.listActivity(30),
      streamingBotService.listReviewedMemory("APPROVED", 30),
      streamingBotService.getStatus()
    ]);
    return {
      generatedAt: new Date().toISOString(),
      bot: { enabled: bot.enabled, platforms: Object.fromEntries(Object.entries(bot.platforms).map(([name, state]) => [name, { connected: state.connected, live: state.live, lastPollAt: state.lastPollAt }])) },
      metrics: snapshot.tiles.filter(tile => tile.provider !== "SPACE").map(tile => ({ provider: tile.provider, label: tile.label, badge: tile.badge, value: tile.value, state: tile.state, sampledAt: tile.sampledAt })),
      messages: activity.filter(item => item.direction === "IN" && !asksForOperatorPrivateData(item.message) &&
        !containsSensitiveDisclosure(`${item.author ?? ""} ${item.message}`))
        .map(item => ({ id: item.id, platform: item.platform, author: item.author, message: item.message.slice(0, 500), at: item.createdAt })),
      targets: activity.filter(item => item.direction === "IN" && !item.protectedAccount && item.authorId &&
        !containsSensitiveDisclosure(item.author ?? "") &&
        Date.now() - Date.parse(item.createdAt) < 10 * 60_000).map(item => ({ id: item.id, platform: item.platform, author: item.author, at: item.createdAt })),
      moderation: (await streamingBotService.listModerationActions(30)).map(item => ({ id: item.id, platform: item.platform,
        author: (() => { const name = activity.find(record => record.messageId === item.messageId)?.author ?? null;
          return name && !containsSensitiveDisclosure(name) ? name : null; })(),
        decision: item.decision, reason: item.reason, durationSeconds: item.durationSeconds, result: item.result, at: item.createdAt })),
      memory: memory.filter(item => !containsSensitiveDisclosure(`${item.title} ${item.body}`)).map(item => ({ title: item.title, body: item.body.slice(0, 500) })),
      knowledge: PUBLIC_SPACEAPP_KNOWLEDGE.map(item => ({ source: item.source, version: item.version, answer: item.answer }))
    };
  });
  app.post("/api/admin/streaming/live-action", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming Live actions require the ADMIN role.");
    const input = parseBody(z.discriminatedUnion("action", [
      z.object({ action: z.literal("REPLY"), platform: z.enum(["YOUTUBE", "TWITCH"]), message: z.string().trim().min(1).max(500) }).strict(),
      z.object({ action: z.literal("PAUSE") }).strict(),
      z.object({ action: z.literal("TIMEOUT"), activityId: z.string().min(1).max(200), durationSeconds: z.union([z.literal(300), z.literal(1800)]) }).strict(),
      z.object({ action: z.literal("UNDO"), moderationActionId: z.string().min(1).max(200) }).strict()
    ]), request.body);
    try {
      const result = input.action === "REPLY" ? await streamingBotService.sendOperatorReply(input.platform, input.message)
        : input.action === "PAUSE" ? await streamingBotService.setPaused(true, request.user.id)
        : input.action === "TIMEOUT" ? await streamingBotService.timeoutFromActivity(input.activityId, input.durationSeconds)
        : await streamingBotService.undoModerationAction(input.moderationActionId);
      await recordAudit(request, { action: `admin.streaming.live_${input.action.toLowerCase()}`, targetType: "streaming_live_action",
        targetId: input.action === "TIMEOUT" ? input.activityId : input.action === "UNDO" ? input.moderationActionId : input.action,
        metadata: { result: "SUCCEEDED" } });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof StreamingBotServiceError) return sendApiError(reply, error.statusCode, error.code, error.message);
      throw error;
    }
  });
  app.post("/api/admin/streaming/bot/moderation/:id/timeout", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming moderation requires the ADMIN role.");
    const { id } = z.object({ id: z.string().min(1).max(200) }).strict().parse(request.params);
    const { durationSeconds } = parseBody(z.object({ durationSeconds: z.union([z.literal(300), z.literal(1800)]) }).strict(), request.body);
    const action = await streamingBotService.timeoutReviewedAction(id, durationSeconds);
    await recordAudit(request, { action: "admin.streaming.moderation_review_timeout", targetType: "streaming_moderation_action", targetId: id, metadata: { platform: action.platform, durationSeconds } });
    return action;
  });
  app.post("/api/admin/streaming/bot/moderation/:id/undo", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming moderation requires the ADMIN role.");
    const { id } = z.object({ id: z.string().min(1).max(200) }).strict().parse(request.params);
    parseBody(z.object({}).strict(), request.body ?? {});
    try {
      const action = await streamingBotService.undoModerationAction(id);
      await recordAudit(request, { action: "admin.streaming.moderation_undone", targetType: "streaming_moderation_action", targetId: id, metadata: { platform: action.platform, result: action.result } });
      return action;
    } catch (error) {
      if (error instanceof StreamingBotServiceError) return sendApiError(reply, error.statusCode, error.code, error.message);
      throw error;
    }
  });
  app.post("/api/internal/streaming/bot/moderation-triage", defaultRouteRateLimitOptions, async (request) => {
    const { message } = parseBody(z.object({ message: z.string().trim().min(1).max(2000) }).strict(), request.body);
    const result = await decisionsService.decide({
      state: message,
      questions: { verdict: { type: "choice", instructions: "Classify a public live-chat message for moderation. Criticism, disagreement, capitals or one isolated swear are SAFE. Clear threats or publication of private information are SEVERE. Repeated targeted insults or harassment are ABUSE. Uncertain intent is AMBIGUOUS.",
        criteria: { SAFE: "No action", ABUSE: "Targeted verbal abuse or harassment", SEVERE: "Clear threat or doxxing", AMBIGUOUS: "Needs human review" } } }
    });
    if (!result.available) return { available: false, verdict: null };
    const answer = result.answers.verdict;
    const choice = answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>).choice : null;
    return { available: true, verdict: typeof choice === "string" && ["SAFE", "ABUSE", "SEVERE", "AMBIGUOUS"].includes(choice) ? choice : "AMBIGUOUS" };
  });
  app.post("/api/admin/streaming/bot/memory", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot memory requires the ADMIN role.");
    const input = parseBody(createStreamingBotMemoryInputSchema, request.body);
    const entry = await streamingBotService.createReviewedMemory(input);
    await recordAudit(request, { action: "admin.streaming.bot_memory_created", targetType: "streaming_bot_memory", targetId: entry.id, metadata: { status: entry.status } });
    return streamingBotReviewedMemorySchema.parse(entry);
  });
  app.patch("/api/admin/streaming/bot/memory/:id", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot memory requires the ADMIN role.");
    const { id } = z.object({ id: z.string().min(1).max(200) }).strict().parse(request.params);
    const input = parseBody(updateStreamingBotMemoryInputSchema, request.body);
    try {
      const entry = await streamingBotService.updateReviewedMemory(id, input);
      await recordAudit(request, { action: "admin.streaming.bot_memory_updated", targetType: "streaming_bot_memory", targetId: id, metadata: { status: entry.status, version: entry.version } });
      return streamingBotReviewedMemorySchema.parse(entry);
    } catch (error) {
      if (error instanceof StreamingBotServiceError) return sendApiError(reply, error.statusCode, error.code, error.message);
      throw error;
    }
  });
  app.delete("/api/admin/streaming/bot/memory/:id", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming bot memory requires the ADMIN role.");
    const { id } = z.object({ id: z.string().min(1).max(200) }).strict().parse(request.params);
    const deleted = await streamingBotService.deleteReviewedMemory(id);
    if (deleted) await recordAudit(request, { action: "admin.streaming.bot_memory_deleted", targetType: "streaming_bot_memory", targetId: id, metadata: {} });
    return { deleted };
  });
  app.post("/api/internal/streaming/bot/mcp-execute", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(streamingBotMcpExecuteInputSchema, request.body ?? {});
    const result = await executeMcpToolWithPolicy({
      toolId: input.toolId,
      arguments: input.arguments ?? {}
    }, request);
    return toMcpExecuteResponse({
      status: result.status === "EXECUTED" ? "EXECUTED" : "FAILED",
      code: result.code,
      message: result.message,
      serverId: result.serverId,
      toolName: result.toolName,
      observation: result.artifact?.storageUri ?? null
    });
  });
  app.get("/api/internal/streaming/bot/skills/:name", defaultRouteRateLimitOptions, async (request) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(160) }).strict().parse(request.params);
    const skills = await store.listSkills();
    const skill = skills.find((candidate) => candidate.id === name || candidate.displayName === name);
    if (!skill || skill.status !== "VERIFIED") {
      throw new SpaceNotFoundError(`Skill ${name} was not found or is not active.`);
    }
    return { content: skill.body };
  });
}
