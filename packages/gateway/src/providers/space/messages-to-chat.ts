/**
 * Anthropic Messages ⇄ OpenAI Chat Completions for the Space provider's free routes (free-tokens brief 6/11, goal d844e0cc): a Claude-format
 * request (a Claude Code pane on `/pools/space/v1/messages`) can then fall over to the free key pools, which speak Chat Completions only.
 * Text, images, tools and tool results map one to one; thinking blocks, cache_control, top_k and metadata have no Chat equivalent and are dropped.
 */
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const blocksOf = (content: unknown): Json[] => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.filter(isObject) : []);
const textOf = (content: unknown) => blocksOf(content).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("\n");

/** Gemini 3 refuses a function-calling history without its thought signatures, which Anthropic blocks cannot carry; Google documents this value for a history from another model. */
const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

function imagePart(block: Json): Json | null {
  const source = isObject(block.source) ? block.source : null;
  if (source?.type === "base64" && typeof source.data === "string") return { type: "image_url", image_url: { url: `data:${String(source.media_type ?? "image/png")};base64,${source.data}` } };
  if (source?.type === "url" && typeof source.url === "string") return { type: "image_url", image_url: { url: source.url } };
  return null;
}

/**
 * The Chat Completions body for a Messages body; `gemini` adds the history signature Gemini 3 asks of every earlier tool call. `maxOutput`
 * caps max_tokens at what the model takes (7/11: Claude Code's 32,000 refused by Cloudflare's 24k-window Llama), and `maxCompletionTokens`
 * names it as GPT-5 models on Azure require (they answer 400 to max_tokens).
 */
export function chatRequestOf(body: Json, options: { gemini?: boolean; maxOutput?: number; maxCompletionTokens?: boolean } = {}): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of Array.isArray(body.messages) ? body.messages.filter(isObject) : []) {
    const blocks = blocksOf(message.content);
    if (message.role === "assistant") {
      const calls = blocks.filter((block) => block.type === "tool_use").map((block) => ({ id: String(block.id ?? ""), type: "function",
        function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
        ...(options.gemini ? { extra_content: { google: { thought_signature: GEMINI_SKIP_SIGNATURE } } } : {}) }));
      messages.push({ role: "assistant", content: textOf(blocks) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results answer the previous assistant turn, so they go before the user's own words.
    for (const block of blocks.filter((item) => item.type === "tool_result")) {
      const text = textOf(block.content);
      messages.push({ role: "tool", tool_call_id: String(block.tool_use_id ?? ""), content: block.is_error === true ? `Error: ${text}` : text });
    }
    const parts = blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [{ type: "text", text: block.text }]
      : block.type === "image" ? [imagePart(block)].filter((part): part is Json => part !== null) : []));
    if (!parts.length) continue;
    messages.push({ role: "user", content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("\n") : parts });
  }
  const chat: Json = { model: body.model, messages };
  if (typeof body.max_tokens === "number") chat[options.maxCompletionTokens ? "max_completion_tokens" : "max_tokens"] = options.maxOutput ? Math.min(body.max_tokens, options.maxOutput) : body.max_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chat.stop = body.stop_sequences;
  if (body.stream === true) Object.assign(chat, { stream: true, stream_options: { include_usage: true } });
  const tools = Array.isArray(body.tools) ? body.tools.filter((tool): tool is Json => isObject(tool) && isObject(tool.input_schema)) : [];
  if (tools.length) chat.tools = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema } }));
  const choice = isObject(body.tool_choice) ? body.tool_choice : null;
  if (tools.length && choice) {
    chat.tool_choice = choice.type === "any" ? "required" : choice.type === "none" ? "none" : choice.type === "tool" ? { type: "function", function: { name: choice.name } } : "auto";
  }
  return chat;
}

const STOP_REASONS: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };
const stopReasonOf = (finish: unknown) => (typeof finish === "string" ? STOP_REASONS[finish] ?? "end_turn" : "end_turn");
const parsedInput = (text: unknown) => {
  try { const value = JSON.parse(typeof text === "string" && text ? text : "{}") as unknown; return isObject(value) ? value : {}; } catch { return {}; }
};
const usageOf = (usage: unknown) => ({ input_tokens: isObject(usage) && typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
  output_tokens: isObject(usage) && typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0 });

/** A Messages answer for a non-streamed Chat Completions answer. */
export function messagesResponseOf(chat: unknown, model: string): Json {
  const choice = isObject(chat) && Array.isArray(chat.choices) && isObject(chat.choices[0]) ? chat.choices[0] : {};
  const message = isObject(choice.message) ? choice.message : {};
  const content: Json[] = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : []) {
    const fn = isObject(call.function) ? call.function : {};
    content.push({ type: "tool_use", id: String(call.id ?? ""), name: String(fn.name ?? ""), input: parsedInput(fn.arguments) });
  }
  return { id: `msg_${isObject(chat) && typeof chat.id === "string" ? chat.id : Date.now().toString(36)}`, type: "message", role: "assistant", model, content,
    stop_reason: stopReasonOf(choice.finish_reason), stop_sequence: null, usage: usageOf(isObject(chat) ? chat.usage : null) };
}

const event = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Anthropic stream events for a Chat Completions SSE stream: one content block at a time (text, or one tool call), usage at the end. */
export async function* messagesStreamOf(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  yield event("message_start", { message: { id: `msg_${Date.now().toString(36)}`, type: "message", role: "assistant", model, content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = -1;
  let open: { kind: "text" } | { kind: "tool"; key: string } | null = null;
  let finish: unknown = null;
  let usage: unknown = null;
  const close = function* () { if (open) yield event("content_block_stop", { index }); open = null; };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        let chunk: unknown;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (!isObject(chunk)) continue;
        if (isObject(chunk.error)) {
          yield* close();
          yield event("error", { error: { type: "api_error", message: String(chunk.error.message ?? "The upstream stream failed.") } });
          return;
        }
        if (isObject(chunk.usage)) usage = chunk.usage;
        const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : null;
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = isObject(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string" && delta.content) {
          if (open?.kind !== "text") { yield* close(); index += 1; open = { kind: "text" }; yield event("content_block_start", { index, content_block: { type: "text", text: "" } }); }
          yield event("content_block_delta", { index, delta: { type: "text_delta", text: delta.content } });
        }
        for (const [position, call] of (Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isObject) : []).entries()) {
          const fn = isObject(call.function) ? call.function : {};
          // A call is known by its index; a provider that sends whole calls without one (Gemini) starts a new block with each id.
          const key = typeof call.index === "number" ? `i${call.index}` : typeof call.id === "string" ? `id${call.id}` : `p${position}`;
          if (open?.kind !== "tool" || open.key !== key) {
            yield* close();
            index += 1;
            open = { kind: "tool", key };
            yield event("content_block_start", { index, content_block: { type: "tool_use", id: String(call.id ?? `call_${index}`), name: String(fn.name ?? ""), input: {} } });
          }
          if (typeof fn.arguments === "string" && fn.arguments) yield event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: fn.arguments } });
        }
      }
      if (done) break;
    }
  } catch (error) {
    yield* close();
    yield event("error", { error: { type: "api_error", message: error instanceof Error ? error.message : "The upstream stream failed." } });
    return;
  }
  yield* close();
  yield event("message_delta", { delta: { stop_reason: stopReasonOf(finish), stop_sequence: null }, usage: usageOf(usage) });
  yield event("message_stop", {});
}
