import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  CHANNEL_LINK_ALPHABET, formatChannelLinkCode, parseChannelCommand, type ChannelInboundMessage, type ChannelProvider, type ChannelProviderStatus,
  type ChannelsStatus, type DotProfile, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { ChannelIdentityRecord, ChannelsRepository, ChannelThreadRecord, DotsRepository } from "@space/db";
import type { SlackClient } from "./channel-slack.js";
import type { TeamsClient } from "./channel-teams.js";

/**
 * Space Dots Stage 6: Slack and Teams conversations with a user's Dots.
 *
 * - Linking: the owner creates a one-time code in Space and sends it to the
 *   Space app in a direct message; only then are that account's messages
 *   accepted. Unknown accounts are told how to link and nothing else.
 * - Threads: each external thread is one conversation with one Dot of its
 *   owner, in its own Chat pane. Only the linked owner can drive it.
 * - Participants: in shared conversations, answers, questions and approval
 *   notices go to the owner directly unless the owner said "reply here".
 * - Delivery: results, Goal questions and approvals go through an outbox, once
 *   per source, with retries. Approvals are decided in Space, never in chat.
 */
const providerLabel: Record<ChannelProvider, string> = { SLACK: "Slack", TEAMS: "Teams" };
const finished = new Set(["COMPLETED", "FAILED", "INTERRUPTED"]);
const sha = (value: string, length = 40) => createHash("sha256").update(value).digest("hex").slice(0, length);
/** Plain text for Slack: its control characters are escaped, so text quoted from email never becomes a mention or a link. */
const slackText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface DotChannelDeps {
  repo: ChannelsRepository;
  slack: SlackClient | null;
  teams: TeamsClient | null;
  providers: ChannelProviderStatus[];
  store: Pick<SpaceStore, "getSpaceAgentSession" | "getLatestSpaceAgentRun" | "listSpaceAgentMessages" | "getSpaceAgentSubmission">;
  dots: Pick<DotsRepository, "list">;
  /** The room where channel conversations open their Chat panes. */
  pickRoom(owner: string): Promise<string | null>;
  openPane(input: { owner: string; roomId: string; title: string }): Promise<Pane>;
  startSession(input: { pane: Pane; owner: string; dotId: string }): Promise<{ sessionId: string }>;
  /** Sends a message into the conversation; throws SpaceConflictError when it cannot take it now. */
  send(input: { paneId: string; sessionId: string; owner: string; content: string; requestKey: string }): Promise<void>;
  pendingApprovals(owner: string, dotId: string, sessionId: string): Promise<Array<{ invocationId: string; summary: string }>>;
  /** The conversation's most recent Goal, open or finished. */
  goalFor(owner: string, dotId: string, sessionId: string): Promise<{ goalId: string; status: string; statusReason: string | null; createdAt: string; updatedAt: string } | null>;
  /** Answers a blocked Goal: adds the reply as guidance and resumes it. */
  answerGoal(owner: string, dotId: string, goalId: string, text: string): Promise<void>;
  appOrigin: string | null;
  log?(message: string, error?: unknown): void;
}

