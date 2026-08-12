import {
  BOT_MEMORY_ROOM_ID,
  getStreamingBotLlmConfig,
  runBotTurn,
  type BotMemoryStore,
  type BotPromptContext,
  type BotTurnMessage,
  type BotTurnTools
} from "@space/streaming";
import {
  StreamingBotSettingsVersionConflictError,
  type StreamingBotRepository,
  type StreamingRepository
} from "@space/db";
import {
  defaultStreamingBotSettings,
  streamingBotMcpExecuteResponseSchema,
  type StreamingBotActivity,
  type StreamingBotMcpExecuteResponse,
  type StreamingBotPlatform,
  type StreamingBotSettings,
  type StreamingBotStatus,
  type StreamingBotTestInput,
  type UpdateStreamingBotSettingsInput
} from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

export class StreamingBotServiceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
    this.name = "StreamingBotServiceError";
  }
}

export interface StreamingBotServiceOptions {
  botRepository: StreamingBotRepository;
  streamingRepository: StreamingRepository;
  store: SpaceStore;
  youtubeDailyBudget: number;
}

export class StreamingBotService {
  constructor(private readonly options: StreamingBotServiceOptions) {}

  private get memoryStore(): BotMemoryStore {
    return createApiBotMemoryStore(this.options.store);
  }

  async getSettings(): Promise<{ settings: StreamingBotSettings; memoryCount: number }> {
    const settings = await this.options.botRepository.getSettings();
    const memoryCount = await this.memoryStore.countMemory();
    return { settings, memoryCount };
  }

