import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { StreamingBotMcpExecuteResponse } from "@space/contracts";
import { buildBotSystemPrompt, buildRecentExchange, type BotPromptContext } from "./prompts.js";

export interface StreamingBotLlmConfig {
  enabled: boolean;
  baseUrl: string | null;
  keyFile: string | null;
  keyName: string | null;
  model: string | null;
  timeoutMs: number;
  maxRounds: number;
}

export interface BotTurnMessage {
  id: string;
  author: string;
  message: string;
  platform: "YOUTUBE" | "TWITCH";
}

export interface BotTurnTools {
  sendReply(input: { platform: "YOUTUBE" | "TWITCH"; message: string; replyToId?: string }): Promise<{ ok: boolean; error?: string }>;
  memorySave(input: { title: string; body: string; tags?: string[] }): Promise<{ ok: boolean; error?: string }>;
  memorySearch(input: { query: string }): Promise<{ ok: boolean; entries: string[]; error?: string }>;
  mcpCall(input: { toolId: string; arguments?: Record<string, unknown> }): Promise<{ ok: boolean; observation: string; error?: string }>;
  skillRead(input: { name: string }): Promise<{ ok: boolean; content: string; error?: string }>;
}

export interface BotTurnResult {
  replies: Array<{ platform: "YOUTUBE" | "TWITCH"; message: string; replyToId?: string }>;
  memorySaves: Array<{ title: string; body: string; tags?: string[] }>;
  skipped: boolean;
  model: string | null;
  rounds: number;
  errorCode: string | null;
}

export interface RunBotTurnOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function boundedInt(raw: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function getStreamingBotLlmConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): StreamingBotLlmConfig {
  return {
    enabled: env.SPACE_STREAMING_BOT_ENABLED === "true",
    baseUrl: env.SPACE_STREAMING_BOT_BASE_URL?.trim() || null,
    keyFile: env.SPACE_STREAMING_BOT_KEY_FILE?.trim() || null,
    keyName: env.SPACE_STREAMING_BOT_KEY_NAME?.trim() || null,
    model: env.SPACE_STREAMING_BOT_MODEL?.trim() || null,
    timeoutMs: boundedInt(env.SPACE_STREAMING_BOT_TIMEOUT_MS, 20_000, 60_000),
    maxRounds: boundedInt(env.SPACE_STREAMING_BOT_MAX_ROUNDS, 3, 6)
  };
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LLM returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function endpoint(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("unsupported base URL");
  const normalized = base.href.endsWith("/") ? base : new URL(`${base.href}/`);
  return new URL(path, normalized).toString();
}

async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function toolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      type: "function",
      function: {
        name: "send_reply",
        description: "Post a chat reply to the viewer question. Call at most once per turn.",
        parameters: {
          type: "object",
          properties: {
            platform: { type: "string", enum: ["YOUTUBE", "TWITCH"] },
            message: { type: "string", description: "The reply text in English, 1-3 sentences." },
            replyToId: { type: "string", description: "Optional id of the viewer message being answered." }
          },
          required: ["platform", "message"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "memory_save",
        description: "Store a fact learned from a viewer question for later in this stream or future streams.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short summary of the fact (max 160 chars)." },
            body: { type: "string", description: "The fact itself (max 500 chars)." },
            tags: { type: "array", items: { type: "string" } }
          },
          required: ["title", "body"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "memory_search",
        description: "Search the bot's separate memory for facts from earlier questions.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "mcp_call",
        description: "Run a tool of a Space MCP server (e.g. space_ops, olla, space_browser, summary_tools, vision).",
        parameters: {
          type: "object",
          properties: {
            toolId: { type: "string", description: "MCP tool id as listed by the Space MCP registry, e.g. space-readonly:space_status." },
            arguments: { type: "object", description: "Tool arguments." }
          },
          required: ["toolId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "skill_read",
        description: "Load a Space skill definition to learn a workflow.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" }
          },
          required: ["name"]
        }
      }
    }
  ];
}

function parseToolCalls(message: Record<string, unknown>): ToolCall[] {
  const calls = asArray(message.tool_calls).flatMap((value) => {
    const call = asRecord(value);
    const fn = asRecord(call.function ?? {});
    const id = stringValue(call.id);
    const name = stringValue(fn.name);
    const rawArguments = stringValue(fn.arguments);
    if (!id || !name) return [];
    let parsedArguments: Record<string, unknown> = {};
    if (rawArguments) {
      try {
        const candidate = JSON.parse(rawArguments);
        parsedArguments = asRecord(candidate);
      } catch {
        parsedArguments = {};
      }
    }
    return [{ id, name, arguments: parsedArguments }];
  });
  const allowed = new Set(["send_reply", "memory_save", "memory_search", "mcp_call", "skill_read"]);
  return calls.filter((call) => allowed.has(call.name)).slice(0, 3);
}

