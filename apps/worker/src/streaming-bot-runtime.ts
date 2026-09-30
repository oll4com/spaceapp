import { randomUUID } from "node:crypto";
import {
  ReplyRateLimiter,
  StreamingCredentialStore,
  StreamingTokenManager,
  TwitchChatConnector,
  TwitchEventSubChat,
  YouTubeChatConnector,
  YouTubeLiveChatStream,
  canReply,
  decideStreamingModeration,
  getStreamingBotLlmConfig,
  isSpam,
  isViewerQuestion,
  resolveStreamingBotModel,
  publicSpaceappContext,
  runBotTurn,
  truncateReply,
  type BotMemoryStore,
  type BotPromptContext,
  type BotTurnMessage,
  type BotTurnTools,
  type StreamingChatMessage
} from "@space/streaming";
import {
  PostgresStreamingRepository,
  type StreamingBotRepository,
  type StreamingPlatformAccountRecord
} from "@space/db";
import type { StreamingBotPlatform, StreamingBotSettings } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

export interface StreamingBotRuntimeOptions {
  streamingRepository: PostgresStreamingRepository;
  spaceStore: SpaceStore;
  botRepository: StreamingBotRepository;
  credentialStore: StreamingCredentialStore;
  memoryStore: BotMemoryStore;
  youtubeDailyBudget: number;
  youtubeReplyUnitCost: number;
  internalApiBaseUrl: string;
  internalApiToken: string | null;
  mcpToolBridgeEnabled: boolean;
  now?: () => Date;
  log?: (record: Record<string, unknown>) => void;
}

export interface StreamingBotCycleResult {
  cycles: number;
  polled: Array<{ platform: StreamingBotPlatform; live: boolean; newMessages: number }>;
  replies: number;
  skipped: number;
  errors: number;
}

export class StreamingBotLoop {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: {
    intervalMs: number;
    runCycle: () => Promise<unknown>;
    log?: (record: Record<string, unknown>) => void;
  }) {}

  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.options.runCycle();
    } catch (error) {
      this.options.log?.({ status: "FAILED", error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
    return true;
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), Math.max(1_000, this.options.intervalMs));
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

const twitchSessions = new Map<string, TwitchEventSubChat>();
const youtubeSessions = new Map<string, YouTubeLiveChatStream>();
const youtubePollAfter = new Map<string, number>();
const youtubeBroadcastCache = new Map<string, { checkedAt: number; broadcast: { chatId: string } | null }>();
const moderationLocks = new Map<string, Promise<void>>();

function closeTwitchSessions(keepAccountId: string | null): void {
  for (const [accountId, session] of twitchSessions) {
    if (accountId === keepAccountId) continue;
    session.close();
    twitchSessions.delete(accountId);
  }
}

function closeYouTubeSessions(keepAccountId: string | null): void {
  for (const [accountId, session] of youtubeSessions) {
    if (accountId === keepAccountId) continue;
    session.close();
    youtubeSessions.delete(accountId);
    youtubePollAfter.delete(accountId);
    youtubeBroadcastCache.delete(accountId);
  }
}

interface PlatformAuth {
  credentialRef: string;
  provider: StreamingBotPlatform;
  scopes: string[];
}

export async function runStreamingBotCycle(options: StreamingBotRuntimeOptions): Promise<StreamingBotCycleResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const settings = await options.botRepository.getSettings();
  if (!settings.enabled && !settings.moderationEnabled) {
    closeTwitchSessions(null);
    closeYouTubeSessions(null);
    return { cycles: 1, polled: [], replies: 0, skipped: 0, errors: 0 };
  }

  const result: StreamingBotCycleResult = { cycles: 1, polled: [], replies: 0, skipped: 0, errors: 0 };
  const limiter = new ReplyRateLimiter(settings.guardrails.maxRepliesPerMinute);
  const day = now().toISOString().slice(0, 10);
  const youtubeQuota = await options.botRepository.getQuota("YOUTUBE", day);
  const tokenManager = new StreamingTokenManager({ credentialStore: options.credentialStore });
  closeTwitchSessions(settings.platforms.TWITCH.enabled ? settings.platforms.TWITCH.accountId : null);
  closeYouTubeSessions(settings.platforms.YOUTUBE.enabled ? settings.platforms.YOUTUBE.accountId : null);

  const [accounts, authorizations] = await Promise.all([
    options.streamingRepository.listAccounts(),
    options.streamingRepository.listAuthorizations()
  ]);
  const authByAccount = new Map<string, PlatformAuth>();
  for (const account of accounts) {
    const authorization = authorizations.find((candidate) => candidate.id === account.authorizationId);
    if (!authorization || authorization.status !== "ACTIVE") continue;
    authByAccount.set(account.id, { credentialRef: authorization.credentialRef, provider: account.provider as StreamingBotPlatform, scopes: authorization.scopes });
  }

  for (const platform of ["YOUTUBE", "TWITCH"] as const) {
    const platformSettings = settings.platforms[platform];
    if ((!platformSettings.enabled && !settings.moderationEnabled) || !platformSettings.accountId) continue;
    const account = accounts.find((candidate) => candidate.id === platformSettings.accountId);
    const auth = account ? authByAccount.get(account.id) : undefined;
    if (!account || !auth || auth.provider !== platform) continue;
    const readScope = platform === "YOUTUBE" ? "https://www.googleapis.com/auth/youtube.force-ssl" : "user:read:chat";
    if (!auth.scopes.includes(readScope)) {
      log({ status: "CHAT_PERMISSION_MISSING", platform });
      result.errors += 1;
      continue;
    }
    try {
      const outcome = await pollPlatform(platform, account, auth, settings, {
        ...options,
        tokenManager,
        limiter,
        day,
        youtubeQuota: youtubeQuota.unitsConsumed,
        now
      });
      result.polled.push(outcome.polled);
      result.replies += outcome.replies;
      result.skipped += outcome.skipped;
      result.errors += outcome.errors;
    } catch (error) {
      result.errors += 1;
      log({ status: "PLATFORM_ERROR", platform, error: error instanceof Error ? error.message : String(error) });
    }
  }

  await options.botRepository.pruneActivity(500);
  return result;
}

