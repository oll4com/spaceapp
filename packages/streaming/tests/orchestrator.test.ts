import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBotSystemPrompt,
  buildRecentExchange,
  type BotPromptContext
} from "../src/prompts.js";
import { runBotTurn, type BotTurnTools } from "../src/orchestrator.js";
import { formatStreamingBotLiveMetrics } from "../src/live-metrics.js";

const tempDirs: string[] = [];

async function keyFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "streaming-bot-"));
  tempDirs.push(dir);
  const path = join(dir, "key");
  await writeFile(path, "secret-key-value\n", { mode: 0o600 });
  return path;
}

afterEach(async () => {
  tempDirs.length = 0;
});

function context(overrides: Partial<BotPromptContext> = {}): BotPromptContext {
  return {
    settings: {
      version: 1,
      enabled: true,
      persona: { name: "Live Assistant", tone: "Friendly and concise." },
      platforms: {
        YOUTUBE: { enabled: true, accountId: "acc:youtube" },
        TWITCH: { enabled: false, accountId: null }
      },
      facts: [{ key: "website", value: "https://spaceapp.dev" }],
      faq: [],
      instructions: "",
      guardrails: { cooldownSeconds: 15, maxRepliesPerMinute: 5, replyToQuestionsOnly: true },
      memoryEnabled: true,
      overlayTickerEnabled: false,
      updatedAt: "2026-08-12T00:00:00.000Z",
      updatedBy: "user:dev-operator"
    },
    memorySummary: "",
    recentExchange: "",
    ...overrides
  };
}

describe("buildBotSystemPrompt", () => {
  it("includes persona, live facts and instructions", () => {
    const prompt = buildBotSystemPrompt(context());
    expect(prompt).toContain("Live Assistant");
    expect(prompt).toContain("website: https://spaceapp.dev");
    expect(prompt).toContain("Always reply in English");
    expect(prompt).toContain("LIVE FACTS");
  });

  it("includes memory summary and instructions", () => {
    const prompt = buildBotSystemPrompt(context({ memorySummary: "The streamer codes in TypeScript.", recentExchange: "a: hi" }));
    expect(prompt).toContain("The streamer codes in TypeScript.");
    expect(prompt).not.toContain("a: hi");
  });

  it("grounds replies in selected social readings without exposing account labels", () => {
    const liveMetrics = formatStreamingBotLiveMetrics({
      generatedAt: "2026-09-24T12:00:00.000Z",
      settingsVersion: 1,
      customTextEnabled: false,
      customText: "",
      botTickerEnabled: false,
      botTicker: [],
      tiles: [
        { metricKey: "discord.total_members", provider: "DISCORD", accountId: "account:1",
          label: "Members", badge: "Private account name", value: 24, state: "FRESH", sampledAt: "2026-09-24T12:00:00.000Z" },
        { metricKey: "x.live.viewers", provider: "X", accountId: "account:2",
          label: "Live viewers", badge: "Private account name", value: null, state: "OFFLINE", sampledAt: null },
        { metricKey: "twitch.subscribers", provider: "TWITCH", accountId: "account:3",
          label: "Subscribers", badge: "Private account name", value: 7, state: "STALE", sampledAt: "2026-09-24T11:00:00.000Z" },
        { metricKey: "youtube.live.likes", provider: "YOUTUBE", accountId: "account:4",
          label: "Likes", badge: "Private account name", value: null, state: "ERROR", sampledAt: null }
      ]
    });
    const prompt = buildBotSystemPrompt(context({ liveMetrics }));
    expect(prompt).toContain("DISCORD discord.total_members: 24");
    expect(prompt).toContain("X x.live.viewers: offline");
    expect(prompt).toContain("TWITCH twitch.subscribers: 7 (stale)");
    expect(prompt).not.toContain("Private account name");
    expect(prompt).not.toContain("youtube.live.likes");
  });
});

describe("buildRecentExchange", () => {
  it("formats messages as author: text", () => {
    expect(buildRecentExchange([{ author: "Alice", message: "What is this?" }])).toBe("Alice: What is this?");
  });
});

