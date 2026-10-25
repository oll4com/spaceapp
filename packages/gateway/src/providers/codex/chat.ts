/**
 * Chat Completions on top of the Responses API, after codex-lb `chat_requests.py` / `chat_responses.py`
 * (MIT, Soju06/codex-lb): requests are rewritten to Responses input and replies are rewritten back, streamed or not.
 */
type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export class ChatRequestError extends Error {}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => str(obj(part)?.text) ?? "").filter(Boolean).join("\n");
}

function userParts(content: unknown): Json[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: Json[] = [];
  for (const raw of content) {
    const part = obj(raw);
    if (!part) continue;
    const type = str(part.type) ?? (typeof part.text === "string" ? "text" : null);
    if (type === "text" || type === "input_text") parts.push({ type: "input_text", text: str(part.text) ?? "" });
    else if (type === "image_url") {
      const image = obj(part.image_url);
      const url = str(image?.url) ?? str(part.image_url);
      if (url) parts.push({ type: "input_image", image_url: url, ...(str(image?.detail) ? { detail: image!.detail } : {}) });
    } else if (type === "input_image") parts.push(part);
    else throw new ChatRequestError(`Unsupported content part: ${type ?? "unknown"}`);
  }
  return parts;
}

/** Chat-style messages as Responses input: system and developer text becomes instructions. */
function messagesToInput(messages: unknown[]): { instructions: string[]; input: Json[] } {
  const instructions: string[] = [];
  const input: Json[] = [];
  for (const raw of messages) {
    const message = obj(raw);
    const role = str(message?.role);
    if (!message || !role) throw new ChatRequestError("Each message must include a string 'role'.");
    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text) instructions.push(text);
    } else if (role === "user") {
      input.push({ type: "message", role: "user", content: userParts(message.content) });
    } else if (role === "assistant") {
      const text = textOf(message.content);
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const rawCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const call = obj(rawCall);
        const fn = obj(call?.function);
        if (!call || !fn || typeof fn.name !== "string") continue;
        input.push({ type: "function_call", call_id: str(call.id) ?? "", name: fn.name, arguments: str(fn.arguments) ?? "{}" });
      }
    } else if (role === "tool") {
      input.push({ type: "function_call_output", call_id: str(message.tool_call_id) ?? "", output: textOf(message.content) });
    } else {
      throw new ChatRequestError(`Unsupported message role: ${role}`);
    }
  }
  return { instructions, input };
}

/** Rewrites a Chat Completions request into a Responses request for the Codex backend. */
export function chatToResponses(body: Json): Json {
  if (typeof body.model !== "string" || !body.model.trim()) throw new ChatRequestError("'model' is required.");
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new ChatRequestError("'messages' must be a non-empty array.");
  const { instructions, input } = messagesToInput(body.messages);
  const out: Json = { model: body.model, instructions: instructions.join("\n\n"), input, stream: true, store: false };
  const tools = Array.isArray(body.tools) ? body.tools.map(obj).filter((tool): tool is Json => Boolean(tool)) : [];
  if (tools.length > 0) {
    out.tools = tools.map((tool) => {
      const fn = obj(tool.function);
      if (tool.type !== "function" || !fn) return tool;
      return { type: "function", name: fn.name, description: fn.description, parameters: fn.parameters ?? { type: "object", properties: {} },
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}) };
    });
  }
  const toolChoice = body.tool_choice;
  if (typeof toolChoice === "string") out.tool_choice = toolChoice;
  else if (obj(toolChoice)?.type === "function") out.tool_choice = { type: "function", name: obj(obj(toolChoice)!.function)?.name };
  if (typeof body.parallel_tool_calls === "boolean") out.parallel_tool_calls = body.parallel_tool_calls;
  const format = obj(body.response_format);
  if (format?.type === "json_schema") {
    const schema = obj(format.json_schema) ?? {};
    out.text = { format: { type: "json_schema", name: schema.name ?? "response", schema: schema.schema ?? {}, ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}) } };
  } else if (format?.type === "json_object") {
    out.text = { format: { type: "json_object" } };
  }
  const effort = str(body.reasoning_effort) ?? str(obj(body.reasoning)?.effort);
  if (effort) out.reasoning = { effort };
  if (typeof body.service_tier === "string") out.service_tier = body.service_tier;
  if (typeof body.prompt_cache_key === "string") out.prompt_cache_key = body.prompt_cache_key;
  return out;
}

