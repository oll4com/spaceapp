import { randomBytes } from "node:crypto";
import {
  effectiveMarketingAutonomy, MARKETING_CAMPAIGN_TEMPLATES, MARKETING_CHANNEL_LABELS, marketingRuleMatches, marketingUrlMatchesChannel, marketingWordingIssues, resolveMarketingCopilotPaneMetadata,
  type MarketingBookmark, type MarketingBookmarkCreate, type MarketingCampaign, type MarketingCampaignCreate, type MarketingEvent, type MarketingMetric, type MarketingEventType, type MarketingMemoryCreate, type MarketingMemoryQuery, type MarketingPendingItem,
  type MarketingAsset, type MarketingAssetInput, type MarketingPost, type MarketingPostCreate, type MarketingPostReviewDecision, type MarketingPostUpdate, type MarketingRule, type MarketingRuleProposal, type MarketingRun,
  type MarketingRunView, type Pane
} from "@space/contracts";
import type { MarketingCopilotRepository, MarketingPostFilter } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import type { BrowserHostActorContext } from "@space/browser-host";

export interface MarketingCopilotServiceOptions {
  /** Campaigns, posts, memory, activity, runs and rules. */
  repository: MarketingCopilotRepository;
  /** Every activity event, for the room stream and notifications. */
  onEvent?(event: MarketingEvent): void;
  /** Opens a bookmark in a new tab of the pane browser with its Google account (the browser routes' openTab). */
  openInBrowser?(owner: string, pane: Pane, bookmark: MarketingBookmark, traceId: string, actor: BrowserHostActorContext): Promise<unknown>;
  /** A capture in the owner's room Media as a post asset: its file path and kind, kept until deleted by hand. */
  resolveArtifactAsset?(owner: string, artifactId: string): Promise<{ path: string; kind: "IMAGE" | "VIDEO" }>;
  now?(): string;
}

const NEXT_POLL_MS = 2_000;
const NEXT_MAX_WAIT_MS = 120_000;
/** A brief nobody reported for this long goes back to the queue (a crashed CLI). */
const TAKEN_STALE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface EventInput { paneId?: string | null; runId?: string | null; postId?: string | null; campaignId?: string | null; type: MarketingEventType; status?: "PENDING" | "TAKEN" | "DONE" | null; message: string; payload?: Record<string, unknown> }

/**
 * Marketing Copilot: the operator's briefs become work items, the agent drafts posts and asks for reviews, and a
 * post is published only through `beginPublish`, the one gate where the pane's settings apply: the channel must be
 * on, its publishing limit not reached, and the effective autonomy (the lower of the pane's and the channel's cap)
 * must allow it. ASSIST: only posts the operator approved. RULES: those, or a post an approved rule covers.
 * FULL: any draft. Wording with unqualified absolute claims never goes out without the operator's approval.
 */
/** What the copilot receives when a campaign starts: the template's plan when it has one, with the campaign's facts. */
function campaignBrief(campaign: MarketingCampaign): string {
  const template = MARKETING_CAMPAIGN_TEMPLATES.find((entry) => entry.id === campaign.payload.templateId);
  const version = typeof campaign.payload.version === "string" ? ` Version: ${campaign.payload.version}.` : "";
  return `${template ? `${template.brief} ` : "Plan and draft the posts of the campaign. "}Campaign "${campaign.name}"${campaign.goal ? `: ${campaign.goal}` : ""}.${version}`.slice(0, 2000);
}