interface PollContext {
  tokenManager: StreamingTokenManager;
  limiter: ReplyRateLimiter;
  day: string;
  youtubeQuota: number;
  now: () => Date;
}

interface PollOutcome {
  polled: { platform: StreamingBotPlatform; live: boolean; newMessages: number };
  replies: number;
  skipped: number;
  errors: number;
}

async function pollPlatform(
  platform: StreamingBotPlatform,
  account: StreamingPlatformAccountRecord,
  auth: PlatformAuth,
  settings: StreamingBotSettings,
  context: PollContext & StreamingBotRuntimeOptions
): Promise<PollOutcome> {
  const options = context;
  const client = await context.credentialStore.readClient(platform);
  const token = await context.tokenManager.getToken(platform, auth.credentialRef);

  const fetchResult = platform === "YOUTUBE"
    ? await fetchYouTube(context, options, account, token)
    : await fetchTwitch(context, options, account, token);

  const chatId = fetchResult.chatId;
  if (!chatId || !fetchResult.live || !fetchResult.messages.length) {
    if (chatId) {
      await options.botRepository.upsertChatState({
        platform,
        accountId: account.id,
        chatId,
        cursor: fetchResult.cursor,
        lastPolledAt: context.now().toISOString(),
        lastReplyAt: (await options.botRepository.getChatState(platform, account.id, chatId))?.lastReplyAt ?? null,
        pendingCount: 0
      });
    }
    return {
      polled: { platform, live: fetchResult.live, newMessages: 0 },
      replies: 0,
      skipped: 0,
      errors: 0
    };
  }

  const candidates: StreamingChatMessage[] = [];
  for (let offset = 0; offset < fetchResult.messages.length; offset += 50) {
    const batch = fetchResult.messages.slice(offset, offset + 50).filter(message => {
      if (message.author.toLowerCase() === settings.persona.name.toLowerCase()) return false;
      if (message.authorId === account.externalAccountId) return false;
      const ageMs = context.now().getTime() - Date.parse(message.publishedAt);
      return Number.isFinite(ageMs) && ageMs >= -5_000 && ageMs <= 30_000;
    });
    const receipts = await Promise.all(batch.map(message => options.botRepository.claimMessage(platform, account.id, message.id)));
    for (let index = 0; index < batch.length; index++) if (receipts[index]) candidates.push(batch[index]!);
  }
  if (!candidates.length) {
    await options.botRepository.upsertChatState({ platform, accountId: account.id, chatId,
      cursor: fetchResult.cursor, lastPolledAt: context.now().toISOString(),
      lastReplyAt: (await options.botRepository.getChatState(platform, account.id, chatId))?.lastReplyAt ?? null, pendingCount: 0 });
    return { polled: { platform, live: true, newMessages: 0 }, replies: 0, skipped: 0, errors: 0 };
  }

  const replyCandidates: StreamingChatMessage[] = [];
  for (let offset = 0; offset < candidates.length; offset += 50) {
    const batch = candidates.slice(offset, offset + 50);
    const handled = settings.moderationEnabled
      ? await Promise.all(batch.map(candidate => moderateCandidate(platform, account, auth, chatId, token, candidate, settings, context)))
      : batch.map(() => false);
    for (let index = 0; index < batch.length; index++) {
      const candidate = batch[index]!;
      if (!handled[index] && replyCandidates.length < 20 &&
        (!settings.guardrails.replyToQuestionsOnly || isViewerQuestion(candidate.message)) &&
        !isSpam(candidate, replyCandidates)) replyCandidates.push(candidate);
    }
  }
  if (!settings.enabled || !settings.platforms[platform].enabled || !replyCandidates.length) {
    await options.botRepository.upsertChatState({ platform, accountId: account.id, chatId,
      cursor: fetchResult.cursor, lastPolledAt: context.now().toISOString(),
      lastReplyAt: (await options.botRepository.getChatState(platform, account.id, chatId))?.lastReplyAt ?? null, pendingCount: 0 });
    return { polled: { platform, live: true, newMessages: candidates.length }, replies: 0, skipped: candidates.length, errors: 0 };
  }

  const [modelProviders, models] = await Promise.all([options.spaceStore.listProviders(), options.spaceStore.listModels()]);
  const primaryModel = resolveStreamingBotModel(settings.modelSelection, modelProviders, models, getStreamingBotLlmConfig());
  if (!primaryModel.modelId) {
    options.log?.({ status: "MODEL_UNAVAILABLE", platform, errorCode: primaryModel.errorCode });
    return { polled: { platform, live: true, newMessages: candidates.length }, replies: 0, skipped: candidates.length, errors: 1 };
  }

  const memorySummary = settings.memoryEnabled ? await summarizeMemory(options.memoryStore) : "";
  const liveMetrics = await fetchLiveMetrics(options);
  const contextPrompt: BotPromptContext = {
    settings,
    memorySummary,
    publicKnowledge: publicSpaceappContext(replyCandidates.map(message => message.message).join(" ")),
    liveMetrics,
    recentExchange: replyCandidates.map((message) => `${message.author}: ${message.message}`).join("\n")
  };
  const turnMessages: BotTurnMessage[] = replyCandidates.map((message) => ({
    id: message.id,
    author: message.author,
    message: message.message,
    platform
  }));

  let replies = 0;
  let skipped = 0;
  let errors = 0;
  const repliedIds = new Set<string>();

  const tools: BotTurnTools = {
    sendReply: async ({ platform: replyPlatform, message, replyToId }) => {
      if (replyPlatform !== platform) return { ok: false, error: "PLATFORM_MISMATCH" };
      const replyScope = platform === "YOUTUBE" ? "https://www.googleapis.com/auth/youtube.force-ssl" : "user:write:chat";
      if (!auth.scopes.includes(replyScope)) return { ok: false, error: "MISSING_REPLY_PERMISSION" };
      const fresh = replyCandidates.some(candidate => (!replyToId || candidate.id === replyToId) &&
        context.now().getTime() - Date.parse(candidate.publishedAt) <= 30_000);
      if (!fresh) return { ok: false, error: "MESSAGE_EXPIRED" };
      const lastMinute = new Date(context.now().getTime() - 60_000).toISOString();
      if (await options.botRepository.recentReplyCount(lastMinute) >= settings.guardrails.maxRepliesPerMinute) {
        skipped += 1;
        return { ok: false, error: "RATE_LIMITED" };
      }
      const state = await options.botRepository.getChatState(platform, account.id, chatId);
      if (state?.lastReplyAt && context.now().getTime() - Date.parse(state.lastReplyAt) < settings.guardrails.cooldownSeconds * 1_000) {
        skipped += 1;
        return { ok: false, error: "COOLDOWN" };
      }
      const budget = canReply(replyPlatform, {
        guardrails: settings.guardrails,
        youtubeDailyUnits: context.youtubeQuota,
        youtubeDailyBudget: options.youtubeDailyBudget,
        youtubeReplyUnitCost: options.youtubeReplyUnitCost
      }, context.limiter, context.now());
      if (budget.reason) {
        skipped += 1;
        return { ok: false, error: budget.reason };
      }
      const capped = truncateReply(message, replyPlatform);
      try {
        const id = platform === "YOUTUBE"
          ? await new YouTubeChatConnector().sendChatMessage(token, chatId, capped)
          : await new TwitchChatConnector({ clientId: client.clientId }).sendChatMessage(token, account.externalAccountId, account.externalAccountId, capped);
        if (replyToId) repliedIds.add(replyToId);
        if (platform === "YOUTUBE") {
          await options.botRepository.consumeQuota("YOUTUBE", context.day, options.youtubeReplyUnitCost);
        }
        replies += 1;
        await options.botRepository.upsertChatState({
          platform,
          accountId: account.id,
          chatId,
          cursor: fetchResult.cursor,
          lastPolledAt: context.now().toISOString(),
          lastReplyAt: context.now().toISOString(),
          pendingCount: 0
        });
        await appendActivity(options, platform, {
          direction: "OUT",
          accountId: account.id,
          channelId: chatId,
          messageId: id,
          author: replyCandidates.find(candidate => candidate.id === replyToId)?.author ?? settings.persona.name,
          message: replyCandidates.find(candidate => candidate.id === replyToId)?.message ?? capped,
          reply: capped,
          status: "REPLIED"
        });
        void id;
        return { ok: true };
      } catch (error) {
        errors += 1;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    memorySave: async ({ title, body, tags }) => {
      if (!settings.memoryEnabled) return { ok: false, error: "MEMORY_DISABLED" };
      await options.memoryStore.saveMemory({ title, body, tags });
      return { ok: true };
    },
    memorySearch: async ({ query }) => {
      if (!settings.memoryEnabled) return { ok: false, error: "MEMORY_DISABLED", entries: [] };
      const entries = await options.memoryStore.searchMemory(query, 10);
      return { ok: true, entries: entries.map((entry) => `${entry.title}: ${entry.body}`) };
    }
  };

  let turn = await runBotTurn({ context: contextPrompt, messages: turnMessages, tools }, { now: options.now, modelId: primaryModel.modelId });
  if (turn.errorCode && turn.replies.length === 0 && settings.fallbackModelSelection) {
    const fallback = resolveStreamingBotModel(settings.fallbackModelSelection, modelProviders, models, getStreamingBotLlmConfig());
    if (fallback.modelId && fallback.modelId !== primaryModel.modelId) {
      turn = await runBotTurn({ context: contextPrompt, messages: turnMessages, tools }, { now: options.now, modelId: fallback.modelId });
    }
  }
  if (turn.errorCode) {
    options.log?.({ status: "TURN_ERROR", platform, errorCode: turn.errorCode });
  }

  for (const message of candidates) {
    const status = repliedIds.has(message.id) ? "REPLIED" : "SKIPPED";
    await appendActivity(options, platform, {
      direction: "IN",
      accountId: account.id,
      channelId: chatId,
      authorId: message.authorId,
      messageId: message.id,
      protectedAccount: message.protectedAccount === true,
      author: message.author,
      message: message.message.slice(0, 2000),
      reply: null,
      status
    });
  }
  return {
    polled: { platform, live: fetchResult.live, newMessages: candidates.length },
    replies,
    skipped,
    errors
  };
}

async function jevModerationVerdict(message: string, options: StreamingBotRuntimeOptions): Promise<"SAFE" | "ABUSE" | "SEVERE" | "AMBIGUOUS" | null> {
  if (!options.internalApiToken) return null;
  try {
    const response = await fetch(`${options.internalApiBaseUrl.replace(/\/$/, "")}/api/internal/streaming/bot/moderation-triage`, {
      method: "POST", signal: AbortSignal.timeout(1_500),
      headers: { "content-type": "application/json", "x-space-internal-token": options.internalApiToken },
      body: JSON.stringify({ message: message.slice(0, 2_000) })
    });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
    const payload = await response.json() as { available?: boolean; verdict?: unknown };
    return payload.available && ["SAFE", "ABUSE", "SEVERE", "AMBIGUOUS"].includes(String(payload.verdict))
      ? payload.verdict as "SAFE" | "ABUSE" | "SEVERE" | "AMBIGUOUS" : null;
  } catch { return null; }
}

async function moderateCandidate(
  platform: StreamingBotPlatform,
  account: StreamingPlatformAccountRecord,
  auth: PlatformAuth,
  chatId: string,
  token: Awaited<ReturnType<StreamingTokenManager["getToken"]>>,
  message: StreamingChatMessage,
  settings: StreamingBotSettings,
  context: PollContext & StreamingBotRuntimeOptions
): Promise<boolean> {
  if (!message.authorId) return false;
  const key = `${platform}\u0000${account.id}\u0000${chatId}\u0000${message.authorId}`;
  const previous = moderationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  moderationLocks.set(key, current);
  await previous;
  try {
    return await moderateCandidateUnlocked(platform, account, auth, chatId, token, message, settings, context);
  } finally {
    release();
    if (moderationLocks.get(key) === current) moderationLocks.delete(key);
  }
}

async function moderateCandidateUnlocked(
  platform: StreamingBotPlatform,
  account: StreamingPlatformAccountRecord,
  auth: PlatformAuth,
  chatId: string,
  token: Awaited<ReturnType<StreamingTokenManager["getToken"]>>,
  message: StreamingChatMessage,
  settings: StreamingBotSettings,
  context: PollContext & StreamingBotRuntimeOptions
): Promise<boolean> {
  const userId = message.authorId;
  if (!userId) return false;
  const protectedAccount = message.protectedAccount === true || userId === account.externalAccountId;
  if (protectedAccount) return false;
  const suspicious = /\b(?:kill|murder|hurt|address|phone|idiot|moron|worthless|harass|dox|die|stupid|hate)\b/i.test(message.message) ||
    /(?:σκοτώσ|διεύθυνσ|τηλέφων|ηλίθι|αχρηστ|μισώ)/iu.test(message.message);
  if (!suspicious) return false;
  const since = new Date(context.now().getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const strikes = await context.botRepository.moderationStrikes(platform, account.id, chatId, userId, since);
  const verdict = settings.jevEnabled ? await jevModerationVerdict(message.message, context) : null;
  const decision = decideStreamingModeration({ message: message.message, previousStrikes: strikes, protectedAccount, jevVerdict: verdict });
  if (decision.decision === "ALLOW") return false;
  const record = await context.botRepository.recordModerationAction({
    id: `moderation:${randomUUID()}`, platform, accountId: account.id, channelId: chatId,
    userId, messageId: message.id, decision: decision.decision, reason: decision.reason,
    durationSeconds: decision.durationSeconds, result: "PENDING", platformActionId: null, safeErrorCode: null
  });
  if (!record) return true;
  if (decision.decision === "REVIEW") {
    await context.botRepository.updateModerationAction(record.id, "REVIEW");
    return true;
  }
  const canWarn = platform === "YOUTUBE"
    ? auth.scopes.includes("https://www.googleapis.com/auth/youtube.force-ssl")
    : auth.scopes.includes("user:write:chat");
  const canTimeout = platform === "YOUTUBE"
    ? auth.scopes.includes("https://www.googleapis.com/auth/youtube.force-ssl")
    : auth.scopes.includes("moderator:manage:banned_users");
  if ((decision.decision === "WARN" && !canWarn) || (decision.durationSeconds !== null && !canTimeout)) {
    await context.botRepository.updateModerationAction(record.id, "UNAVAILABLE", null, "MISSING_PERMISSION");
    return true;
  }
  try {
    if (decision.decision === "WARN") {
      const warning = "Let's keep the chat respectful. Please stop the personal attacks.";
      if (platform === "YOUTUBE") await new YouTubeChatConnector().sendChatMessage(token, chatId, warning);
      else {
        const client = await context.credentialStore.readClient("TWITCH");
        await new TwitchChatConnector({ clientId: client.clientId }).sendChatMessage(token, account.externalAccountId, account.externalAccountId, warning);
      }
      await context.botRepository.updateModerationAction(record.id, "SUCCEEDED");
      return true;
    }
    const duration = decision.durationSeconds === 300 ? 300 : 1800;
    if (platform === "YOUTUBE") {
      const connector = new YouTubeChatConnector();
      const banId = await connector.timeoutUser(token, chatId, userId, duration);
      await context.botRepository.updateModerationAction(record.id, "SUCCEEDED", banId);
      await connector.deleteChatMessage(token, message.id).catch(() => undefined);
    } else {
      const client = await context.credentialStore.readClient("TWITCH");
      await new TwitchChatConnector({ clientId: client.clientId }).timeoutUser(token, account.externalAccountId, account.externalAccountId, userId, duration, decision.reason);
      await context.botRepository.updateModerationAction(record.id, "SUCCEEDED");
    }
    return true;
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 100) : "PLATFORM_ERROR";
    await context.botRepository.updateModerationAction(record.id, "FAILED", null, code);
    return true;
  }
}

async function fetchYouTube(
  context: PollContext & StreamingBotRuntimeOptions,
  options: StreamingBotRuntimeOptions,
  account: StreamingPlatformAccountRecord,
  token: Awaited<ReturnType<StreamingTokenManager["getToken"]>>
): Promise<{ live: boolean; messages: StreamingChatMessage[]; cursor: string | null; chatId: string | null }> {
  const connector = new YouTubeChatConnector();
  const cached = youtubeBroadcastCache.get(account.id);
  const broadcast = cached && Date.now() - cached.checkedAt < (cached.broadcast ? 30_000 : 10_000)
    ? cached.broadcast : await connector.findActiveBroadcast(token);
  if (!cached || broadcast !== cached.broadcast) youtubeBroadcastCache.set(account.id, { checkedAt: Date.now(), broadcast });
  if (!broadcast) {
    youtubeSessions.get(account.id)?.close();
    youtubeSessions.delete(account.id);
    return { live: false, messages: [], cursor: null, chatId: null };
  }
  const state = await options.botRepository.getChatState("YOUTUBE", account.id, broadcast.chatId);
  let stream = youtubeSessions.get(account.id);
  if (stream?.chatId !== broadcast.chatId) {
    stream?.close();
    stream = new YouTubeLiveChatStream(broadcast.chatId, state?.cursor ?? null);
    youtubeSessions.set(account.id, stream);
  }
  if (await stream.ensure(token)) {
    const page = stream.drain();
    return { live: true, messages: page.messages, cursor: page.nextCursor, chatId: broadcast.chatId };
  }
  if (Date.now() < (youtubePollAfter.get(account.id) ?? 0))
    return { live: true, messages: [], cursor: state?.cursor ?? null, chatId: broadcast.chatId };
  const page = await connector.listChatMessages(token, broadcast.chatId, state?.cursor ?? null);
  youtubePollAfter.set(account.id, Date.now() + Math.max(1_000, page.pollingIntervalMillis ?? 5_000));
  return { live: true, messages: page.messages, cursor: page.nextCursor, chatId: broadcast.chatId };
}

async function fetchTwitch(
  context: PollContext & StreamingBotRuntimeOptions,
  options: StreamingBotRuntimeOptions,
  account: StreamingPlatformAccountRecord,
  token: Awaited<ReturnType<StreamingTokenManager["getToken"]>>
): Promise<{ live: boolean; messages: StreamingChatMessage[]; cursor: string | null; chatId: string | null }> {
  const client = await options.credentialStore.readClient("TWITCH");
  const connector = new TwitchChatConnector({ clientId: client.clientId });
  const live = await connector.isStreamLive(token, account.externalAccountId);
  if (!live) {
    twitchSessions.get(account.id)?.close();
    twitchSessions.delete(account.id);
    return { live: false, messages: [], cursor: null, chatId: null };
  }
  let session = twitchSessions.get(account.id);
  if (!session) {
    session = new TwitchEventSubChat(client.clientId, account.externalAccountId);
    twitchSessions.set(account.id, session);
  }
  await session.ensure(token);
  return { live: true, messages: session.drain(), cursor: null, chatId: account.externalAccountId };
}

async function fetchLiveMetrics(options: StreamingBotRuntimeOptions): Promise<string> {
  if (!options.internalApiToken) return "";
  try {
    const response = await fetch(`${options.internalApiBaseUrl.replace(/\/$/, "")}/api/internal/streaming/bot/live-metrics`, {
      headers: { "x-space-internal-token": options.internalApiToken },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return "";
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("metrics" in payload)) return "";
    const metrics = (payload as { metrics: unknown }).metrics;
    return typeof metrics === "string" ? metrics.slice(0, 5_000) : "";
  } catch {
    // Keep chat available when metric collection is temporarily unavailable.
    return "";
  }
}

async function summarizeMemory(memoryStore: BotMemoryStore): Promise<string> {
  const entries = await memoryStore.listMemory(10);
  if (!entries.length) return "";
  return entries.map((entry) => `- ${entry.title}: ${entry.body.slice(0, 200)}`).join("\n");
}

async function appendActivity(
  options: StreamingBotRuntimeOptions,
  platform: StreamingBotPlatform,
  input: { direction: "IN" | "OUT"; accountId?: string | null; channelId?: string | null; authorId?: string | null; messageId?: string | null; protectedAccount?: boolean;
    author: string | null; message: string; reply: string | null; status: "REPLIED" | "SKIPPED" | "ERROR" | "TEST" }
): Promise<void> {
  await options.botRepository.appendActivity({
    id: `activity:${randomUUID()}`,
    platform,
    accountId: input.accountId ?? null,
    channelId: input.channelId ?? null,
    authorId: input.authorId ?? null,
    messageId: input.messageId ?? null,
    protectedAccount: input.protectedAccount ?? false,
    direction: input.direction,
    author: input.author,
    message: input.message,
    reply: input.reply,
    status: input.status,
    createdAt: (options.now ?? (() => new Date()))().toISOString()
  });
}

export function createSpaceBotMemoryStore(repository: StreamingBotRepository): BotMemoryStore {
  return {
    async ensureBotRoom(): Promise<void> {},
    async saveMemory(input) {
      const record = await repository.saveMemory({ title: input.title, body: input.body, source: "BOT" });
      return { id: record.id, title: record.title, body: record.body, createdAt: record.createdAt };
    },
    async searchMemory(query, limit = 10) {
      const entries = await repository.listMemory("APPROVED", limit, query);
      return entries.map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt }));
    },
    async listMemory(limit = 10) {
      const entries = await repository.listMemory("APPROVED", limit);
      return entries.map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt }));
    },
    async countMemory() {
      return repository.countMemory("APPROVED");
    },
    async clearMemory() {
      return repository.clearMemoryRecords();
    }
  };
}
