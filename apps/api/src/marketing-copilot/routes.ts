import type {} from "../request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  marketingBookmarkCreateSchema, marketingBookmarkIdSchema, marketingBriefSchema, marketingCampaignCreateSchema, marketingCampaignDecisionSchema, marketingCampaignIdSchema, marketingChannelSchema, marketingCopilotPaneMetadataSchema, marketingEventListQuerySchema,
  marketingMemoryCreateSchema, marketingMemoryIdSchema, marketingMemoryKindSchema, marketingMemoryQuerySchema, marketingMemoryUpdateSchema, marketingPostIdSchema, marketingPostReviewDecisionSchema,
  marketingPostStatusSchema, marketingQuestionAnswerSchema, marketingRuleDecisionSchema, marketingRuleIdSchema, marketingRuleProposalSchema, MARKETING_RULE_STATUSES, resolveMarketingCopilotPaneMetadata,
  type MarketingRun, type Pane
} from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { operatorBrowserActor } from "../browser-actors.js";
import { sendApiError } from "../http-errors.js";
import type { MarketingCopilotService } from "./service.js";

export interface MarketingCopilotRouteDependencies {
  store: Pick<SpaceStore, "getPane" | "updateMarketingCopilotMetadata">;
  routeOptions: Record<string, unknown>;
  /** Resolves the signed-in owner; throws the API's 401 error when absent. */
  authenticatedOwner(request: FastifyRequest): Promise<string>;
  assertPaneAccess(request: FastifyRequest, pane: Pane): Promise<void>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Sends the run's kickoff prompt into the pane's CLI (the existing pane CLI input path). */
  kickoff?(pane: Pane, run: MarketingRun): Promise<void>;
}

// Not strict: the post routes carry a postId next to the pane id.
const paneParamsSchema = z.object({ id: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/) });

const postParamsSchema = z.object({ id: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/), postId: marketingPostIdSchema }).strict();
const list = (raw: string | undefined) => raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;