export function createDotChannelService(deps: DotChannelDeps) {
  async function reply(message: ChannelInboundMessage, text: string) {
    if (message.provider === "SLACK" && deps.slack) {
      await deps.slack.post({ channel: message.conversationId, text, threadTs: message.threadKey });
    } else if (message.provider === "TEAMS" && deps.teams && message.serviceUrl) {
      await deps.teams.post({ serviceUrl: message.serviceUrl, conversationId: message.conversationId, text });
    }
  }
  const spaceLink = () => deps.appOrigin ? ` ${deps.appOrigin}` : "";
  const requestKeyFor = (provider: ChannelProvider, eventId: string) => `channel-${sha(`${provider}:${eventId}`)}`;
  // One message at a time per thread, so two first messages never open two conversations.
  const locks = new Map<string, Promise<unknown>>();
  async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }

  async function linkCode(owner: string) {
    const code = Array.from({ length: 8 }, () => CHANNEL_LINK_ALPHABET[randomInt(CHANNEL_LINK_ALPHABET.length)]).join("");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await deps.repo.createLinkCode(owner, code, expiresAt);
    return { code: formatChannelLinkCode(code), expiresAt };
  }

  async function ensureConversation(thread: ChannelThreadRecord, dot: DotProfile): Promise<ChannelThreadRecord | null> {
    const session = thread.sessionId ? await deps.store.getSpaceAgentSession(thread.sessionId) : null;
    if (session?.isActive && thread.paneId) return thread;
    const roomId = await deps.pickRoom(thread.ownerUserId);
    if (!roomId) return null;
    const pane = await deps.openPane({ owner: thread.ownerUserId, roomId, title: `${dot.name} · ${providerLabel[thread.provider]}` });
    const { sessionId } = await deps.startSession({ pane, owner: thread.ownerUserId, dotId: dot.dotId });
    await deps.repo.updateThread(thread.threadId, { sessionId, paneId: pane.id });
    return { ...thread, sessionId, paneId: pane.id };
  }

  async function busy(sessionId: string) {
    const latest = await deps.store.getLatestSpaceAgentRun(sessionId);
    return latest?.status === "QUEUED" || latest?.status === "RUNNING";
  }

  /**
   * Sends the oldest waiting message when nothing sent before is still running.
   * Returns what happened to `eventId` when it is given (for the reply to a new message).
   */
  async function dispatch(thread: ChannelThreadRecord, dotName: string, eventId?: string): Promise<"SENT" | "WAITING" | { dropped: string } | null> {
    const open = await deps.repo.openInbox(thread.threadId);
    for (const item of open.filter((entry) => entry.status === "SENT")) {
      const run = await deps.store.getSpaceAgentSubmission(thread.paneId!, item.requestKey);
      if (!run || !finished.has(run.status)) return eventId && open.some((entry) => entry.eventId === eventId && entry.status === "PENDING") ? "WAITING" : null;
    }
    const next = open.find((entry) => entry.status === "PENDING");
    if (!next) return null;
    try {
      await deps.send({ paneId: thread.paneId!, sessionId: thread.sessionId!, owner: thread.ownerUserId, content: next.text, requestKey: next.requestKey });
      await deps.repo.markInbox(thread.threadId, next.eventId, "SENT");
      return next.eventId === eventId || !eventId ? "SENT" : "WAITING";
    } catch (error) {
      if (!(error instanceof SpaceConflictError)) throw error;
      if (await busy(thread.sessionId!)) return eventId ? "WAITING" : null;
      // Not busy: the conversation refused this message for good (for example a pending decision or an unavailable model).
      await deps.repo.markInbox(thread.threadId, next.eventId, "DROPPED");
      const reason = `${dotName} could not take that message: ${error.message.slice(0, 300)}`;
      if (next.eventId !== eventId) await deps.repo.enqueue({ threadId: thread.threadId, sourceKey: `dropped:${next.requestKey}`, kind: "NOTICE", target: "THREAD", body: reason });
      return next.eventId === eventId ? { dropped: reason } : null;
    }
  }

  async function processInbound(message: ChannelInboundMessage): Promise<void> {
    const identity = await deps.repo.identity(message.provider, message.tenantId, message.externalUserId);
    const owner = identity?.ownerUserId ?? null;
    const dots = owner ? [...await deps.dots.list(owner)].sort((a, b) => a.slot - b.slot) : [];
    const command = parseChannelCommand(message.text, dots.map((dot) => dot.name));
    if (command.kind === "link") {
      // A code typed where others can read it could be used by someone else: it is cancelled at once.
      if (message.conversationKind !== "DIRECT") {
        await deps.repo.burnLinkCode(command.code);
        await reply(message, "For your security I cancelled that code. Create a new one in Space and send it to me in a direct message.");
        return;
      }
      const linked = await deps.repo.linkIdentity(command.code, { provider: message.provider, tenantId: message.tenantId,
        externalUserId: message.externalUserId, displayName: message.displayName, replyAddress: message.replyAddress });
      await reply(message, linked === "LINKED_ELSEWHERE" ? "This account is already linked to another Space user. They need to unlink it first."
        : linked ? `Linked to your Space account. Start a message with a Dot's name to talk to it, for example "Orbit: summarize my day".`
        : "That code is not valid or has expired. Create a new one in Space.");
      return;
    }
    if (!identity) {
      await reply(message, `This ${providerLabel[message.provider]} account is not linked to Space. In Space, open a Dot's Tools, create a link code under Slack and Teams and send me: link XXXX-XXXX`);
      return;
    }
    if (identity.replyAddress !== message.replyAddress) await deps.repo.updateReplyAddress(identity.identityId, message.replyAddress);
    if (command.kind === "unlink") {
      if (message.conversationKind !== "DIRECT") { await reply(message, "Send unlink to me in a direct message."); return; }
      await deps.repo.unlink(identity.ownerUserId, identity.identityId);
      await reply(message, "Unlinked. Space no longer accepts messages from this account.");
      return;
    }
    let thread = await deps.repo.thread(message.provider, message.tenantId, message.conversationId, message.threadKey);
    // Participant check: a thread belongs to the owner who started it.
    if (thread && thread.ownerUserId !== identity.ownerUserId) {
      await reply(message, "This conversation is linked to someone else's Dot. Message the Space app directly to use your own Dots.");
      return;
    }
    if (command.kind === "reply-here") {
      if (!thread) { await reply(message, "Start a conversation with a Dot in this thread first."); return; }
      await deps.repo.updateThread(thread.threadId, { replyInThread: command.enabled || thread.conversationKind === "DIRECT" });
      await reply(message, command.enabled ? "Answers will be posted in this thread, where everyone in it can read them." : "Answers will be sent to you directly.");
      return;
    }
    const named = command.dot ? dots.find((dot) => dot.name === command.dot) ?? null : null;
    if (thread && named && named.dotId !== thread.dotId) {
      const current = dots.find((dot) => dot.dotId === thread!.dotId)?.name ?? "another Dot";
      await reply(message, `This thread is with ${current}. Start a new thread to talk to ${named.name}.`);
      return;
    }
    const dot = named ?? dots.find((candidate) => candidate.dotId === thread?.dotId) ?? dots[0];
    if (!dot) { await reply(message, "Your Dots are not available right now."); return; }
    thread ??= await deps.repo.createThread({ provider: message.provider, tenantId: message.tenantId, conversationId: message.conversationId,
      threadKey: message.threadKey, conversationKind: message.conversationKind, identityId: identity.identityId, ownerUserId: identity.ownerUserId,
      dotId: dot.dotId, sessionId: null, paneId: null, serviceUrl: message.serviceUrl });
    if (message.serviceUrl && message.serviceUrl !== thread.serviceUrl) await deps.repo.updateThread(thread.threadId, { serviceUrl: message.serviceUrl });
    const ready = await ensureConversation(thread, dot);
    if (!ready) { await reply(message, "Create a room in Space first; your Dots work there."); return; }
    thread = ready;
    const text = command.text.slice(0, 7000);
    // A Goal waiting for the user takes the reply as its answer and continues.
    const goal = await deps.goalFor(identity.ownerUserId, dot.dotId, thread.sessionId!);
    if (goal?.status === "BLOCKED") {
      await deps.answerGoal(identity.ownerUserId, dot.dotId, goal.goalId, text);
      await reply(message, `Thanks. ${dot.name} continues with your answer.`);
      return;
    }
    const content = `(${providerLabel[message.provider]}${message.conversationKind === "GROUP" ? ", shared conversation" : ""}) ${text}`;
    if (!await deps.repo.queueInbox(thread.threadId, message.eventId, content, requestKeyFor(message.provider, message.eventId))) return;
    // Messages are answered in the order they arrived; a new one waits behind older ones.
    const outcome = await dispatch(thread, dot.name, message.eventId);
    if (outcome === "WAITING") await reply(message, `${dot.name} is finishing something; your message is next.`);
    else if (outcome && typeof outcome === "object") await reply(message, outcome.dropped);
  }

  /** Handles one verified message; duplicates (provider retries) are ignored and failures are told to the user. */
  async function handleInbound(message: ChannelInboundMessage): Promise<void> {
    if (!await deps.repo.markEvent(message.provider, message.eventId)) return;
    const key = [message.provider, message.tenantId, message.conversationId, message.threadKey].join("|");
    try {
      await serialized(key, () => processInbound(message));
    } catch (error) {
      deps.log?.("Channel message failed.", error);
      await reply(message, "Something went wrong with that message. Please send it again.").catch(() => undefined);
    }
  }

  async function deliver(thread: ChannelThreadRecord, identity: ChannelIdentityRecord, target: "THREAD" | "DIRECT", text: string) {
    if (thread.provider === "SLACK") {
      if (!deps.slack) throw new Error("Slack is not configured.");
      if (target === "THREAD") await deps.slack.post({ channel: thread.conversationId, text, threadTs: thread.threadKey });
      else await deps.slack.post({ channel: await deps.slack.openDirect(identity.replyAddress), text });
      return;
    }
    if (!deps.teams || !thread.serviceUrl) throw new Error("Teams is not configured.");
    const conversationId = target === "THREAD" ? thread.conversationId
      : await deps.teams.openDirect({ serviceUrl: thread.serviceUrl, tenantId: thread.tenantId, userAddress: identity.replyAddress });
    await deps.teams.post({ serviceUrl: thread.serviceUrl, conversationId, text });
  }
  /** A direct message to a linked account, which may never have started a thread (Teams needs one to reach the user). */
  async function deliverDirect(identity: ChannelIdentityRecord, text: string) {
    const via = await deps.repo.latestThreadForIdentity(identity.identityId);
    const thread: ChannelThreadRecord = via ?? { threadId: "", provider: identity.provider, tenantId: identity.tenantId, conversationId: "", threadKey: "direct",
      conversationKind: "DIRECT", identityId: identity.identityId, ownerUserId: identity.ownerUserId, dotId: "", sessionId: null, paneId: null, serviceUrl: null,
      replyInThread: false, lastDeliveredRunId: null, createdAt: identity.createdAt, updatedAt: identity.createdAt };
    await deliver(thread, identity, "DIRECT", text);
  }

  let sweeping = false;
  let lastPrune = 0;
  /** Returns answers to channel requests, Goal questions and outcomes, and approvals; sends waiting messages; delivers the outbox. */
  async function sweep(): Promise<{ queued: number; delivered: number }> {
    // Sweeps never overlap, so a slow provider cannot cause double deliveries.
    if (sweeping) return { queued: 0, delivered: 0 };
    sweeping = true;
    try { return await sweepOnce(); } finally { sweeping = false; }
  }
  async function sweepOnce(): Promise<{ queued: number; delivered: number }> {
    let queued = 0, delivered = 0;
    if (Date.now() - lastPrune > 3_600_000) { lastPrune = Date.now(); await deps.repo.pruneEvents(48).catch(() => 0); }
    const dotNames = new Map<string, Map<string, string>>();
    const nameOf = async (owner: string, dotId: string) => {
      if (!dotNames.has(owner)) dotNames.set(owner, new Map((await deps.dots.list(owner)).map((dot) => [dot.dotId, dot.name])));
      return dotNames.get(owner)!.get(dotId) ?? "Your Dot";
    };
    for (const thread of await deps.repo.activeThreads(200)) {
      try {
        const session = await deps.store.getSpaceAgentSession(thread.sessionId!);
        if (!session?.isActive || !thread.paneId) continue;
        const name = await nameOf(thread.ownerUserId, thread.dotId);
        // Participant check: in a shared conversation, only the owner sees what the Dot returns unless they chose otherwise.
        const target = thread.conversationKind === "DIRECT" || thread.replyInThread ? "THREAD" as const : "DIRECT" as const;
        // Only answers to requests made in this thread go back to it; work started elsewhere stays in Space.
        for (const item of (await deps.repo.openInbox(thread.threadId)).filter((entry) => entry.status === "SENT")) {
          const run = await deps.store.getSpaceAgentSubmission(thread.paneId, item.requestKey);
          if (!run || !finished.has(run.status)) continue;
          const answer = (await deps.store.listSpaceAgentMessages(thread.sessionId!)).find((message) => message.messageId === run.responseMessageId)?.content?.trim();
          const body = run.status === "COMPLETED" ? `${name}: ${answer || "Done."}` : `${name} could not finish: ${run.errorMessage ?? run.status.toLowerCase()}`;
          if (await deps.repo.enqueue({ threadId: thread.threadId, sourceKey: `result:${run.runId}`, kind: "RESULT", target, body: body.slice(0, 11_500) })) queued += 1;
          if (target === "DIRECT" && await deps.repo.enqueue({ threadId: thread.threadId, sourceKey: `result-note:${run.runId}`, kind: "NOTICE", target: "THREAD",
            body: `${name} sent the answer to its owner directly.` })) queued += 1;
          await deps.repo.markInbox(thread.threadId, item.eventId, "DELIVERED");
        }
        await dispatch(thread, name);
        for (const approval of await deps.pendingApprovals(thread.ownerUserId, thread.dotId, thread.sessionId!)) {
          if (await deps.repo.enqueue({ threadId: thread.threadId, sourceKey: `approval:${approval.invocationId}`, kind: "APPROVAL", target,
            body: `${name} is waiting for your approval: ${approval.summary.slice(0, 600)}\nApprove or decline it in Space.${spaceLink()}` })) queued += 1;
        }
        const goal = await deps.goalFor(thread.ownerUserId, thread.dotId, thread.sessionId!);
        if (goal && Date.parse(goal.createdAt) >= Date.parse(thread.createdAt)) {
          if (goal.status === "BLOCKED") {
            if (await deps.repo.enqueue({ threadId: thread.threadId, sourceKey: `goal:${goal.goalId}:${goal.updatedAt}`, kind: "QUESTION", target,
              body: `${name} needs you: ${(goal.statusReason ?? "it is waiting for your input").slice(0, 1000)}\nReply ${target === "THREAD" ? "here" : "in the thread"} to answer.` })) queued += 1;
          } else if (["COMPLETED", "FAILED", "CANCELLED", "BUDGET_EXHAUSTED"].includes(goal.status)) {
            if (await deps.repo.enqueue({ threadId: thread.threadId, sourceKey: `goal-done:${goal.goalId}:${goal.status}`, kind: "NOTICE", target,
              body: goal.status === "COMPLETED" ? `${name} finished its Goal. The details are in Space.${spaceLink()}`
                : `${name}'s Goal ended (${goal.status.toLowerCase().replace("_", " ")}): ${(goal.statusReason ?? "no reason given").slice(0, 600)}` })) queued += 1;
          }
        }
      } catch (error) {
        deps.log?.("Channel thread sweep failed.", error);
      }
    }
    const threads = new Map<string, ChannelThreadRecord>();
    for (const item of await deps.repo.due(50)) {
      try {
        if (!item.threadId) {
          const identity = item.identityId ? await deps.repo.identityById(item.identityId) : null;
          if (!identity) { await deps.repo.retry(item.outboxId, "The account was unlinked.", 1); continue; }
          await deliverDirect(identity, item.body);
          await deps.repo.delivered(item.outboxId);
          delivered += 1;
          continue;
        }
        const thread = threads.get(item.threadId) ?? await deps.repo.threadById(item.threadId);
        if (!thread) { await deps.repo.retry(item.outboxId, "The thread no longer exists.", 1); continue; }
        threads.set(thread.threadId, thread);
        const identity = await deps.repo.identityById(thread.identityId);
        if (!identity) { await deps.repo.retry(item.outboxId, "The account was unlinked.", 1); continue; }
        await deliver(thread, identity, item.target, item.body);
        await deps.repo.delivered(item.outboxId);
        delivered += 1;
      } catch (error) {
        await deps.repo.retry(item.outboxId, error instanceof Error ? error.message : "Delivery failed.", 6);
      }
    }
    return { queued, delivered };
  }

  async function status(owner: string): Promise<ChannelsStatus> {
    const [identities, threads] = await Promise.all([deps.repo.identities(owner), deps.repo.threads(owner)]);
    return { providers: deps.providers,
      identities: identities.map((item) => ({ identityId: item.identityId, provider: item.provider, tenantId: item.tenantId, displayName: item.displayName, linkedAt: item.createdAt })),
      threads: threads.map((item) => ({ threadId: item.threadId, provider: item.provider, conversationKind: item.conversationKind, dotId: item.dotId,
        replyInThread: item.replyInThread, updatedAt: item.updatedAt })) };
  }
  /** Connections the owner made, for evaluation cases that need them. */
  async function available(owner: string): Promise<string[]> {
    const providers = new Set((await deps.repo.identities(owner)).map((item) => item.provider));
    return [...providers].filter((provider) => deps.providers.find((entry) => entry.provider === provider)?.configured).map((provider) => `channel:${provider.toLowerCase()}`);
  }
  /** `channel.slack.send` / `channel.teams.send`: a direct message to the owner, or a post in the thread linked to this conversation. */
  async function toolSend(session: { sessionId: string }, owner: string, toolId: string, args: Record<string, unknown>):
    Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }> {
    const provider: ChannelProvider = toolId === "channel.teams.send" ? "TEAMS" : "SLACK";
    const parsed = z.object({ text: z.string().trim().min(1).max(8000), where: z.enum(["direct", "thread"]).default("direct") }).strict().safeParse(args);
    if (!parsed.success) return { status: "BLOCKED", statusReason: `${toolId} needs text (up to 8,000 characters) and optional where: direct or thread.` };
    const identities = (await deps.repo.identities(owner)).filter((item) => item.provider === provider);
    if (parsed.data.where === "thread") {
      const thread = await deps.repo.threadForSession(session.sessionId, provider);
      if (!thread || thread.ownerUserId !== owner) return { status: "BLOCKED", statusReason: `This conversation has no linked ${providerLabel[provider]} thread.` };
      const identity = await deps.repo.identityById(thread.identityId);
      if (!identity) return { status: "BLOCKED", statusReason: `The ${providerLabel[provider]} account was unlinked.` };
      await deliver(thread, identity, "THREAD", parsed.data.text);
      return { status: "COMPLETED", result: { sent: true, provider, where: "thread" } };
    }
    const identity = identities[0];
    if (!identity) return { status: "BLOCKED", statusReason: `No ${providerLabel[provider]} account is linked.` };
    if (provider === "TEAMS" && !(await deps.repo.latestThreadForIdentity(identity.identityId))?.serviceUrl) {
      return { status: "BLOCKED", statusReason: "Message the Space app in Teams once so it can reach you." };
    }
    await deliverDirect(identity, parsed.data.text);
    return { status: "COMPLETED", result: { sent: true, provider, where: "direct" } };
  }
  /**
   * A message the Dot wrote on its own, also sent to its owner in Slack (Settings → Dots → Also send to Slack): the same
   * plain text and Space's link to its source, as a direct message from the Space app, once per notice. False when Space
   * has no Slack app or the owner linked no Slack account.
   */
  async function notifyOwner(owner: string, notice: { sourceKey: string; dotName: string; content: string; link: { label: string; url: string } | null }) {
    if (!deps.slack) return false;
    const identity = (await deps.repo.identities(owner)).find((item) => item.provider === "SLACK");
    if (!identity) return false;
    const link = notice.link && /^https:\/\/[^\s<>|]+$/.test(notice.link.url) ? `\n<${notice.link.url}|${slackText(notice.link.label)}>` : "";
    return deps.repo.enqueue({ threadId: null, identityId: identity.identityId, sourceKey: notice.sourceKey, kind: "NOTICE", target: "DIRECT",
      body: `${slackText(notice.dotName)}: ${slackText(notice.content)}${link}` });
  }
  return { linkCode, handleInbound, sweep, status, available, toolSend, notifyOwner, unlink: (owner: string, identityId: string) => deps.repo.unlink(owner, identityId) };
}
export type DotChannelService = ReturnType<typeof createDotChannelService>;

