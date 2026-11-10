import { describe, expect, it } from "vitest";
import { chatRequestOf, messagesResponseOf, messagesStreamOf } from "../src/providers/space/messages-to-chat.js";

const sse = (...chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("")).body!;
const collect = async (stream: AsyncGenerator<string>) => { const out = []; for await (const item of stream) out.push(JSON.parse(item.split("\ndata: ")[1]!)); return out; };

describe("Anthropic Messages ⇄ Chat Completions", () => {
  it("translates a tool-using conversation: system blocks, images, tool calls with Gemini's history signature, tool results before the user's words", () => {
    const chat = chatRequestOf({ model: "gemini-3-flash-preview", max_tokens: 50, stop_sequences: ["END"], system: [{ type: "text", text: "Rules", cache_control: { type: "ephemeral" } }],
      tool_choice: { type: "tool", name: "read" }, tools: [{ name: "read", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "tool_use", id: "t1", name: "read", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "missing" }] }, { type: "text", text: "Again" }] }
      ] }, { gemini: true });
    expect(chat).toEqual({ model: "gemini-3-flash-preview", max_tokens: 50, stop: ["END"], tool_choice: { type: "function", function: { name: "read" } },
      tools: [{ type: "function", function: { name: "read", description: "", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "Rules" },
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" },
          extra_content: { google: { thought_signature: "skip_thought_signature_validator" } } }] },
        { role: "tool", tool_call_id: "t1", content: "Error: missing" },
        { role: "user", content: "Again" }
      ] });
    // Other providers get no Google field.
    expect(JSON.stringify(chatRequestOf({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }] }))).not.toContain("extra_content");
    // 7/11 CLI tests: Claude Code's 32,000 output tokens fit the model's own cap, and Azure's GPT-5 models take max_completion_tokens.
    expect(chatRequestOf({ model: "m", max_tokens: 32_000, messages: [] }, { maxOutput: 6_000 })).toMatchObject({ max_tokens: 6_000 });
    expect(chatRequestOf({ model: "m", max_tokens: 500, messages: [] }, { maxOutput: 6_000 })).toMatchObject({ max_tokens: 500 });
    const azure = chatRequestOf({ model: "gpt-5-mini", max_tokens: 32_000, messages: [] }, { maxCompletionTokens: true });
    expect(azure).toMatchObject({ max_completion_tokens: 32_000 });
    expect(azure).not.toHaveProperty("max_tokens");
  });

  it("maps a non-streamed answer's stop reason, usage and broken tool arguments", () => {
    expect(messagesResponseOf({ id: "c", choices: [{ finish_reason: "length", message: { content: "cut" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }, "groq:m"))
      .toEqual({ id: "msg_c", type: "message", role: "assistant", model: "groq:m", content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 } });
    expect(messagesResponseOf({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "t", function: { name: "x", arguments: "{bad" } }] } }] }, "m").content)
      .toEqual([{ type: "tool_use", id: "t", name: "x", input: {} }]);
  });

  it("streams text then tool calls as Anthropic blocks, split across chunk boundaries, and ends with stop reason and usage", async () => {
    const events = await collect(messagesStreamOf(sse(
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read", arguments: "{\"pa" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":1}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "t2", function: { name: "ls", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } }, "[DONE]"), "m"));
    expect(events.map((item) => [item.type, item.index ?? null, item.content_block?.type ?? item.delta?.type ?? null])).toEqual([
      ["message_start", null, null], ["content_block_start", 0, "text"], ["content_block_delta", 0, "text_delta"], ["content_block_stop", 0, null],
      ["content_block_start", 1, "tool_use"], ["content_block_delta", 1, "input_json_delta"], ["content_block_delta", 1, "input_json_delta"], ["content_block_stop", 1, null],
      ["content_block_start", 2, "tool_use"], ["content_block_delta", 2, "input_json_delta"], ["content_block_stop", 2, null], ["message_delta", null, null], ["message_stop", null, null]]);
    expect(events[4].content_block).toEqual({ type: "tool_use", id: "t1", name: "read", input: {} });
    expect(events.at(-2)).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 7, output_tokens: 4 } });
    // A line split between two network chunks still parses.
    const text = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "whole" } }] })}\n\n`);
    const split = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(text.slice(0, 10)); controller.enqueue(text.slice(10)); controller.close(); } });
    expect((await collect(messagesStreamOf(split, "m"))).find((item) => item.delta?.type === "text_delta")?.delta.text).toBe("whole");
    // An upstream error mid-stream becomes an Anthropic error event.
    expect((await collect(messagesStreamOf(sse({ error: { message: "quota" } }), "m"))).at(-1)).toEqual({ type: "error", error: { type: "api_error", message: "quota" } });
  });
});