const UNSUPPORTED_UPSTREAM_FIELDS = ["max_output_tokens", "metadata", "prompt_cache_retention", "safety_identifier", "temperature", "top_p", "truncation", "user"];

/**
 * Responses requests as the Codex backend takes them, after codex-lb's request models: fields it rejects are dropped,
 * `store` is always false, a string `input` becomes one user message, and on `/v1` (OpenAI-style clients) `messages`
 * are accepted in place of `input` and missing `instructions` are empty.
 */
export function normalizeResponsesRequest(body: Json, options: { openAiStyle: boolean; compact?: boolean }): Json {
  const out: Json = { ...body };
  // The Codex backend rejects these OpenAI API fields (codex-lb `_UNSUPPORTED_UPSTREAM_FIELDS`).
  for (const field of UNSUPPORTED_UPSTREAM_FIELDS) delete out[field];
  delete out.prompt_cache_options;
  if (!options.compact) out.store = false;
  if (typeof out.input === "string") out.input = [{ role: "user", content: [{ type: "input_text", text: out.input }] }];
  if (!options.openAiStyle) return out;
  if (out.messages !== undefined) {
    if (!Array.isArray(out.messages)) throw new ChatRequestError("'messages' must be an array.");
    if (Array.isArray(out.input) ? out.input.length > 0 : out.input !== undefined && out.input !== null) {
      throw new ChatRequestError("Provide either 'input' or 'messages', not both.");
    }
    const { instructions, input } = messagesToInput(out.messages);
    const existing = typeof out.instructions === "string" && out.instructions ? [out.instructions] : [];
    out.instructions = [...existing, ...instructions].join("\n");
    out.input = input;
    delete out.messages;
  }
  if (out.input === undefined || out.input === null) throw new ChatRequestError("Provide either 'input' or 'messages'.");
  if (!Array.isArray(out.input)) throw new ChatRequestError("'input' must be a string or an array.");
  if (typeof out.instructions !== "string") out.instructions = "";
  return out;
}

function usageOf(response: Json | null): Json | undefined {
  const usage = obj(response?.usage);
  if (!usage) return undefined;
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  return {
    prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: Number(obj(usage.input_tokens_details)?.cached_tokens ?? 0) },
    completion_tokens_details: { reasoning_tokens: Number(obj(usage.output_tokens_details)?.reasoning_tokens ?? 0) }
  };
}

function finishReason(response: Json | null, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  const reason = str(obj(response?.incomplete_details)?.reason);
  if (response?.status === "incomplete") return reason === "content_filter" ? "content_filter" : "length";
  return "stop";
}

/** The final Responses object as a `chat.completion`. */
export function responseToChatCompletion(response: Json, fallbackModel: string, createdSeconds: number): Json {
  const output = Array.isArray(response.output) ? response.output.map(obj).filter((item): item is Json => Boolean(item)) : [];
  let text = "";
  const toolCalls: Json[] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content.map(obj) : []) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ id: str(item.call_id) ?? str(item.id) ?? "", type: "function", function: { name: item.name, arguments: str(item.arguments) ?? "" } });
    }
  }
  return {
    id: `chatcmpl-${str(response.id) ?? "gateway"}`,
    object: "chat.completion",
    created: createdSeconds,
    model: str(response.model) ?? fallbackModel,
    choices: [{ index: 0, message: { role: "assistant", content: toolCalls.length && !text ? null : text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: finishReason(response, toolCalls.length > 0), logprobs: null }],
    ...(usageOf(response) ? { usage: usageOf(response) } : {})
  };
}

