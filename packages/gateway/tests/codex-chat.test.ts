import { describe, expect, it } from "vitest";
import { ChatRequestError, ChatStreamTranslator, chatToResponses, normalizeResponsesRequest, responseToChatCompletion } from "../src/providers/codex/chat.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sse = (type: string, body: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;

describe("Chat Completions over Responses", () => {
  it("maps messages, tools, tool results, JSON schema and effort", () => {
    const request = chatToResponses({
      model: "gpt-5.5", reasoning_effort: "low", temperature: 0.2, max_tokens: 100,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: [{ type: "text", text: "Use JSON." }] },
        { role: "user", content: [{ type: "text", text: "Weather?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA", detail: "low" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Athens\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "22C" }
      ],
      tools: [{ type: "function", function: { name: "weather", description: "Weather", parameters: { type: "object" }, strict: true } }],
      tool_choice: { type: "function", function: { name: "weather" } },
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true } }
    });
    expect(request).toEqual({
      model: "gpt-5.5", instructions: "Be brief.\n\nUse JSON.", stream: true, store: false, reasoning: { effort: "low" },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Weather?" }, { type: "input_image", image_url: "data:image/png;base64,AA", detail: "low" }] },
        { type: "function_call", call_id: "call_1", name: "weather", arguments: "{\"city\":\"Athens\"}" },
        { type: "function_call_output", call_id: "call_1", output: "22C" }
      ],
      tools: [{ type: "function", name: "weather", description: "Weather", parameters: { type: "object" }, strict: true }],
      tool_choice: { type: "function", name: "weather" },
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } }
    });
    expect(() => chatToResponses({ model: "m", messages: [] })).toThrow(ChatRequestError);
    expect(() => chatToResponses({ model: "m", messages: [{ role: "robot", content: "x" }] })).toThrow(/Unsupported message role/);
  });

  it("drops Responses fields the Codex backend rejects and keeps the rest (Copilot BYOK, OpenAI SDK clients)", () => {
    const body = normalizeResponsesRequest({ model: "gpt-5.5", input: "hi", max_output_tokens: 4096, temperature: 0.2, top_p: 1, truncation: "auto",
      metadata: { a: "b" }, user: "u", safety_identifier: "s", prompt_cache_retention: "24h", prompt_cache_options: {}, prompt_cache_key: "k",
      tools: [{ type: "function", name: "f" }], stream: true }, { openAiStyle: true });
    expect(body).toEqual({ model: "gpt-5.5", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], instructions: "", store: false,
      prompt_cache_key: "k", tools: [{ type: "function", name: "f" }], stream: true });
  });

  it("builds a chat.completion from the final response", () => {
    const completion = responseToChatCompletion({
      id: "resp_1", model: "gpt-5.5", status: "completed",
      output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "Hello" }] }],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 } }
    }, "fallback", 1_900_000_000);
    expect(completion).toEqual({
      id: "chatcmpl-resp_1", object: "chat.completion", created: 1_900_000_000, model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 } }
    });
    const tools = responseToChatCompletion({ output: [{ type: "function_call", call_id: "call_9", name: "f", arguments: "{}" }] }, "m", 1);
    expect(tools.choices).toEqual([{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls", logprobs: null }]);
  });

  it("streams chat.completion.chunk events with tool calls, usage and [DONE]", () => {
    const translator = new ChatStreamTranslator("gpt-5.5", 1, true);
    const stream = sse("response.created", { response: { id: "resp_2", model: "gpt-5.5" } })
      + sse("response.output_text.delta", { delta: "Hi" })
      + sse("response.output_item.added", { item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" } })
      + sse("response.function_call_arguments.delta", { item_id: "fc_1", delta: "{\"q\":" })
      + sse("response.completed", { response: { id: "resp_2", usage: { input_tokens: 5, output_tokens: 2 } } });
    const out = decode(translator.push(encode(stream.slice(0, 40)))) + decode(translator.push(encode(stream.slice(40)))) + decode(translator.finish());
    const events = out.split("\n\n").filter(Boolean).map((line) => line.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event) as { id: string; choices: { delta: Record<string, unknown>; finish_reason: string | null }[]; usage?: unknown });
    expect(chunks[0]).toMatchObject({ id: "chatcmpl-resp_2", choices: [{ delta: { role: "assistant", content: "" } }] });
    expect(chunks[1]!.choices[0]!.delta).toEqual({ content: "Hi" });
    expect(chunks[2]!.choices[0]!.delta).toEqual({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }] });
    expect(chunks[3]!.choices[0]!.delta).toEqual({ tool_calls: [{ index: 0, function: { arguments: "{\"q\":" } }] });
    expect(chunks[4]!.choices[0]!.finish_reason).toBe("tool_calls");
    expect(chunks[5]).toMatchObject({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
  });

  it("keeps parallel tool calls apart, by output index or by their done events", () => {
    const toolDeltas = (stream: string) => {
      const translator = new ChatStreamTranslator("gpt-5.5", 1, false);
      const out = decode(translator.push(encode(stream))) + decode(translator.finish());
      const calls: Record<number, string> = {};
      for (const event of out.split("\n\n").filter((line) => line && !line.endsWith("[DONE]"))) {
        for (const call of (JSON.parse(event.replace(/^data: /, "")) as { choices: { delta: { tool_calls?: { index: number; function?: { arguments?: string } }[] } }[] }).choices[0]?.delta.tool_calls ?? []) {
          calls[call.index] = (calls[call.index] ?? "") + (call.function?.arguments ?? "");
        }
      }
      return calls;
    };
    const added = (n: number, extra: Record<string, unknown> = {}) => sse("response.output_item.added", { output_index: n, item: { type: "function_call", call_id: `call_${n}`, name: "read_pane", ...extra } });
    // Both calls open before their arguments stream, and the items carry no id.
    expect(toolDeltas(added(0) + added(1)
      + sse("response.function_call_arguments.delta", { item_id: "fc_a", output_index: 0, delta: "{\"pane\":\"Andy\"}" })
      + sse("response.function_call_arguments.delta", { item_id: "fc_b", output_index: 1, delta: "{\"pane\":\"Bob\"}" })
      + sse("response.completed", { response: {} }))).toEqual({ 0: "{\"pane\":\"Andy\"}", 1: "{\"pane\":\"Bob\"}" });
    // Arguments only in the done events, once each.
    expect(toolDeltas(added(0, { id: "fc_a" }) + added(1, { id: "fc_b" })
      + sse("response.function_call_arguments.done", { item_id: "fc_a", output_index: 0, arguments: "{\"pane\":\"Andy\"}" })
      + sse("response.output_item.done", { output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_0", arguments: "{\"pane\":\"Andy\"}" } })
      + sse("response.output_item.done", { output_index: 1, item: { type: "function_call", id: "fc_b", call_id: "call_1", arguments: "{\"pane\":\"Bob\"}" } })
      + sse("response.completed", { response: {} }))).toEqual({ 0: "{\"pane\":\"Andy\"}", 1: "{\"pane\":\"Bob\"}" });
    // Streamed arguments are never repeated by the done events.
    expect(toolDeltas(added(0, { id: "fc_a" })
      + sse("response.function_call_arguments.delta", { item_id: "fc_a", delta: "{}" })
      + sse("response.function_call_arguments.done", { item_id: "fc_a", arguments: "{}" })
      + sse("response.completed", { response: {} }))).toEqual({ 0: "{}" });
  });

  it("reports a failed stream as an error event", () => {
    const translator = new ChatStreamTranslator("m", 1, false);
    const out = decode(translator.push(encode(sse("response.failed", { response: { error: { code: "server_error", message: "boom" } } }))));
    expect(out).toContain("\"code\":\"server_error\"");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(decode(translator.finish())).toBe("");
  });
});
