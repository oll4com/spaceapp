import { operatorHands } from "../owner-clock.js";
import type {} from "../request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  effectiveMarketingAutonomy, MARKETING_CHANNELS, marketingBookmarkCreateSchema, marketingBookmarkIdSchema, marketingCampaignCreateSchema, marketingCampaignIdSchema, marketingChannelSchema, marketingEventIdSchema, marketingMemoryCreateSchema,
  marketingMemoryIdSchema, marketingMemoryQuerySchema, marketingPostCreateSchema, marketingPostIdSchema, marketingPostStatusSchema, marketingPostUpdateSchema, marketingPublishBeginSchema,
  marketingPostMetricsRecordSchema, marketingPublishDoneSchema, marketingPublishFailedSchema, marketingPublishDeferSchema, marketingQuestionAskSchema, marketingQuestionIdSchema, marketingRuleProposalSchema, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { PUBLIC_SPACEAPP_KNOWLEDGE, searchPublicSpaceappKnowledge } from "@space/streaming";
import { GitControlError } from "../source-control/errors.js";
import type { MarketingCopilotService } from "./service.js";

// Agent-facing routes of the Marketing Copilot pane, reached with the pane-scoped CLI bridge token. The owner is
// the room owner; the agent drafts, asks and reports, and publishes only through the publish gate.
export const cliMarketingCopilotPathPrefix = "/api/cli/marketing-copilot/";

export interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface MarketingCopilotAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane" | "getControlActor" | "getUserSettings">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
}

const waitMs = z.number().int().min(0).max(120_000).default(60_000);
const postParamsSchema = z.object({ id: marketingPostIdSchema }).strict();

type BookmarkBridge = { owner: string; pane: Pane; cliSessionId: string };

/** The operator's bookmarks (one list per owner), each opened in a new tab of the pane browser with its Google account; the Freelance Copilot's bridge registers the same routes. */
export function registerBookmarkAgentRoutes(
  handle: (method: "get" | "post" | "delete", path: string, handler: (bridge: BookmarkBridge, request: FastifyRequest) => Promise<unknown>) => void,
  service: Pick<MarketingCopilotService, "listBookmarks" | "createBookmark" | "openBookmark" | "deleteBookmark">,
  deps: Pick<MarketingCopilotAgentRouteDependencies, "store" | "parseBody" | "parseQuery" | "audit">,
  auditPrefix: string
): void {
  handle("get", "bookmarks", async ({ owner }) => ({ bookmarks: await service.listBookmarks(owner) }));
  handle("post", "bookmarks", async ({ owner, pane }, request) => {
    const input = deps.parseBody(marketingBookmarkCreateSchema, request.body ?? {});
    // Like the operator's route: another Google account is ADMIN-only (here the room owner's role).
    if (input.profileId !== null && (await deps.store.getControlActor(owner))?.role !== "ADMIN") throw new GitControlError("ADMIN_REQUIRED", "Google account selection requires a room owned by an ADMIN.", 403);
    const bookmark = await service.createBookmark(owner, input);
    await deps.audit(request, `${auditPrefix}.bookmark.create`, bookmark.id, { paneId: pane.id, url: bookmark.url, profileId: bookmark.profileId });
    return { bookmark };
  });
  handle("post", "bookmarks/:id/open", async ({ owner, pane, cliSessionId }, request) => {
    const { id } = deps.parseQuery(z.object({ id: marketingBookmarkIdSchema }).strict(), request.params);
    const opened = await service.openBookmark(owner, pane, id, request.requestIdForSpace, { holderType: "AGENT", holderId: `cli:${cliSessionId}` });
    await deps.audit(request, `${auditPrefix}.bookmark.open`, id, { paneId: pane.id, profileId: opened.bookmark.profileId });
    return opened;
  });
  handle("delete", "bookmarks/:id", async ({ owner, pane }, request) => {
    const { id } = deps.parseQuery(z.object({ id: marketingBookmarkIdSchema }).strict(), request.params);
    const deleted = await service.deleteBookmark(owner, id);
    if (deleted) await deps.audit(request, `${auditPrefix}.bookmark.delete`, id, { paneId: pane.id });
    return { deleted };
  });
}

