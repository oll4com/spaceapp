import { randomUUID } from "node:crypto";
import {
  BOT_MEMORY_PROVENANCE,
  BOT_MEMORY_ROOM_ID,
  ReplyRateLimiter,
  StreamingCredentialStore,
  StreamingTokenManager,
  TwitchChatConnector,
  YouTubeChatConnector,
  canReply,
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

interface PlatformAuth {
  credentialRef: string;
  provider: StreamingBotPlatform;
}

export async function runStreamingBotCycle(options: StreamingBotRuntimeOptions): Promise<StreamingBotCycleResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const settings = await options.botRepository.getSettings();
  if (!settings.enabled) {
    return { cycles: 1, polled: [], replies: 0, skipped: 0, errors: 0 };
  }

  const result: StreamingBotCycleResult = { cycles: 1, polled: [], replies: 0, skipped: 0, errors: 0 };
  const limiter = new ReplyRateLimiter(settings.guardrails.maxRepliesPerMinute);
  const day = now().toISOString().slice(0, 10);
  const youtubeQuota = await options.botRepository.getQuota("YOUTUBE", day);
  const tokenManager = new StreamingTokenManager({ credentialStore: options.credentialStore });

  const [accounts, authorizations] = await Promise.all([
    options.streamingRepository.listAccounts(),
    options.streamingRepository.listAuthorizations()
  ]);
  const authByAccount = new Map<string, PlatformAuth>();
  for (const account of accounts) {
    const authorization = authorizations.find((candidate) => candidate.id === account.authorizationId);
    if (!authorization || authorization.status !== "ACTIVE") continue;
    authByAccount.set(account.id, { credentialRef: authorization.credentialRef, provider: account.provider as StreamingBotPlatform });
  }

  for (const platform of ["YOUTUBE", "TWITCH"] as const) {
    const platformSettings = settings.platforms[platform];
    if (!platformSettings.enabled || !platformSettings.accountId) continue;
    const account = accounts.find((candidate) => candidate.id === platformSettings.accountId);
    const auth = account ? authByAccount.get(account.id) : undefined;
    if (!account || !auth || auth.provider !== platform) continue;
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
        lastReplyAt: null,
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

  const candidates = fetchResult.messages.filter((message) =>
    message.author.toLowerCase() !== settings.persona.name.toLowerCase()
  ).slice(0, 20);

  const memorySummary = settings.memoryEnabled ? await summarizeMemory(options.memoryStore) : "";
  const contextPrompt: BotPromptContext = {
    settings,
    memorySummary,
    recentExchange: candidates.map((message) => `${message.author}: ${message.message}`).join("\n")
  };
  const turnMessages: BotTurnMessage[] = candidates.map((message) => ({
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
          author: settings.persona.name,
          message: capped,
          reply: null,
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
    },
    mcpCall: async ({ toolId, arguments: toolArguments }) => {
      if (!options.internalApiToken || !options.mcpToolBridgeEnabled) {
        return { ok: false, observation: "", error: "MCP_BRIDGE_DISABLED" };
      }
      try {
        const response = await fetch(`${options.internalApiBaseUrl.replace(/\/+$/, "")}/api/internal/streaming/bot/mcp-execute`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-space-internal-token": options.internalApiToken },
          body: JSON.stringify({ toolId, arguments: toolArguments })
        });
        if (!response.ok) return { ok: false, observation: "", error: `MCP_HTTP_${response.status}` };
        const body = await response.json() as { status: string; code: string; message: string; serverId: string | null; toolName: string | null; observation: unknown };
        if (body.status !== "EXECUTED") return { ok: false, observation: "", error: body.code };
        return { ok: true, observation: JSON.stringify(body.observation ?? {}) };
      } catch {
        return { ok: false, observation: "", error: "MCP_UNAVAILABLE" };
      }
    },
    skillRead: async ({ name }) => {
      if (!options.internalApiToken) return { ok: false, content: "", error: "MCP_BRIDGE_DISABLED" };
      try {
        const response = await fetch(`${options.internalApiBaseUrl.replace(/\/+$/, "")}/api/internal/streaming/bot/skills/${encodeURIComponent(name)}`, {
          headers: { "x-space-internal-token": options.internalApiToken }
        });
        if (!response.ok) return { ok: false, content: "", error: `SKILL_HTTP_${response.status}` };
        const body = await response.json() as { content: string };
        return { ok: true, content: body.content.slice(0, 4000) };
      } catch {
        return { ok: false, content: "", error: "SKILL_UNAVAILABLE" };
      }
    }
  };

  const turn = await runBotTurn({ context: contextPrompt, messages: turnMessages, tools }, { now: options.now });
  if (turn.errorCode) {
    options.log?.({ status: "TURN_ERROR", platform, errorCode: turn.errorCode });
  }

  for (const message of candidates) {
    const status = turn.replies.length ? "REPLIED" : "SKIPPED";
    await appendActivity(options, platform, {
      direction: "IN",
      author: message.author,
      message: message.message.slice(0, 2000),
      reply: null,
      status
    });
  }
  for (const save of turn.memorySaves) {
    await options.memoryStore.saveMemory(save);
  }

  return {
    polled: { platform, live: fetchResult.live, newMessages: candidates.length },
    replies,
    skipped,
    errors
  };
}

async function fetchYouTube(
  context: PollContext & StreamingBotRuntimeOptions,
  options: StreamingBotRuntimeOptions,
  account: StreamingPlatformAccountRecord,
  token: Awaited<ReturnType<StreamingTokenManager["getToken"]>>
): Promise<{ live: boolean; messages: StreamingChatMessage[]; cursor: string | null; chatId: string | null }> {
  const connector = new YouTubeChatConnector();
  const broadcast = await connector.findActiveBroadcast(token);
  if (!broadcast) return { live: false, messages: [], cursor: null, chatId: null };
  const state = await options.botRepository.getChatState("YOUTUBE", account.id, broadcast.chatId);
  const page = await connector.listChatMessages(token, broadcast.chatId, state?.cursor ?? null);
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
  if (!live) return { live: false, messages: [], cursor: null, chatId: null };
  const state = await options.botRepository.getChatState("TWITCH", account.id, account.externalAccountId);
  const page = await connector.listChatMessages(token, account.externalAccountId, account.externalAccountId, state?.cursor ?? null);
  return { live: true, messages: page.messages, cursor: page.nextCursor, chatId: account.externalAccountId };
}

async function summarizeMemory(memoryStore: BotMemoryStore): Promise<string> {
  const entries = await memoryStore.listMemory(10);
  if (!entries.length) return "";
  return entries.map((entry) => `- ${entry.title}: ${entry.body.slice(0, 200)}`).join("\n");
}

async function appendActivity(
  options: StreamingBotRuntimeOptions,
  platform: StreamingBotPlatform,
  input: { direction: "IN" | "OUT"; author: string | null; message: string; reply: string | null; status: "REPLIED" | "SKIPPED" | "ERROR" | "TEST" }
): Promise<void> {
  await options.botRepository.appendActivity({
    id: `activity:${randomUUID()}`,
    platform,
    direction: input.direction,
    author: input.author,
    message: input.message,
    reply: input.reply,
    status: input.status,
    createdAt: (options.now ?? (() => new Date()))().toISOString()
  });
}

export function createSpaceBotMemoryStore(store: SpaceStore): BotMemoryStore {
  return {
    async ensureBotRoom(): Promise<void> {
      try {
        await store.getRoom(BOT_MEMORY_ROOM_ID);
      } catch {
        await store.createRoom({
          name: "Streaming bot memory",
          description: "Separate memory namespace for the streaming chat bot.",
          initialPaneCount: 0,
          reason: "streaming-bot"
        }, `trace:${randomUUID()}`);
      }
    },
    async saveMemory(input) {
      await this.ensureBotRoom();
      const result = await store.createMemoryEntry({
        scope: "ROOM",
        roomId: BOT_MEMORY_ROOM_ID,
        title: input.title,
        body: input.body,
        provenance: BOT_MEMORY_PROVENANCE,
        tags: input.tags
      }, `trace:${randomUUID()}`);
      return { id: result.entry.id, title: result.entry.title, body: result.entry.body, createdAt: result.entry.createdAt };
    },
    async searchMemory(query, limit = 10) {
      const entries = await store.listMemoryEntries({
        scope: "ROOM",
        roomId: BOT_MEMORY_ROOM_ID,
        q: query,
        searchMode: "keyword",
        sortOrder: "desc",
        page: 1,
        pageSize: Math.min(limit, 50)
      });
      return entries.map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt }));
    },
    async listMemory(limit = 10) {
      const entries = await store.listMemoryEntries({
        scope: "ROOM",
        roomId: BOT_MEMORY_ROOM_ID,
        sortOrder: "desc",
        page: 1,
        pageSize: Math.min(limit, 50)
      });
      return entries.map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt }));
    },
    async countMemory() {
      const entries = await store.listMemoryEntries({
        scope: "ROOM",
        roomId: BOT_MEMORY_ROOM_ID,
        sortOrder: "desc",
        page: 1,
        pageSize: 1
      });
      return entries.length;
    },
    async clearMemory() {
      return 0;
    }
  };
}