/** Turns a Responses SSE stream into `chat.completion.chunk` events, chunk by chunk. */
function outputKey(event: Json): string | undefined {
  return typeof event.output_index === "number" ? `output:${event.output_index}` : undefined;
}

export class ChatStreamTranslator {
  private buffer = "";
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private id = "chatcmpl-gateway";
  private model: string;
  private sentRole = false;
  private toolIndexes = new Map<string, number>();
  private toolCount = 0;
  /** Tool calls whose arguments arrived as deltas; the others get theirs from the done events. */
  private streamedArguments = new Set<number>();
  private finished = false;

  constructor(model: string, private readonly createdSeconds: number, private readonly includeUsage: boolean) {
    this.model = model;
  }

  private chunk(delta: Json, finish: string | null = null, usage?: Json): string {
    const payload: Json = { id: this.id, object: "chat.completion.chunk", created: this.createdSeconds, model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] };
    if (usage !== undefined) payload.usage = usage;
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private role(): string {
    if (this.sentRole) return "";
    this.sentRole = true;
    return this.chunk({ role: "assistant", content: "" });
  }

  push(bytes: Uint8Array): Uint8Array {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let out = "";
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data || data === "[DONE]") continue;
      let event: Json | null = null;
      try { event = obj(JSON.parse(data)); } catch { continue; }
      if (event) out += this.handle(event);
    }
    return this.encoder.encode(out);
  }

  private handle(event: Json): string {
    const type = str(event.type);
    if (type === "response.created" || type === "response.in_progress") {
      const response = obj(event.response);
      if (str(response?.id)) this.id = `chatcmpl-${response!.id as string}`;
      if (str(response?.model)) this.model = response!.model as string;
      return "";
    }
    if (type === "response.output_text.delta" && typeof event.delta === "string") return this.role() + this.chunk({ content: event.delta });
    if (type === "response.output_item.added") {
      const item = obj(event.item);
      if (item?.type !== "function_call") return "";
      const index = this.toolCount++;
      // Parallel calls: argument events name their call by item id or output index, whichever the upstream sends.
      for (const key of [str(item.id), str(item.call_id), outputKey(event)]) if (key) this.toolIndexes.set(key, index);
      return this.role() + this.chunk({ tool_calls: [{ index, id: str(item.call_id) ?? "", type: "function", function: { name: item.name, arguments: "" } }] });
    }
    if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const index = this.toolIndex(event);
      this.streamedArguments.add(index);
      return this.chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] });
    }
    if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
      const item = obj(event.item);
      if (type === "response.output_item.done" && item?.type !== "function_call") return "";
      const index = this.toolIndex(event, item);
      const args = str(event.arguments) ?? str(item?.arguments);
      if (this.streamedArguments.has(index) || !args) return "";
      this.streamedArguments.add(index);
      return this.chunk({ tool_calls: [{ index, function: { arguments: args } }] });
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const response = obj(event.response);
      this.finished = true;
      let out = this.role() + this.chunk({}, finishReason(response, this.toolCount > 0));
      if (this.includeUsage) out += `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.createdSeconds, model: this.model, choices: [], usage: usageOf(response) ?? null })}\n\n`;
      return `${out}data: [DONE]\n\n`;
    }
    if (type === "response.failed" || type === "error") {
      const error = obj(obj(event.response)?.error) ?? obj(event.error) ?? {};
      this.finished = true;
      return `data: ${JSON.stringify({ error: { message: str(error.message) ?? "The upstream response failed.", type: "server_error", code: str(error.code) ?? "upstream_error" } })}\n\ndata: [DONE]\n\n`;
    }
    return "";
  }

  private toolIndex(event: Json, item?: Json | null): number {
    for (const key of [str(event.item_id), str(item?.id), str(item?.call_id), outputKey(event)]) {
      const index = key ? this.toolIndexes.get(key) : undefined;
      if (index !== undefined) return index;
    }
    return Math.max(0, this.toolCount - 1);
  }

  /** Closes a stream that ended without a terminal event. */
  finish(): Uint8Array {
    return this.encoder.encode(this.finished ? "" : "data: [DONE]\n\n");
  }
}