export function registerMarketingCopilotAgentRoutes(app: FastifyInstance, service: MarketingCopilotService, deps: MarketingCopilotAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  const route = (path: string) => `${cliMarketingCopilotPathPrefix}${path}`;

  async function context(request: FastifyRequest, reply: FastifyReply): Promise<{ owner: string; pane: Pane; cliSessionId: string } | null> {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const room = await deps.store.getRoom(bridge.claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; open the Marketing Copilot pane from a signed-in operator account.");
    const pane = await deps.store.getPane(bridge.claims.paneId);
    if (pane.mode !== "MARKETING_COPILOT") throw new SpaceConflictError("Marketing Copilot tools belong to the CLI session of a Marketing Copilot pane.");
    return { owner: room.ownerUserId, pane, cliSessionId: bridge.claims.cliSessionId };
  }
  /** Registers an agent route: resolves the bridge, then hands the owner, the pane and the request to the handler. */
  function handle(method: "get" | "post" | "patch" | "delete", path: string, handler: (bridge: { owner: string; pane: Pane; cliSessionId: string }, request: FastifyRequest) => Promise<unknown>) {
    app[method](route(path), routeOptions, async (request, reply) => {
      const bridge = await context(request, reply);
      if (!bridge) return reply;
      return handler(bridge, request);
    });
  }

  handle("get", "state", async ({ owner, pane }) => {
    const settings = service.settingsOf(pane);
    return {
      paneId: pane.id, settings,
      channels: Object.fromEntries(MARKETING_CHANNELS.map((id) => [id, { ...settings.channels[id], effectiveAutonomy: effectiveMarketingAutonomy(settings, id) }])),
      run: await service.runView(owner, pane), campaigns: await service.listCampaigns(owner, ["ACTIVE", "PROPOSED"]), bookmarks: await service.listBookmarks(owner)
    };
  });
  registerBookmarkAgentRoutes(handle, service, deps, "marketing_copilot");
  // Public SpaceApp facts (README and docs, versioned): the only source of product claims besides the operator's FACT memories.
  handle("get", "facts", async (_bridge, request) => {
    const query = parseQuery(z.object({ query: z.string().trim().max(500).optional() }).strict(), request.query ?? {});
    return { facts: query.query ? searchPublicSpaceappKnowledge(query.query, 8) : PUBLIC_SPACEAPP_KNOWLEDGE };
  });
  handle("post", "next", async ({ owner, pane }, request) => service.nextItem(owner, pane, parseBody(z.object({ waitMs }).strict(), request.body ?? {})));
  handle("post", "report", async ({ owner, pane }, request) => {
    const input = parseBody(z.object({
      eventId: marketingEventIdSchema, outcome: z.enum(["drafted", "needs_user", "skipped", "done"]), summary: z.string().trim().min(1).max(1000), memoryIds: z.array(marketingMemoryIdSchema).max(20).default([])
    }).strict(), request.body ?? {});
    const reported = await service.reportBrief(owner, pane, input);
    // A needs-you report learns the operator's local time and, at night, until when it is held (plan clipboard:9XSwTPyxXP1W).
    return input.outcome === "needs_user" ? { ...reported, operator: await operatorHands(deps.store, owner) } : reported;
  });

  handle("get", "posts", async ({ owner }, request) => {
    const query = parseQuery(z.object({ status: z.string().max(200).optional(), channel: marketingChannelSchema.optional(), campaignId: marketingCampaignIdSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict(), request.query ?? {});
    return { posts: await service.listPosts(owner, { status: query.status?.split(",").map((entry) => marketingPostStatusSchema.parse(entry.trim())), channel: query.channel, campaignId: query.campaignId, limit: query.limit }) };
  });
  handle("get", "posts/:id", async ({ owner }, request) => ({ post: await service.getPost(owner, parseQuery(postParamsSchema, request.params).id) }));
  handle("post", "posts", async ({ owner, pane }, request) => service.createPost(owner, pane, parseBody(marketingPostCreateSchema, request.body ?? {})));
  handle("patch", "posts/:id", async ({ owner }, request) => service.updatePost(owner, parseQuery(postParamsSchema, request.params).id, parseBody(marketingPostUpdateSchema, request.body ?? {})));
  handle("post", "review", async ({ owner, pane }, request) => service.requestReview(owner, pane, parseBody(z.object({ postId: marketingPostIdSchema, summary: z.string().trim().min(1).max(1000).optional() }).strict(), request.body ?? {})));
  handle("post", "review/wait", async ({ owner }, request) => service.waitForReview(owner, parseBody(z.object({ postId: marketingPostIdSchema, waitMs }).strict(), request.body ?? {})));

  handle("post", "publish/begin", async ({ owner, pane }, request) => {
    const post = await service.beginPublish(owner, pane, parseBody(marketingPublishBeginSchema, request.body ?? {}).postId);
    await deps.audit(request, "marketing_copilot.publish.begin", post.id, { channel: post.channel, ruleId: post.ruleId });
    return { post };
  });
  handle("post", "publish/done", async ({ owner, pane }, request) => {
    const post = await service.finishPublish(owner, pane, parseBody(marketingPublishDoneSchema, request.body ?? {}));
    await deps.audit(request, "marketing_copilot.publish.done", post.id, { channel: post.channel, url: post.publishedUrl });
    return { post };
  });
  handle("post", "publish/failed", async ({ owner, pane }, request) => ({ post: await service.failPublish(owner, pane, parseBody(marketingPublishFailedSchema, request.body ?? {})) }));
  handle("post", "publish/defer", async ({ owner, pane }, request) => service.deferPublish(owner, pane, parseBody(marketingPublishDeferSchema, request.body ?? {})));

  handle("post", "metrics", async ({ owner, pane }, request) => ({ post: await service.recordPostMetrics(owner, pane, parseBody(marketingPostMetricsRecordSchema, request.body ?? {})) }));
  handle("post", "question", async ({ owner, pane }, request) => service.askQuestion(owner, pane, parseBody(marketingQuestionAskSchema, request.body ?? {})));
  handle("post", "question/wait", async ({ owner }, request) => service.waitForAnswer(owner, parseBody(z.object({ questionId: marketingQuestionIdSchema, waitMs }).strict(), request.body ?? {})));
  handle("post", "memory/recall", async ({ owner }, request) => ({ memories: await service.recallMemory(owner, parseBody(marketingMemoryQuerySchema, request.body ?? {})) }));
  handle("post", "memory", async ({ owner }, request) => ({ memory: await service.rememberMemory(owner, parseBody(marketingMemoryCreateSchema, request.body ?? {}), "AGENT") }));
  handle("get", "campaigns", async ({ owner }) => ({ campaigns: await service.listCampaigns(owner) }));
  handle("post", "campaigns", async ({ owner, pane }, request) => ({ campaign: await service.createCampaign(owner, pane, parseBody(marketingCampaignCreateSchema, request.body ?? {}), "AGENT") }));
  handle("get", "rules", async ({ owner }) => ({ rules: await service.listRules(owner) }));
  handle("post", "rules", async ({ owner, pane }, request) => ({ rule: await service.proposeRule(owner, pane, parseBody(marketingRuleProposalSchema, request.body ?? {}), "AGENT") }));
  handle("post", "note", async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ message: z.string().trim().min(1).max(1000), postId: marketingPostIdSchema.optional(), needsUser: z.boolean().default(false) }).strict(), request.body ?? {});
    return { event: await service.note(owner, pane, input), ...(input.needsUser ? { operator: await operatorHands(deps.store, owner) } : {}) };
  });
}