export function registerDotChannelRoutes(app: FastifyInstance, service: DotChannelService | null, options: {
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
  verifySlack: ((input: { rawBody: string; timestamp: string | undefined; signature: string | undefined }) => boolean) | null;
  parseSlack: (raw: string) => { kind: "challenge"; challenge: string } | { kind: "message"; message: ChannelInboundMessage } | { kind: "ignored"; reason: string };
  verifyTeams: ((authorization: string | undefined, serviceUrl: string | null) => Promise<boolean>) | null;
  parseTeams: (activity: Record<string, unknown>) => ChannelInboundMessage | null;
  log(message: string, error?: unknown): void;
}) {
  const unavailable = (reply: FastifyReply) => reply.code(404).send({ error: { code: "CHANNEL_UNAVAILABLE", message: "This channel is not configured." } });
  // Verified events are acknowledged at once; the Dot's work happens afterwards and replies through the channel.
  const handle = (message: ChannelInboundMessage) => { void service!.handleInbound(message).catch((error) => options.log("Channel message failed.", error)); };
  app.register(async (child) => {
    // Signatures cover the exact bytes, so these routes keep the raw body.
    child.removeAllContentTypeParsers();
    child.addContentTypeParser("*", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_request, body, done) => done(null, body));
    child.post("/api/channels/slack/events", options.routeOptions, async (request, reply) => {
      if (!service || !options.verifySlack) return unavailable(reply);
      const rawBody = typeof request.body === "string" ? request.body : "";
      const header = (name: string) => { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; };
      if (!options.verifySlack({ rawBody, timestamp: header("x-slack-request-timestamp"), signature: header("x-slack-signature") })) {
        return reply.code(401).send({ error: { code: "CHANNEL_SIGNATURE_INVALID", message: "Invalid signature." } });
      }
      const envelope = options.parseSlack(rawBody);
      if (envelope.kind === "challenge") return reply.send({ challenge: envelope.challenge });
      if (envelope.kind === "message") handle(envelope.message);
      return reply.code(200).send({ ok: true });
    });
    child.post("/api/channels/teams/messages", options.routeOptions, async (request, reply) => {
      if (!service || !options.verifyTeams) return unavailable(reply);
      let activity: Record<string, unknown>;
      try { activity = JSON.parse(typeof request.body === "string" ? request.body : "{}") as Record<string, unknown>; }
      catch { return reply.code(400).send({ error: { code: "CHANNEL_INVALID", message: "Invalid activity." } }); }
      const serviceUrl = typeof activity.serviceUrl === "string" ? activity.serviceUrl : null;
      const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
      if (!await options.verifyTeams(authorization, serviceUrl).catch(() => false)) {
        return reply.code(401).send({ error: { code: "CHANNEL_SIGNATURE_INVALID", message: "Invalid token." } });
      }
      const message = options.parseTeams(activity);
      if (message) handle(message);
      return reply.code(200).send({});
    });
  });
  const ready = async (request: FastifyRequest, reply: FastifyReply) => {
    const owner = await options.authenticatedOwner(request);
    if (!service) { await reply.code(503).send({ error: { code: "CHANNELS_UNAVAILABLE", message: "Slack and Teams need the database." } }); return null; }
    return owner;
  };
  app.get("/api/channels", options.routeOptions, async (request, reply) => {
    const owner = await ready(request, reply);
    return owner ? service!.status(owner) : reply;
  });
  app.post("/api/channels/link-codes", options.routeOptions, async (request, reply) => {
    const owner = await ready(request, reply);
    return owner ? reply.code(201).send(await service!.linkCode(owner)) : reply;
  });
  app.delete("/api/channels/identities/:identityId", options.routeOptions, async (request, reply) => {
    const owner = await ready(request, reply);
    if (!owner) return reply;
    const { identityId } = z.object({ identityId: z.string().regex(/^channel_identity:[a-f0-9]{32}$/) }).parse(request.params);
    return await service!.unlink(owner, identityId) ? { identityId, unlinked: true }
      : reply.code(404).send({ error: { code: "CHANNEL_IDENTITY_NOT_FOUND", message: "Linked account not found." } });
  });
}
