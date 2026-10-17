import { randomUUID } from "node:crypto";
import {
  getStreamingBotLlmConfig,
  publicSpaceappContext,
  asksForOperatorPrivateData,
  containsSensitiveDisclosure,
  truncateReply,
  dedicatedCredentialReady,
  resolveStreamingBotModel,
  streamingBotModelOptions,
  StreamingCredentialStore,
  StreamingProviderError,
  StreamingTokenManager,
  TwitchChatConnector,
  YouTubeChatConnector,
  runBotTurn,
  type BotMemoryStore,
  type BotPromptContext,
  type BotTurnMessage,
  type BotTurnTools
} from "@space/streaming";
import {
  StreamingBotSettingsVersionConflictError,
  type StreamingBotMemoryRecord,
  type StreamingBotRepository,
  type StreamingModerationActionRecord,
  type StreamingRepository
} from "@space/db";
import {
  defaultStreamingBotSettings,
  instanceBackgroundJobEnabled,
  streamingBotMcpExecuteResponseSchema,
  type StreamingBotActivity,
  type StreamingBotMcpExecuteResponse,
  type StreamingBotPlatform,
  type StreamingBotSettings,
  type StreamingBotStatus,
  type StreamingBotTestInput,
  type CreateStreamingBotMemoryInput,
  type UpdateStreamingBotMemoryInput,
  type UpdateStreamingBotSettingsInput
} from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { StreamingServiceError } from "./streaming-service.js";

/** A StreamingServiceError, so the composition root's error handler keeps its code and status on every bot route. */
export class StreamingBotServiceError extends StreamingServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "StreamingBotServiceError";
  }
}

/** A platform refusal becomes a 502 with the platform's code instead of an INTERNAL_ERROR. */
async function platformCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof StreamingProviderError) throw new StreamingBotServiceError(error.code, "The streaming platform rejected the request.", 502);
    throw error;
  }
}

export interface StreamingBotServiceOptions {
  botRepository: StreamingBotRepository;
  streamingRepository: StreamingRepository;
  store: SpaceStore;
  youtubeDailyBudget: number;
  credentialStore?: StreamingCredentialStore;
  liveMetrics?: () => Promise<string>;
}

export class StreamingBotService {
  constructor(private readonly options: StreamingBotServiceOptions) {}

  private get memoryStore(): BotMemoryStore {
    return createApiBotMemoryStore(this.options.botRepository);
  }

  async getSettings(): Promise<{ settings: StreamingBotSettings; memoryCount: number }> {
    const settings = await this.options.botRepository.getSettings();
    const memoryCount = await this.memoryStore.countMemory();
    return { settings, memoryCount };
  }

  async modelOptions() {
    return streamingBotModelOptions(getStreamingBotLlmConfig());
  }

  async updateSettings(input: UpdateStreamingBotSettingsInput, updatedBy: string): Promise<StreamingBotSettings> {
    const publicPolicyText = [input.persona.name, input.persona.tone, input.instructions,
      ...input.facts.flatMap(item => [item.key, item.value]),
      ...input.faq.flatMap(item => [item.question, item.answer])].join("\n");
    if (containsSensitiveDisclosure(publicPolicyText)) {
      throw new StreamingBotServiceError("PRIVATE_SETTINGS_BLOCKED", "Streaming bot settings must contain only public, non-personal information.", 400);
    }
    const config = getStreamingBotLlmConfig();
    if (input.enabled) {
      const selection = resolveStreamingBotModel(input.modelSelection, config);
      if (!selection.modelId) throw new StreamingBotServiceError("MODEL_UNAVAILABLE", "The bot's Space Gateway key and a selected model are required before replies can be enabled.", 409);
    }
    for (const selection of [input.modelSelection, input.fallbackModelSelection]) {
      if (selection && resolveStreamingBotModel(selection, config).errorCode === "MODEL_NOT_IN_CATALOG") {
        throw new StreamingBotServiceError("MODEL_NOT_IN_CATALOG", "Choose one of the bot's models.", 400);
      }
    }
    return this.saveSettings(input, updatedBy);
  }