/** Operator-facing routes of the Marketing Copilot pane: settings, runs, briefs, reviews, campaigns, rules and memory. */
export function registerMarketingCopilotRoutes(app: FastifyInstance, service: MarketingCopilotService, deps: MarketingCopilotRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  async function paneOf(request: FastifyRequest, modes: readonly Pane["mode"][] = ["MARKETING_COPILOT"]): Promise<Pane> {
    await deps.authenticatedOwner(request);
    const params = parseQuery(paneParamsSchema, request.params);
    const pane = await deps.store.getPane(params.id);
    await deps.assertPaneAccess(request, pane);
    if (!modes.includes(pane.mode)) throw new SpaceConflictError("Settings belong to a Marketing Copilot pane.");
    return pane;
  }

  app.get("/api/panes/:id/marketing-copilot/settings", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return { metadata: resolveMarketingCopilotPaneMetadata(pane.marketingCopilotMetadata) };
  });

  app.put("/api/panes/:id/marketing-copilot/settings", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const input = parseBody(marketingCopilotPaneMetadataSchema, request.body ?? {});
    // A client that does not name the operator's view keeps it.
    const current = resolveMarketingCopilotPaneMetadata(pane.marketingCopilotMetadata);
    const metadata = { ...input, ...(input.view ?? current.view ? { view: input.view ?? current.view } : {}) };
    const updated = await deps.store.updateMarketingCopilotMetadata(pane.id, metadata);
    const channels = Object.entries(metadata.settings.channels).filter(([, channel]) => channel.enabled).map(([id]) => id);
    await deps.audit(request, "marketing_copilot.settings.update", pane.id, { paused: metadata.settings.paused, autonomy: metadata.settings.autonomy, channels });
    return { metadata: resolveMarketingCopilotPaneMetadata(updated.marketingCopilotMetadata) };
  });

  // ---- runs, briefs, activity and questions (the rail) -------------------------------------------
  app.get("/api/panes/:id/marketing-copilot/run", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return service.runView(await deps.authenticatedOwner(request), pane);
  });
  app.post("/api/panes/:id/marketing-copilot/run/start", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    const started = await service.startRun(owner, pane.id);
    let kickoffSent = false;
    if (started.kickoff && deps.kickoff) {
      await deps.kickoff(pane, started.run);
      await service.markKickoff(owner, started.run.id);
      kickoffSent = true;
    }
    await deps.audit(request, "marketing_copilot.run.start", pane.id, { runId: started.run.id, kickoffSent });
    return { ...(await service.runView(owner, pane)), kickoffSent };
  });
  for (const action of ["pause", "stop"] as const) {
    app.post(`/api/panes/:id/marketing-copilot/run/${action}`, routeOptions, async (request) => {
      const pane = await paneOf(request);
      const owner = await deps.authenticatedOwner(request);
      const run = action === "pause" ? await service.pauseRun(owner, pane.id) : await service.stopRun(owner, pane.id);
      await deps.audit(request, `marketing_copilot.run.${action}`, pane.id, { runId: run.id });
      return service.runView(owner, pane);
    });
  }
  app.post("/api/panes/:id/marketing-copilot/briefs", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    const brief = await service.createBrief(owner, pane, parseBody(marketingBriefSchema, request.body ?? {}));
    await deps.audit(request, "marketing_copilot.brief.create", brief.id, { campaignId: brief.campaignId });
    return { brief };
  });
  app.get("/api/marketing-copilot/events", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return { events: await service.listEvents(owner, parseQuery(marketingEventListQuerySchema, request.query ?? {})) };
  });
  app.post("/api/panes/:id/marketing-copilot/answer", routeOptions, async (request) => {
    const pane = await paneOf(request);
    return service.answerQuestion(await deps.authenticatedOwner(request), pane, parseBody(marketingQuestionAnswerSchema, request.body ?? {}));
  });

  // ---- posts and reviews ---------------------------------------------------------------------------
  app.get("/api/marketing-copilot/posts", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const raw = parseQuery(z.object({ status: z.string().max(200).optional(), channel: marketingChannelSchema.optional(), campaignId: marketingCampaignIdSchema.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).strict(), request.query ?? {});
    return { posts: await service.listPosts(owner, { status: list(raw.status)?.map((entry) => marketingPostStatusSchema.parse(entry)), channel: raw.channel, campaignId: raw.campaignId, limit: raw.limit }) };
  });
  app.post("/api/panes/:id/marketing-copilot/posts/:postId/review", routeOptions, async (request) => {
    const params = parseQuery(postParamsSchema, request.params);
    const pane = await paneOf(request);
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(marketingPostReviewDecisionSchema, request.body ?? {});
    const post = await service.decideReview(owner, pane, params.postId, input);
    await deps.audit(request, "marketing_copilot.review.decide", post.id, { decision: input.decision, channel: post.channel });
    return { post };
  });
  app.post("/api/panes/:id/marketing-copilot/posts/:postId/retry", routeOptions, async (request) => {
    const params = parseQuery(postParamsSchema, request.params);
    const pane = await paneOf(request);
    const post = await service.retryPost(await deps.authenticatedOwner(request), pane, params.postId);
    await deps.audit(request, "marketing_copilot.post.retry", post.id, { channel: post.channel });
    return { post };
  });

  // ---- campaigns and rules -------------------------------------------------------------------------
  app.get("/api/marketing-copilot/campaigns", routeOptions, async (request) => {
    return { campaigns: await service.listCampaigns(await deps.authenticatedOwner(request)) };
  });
  app.post("/api/panes/:id/marketing-copilot/campaigns", routeOptions, async (request) => {
    const pane = await paneOf(request);
    const campaign = await service.createCampaign(await deps.authenticatedOwner(request), pane, parseBody(marketingCampaignCreateSchema, request.body ?? {}), "USER");
    await deps.audit(request, "marketing_copilot.campaign.create", campaign.id, { channels: campaign.channels });
    return { campaign };
  });
  app.post("/api/marketing-copilot/campaigns/:id/decide", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: marketingCampaignIdSchema }).strict(), request.params);
    const query = parseQuery(z.object({ paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).optional() }).strict(), request.query ?? {});
    const pane = query.paneId ? await deps.store.getPane(query.paneId) : null;
    if (pane) await deps.assertPaneAccess(request, pane);
    const input = parseBody(marketingCampaignDecisionSchema, request.body ?? {});
    const campaign = await service.decideCampaign(owner, pane?.mode === "MARKETING_COPILOT" ? pane : null, params.id, input.decision);
    await deps.audit(request, "marketing_copilot.campaign.decide", campaign.id, { decision: input.decision });
    return { campaign };
  });
  app.get("/api/marketing-copilot/rules", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const raw = parseQuery(z.object({ status: z.string().max(100).optional() }).strict(), request.query ?? {});
    return { rules: await service.listRules(owner, list(raw.status)?.map((entry) => z.enum(MARKETING_RULE_STATUSES).parse(entry))) };
  });
  app.post("/api/marketing-copilot/rules", routeOptions, async (request) => {
    const rule = await service.proposeRule(await deps.authenticatedOwner(request), null, parseBody(marketingRuleProposalSchema, request.body ?? {}), "USER");
    await deps.audit(request, "marketing_copilot.rule.create", rule.id, { channel: rule.channel });
    return { rule };
  });
  app.post("/api/marketing-copilot/rules/:id/decide", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: marketingRuleIdSchema }).strict(), request.params);
    const input = parseBody(marketingRuleDecisionSchema, request.body ?? {});
    const rule = await service.decideRule(owner, null, params.id, input.decision);
    await deps.audit(request, "marketing_copilot.rule.decide", rule.id, { decision: input.decision });
    return { rule };
  });

  app.get("/api/marketing-copilot/analytics", routeOptions, async (request) => service.analytics(await deps.authenticatedOwner(request)));

  // ---- bookmarks: pages the pane browser opens with a chosen Google account ------------------------------
  app.get("/api/marketing-copilot/bookmarks", routeOptions, async (request) => ({ bookmarks: await service.listBookmarks(await deps.authenticatedOwner(request)) }));
  app.post("/api/marketing-copilot/bookmarks", routeOptions, async (request, reply) => {
    const owner = await deps.authenticatedOwner(request);
    const input = parseBody(marketingBookmarkCreateSchema, request.body ?? {});
    // Like the browser's Google account menu: only an ADMIN chooses an account.
    if (input.profileId !== null && request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Google account selection requires the ADMIN role.");
    const bookmark = await service.createBookmark(owner, input);
    await deps.audit(request, "marketing_copilot.bookmark.create", bookmark.id, { url: bookmark.url, profileId: bookmark.profileId });
    return { bookmark };
  });
  app.delete("/api/marketing-copilot/bookmarks/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: marketingBookmarkIdSchema }).strict(), request.params);
    return { deleted: await service.deleteBookmark(owner, params.id) };
  });
  app.post("/api/panes/:id/marketing-copilot/bookmarks/:bookmarkId/open", routeOptions, async (request) => {
    const params = parseQuery(z.object({ id: paneParamsSchema.shape.id, bookmarkId: marketingBookmarkIdSchema }).strict(), request.params);
    // One bookmark list for every browser pane with a Google account (operator request 2026-10-21).
    const pane = await paneOf(request, ["BROWSER", "JOB_APPLY", "MARKETING_COPILOT", "FREELANCE_COPILOT"]);
    const opened = await service.openBookmark(await deps.authenticatedOwner(request), pane, params.bookmarkId, request.requestIdForSpace, operatorBrowserActor(request));
    await deps.audit(request, "marketing_copilot.bookmark.open", params.bookmarkId, { paneId: pane.id, profileId: opened.bookmark.profileId });
    return opened;
  });

  // ---- memory ----------------------------------------------------------------------------------------
  app.get("/api/marketing-copilot/memory", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const query = parseQuery(marketingMemoryQuerySchema, { ...raw, ...(raw.kinds ? { kinds: list(raw.kinds)!.map((kind) => marketingMemoryKindSchema.parse(kind)) } : {}) });
    return { memories: await service.listMemory(owner, query) };
  });
  app.post("/api/marketing-copilot/memory", routeOptions, async (request) => {
    return { memory: await service.rememberMemory(await deps.authenticatedOwner(request), parseBody(marketingMemoryCreateSchema, request.body ?? {}), "USER") };
  });
  app.patch("/api/marketing-copilot/memory/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: marketingMemoryIdSchema }).strict(), request.params);
    const memory = await service.updateMemory(owner, params.id, parseBody(marketingMemoryUpdateSchema, request.body ?? {}));
    if (!memory) throw new SpaceNotFoundError(`Memory ${params.id} was not found.`);
    return { memory };
  });
  app.delete("/api/marketing-copilot/memory/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(z.object({ id: marketingMemoryIdSchema }).strict(), request.params);
    return { forgotten: await service.forgetMemory(owner, params.id) };
  });
}