function contentOf(payload: Record<string, unknown>): string | null {
  const choices = asArray(payload.choices);
  const message = asRecord(asRecord(choices[0] ?? {}).message ?? {});
  const content = message.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

function skippedResult(model: string | null): BotTurnResult {
  return { replies: [], memorySaves: [], skipped: true, model, rounds: 0, errorCode: null };
}

export async function runBotTurn(
  input: { context: BotPromptContext; messages: BotTurnMessage[]; tools: BotTurnTools },
  options: RunBotTurnOptions = {}
): Promise<BotTurnResult> {
  const config = getStreamingBotLlmConfig(options.env ?? process.env);
  if (!config.enabled) return { ...skippedResult(null), errorCode: "BOT_GATE_DISABLED" };
  if (!config.baseUrl || !config.keyFile || !config.keyName || !config.model) {
    return { ...skippedResult(null), errorCode: "MISSING_CONFIG" };
  }
  if (!config.keyName.startsWith("space-streaming-") || !isAbsolute(config.keyFile)) {
    return { ...skippedResult(null), errorCode: "DEDICATED_KEY_REQUIRED" };
  }

  let credential: string;
  try {
    const metadata = await lstat(config.keyFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o007) !== 0) {
      return { ...skippedResult(null), errorCode: "KEY_FILE_NOT_PROTECTED" };
    }
    credential = (await readFile(config.keyFile, "utf8")).trim();
    if (!credential) return { ...skippedResult(null), errorCode: "KEY_FILE_EMPTY" };
  } catch {
    return { ...skippedResult(null), errorCode: "KEY_FILE_UNREADABLE" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = `Bearer ${credential}`;
  const systemPrompt = buildBotSystemPrompt(input.context);
  const exchange = buildRecentExchange(input.messages.map((message) => ({ author: message.author, message: message.message })));
  const conversation: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: exchange
        ? `The following are the latest viewer messages in live chat. Answer questions about the stream.\n\n${exchange}`
        : "There are no new viewer messages this cycle."
    }
  ];

  let replies: BotTurnResult["replies"] = [];
  const memorySaves: BotTurnResult["memorySaves"] = [];
  let rounds = 0;
  let errorCode: string | null = null;

  try {
    for (; rounds < config.maxRounds; rounds++) {
      const response = await boundedFetch(fetchImpl, endpoint(config.baseUrl, "chat/completions"), {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: conversation,
          tools: toolDefinitions(),
          tool_choice: "auto",
          max_tokens: 800
        })
      }, config.timeoutMs);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ...skippedResult(config.model), errorCode: `LLM_HTTP_${response.status}` };
      }
      let payload: Record<string, unknown>;
      try {
        payload = asRecord(await response.json());
      } catch {
        return { ...skippedResult(config.model), errorCode: "LLM_RESPONSE_INVALID" };
      }
      const choices = asArray(payload.choices);
      const message = asRecord(asRecord(choices[0] ?? {}).message ?? {});
      const toolCalls = parseToolCalls(message);
      if (!toolCalls.length) {
        const content = contentOf(payload);
        if (content && !replies.length) {
          // Assistant answered in plain text without a tool call: do not auto-send.
        }
        break;
      }
      conversation.push({ role: "assistant", content: null, tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      })) });
      for (const call of toolCalls) {
        const result = await executeTool(call, input.tools, replies, memorySaves);
        conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      if (toolCalls.some((call) => call.name === "send_reply")) break;
    }
  } catch {
    errorCode = "LLM_UNAVAILABLE";
  }

  return { replies, memorySaves, skipped: replies.length === 0, model: config.model, rounds, errorCode };
}

async function executeTool(
  call: ToolCall,
  tools: BotTurnTools,
  replies: BotTurnResult["replies"],
  memorySaves: BotTurnResult["memorySaves"]
): Promise<Record<string, unknown>> {
  const args = call.arguments;
  switch (call.name) {
    case "send_reply": {
      const platform = args.platform === "TWITCH" ? "TWITCH" : "YOUTUBE";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!message) return { ok: false, error: "EMPTY_MESSAGE" };
      if (replies.length >= 3) return { ok: false, error: "REPLY_LIMIT" };
      const replyToId = typeof args.replyToId === "string" && args.replyToId ? args.replyToId : undefined;
      const result = await tools.sendReply({ platform, message, replyToId });
      if (result.ok) replies.push({ platform, message, replyToId });
      return result;
    }
    case "memory_save": {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!title || !body) return { ok: false, error: "MEMORY_FIELDS_REQUIRED" };
      const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12) : [];
      const result = await tools.memorySave({ title: title.slice(0, 160), body: body.slice(0, 500), tags });
      if (result.ok) memorySaves.push({ title: title.slice(0, 160), body: body.slice(0, 500), tags });
      return result;
    }
    case "memory_search": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { ok: false, error: "QUERY_REQUIRED" };
      return tools.memorySearch({ query: query.slice(0, 200) });
    }
    case "mcp_call": {
      const toolId = typeof args.toolId === "string" ? args.toolId.trim() : "";
      if (!toolId) return { ok: false, error: "TOOL_ID_REQUIRED" };
      const rawArguments = args.arguments;
      const toolArguments = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
        ? rawArguments as Record<string, unknown>
        : {};
      return tools.mcpCall({ toolId, arguments: toolArguments });
    }
    case "skill_read": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return { ok: false, error: "SKILL_NAME_REQUIRED" };
      return tools.skillRead({ name });
    }
    default:
      return { ok: false, error: "UNKNOWN_TOOL" };
  }
}

export function summarizeMcpExecuteResponse(response: StreamingBotMcpExecuteResponse): string {
  return JSON.stringify({
    status: response.status,
    code: response.code,
    message: response.message,
    serverId: response.serverId,
    toolName: response.toolName,
    observation: response.observation
  });
}