  private async saveSettings(input: UpdateStreamingBotSettingsInput, updatedBy: string): Promise<StreamingBotSettings> {
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
    // Pausing must always work, even when the selected model has since left the catalog; resuming is validated.
    return (paused ? this.saveSettings.bind(this) : this.updateSettings.bind(this))({
      expectedVersion: current.version,
      enabled: !paused,
      persona: current.persona,
      platforms: current.platforms,
      facts: current.facts,
      faq: current.faq,
      instructions: current.instructions,
      guardrails: current.guardrails,
      modelSelection: current.modelSelection,
      fallbackModelSelection: current.fallbackModelSelection,
      memoryEnabled: current.memoryEnabled,
      moderationEnabled: current.moderationEnabled,
      jevEnabled: current.jevEnabled,
      overlayTickerEnabled: current.overlayTickerEnabled
    }, updatedBy);
  }

  async getStatus(): Promise<StreamingBotStatus> {
    const [settings, quota, chatStates, accounts, authorizations, memoryPending] = await Promise.all([
      this.options.botRepository.getSettings(),
      this.options.botRepository.getQuota("YOUTUBE", new Date().toISOString().slice(0, 10)),
      this.options.botRepository.listChatStates(),
      this.options.streamingRepository.listAccounts(),
      this.options.streamingRepository.listAuthorizations(),
      this.options.botRepository.countMemory("PENDING")
    ]);
    const llmConfig = getStreamingBotLlmConfig();
    const selectedModel = resolveStreamingBotModel(settings.modelSelection, llmConfig);
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
        live: Boolean(state?.lastPolledAt && Date.now() - Date.parse(state.lastPolledAt) < 30_000),
        chatId: state?.chatId ?? null,
        lastPollAt: state?.lastPolledAt ?? null,
        lastReplyAt: state?.lastReplyAt ?? null,
        pendingCount: state?.pendingCount ?? 0
      };
    };
    return {
      enabled: settings.enabled,
      paused: !settings.enabled,
      llmConfigured: selectedModel.errorCode === null,
      model: selectedModel.modelId,
      youtubeQuota: {
        day: quota.day,
        unitsConsumed: quota.unitsConsumed,
        budget: this.options.youtubeDailyBudget
      },
      platforms: {
        YOUTUBE: platformStatus("YOUTUBE", settings.platforms.YOUTUBE.accountId),
        TWITCH: platformStatus("TWITCH", settings.platforms.TWITCH.accountId)
      },
      moderationEnabled: settings.moderationEnabled,
      memoryPending,
      setup: await this.setupChecklist(settings, accounts, authorizations, selectedModel.errorCode)
    };
  }

  private async setupChecklist(
    settings: StreamingBotSettings,
    accounts: Awaited<ReturnType<StreamingRepository["listAccounts"]>>,
    authorizations: Awaited<ReturnType<StreamingRepository["listAuthorizations"]>>,
    modelErrorCode: string | null
  ): Promise<StreamingBotStatus["setup"]> {
    const llmConfig = getStreamingBotLlmConfig();
    const keyReady = dedicatedCredentialReady(llmConfig);
    const items: StreamingBotStatus["setup"] = [
      { id: "llm-key", label: "Space Gateway key for the bot", ok: keyReady,
        hint: keyReady ? null : "Set SPACE_STREAMING_BOT_ENABLED, _BASE_URL, _KEY_FILE and _KEY_NAME (space-streaming-*) for the API and worker. See docs/runbooks/streaming-bot.md." },
      { id: "model", label: "Reply model selected", ok: modelErrorCode === null,
        hint: modelErrorCode === null ? null : "Choose an available model under Language model and save." }
    ];
    const chatScopes: Record<StreamingBotPlatform, { read: string; write: string; moderate: string }> = {
      YOUTUBE: { read: "https://www.googleapis.com/auth/youtube.force-ssl", write: "https://www.googleapis.com/auth/youtube.force-ssl", moderate: "https://www.googleapis.com/auth/youtube.force-ssl" },
      TWITCH: { read: "user:read:chat", write: "user:write:chat", moderate: "moderator:manage:banned_users" }
    };
    const used = (["YOUTUBE", "TWITCH"] as const).filter(platform => settings.platforms[platform].enabled || settings.platforms[platform].accountId);
    if (!used.length) items.push({ id: "chat", label: "Chat account", ok: false, hint: "Pick a YouTube or Twitch account under Platforms." });
    for (const platform of used) {
      const name = platform === "YOUTUBE" ? "YouTube" : "Twitch";
      const selected = accounts.find(item => item.id === settings.platforms[platform].accountId);
      const account = selected?.status === "ACTIVE" ? selected : undefined;
      const authorization = authorizations.find(item => item.id === account?.authorizationId && item.status === "ACTIVE");
      const scopes = chatScopes[platform];
      const needed = [scopes.read, ...(settings.platforms[platform].enabled ? [scopes.write] : []), ...(settings.moderationEnabled ? [scopes.moderate] : [])];
      const client = this.options.credentialStore ? await this.options.credentialStore.readiness(platform) : null;
      const hint = !selected ? `Pick a connected ${name} account under Platforms.`
        : !account ? `Reconnect ${name} in Overview. ${selected.safeErrorMessage ?? ""}`.trim().slice(0, 300)
        : !authorization ? `Reconnect ${name} in Overview.`
        : needed.some(scope => !authorization.scopes.includes(scope)) ? `Reconnect ${name} in Overview to grant chat${settings.moderationEnabled ? " and moderation" : ""} permissions.`
        : client && client.status !== "READY" ? `Fix the ${name} client file in Overview: ${client.message}`.slice(0, 300)
        : null;
      items.push({ id: platform.toLowerCase(), label: `${name} chat`, ok: hint === null, hint });
    }
    const workerOn = instanceBackgroundJobEnabled(process.env, "streaming-bot");
    items.push({ id: "worker", label: "Bot worker on this instance", ok: workerOn,
      hint: workerOn ? null : "This instance runs the bot only with SPACE_INSTANCE_ENABLED_JOBS=streaming-bot." });
    return items;
  }

  async listActivity(limit: number): Promise<StreamingBotActivity[]> {
    const records = await this.options.botRepository.listActivity(Math.max(1, Math.min(limit, 200)));
    return records.map((record) => ({
      id: record.id,
      platform: record.platform,
      accountId: record.accountId,
      channelId: record.channelId,
      authorId: record.authorId,
      messageId: record.messageId,
      protectedAccount: record.protectedAccount,
      direction: record.direction,
      author: record.author,
      message: record.message,
      reply: record.reply,
      status: record.status,
      createdAt: record.createdAt
    }));
  }

  async listModerationActions(limit: number): Promise<Array<StreamingModerationActionRecord & { author: string | null; message: string | null; activityId: string | null }>> {
    const [actions, activity] = await Promise.all([
      this.options.botRepository.listModerationActions(limit),
      this.options.botRepository.listActivity(500)
    ]);
    // shortcut: names and text come from retained activity (the newest 500 rows); older actions show the viewer id.
    const incoming = new Map(activity.filter(item => item.direction === "IN" && item.messageId).map(item => [`${item.platform}\u0000${item.messageId}`, item]));
    return actions.map(action => {
      const source = incoming.get(`${action.platform}\u0000${action.messageId}`);
      return { ...action, author: source?.author ?? null, message: source?.message ?? null, activityId: source?.id ?? null };
    });
  }

  private async actionAccount(platform: "YOUTUBE" | "TWITCH", permission: string) {
    const settings = await this.options.botRepository.getSettings();
    const accountId = settings.platforms[platform].accountId;
    const [accounts, authorizations] = await Promise.all([
      this.options.streamingRepository.listAccounts(), this.options.streamingRepository.listAuthorizations()
    ]);
    const account = accounts.find(item => item.id === accountId && item.provider === platform && item.status === "ACTIVE");
    const authorization = authorizations.find(item => item.id === account?.authorizationId && item.status === "ACTIVE");
    if (!account || !authorization) throw new StreamingBotServiceError("ACCOUNT_UNAVAILABLE", "The selected connected account is unavailable.", 409);
    if (!authorization.scopes.includes(permission)) throw new StreamingBotServiceError("MISSING_PERMISSION", "The connected account lacks the required permission.", 409);
    if (!this.options.credentialStore) throw new StreamingBotServiceError("CREDENTIALS_UNAVAILABLE", "Streaming credentials are unavailable.", 503);
    const token = await new StreamingTokenManager({ credentialStore: this.options.credentialStore }).getToken(platform, authorization.credentialRef);
    const client = platform === "TWITCH" ? await this.options.credentialStore.readClient("TWITCH") : null;
    return { settings, account, token, client };
  }

  async sendOperatorReply(platform: "YOUTUBE" | "TWITCH", message: string) {
    const reply = truncateReply(message.trim(), platform);
    if (!reply || containsSensitiveDisclosure(reply)) throw new StreamingBotServiceError("SENSITIVE_REPLY_BLOCKED", "The reply is empty or contains private data.", 400);
    const permission = platform === "YOUTUBE" ? "https://www.googleapis.com/auth/youtube.force-ssl" : "user:write:chat";
    const { settings, account, token, client } = await this.actionAccount(platform, permission);
    const states = await this.options.botRepository.listChatStates();
    const state = states.find(item => item.platform === platform && item.accountId === account.id &&
      item.lastPolledAt && Date.now() - Date.parse(item.lastPolledAt) < 30_000);
    if (!state) throw new StreamingBotServiceError("CHAT_NOT_LIVE", "No current live chat was verified.", 409);
    const since = new Date(Date.now() - 60_000).toISOString();
    if (await this.options.botRepository.recentReplyCount(since) >= settings.guardrails.maxRepliesPerMinute) {
      throw new StreamingBotServiceError("RATE_LIMITED", "The configured reply limit has been reached.", 429);
    }
    if (platform === "YOUTUBE") {
      const quota = await this.options.botRepository.getQuota("YOUTUBE", new Date().toISOString().slice(0, 10));
      if (quota.unitsConsumed + 10 > this.options.youtubeDailyBudget) throw new StreamingBotServiceError("QUOTA_LIMIT", "The YouTube reply budget is exhausted.", 429);
    }
    const platformMessageId = await platformCall(() => platform === "YOUTUBE"
      ? new YouTubeChatConnector().sendChatMessage(token, state.chatId, reply)
      : new TwitchChatConnector({ clientId: client!.clientId }).sendChatMessage(token, account.externalAccountId, account.externalAccountId, reply));
    if (platform === "YOUTUBE") await this.options.botRepository.consumeQuota("YOUTUBE", new Date().toISOString().slice(0, 10), 10);
    const activity = await this.options.botRepository.appendActivity({
      id: `activity:${randomUUID()}`, platform, accountId: account.id, channelId: state.chatId,
      messageId: platformMessageId, direction: "OUT", author: settings.persona.name, message: reply,
      status: "REPLIED", createdAt: new Date().toISOString()
    });
    return { ok: true, activityId: activity.id, platformMessageId };
  }

  async timeoutFromActivity(activityId: string, durationSeconds: 300 | 1800) {
    const source = (await this.options.botRepository.listActivity(200)).find(item => item.id === activityId && item.direction === "IN");
    if (!source || !source.accountId || !source.channelId || !source.authorId || !source.messageId ||
      Date.now() - Date.parse(source.createdAt) > 10 * 60_000) {
      throw new StreamingBotServiceError("MESSAGE_UNAVAILABLE", "The recent chat message is unavailable for moderation.", 409);
    }
    if (source.protectedAccount) throw new StreamingBotServiceError("PROTECTED_ACCOUNT", "This account is protected from automated timeouts.", 403);
    const platform = source.platform;
    const permission = platform === "YOUTUBE" ? "https://www.googleapis.com/auth/youtube.force-ssl" : "moderator:manage:banned_users";
    const { account, token, client } = await this.actionAccount(platform, permission);
    if (account.id !== source.accountId || source.authorId === account.externalAccountId) {
      throw new StreamingBotServiceError("ACCOUNT_MISMATCH", "The target does not belong to the selected live account.", 409);
    }
    const action = await this.options.botRepository.recordModerationAction({
      id: `moderation:${randomUUID()}`, platform, accountId: account.id, channelId: source.channelId,
      userId: source.authorId, messageId: source.messageId, decision: durationSeconds === 300 ? "TIMEOUT_5M" : "TIMEOUT_30M",
      reason: "OPERATOR_COMMAND", durationSeconds, result: "PENDING", platformActionId: null, safeErrorCode: null
    });
    if (!action) throw new StreamingBotServiceError("ACTION_ALREADY_EXISTS", "This chat message already has a moderation action.", 409);
    return this.applyTimeout(action, account.externalAccountId, token, client);
  }

  /** The operator's answer to a REVIEW item: time the viewer out with the item's own chat and message ids. */
  async timeoutReviewedAction(id: string, durationSeconds: 300 | 1800): Promise<StreamingModerationActionRecord> {
    const review = await this.options.botRepository.getModerationAction(id);
    if (!review) throw new StreamingBotServiceError("ACTION_NOT_FOUND", "Moderation action was not found.", 404);
    if (review.result !== "REVIEW" || review.platform === "DISCORD") {
      throw new StreamingBotServiceError("ACTION_NOT_IN_REVIEW", "Only an item waiting for review can be timed out here.", 409);
    }
    const permission = review.platform === "YOUTUBE" ? "https://www.googleapis.com/auth/youtube.force-ssl" : "moderator:manage:banned_users";
    const { account, token, client } = await this.actionAccount(review.platform, permission);
    if (account.id !== review.accountId) throw new StreamingBotServiceError("ACCOUNT_MISMATCH", "The item does not belong to the selected live account.", 409);
    const action = await this.options.botRepository.resolveModerationReview(id, durationSeconds === 300 ? "TIMEOUT_5M" : "TIMEOUT_30M", durationSeconds);
    if (!action) throw new StreamingBotServiceError("ACTION_NOT_IN_REVIEW", "Only an item waiting for review can be timed out here.", 409);
    return this.applyTimeout(action, account.externalAccountId, token, client);
  }

  private async applyTimeout(action: StreamingModerationActionRecord, broadcasterId: string,
    token: Awaited<ReturnType<StreamingTokenManager["getToken"]>>, client: { clientId: string } | null): Promise<StreamingModerationActionRecord> {
    const durationSeconds = action.durationSeconds === 300 ? 300 : 1800;
    try {
      let platformActionId: string | null = null;
      if (action.platform === "YOUTUBE") {
        const connector = new YouTubeChatConnector();
        platformActionId = await connector.timeoutUser(token, action.channelId, action.userId, durationSeconds);
        await connector.deleteChatMessage(token, action.messageId).catch(() => undefined);
      } else {
        await new TwitchChatConnector({ clientId: client!.clientId }).timeoutUser(token, broadcasterId,
          broadcasterId, action.userId, durationSeconds, "Operator command");
      }
      return (await this.options.botRepository.updateModerationAction(action.id, "SUCCEEDED", platformActionId))!;
    } catch (error) {
      await this.options.botRepository.updateModerationAction(action.id, "FAILED", null, error instanceof StreamingProviderError ? error.code.slice(0, 100) : "PLATFORM_ERROR");
      throw new StreamingBotServiceError("TIMEOUT_FAILED", "The platform did not confirm the timeout.", 502);
    }
  }

  async undoModerationAction(id: string): Promise<StreamingModerationActionRecord> {
    const action = await this.options.botRepository.getModerationAction(id);
    if (!action) throw new StreamingBotServiceError("ACTION_NOT_FOUND", "Moderation action was not found.", 404);
    if (action.result !== "SUCCEEDED" || action.durationSeconds === null) {
      throw new StreamingBotServiceError("ACTION_NOT_ACTIVE", "Only a successful timeout can be undone.", 409);
    }
    const credentials = this.options.credentialStore;
    if (!credentials) throw new StreamingBotServiceError("MODERATION_UNAVAILABLE", "Streaming credentials are unavailable.", 503);
    const [accounts, authorizations] = await Promise.all([this.options.streamingRepository.listAccounts(), this.options.streamingRepository.listAuthorizations()]);
    const account = accounts.find(item => item.id === action.accountId && item.provider === action.platform && item.status === "ACTIVE");
    const authorization = authorizations.find(item => item.id === account?.authorizationId && item.status === "ACTIVE");
    if (!account || !authorization) throw new StreamingBotServiceError("ACCOUNT_UNAVAILABLE", "The connected account is unavailable.", 409);
    const requiredScope = action.platform === "YOUTUBE" ? "https://www.googleapis.com/auth/youtube.force-ssl" : "moderator:manage:banned_users";
    if (!authorization.scopes.includes(requiredScope)) throw new StreamingBotServiceError("MISSING_PERMISSION", "The timeout permission is missing.", 409);
    if (action.platform === "DISCORD") throw new StreamingBotServiceError("MODERATION_UNAVAILABLE", "Discord moderation is pending channel setup.", 409);
    if (action.platform === "YOUTUBE" && !action.platformActionId) throw new StreamingBotServiceError("ACTION_ID_MISSING", "The YouTube timeout id is unavailable.", 409);
    await platformCall(async () => {
      const token = await new StreamingTokenManager({ credentialStore: credentials }).getToken(action.platform as "YOUTUBE" | "TWITCH", authorization.credentialRef);
      if (action.platform === "YOUTUBE") {
        await new YouTubeChatConnector().undoTimeout(token, action.platformActionId!);
      } else {
        const client = await credentials.readClient("TWITCH");
        await new TwitchChatConnector({ clientId: client.clientId }).undoTimeout(token, account.externalAccountId, account.externalAccountId, action.userId);
      }
    });
    return (await this.options.botRepository.updateModerationAction(id, "UNDONE", action.platformActionId))!;
  }

  async test(input: StreamingBotTestInput): Promise<{ reply: string | null; errorCode: string | null; model: string | null }> {
    const settings = await this.options.botRepository.getSettings();
    const selectedModel = resolveStreamingBotModel(settings.modelSelection, getStreamingBotLlmConfig());
    if (selectedModel.errorCode || !selectedModel.modelId) return { reply: null, errorCode: selectedModel.errorCode, model: null };
    const memorySummary = settings.memoryEnabled ? await summarizeApiMemory(this.memoryStore) : "";
    const contextPrompt: BotPromptContext = {
      settings,
      memorySummary,
      publicKnowledge: publicSpaceappContext(input.message),
      liveMetrics: await this.options.liveMetrics?.().catch(() => "") ?? "",
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
      memorySearch: async () => ({ ok: true, entries: [] })
    };
    let turn = await runBotTurn({ context: contextPrompt, messages: turnMessages, tools }, { modelId: selectedModel.modelId, route: selectedModel.route });
    if (turn.errorCode && settings.fallbackModelSelection) {
      const fallback = resolveStreamingBotModel(settings.fallbackModelSelection, getStreamingBotLlmConfig());
      if (fallback.modelId && fallback.modelId !== selectedModel.modelId) {
        turn = await runBotTurn({ context: contextPrompt, messages: turnMessages, tools }, { modelId: fallback.modelId, route: fallback.route });
      }
    }
    if (turn.errorCode) {
      return { reply: null, errorCode: turn.errorCode, model: turn.model };
    }
    return { reply: capturedReply, errorCode: null, model: turn.model };
  }

  async clearMemory(): Promise<{ removed: number }> {
    const removed = await this.memoryStore.clearMemory();
    return { removed };
  }

  async searchMemory(query: string, limit: number): Promise<{ entries: Array<{ id: string; title: string; body: string; createdAt: string }> }> {
    const entries = await this.memoryStore.searchMemory(query, Math.max(1, Math.min(limit, 50)));
    return { entries };
  }

  async listReviewedMemory(status: "PENDING" | "APPROVED", limit: number, query = ""): Promise<StreamingBotMemoryRecord[]> {
    return this.options.botRepository.listMemory(status, limit, query);
  }

  async createReviewedMemory(input: CreateStreamingBotMemoryInput): Promise<StreamingBotMemoryRecord> {
    if (containsSensitiveDisclosure(`${input.title} ${input.body}`)) throw new StreamingBotServiceError("PRIVATE_MEMORY_BLOCKED", "Streaming memory must contain public, non-personal information.", 400);
    return this.options.botRepository.saveMemory({ ...input, source: "OPERATOR" });
  }

  async updateReviewedMemory(id: string, input: UpdateStreamingBotMemoryInput): Promise<StreamingBotMemoryRecord> {
    const current = await this.options.botRepository.getMemory(id);
    if (!current) throw new StreamingBotServiceError("MEMORY_NOT_FOUND", "Memory was not found.", 404);
    if (containsSensitiveDisclosure(`${input.title ?? current.title} ${input.body ?? current.body}`))
      throw new StreamingBotServiceError("PRIVATE_MEMORY_BLOCKED", "Streaming memory must contain public, non-personal information.", 400);
    const updated = await this.options.botRepository.updateMemory(id, input.expectedVersion, input);
    if (!updated) throw new StreamingBotServiceError("MEMORY_VERSION_CONFLICT", "Memory changed. Reload before editing.", 409);
    return updated;
  }

  async deleteReviewedMemory(id: string) {
    return this.options.botRepository.deleteMemory(id);
  }

  async botTicker(): Promise<{ enabled: boolean; ticker: Array<{ author: string | null; message: string; reply: string | null; createdAt: string }> }> {
    const settings = await this.options.botRepository.getSettings();
    if (!settings.enabled || !settings.overlayTickerEnabled) {
      return { enabled: false, ticker: [] };
    }
    const activity = await this.options.botRepository.listActivity(6);
    const ticker = activity
      .filter((record) => record.status === "REPLIED" && record.reply &&
        !asksForOperatorPrivateData(record.message) && !containsSensitiveDisclosure(`${record.author ?? ""} ${record.message} ${record.reply}`))
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

function createApiBotMemoryStore(repository: StreamingBotRepository): BotMemoryStore {
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