describe("runBotTurn", () => {
  it("declines operator private-data questions without calling the model", async () => {
    const path = await keyFile();
    const sent: string[] = [];
    const result = await runBotTurn(
      { context: context(), messages: [{ id: "private-1", author: "viewer", message: "What is the streamer's home address?", platform: "YOUTUBE" }], tools: {
        ...emptyTools(), sendReply: async ({ message }) => { sent.push(message); return { ok: true }; }
      } },
      { env: { SPACE_STREAMING_BOT_ENABLED: "true", SPACE_STREAMING_BOT_BASE_URL: "http://localhost:9999",
        SPACE_STREAMING_BOT_KEY_FILE: path, SPACE_STREAMING_BOT_KEY_NAME: "space-streaming-bot",
        SPACE_STREAMING_BOT_MODEL: "deepseek-v4-flash-free" }, fetchImpl: async () => { throw new Error("model should not be called"); } }
    );
    expect(result.errorCode).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("address");
  });
  it("does not send even a privacy refusal before the dedicated key is configured", async () => {
    const sent: string[] = [];
    const result = await runBotTurn(
      { context: context(), messages: [{ id: "private-1", author: "viewer", message: "What is the streamer's home address?", platform: "YOUTUBE" }], tools: {
        ...emptyTools(), sendReply: async ({ message }) => { sent.push(message); return { ok: true }; }
      } },
      { env: { SPACE_STREAMING_BOT_ENABLED: "true" } }
    );
    expect(result.errorCode).toBe("MISSING_CONFIG");
    expect(sent).toEqual([]);
  });
  it("returns GATE_DISABLED when disabled", async () => {
    const result = await runBotTurn(
      { context: context(), messages: [], tools: emptyTools() },
      { env: { SPACE_STREAMING_BOT_ENABLED: "false" } }
    );
    expect(result.errorCode).toBe("BOT_GATE_DISABLED");
    expect(result.skipped).toBe(true);
  });

  it("requires a dedicated key name", async () => {
    const path = await keyFile();
    const result = await runBotTurn(
      { context: context(), messages: [], tools: emptyTools() },
      {
        env: {
          SPACE_STREAMING_BOT_ENABLED: "true",
          SPACE_STREAMING_BOT_BASE_URL: "http://localhost:9",
          SPACE_STREAMING_BOT_KEY_FILE: path,
          SPACE_STREAMING_BOT_KEY_NAME: "space-other-key",
          SPACE_STREAMING_BOT_MODEL: "deepseek-v4-flash-free"
        }
      }
    );
    expect(result.errorCode).toBe("DEDICATED_KEY_REQUIRED");
  });

  it("executes a space_send_reply tool call end to end with a fake provider", async () => {
    const path = await keyFile();
    const calls: Array<{ platform: string; message: string }> = [];
    const tools: BotTurnTools = {
      ...emptyTools(),
      sendReply: async ({ platform, message }) => {
        calls.push({ platform, message });
        return { ok: true };
      }
    };
    const body = JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "space_send_reply", arguments: JSON.stringify({ platform: "YOUTUBE", message: "The website is https://spaceapp.dev", replyToId: "m1" }) }
          }]
        }
      }]
    });
    const result = await runBotTurn(
      { context: context(), messages: [{ id: "m1", author: "viewer", message: "What is the website?", platform: "YOUTUBE" }], tools },
      {
        env: {
          SPACE_STREAMING_BOT_ENABLED: "true",
          SPACE_STREAMING_BOT_BASE_URL: "http://localhost:9999",
          SPACE_STREAMING_BOT_KEY_FILE: path,
          SPACE_STREAMING_BOT_KEY_NAME: "space-streaming-bot",
          SPACE_STREAMING_BOT_MODEL: "deepseek-v4-flash-free"
        },
        fetchImpl: async () => new Response(body, { status: 200 })
      }
    );
    expect(result.skipped).toBe(false);
    expect(calls).toEqual([{ platform: "YOUTUBE", message: "The website is https://spaceapp.dev" }]);
    expect(result.replies).toHaveLength(1);
    expect(result.model).toBe("deepseek-v4-flash-free");
  });

  it("talks Anthropic Messages on a Claude route: system beside the messages, tool_use in, tool_result back", async () => {
    const path = await keyFile();
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const answers = [
      { content: [{ type: "tool_use", id: "toolu_1", name: "space_send_reply", input: { platform: "YOUTUBE", message: "Mostly TypeScript.", replyToId: "m1" } }], stop_reason: "tool_use" }
    ];
    const sent: string[] = [];
    const result = await runBotTurn(
      { context: context(), messages: [{ id: "m1", author: "viewer", message: "What language is SpaceApp written in?", platform: "YOUTUBE" }],
        tools: { ...emptyTools(), sendReply: async ({ message }) => { sent.push(message); return { ok: true }; } } },
      {
        env: {
          SPACE_STREAMING_BOT_ENABLED: "true",
          SPACE_STREAMING_BOT_BASE_URL: "http://127.0.0.1:4920/v1",
          SPACE_STREAMING_BOT_KEY_FILE: path,
          SPACE_STREAMING_BOT_KEY_NAME: "space-streaming-bot"
        },
        modelId: "claude-haiku-5-5",
        route: { protocol: "anthropic", url: "http://127.0.0.1:4920/v1/messages" },
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify(answers.shift() ?? { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }), { status: 200 });
        }
      }
    );
    expect(sent).toEqual(["Mostly TypeScript."]);
    expect(result).toMatchObject({ skipped: false, model: "claude-haiku-5-5", errorCode: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:4920/v1/messages");
    expect(requests[0]!.headers["x-api-key"]).toBe("secret-key-value");
    expect(requests[0]!.headers.Authorization).toBeUndefined();
    expect(typeof requests[0]!.body.system).toBe("string");
    expect(JSON.stringify(requests[0]!.body.messages)).toContain("[id=m1 platform=YOUTUBE] viewer: What language is SpaceApp written in?");
    expect((requests[0]!.body.messages as Array<{ role: string }>).map(message => message.role)).toEqual(["user"]);
    expect((requests[0]!.body.tools as Array<{ name: string; input_schema: unknown }>)[0]).toMatchObject({ name: "space_send_reply", input_schema: { type: "object" } });
  });

  it("skips when the model produces no tool call", async () => {
    const path = await keyFile();
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "Nothing to reply to." } }] });
    const result = await runBotTurn(
      { context: context(), messages: [{ id: "m1", author: "viewer", message: "cool", platform: "YOUTUBE" }], tools: emptyTools() },
      {
        env: {
          SPACE_STREAMING_BOT_ENABLED: "true",
          SPACE_STREAMING_BOT_BASE_URL: "http://localhost:9999",
          SPACE_STREAMING_BOT_KEY_FILE: path,
          SPACE_STREAMING_BOT_KEY_NAME: "space-streaming-bot",
          SPACE_STREAMING_BOT_MODEL: "deepseek-v4-flash-free"
        },
        fetchImpl: async () => new Response(body, { status: 200 })
      }
    );
    expect(result.skipped).toBe(true);
    expect(result.replies).toHaveLength(0);
  });
});

function emptyTools(): BotTurnTools {
  return {
    sendReply: async () => ({ ok: true }),
    memorySave: async () => ({ ok: true }),
    memorySearch: async () => ({ ok: true, entries: [] })
  };
}