export function createMarketingCopilotService(options: MarketingCopilotServiceOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const { repository } = options;
  const settingsOf = (pane: Pane | null) => resolveMarketingCopilotPaneMetadata(pane?.mode === "MARKETING_COPILOT" ? pane.marketingCopilotMetadata : null).settings;

  async function record(owner: string, input: EventInput): Promise<MarketingEvent> {
    const event = await repository.createEvent({ ownerUserId: owner, paneId: input.paneId ?? null, runId: input.runId ?? null, postId: input.postId ?? null, campaignId: input.campaignId ?? null,
      type: input.type, status: input.status ?? null, message: input.message.slice(0, 1000), payload: input.payload ?? {} });
    try { options.onEvent?.(event); } catch { /* listeners never break the write */ }
    return event;
  }
  /** Captured assets get their path and kind from the artifact, never from the agent. */
  async function resolveAssets(owner: string, assets: MarketingAssetInput[]): Promise<MarketingAsset[]> {
    return Promise.all(assets.map(async (asset) => {
      if (!asset.artifactId) return asset as MarketingAsset;
      if (!options.resolveArtifactAsset) throw new SpaceConflictError("Captured media cannot be attached on this runtime.");
      return { label: asset.label, artifactId: asset.artifactId, ...await options.resolveArtifactAsset(owner, asset.artifactId) };
    }));
  }
  async function postOf(owner: string, id: string): Promise<MarketingPost> {
    const post = await repository.getPost(owner, id);
    if (!post) throw new SpaceNotFoundError(`Post ${id} was not found.`);
    return post;
  }
  async function bumpRun(owner: string, paneId: string, counter: keyof MarketingRun["counters"]): Promise<string | null> {
    const run = await repository.getActiveRun(paneId);
    if (!run || run.ownerUserId !== owner) return null;
    await repository.updateRun(owner, run.id, { counters: { ...run.counters, [counter]: run.counters[counter] + 1 }, lastActivityAt: now() });
    return run.id;
  }
  /** When the channel's next publication slot opens; null while one is free. */
  async function nextSlot(owner: string, pane: Pane | null, post: Pick<MarketingPost, "channel">): Promise<string | null> {
    const channel = settingsOf(pane).channels[post.channel];
    const since = new Date(Date.parse(now()) - channel.perDays * DAY_MS).toISOString();
    if (await repository.countPublications(owner, post.channel, since) < channel.posts) return null;
    const recent = await repository.listPosts(owner, { status: ["PUBLISHED"], channel: post.channel, limit: Math.max(1, channel.posts) });
    const oldest = recent.map((entry) => entry.publishedAt ?? entry.updatedAt).sort()[0];
    return oldest ? new Date(Date.parse(oldest) + channel.perDays * DAY_MS).toISOString() : now();
  }

  /** The publication gate (see the service comment); records a rule's use. Throws MARKETING_NEEDS_REVIEW / MARKETING_LIMIT. */
  async function authorize(owner: string, pane: Pane | null, post: MarketingPost): Promise<{ ruleId: string | null }> {
    const settings = settingsOf(pane);
    const label = MARKETING_CHANNEL_LABELS[post.channel];
    if (settings.paused) throw new SpaceConflictError("MARKETING_PAUSED: the pane is paused; nothing is published until the operator resumes it.");
    if (!settings.channels[post.channel].enabled) throw new SpaceConflictError(`MARKETING_CHANNEL_OFF: ${label} is off in this pane's Setup.`);
    // Stable 2026-10-19: an approved X post slotted for 10-21 13:10 UTC went out two days early when the CLI began it itself.
    if (post.scheduledAt && Date.parse(post.scheduledAt) > Date.parse(now())) {
      throw new SpaceConflictError(`MARKETING_NOT_DUE: this post is scheduled for ${post.scheduledAt}; it publishes then, not before (it comes back as a PUBLISH item when due).`);
    }
    const slot = await nextSlot(owner, pane, post);
    if (slot) throw new SpaceConflictError(`MARKETING_LIMIT: ${label} allows ${settings.channels[post.channel].posts} post(s) per ${settings.channels[post.channel].perDays} day(s); the next slot opens at ${slot}.`);
    if (post.status === "APPROVED") return { ruleId: null };
    const issues = marketingWordingIssues(`${post.title ?? ""}\n${post.body}`);
    if (issues.length) throw new SpaceConflictError(`MARKETING_NEEDS_REVIEW: the post makes unqualified claims (${issues.join(", ")}); rephrase it or ask for a review.`);
    const autonomy = effectiveMarketingAutonomy(settings, post.channel);
    if (autonomy === "FULL") return { ruleId: null };
    if (autonomy === "ASSIST") throw new SpaceConflictError(`MARKETING_NEEDS_REVIEW: autonomy on ${label} is Assist; ask for a review with space_marketing_review_request.`);
    const rule = (await repository.listRules(owner, ["APPROVED"])).find((candidate) => marketingRuleMatches(candidate, post));
    if (!rule) throw new SpaceConflictError(`MARKETING_NEEDS_REVIEW: autonomy on ${label} is Rules and no approved rule covers this post; ask for a review.`);
    await repository.updateRule(owner, rule.id, { appliedCount: rule.appliedCount + 1, lastAppliedAt: now() });
    await record(owner, { paneId: pane?.id ?? null, postId: post.id, type: "RULE_APPLIED", message: `Rule "${rule.name}" let the copilot publish on ${label}`, payload: { ruleId: rule.id } });
    return { ruleId: rule.id };
  }

  const service = {
    settingsOf,
    // ---- campaigns ----------------------------------------------------------------------------
    listCampaigns: (owner: string, status?: MarketingCampaign["status"][]) => repository.listCampaigns(owner, status),
    /** The operator's own campaigns start ACTIVE; the agent's (and the release hook's) wait as PROPOSED. */
    async createCampaign(owner: string, pane: Pane | null, input: MarketingCampaignCreate, by: "USER" | "AGENT" | "RELEASE", payload: Record<string, unknown> = {}) {
      const template = input.templateId ? MARKETING_CAMPAIGN_TEMPLATES.find((entry) => entry.id === input.templateId) : undefined;
      if (input.templateId && !template) throw new SpaceNotFoundError(`Campaign template ${input.templateId} was not found.`);
      const campaign = await repository.createCampaign({ ownerUserId: owner, name: input.name, goal: input.goal ?? template?.goal ?? null, channels: input.channels.length ? input.channels : [...(template?.channels ?? [])],
        status: by === "USER" ? "ACTIVE" : "PROPOSED", startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, proposedBy: by, payload: { ...payload, ...(template ? { templateId: template.id } : {}) } });
      await record(owner, { paneId: pane?.id ?? null, campaignId: campaign.id, type: by === "USER" ? "CAMPAIGN_DECIDED" : "CAMPAIGN_PROPOSED",
        message: by === "USER" ? `You started the campaign: ${campaign.name}` : `Campaign proposed: ${campaign.name}`, payload: { goal: campaign.goal, channels: campaign.channels } });
      if (by === "USER") await service.createBrief(owner, pane, { text: campaignBrief(campaign), campaignId: campaign.id, channels: campaign.channels });
      return campaign;
    },
    /** A SpaceApp version nobody announced yet proposes its release campaign (once per version, while the pane allows it). */
    async proposeReleaseCampaign(owner: string, pane: Pane, version: string) {
      if (!settingsOf(pane).releaseCampaigns || !/^\d+\.\d+\.\d+/.test(version)) return null;
      if ((await repository.listCampaigns(owner)).some((campaign) => campaign.payload.version === version)) return null;
      return service.createCampaign(owner, pane, { templateId: "release", name: `SpaceApp ${version} release`, channels: [] }, "RELEASE", { version });
    },
    async decideCampaign(owner: string, pane: Pane | null, id: string, decision: "approve" | "complete" | "cancel") {
      const campaign = await repository.getCampaign(owner, id);
      if (!campaign) throw new SpaceNotFoundError("The campaign was not found.");
      if (decision === "approve" && campaign.status !== "PROPOSED") throw new SpaceConflictError("Only a proposed campaign can be approved.");
      const status = ({ approve: "ACTIVE", complete: "DONE", cancel: "CANCELLED" } as const)[decision];
      const updated = (await repository.updateCampaign(owner, id, { status }))!;
      await record(owner, { paneId: pane?.id ?? null, campaignId: id, type: "CAMPAIGN_DECIDED", message: `You ${decision === "approve" ? "approved" : decision === "complete" ? "completed" : "cancelled"} the campaign: ${campaign.name}`, payload: { decision } });
      if (decision === "approve") await service.createBrief(owner, pane, { text: campaignBrief(campaign), campaignId: id, channels: campaign.channels });
      return updated;
    },
    // ---- briefs (the operator's requests, the agent's work items) -----------------------------
    async createBrief(owner: string, pane: Pane | null, input: { text: string; campaignId?: string | null; channels?: MarketingPost["channel"][]; postId?: string | null }) {
      if (input.campaignId && !await repository.getCampaign(owner, input.campaignId)) throw new SpaceNotFoundError("The campaign was not found.");
      return record(owner, { paneId: pane?.id ?? null, campaignId: input.campaignId ?? null, postId: input.postId ?? null, type: "BRIEF", status: "PENDING", message: input.text,
        payload: { text: input.text, channels: input.channels ?? [] } });
    },
    // ---- posts --------------------------------------------------------------------------------
    listPosts: (owner: string, filter: MarketingPostFilter) => repository.listPosts(owner, filter),
    getPost: postOf,
    async createPost(owner: string, pane: Pane | null, input: MarketingPostCreate) {
      if (input.campaignId && !await repository.getCampaign(owner, input.campaignId)) throw new SpaceNotFoundError("The campaign was not found.");
      const post = await repository.createPost({ ownerUserId: owner, paneId: pane?.id ?? null, campaignId: input.campaignId ?? null, channel: input.channel, kind: input.kind, target: input.target ?? null,
        title: input.title ?? null, body: input.body, assets: await resolveAssets(owner, input.assets), status: "DRAFT", scheduledAt: input.scheduledAt ?? null, reviewNote: null, ruleId: null, publishedUrl: null, publishedAt: null,
        evidence: {}, metrics: {} });
      const runId = pane ? await bumpRun(owner, pane.id, "drafted") : null;
      await record(owner, { paneId: pane?.id ?? null, runId, postId: post.id, campaignId: post.campaignId, type: "POST_DRAFTED", message: `Drafted a ${MARKETING_CHANNEL_LABELS[post.channel]} ${post.kind.toLowerCase().replace("_", " ")}${post.title ? `: ${post.title}` : ""}` });
      return { post, wordingIssues: marketingWordingIssues(`${post.title ?? ""}\n${post.body}`) };
    },
    /** The agent edits its own drafts (and posts sent back for changes); reviewed or published posts stay as they are. */
    async updatePost(owner: string, id: string, patch: MarketingPostUpdate) {
      const post = await repository.updatePost(owner, id, { ...patch, assets: patch.assets && await resolveAssets(owner, patch.assets) }, ["DRAFT", "FAILED"]);
      if (!post) throw new SpaceConflictError("Only a draft (or a failed post) can be edited; a post in review waits for the operator.");
      return { post, wordingIssues: marketingWordingIssues(`${post.title ?? ""}\n${post.body}`) };
    },
    /** Graphics the Design pane delivered for a post ("Make graphic"): added to any post that is not published or rejected. */
    async attachAssets(owner: string, postId: string, assets: Array<{ artifactId: string; label: string }>) {
      const current = await postOf(owner, postId);
      const post = await repository.updatePost(owner, postId, { assets: [...current.assets, ...await resolveAssets(owner, assets)] }, ["DRAFT", "IN_REVIEW", "APPROVED", "FAILED"]);
      if (!post) throw new SpaceConflictError(`The post is ${current.status.toLowerCase()}; its graphics can no longer change.`);
      await record(owner, { paneId: post.paneId, postId: post.id, campaignId: post.campaignId, type: "NOTE", message: `The Design pane attached ${assets.length} graphic${assets.length === 1 ? "" : "s"}` });
      return post;
    },
    async requestReview(owner: string, pane: Pane | null, input: { postId: string; summary?: string }) {
      const post = await repository.updatePost(owner, input.postId, { reviewNote: null }, ["DRAFT", "FAILED"]).then((updated) => updated && repository.updatePost(owner, input.postId, { status: "IN_REVIEW" }));
      if (!post) throw new SpaceConflictError("Only a draft (or a failed post) can be sent for review.");
      const wordingIssues = marketingWordingIssues(`${post.title ?? ""}\n${post.body}`);
      await record(owner, { paneId: pane?.id ?? post.paneId, postId: post.id, campaignId: post.campaignId, type: "REVIEW_REQUESTED",
        message: `Review: ${input.summary ?? `${MARKETING_CHANNEL_LABELS[post.channel]} ${post.kind.toLowerCase().replace("_", " ")}${post.title ? ` "${post.title}"` : ""}`}`, payload: { wordingIssues } });
      return { post, wordingIssues };
    },
    /** The operator decides a post: approve, edit (their version is approved and learned), revise (back to the agent) or reject. */
    async decideReview(owner: string, pane: Pane | null, postId: string, input: MarketingPostReviewDecision) {
      const current = await postOf(owner, postId);
      const patch = input.decision === "approve" || input.decision === "edit"
        ? { status: "APPROVED" as const, reviewNote: input.note ?? null, ...(input.decision === "edit" ? { ...(input.body !== undefined ? { body: input.body } : {}), ...(input.title !== undefined ? { title: input.title } : {}) } : {}),
          ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}) }
        : { status: input.decision === "revise" ? "DRAFT" as const : "REJECTED" as const, reviewNote: input.note ?? null };
      const post = await repository.updatePost(owner, postId, patch, ["DRAFT", "IN_REVIEW", "FAILED"]);
      if (!post) throw new SpaceConflictError("This post is no longer waiting for a decision.");
      const label = MARKETING_CHANNEL_LABELS[post.channel];
      if (input.decision === "edit" && (post.body !== current.body || post.title !== current.title)) {
        await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: null, channel: post.channel, tags: ["review-edit"], source: "LEARNED", pinned: false,
          text: `On ${label} the operator changed a ${post.kind.toLowerCase()}. Copilot draft:\n${current.body.slice(0, 1500)}\n\nOperator's version:\n${post.body.slice(0, 1500)}`.slice(0, 4000) });
      }
      if (input.decision === "reject" && input.note) {
        await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: null, channel: post.channel, tags: ["review-reject"], source: "LEARNED", pinned: false,
          text: `On ${label} the operator rejected a ${post.kind.toLowerCase()}: ${input.note}`.slice(0, 4000) });
      }
      if (input.decision === "revise") await service.createBrief(owner, pane, { text: `Revise the ${label} post ${post.id}: ${input.note}`, campaignId: post.campaignId, channels: [post.channel], postId: post.id });
      const verb = { approve: "approved", edit: "edited and approved", revise: "sent back for changes", reject: "rejected" }[input.decision];
      await record(owner, { paneId: pane?.id ?? post.paneId, postId: post.id, campaignId: post.campaignId, type: "REVIEW_DECIDED", message: `You ${verb} the ${label} post${input.note ? `: ${input.note}` : ""}`,
        payload: { decision: input.decision, note: input.note ?? null } });
      return post;
    },
    async waitForReview(owner: string, input: { postId: string; waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      for (;;) {
        const post = await postOf(owner, input.postId);
        if (post.status !== "IN_REVIEW") return { decided: true as const, status: post.status, note: post.reviewNote, post };
        if (Date.now() >= deadline) return { decided: false as const, status: post.status };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    // ---- publishing: the gate, then evidence ---------------------------------------------------
    async beginPublish(owner: string, pane: Pane, postId: string) {
      const post = await postOf(owner, postId);
      if (!["APPROVED", "DRAFT", "FAILED"].includes(post.status)) throw new SpaceConflictError(`This post is ${post.status.toLowerCase().replace("_", " ")}; it cannot be published now.`);
      const { ruleId } = await authorize(owner, pane, post);
      const publishing = await repository.updatePost(owner, postId, { status: "PUBLISHING", ruleId }, [post.status]);
      if (!publishing) throw new SpaceConflictError("The post changed meanwhile; read it again.");
      const runId = await bumpRun(owner, pane.id, "taken");
      await record(owner, { paneId: pane.id, runId, postId, campaignId: post.campaignId, type: "PUBLISHING", message: `Publishing on ${MARKETING_CHANNEL_LABELS[post.channel]}${post.title ? `: ${post.title}` : ""}` });
      return publishing;
    },
    /** A publication counts only with its URL on the channel's site (and, when taken, a screenshot of it). */
    async finishPublish(owner: string, pane: Pane, input: { postId: string; url: string; screenshotPath?: string }) {
      const post = await postOf(owner, input.postId);
      if (post.status !== "PUBLISHING") throw new SpaceConflictError("Begin the publication first (space_marketing_publish_begin).");
      if (!marketingUrlMatchesChannel(input.url, post.channel)) throw new SpaceConflictError(`MARKETING_EVIDENCE: ${input.url} is not an https page of ${MARKETING_CHANNEL_LABELS[post.channel]}; report the published post's own URL.`);
      const published = (await repository.updatePost(owner, post.id, { status: "PUBLISHED", publishedUrl: input.url, publishedAt: now(),
        evidence: { ...post.evidence, url: input.url, screenshotPath: input.screenshotPath ?? null, reportedAt: now() } }, ["PUBLISHING"]))!;
      const runId = await bumpRun(owner, pane.id, "published");
      await record(owner, { paneId: pane.id, runId, postId: post.id, campaignId: post.campaignId, type: "PUBLISHED", message: `Published on ${MARKETING_CHANNEL_LABELS[post.channel]}${post.title ? `: ${post.title}` : ""}`, payload: { url: input.url } });
      return published;
    },
    async failPublish(owner: string, pane: Pane, input: { postId: string; reason: string }) {
      const post = await repository.updatePost(owner, input.postId, { status: "FAILED", evidence: { failure: input.reason, failedAt: now() } }, ["PUBLISHING"]);
      if (!post) throw new SpaceConflictError("This post is not being published.");
      const runId = await bumpRun(owner, pane.id, "failed");
      await record(owner, { paneId: pane.id, runId, postId: post.id, campaignId: post.campaignId, type: "PUBLISH_FAILED", message: `Publishing on ${MARKETING_CHANNEL_LABELS[post.channel]} failed: ${input.reason}`, payload: { reason: input.reason } });
      return post;
    },
    /** The operator retries a failed post: approved again, so the next run publishes it. */
    async retryPost(owner: string, pane: Pane | null, postId: string) {
      const post = await repository.updatePost(owner, postId, { status: "APPROVED" }, ["FAILED"]);
      if (!post) throw new SpaceConflictError("Only a failed post can be retried.");
      await record(owner, { paneId: pane?.id ?? post.paneId, postId, type: "REVIEW_DECIDED", message: `You approved a retry of the ${MARKETING_CHANNEL_LABELS[post.channel]} post`, payload: { decision: "approve" } });
      return post;
    },
    // ---- memory -------------------------------------------------------------------------------
    async recallMemory(owner: string, query: MarketingMemoryQuery) {
      const merged = [...new Map([...(await repository.listMemory(owner, { ...query, query: undefined, limit: 200 })).filter((memory) => memory.pinned), ...await repository.listMemory(owner, query)]
        .map((memory) => [memory.id, memory])).values()];
      await repository.touchMemories(owner, merged.map((memory) => memory.id));
      return merged;
    },
    listMemory: (owner: string, query: MarketingMemoryQuery) => repository.listMemory(owner, query),
    rememberMemory: (owner: string, input: MarketingMemoryCreate, source: "USER" | "AGENT") => repository.upsertMemory({ ownerUserId: owner, kind: input.kind, key: input.key ?? null, text: input.text,
      channel: input.channel ?? null, tags: input.tags, source, pinned: input.pinned }),
    updateMemory: (owner: string, id: string, patch: { text?: string; pinned?: boolean }) => repository.updateMemory(owner, id, patch),
    forgetMemory: (owner: string, id: string) => repository.deleteMemory(owner, id),
    // ---- bookmarks ----------------------------------------------------------------------------
    listBookmarks: (owner: string) => repository.listBookmarks(owner),
    createBookmark: (owner: string, input: MarketingBookmarkCreate) => repository.createBookmark({ ownerUserId: owner, url: input.url,
      title: input.title ?? new URL(input.url).hostname.replace(/^www\./, ""), profileId: input.profileId, accountLabel: input.profileId ? input.accountLabel : null }),
    deleteBookmark: (owner: string, id: string) => repository.deleteBookmark(owner, id),
    async openBookmark(owner: string, pane: Pane, id: string, traceId: string, actor: BrowserHostActorContext) {
      const bookmark = await repository.getBookmark(owner, id);
      if (!bookmark) throw new SpaceNotFoundError(`Bookmark ${id} was not found.`);
      if (!options.openInBrowser) throw new SpaceConflictError("The pane browser cannot open tabs on this runtime.");
      return { bookmark, pages: await options.openInBrowser(owner, pane, bookmark, traceId, actor) };
    },
    // ---- questions ----------------------------------------------------------------------------
    async askQuestion(owner: string, pane: Pane, input: { question: string; options?: string[]; postId?: string }) {
      const questionId = `mktq:${randomBytes(9).toString("base64url")}`;
      await record(owner, { paneId: pane.id, postId: input.postId ?? null, type: "QUESTION", message: `Needs you: ${input.question}`, payload: { questionId, question: input.question, options: input.options ?? [] } });
      return { questionId };
    },
    /** by NOUS: Nous, the mind of SpaceApp, answered for the operator (its answer is the agent's memory, not the operator's voice). */
    async answerQuestion(owner: string, pane: Pane | null, input: { questionId: string; answer: string }, by: "USER" | "NOUS" = "USER") {
      const question = (await repository.listEvents(owner, { types: ["QUESTION"], limit: 300 })).find((event) => event.payload.questionId === input.questionId);
      if (!question) throw new SpaceNotFoundError("The question was not found.");
      const memory = await repository.upsertMemory({ ownerUserId: owner, kind: "FACT", key: String(question.payload.question).toLowerCase().slice(0, 300), text: input.answer, channel: null, tags: ["question"], source: by === "NOUS" ? "AGENT" : "USER", pinned: false });
      await record(owner, { paneId: pane?.id ?? question.paneId, postId: question.postId, type: "ANSWERED", message: `${by === "NOUS" ? "Nous" : "You"} answered: ${input.answer.slice(0, 200)}`, payload: { questionId: input.questionId, answer: input.answer, memoryId: memory.id, answeredBy: by } });
      return { memory };
    },
    async waitForAnswer(owner: string, input: { questionId: string; waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      for (;;) {
        const answered = (await repository.listEvents(owner, { types: ["ANSWERED"], limit: 300 })).find((event) => event.payload.questionId === input.questionId);
        if (answered) return { answered: true as const, answer: String(answered.payload.answer ?? "") };
        if (Date.now() >= deadline) return { answered: false as const, answer: null };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    // ---- rules --------------------------------------------------------------------------------
    listRules: (owner: string, status?: MarketingRule["status"][]) => repository.listRules(owner, status),
    async proposeRule(owner: string, pane: Pane | null, proposal: MarketingRuleProposal, by: "AGENT" | "USER") {
      const rule = await repository.createRule({ ownerUserId: owner, name: proposal.name, channel: proposal.channel, kinds: proposal.kinds, campaignId: proposal.campaignId ?? null,
        status: by === "USER" ? "APPROVED" : "PROPOSED", evidence: proposal.evidence, proposedBy: by });
      await record(owner, { paneId: pane?.id ?? null, type: by === "USER" ? "RULE_DECIDED" : "RULE_PROPOSED", message: by === "USER" ? `You added the rule: ${rule.name}` : `Rule proposed: ${rule.name}`, payload: { ruleId: rule.id } });
      return rule;
    },
    async decideRule(owner: string, pane: Pane | null, id: string, decision: "approve" | "reject" | "retire") {
      const rule = await repository.getRule(owner, id);
      if (!rule) throw new SpaceNotFoundError("The rule was not found.");
      const updated = (await repository.updateRule(owner, id, { status: ({ approve: "APPROVED", reject: "REJECTED", retire: "RETIRED" } as const)[decision], decidedAt: now() }))!;
      await record(owner, { paneId: pane?.id ?? null, type: "RULE_DECIDED", message: `You ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "retired"} the rule: ${rule.name}`, payload: { ruleId: id, decision } });
      return updated;
    },
    // ---- activity, pending items and runs ------------------------------------------------------
    listEvents: (owner: string, filter: { paneId?: string; limit: number }) => repository.listEvents(owner, filter),
    async pendingItems(owner: string, paneId: string | null): Promise<MarketingPendingItem[]> {
      const [reviews, questions, campaigns, rules] = await Promise.all([
        repository.listPosts(owner, { status: ["IN_REVIEW"], limit: 100 }),
        repository.listEvents(owner, { paneId, types: ["QUESTION", "ANSWERED"], limit: 300 }),
        repository.listCampaigns(owner, ["PROPOSED"]),
        repository.listRules(owner, ["PROPOSED"])
      ]);
      const answered = new Set(questions.filter((event) => event.type === "ANSWERED").map((event) => String(event.payload.questionId)));
      return [
        ...reviews.map((post) => ({ kind: "REVIEW" as const, id: post.id, message: `Review the ${MARKETING_CHANNEL_LABELS[post.channel]} post${post.title ? ` "${post.title}"` : ""}`, payload: { post, wordingIssues: marketingWordingIssues(`${post.title ?? ""}\n${post.body}`) }, createdAt: post.updatedAt })),
        ...questions.filter((event) => event.type === "QUESTION" && !answered.has(String(event.payload.questionId))).map((event) => ({ kind: "QUESTION" as const, id: String(event.payload.questionId), message: event.message, payload: event.payload, createdAt: event.createdAt })),
        ...campaigns.map((campaign) => ({ kind: "CAMPAIGN" as const, id: campaign.id, message: `Campaign proposed: ${campaign.name}`, payload: { campaign }, createdAt: campaign.createdAt })),
        ...rules.map((rule) => ({ kind: "RULE" as const, id: rule.id, message: `Rule proposed: ${rule.name}`, payload: { rule }, createdAt: rule.createdAt }))
      ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 200);
    },
    /** Approved posts whose time has come, on channels that are on and have a free slot. */
    async duePosts(owner: string, pane: Pane | null) {
      const settings = settingsOf(pane);
      const at = now();
      const due = (await repository.listPosts(owner, { status: ["APPROVED"], limit: 200 })).filter((post) => settings.channels[post.channel].enabled && (!post.scheduledAt || post.scheduledAt <= at))
        .sort((left, right) => (left.scheduledAt ?? left.updatedAt).localeCompare(right.scheduledAt ?? right.updatedAt));
      const open: MarketingPost[] = [];
      for (const post of due) if (!await nextSlot(owner, pane, post)) open.push(post);
      return open;
    },
    async runView(owner: string, pane: Pane): Promise<MarketingRunView> {
      const run = await repository.getActiveRun(pane.id);
      const mine = run && run.ownerUserId === owner ? run : null;
      const briefs = await repository.listEvents(owner, { types: ["BRIEF"], status: ["PENDING"], limit: 200 });
      return { run: mine, status: mine?.status ?? "IDLE", pending: await service.pendingItems(owner, pane.id), backlog: briefs.length + (await service.duePosts(owner, pane)).length };
    },
    activeRun: (paneId: string) => repository.getActiveRun(paneId),
    async startRun(owner: string, paneId: string): Promise<{ run: MarketingRun; kickoff: boolean }> {
      const active = await repository.getActiveRun(paneId);
      if (active && active.ownerUserId !== owner) throw new SpaceConflictError("Another user's run is active in this pane.");
      if (active?.status === "RUNNING") return { run: active, kickoff: !active.kickoffSentAt };
      if (active?.status === "PAUSED") {
        const resumed = (await repository.updateRun(owner, active.id, { status: "RUNNING", lastActivityAt: now() }))!;
        await record(owner, { paneId, runId: resumed.id, type: "RUN_RESUMED", message: "Run resumed" });
        return { run: resumed, kickoff: !resumed.kickoffSentAt };
      }
      const run = await repository.createRun({ ownerUserId: owner, paneId });
      await record(owner, { paneId, runId: run.id, type: "RUN_STARTED", message: "Run started: the copilot works through your briefs and publishes approved posts that are due" });
      return { run, kickoff: true };
    },
    async markKickoff(owner: string, runId: string) { await repository.updateRun(owner, runId, { kickoffSentAt: now() }); },
    async pauseRun(owner: string, paneId: string) {
      const run = await repository.getActiveRun(paneId);
      if (!run || run.ownerUserId !== owner) throw new SpaceConflictError("No run is active in this pane.");
      if (run.status === "PAUSED") return run;
      const paused = (await repository.updateRun(owner, run.id, { status: "PAUSED", lastActivityAt: now() }))!;
      await record(owner, { paneId, runId: run.id, type: "RUN_PAUSED", message: "Run paused" });
      return paused;
    },
    async stopRun(owner: string, paneId: string, message = "Run stopped") {
      const run = await repository.getActiveRun(paneId);
      if (!run || run.ownerUserId !== owner) throw new SpaceConflictError("No run is active in this pane.");
      const stopped = (await repository.updateRun(owner, run.id, { status: "STOPPED", stoppedAt: now(), lastActivityAt: now() }))!;
      const { counters } = run;
      await record(owner, { paneId, runId: run.id, type: "RUN_STOPPED", message: `${message}: ${counters.drafted} drafted, ${counters.published} published, ${counters.failed} failed` });
      return stopped;
    },
    /**
     * The agent's loop: waits (up to `waitMs`) while the run is RUNNING for a work item. A brief (oldest first) is
     * taken for this pane; otherwise an approved post that is due comes back for publishing. With neither left the
     * run finishes (Start, a new brief's kickoff or the scheduler starts the next one).
     */
    async nextItem(owner: string, pane: Pane, input: { waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      for (;;) {
        const run = await repository.getActiveRun(pane.id);
        if (!run || run.ownerUserId !== owner) return { done: true as const, reason: "NO_RUN" as const };
        const settings = settingsOf(pane);
        if (run.status === "RUNNING" && !settings.paused) {
          const brief = await repository.takeNextBrief(owner, pane.id, TAKEN_STALE_MS);
          if (brief) {
            await bumpRun(owner, pane.id, "taken");
            const post = brief.postId ? await repository.getPost(owner, brief.postId) : null;
            const campaign = brief.campaignId ? await repository.getCampaign(owner, brief.campaignId) : null;
            const memories = await service.recallMemory(owner, { query: brief.message.slice(0, 300), limit: 15 });
            return { done: false as const, kind: "BRIEF" as const, item: brief, post, campaign, memories, autonomy: settings.autonomy };
          }
          const [due] = await service.duePosts(owner, pane);
          if (due) return { done: false as const, kind: "PUBLISH" as const, post: due, memories: await service.recallMemory(owner, { kinds: ["CHANNEL_RULE"], channel: due.channel, limit: 10 }) };
          const [measure] = await service.postsToMeasure(owner);
          if (measure) return { done: false as const, kind: "MEASURE" as const, post: measure };
          await service.stopRun(owner, pane.id, "Run finished");
          return { done: true as const, reason: "QUEUE_EMPTY" as const };
        }
        if (Date.now() >= deadline) return { done: false as const, waiting: true as const, reason: run.status === "PAUSED" ? "PAUSED" as const : "SETTINGS_PAUSED" as const };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    // ---- analytics -----------------------------------------------------------------------------
    recordMetrics: (owner: string, metrics: MarketingMetric[]) => repository.recordMetrics(owner, metrics),
    /** Published posts whose engagement is due a reading: a day after publication, and again after a week. */
    async postsToMeasure(owner: string): Promise<MarketingPost[]> {
      const at = Date.parse(now());
      return (await repository.listPosts(owner, { status: ["PUBLISHED"], limit: 100 })).filter((post) => {
        const age = at - Date.parse(post.publishedAt ?? post.updatedAt);
        return age < 30 * DAY_MS && ((age >= DAY_MS && !post.evidence.measured1d) || (age >= 7 * DAY_MS && !post.evidence.measured7d));
      });
    },
    /** The agent's reading of a published post's engagement (from the post's page in the pane browser). */
    async recordPostMetrics(owner: string, pane: Pane, input: { postId: string; metrics: Record<string, number> }) {
      const post = await postOf(owner, input.postId);
      if (post.status !== "PUBLISHED") throw new SpaceConflictError("Only a published post has engagement to record.");
      const age = Date.parse(now()) - Date.parse(post.publishedAt ?? post.updatedAt);
      const updated = (await repository.updatePost(owner, post.id, { metrics: { ...post.metrics, ...input.metrics },
        evidence: { ...post.evidence, metricsAt: now(), ...(age >= DAY_MS ? { measured1d: true } : {}), ...(age >= 7 * DAY_MS ? { measured7d: true } : {}) } }, ["PUBLISHED"]))!;
      await record(owner, { paneId: pane.id, postId: post.id, campaignId: post.campaignId, type: "METRICS",
        message: `${MARKETING_CHANNEL_LABELS[post.channel]} post: ${Object.entries(input.metrics).map(([key, value]) => `${value} ${key.replace(/_/g, " ")}`).join(", ")}`, payload: { metrics: input.metrics } });
      return updated;
    },
    /** The last 90 days of public numbers and the published posts ranked by their recorded engagement. */
    async analytics(owner: string) {
      const since = new Date(Date.parse(now()) - 90 * DAY_MS).toISOString().slice(0, 10);
      const engagement = (post: MarketingPost) => Object.values(post.metrics).reduce((sum, value) => sum + value, 0);
      const published = await repository.listPosts(owner, { status: ["PUBLISHED"], limit: 200 });
      return { metrics: await repository.listMetrics(owner, since), topPosts: published.filter((post) => engagement(post) > 0).sort((a, b) => engagement(b) - engagement(a)).slice(0, 10), published: published.length };
    },
    /** Once a week: the public numbers and their change since a week ago, as one line in the pane's Activity. */
    async metricsDigest(owner: string, pane: Pane) {
      const at = Date.parse(now());
      const [last] = await repository.listEvents(owner, { types: ["METRICS"], limit: 20 }).then((events) => events.filter((event) => event.payload.digest === true));
      if (last && at - Date.parse(last.createdAt) < 6.5 * DAY_MS) return null;
      const rows = await repository.listMetrics(owner, new Date(at - 8 * DAY_MS).toISOString().slice(0, 10));
      const series = (source: string, key: string) => rows.filter((row) => row.source === source && row.key === key);
      const line = (label: string, source: string, key: string, change: boolean) => {
        const points = series(source, key);
        const latest = points.at(-1);
        if (!latest) return null;
        const delta = change && points.length > 1 ? latest.value - points[0]!.value : null;
        return `${label} ${latest.value}${delta !== null ? ` (${delta >= 0 ? "+" : ""}${delta} this week)` : ""}`;
      };
      const parts = [line("GitHub stars", "GITHUB", "stars", true), line("forks", "GITHUB", "forks", true), line("npm downloads last week", "NPM", "downloads_week", false), line("active self-hosted installs", "INSTALLS", "active_7d", true)].filter(Boolean);
      if (!parts.length) return null;
      return record(owner, { paneId: pane.id, type: "METRICS", message: `This week: ${parts.join(", ")}`, payload: { digest: true } });
    },
    /** A line in the pane's Activity from the agent (what it saw, decided and why); NEEDS_USER when it cannot go on alone. */
    note: (owner: string, pane: Pane, input: { message: string; postId?: string; needsUser?: boolean }) =>
      record(owner, { paneId: pane.id, postId: input.postId ?? null, type: input.needsUser ? "NEEDS_USER" : "NOTE", message: input.message }),
    /** The agent closes a brief: what it did (drafted posts, asked, skipped) for the timeline. */
    async reportBrief(owner: string, pane: Pane, input: { eventId: string; outcome: "drafted" | "needs_user" | "skipped" | "done"; summary: string; memoryIds?: string[] }) {
      const brief = (await repository.listEvents(owner, { types: ["BRIEF"], status: ["TAKEN", "PENDING"], limit: 500 })).find((event) => event.id === input.eventId);
      if (!brief) throw new SpaceNotFoundError(`Brief ${input.eventId} is not open.`);
      await repository.setEventStatus(owner, brief.id, "DONE");
      if (input.memoryIds?.length) await repository.touchMemories(owner, input.memoryIds);
      const runId = input.outcome === "needs_user" ? await bumpRun(owner, pane.id, "needsUser") : (await repository.getActiveRun(pane.id))?.id ?? null;
      return record(owner, { paneId: pane.id, runId, postId: brief.postId, campaignId: brief.campaignId, type: input.outcome === "needs_user" ? "NEEDS_USER" : "NOTE", message: input.summary, payload: { briefId: brief.id, outcome: input.outcome } });
    },
    now
  };
  return service;
}
export type MarketingCopilotService = ReturnType<typeof createMarketingCopilotService>;