  async updateSettings(input: UpdateStreamingBotSettingsInput, updatedBy: string): Promise<StreamingBotSettings> {
    try {
      return await this.options.botRepository.updateSettings({
        expectedVersion: input.expectedVersion,
        settings: input,
        updatedBy,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof StreamingBotSettingsVersionConflictError) {
        throw new StreamingBotServiceError("SETTINGS_VERSION_CONFLICT", error.message, 409);
      }
      throw error;
    }
  }

  async setPaused(paused: boolean, updatedBy: string): Promise<StreamingBotSettings> {
    const current = await this.options.botRepository.getSettings();
    if (current.enabled === !paused) return current;
    return this.updateSettings({
      expectedVersion: current.version,
      enabled: !paused,
      persona: current.persona,
      platforms: current.platforms,
      facts: current.facts,
      faq: current.faq,
      instructions: current.instructions,
      guardrails: current.guardrails,
      memoryEnabled: current.memoryEnabled,
      overlayTickerEnabled: current.overlayTickerEnabled
    }, updatedBy);
  }

  async getStatus(): Promise<StreamingBotStatus> {
    const [settings, quota, chatStates, accounts, authorizations] = await Promise.all([
      this.options.botRepository.getSettings(),
      this.options.botRepository.getQuota("YOUTUBE", new Date().toISOString().slice(0, 10)),
      this.options.botRepository.listChatStates(),
      this.options.streamingRepository.listAccounts(),
      this.options.streamingRepository.listAuthorizations()
    ]);
    const llmConfig = getStreamingBotLlmConfig();
    const connectedAccounts = new Set(
      accounts
        .filter((account) => authorizations.some((authorization) =>
          authorization.id === account.authorizationId && authorization.status === "ACTIVE"
        ))
        .map((account) => account.id)
    );
    const stateFor = (platform: StreamingBotPlatform, accountId: string | null) => {
      if (!accountId || !connectedAccounts.has(accountId)) return null;
      return chatStates.find((state) => state.platform === platform && state.accountId === accountId) ?? null;
    };
    const platformStatus = (platform: StreamingBotPlatform, accountId: string | null) => {
      const state = stateFor(platform, accountId);
      return {
        connected: Boolean(accountId && connectedAccounts.has(accountId)),
        live: Boolean(state),
        chatId: state?.chatId ?? null,
        lastPollAt: state?.lastPolledAt ?? null,
        lastReplyAt: state?.lastReplyAt ?? null,
        pendingCount: state?.pendingCount ?? 0
      };
    };
    return {
      enabled: settings.enabled,
      paused: !settings.enabled,
      llmConfigured: Boolean(llmConfig.enabled && llmConfig.baseUrl && llmConfig.keyFile && llmConfig.keyName && llmConfig.model),
      model: llmConfig.model,
      youtubeQuota: {
        day: quota.day,
        unitsConsumed: quota.unitsConsumed,
        budget: this.options.youtubeDailyBudget
      },
      platforms: {
        YOUTUBE: platformStatus("YOUTUBE", settings.platforms.YOUTUBE.accountId),
        TWITCH: platformStatus("TWITCH", settings.platforms.TWITCH.accountId)
      }
    };
  }

  async listActivity(limit: number): Promise<StreamingBotActivity[]> {
    const records = await this.options.botRepository.listActivity(Math.max(1, Math.min(limit, 200)));
    return records.map((record) => ({
      id: record.id,
      platform: record.platform,
      direction: record.direction,
      author: record.author,
      message: record.message,
      reply: record.reply,
      status: record.status,
      createdAt: record.createdAt
    }));
  }

  async test(input: StreamingBotTestInput): Promise<{ reply: string | null; errorCode: string | null; model: string | null }> {
    const settings = await this.options.botRepository.getSettings();
    const memorySummary = settings.memoryEnabled ? await summarizeApiMemory(this.memoryStore) : "";
    const contextPrompt: BotPromptContext = {
      settings,
      memorySummary,
      recentExchange: `Viewer: ${input.message}`
    };
    const turnMessages: BotTurnMessage[] = [{
      id: `test:${input.platform.toLowerCase()}:${Date.now()}`,
      author: "Viewer",
      message: input.message,
      platform: input.platform
    }];
    let capturedReply: string | null = null;
    const tools: BotTurnTools = {
      sendReply: async ({ message }) => {
        capturedReply = message;
        return { ok: true };
      },
      memorySave: async () => ({ ok: true }),
      memorySearch: async () => ({ ok: true, entries: [] }),
      mcpCall: async () => ({ ok: false, observation: "", error: "TEST_MODE" }),
      skillRead: async () => ({ ok: false, content: "", error: "TEST_MODE" })
    };
    const turn = await runBotTurn({ context: contextPrompt, messages: turnMessages, tools });
    if (turn.errorCode) {
      return { reply: null, errorCode: turn.errorCode, model: turn.model };
    }
    return { reply: capturedReply, errorCode: null, model: turn.model };
  }

  async clearMemory(): Promise<{ removed: number }> {
    const removed = await this.options.botRepository.clearBotMemory(BOT_MEMORY_ROOM_ID);
    await this.memoryStore.clearMemory();
    return { removed };
  }

  async searchMemory(query: string, limit: number): Promise<{ entries: Array<{ id: string; title: string; body: string; createdAt: string }> }> {
    const entries = await this.memoryStore.searchMemory(query, Math.max(1, Math.min(limit, 50)));
    return { entries };
  }

  async botTicker(): Promise<{ enabled: boolean; ticker: Array<{ author: string | null; message: string; reply: string | null; createdAt: string }> }> {
    const settings = await this.options.botRepository.getSettings();
    if (!settings.enabled || !settings.overlayTickerEnabled) {
      return { enabled: false, ticker: [] };
    }
    const activity = await this.options.botRepository.listActivity(6);
    const ticker = activity
      .filter((record) => record.status === "REPLIED" && record.reply)
      .slice(0, 6)
      .map((record) => ({
        author: record.author,
        message: record.message,
        reply: record.reply,
        createdAt: record.createdAt
      }));
    return { enabled: true, ticker };
  }
}

function createApiBotMemoryStore(store: SpaceStore): BotMemoryStore {
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
        }, "trace:streaming-bot-api");
      }
    },
    async saveMemory(input) {
      await this.ensureBotRoom();
      const result = await store.createMemoryEntry({
        scope: "ROOM",
        roomId: BOT_MEMORY_ROOM_ID,
        title: input.title,
        body: input.body,
        provenance: "streaming-bot",
        tags: input.tags
      }, "trace:streaming-bot-api");
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

async function summarizeApiMemory(memoryStore: BotMemoryStore): Promise<string> {
  const entries = await memoryStore.listMemory(10);
  if (!entries.length) return "";
  return entries.map((entry) => `- ${entry.title}: ${entry.body.slice(0, 200)}`).join("\n");
}

export function toMcpExecuteResponse(input: {
  status: "EXECUTED" | "BLOCKED" | "FAILED";
  code: string;
  message: string;
  serverId: string | null;
  toolName: string | null;
  observation: unknown;
}): StreamingBotMcpExecuteResponse {
  return streamingBotMcpExecuteResponseSchema.parse(input);
}

export { defaultStreamingBotSettings };