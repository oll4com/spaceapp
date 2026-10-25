import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStreamingBotRepository } from "@space/db";
import { StreamingCredentialStore } from "@space/streaming";
import { createSpaceBotMemoryStore, runStreamingBotCycle, type StreamingBotRuntimeOptions } from "../src/streaming-bot-runtime.js";

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor() {
    FakeSocket.last = this;
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN;
      this.emit({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "session-1" } } });
    }, 0);
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(envelope: unknown) { for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(envelope) }); }
  close() { this.readyState = 3; for (const listener of this.listeners.get("close") ?? []) listener({}); }
}

function chatNotification(id: string, text: string, at: Date) {
  return {
    metadata: { message_type: "notification", message_timestamp: at.toISOString() },
    payload: { event: { message_id: id, chatter_user_name: "viewer", chatter_user_id: "viewer-1", message: { text }, badges: [] } }
  };
}

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(platform: "TWITCH" | "YOUTUBE", accountId: string, settingsPatch: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "space-streaming-bot-"));
  roots.push(root);
  const credentialStore = new StreamingCredentialStore(root);
  await credentialStore.initialize();
  await writeFile(credentialStore.clientPath(platform), JSON.stringify({ clientId: "client", clientSecret: "secret", redirectUri: "https://space.example/cb" }), { mode: 0o600 });
  await credentialStore.writeCredential("streaming-credential:test", { accessToken: "token", refreshToken: "refresh", expiresAt: "2999-01-01T00:00:00.000Z" });
  const botRepository = new InMemoryStreamingBotRepository();
  const current = await botRepository.getSettings();
  await botRepository.updateSettings({
    expectedVersion: current.version,
    settings: { ...current, ...settingsPatch } as never,
    updatedBy: "test",
    updatedAt: new Date().toISOString()
  });
  const scopes = platform === "TWITCH"
    ? ["user:read:chat", "user:write:chat", "moderator:manage:banned_users"]
    : ["https://www.googleapis.com/auth/youtube.force-ssl"];
  const streamingRepository = {
    listAccounts: async () => [{ id: accountId, provider: platform, authorizationId: "auth-1", externalAccountId: "broadcaster-1", status: "ACTIVE" }],
    listAuthorizations: async () => [{ id: "auth-1", status: "ACTIVE", credentialRef: "streaming-credential:test", scopes }]
  };
  const log = vi.fn();
  const options: StreamingBotRuntimeOptions = {
    streamingRepository: streamingRepository as never,
    spaceStore: { listProviders: async () => [], listModels: async () => [] } as never,
    botRepository,
    credentialStore,
    memoryStore: createSpaceBotMemoryStore(botRepository),
    youtubeDailyBudget: 10_000,
    youtubeReplyUnitCost: 50,
    internalApiBaseUrl: "http://127.0.0.1:1",
    internalApiToken: null,
    mcpToolBridgeEnabled: false,
    log
  };
  return { botRepository, options, log };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("streaming bot runtime", () => {
  it("keeps the Twitch chat open for moderation while replies are off, warns, and logs the message", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/helix/streams")) return jsonResponse({ data: [{ type: "live" }] });
      if (String(url).includes("/helix/chat/messages")) return jsonResponse({ data: [{ message_id: "warning-1", is_sent: true }] });
      return new Response(null, { status: 202 });
    }));
    const { botRepository, options } = await setup("TWITCH", "account-moderation", {
      enabled: false,
      moderationEnabled: true,
      platforms: { YOUTUBE: { enabled: false, accountId: null }, TWITCH: { enabled: false, accountId: "account-moderation" } }
    });

    await runStreamingBotCycle(options);
    FakeSocket.last!.emit(chatNotification("message-1", "You're an idiot", new Date()));
    await runStreamingBotCycle(options);

    expect(await botRepository.listModerationActions(10)).toMatchObject([{ decision: "WARN", result: "SUCCEEDED", userId: "viewer-1" }]);
    expect(calls.filter(url => url.includes("/helix/chat/messages"))).toHaveLength(1);
    expect(await botRepository.listActivity(10)).toMatchObject([{ direction: "IN", author: "viewer", status: "SKIPPED", messageId: "message-1" }]);
    expect(await botRepository.listChatStates()).toMatchObject([{ platform: "TWITCH", chatId: "broadcaster-1" }]);
  });

  it("logs chat that is not a question and saves the chat state", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/helix/streams") ? jsonResponse({ data: [{ type: "live" }] }) : new Response(null, { status: 202 })));
    const { botRepository, options } = await setup("TWITCH", "account-replies", {
      enabled: true,
      platforms: { YOUTUBE: { enabled: false, accountId: null }, TWITCH: { enabled: true, accountId: "account-replies" } }
    });

    await runStreamingBotCycle(options);
    FakeSocket.last!.emit(chatNotification("message-2", "hello everyone", new Date()));
    await runStreamingBotCycle(options);

    expect(await botRepository.listActivity(10)).toMatchObject([{ direction: "IN", message: "hello everyone", status: "SKIPPED" }]);
    const [state] = await botRepository.listChatStates();
    expect(state?.lastPolledAt).toBeTruthy();
  });

  it("looks for a YouTube broadcast at most once per offline cache window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
    const broadcastCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/liveBroadcasts")) broadcastCalls.push(String(url));
      return jsonResponse({ items: [] });
    }));
    const { options } = await setup("YOUTUBE", "account-youtube", {
      enabled: true,
      platforms: { YOUTUBE: { enabled: true, accountId: "account-youtube" }, TWITCH: { enabled: false, accountId: null } }
    });

    await runStreamingBotCycle(options);
    vi.setSystemTime(new Date("2026-10-14T12:00:11.000Z"));
    await runStreamingBotCycle(options);
    await runStreamingBotCycle(options);
    await runStreamingBotCycle(options);

    expect(broadcastCalls).toHaveLength(2);
    expect(broadcastCalls[0]).not.toContain("mine=");
    expect(broadcastCalls[0]).toContain("broadcastStatus=active");
  });
});
